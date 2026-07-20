---
title: "데이터베이스 기반 자동완성 설계: 토큰화·인덱스·운영 점검 체크포인트"
description: "대량 문자열 대상 자동완성 설계 대상(상품명·태그), PostgreSQL 확장(pg_trgm, tsvector) 설치·색인·쿼리 예시, 인덱스 사용 여부(EXPLAIN), materialized view와 캐시 고려사항, 운영 점검 명령"
slug: "db-autocomplete-tokenization-index-design"
date: 2026-07-20 09:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "pg-trgm", "autocomplete", "성능튜닝", "검색-설계"]
image:
  path: /assets/img/posts/blog/db-autocomplete-tokenization-index-design/preview.png
  alt: "빠른 자동완성 설계 썸네일"
---

데이터베이스 기반 자동완성은 입력한 접두사나 오타에 빠르게 응답해야 하기 때문에 **토큰화 방식(토큰 단위 vs n-gram)**, **적절한 인덱스(opclass)**, 그리고 **쿼리의 인덱스 적중 여부**를 먼저 확인하는 것이 핵심입니다. 실무에서는 `CREATE EXTENSION pg_trgm`, 인덱스 생성, 그리고 EXPLAIN(ANALYZE)로 인덱스 사용·응답 시간·IO를 확인하는 루틴을 먼저 돌려볼 것을 권합니다.

왜 이걸 정리하냐면, 로컬에서는 1만 건으로도 괜찮았는데 실제 데이터(수십만~수백만 건)로 올리면 응답이 갑자기 느려지는 경우가 너무 흔했거든요. 자동완성은 사용자 체감이 직접적으로 떨어져서 작은 설계 차이가 큰 영향으로 이어질 수 있었습니다. 제가 공부하면서 정리한 핵심과 실무 점검 위주로 차근차근 적어볼게요.

## 핵심 개념 요약 (한눈에)
- 토큰화: 전체 문자열을 어떤 단위로 쪼개는지가 검색 가능성·정확도·인덱스 활용에 영향을 줌 (단어단위, prefix, n-gram).
- 인덱스: prefix 검색은 btree(text_pattern_ops)나 expression index, fuzzy/substring는 pg_trgm(GIN/GiST)이 흔함.
- 운영 점검: `EXPLAIN (ANALYZE, BUFFERS)`, `pg_stat_user_indexes.idx_scan`, 인덱스 사이즈 검사로 쿼리 판단.

## 공부하면서 알게 된 점
- 단순 ILIKE '%term%' 같은 쿼리는 대부분의 인덱스를 무력화해서 대안이 필요하다는 점이 가장 먼저 와닿았어요.
- PostgreSQL의 pg_trgm은 typo tolerant(오타 허용)·substring 검색에 실전에서 쓸만하지만, 인덱스 크기와 메모리·쓰기 비용을 고려해야 해요.
- 자동완성의 응답성은 단순 검색 속도보다도 순위산정(랭킹)과 LIMIT 처리 방식이 더 크게 체감되는 경우가 많더군요.

## 처음에는 헷갈렸던 부분
- "tsvector(full-text search)와 pg_trgm 중 무엇을 써야 하나?" — 둘은 목적이 조금 달라서 혼동했어요.
  - tsvector는 형태소 기반(언어별 stemming, stop words 포함)으로 정렬·문맥 검색에 유리.
  - pg_trgm은 substring/similarity 기반으로 짧은 키워드 검색과 오타 허용에 유리.
- 인덱스가 있는데도 안 쓰이는 경우의 원인(쿼리 형태, 함수 호출, 통계 미반영)을 처음에 몰라서 EXPLAIN 보고도 혼란스러웠습니다.

## 선택 기준(간단 표)
| 방식 | 장점 | 단점 | 사용 시점 |
|---|---:|---|---|
| prefix (term%) | btree로 빠름, 적은 메모리 | 전체 단어 시작만, 오타 미허용 | 상품 코드, 고유 이름 |
| pg_trgm (GIN/GiST) | substring·오타 허용 | 인덱스 크기·쓰기 부담 | 사용자가 자유 입력, typo 허용 필요 |
| full-text(tsvector) | 언어처리, 복합어 검색 | 짧은 키워드 민감도 낮음 | 문서 검색, 자연어 검색 |
| 외부 검색(ES) | 풍부한 랭킹·스케일 | 운영 복잡도 | 대규모·복잡 랭킹 필요시 |

**표는 기준이 명확한 경우에만 사용**하라는 규칙에 맞춰 최대한 간결히 정리해봤어요.

## 실무에서 이렇게 확인하면 좋겠다 (체크 순서)
1. 빠른 재현 환경 만들기
   - 실 운영 샘플 덤프(크기 제한)로 테스트 DB 구성.
