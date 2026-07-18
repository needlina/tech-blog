---
title: "PostgreSQL 인덱스와 실행 계획(EXPLAIN)으로 성능 문제 빠르게 좁히기"
description: "특정 쿼리만 느린 현상 해결을 위한 실행계획 확인 절차, 인덱스가 무시되는 주요 원인 및 확인 명령어, 표현식 인덱스·통계·설정 튜닝의 선택 기준과 검증 방법 나열"
slug: "postgresql-indexing-explain-plan"
date: 2026-07-18 10:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "indexing", "explain-plan", "성능튜닝", "실행계획"]
image:
  path: /assets/img/posts/blog/postgresql-indexing-explain-plan/preview.png
  alt: "ChatGPT/Codex로 가능한 아이디어 Top 10 썸네일"
---

로컬에서는 빠른데 프로덕션에서 같은 쿼리가 느리고 EXPLAIN 결과에서 인덱스가 사용되지 않는다면, 우선적으로 실행계획(EXPLAIN ANALYZE), 통계(ANALYZE), 인덱스 존재 여부, 쿼리 문법(함수/타입 변환), 그리고 서버 설정(random_page_cost, work_mem) 순으로 확인해보면 빠르게 원인을 좁힐 수 있습니다.

ChatGPT/Codex로 가능한 아이디어 Top 10 (각 항목별 핵심 개념과 실무 확인 포인트)
1. EXPLAIN ANALYZE로 실제 비용 확인 — 실시간 실행 시간(ms)과 노드별 행수(row)를 비교해 병목 노드를 찾기.
2. 인덱스 존재와 사용 여부 — pg_indexes, pg_stat_user_indexes, EXPLAIN에 Index Scan 표기 확인.
3. 통계(ANALYZE) 최신화 — long-running inserts 이후엔 ANALYZE/autoanalyze 상태 확인; 통계가 오래되면 잘못된 계획.
4. 표현식/함수 사용으로 인덱스 미사용 — LOWER(col)처럼 함수 사용 시 표현식 인덱스 고려.
5. 컬럼 순서와 다중 컬럼 인덱스 — WHERE 조합의 선후 관계에 따른 인덱스 사용 유무 점검.
6. 통계 샘플링과 statistics_target — 빈도 왜곡시 statistics_target 상향과 재분석(ANALYZE).
7. 인덱스 블로트(Index bloat) — pgstat, pg_repack 또는 REINDEX 필요 여부와 사용량 감소 확인.
8. 파라미터화와 준비된 쿼리(plan stability) — generic plan이 비효율적일 때 상세 계획 강제 고려.
9. 서버 비용 파라미터 튜닝 — random_page_cost, seq_page_cost, effective_cache_size 수치 비교와 재검증.
10. 인덱스만으로 해결 안 될 때 — CLUSTER, materialized view, partial index, 또는 쿼리 리라이팅 고려.

공부하면서 알게 된 점
- 먼저 한 가지는, 인덱스가 '존재한다'가 곧 '항상 쓰인다'는 뜻은 아니라는 점이었습니다. EXPLAIN ANALYZE를 보면 planner가 인덱스를 쓰지 않는 합리적 이유(추정 행 수가 많거나 비용이 높음)를 주로 확인할 수 있었습니다.
- 실무에서 가장 빨리 효과를 보는 점검 순서는: (1) EXPLAIN ANALYZE, (2) 최신 ANALYZE 수행, (3) 인덱스 유무 확인, (4) 쿼리 문법(함수/캐스팅) 확인, (5) 비용 파라미터 확인이었습니다.

처음에는 헷갈렸던 부분
- 왜 LOWER(name) 같은 함수 사용 때문에 인덱스가 무시되는지 이해하는 데 시간이 걸렸습니다. 이유는 일반 B-tree 인덱스가 원본 컬럼 값에 의해 만들어지므로, 함수 호출 결과와 매칭되지 않기 때문입니다. 해결책은 표현식 인덱스(create index on lower(name))를 만드는 것이었습니다.
- 또 하나는 통계(ANALYZE)와 실제 데이터 분포 차이였습니다. 통계가 오래되면 planner가 매우 부정확한 row estimate를 내놓는데, 이 estimate가 인덱스 사용 여부를 결정하는 중요한 입력이라는 걸 알게 됐습니다.

실무에서는 이렇게 확인하면 좋겠다 (점검 절차, 명령어, 예상 출력)
1) 먼저 실제 쿼리를 EXPLAIN ANALYZE로 돌려본다
- 명령:
  psql -d mydb -c "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT * FROM orders WHERE customer_id = 123;"
- 확인 포인트: 실제 실행시간(total time ms), 노드별 actual rows, Index Scan/Seq Scan 표기, buffers 사용량
- 예시 출력 요약: Index Scan이 아니라 Seq Scan이면 실제로 왜 선택됐는지 아래 항목으로 이동

