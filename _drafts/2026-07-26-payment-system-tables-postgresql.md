---
title: "결제 시스템용 PostgreSQL 테이블 설계 및 생성 예시"
description: "결제·주문·환불 테이블 설계 예시와 SQL 생성문, 인덱스·무결성 포인트, 트랜잭션·동시성 확인 명령과 로그 확인 경로를 정리한 실무 가이드"
slug: "payment-system-tables-postgresql"
date: 2026-07-26 10:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "database-design", "payments", "데이터모델링", "결제시스템"]
image:
  path: /assets/img/posts/blog/payment-system-tables-postgresql/preview.png
  alt: "결제 시스템에 결제 관련 테이블들 생성 예시 (각 DBMS 별) 썸네일"
---

결제 관련 테이블 설계 핵심은 **무결성 확보**, **동시성 제어**, 그리고 **실무에서 재현 가능한 확인 절차**를 먼저 정하는 것입니다. 구름이 조금 낀 날씨 탓에 집중이 흐트러질 수 있어도, 핵심 체크포인트와 바로 쓸 수 있는 SQL 예시 위주로 정리했습니다.

나는 막 배운 내용을 친한 선배에게 설명하듯 정리하려고 해요. 로컬에서 테스트는 잘 되는데 운영에서 거래량이 늘며 문제가 생기는 상황을 떠올리며 썼습니다.

왜 테이블 설계에서 자꾸 실수가 날까?
- 결제 도메인은 작은 실수가 곧 돈과 직결됩니다. 금액 단위(원 vs 센트), 중복 결제 방지, 환불 이력 관리, 그리고 외부 PG사 응답을 내부 상태와 일관되게 반영하는 흐름을 놓치기 쉽습니다.
- 커뮤니티 토론과 PostgreSQL 공식 문서(예: 제약 조건, 트랜잭션 섹션)를 보면 무결성 제약과 인덱스 설계에서 실무 설계가 자주 다르게 진행된다고 합니다. 실제로는 먼저 확인 명령 몇 개를 정해두면 문제 원인을 훨씬 빨리 좁힐 수 있더군요.

핵심 개념(짧게)
- 금액은 소수점 이슈를 피하려 **정수(센트)**로 저장하는 것을 권장.
- 외부 결제사 ID나 idempotency key는 **고유 제약(Unique)** 또는 **다중 컬럼 인덱스**로 중복 방지.
- 환불은 별도 테이블로 이력화하고, 원결제와 연결하는 FK를 둬 추적 가능하게.

실제 생성 예시 — 간단하지만 실무에 바로 쓰는 SQL
아래 예시는 PostgreSQL 14~15 환경을 기준으로 작성했습니다. 실행 전에 psql --version 또는 SELECT version();로 서버 버전을 확인하세요.

좋지 않은 예 (실패 가능성)
- 금액을 numeric(10,2)로만 쓰고 인덱스 없이 처리
- 결제 응답 ID를 중복 허용

```sql
-- 나쁜 예: 금액을 소수로 저장하면 비교/합계에서 오차 발생 가능
CREATE TABLE payments_bad (
  id serial PRIMARY KEY,
  order_id integer NOT NULL,
  amount numeric(10,2) NOT NULL,
  status varchar(20) NOT NULL,
  provider_payment_id varchar(255),
  created_at timestamptz DEFAULT now()
);
```

수정된 실무 예시 (권장)
- 금액은 정수(센트)
- id는 UUID 권장(분산 생성, 추적 용이)
- idempotency 위한 unique index, 결제 상태 검사용 partial index

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE payment_methods (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  provider varchar(50) NOT NULL,
  token varchar(255) NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uniq_user_provider_token UNIQUE (user_id, provider, token)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount_cents bigint NOT NULL,            -- 금액은 센트 단위 정수
  currency char(3) NOT NULL DEFAULT 'KRW',
  status varchar(20) NOT NULL,            -- e.g. pending, paid, failed, refunded
  provider varchar(50),
  provider_payment_id varchar(255),
  idempotency_key varchar(255),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
);

