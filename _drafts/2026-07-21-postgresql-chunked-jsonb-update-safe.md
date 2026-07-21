---
title: "PostgreSQL에서 대규모 JSONB 컬럼을 청크로 안전하게 업데이트하는 실전 절차"
description: "대량의 jsonb 컬럼을 전체 업데이트하기 전 점검 항목, 배치(청크) 방식 예시, 실패 증상(잠금·WAL·바이너리 토스트), 모니터링·복구 명령어 및 적용 후 확인 절차을 중심으로 정리"
slug: "postgresql-chunked-jsonb-update-safe"
date: 2026-07-21 10:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "jsonb", "database-migration", "성능튜닝", "장애대응"]
image:
  path: /assets/img/posts/blog/postgresql-chunked-jsonb-update-safe/preview.png
  alt: "JSONB 대량 업데이트 썸네일"
---

PostgreSQL에서 수백만 건의 레코드에 있는 jsonb 칼럼을 한 번에 바꾸면 잠금, WAL 폭주, 복제 지연, 테이블 부피 증가 같은 문제가 생기기 쉬워서, **작은 트랜잭션(청크) 단위로 나눠 적용하고 모니터링하는 것**이 더 안전하다고 정리할 수 있었습니다. 아래는 청크 업데이트를 안전하게 실행하기 위한 점검 항목, 실패 예시와 수정 예시, 실무에서 바로 쓸 수 있는 명령과 체크리스트입니다.

왜 이런 작업에서 헷갈렸는지: 로컬 샘플 데이터로는 문제가 없어 보였는데 프로덕션 규모에서는 트랜잭션 시간과 WAL 쓰기량이 병목을 일으킨다는 걸 뒤늦게 알았습니다. 그래서 실제 환경에서 확인할 포인트 중심으로 단계별로 적어봅니다.

## 핵심 개념 요약(짧게)
- **대량 업데이트는 WAL, TOAST, 트랜잭션 크기, 잠금, 복제 지연**을 유발할 수 있다.
- 작은 청크(예: 500~10,000행)로 나눠 커밋하면서 진행 상태와 WAL/디스크 사용량을 모니터하면 안전성은 크게 올라간다.
- 인덱스·제약 조건·트리거 유무에 따라 전략을 바꿔야 한다.

## 실무로 직결되는 확인 포인트(시작하기 전에)
- PostgreSQL 버전: SELECT version(); (예: PostgreSQL 13.4)
- 대상 테이블 크기: SELECT count(*) FROM my_table;
- 테이블 전체 디스크 사용량: SELECT pg_size_pretty(pg_total_relation_size('my_table'));
- WAL 남용 확인: SELECT sum(pg_xlog_location_diff(pg_current_wal_lsn(), replay_lsn)) ... 또는 모니터링 툴
- 활성 세션/잠금 확인: SELECT * FROM pg_stat_activity WHERE datname='yourdb'; SELECT * FROM pg_locks WHERE relation::regclass::text='my_table';
- 인덱스·제약·트리거 유무: \d my_table 와 \dx, 확인

(위 명령어들은 반드시 프로덕션에서 조회 권한으로 실행하고, 스냅샷을 만들지 않도록 주의하세요.)

## 실패 예시(안 좋은 패턴)
아래는 흔히 할 수 있는 '한 번에 업데이트' 예시입니다. 문제: 전체 테이블이 롱 트랜잭션에 잡히면서 WAL이 급증하고 복제가 멈추고, 트랜잭션이 끝날 때까지 디스크가 늘어납니다.

```
-- 실패 예시: 대량 한 번에 업데이트 (좋지 않음)
UPDATE my_table
SET payload = jsonb_set(payload, '{user,active}', 'true', true)
WHERE payload->'user' IS NOT NULL;
```

실제 실패 증상(자주 보이는 로그/메시지)
- psql에서 응답 지연, 다른 쿼리 블록
- 리플리케이션 지연이 커짐: replication lag seconds 증가
- WAL 디스크 부족: ERROR: could not write to file "pg_wal/..." (no space left on device)
- autovacuum이 작업을 못 따라옴 -> 테이블/인덱스 bloat 증가

## 수정 예시(청크 단위로 안전하게)
여기서는 기본 키(id)가 연속적이라 가정하고 id 범위 기반으로 진행하는 예를 보여줍니다. 다른 방법으로 ctid 기반 청크나 시간 기반 배치도 가능하지만, id 범위가 가장 안정적입니다.

1) 사전 점검(버전·사이즈·잠금)
```
SELECT version();
SELECT count(*) FROM my_table;
SELECT pg_size_pretty(pg_total_relation_size('my_table'));
SELECT relname, n_live_tup FROM pg_stat_all_tables WHERE relname='my_table';
```

