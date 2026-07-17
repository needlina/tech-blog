---
title: "무중단 데이터베이스 스키마 마이그레이션과 안전한 롤백 전략"
description: "오늘은 \"무중단으로 데이터베이스 스키마 마이그레이션을 롤아웃하고, 안전하게 롤백하는 방법\"을 공부한 내용을 정리하려고 합니다. 저는 아직 초보 개발자라 완벽하진 않지만, 공부하면서 알게 된 점과 처음에는 헷갈렸던 부분, 그리고 실무에서 확인하면 좋을 포인트 중심으로 차근차근"
slug: "zero-downtime-db-migrations-rollout-rollback"
date: 2026-07-16 10:00:00 +0900
categories: ["Database", "DevOps"]
tags: ["database-migrations", "zero-downtime", "rollback", "postgres", "devops"]
image:
  path: /assets/img/posts/blog/zero-downtime-db-migrations-rollout-rollback/preview.png
  alt: "무중단 DB 마이그레이션 썸네일"
---

오늘은 "무중단으로 데이터베이스 스키마 마이그레이션을 롤아웃하고, 안전하게 롤백하는 방법"을 공부한 내용을 정리하려고 합니다. 저는 아직 초보 개발자라 완벽하진 않지만, 공부하면서 알게 된 점과 처음에는 헷갈렸던 부분, 그리고 실무에서 확인하면 좋을 포인트 중심으로 차근차근 적어봅니다. 틀릴 수 있는 부분은 조심스럽게 표현하려고 하고요, 실제 환경에 적용하기 전에는 반드시 테스트 환경에서 확인해보시길 권합니다.

목차
- 왜 스키마 변경이 어렵게 느껴졌나
- 무중단(Zero-downtime) 마이그레이션의 기본 아이디어
- 자주 쓰는 안전한 패턴과 예시 (PostgreSQL 중심)
- 명령어, 점검 절차, 실무 확인 포인트
- 안전한 롤백 전략(파괴적 변경과 비파괴적 변경 구분)
- 공부하면서 알게 된 점 / 처음 헷갈렸던 부분
- 실무 체크리스트

왜 스키마 변경이 어렵게 느껴졌나
- 스키마 변경이 테이블 잠금, 긴 트랜잭션, 복제 지연 등으로 서비스에 영향을 줄 수 있어서인지 처음엔 굉장히 부담스럽게 느껴졌습니다.
- 특히 "ALTER TABLE" 같은 명령이 내부에서 어떤 잠금(lock)을 잡는지, 인덱스 생성이 어떤 방식으로 진행되는지 헷갈렸습니다.
- 공부를 하면서 모든 변경이 즉시 위험한 것은 아니고, 안전하게 할 수 있는 패턴들이 있다는 것을 조금씩 확인하게 됐습니다.

무중단 마이그레이션의 기본 아이디어 (개념 정리)
- 파괴적(destructive) 변경과 비파괴적(non-destructive) 변경을 구분:
  - 비파괴적: 컬럼 추가(nullable/without default), 인덱스 생성(concurrently), 뷰/함수 추가 등. 보통 서비스 중에도 안전하게 수행 가능.
  - 파괴적: 컬럼 삭제, 타입 변경(데이터 변환이 필요한 경우), 컬럼 NOT NULL 설정과 default 변경 등. 주의가 필요.
- 단계적 롤아웃:
  1. 스키마 준비(새 컬럼 추가, 새로운 인덱스 생성) — 애플리케이션은 기존 방식도 계속 사용
  2. 애플리케이션 코드 배포(읽기/쓰기 모두 새 스키마도 사용하도록 변경)
  3. 데이터 백필(backfill) 또는 점진적 전환
  4. 불필요한 레거시 컬럼 제거(충분히 시간이 지난 뒤, 파괴적 변경)
- 애플리케이션 레벨의 feature flag(또는 버전 호환성 유지)를 활용해 DB와 코드의 호환성을 관리

자주 쓰는 안전한 패턴과 예시 (PostgreSQL 중심)
- 컬럼 추가(안전한 순서)
  1. NULL 허용 상태로 컬럼 추가
     - ALTER TABLE my_table ADD COLUMN new_col text;
  2. 애플리케이션에서 새 컬럼을 읽고 쓰도록 변경(동시성 고려)
  3. 백필(필요한 경우 배치로)
  4. 기본값 설정 및 NOT NULL 적용(가능하면 트랜잭션 없이 단계적으로)
     - ALTER TABLE my_table ALTER COLUMN new_col SET DEFAULT 'x';
     - UPDATE를 통한 일괄 백필 후: ALTER TABLE my_table ALTER COLUMN new_col SET NOT NULL;

- 인덱스 생성(서비스 영향 최소화)
  - CREATE INDEX CONCURRENTLY idx_name ON my_table(column);
  - CONCURRENTLY는 트랜잭션 블록 내에서 실행할 수 없고, 테이블 전체 잠금을 피하려고 설계돼 있지만 완료까지 시간이 걸립니다.
  - 진행 상황 확인: PostgreSQL 12 이상에서는 pg_stat_progress_create_index 뷰를 볼 수 있습니다.

