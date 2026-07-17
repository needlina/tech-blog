---
title: "PostgreSQL 대용량 테이블 컬럼 추가·타입 변경 시 다운타임 최소화 가이드"
slug: "postgresql-online-schema-change-minimal-downtime"
date: 2026-07-17 10:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "database-migration", "online-migration", "pg-repack", "zero-downtime"]
image:
  path: /assets/img/posts/blog/postgresql-online-schema-change-minimal-downtime/preview.png
  alt: "PostgreSQL 무중단 스키마 변경 썸네일"
---

오늘은 PostgreSQL에서 대용량 테이블에 컬럼을 추가하거나 컬럼 타입을 변경할 때 가능한 다운타임을 줄이는 절차를 정리해봤습니다. 저는 아직 초보라 실무에서 쓰기 전에 여러 자료와 버전별 동작을 확인하면서 정리한 내용입니다. 틀릴 가능성도 있으니 항상 환경(버전, 확장, 트래픽)에 맞춰 검증하시길 권합니다.

목차
- 왜 조심해야 하나
- 핵심 전략 요약
- 단계별 안전 절차 (명령어/스크립트 포함)
- 타입 변경(호환성 없는 경우) 별도 절차
- pg_repack / logical replication 같은 대안
- 모니터링·검증 포인트
- 공부하면서 알게 된 점 / 처음에는 헷갈렸던 부분 / 실무에서는 이렇게 확인하면 좋겠다
- 실무 체크리스트

왜 조심해야 하나
컬럼 추가나 타입 변경은 테이블의 물리적 레이아웃을 바꿀 수 있어서 대량의 데이터를 가진 테이블에서는 오래 걸리거나 전체 테이블을 재작성(rewrite)하게 됩니다. 재작성은 I/O·CPU·WAL을 많이 만들고, 그동안 락이나 긴 트랜잭션으로 인해 서비스 지연이나 장애가 날 수 있습니다. PostgreSQL 버전과 옵션에 따라 동작이 달라서 "항상 안전하다"라고 말하기 어렵습니다.

핵심 전략 요약
- 가능한 한 테이블 전체 리라이트를 피한다.
- 신규 nullable 컬럼을 추가하고, 배치로 백필(backfill)한다.
- 백필 중 발생하는 쓰기 변경을 놓치지 않기 위해 트리거나 논리 복제를 사용해 동기화한다.
- 인덱스가 필요하면 CREATE INDEX CONCURRENTLY로 생성한다.
- 최종적으로 컬럼 교체(이름 변경)과 제약 추가는 빠른 DDL로 수행한다.
- 테스트 환경과 스테이징에서 반드시 검증한 뒤 운영 적용한다.

간단 개념도 (이미지는 개념 설명용)
![컬럼 마이그레이션 개념 다이어그램](/assets/img/posts/blog/postgresql-online-schema-change-minimal-downtime/image-1.webp)
이미지 출처: AI 생성 이미지

단계별 안전 절차 (예시)
아래 예시는 "users" 테이블에 email_hash라는 새로운 varchar(64) 컬럼을 추가하고 기존 email 컬럼의 타입을 변경하거나 대체해야 하는 상황을 가정한 절차입니다.

1) 사전 점검
- PostgreSQL 버전 확인
  - 9.x / 10 / 11 이후 동작이 달라집니다. 예를 들어 일부 버전부터 DEFAULT를 가진 컬럼 추가 시 성능 최적화가 도입됐습니다.
- 테이블 크기 확인
  ```sql
  -- row 수와 사이즈 확인
  SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) 
  FROM pg_stat_user_tables WHERE relname = 'users';
  SELECT pg_total_relation_size('public.users');
  ```
- 현재 활성 쿼리/락 확인
  ```sql
  SELECT pid, usename, state, query, now() - query_start AS duration
  FROM pg_stat_activity WHERE state <> 'idle' ORDER BY duration DESC LIMIT 10;
  SELECT * FROM pg_locks WHERE relation = 'users'::regclass;
  ```

