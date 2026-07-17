---
title: "PostgreSQL 인덱스 설계 기초 — 처음 설계할 때 확인할 기준과 실무 점검"
description: "오늘은 \"PostgreSQL 인덱스를 처음 설계할 때 알아야 할 기준\"에 대해 제가 공부하면서 정리한 내용을 적어봅니다. 초보 입장에서 실무에 바로 적용할 수 있는 포인트 위주로, 헷갈렸던 부분과 실무에서 확인하면 좋은 점검 절차도 함께 적습니다"
slug: "postgresql-index-design-basics"
date: 2026-07-10 10:00:00 +0900
categories: [Database, PostgreSQL]
tags: [postgresql, indexing, query-optimization, index-performance, database]
---

오늘은 "PostgreSQL 인덱스를 처음 설계할 때 알아야 할 기준"에 대해 제가 공부하면서 정리한 내용을 적어봅니다. 초보 입장에서 실무에 바로 적용할 수 있는 포인트 위주로, 헷갈렸던 부분과 실무에서 확인하면 좋은 점검 절차도 함께 적습니다. 제가 틀리거나 더 좋은 방법이 있을 수 있으니 참고 자료로 보시고, 실제 환경에서는 테스트해보면서 결정하시는 게 좋겠습니다.

공부하면서 알게 된 점
- 인덱스는 검색 속도를 빠르게 해주지만 항상 무조건 좋은 건 아닙니다. 읽기(SELECT)는 빨라지지만 쓰기(INSERT/UPDATE/DELETE)와 디스크/메모리 비용이 늘어납니다.
- PostgreSQL 기본 인덱스는 btree이고, 흔히 쓰는 패턴(=, <, >, BETWEEN, ORDER BY ... ASC/DESC 등)에 적합합니다. 그 외 gin, gist, brin 같은 특수 인덱스는 특정 데이터·쿼리 패턴에서 효과적입니다.
- "칼럼 선택성(selectivity)", "카디널리티(cardinality)", "쿼리 패턴"을 먼저 봐야 합니다. 자주 조회되는 조건(WHERE)에 대해 높은 선택성을 가지는 칼럼이 인덱스 후보가 됩니다.
- 복합 인덱스(multicolumn index)는 컬럼 순서가 중요합니다. btree 인덱스는 왼쪽 접두사(leftmost) 규칙이 적용됩니다.
- 인덱스만 있는 쿼리(covering index or index-only scan)는 성능상 이득이 큽니다. 다만 index-only scan은 visibility map(가비지 제거 상태)에 따라 달라집니다.

처음에는 헷갈렸던 부분
- multicolumn 인덱스의 순서: "어떤 컬럼을 먼저 둘까?"가 헷갈렸습니다. 일반적인 가이드라인은 WHERE 절에서 자주 필터링되는 가장 선택적인 컬럼을 왼쪽에 두는 것입니다. 하지만 ORDER BY나 GROUP BY 패턴도 고려해야 합니다.
- low-cardinality 컬럼(예: 성별, boolean)을 인덱스할지 말지는 상황에 따라 다릅니다. 단일로는 효과가 없더라도 partial index나 자주 결합되는 다른 컬럼과의 multicolumn 인덱스에서는 의미가 있을 수 있습니다.
- index-only scan이 동작하는 조건: 인덱스에 필요한 컬럼이 모두 포함되어 있고, visibility map이 설정되어 있어야 실제로 디스크 블록 접근을 줄일 수 있습니다.
- 통계(stattarget), planner cost parameter, correlation 값이 쿼리 플랜에 미치는 영향은 처음엔 직관적으로 와닿지 않았습니다. 실제 쿼리에 대해 EXPLAIN ANALYZE를 자주 보면서 확인하는 게 도움이 되었습니다.

인덱스 종류(요약)
- btree: 기본. 등가·범위 비교, ORDER BY, GROUP BY에 적합.
- gin: 역색인. jsonb, array, full-text search 같은 경우 사용.
- gist: 지리공간, 근접 검색 등에 적합한 일반화된 색인.
- brin: 대용량 테이블에서 연속성(physical correlation)이 높을 때 유용, 아주 작은 메모리로 표현.
- hash: 등가 검색에 최적화되지만 최근 버전에서는 안정성과 성능 개선이 있었습니다(버전 확인 필요).

실무에서는 이렇게 확인하면 좋겠다 — 점검 절차과 명령
아래는 실무에서 인덱스 설계/적용 후 점검해볼 체크 포인트와 명령 예시입니다. 대부분의 명령은 psql에서 실행한다고 가정합니다. Docker로 테스트하는 예제도 포함합니다.