2) 배치 스크립트 예 (bash + psql)
```
#!/bin/bash
DB="mydb"
USER="deploy"
CHUNK=1000
LAST_ID=0

while true; do
  IDS=$(psql -U $USER -d $DB -t -c "SELECT id FROM my_table WHERE id > $LAST_ID ORDER BY id LIMIT $CHUNK;")
  if [ -z "$IDS" ]; then
    echo "done"
    break
  fi
  LAST_ID=$(echo "$IDS" | tail -n1 | tr -d ' ')
  psql -U $USER -d $DB -c "BEGIN;
    UPDATE my_table
    SET payload = jsonb_set(payload, '{user,active}', 'true', true)
    WHERE id IN ($(echo "$IDS" | paste -sd, -));
    COMMIT;"
  sleep 0.5
done
```

3) plpgsql 반복문(서버 사이드)
```
DO $$
DECLARE
  batch RECORD;
  cnt INT := 0;
BEGIN
  LOOP
    WITH c AS (
      SELECT id FROM my_table WHERE id > COALESCE((SELECT max(applied_id) FROM migration_meta), 0)
      ORDER BY id LIMIT 1000
    )
    UPDATE my_table t SET payload = jsonb_set(payload, '{user,active}', 'true', true)
    FROM c WHERE t.id = c.id
    RETURNING t.id INTO batch;

    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt = 0 THEN
      EXIT;
    END IF;

    -- 여기서 migration_meta 같은 테이블에 진행상태를 기록하면 재시작 용이
    PERFORM pg_sleep(0.3);
  END LOOP;
END;
$$;
```

주의: 위 DO 블록은 단일 트랜잭션으로 감싸지 않도록 설계해야 합니다. 실제로는 각 배치마다 COMMIT을 보장해야 재시작·중단 복구가 쉽습니다.

## 청크 전략 비교
| 전략 | 장점 | 단점 | 추천 상황 |
|---:|---|---|---|
| id 범위 | 읽기·쓰기 모두 예측 가능, 간단 | id 간격 불균형 시 한 청크가 커짐 | PK가 균등하면 기본 선택 |
| LIMIT + ORDER BY | 구현 간단 | offset 사용 시 느림, 재시작 시 불편 | 작은 테이블·단일 프로세스 |
| ctid 기반 | 빠름, 인덱스 필요 없음 | VACUUM/REORG로 ctid 변경 가능 | 일시적 스크립트, 재시작 불편 |
| 임시 테이블 + swap | 최소 잠금, 빠른 스왑 | 구현 복잡, 디스크 추가 필요 | 대량 교체 또는 스키마 변경 시 |

(**중요**) 각 전략은 인덱스·FK·트리거 존재 여부에 따라 영향이 큽니다. FK/트리거가 있다면 임시 테이블 + swap이 안전할 때가 있습니다.

## 실행 가능한 점검·모니터링 명령(세부)
- 세션/잠금: SELECT pid, usename, application_name, state, query FROM pg_stat_activity WHERE datname='mydb';
- WAL 사용량 예측: SELECT pg_current_wal_lsn();
- 테이블 크기 확인: SELECT pg_size_pretty(pg_total_relation_size('my_table'));
- bloat 확인(간단): SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_all_tables WHERE relname='my_table';
- 복제 지연 확인(비동기): SELECT client_addr, state, sent_lsn, replay_lsn, pg_wal_lsn_diff(sent_lsn, replay_lsn) AS bytes_lag FROM pg_stat_replication;
- 작업 수와 속도 모니터: 쿼리별 EXPLAIN ANALYZE, 그리고 UPDATE 후 SELECT count(*) WHERE payload->'user'->>'active'='true' 로 적용 범위 확인

## 실패 케이스와 디버그 예
실패 메시지 예시:
- ERROR: could not write to file "pg_wal/000000010000000000000001": No space left on device
- ERROR: canceling statement due to conflict with recovery
- NOTICE: could not shrink segment ... (자동화 환경에서 볼 수 있음)

디버그 절차 (우선순위)
1. 즉시 중단 가능하면 중단(스크립트 종료), 그 후 남은 롱 트랜잭션 확인: SELECT * FROM pg_stat_activity WHERE state='active';
2. 디스크 사용량 확인: df -h /var/lib/postgresql && SELECT pg_size_pretty(pg_total_relation_size('my_table'));
3. WAL 파일 수·크기 확인: ls -lh /var/lib/postgresql/…/pg_wal
4. 복제 상태 확인: SELECT * FROM pg_stat_replication;
5. 필요한 경우 복제 지연을 줄이기 위해 스크립트 속도 조절(sleep 더 늘리기) 또는 배치 크기 축소

## 코드 예시 — 실패 vs 개선 비교

실패 (한 번에):
```
UPDATE my_table
SET payload = jsonb_set(payload, '{meta,version}', '"v2"', true);
-- 이 한 줄로 수백만 row를 건드리면 WAL과 잠금 문제 발생
```

개선 (청크, 커밋 보장):
```
-- 배치 예: id 범위로 1000씩
BEGIN;
UPDATE my_table SET payload = jsonb_set(payload, '{meta,version}', '"v2"', true)
WHERE id BETWEEN 100001 AND 101000;
COMMIT;
```