2) 신규 컬럼 추가 (빠르고 안전한 방식)
- 가능한 한 nullable로 추가합니다. DEFAULT를 주거나 NOT NULL을 같이 주면 재작성될 수 있으니 주의합니다.
  ```sql
  ALTER TABLE users ADD COLUMN email_hash varchar(64);
  ```
- 이 명령은 대체로 빠르게 끝나지만 버전에 따라 다르게 동작할 수 있으니 테스트 필요.

3) 백필(Backfill)을 배치로 수행
- 한 번에 대량 UPDATE 하는 것은 WAL 폭증과 bloat를 일으킬 수 있으므로 작은 배치로 나눠 처리합니다.
- 기본 아이디어: 기본 키(또는 id)를 이용해 범위로 업데이트하거나 ctid를 사용.
  - id 범위를 사용한 예:
  ```sql
  -- psql에서 루프 예시 (bash)
  for start in 1 10001 20001 30001; do
    end=$((start + 9999))
    psql -c "UPDATE users SET email_hash = md5(email) WHERE id BETWEEN ${start} AND ${end};"
  done
  ```
  - ctid를 이용한 안전한 배치(제한) 예:
  ```sql
  -- ctid로 10k씩 처리 (psql)
  WITH c AS (
    SELECT ctid FROM users WHERE email_hash IS NULL LIMIT 10000
  )
  UPDATE users u SET email_hash = md5(u.email)
  FROM c WHERE u.ctid = c.ctid;
  ```
- 각 배치 후 VACUUM / ANALYZE를 계획적으로 실행해 bloat와 통계를 관리합니다.

4) 쓰기 동기화 전략 (백필 중 발생하는 변경 처리)
- 백필을 하는 동안 신규 쓰기나 업데이트가 발생하면 변경된 값이 새 컬럼에 반영되지 않을 수 있습니다. 이를 방지하기 위해 두 가지 방법을 주로 씁니다.

  방법 A: 트리거를 걸어 쓰기 시 동기화
  ```sql
  CREATE FUNCTION sync_email_hash() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      NEW.email_hash := COALESCE(NEW.email_hash, md5(NEW.email));
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.email IS DISTINCT FROM OLD.email THEN
        NEW.email_hash := md5(NEW.email);
      END IF;
      RETURN NEW;
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER trg_sync_email_hash
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION sync_email_hash();
  ```
  트리거는 간단하지만 각 쓰기에 오버헤드가 생깁니다.

  방법 B: 논리 복제 / 외부 작업으로 동기화
  - 복잡하지만 대형 분산 시스템에서는 logical replication(또는 Debezium 등)으로 변경을 잡아 새 테이블에 반영하는 방식이 안전할 수 있습니다.

5) 인덱스 생성은 CONCURRENTLY로
- 새 컬럼에 인덱스가 필요하면 CONCURRENTLY 옵션 사용
  ```sql
  CREATE INDEX CONCURRENTLY idx_users_email_hash ON users (email_hash);
  ```
- CONCURRENTLY는 빌드 중에도 읽기·쓰기 작업을 허용하지만 실패 시 롤백이 아닌 재시도 필요.

6) 컬럼 스와핑 (짧은 다운타임 또는 무중단)
- 모든 백필과 동기화가 끝났다면 컬럼 교체를 빠르게 수행합니다.
  - 순서 예시:
    1. 기존 컬럼 이름 변경: ALTER TABLE users RENAME COLUMN email TO email_old;
    2. 새 컬럼 이름 변경: ALTER TABLE users RENAME COLUMN email_hash TO email;
    3. 필요하면 NOT NULL/DEFAULT 및 제약 추가(이들 DDL은 보통 빠름)
  ```sql
  ALTER TABLE users RENAME COLUMN email TO email_old;
  ALTER TABLE users RENAME COLUMN email_hash TO email;
  ALTER TABLE users ALTER COLUMN email SET NOT NULL;
  ALTER TABLE users ALTER COLUMN email SET DEFAULT '';
  ```