-- 중복 결제 방지
CREATE UNIQUE INDEX uniq_payment_provider_on_order
  ON payments (order_id, provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

-- idempotency key에 대한 빠른 조회용
CREATE UNIQUE INDEX uniq_payment_idempotency
  ON payments (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

환불은 별도 테이블로 이력 관리
```sql
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL,
  status varchar(20) NOT NULL, -- pending, completed, failed
  reason text,
  created_at timestamptz DEFAULT now()
);
```

여기서 잠깐. 한 가지 헷갈리기 쉬운 점은 FK의 ON DELETE 동작입니다. 주문이 삭제되면 결제 기록을 함께 지우면 안 되는 경우가 대부분입니다. 그래서 위 예시는 ON DELETE RESTRICT (또는 NO ACTION)를 사용했습니다.

이미지: 결제-테이블-개념 다이어그램
/asset 경로 규칙에 맞춘 이미지 삽입은 아래처럼 합니다.

![결제, 환불, 결제수단 테이블 관계 다이어그램](/assets/img/posts/blog/payment-system-tables-postgresql/image-1.webp)
이미지 출처: AI 생성 이미지

실패 증상 / 원인 / 확인 명령 / 조치 (실무에 바로 쓸 표)
비교 기준: 빠르게 원인 추적하고 재현/수정까지 연결되는 흐름으로 구성했습니다.

| 증상 | 원인(가능성) | 확인 명령 | 조치 |
|---|---:|---|---|
| 같은 주문에 중복 결제 발생 | idempotency 미구현, provider_payment_id 중복 허용 | psql -c "SELECT order_id, count(*) FROM payments GROUP BY order_id HAVING count(*)>1;" | idempotency key 도입, unique index 추가 |
| 특정 기간 쿼리 느림 | 인덱스 부재 또는 통계 부정확 | EXPLAIN (ANALYZE, BUFFERS) SELECT ... WHERE created_at >= ...; | 필요한 인덱스 추가, VACUUM ANALYZE 실행 |
| 환불 이력 누락 | 트랜잭션 처리 누락(rollback) | tail -n 200 /var/log/postgresql/postgresql-14-main.log | 트랜잭션 코드 점검, 로그에서 오류 메시지로 원인 파악 |
| 조회 시 금액 오차 | 금액을 float/numeric로 저장 후 계산 오류 | SELECT SUM(amount_cents) FROM payments WHERE ...; | 금액을 정수(센트)로 통일, 마이그레이션 필요 |

표 뒤 해석: 운영에서는 **중복 결제**와 **금액 단위** 문제가 가장 치명적입니다. 확인 명령(EXPLAIN, SELECT COUNT, 로그 tail 등)을 먼저 실행해 범위를 좁히고, 인덱스·제약을 적용해 재발을 막는 절차를 권합니다.

성능과 무결성 체크 포인트 (꼭 봐야 할 명령들)
- 서버 정보 확인: psql -c "SELECT version();"  
- 인덱스 목록: psql -c "SELECT * FROM pg_indexes WHERE tablename='payments';"  
- 테이블 사이즈: psql -c "SELECT pg_size_pretty(pg_relation_size('payments'));"  
- 인덱스 사용 여부: EXPLAIN (ANALYZE, BUFFERS) SELECT ... WHERE order_id = '...';  
- 통계 업데이트: VACUUM (VERBOSE, ANALYZE) payments;  
- 장애 로그 확인: tail -n 200 /var/log/postgresql/postgresql-14-main.log

이미지: 트랜잭션과 인덱스 점검 흐름
![확인 명령 예시와 로그 흐름을 보여주는 일러스트](/assets/img/posts/blog/payment-system-tables-postgresql/image-2.webp)
이미지 출처: AI 생성 이미지

운영상 고려사항: 동시성·환불·데이터 보안
- **동시성**: 결제 승인 콜백이 여러 번 올 수 있습니다. idempotency 키 또는 provider_payment_id 기반 **unique index**로 방어하세요. 트랜잭션 내에서 상태 변경 전후의 조회를 최소화하고, 필요한 경우 SELECT ... FOR UPDATE로 레코드를 잠급니다.
- **환불 흐름**: 환불은 원결제의 상태를 바꾸는 동시에 별도 이력(또는 이벤트)을 남겨야 합니다. 환불 실패 시 재시도 로직과 환불 상태 별 처리 정책을 명확히 하세요.
- **카드정보**: 카드 번호(PAN)는 절대 저장하지 마세요. PCI Security Standards Council 문서에 따라 토큰화 또는 외부 보관을 사용해야 합니다. 이 부분은 **공식 확인이 필요한 부분**입니다.
- **파티셔닝**: 거래량이 월별/년별로 극단적이라면 파티셔닝 고려(범위 파티셔닝 on created_at). Postgres 공식 문서와 운영 데이터 특성에 근거해 결정하세요.
- **복구/재처리**: 결제 재처리 스크립트를 만들 때는 idempotency key로 중복 실행을 안전하게 만들 것. 재처리 전 전체 로그와 audit 테이블을 확인하세요.

실패 예시와 수정 예시(동시성 관련)
나쁜 코드 패턴(예: 조회 후 삽입으로 경쟁 조건 발생)
```sql
-- 트랜잭션 A, B 동시 실행 시 race 발생 가능
BEGIN;
SELECT status FROM payments WHERE order_id = '...';
-- if not paid then insert
INSERT INTO payments (...) VALUES (...);
COMMIT;
```

수정된 패턴(고유 제약으로 방어)
```sql
BEGIN;
INSERT INTO payments (...) VALUES (...)
ON CONFLICT (order_id, provider, provider_payment_id) DO NOTHING;
-- 혹은 상태 업데이트를 위한 upsert 전략
COMMIT;
```

커뮤니티와 업계 반응(관찰)
- 실무자들은 idempotency와 환불 이력의 중요성에는 동의하지만, 실제 코드에선 누락되는 경우가 많습니다.
- 일부 개발자는 UUID가 과도하다고 생각하고 serial 사용을 선호합니다. 단, 분산 시스템이나 로그 추적을 고려하면 UUID 장점이 명확합니다.
- "인덱스 너무 많이 만들지 마라"는 의견도 있지만, 결제 관련 컬럼(주문ID, 상태, created_at)에 적절한 인덱스는 성능 차이가 큽니다.

공식 문서 및 참고
- PostgreSQL 문서: DDL 제약(CONSTRAINT), 인덱스, 파티셔닝 섹션 — 공식 문서를 확인해 구체 옵션을 검토하세요.
- PCI Security Standards Council 가이드라인 — 카드 정보 저장·처리 관련 규정은 반드시 확인이 필요합니다.
- 커뮤니티 예시: StackOverflow, PGCon 발표 등에서 idempotency와 인덱스 전략을 참고하면 도움됩니다.

자주 묻는 질문
(실제 검색 쿼리 형태로 작성하고 짧게 답합니다.)

Q: 금액 타입은 numeric이 더 안전한가요?  
A: 금융 연산에서는 소수점 오차를 피하려 **정수(센트)** 사용을 권합니다. 필요하면 애플리케이션에서 포맷하세요.

Q: idempotency key는 어디에 두는 게 좋나요?  
A: payments 테이블에 컬럼으로 두고 user_id와 함께 **unique 제약**을 걸어 중복 실행을 방지합니다.

Q: 결제 테이블에 파티셔닝이 필요한 기준은?  
A: 월별 거래량과 쿼리 패턴. 한 파티션이 너무 크고 VACUUM/ANALYZE 비용이 커지면 고려하세요.

Q: 환불 처리 실패 시 롤백 정책은?  
A: 원결제 상태는 변경하지 말고 환불 레코드 상태로 관리한 뒤, 실패 로그를 남기고 재시도 큐로 넣습니다.

Q: provider_payment_id가 null인 경우 중복 방지 어떻게 하나요?  
A: provider_payment_id가 null인 경우를 제외한 partial unique index를 사용하거나, 애플리케이션 레벨에서 idempotency 처리 로직을 추가합니다.

나의 의견 1
- 여기에는 본인의 환경(예: PostgreSQL 버전, 트래픽 패턴, 사용 중인 PG사)을 적어 보세요. 예: "내 환경에서는 Postgres 14, 하루 100k 트랜잭션이었다."

나의 의견 2
- 처음 실패한 재현 명령과 수정 후 명령/로그 차이를 적어 보세요. 예: "문제 전: SELECT count(*) FROM payments WHERE order_id='x' 결과 2건. 문제 후: unique index 적용으로 1건."

실무 체크리스트
- psql --version 또는 SELECT version();로 서버 버전 확인  
- payments 테이블 인덱스 목록 확인: SELECT * FROM pg_indexes WHERE tablename='payments';  
- 중복 결제 존재 여부 검사: psql -c "SELECT order_id, count(*) FROM payments GROUP BY order_id HAVING count(*)>1;"  
- 인덱스 사용 여부 테스트: EXPLAIN (ANALYZE, BUFFERS) <자주 쓰는 쿼리>;  
- 통계 업데이트: VACUUM (VERBOSE, ANALYZE) payments;  
- 로그에서 결제 관련 에러 확인: tail -n 200 /var/log/postgresql/postgresql-14-main.log  
- 백업/복구 시나리오 점검: 백업에서 테스트 복원 후 거래 무결성(카운트/총합) 검증  
- 롤백 전 확인: idempotency key 적용여부, unique index가 있는지, 환불 이력 관련 레코드 존재 여부

마무리(다음 확인 포인트)
가장 먼저 볼 로그는 결제 요청 시점의 애플리케이션 로그와 PostgreSQL 로그입니다. 다음으로는 idempotency 관련 인덱스 유무와 환불 이력 테이블 상태를 확인하세요. 운영에서 다른 선택지(예: 파티셔닝, read-replica 활용)가 더 나은지는 실제 트래픽 패턴과 쿼리 프로파일(EXPLAIN 결과)을 보고 결정하면 됩니다.

읽다가 더 궁금한 점이 있으면, 어떤 트랜잭션 예시(쿼리·로그·버전)를 가지고 있는지 알려 주세요. 같이 원인 좁혀보면 좋겠습니다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

## 함께 보면 좋은 글

- [PostgreSQL에서 장기 실행 트랜잭션 자동 감지와 알람·응답 루틴 구축 가이드](/posts/db-long-running-transaction-detection-alerting/)
- [Event-driven 아키텍처에서 스키마 변경을 무중단 적용하는 전략 Top 6](/posts/event-driven-schema-change-zero-downtime-top6/)
- [PostgreSQL에서 대규모 JSONB 컬럼을 청크로 안전하게 업데이트하는 실전 절차](/posts/postgresql-chunked-jsonb-update-safe/)
