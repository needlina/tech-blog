---
title: "Event-driven 아키텍처에서 스키마 변경을 무중단 적용하는 전략 Top 6"
description: "이벤트 기반 시스템에서 스키마 변경 시 무중단을 위한 6가지 실무 전략과 선택 기준, 확인 명령, 재현·백업·롤백 포인트, 소비자 호환성 검사 방법을 정리한 가이드"
slug: "event-driven-schema-change-zero-downtime-top6"
date: 2026-07-26 12:31:00 +0900
categories: ["Database", "PostgreSQL"]
tags:
  ["postgresql", "event-driven", "schema-migration", "배포자동화", "스키마변경"]
image:
  path: /assets/img/posts/blog/event-driven-schema-change-zero-downtime-top6/preview.png
  alt: "이벤트 스키마 무중단 변경 썸네일"
---

이벤트 기반 시스템에서 스키마 변경을 무중단으로 적용하려면, **(1) 호환성 규칙 준수(가역적 변경)**, **(2) 스키마 레지스트리와 호환성 모드**, **(3) 버전화된 이벤트 혹은 토픽 분리 + 듀얼 라이트·리플레이**, **(4) 업캐스터/어댑터로 소비자 적응**, **(5) 온라인 DB 변경(컬럼 추가→비어있음→백필→제약 추가 순)**, **(6) 사이드바이사이드(그림자) 리더 및 점진적 컷오버**를 조합하되, 각 전략별로 소비자 장애 로그, 레이턴시·오류율, DB 잠금 상태를 먼저 확인해야 한다.

여기서는 각 전략의 목적과 왜 필요한지, 실무에서 먼저 보는 로그/명령, 실패 시 흔한 원인과 조치 순서를 중심으로 단계적으로 정리했다. 공식 문서, 점검 명령, 예시 SQL/CLI, 오류 메시지 예시를 함께 적었다.

## 왜 이벤트 기반에서 스키마 변경이 더 복잡한가

이벤트 아키텍처는 데이터의 생산자(producer)와 소비자(consumer)가 느슨하게 결합되어 있다. 그래서 한 쪽의 스키마 변경이 다른 쪽의 역호환성 문제를 일으키기 쉽다.

- 소비자마다 배포 주기가 달라서 동시에 업데이트되지 않음.
- 이벤트 포맷이 바뀌면 직렬화(deserialization) 오류가 발생할 수 있음.
- DB 스키마 변경이 테이블 전체 재작성으로 장애를 유발할 수 있음(특히 대형 테이블).

내가 먼저 볼 로그는 소비자 애플리케이션의 deserialization 에러(예: "Unknown field", "AvroTypeException"), Kafka/메시지 브로커의 스키마 레퍼런스 오류, 그리고 DB에서의 긴 락 관련 로그다.

## Top 6 전략 개요 (실무 포인트 포함)

- 호환성 규칙(가역적·추가적 변경) — 먼저 소비자 계약부터 정하고, 비파괴적 변경만 허용. 확인: 스키마 레지스트리 호환성 설정.
- 스키마 레지스트리 사용(Avro/Protobuf/JSON Schema) — 스키마 호환성 모드(Backward/Forward/Full) 설정. 확인: 레지스트리 UI/API에서 compatibility 확인.
- 이벤트 버전화 + 듀얼 라이트(구버전+신버전 발행) — 소비자 별로 전환 시점 관리. 확인: 토픽에 신/구 메시지 동시 존재 여부, 컨슈머가 읽는 토픽 이름.
- 업캐스터(Upcaster) / 어댑터 패턴 — 중간에서 오래된 이벤트를 최신 형식으로 변환. 확인: 업캐스터 로그와 변환 실패 카운트.
- 사이드바이사이드(그림자) 리더 + 점진 컷오버 — 새 소비자/서비스를 그림자 모드로 띄워 비교 검증. 확인: 그림자 리더의 결과와 기존 리더 결과 비교 쿼리.
- 온라인 DB 변경 + 백필 배치 — ADD COLUMN NULL → 백필(배치) → SET DEFAULT → SET NOT NULL. 확인: pg_stat_activity, pg_locks, 백필 배치 성공률.

아래 각 전략을 더 깊게 보고, 선택 기준 표와 실패 대응 표를 함께 둡니다.