2. 확장 설치 & 인덱스 생성
   - psql에서:
     - CREATE EXTENSION IF NOT EXISTS pg_trgm;
     - ALTER TABLE items ADD COLUMN name_lower text GENERATED ALWAYS AS (lower(name)) STORED; -- 버전 확인 필요
     - CREATE INDEX idx_items_name_trgm ON items USING gin (name_lower gin_trgm_ops);
3. 쿼리와 EXPLAIN 점검
   - 예시(실패): ILIKE와 인덱스 미사용
     ```sql
     EXPLAIN ANALYZE SELECT id, name FROM items WHERE name ILIKE '%shoe%' LIMIT 10;
     ```
     - 보통 Seq Scan이 뜨면 인덱스 미사용.
   - 예시(수정): trigram 연산자 사용
     ```sql
     EXPLAIN ANALYZE SELECT id, name FROM items WHERE name_lower % 'shoe' ORDER BY similarity(name_lower, 'shoe') DESC LIMIT 10;
     ```
     - 또는 similarity() 필터 + ORDER BY + LIMIT.
4. 통계 및 인덱스 상태 확인
   - 인덱스 스캔 수:
     ```sql
     SELECT indexrelid::regclass, idx_scan, idx_tup_read, idx_tup_fetch
     FROM pg_stat_user_indexes
     WHERE relname = 'items';
     ```
   - 인덱스 크기:
     ```sql
     SELECT pg_size_pretty(pg_relation_size('idx_items_name_trgm'));
     ```
5. 성능 수치 비교
   - EXPLAIN(ANALYZE, BUFFERS) 결과로 Seq Scan vs Index Scan 비용과 실제 ms를 비교.
   - 예: 로컬 샘플(100k rows)에서 Seq Scan 1200 ms → 인덱스 쿼리 15 ms로 개선된 사례(환경 따라 다름).

이미지 예시: 자동완성 동작 흐름 다이어그램
![자동완성 토큰화와 인덱스 흐름을 단순화한 다이어그램](/assets/img/posts/blog/db-autocomplete-tokenization-index-design/image-1.webp)
이미지 출처: AI 생성 이미지

## 코드 예시: 실패 예시와 수정 예시
- 실패 예시: 와일드카드 앞에 %가 있는 ILIKE (인덱스 사용 안 됨)
```sql
-- 실패: 인덱스 무력화
EXPLAIN ANALYZE
SELECT id, name
FROM items
WHERE name ILIKE '%' || 'term' || '%'
LIMIT 20;
```

- 수정 예시 1: prefix 검색으로 개선 가능 (term%)
```sql
-- prefix 빠른 검색: btree 이용
CREATE INDEX idx_items_name_prefix ON items (name text_pattern_ops);
EXPLAIN ANALYZE
SELECT id, name
FROM items
WHERE name ILIKE 'term%'
LIMIT 20;
```

- 수정 예시 2: pg_trgm로 substring/오타 허용
```sql
-- 필요 확장 설치
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 추천 인덱스
CREATE INDEX idx_items_name_trgm ON items USING gin (lower(name) gin_trgm_ops);

-- 실행 예
EXPLAIN ANALYZE
SELECT id, name
FROM items
WHERE lower(name) % 'tarm'  -- 오타 허용 예시
ORDER BY similarity(lower(name), 'tarm') DESC
LIMIT 10;
```

## materialized view + 캐시 패턴
대량 집계나 복잡한 랭킹을 실시간으로 수행하기 힘들면 materialized view나 Redis 캐시를 고려합니다.
- materialized view 생성
```sql
CREATE MATERIALIZED VIEW mv_items_autocomplete AS
SELECT id, name, lower(name) as name_lower, to_tsvector('simple', name) as vec
FROM items;
CREATE INDEX idx_mv_name_trgm ON mv_items_autocomplete USING gin (name_lower gin_trgm_ops);
```
- 갱신(동시성 고려)
```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_items_autocomplete;
```
주의: CONCURRENTLY는 MV가 고유 인덱스를 필요로 합니다. 대안으로 트래픽 비수기 배치나 파티셔닝을 고려하세요.

이미지 예시: materialized view와 캐시 계층 구조
![materialized view로 집계 후 캐시를 사용하는 구조 그림](/assets/img/posts/blog/db-autocomplete-tokenization-index-design/image-2.webp)
이미지 출처: AI 생성 이미지

## 공부하면서 알게 된 작은 팁들
- lower()를 미리 저장한 컬럼을 인덱스해서 쿼리에서 함수를 피하면 인덱스 활용성이 좋아질 때가 많았어요.
- pg_trgm 인덱스는 쓰기가 약간 느려집니다. 대량 쓰기가 많은 시스템이면 배치 전략을 고민해야 합니다.
- EXPLAIN(ANALYZE, BUFFERS) 결과를 저장해 두고 변경 전후를 비교하면 원인 파악이 쉬워집니다.

