---
title: "PostgreSQL EXPLAIN 읽기: 먼저 보는 항목들과 실무 체크포인트"
slug: "postgresql-explain-first-look"
date: 2026-07-11 10:00:00 +0900
categories: [Database, PostgreSQL]
tags: [postgresql, explain, query-planning, performance, indexing]
image:
  path: /assets/img/posts/blog/postgresql-explain-first-look/image-1.png
  alt: "PostgreSQL EXPLAIN 출력의 요약과 주요 항목을 도식화한 이미지"
---

오늘의 주제

PostgreSQL EXPLAIN 결과를 읽을 때 먼저 보는 항목들

처음 PostgreSQL의 EXPLAIN을 접했을 때는 출력의 숫자들과 용어들(cost, rows, actual, loops 등) 때문에 막막했습니다. 공부를 조금씩 하면서 어느 정도는 이해가 되었고, 특히 실무에서 어떤 항목을 우선적으로 확인하면 좋을지 감을 잡게 되었습니다. 이 글은 제가 공부하면서 정리한 내용을 초보의 시선으로, 실무에서 바로 확인할 포인트 위주로 정리한 것입니다. 틀릴 가능성도 있으니 참고 정도로 읽어주시면 좋겠습니다.

![PostgreSQL EXPLAIN 출력의 요약과 주요 항목을 도식화한 이미지](/assets/img/posts/blog/postgresql-explain-first-look/image-1.png)
이미지 출처: AI 생성 이미지

목차(읽는 흐름)
- EXPLAIN의 종류와 간단한 사용법
- 출력에서 먼저 보는 항목들(우선순위)
- 주요 노드(Scan/Join/Sort 등)별로 확인할 점
- 실무에서의 체크 절차(명령어·설정 예시 포함)
- 공부하면서 알게 된 점 / 헷갈렸던 부분 / 실무 팁
- 실무 체크리스트

1) EXPLAIN의 기본과 한 줄 사용법
- EXPLAIN: 쿼리 계획(추정치)만 보여줍니다.
- EXPLAIN ANALYZE: 실제 실행을 해서 실제 시간과 행 수를 보여줍니다.
- BUFFERS, VERBOSE, FORMAT JSON 등 옵션으로 더 많은 정보를 얻을 수 있습니다.

간단 예:
```sql
-- 추정 계획만
EXPLAIN SELECT * FROM orders WHERE user_id = 123;

-- 실제 실행까지 (주의: 쓰기 쿼리는 주의해서)
EXPLAIN ANALYZE VERBOSE BUFFERS SELECT * FROM orders WHERE user_id = 123;

-- JSON 포맷 (도구로 파싱할 때 편함)
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE user_id = 123;
```

2) 먼저 보는 항목들 (우선순위로)
제가 정리한 '먼저 보는 항목' 순서는 다음과 같습니다. 실무에서는 이 순서대로 확인해보면 원인 파악이 빠르게 됩니다.

1. 실제 실행 여부: EXPLAIN만으로는 실행 비용 추정치만 봅니다. 실제 상황인지 확인하려면 EXPLAIN ANALYZE를 사용하세요.
2. Actual vs Estimated (rows, time): 실제 행 수(actual rows)와 추정 rows(estimated rows)가 크게 다르면 통계(ANALYZE)나 인덱스 선택에 문제가 있을 수 있습니다.
3. Cost (cost=.. ..): planner가 사용한 비용 추정. 절대값보다는 서로 다른 계획 간 비교에 유용합니다.
4. Loops: 노드가 반복 실행되는 횟수. nested-loop에서 내부 노드가 여러 번 돈다면 비용이 커집니다.
5. Node 타입 (Seq Scan / Index Scan / Bitmap Heap Scan / Index Only Scan 등): 어떤 스캔을 했는지 확인해서 인덱스가 쓰였는지 봅니다.
6. Buffers (옵션 사용 시): 실제 디스크/캐시 접근 수치를 보고 I/O 원인을 판단합니다.
7. Parallelism: 병렬 실행 여부와 worker 수. 작은 쿼리에는 오버헤드일 수 있습니다.
8. Planning time vs Execution time: planning이 오래 걸리면 복잡한 쿼리나 많은 파라미터가 원인일 수 있습니다.

3) 주요 출력 항목 간단 해석(실무 포인트)
- cost=(start..end rows=... width=...):
  - start/end는 planner가 추정한 상대적 비용입니다. 값 자체보다 계획 간의 비교가 의미 있습니다.
  - rows는 planner가 예상한 반환 행 수. 실제 rows와 차이가 크면 ANALYZE(통계 수집)를 먼저 확인하세요.
  - width는 평균 행 크기(바이트) 추정. 큰 차이는 메모리/IO 영향 추정에 도움됩니다.