1) 테스트용 PostgreSQL 컨테이너 띄우기 (간단)
```sh
docker run --name pg-test -e POSTGRES_PASSWORD=pass -p 5432:5432 -d postgres:15
# psql 접속
docker exec -it pg-test psql -U postgres
```

2) 익스플레인(실행 계획)으로 먼저 확인
- EXPLAIN과 EXPLAIN ANALYZE는 필수입니다. 예상(planner)과 실제 시간 차이를 보세요.
```sql
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer_id = 123;
```
- 결과에서 "Index Scan"이 나오면 인덱스가 사용된 것이고, "Seq Scan"이면 전체 스캔입니다. 단순히 Index Scan이 빠른 것은 아니므로 항상 실제 시간을 봐야 합니다.

3) 인덱스 사용 빈도 확인
- 인덱스가 실제로 사용되는지 확인하려면 pg_stat_user_indexes를 보세요.
```sql
SELECT
  schemaname, relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan DESC;
```
- idx_scan=0인 인덱스는 실무에서 제거 후보가 될 수 있습니다(단, 사용 패턴이 바뀔 수 있으니 백업/검토 필요).

4) 테이블의 전체 스캔 대비 인덱스 스캔 비율
```sql
SELECT
  relname,
  seq_scan,
  idx_scan,
  CASE WHEN seq_scan+idx_scan = 0 THEN NULL ELSE 100.0*idx_scan/(seq_scan+idx_scan) END as idx_ratio
FROM pg_stat_user_tables
ORDER BY idx_ratio DESC NULLS LAST;
```

5) 인덱스 크기 확인
```sql
-- 개별 인덱스 크기
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) as size
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;

-- 테이블 전체(테이블+인덱스)
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) as total_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

6) 인덱스 중복 / 불필요한 인덱스 탐지 (간단 예)
```sql
-- 같은 테이블에 동일한 인덱스 구조(단순 체크)
SELECT
  t.relname AS table_name,
  i.indexrelname AS index_name,
  pg_get_indexdef(i.indexrelid) AS index_def
FROM pg_stat_user_indexes i
JOIN pg_class t ON i.relid = t.oid
ORDER BY table_name, index_def;
```
더 정교한 중복 탐지는 pg_index와 인덱스 정의를 비교해야 합니다.

7) 인덱스(또는 테이블) 부풀음(bloat) 점검
- bloat 체크는 정확한 계산이 복잡합니다. 간단한 추정 쿼리를 사용하거나 pg_repack, pgstattuple 확장 도구를 이용해보세요.
```sql
-- pgstattuple 사용 (확장 설치 필요)
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT * FROM pgstattuple('public.my_table');
```
- pg_repack은 운영 중에 테이블/인덱스 재정비가 필요할 때 유용합니다(다운타임 없이 재정비 가능).

8) 인덱스 생성/제거 권장 절차
- 프로덕션에서 인덱스 생성은 가능한 CONCURRENTLY로:
```sql
CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id);
DROP INDEX CONCURRENTLY idx_unused;
```
- CONCURRENTLY는 롱 트랜잭션과 충돌할 수 있으니 오프피크에 수행하고 모니터링하세요.

9) 인덱스 설계 예시
- 단일 컬럼 btree
```sql
CREATE INDEX idx_users_email ON users (email);
```
- 복합 인덱스 (leftmost 규칙 주의)
```sql
CREATE INDEX idx_orders_customer_date ON orders (customer_id, created_at);
```
- 부분 인덱스 (partial)
```sql
CREATE INDEX idx_active_users ON users (last_login) WHERE active IS TRUE;
```
- 표현식 인덱스 (function-based)
```sql
CREATE INDEX idx_lower_email ON users (lower(email));
```
- INCLUDE로 covering index (Postgres 11+)
```sql
CREATE INDEX idx_orders_customer_inc ON orders (customer_id) INCLUDE (total_amount, status);
```
- jsonb에 gin 사용
```sql
CREATE INDEX idx_orders_payload_gin ON orders USING gin (payload jsonb_path_ops);
```

10) 통계와 planner 가중치 조정
- 특정 컬럼의 통계를 더 자세히 보고 싶으면 ALTER TABLE ... ALTER COLUMN ... SET STATISTICS를 조절하고 VACUUM ANALYZE를 실행합니다.
```sql
ALTER TABLE users ALTER COLUMN email SET STATISTICS 1000;
ANALYZE users;
```
- 하지만 무턱대고 큰 통계를 설정하면 분석 비용이 올라갈 수 있습니다. 상황에 따라 적절히 조정하세요.

11) 모니터링·로그: pg_stat_statements, slow query log
- 확장 설치:
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- postgresql.conf에 shared_preload_libraries = 'pg_stat_statements'가 필요할 수 있음
```
- 상위 느린 쿼리 확인
```sql
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY total_time DESC
LIMIT 20;
```