- 컬럼 이름 변경과 제약 추가는 보통 메타데이터 작업이라 빠르게 끝나지만 필요시 짧은 maintenance window를 잡는 편이 안전합니다.

7) 정리 및 청소
- 트리거 제거, 임시 컬럼 삭제
  ```sql
  DROP TRIGGER IF EXISTS trg_sync_email_hash ON users;
  DROP FUNCTION IF EXISTS sync_email_hash();
  ALTER TABLE users DROP COLUMN email_old;
  ```
- VACUUM FULL 또는 pg_repack로 테이블을 정리 (Downtime 없는 경우 pg_repack 추천)

타입 변경(호환성 없는 경우)
- 직접 ALTER COLUMN TYPE은 테이블 전체 재작성(rewrite)을 할 수 있습니다:
  ```sql
  ALTER TABLE users ALTER COLUMN age TYPE bigint USING age::bigint;
  ```
  - 이 명령은 데이터 변환이 필요하면 테이블을 rewrite할 수 있어 위험합니다.
- 안전한 방법은 앞서와 같은 "새 컬럼 추가 → 백필 → 스와핑" 패턴입니다.
  1. add new_col with target type
  2. backfill in batches using CAST/USING
  3. create indexes, constraints
  4. rename swap
  5. drop old

pg_repack, logical replication 같은 대안
- pg_repack: 테이블을 온라인으로 재작성해서 bloat를 줄이거나 리라이트를 수행합니다. 확장 설치와 충분한 디스크 공간이 필요합니다.
  - 설치 후 사용 예:
  ```bash
  pg_repack -h host -U user -d db -t users
  ```
- Logical replication: 전체 테이블을 새 스키마/테이블로 복제 후 스위치하는 방식(또는 마스터→리플리카 전환)으로 거의 무중단 이전을 할 수 있습니다. 설정과 검증이 복잡하므로 사전 테스트 필수.

운영(운영체제, Docker)에서 확인할 포인트
- Docker에서의 예 (pg 실행중일 때 psql 접속):
  ```bash
  docker exec -it my-postgres psql -U postgres -d mydb -c "SELECT now();"
  ```