- actual time=.. rows=.. loops=..
  - actual time: 실제 실행에서 걸린 시간 범위
  - rows: 실제 반환한 행 수
  - loops: 이 노드가 몇 번 실행되었는지. 예를 들어 Nested Loop의 외부 반복으로 내부 Scan의 loops가 많아질 수 있습니다.

- Buffers: shared hit/read/write, temp read/write 등
  - 버퍼 통계가 높으면 디스크 I/O가 원인인지 파악할 수 있습니다. BUFFERS 옵션 사용 필요.

4) 노드별로 실무에서 확인할 포인트
- Seq Scan
  - 테이블 전체를 훑는 작업. 예상 이상으로 자주 나오면 인덱스 필요성 고려(하지만 작은 테이블에서는 Seq Scan이 더 빠를 수 있음).
  - 확인: 테이블 크(SELECT pg_total_relation_size), 인덱스 존재 여부(\d table 또는 pg_indexes), 통계 최신화(ANALYZE).

- Index Scan / Index Only Scan
  - 인덱스가 사용되었다면 어떤 인덱스인지, 인덱스 커버리지가 충분한지 확인하세요.
  - Index Only Scan은 테이블 접근 없이 인덱스만으로 결과를 충족할 때 발생(visibility map이 중요).
  - 확인: 인덱스 컬럼 순서, index-only가 되려면 테이블의 HOT/visibility 상태도 영향.

- Bitmap Index Scan + Bitmap Heap Scan
  - 여러 인덱스를 조합하거나 넓은 범위를 읽을 때 등장. 디스크 접근 패턴이 달라서 I/O 특성 확인 필요.

- Joins (Nested Loop / Hash Join / Merge Join)
  - Nested Loop: 작은 외부 테이블 + 인덱스가 있을 때 효율적. loops를 특히 봅니다.
  - Hash Join: 메모리에만 해시 테이블을 만들 수 있으면 빠릅니다. 메모리 부족이면 성능 저하.
  - Merge Join: 정렬된 입력에 적합. large sorted inputs에 유리.
  - 확인: 각 조인의 예상/실제 행 수, 메모리 사용( work_mem ), 정렬 발생 여부.

- Sort
  - 메모리 기반인지 디스크 기반인지 확인( work_mem과 temp files).
  - EXPLAIN ANALYZE와 BUFFERS를 보면 temp 디스크 사용 여부를 유추할 수 있습니다.

- Aggregate / Grouping
  - 그룹을 만드는데 많은 메모리를 쓰는지, 혹은 외부 정렬로 temp를 쓰는지 확인.

5) 실무에서 바로 써먹을 명령어·설정 예시 (Docker / Linux / psql 포함)
- 로컬 또는 컨테이너에서 psql 실행 예:
```bash
# Docker로 띄운 컨테이너에 접속해서 psql 실행
docker exec -it my-postgres-container psql -U postgres -d mydb -c "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) SELECT * FROM orders WHERE created_at > now() - interval '1 day';"
```

- psql에서 자주 쓰는 단축:
```sql
-- 인덱스 리스트
\d+ public.orders
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='orders';

-- 통계 확인
ANALYZE public.orders;
SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_all_tables WHERE relname='orders';

-- pg_stat_statements 활성화 후 상위 쿼리 확인
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT query, calls, total_time, mean_time FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;
```

- PostgreSQL 설정(예: postgresql.conf)에서 점검해볼 것들
```conf
# planner 및 메모리 관련 (환경에 맞게 조정 필요)
shared_buffers = 1GB
work_mem = '16MB'
effective_cache_size = '3GB'
random_page_cost = 2.0
```
설정 변경 후에는 재시작/재적용 필요:
```bash
# 시스템d 서비스
sudo systemctl restart postgresql

# Docker 환경이면 컨테이너 재시작
docker-compose restart db
```

- auto_explain 모듈로 오래 걸리는 쿼리 자동 로깅
postgresql.conf에:
```conf
shared_preload_libraries = 'auto_explain'
auto_explain.log_min_duration = 1000  # ms, 예: 1000ms 이상 로깅
auto_explain.log_analyze = on
auto_explain.log_buffers = on
```
설정 변경 후 DB 재시작 필요합니다. 이 방법은 실서비스에서 어떤 쿼리가 문제인지 찾는 데 도움이 되지만, 로그량/오버헤드에 주의하세요.

![EXPLAIN 출력에서 노드별(SeqScan, IndexScan, HashJoin 등) 주요 수치를 가리키는 다이어그램](/assets/img/posts/blog/postgresql-explain-first-look/image-2.png)
이미지 출처: AI 생성 이미지