12) 운영(리소스) 점검: 디스크/IO/메모리
- Linux에서 디스크와 IO 상황을 체크:
```sh
# 디스크 사용량
df -h
# iostat (sysstat 설치 필요)
iostat -x 1 5
# 메모리
free -h
```
- DB측면에서는 shared_buffers, work_mem, maintenance_work_mem 설정과 인덱스 빌드 시 메모리 여유를 확인하세요.

간단한 EXPLAIN 예시와 해석 (예시)
```sql
EXPLAIN ANALYZE
SELECT id, total_amount FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 10;
```
- 이 결과에서 "Index Scan using idx_orders_customer_date on orders" + "Filter: (customer_id = 42)" + 실행 시간(총 시간/루프 수)을 보면 인덱스가 필터링과 정렬에 도움이 되는지 판단할 수 있습니다.
- 만약 Seq Scan이 사용된다면 인덱스가 없거나 planner가 인덱스 사용이 비효율적이라고 판단한 것입니다. 인덱스 통계, 테이블 크기, 비용 파라미터가 원인이 될 수 있습니다.

제가 실무에서 적용해보며 느낀 것들 (조심스럽게)
- 모든 컬럼을 일단 다 인덱스하는 접근은 추천하지 않습니다. 운영 중 인덱스가 많아지면 쓰기 지연과 디스크 비용이 눈에 띄게 늘었습니다.
- 읽기 성능이 문제라면 우선 EXPLAIN ANALYZE로 병목 쿼리를 정확히 파악한 뒤, 시험용 인덱스를 만들어 직접 벤치마크해보는 것이 안전합니다.
- 인덱스 튜닝은 쿼리 패턴이 바뀌면 재평가해야 합니다. 주기적으로(예: 분기별) pg_stat_statements 결과를 보고 상위 쿼리를 재검토하는 루틴이 도움이 됐습니다.
- 브랜딩(예: BRIN)은 로그나 시계열처럼 자연 정렬되어 있는 대규모 테이블에서 유용했지만, 데이터 스키우(불연속) 상황에서는 효과가 떨어졌습니다.

실무 체크리스트
- [ ] 문제 쿼리를 EXPLAIN ANALYZE로 확인했는가?
- [ ] 해당 WHERE/ORDER BY 패턴에 적합한 인덱스 유형(btree/gin/brin 등)을 선택했는가?
- [ ] 복합 인덱스의 컬럼 순서를 쿼리 패턴에 맞게 정했는가(왼쪽 접두사 규칙)?
- [ ] 인덱스 생성은 가능하면 CREATE INDEX CONCURRENTLY로, 오프피크에 수행했는가?
- [ ] pg_stat_user_indexes와 pg_stat_user_tables로 인덱스 사용 통계를 점검했는가?
- [ ] 인덱스 크기와 테이블 bloat를 확인했는가( pg_relation_size, pg_total_relation_size, pgstattuple 등 )?
- [ ] pg_stat_statements를 통해 상위 느린 쿼리를 모니터링하는 루틴이 있는가?
- [ ] 인덱스 추가로 인한 쓰기 성능 저하 가능성을 테스트했는가(INSERT/UPDATE TPS 영향)?
- [ ] AUTOVACUUM, maintenance_work_mem, shared_buffers 등 관련 설정을 검토했는가?
- [ ] 백업·롤백 계획(인덱스 롤백 시 영향 포함)을 마련했는가?

마무리하며
이 글은 제가 인덱스를 처음 설계하면서 정리한 요약과 실무에서 바로 쓸 수 있는 점검 목록입니다. 인덱스는 매우 강력한 도구지만, 환경과 쿼리 패턴에 따라 효과가 달라질 수 있습니다. 가능하면 테스트 환경에서 충분히 검증한 뒤 운영에 반영하시고, 모니터링을 통해 지속적으로 재평가하는 것을 권합니다. 부족한 점이 있으면 지적해주시면 감사하겠습니다.