## 재시작/중단 후 복구 방법
- 각 배치 완료 후 progress 테이블에 마지막 id를 기록하면 재시작 시 해당 id부터 이어서 실행 가능
- 중간에 실패하면 배치 단위로 되돌리거나(예: 트랜잭션 롤백) 이미 커밋된 배치는 그대로 두고 다음 배치부터 진행
- 만약 테이블 bloat가 심해지면 작업 후 VACUUM (FULL은 주의), 또는 pg_repack 같은 툴 사용을 고려

## 공식 문서·검증 경로
- PostgreSQL 문서: WAL, TOAST, VACUUM 관련 페이지(예: https://www.postgresql.org/docs/current/)
- 재현 명령: 작은 샘플 테이블(예: 1M 행) 생성 후 동일 스크립트로 성능 비교
- 확인 명령(요약): SELECT version(); SELECT count(*) FROM my_table; SELECT pg_size_pretty(pg_total_relation_size('my_table')); SELECT * FROM pg_stat_activity; SELECT * FROM pg_stat_replication;

## 자주 묻는 질문 / Q&A
Q: 청크 크기는 어떻게 정해야 하나요?
A: 환경마다 다르지만 **메모리·WAL·디스크의 여유**에 따라 결정하세요. 실무 포인트로는 처음엔 500~1,000으로 시작해 WAL 증가량·트랜잭션 시간(초)·복제 지연(sec)을 보고 배율(2배)로 조정하는 편이 안전합니다.

Q: 트랜잭션을 작게 하면 인덱스 재작성 비용은 어떻게 되나?
A: 각 UPDATE는 새로운 튜플을 만들어 인덱스를 갱신하므로 트랜잭션이 많아지면 전체 인덱스 작업량은 비슷하지만 한 번에 걸리는 잠금·WAL 폭주는 줄어듭니다. 인덱스 bloat를 줄이려면 작업 후 VACUUM이나 pg_repack 고려.

Q: jsonb_set 대신 jsonb || 사용하면 어떨까?
A: jsonb_set은 경로 지정이 편하고 일부 키만 바꾸기에 적합합니다. 전체 교체가 필요하면 || 연산자가 더 단순할 수 있으나, **불필요한 쓰기량**을 줄이려면 변경 전후를 비교해서 실제 변경이 필요한 행만 업데이트하세요.

Q: 복제 환경에서 안전한가?
A: 비동기 복제라면 리플리케이션 지연(바이트 또는 시간)을 모니터하면서 진행해야 합니다. 지연이 커지면 배치 크기/속도를 줄이세요.

## 나의 의견 1
이 작업을 실제로 해본 환경에서 사용한 PostgreSQL 버전, 청크 크기, 처음 실패했던 명령을 적어보세요.

## 나의 의견 2
작업 후 WAL 증가량, 테이블 크기 변화(예: before/after pg_total_relation_size), 적용 시간(초) 같은 숫자 기록을 남겨 보세요.

![간단한 jsonb 업데이트 흐름 다이어그램](/assets/img/posts/blog/postgresql-chunked-jsonb-update-safe/image-1.webp)
이미지 출처: AI 생성 이미지

(위 이미지는 청크 처리와 커밋 흐름을 간단히 표현한 일러스트입니다)

![배치별 모니터링 체크리스트 이미지](/assets/img/posts/blog/postgresql-chunked-jsonb-update-safe/image-2.webp)
이미지 출처: AI 생성 이미지

(위 이미지는 실행 중인 배치의 모니터링 포인트를 요약한 일러스트입니다)

## 실무 체크리스트
- [ ] PostgreSQL 버전 확인: SELECT version();
- [ ] 전체 행 수·테이블 크기 확인: SELECT count(*) FROM my_table; SELECT pg_size_pretty(pg_total_relation_size('my_table'));
- [ ] 인덱스/트리거/FK 확인: \d my_table
- [ ] 복제 상태 점검: SELECT * FROM pg_stat_replication;
- [ ] 배치 스크립트 준비: 배치 크기, 커밋 보장, 상태 테이블(예: migration_meta) 준비
- [ ] 모니터링 쿼리 준비: pg_stat_activity, pg_locks, WAL 위치 조회
- [ ] 테스트 실행(스테이징): 동일한 row수 샘플로 시뮬레이션(예: 100k rows)
- [ ] 배치 실행 중 모니터링: WAL 증가량, replication lag, 디스크 여유
- [ ] 작업 완료 후 VACUUM ANALYZE 실행 또는 pg_repack 고려
- [ ] 적용 전후 성능·디스크 비교값 기록(숫자 3가지 이상: rows, PG size, 적용 시간)

끝으로, 이 주제에서 먼저 확인해야 할 것은 **(1) 대상 테이블의 크기·인덱스·트리거 유무, (2) 복제/디스크 여유, (3) WAL 증가 허용치**입니다. 만약 FK나 트리거로 인해 행 단위 업데이트가 부담스럽다면 임시 테이블로 새로운 버전을 만들고 스왑하는 방식이 더 나을 수 있습니다. 더 궁금한 지점(예: ctid 기반 배치 코드, pg_repack 사용 예, 트리거가 있을 때 전략)을 알려주시면 그 상황에 맞춘 스크립트와 점검 절차를 함께 정리해 드릴게요.