- 백필을 배치로 안전하게 실행하는 예(예시는 psql에서 실행 가능한 형태)
  - UPDATE에 LIMIT가 없으므로 ctid를 이용해 배치 처리:
  ```
  -- 배치 크기 10000로 예시
  DO $$
  DECLARE
    rows int;
  BEGIN
    LOOP
      WITH batch AS (
        SELECT ctid FROM my_table WHERE new_col IS NULL LIMIT 10000
      )
      UPDATE my_table t SET new_col = some_expression
      FROM batch b WHERE t.ctid = b.ctid
      RETURNING 1 INTO rows;
      EXIT WHEN NOT FOUND;
      PERFORM pg_sleep(0.1); -- DB에 휴식 시간
    END LOOP;
  END
  $$;
  ```
  - 또는 간단히 별도의 스크립트(파이썬/쉘)로 반복적으로 작은 UPDATE를 호출하는 방식도 실무에서 많이 씁니다.

- 예시: 인덱스 생성 후 애플리케이션에서 사용하도록 전환
  1. CREATE INDEX CONCURRENTLY idx_new ON my_table(new_col);
  2. 애플리케이션에서 쿼리 플랜을 확인해 새 인덱스를 사용하는지 확인
     - EXPLAIN ANALYZE SELECT ...;
  3. 일정 기간 모니터링 후 기존 인덱스를 제거

명령어, 점검 절차, 실무에서 확인하면 좋은 포인트
- 활성 쿼리/긴 쿼리 확인
  - psql 예:
    ```
    SELECT pid, usename, state, now() - query_start AS duration, query
    FROM pg_stat_activity
    WHERE state = 'active'
    ORDER BY duration DESC
    LIMIT 10;
    ```
  - 장시간 실행 쿼리는 마이그레이션에 영향을 줄 수 있으니 사전에 파악 후(또는 배치시간에 재시작 유도) 처리합니다.

- 잠금(Lock) 확인
  ```
  SELECT
    l.locktype, l.mode, l.granted, a.datname, a.usename, a.query
  FROM pg_locks l
  LEFT JOIN pg_stat_activity a ON l.pid = a.pid
  WHERE a.pid IS NOT NULL;
  ```
  - ALTER TABLE 같은 명령이 길게 잠금을 잡는지 모니터링합니다.

- 인덱스 생성 진행 상태 확인(버전에 따라 다름)
  ```
  SELECT * FROM pg_stat_progress_create_index;
  ```
  - 없으면 pg_stat_activity로 확인하거나 로그를 봅니다.

- 복제 지연 확인(레플리카가 있는 경우)
  ```
  SELECT client_addr,
         pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS bytes_lag
  FROM pg_stat_replication;
  ```
  - 복제가 지연되면 롤아웃 후 읽기 복제본에서 오래된 스키마를 참조하는 상황이 발생할 수 있어 주의가 필요합니다.

- 백업(항상 사전)
  - 빠른 백업: pg_dump
    ```
    pg_dump -Fc -f /backups/dbname_$(date +%F).dump dbname
    ```
  - 물리 백업: pg_basebackup 등. 변경이 크거나 위험도가 높으면 베이스백업을 권장합니다.

Docker 환경에서 PostgreSQL 접속 예시
- 컨테이너 이름이 pg라면:
  ```
  docker exec -it pg psql -U postgres -d mydb -c "SELECT count(*) FROM my_table;"
  ```
- 로컬 개발에서 빠르게 테스트할 때 유용합니다.

안전한 롤백 전략 (실무에서 제가 정리한 흐름)
- 원칙: 가능한 한 파괴적/데이터 손실이 발생하는 롤백은 피하거나 단계를 통해 최소화
- 롤백 1 (비파괴적 변경): 애플리케이션을 이전 버전으로 되돌리고, 새 컬럼에 대한 쓰기를 중단(패치 또는 feature flag). 데이터는 그대로 보존.
- 롤백 2 (파괴적 변경을 이미 수행한 경우): 데이터 복구가 필요하면 백업에서 복원하거나, 만약 변경이 되돌릴 수 없는 상태라면 로그를 통해 보완. 따라서 중요한 변경 전 백업은 필수.
- 안전한 순서 예시:
  1. 애플리케이션 롤백(먼저 코드)
  2. 애플리케이션이 구버전과 호환되면 DB 변경은 나중에(가능하다면 제거하지 않고 유지)
  3. DB 스키마를 원상복귀 해야 한다면, 데이터 손실 여부를 반드시 확인하고 백업에서 복원

롤백 커맨드(예시)
- 새 컬럼을 제거해야 할 때(주의: 데이터 손실):
  ```
  ALTER TABLE my_table DROP COLUMN new_col;
  ```
  - 이 커맨드는 즉시 데이터가 사라질 수 있으니 사전 백업 필수.