6) 실제 예와 해석(초보자도 따라하기 쉽게)
예시 EXPLAIN ANALYZE 출력(요약 형태):
```
Nested Loop  (cost=0.00..12345.67 rows=1000 width=200) (actual time=0.123..456.789 rows=950 loops=1)
  ->  Index Scan using idx_users_id on users  (cost=0.00..12.34 rows=1 width=100) (actual time=0.010..0.010 rows=1 loops=950)
  ->  Index Scan using idx_orders_user_id on orders  (cost=0.00..12.34 rows=1 width=100) (actual time=0.020..0.040 rows=1 loops=950)
Planning Time: 0.123 ms
Execution Time: 456.789 ms
```
해석 포인트:
- Nested Loop이 사용되었고, 내부 Index Scan이 loops=950번 반복되었다면 내부 작업 비용이 누적됩니다. 실제 rows(950)가 planner의 추정 rows(1000)과 크게 다르지 않으면 통계는 어느 정도 정확합니다.
- 하지만 내부 Index Scan의 actual time이 각 loop마다 작지 않다면 전체 실행 시간은 크게 늘어날 수 있습니다. 이럴 때는 Hash Join/Bitmap이 더 효율적일지 검토해볼 수 있습니다(데이터 분포에 따라 다릅니다).
- Planning vs Execution time을 같이 보면 planning이 오래 걸리는 쿼리는 쿼리 복잡성(많은 JOIN, 서브쿼리)나 파라미터화 특성 문제일 수 있습니다.

7) 공부하면서 알게 된 점
- EXPLAIN에서 보여주는 값들은 '추정'이 기본인 경우가 많아서 통계가 매우 중요하다는 점을 알게 되었습니다. ANALYZE를 주기적으로 돌려 통계를 갱신하면 planner의 선택이 바뀌는 경우가 있었습니다.
- Index Only Scan이 항상 빠른 건 아니라는 점. visibility map과 함께 작동하기 때문에 테이블 변경이 잦으면 index-only가 잘 안될 수 있습니다.
- cost 값 자체는 절대적이지 않아서, 다른 계획과의 상대 비교가 중요하다는 점을 실무에서 더 느꼈습니다.

8) 처음에는 헷갈렸던 부분
- cost의 의미(특히 start..end)와 실제 시간의 관계. start..end는 추정 비용의 범위이지 밀리초 수가 아니라는 점이 처음에는 헷갈렸습니다.
- loops 값의 의미도 초반에 오해했는데, 어떤 노드는 내부 반복 때문에 큰 loops 값을 가지며 이로 인해 실제 트래픽이 증폭된다는 사실을 실제 EXPLAIN ANALYZE를 통해 확인하면서 이해했습니다.

9) 실무에서는 이렇게 확인하면 좋겠다 (권장 절차)
- 문제 쿼리 발견 → EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)로 실제 실행 계획 수집
- pg_stat_statements로 빈도/비용이 큰 쿼리 파악
- 문제 쿼리의 통계 확인 및 ANALYZE 수행
- 인덱스 존재 확인 및 필요하면 인덱스 생성(운영 환경에서는 생성 시 잠금/부하 고려)
- 설정( work_mem, random_page_cost 등)을 테스트 환경에서 조정해 보고 실행 계획 변화를 확인
- auto_explain으로 장기적으로 느린 쿼리 로깅

10) 실무 체크리스트
- [ ] EXPLAIN(ANALYZE, BUFFERS)로 실제/추정 차이를 확인했다.
- [ ] pg_stat_statements에서 쿼리 영향도(총 시간, 호출 수)를 확인했다.
- [ ] 관련 테이블에 대해 ANALYZE를 수행해 통계를 최신화했다.
- [ ] 테이블 크기, 인덱스 유무, 인덱스 정의(컬럼 순서)를 점검했다 (\d, pg_indexes).
- [ ] EXPLAIN 결과에서 loops/actual rows/plan node 유형을 우선적으로 확인했다.
- [ ] auto_explain이나 slow query logging을 통해 장기 데이터를 수집하도록 설정했는가?
- [ ] 설정 변경( work_mem, random_page_cost 등)은 반드시 테스트 환경에서 먼저 검증했다.
- [ ] Docker/시스템 환경에서 psql 접근 방법과 로그 확인 절차를 문서화해 두었는가?

마무리하며
이 글은 제가 EXPLAIN을 처음 배울 때 정리해둔 요점들을 바탕으로 작성했습니다. EXPLAIN은 처음엔 복잡하지만, '먼저 볼 항목들'의 우선순위와 간단한 체크 절차만 기억해도 문제 원인 탐색이 훨씬 수월해집니다. 실무에서는 항상 안전하게(특히 EXPLAIN ANALYZE는 실제 실행을 하기 때문에) 테스트 환경에서 먼저 시도하고, 로그와 통계를 통해 반복적으로 확인하는 습관이 도움이 되었습니다.

읽어주셔서 감사합니다. 혹시 특정 EXPLAIN 출력(원본)을 공유해 주시면 함께 단계별로 해석해보면서 더 구체적으로 도와드릴 수 있어요.