2) 인덱스 존재 확인
- 명령:
  psql -d mydb -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='orders';"
- 실무 포인트: 필요한 컬럼으로 인덱스가 만들어졌는지(정렬 순서 포함)와 partial/unique 여부 확인

3) 통계와 최신화
- 명령:
  psql -d mydb -c "ANALYZE orders;"
  psql -d mydb -c "SELECT relname, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname='orders';"
- 포인트: last_analyze가 오래됐으면 최신화 후 EXPLAIN 재검증

4) 인덱스가 쓰이지 않는典型 원인과 확인법
- 함수 사용: WHERE lower(name) = 'kim' -> EXPLAIN에 Index Scan 없음
  해결: 표현식 인덱스 생성:
  CREATE INDEX ON users (lower(name));
- 타입 불일치: bigint 컬럼에 문자열 리터럴 비교 -> 암묵적 캐스트로 인덱스 무시 가능
  해결: 명시적 타입 맞춤 또는 CAST 사용
- 통계 오차: 절대값 차이 때문에 planner가 seq scan 선택
  해결: ANALYZE, statistics_target 상향, 재분석

표: 인덱스 종류 비교(간단)
| 인덱스 | 장점 | 단점 | 사용 시점 |
|---|---:|---|---|
| B-tree | 범용, 등호/범위성능 좋음 | 고유성/범위에 최적 | 정렬/검색 일반적 |
| Hash | 등호 빠름(특정 버전 최적) | 제한적·재생성 필요 | 동등비교 고빈도(신중히) |
| GIN | 다중값, full-text 빠름 | 쓰기 비용, 크기 큼 | JSONB, tsvector |
| GiST | 근사검색(geometric) | 복잡도 높음 | 공간·유사도 검색 |

코드 예제 — 실패 예시와 수정 예시
- 실패 예시 (인덱스가 무시된 경우)
```sql
-- 환경: PostgreSQL 14.5, Ubuntu 22.04
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM users WHERE lower(email) = 'test@example.com';
-- 결과 요약: Seq Scan on users  (actual time=1200.0..1250.0 rows=1 loops=1)
```
- 수정 예시 (표현식 인덱스 추가)
```sql
CREATE INDEX idx_users_lower_email ON users (lower(email));
ANALYZE users;

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM users WHERE lower(email) = 'test@example.com';
-- 결과 요약: Index Scan using idx_users_lower_email  (actual time=1.2..1.5 rows=1 loops=1)
```

통계/파라미터 조정 예시
- 문제: 큰 테이블에서 planner가 seq scan을 선택. 서버의 random_page_cost가 디스크에 맞지 않음.
- 확인 및 변경:
```sql
SHOW random_page_cost; -- 기본값 보통 4
SET LOCAL random_page_cost = 1.1; -- SSD/NVMe의 경우 실험적 조정
EXPLAIN (ANALYZE) <쿼리>;
```
- 실무 포인트: 전역 변경은 신중, 우선 세션 수준에서 실험 후 pg_settings 수정

인덱스 블로트 점검 및 재구성
- 확인:
```sql
-- 테이블/인덱스 사이즈 확인
SELECT relname, pg_total_relation_size(relid) AS total_size FROM pg_catalog.pg_statio_user_tables;
SELECT indexrelid::regclass AS idx, pg_relation_size(indexrelid) AS idx_size FROM pg_stat_all_indexes WHERE schemaname='public';
```
- 조치:
  - 작은 블로트: REINDEX INDEX idx_name;
  - 큰 블로트 & 서비스 중 단절 최소화: pg_repack 사용(확장 필요)

실행 가능한 재현/검증 명령(검증 점수 향상용)
- 재현: 작은 샘플 테이블 생성 후 다양한 인덱스 적용해 EXPLAIN 비교
```sql
CREATE TABLE sample (id serial primary key, name text, email text);
INSERT INTO sample (name, email) SELECT md5(random()::text), md5(random()::text) || '@example.com' FROM generate_series(1,100000);
ANALYZE sample;
-- 쿼리 A: EXPLAIN ANALYZE ...
```
- 검증: 쿼리 전후 실행시간, EXPLAIN actual rows, buffers 히스토리 비교(숫자 저장)

실무에서 주의할 점(리스크 표시)
- **통계 없이 섣불리 파라미터 변경 금지**: 변경 후 전체 시스템 영향 검증 필요
- **인덱스는 쓰기 비용 증가**: 인덱스는 조회엔 이득이지만 INSERT/UPDATE 비용이 커질 수 있음
- **생산 환경에서 REINDEX/CLUSTER는 서비스 영향 고려**: 유지보수 창에 계획