## 1) 호환성 규칙(가급적 읽기/쓰기 호환)

목적: 소비자/생산자가 깨지지 않도록 스키마 변경을 제한.
핵심 원칙:

- 필드 추가는 보통 안전(Nullable 또는 default 없이 추가).
- 필드 삭제/이름 변경/타입 변경은 위험.
  실무 확인:
- 스키마 레지스트리가 있다면 compatibility 모드를 **Backward** 또는 **Full**로 설정했는지 확인.
- 문서: PostgreSQL/DB 변경과 별개로 이벤트 스키마는 Confluent Schema Registry 문서(예: https://docs.confluent.io/)를 참고.

주의사항: "추가만 하면 안전"이 항상 성립하지 않는다. 소비자가 필수값으로 기대하면 문제가 된다.

## 2) 스키마 레지스트리 + 호환성 모드

설명: Avro/Protobuf/JSON Schema를 레지스트리로 관리하면 자동으로 호환성 검사를 걸 수 있음.
실무 포인트:

- 레지스트리 API로 현재 스키마 버전과 compatibility 확인: curl로 확인 가능.
- 예시(Confluent Schema Registry):
  - 확인 명령: curl -sS http://schema-registry:8081/subjects/{subject}/versions
- 실패 증상: producer에서 "Schema incompatible" 에러.
- 조치: 호환성을 만족하도록 스키마 수정 또는 버전 분리.

## 3) 이벤트 버전화 + 듀얼 라이트(dual-write) 및 리플레이

패턴: 새 형식 이벤트를 별도 토픽으로 발행하거나, 같은 토픽에 버전 구분 필드를 둔다. 마이그레이션 동안 동시에 구/신 이벤트를 생성(또는 DB에 듀얼 라이트)하고 소비자들을 단계적으로 전환한다.
확인 명령:

- kafka-topics.sh --describe --topic new-topic
- 소비자 로그에서 어느 버전의 이벤트를 처리했는지 추적(예: 로그에 event.version 기록)
  장점: 급격한 컷오버 위험 감소.
  단점: 중복 처리, 운영 복잡도 증가.

## 4) 업캐스터(Upcaster) / 어댑터로 소비자 적응

설명: 소비자 쪽 또는 메시지 브로커 사이에서 오래된 이벤트를 최신 형식으로 변환.
예시 패턴 코드(간단한 업캐스터 자바 의사코드):
{% raw %}

```java
// Upcaster 예시(의사코드)
public Event upcast(OldEvent e) {
  NewEvent ne = new NewEvent();
  ne.fieldA = e.fieldA;
  // 새 필드 default 처리
  ne.newField = "default";
  return ne;
}
```

{% endraw %}
실패 예시: 변환 중 NullPointerException 또는 타입 변환 실패("java.lang.ClassCastException").
확인: 업캐스터 로그, 변환 실패 카운터, Sentry/에러 트래킹의 stacktrace.

![이벤트 업캐스터 흐름 다이어그램](/assets/img/posts/blog/event-driven-schema-change-zero-downtime-top6/image-1.webp)
이미지 출처: AI 생성 이미지

## 5) 온라인 DB 변경 패턴(실무 절차)

### 많이 쓰는 순서(권장):

1. ALTER TABLE ADD COLUMN new_col TYPE; -- NULL 허용
2. 백필(batch update)로 값 채우기 (작은 배치로)
3. ALTER TABLE ALTER COLUMN SET DEFAULT ...
4. ALTER TABLE ALTER COLUMN SET NOT NULL;

### 실행 예(PSQL):

```sql
-- 1) 컬럼 추가 (NULL 허용)
ALTER TABLE orders ADD COLUMN status text;

-- 2) 백필(배치 예시)
UPDATE orders SET status = 'created' WHERE status IS NULL LIMIT 10000;

-- 3) 기본값 설정
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'created';

-- 4) NOT NULL 설정 (백필 완료 후)
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;
```

확인 명령:

- 서버 버전: SELECT version();
- 락 확인: SELECT \* FROM pg_locks WHERE relation = 'orders'::regclass;
- 진행 모니터링: SELECT count(\*) FROM orders WHERE status IS NULL;
  주의: PostgreSQL 버전에 따라 ADD COLUMN with DEFAULT가 전체 테이블 재작성할 수 있다. 운영 전 반드시 SELECT version()로 버전 확인하고 공식 문서(https://www.postgresql.org/docs/current/sql-altertable.html)를 확인해야한다.

## 6) 사이드바이사이드(Shadow) 리더 + 점진 컷오버

방법: 새 소비자/서비스를 그림자 모드로 띄워 기존 결과와 비교. 로그나 결과가 동일하면 트래픽을 점진 이전.
확인:

- 그림자 리더 결과와 기존 리더 결과를 비교하는 쿼리(예: 샘플 10k건 비교).
- CI에서 계약 테스트 통과 여부.

![이벤트 기반 시스템 일러스트](/assets/img/posts/blog/event-driven-schema-change-zero-downtime-top6/image-2.webp)
이미지 출처: AI 생성 이미지

## 전략 선택 기준 표

서비스 영향도(실시간 요구), 소비자 배포 속도, DB 테이블 크기, 메시지 형식(스키마 레지스트리 유무). 표 뒤에는 실제로 어떤 항목이 결정적일지 적습니다.

| 전략              | 맞는 상황                      | 피해야 할 상황                | 확인 방법                            |
| ----------------- | ------------------------------ | ----------------------------- | ------------------------------------ |
| 호환성 규칙       | 다수 소비자, 느린 배포 주기    | 필드 삭제/타입 변경 필요할 때 | 스키마 레지스트리와 소비자 코드 검사 |
| 스키마 레지스트리 | 중앙에서 스키마 관리 가능      | 레지스트리 도입 불가 환경     | 레지스트리 API / compatibility 확인  |
| 버전화+듀얼라이트 | 소비자 점진 전환, 무중단 필요  | 중복 처리 감수 못할 때        | 토픽의 메시지 버전 비율              |
| 업캐스터          | 오래된 이벤트 관리가 필요      | 변환 로직이 복잡한 경우       | 업캐스터 에러 카운트                 |
| 온라인 DB 변경    | 대형 테이블이 있고 재작성 불가 | 즉시 NOT NULL 요구될 때       | pg_locks, 백필 진행률                |
| 사이드바이사이드  | 검증이 꼭 필요한 핵심 경로     | 리소스(리더) 중복 부담 클 때  | 결과 차이, 레이턴시 비교             |

여기서 결정적 분기:

- DB가 크고 ALTER가 재작성된다면 온라인 DB 변경 + 백필 없이 NOT NULL을 강행하면 안 된다.
- 소비자 배포가 느리다면 호환성 규칙과 업캐스터 조합이 실무적으로 더 안전하다.

## 실패 증상 / 원인 / 확인 명령 / 조치 표

운영에서 자주 마주치는 사례 위주로.

| 실패 증상                                         | 원인(가능성)                 | 확인 명령                                  | 조치                                              |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------ | ------------------------------------------------- |
| 소비자 deserialization 예외(AvroTypeException 등) | 스키마 불일치                | 소비자 로그, schema-registry versions API  | 스키마 호환성 확인, 업캐스터 도입 또는 롤백       |
| ALTER TABLE 오래 걸림/락                          | 테이블 재작성 발생           | SELECT \* FROM pg_locks; SELECT version(); | 중단 후 온라인 변경 패턴으로 전환, pg_repack 고려 |
| 이벤트 처리 결과 불일치                           | 듀얼 라이트 불일치 또는 중복 | 샘플 비교 쿼리, 로그 correlation id        | 듀얼 라이트 검증, idempotency 적용                |
| 변환(업캐스트) 실패                               | 변환 로직 버그               | 업캐스터 로그, Sentry                      | 테스트 케이스 추가, 실패 메시지 트래킹            |

여기서 시간을 많이 쓰는 곳은 업캐스터 테스트와 백필 배치 스크립트이다.

## 실패 예시와 수정 예시(코드)

문제 예시(실패):

```sql
-- 즉시 NOT NULL 추가 (대형 테이블에서 실행하면 잠금)
ALTER TABLE orders ADD COLUMN status text NOT NULL DEFAULT 'created';
-- 운영에서 실행하면 테이블이 재작성되어 수분~수시간 락 발생
```

수정(권장 순서):

```sql
ALTER TABLE orders ADD COLUMN status text; -- 1. NULL 허용
-- 2. 백필: 배치 또는 COPY로 점진 적용
UPDATE orders SET status = 'created' WHERE status IS NULL LIMIT 10000;
-- 반복 수행 until count = 0
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'created';
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;
```

검증 명령:

- 진행률: SELECT count(\*) FROM orders WHERE status IS NULL;
- 락: SELECT pid, query FROM pg_stat_activity WHERE wait_event IS NOT NULL;

## 배포·CI에서 검증할 명령·테스트

- 소비자 단위 테스트: 직렬화/역직렬화 케이스 (unit)
- 통합 테스트: Kafka 토픽에 실제 메시지(post) 후 소비자 처리 확인
- 명령 예: kafkacat -P -b broker:9092 -t my-topic -p 0 < sample.json
- DB 버전 확인: SELECT version();
- 스키마 레지스트리 확인: curl -sS http://schema-registry:8081/subjects/<subject>/versions

## 자주 묻는 질문

Q: ALTER TABLE ADD COLUMN에 DEFAULT를 주면 항상 테이블 전체가 재작성되나?  
A: PostgreSQL 버전과 DEFAULT 값의 종류에 따라 다르다. 운영 전 SELECT version()로 버전 확인하고 공식 문서(ALTER TABLE)에서 동작을 확인해야한다.

Q: 스키마 레지스트리가 없는데 어떻게 호환성 보장하나?  
A: 계약을 문서화하고 소비자별 통합 테스트를 CI에서 자동화하는 것을 추천한다. 업캐스터/어댑터 패턴을 소비자 측에 둬서 점진 적용이 가능하다.

Q: 듀얼 라이트 후 리플레이가 필요하면 어떻게 처리하나?  
A: 메시지에 고유 ID를 포함하고 idempotent한 소비자를 구현한 뒤, 리플레이 시 중복 필터링을 적용한다.

Q: 소비자가 최신 이벤트를 못 읽는 경우 먼저 어디를 보나?  
A: 소비자 deserialization 에러 로그, 스키마 레지스트리 버전, 소스 토픽의 메시지 스키마(샘플)를 먼저 확인한다.

Q: 대형 테이블의 NOT NULL 추가를 안전하게 처리하는 절차는?  
A: 컬럼 추가(널 허용) → 백필(배치) → DEFAULT 설정 → NOT NULL 설정 순으로 진행하고 pg_locks/pg_stat_activity로 모니터링한다.

## 함께 보면 좋은 글

- [안전한 데이터베이스 마이그레이션 배포 가이드: 실무 중심 체크포인트](/posts/safe-database-migration-deployment/)
- [무중단 데이터베이스 스키마 마이그레이션과 안전한 롤백 전략](/posts/zero-downtime-db-migrations-rollout-rollback/)
- [PostgreSQL에서 대규모 JSONB 컬럼을 청크로 안전하게 업데이트하는 실전 절차](/posts/postgresql-chunked-jsonb-update-safe/)

## 실무 체크리스트

- SELECT version(); 로 PostgreSQL 버전 확인 및 해당 버전의 ALTER TABLE 동작 문서(https://www.postgresql.org/docs/current/sql-altertable.html) 참조
- 소비자 서비스 로그에서 deserialization/Avro 오류 검색(예: "AvroTypeException", "Unknown field")
- schema registry API 호출로 subject 호환성(compatibility) 확인: curl http://schema-registry:8081/subjects/<subject>/versions
- 대형 테이블 변경 시 pg_locks/pg_stat_activity 확인: SELECT \* FROM pg_locks WHERE relation = 'your_table'::regclass;
- 백필 배치 스크립트 준비 및 소규모 샘플로 검증(예: UPDATE ... LIMIT 10000), 진행률 모니터링: SELECT count(\*) FROM your_table WHERE new_col IS NULL;
- 그림자 리더로 결과 비교 샘플(예: 10k건) 수행하고 차이 발생 시 로그 캡처
- 롤백 절차 문서화: (a) 프로듀서 신버전 중단, (b) 토픽 리플레이/듀얼라이트 중단, (c) DB 변경 전 스냅샷 복원 계획