## 실무에서는 이렇게 확인하면 좋겠다 (구체 명령 모음)
- 인덱스 사용 유무 확인:
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```
- 인덱스 스캔 통계:
```sql
SELECT indexrelid::regclass, idx_scan
FROM pg_stat_user_indexes
WHERE relname = 'items';
```
- 인덱스 크기:
```sql
SELECT pg_size_pretty(pg_relation_size('idx_items_name_trgm'));
```
- 확장 설치 확인:
```sql
SELECT * FROM pg_extension WHERE extname = 'pg_trgm';
```

## Q&A (자주 묻는 질문)
Q1: 오타 허용과 순위(랭킹)를 동시에 만족하려면?
A1: pg_trgm으로 후보를 먼저 뽑고(유사도 필터), 그 결과에 대해 추가 가중치(조회수, 클릭수, 최근성)를 적용해 정렬하는 하이브리드가 현실적입니다. 실무에서는 후보 수 제한(LIMIT 100) 뒤 랭킹을 적용해 응답을 지연시키지 않는 방식을 씁니다.

Q2: 언제 외부 검색(Elasticsearch 등)을 도입해야 하나요?
A2: 데이터량이 매우 크고, 복잡한 랭킹·부스트 규칙·다중 언어 형태소 분석·통계 기반 정렬이 필요하면 도입을 고려해볼 수 있습니다. 단, 운영 복잡도가 커지므로 우선 DB 기반으로 프로토타입을 만들고 병목 확인 후 결정하는 걸 추천합니다.

Q3: 인덱스가 있는데도 안 쓰여요. 이유는?
A3: 함수가 적용되었거나(인덱스와 동일한 표현이 아님), 통계 수치 때문에 옵티마이저가 Seq Scan을 택했을 수 있습니다. ANALYZE 수행, 명시적 expression index 생성, 또는 힌트 대신 쿼리 리라이팅을 검토하세요.

Q4: pg_trgm 인덱스 크기·쓰기 비용은 어느 정도인가요?
A4: 환경에 따라 다르지만, 일반적으로 GIN 트라이그램 인덱스는 원본 데이터 크기의 수십%~수백%가 될 수 있으니 인덱스 크기와 WAL/쓰기 비용을 측정하세요. 실제로는 데이터 샘플로 인덱스 생성 후 `pg_relation_size`로 확인하는 게 안전합니다.

## 나의 의견 1
여기에 내 환경(예: PostgreSQL 버전, 데이터 건수, 처음 실패한 쿼리, 수정 후 응답 시간)을 적어보세요.

## 나의 의견 2
여기에 A/B 테스트 결과나 운영에서 적용한 최종 판단(어떤 전략을 선택했고 그 이유)을 기록해 주세요.

## 실무 체크리스트
- [ ] 현재 PostgreSQL 버전 확인: SELECT version();
- [ ] pg_trgm 설치 유무 확인: SELECT * FROM pg_extension WHERE extname='pg_trgm';
- [ ] 인덱스 생성(예시): CREATE INDEX idx_items_name_trgm ON items USING gin (lower(name) gin_trgm_ops);
- [ ] 쿼리 성능 측정: EXPLAIN (ANALYZE, BUFFERS) <쿼리>
- [ ] 인덱스 사용 통계 확인: SELECT indexrelid::regclass, idx_scan FROM pg_stat_user_indexes WHERE relname='items';
- [ ] 인덱스/테이블 사이즈 확인: SELECT pg_size_pretty(pg_relation_size('idx_items_name_trgm'));
- [ ] materialized view 필요성 검토(쓰기 빈도, 응답 SLA)
- [ ] 캐시(예: Redis) 도입 검토: 캐시 만료 정책·일관성(쓰기 시 갱신 전략) 설계
- [ ] 변경 전후 EXPLAIN 결과 보관 및 추적

마지막으로 제 생각을 아주 조심스럽게 말하자면, 자동완성은 사용자의 입력 패턴(짧은 키워드 빈도, 오타 빈도, 인기 검색어 분포)에 따라 최적 전략이 크게 달라지는 분야라고 느꼈습니다. 우선은 작은 샘플을 실제 쿼리로 재현해 성능 지표(EXPLAIN, 응답시간, 인덱스 사이즈)를 수집한 뒤, 그 데이터로 선택지를 좁혀가면 안정적으로 운영할 수 있을 것 같아요. 질문이나 더 보고 싶은 비교 항목 있으면 옆에서 함께 더 실험해볼게요.