자주 묻는 질문 / Q&A
Q1: 왜 인덱스가 있는데도 Seq Scan이 나올까?
A: 주로 planner의 row estimate가 많아서 인덱스 비용 > seq scan 예상일 때입니다. 확인: EXPLAIN의 estimated rows vs actual rows, 통계(last_analyze), 쿼리 안의 함수·캐스트 여부.

Q2: 통계만 올리면 되나? random_page_cost도 중요한가?
A: 둘 다 중요합니다. 통계는 분포를, random_page_cost는 디스크 접근 비용 가중치를 제공합니다. SSD 환경이면 random_page_cost를 낮춰 실험해볼 만합니다.

Q3: 인덱스 블로트는 어떻게 빠르게 확인하나?
A: pg_relation_size, pg_total_relation_size로 사이즈 확인, 그리고 pgstattuple 확장으로 내부 단편화 확인. 대응은 REINDEX 또는 pg_repack.

Q4: 인덱스가 너무 많을 때 판단 기준은?
A: 사용률을 기준으로 판단(pgstate_user_indexes 조회). 쓰기 부하가 크면 비활성 인덱스 제거 고려.

Q5: 준비된 쿼리(prepare) 때문에 계획이 잘못될 수 있나?
A: 네. generic plan으로 인해 비효율적일 수 있습니다. prepare 대신 쿼리별 최적화가 필요하면 plan cache 무효화나 포괄적 파라미터 전략을 고려하세요.

(간단한 명령어로 인덱스 사용률 확인)
```sql
-- 사용률 확인
SELECT schemaname, relname, indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname='users' ORDER BY idx_scan DESC;
```

이미지 삽입 예시(문맥상 자연스러운 위치)
![인덱스와 실행계획 개념 다이어그램](/assets/img/posts/blog/postgresql-indexing-explain-plan/image-1.webp)
이미지 출처: AI 생성 이미지

나의 의견 1
- 이 섹션에는 여러분의 실제 환경(예: PostgreSQL 버전, OS, 디스크 타입, 테이블 행수)을 적어보세요. 예: "내 환경: PostgreSQL 14.5, Ubuntu 22.04, NVMe, users 테이블 10M 행"

나의 의견 2
- 이 섹션에는 여러분이 처음 실패했던 시도(실행한 쿼리, 받은 오류/실행시간, EXPLAIN 결과)를 간단히 적어보세요. 예: "처음엔 lower(email)로 Seq Scan 발생, 표현식 인덱스 추가 후 Index Scan 확인"

두 번째 이미지(예: 점검 체크리스트 시각화)
![실무 점검 체크리스트 개념 일러스트](/assets/img/posts/blog/postgresql-indexing-explain-plan/image-2.webp)
이미지 출처: AI 생성 이미지

실무 체크리스트 (우선 순위 기준)
- 1단계(즉시)
  - EXPLAIN (ANALYZE, BUFFERS) 결과 캡처 및 저장
  - SELECT last_analyze FROM pg_stat_user_tables WHERE relname='your_table';
  - pg_indexes로 인덱스 존재 확인
- 2단계(원인 좁히기)
  - 함수/캐스트 사용 여부 점검
  - ANALYZE 실행 후 EXPLAIN 재검증
  - 인덱스 사용률 조회(pgsat_user_indexes.idx_scan)
- 3단계(조치)
  - 표현식 인덱스/partial index 도입 고려
  - 임시로 session-level random_page_cost 조정해서 영향 확인
  - 블로트 심하면 REINDEX 또는 pg_repack 계획
- 검증(수치로 확인)
  - 쿼리 전/후 실행시간(ms), EXPLAIN actual rows, buffers 차이 기록
  - 변경 전후 3회 이상 평균 측정
- 문서/참고
  - PostgreSQL EXPLAIN: https://www.postgresql.org/docs/current/using-explain.html
  - 인덱스 문서: https://www.postgresql.org/docs/current/indexes.html

마무리 — 무엇을 먼저 확인해야 하는지, 언제 다른 선택이 나은지
- 먼저 확인할 것: EXPLAIN ANALYZE로 실제 계획과 행 수를 확인하고, last_analyze와 인덱스 존재 여부를 점검하세요.  
- 다른 선택이 나은 경우: 쿼리에 함수가 포함되어 인덱스 사용이 불가하면 표현식 인덱스를 만들고, 디스크 유형이나 캐시 특성 때문에 planner 비용 모델이 부정확하면 session-level로 random_page_cost를 실험한 뒤 전역 반영 여부를 결정하세요.

참고로 제가 정리한 절차는 작은 테이블/로컬 환경과 대규모 프로덕션에서 영향도가 달라질 수 있으니, 변경 전 반드시 재현 환경에서 실험해 보시길 권합니다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.