- Linux에서 로그/자원 점검:
  - PostgreSQL 로그 확인: tail -f /var/log/postgresql/postgresql-*.log
  - 디스크 사용량 모니터: df -h, iostat 등
  - WAL 디렉토리 사용량 점검: du -sh /var/lib/postgresql/*/main/pg_wal
- 장시간 락/쿼리 확인:
  ```sql
  SELECT pid, state, query_start, now() - query_start AS duration, query 
  FROM pg_stat_activity WHERE state <> 'idle' ORDER BY duration DESC LIMIT 20;
  ```

모니터링·검증 포인트(실무에서 꼭 체크)
- replication lag (동기화 필요 시)
  ```sql
  SELECT application_name, client_addr, state, sync_state, pg_xlog_location_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
  FROM pg_stat_replication;
  ```
  (버전에 따라 함수명이 다를 수 있으니 확인)
- 테이블 사이즈와 bloat:
  ```sql
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables WHERE relname='users';
  ```
- 인덱스 사용 여부: EXPLAIN 분석으로 새 컬럼 관련 쿼리 계획 확인
- 트랜잭션 빈도 및 장기 트랜잭션 유무 확인

간단한 예시: 배치 스크립트 (bash + psql)
```bash
#!/bin/bash
DB="mydb"
USER="postgres"
BATCH=10000

while true; do
  psql -U $USER -d $DB -c "
  WITH c AS (
    SELECT ctid FROM users WHERE email_hash IS NULL LIMIT $BATCH
  )
  UPDATE users u SET email_hash = md5(u.email)
  FROM c WHERE u.ctid = c.ctid;
  " -q

  # 처리된 행 수 확인
  cnt=$(psql -U $USER -d $DB -At -c "SELECT count(*) FROM users WHERE email_hash IS NULL;")
  echo "남은 행: $cnt"
  if [ "$cnt" -eq "0" ]; then
    break
  fi
  sleep 1
done
```

공부하면서 알게 된 점
- PostgreSQL의 DDL 동작은 버전별로 차이가 크다는 점을 실제로 여러 문서를 보면서 더 실감했습니다. 예컨대 어떤 버전에서는 DEFAULT를 가진 컬럼 추가가 테이블을 재작성하지 않도록 개선된 기능이 있었습니다.
- 작은 배치로 나눠 업데이트하면 WAL과 IO를 훨씬 제어하기 쉬웠고, VACUUM을 적극적으로 활용해야 bloat 누적을 막을 수 있다는 걸 배웠습니다.
- 트리거는 구현이 비교적 쉽지만 쓰기 처리량이 높은 테이블에선 부하 요인이 되므로 상황에 맞게 선택해야 합니다.

처음에는 헷갈렸던 부분
- "ALTER TABLE ADD COLUMN DEFAULT X"가 항상 테이블을 재작성하는지 여부였는데, 버전과 DEFAULT 값의 종류(volatile function vs constant) 등에 따라 동작이 달라서 착각했습니다.
- CONCURRENTLY 옵션의 제한(예: 트랜잭션 내에서 사용 불가)과 실패 시 처리가 필요하다는 것도 처음엔 놓치기 쉬운 부분이었습니다.

실무에서는 이렇게 확인하면 좋겠다
- 변경 전후의 쿼리 계획(EXPLAIN)을 비교해 인덱스가 잘 적용되는지 확인하세요.
- 스테이징에서 동일한 데이터 크기와 부하(또는 샘플 부하)로 시뮬레이션해 실제 소요 시간과 WAL 증분을 측정하세요.
- 변경 작업 중 모니터링(Active queries, locks, IO, WAL 사용량)을 실시간으로 보고 이상치가 보이면 즉시 중단할 계획(롤백/스톱)도 마련하세요.
- 복구, 백업 절차는 변경 전 반드시 최신 상태로 확보하세요 (pg_basebackup, pg_dump 등).

추가 개념도: 배치 백필 흐름
![배치 백필과 트리거 동기화 개념](/assets/img/posts/blog/postgresql-online-schema-change-minimal-downtime/image-2.webp)
이미지 출처: AI 생성 이미지

마무리하며
제가 공부한 절차를 정리해봤습니다. 핵심은 "테이블 전체 재작성을 피하면서(또는 통제하면서) 단계적으로 진행" 하는 것입니다. 환경에 따라 선택지가 달라지니, 실제 운영 환경에서는 작은 규모로 테스트하고, 모니터링을 준비한 뒤 적용하시길 권합니다.

실무 체크리스트
- [ ] PostgreSQL 버전과 해당 버전의 ALTER TABLE 동작을 문서로 확인
- [ ] 테이블 크기, 파티셔닝 여부, 인덱스 현황 확인
- [ ] 운영 및 스테이징에서 시간/IO/WAL 영향 시뮬레이션
- [ ] 백업(전체/증분) 및 롤백 플랜 준비
- [ ] 배치 백필 스크립트(배치 크기·간격) 및 모니터링 스크립트 준비
- [ ] 쓰기 동기화 방식 결정(트리거 vs replication) 및 테스트
- [ ] 인덱스 생성은 CONCURRENTLY 사용, 실패 시 재시도 계획 수립
- [ ] 최종 스왑(컬럼 rename/제약 추가)은 가능한 한 짧게 수행
- [ ] 작업 후 VACUUM/ANALYZE 및 bloat 점검, 필요 시 pg_repack 검토

참고 문서와 도구(제가 확인했던 것들)
- PostgreSQL 공식 문서의 ALTER TABLE 관련 섹션
- pg_repack 확장 문서
- 실제 운영 로그와 pg_stat_activity, pg_stat_replication 뷰

끝으로, 저는 이 절차를 실무에 바로 적용하기보다는 우선 스테이징에서 여러 번 시도하면서 환경별 세부 조정을 할 것을 추천합니다. 궁금한 점이 있거나 특정 상황(예: 파티셔닝 테이블, 스트리밍 복제 환경 등)에 대해 더 알고 싶으면 알려주세요.