- 인덱스 제거:
  ```
  DROP INDEX CONCURRENTLY IF EXISTS idx_new;
  ```
  - CONCURRENTLY 옵션을 사용하면 잠금 영향이 적습니다.


![데이터베이스 테이블에 새 컬럼을 단계적으로 추가하는 순서를 화살표로 보여주는 단순 다이어그램](/assets/img/posts/blog/zero-downtime-db-migrations-rollout-rollback/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점 / 처음에 헷갈렸던 부분
- CONCURRENTLY는 트랜잭션 블록 내부에서 실행될 수 없다는 점을 처음에 놓쳤습니다. psql에서 BEGIN; CREATE INDEX CONCURRENTLY ...; COMMIT; 처럼 하면 에러가 납니다.
- ALTER TABLE로 컬럼 추가할 때 'DEFAULT'를 동시에 주면 PostgreSQL 버전에 따라 전체 테이블을 쓰기 작업(write)으로 다시 쓰게 되어 오래 걸릴 수 있다는 것을 알게 됐습니다. 그래서 NULL로 먼저 추가하고 나중에 default와 not null을 적용하는 패턴을 배웠습니다.
- 백필을 하는 방법(전체 UPDATE vs 배치 업데이트)은 운영 중인 트랜잭션 부하를 고려해 배치로 수행하는 것이 안전하다는 점이 실전에서 중요하다는 걸 느꼈습니다.
- 완벽한 무중단은 어려운 목표일 수 있고, 위험을 줄이는 것이 현실적인 목표라는 점을 받아들였습니다.

실무에서는 이렇게 확인하면 좋겠다 (요약된 체크포인트)
- 사전:
  - 마이그레이션 스크립트를 스테이징에서 충분히 검증
  - 전체 백업(또는 최소한 변경 범위의 백업) 확보
  - 관련 인덱스/쿼리 성능 영향 분석
  - 롤백 절차와 담당자, 연락망(대응 플랜) 준비
- 실행 중:
  - pg_stat_activity로 긴 쿼리/활성 쿼리 모니터링
  - 잠금 상태 확인
  - 인덱스 생성 시 pg_stat_progress_create_index 또는 로그로 진행 확인
  - 레플리카가 있으면 복제 지연 모니터링
  - 애플리케이션 로그/에러 모니터링
- 실행 후:
  - 쿼리 플랜(EXPLAIN ANALYZE)으로 새 인덱스/스키마가 실제로 성능에 도움이 되었는지 확인
  - 일정 기간 모니터링 후 레거시 컬럼 제거 결정


![마이그레이션 단계(prepare → backfill → switch → cleanup)와 각 단계의 체크포인트를 아이콘으로 나열한 개념 일러스트](/assets/img/posts/blog/zero-downtime-db-migrations-rollout-rollback/image-2.webp)
이미지 출처: AI 생성 이미지

실무 체크리스트
- 마이그레이션 전에:
  - [ ] 스테이징에서 동일한 스크립트로 검증했는가?
  - [ ] pg_dump 또는 물리 백업을 확보했는가?
  - [ ] 변경 계획(단계, 롤백, 책임자)을 문서화했는가?
  - [ ] 비파괴적 순서(추가→전환→삭제)를 따르는가?
  - [ ] 애플리케이션이 새/구 스키마와 호환되는가(버전 호환성)?
- 실행 중:
  - [ ] pg_stat_activity로 장시간 쿼리 감지 후 조치했는가?
  - [ ] 잠금 상황을 모니터링했는가?
  - [ ] 인덱스 생성은 CONCURRENTLY로 진행했는가(필요 시)?
  - [ ] 복제본의 지연을 확인했는가?
  - [ ] 애플리케이션 에러 로그를 실시간으로 확인하고 있는가?
- 롤백 및 후속:
  - [ ] 애플리케이션을 먼저 롤백했는가(가능한 경우)?
  - [ ] 파괴적 롤백은 백업 근거로만 진행했는가?
  - [ ] 최종적으로 레거시 컬럼 제거 전 충분한 시간을 두었는가?

마무리(제가 느낀 점)
- 스키마 변경은 기술적으로 복잡하지만, 일련의 안전한 패턴을 따르면 위험을 많이 줄일 수 있다는 것을 배웠습니다.
- 특히 "단계적으로 바꾸고(prepare → backfill → switch → cleanup), 애플리케이션을 먼저 적응시키고(또는 롤백은 코드부터)", 그리고 "항상 백업과 모니터링"이라는 원칙이 실무에서 가장 실용적이라는 느낌을 받았습니다.
- 제가 틀렸거나 더 좋은 방법을 아시는 분은 조언해주시면 감사하겠습니다. 다음에는 실제 예제를 더 작게 분할해서 테스트용 스크립트도 정리해보려고 합니다.