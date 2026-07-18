---
title: "Prepared Statement 캐시 누수로 인한 DB 커넥션 과다 사용 진단과 해결"
description: "대량 요청 환경에서 PostgreSQL 서버·드라이버의 Prepared Statement 캐시 누수 원인 식별, pg_stat_activity·pg_prepared_statements 조회 명령어, 드라이버 설정(prepareThreshold 등) 변경과 임시 대처(DEALLOCATE/pg_terminate_backend) 절차와 실무 점검 포인트"
slug: "db-prepared-statement-cache-leak-diagnosis"
date: 2026-07-18 12:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "prepared-statements", "psql", "성능튜닝", "연결관리"]
image:
  path: /assets/img/posts/blog/db-prepared-statement-cache-leak-diagnosis/preview.png
  alt: "Prepared Statement 캐시 누수 썸네일"
---

Prepared Statement 캐시가 의도치 않게 늘어나면 각 DB 세션의 메모리와 상태가 증가해 전체 커넥션 수·자원 사용이 급격히 늘어날 수 있고, 실무에서는 **pg_prepared_statements 조회**, **pg_stat_activity 모니터링**, 클라이언트 드라이버의 prepare 동작 설정 확인을 먼저 하면 원인 파악에 도움이 됩니다.

들어가며 — 제가 공부하면서 정리한 흐름
- 대량 요청 환경에서 특정 API가 갑자기 DB 연결을 많이 쓰기 시작했을 때, 보통 커넥션 풀 설정부터 보게 되는데, Prepared Statement 관련 캐시 누수가 숨은 원인일 때가 있더라고요.
- 처음에는 "prepared statement가 어떻게 커넥션 수랑 연관이 있지?"라고 헷갈렸습니다. 직접 코드·드라이버 설정과 DB 내부 뷰를 비교해보니 몇 가지 확인 포인트가 보였습니다.
- 아래에는 제가 실제로 체크해볼 단계, 자주 만나는 드라이버/풀 관련 이슈, 임시 대처법과 권장 설정들을 정리했습니다. 실무에서 바로 쓸 수 있도록 명령어·코드 예시도 넣었습니다.

Prepared Statement 개념(간단히)
- Prepared Statement는 동일한 쿼리를 반복 실행할 때 파싱/계획 비용을 줄이기 위해 미리 준비해두는 기법입니다. 서버 측(세션 단위)에서 준비되면 세션이 살아있는 동안 그 준비된 상태가 유지됩니다.
- 클라이언트 드라이버(예: JDBC, node-postgres, psycopg 등)가 내부적으로 **서버 사이드 준비(named prepared statement)** 를 만들거나, 드라이버 내부 캐시를 유지해서 반복 사용 성능을 높이는 방식이 있습니다. 이 동작은 드라이버별로 다르고 설정 가능한 경우가 많습니다.

공부하면서 알게 된 점
- 드라이버가 준비된 쿼리를 세션에 이름을 붙여 저장하면, 해당 세션(커넥션)에 준비된 항목이 누적될 수 있습니다.
- 커넥션 풀이 커서/커넥션을 많이 만들고 오래 유지하면, 각 커넥션에 쌓인 prepared statement가 합쳐져 전체 메모리·상태를 키울 수 있습니다.
- pgbouncer 같은 커넥션 풀러/프록시 모드(특히 transaction pooling)는 세션 기반 준비와 충돌이 생길 수 있어 주의가 필요합니다.

처음에는 헷갈렸던 부분
- pg_prepared_statements 뷰로는 어떤 세션(PID)에 속한 prepared statement인지 바로 알기 어렵더군요. 그래서 세션과 매핑하는 방법(응용 로그, 드라이버 로깅, 혹은 강제 커넥션 종료)을 조합해야 했습니다.
- "자동으로 준비되는 것(드라이버 캐시) vs. 명시적으로 PREPARE한 것"을 구분해야 원인 추적이 쉬웠습니다.

실무 점검 순서 (우선순위 낮음->높음이 아니라, 문제 발견 시 바로 해볼 것들)
1. 전체 커넥션/활동 확인
   - psql에서:
     ```
     SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
     SELECT application_name, client_addr, count(*) AS conns
       FROM pg_stat_activity
       GROUP BY application_name, client_addr
       ORDER BY conns DESC;
     ```
   - 여기서 특정 application_name 또는 client_addr에서 연결이 몰리는지 확인합니다.

2. Prepared statements 수 확인
   - psql에서:
     ```
     SELECT count(*) FROM pg_prepared_statements;
     SELECT name, statement, prepare_time FROM pg_prepared_statements LIMIT 20;
     ```
   - **주의**: 이 뷰는 세션별 prepared statement를 보여주지만, 어떤 세션(PID)에 속하는지는 표시하지 않아서 단독으로는 매핑이 어렵습니다.

3. 애플리케이션/드라이버 설정 확인
   - JDBC: `prepareThreshold` (PostgreSQL JDBC 드라이버) — 기본값이 5인 경우가 많아 그 이상 빈도로 같은 쿼리를 쓰면 서버에 준비가 생깁니다. 0으로 해서 비활성화하거나 적절히 조정 가능.
   - node-postgres(pg): 쿼리 객체에 `name`을 주면 named prepared statement가 세션에 저장됩니다. 이름을 매번 다르게 주면 누수 발생 가능.
   - 각 드라이버에 "prepared statement cache" 관련 설정이 있는지 찾아봅니다.

4. 연결 풀러(pgbouncer 등)와의 상호작용 확인
   - pgbouncer의 pooling mode가 `transaction`이면 세션 기반 prepared statement 사용에 제약이 생길 수 있습니다. 충돌로 인해 오류나 풀 불일치가 발생하기도 합니다.
   - 이 경우 **transaction pooling** 사용 시 **서버 사이드 prepared statement 사용은 피하는 편**이 안전합니다.

임시 해결(긴급 대처)
- 해당 세션의 준비된 항목을 제거하려면 세션 내부에서 `DEALLOCATE name` 혹은 `DEALLOCATE ALL` 을 사용할 수 있습니다.
  - 세션 내부 접속이 가능하면:
    ```
    DEALLOCATE ALL;
    ```
  - 다른 세션에서 강제로 종료하기(위험함 — 트랜잭션 유실 가능):
    ```
    SELECT pid, application_name, client_addr FROM pg_stat_activity WHERE application_name = 'your-app';
    SELECT pg_terminate_backend(<pid>);
    ```
    - **주의**: 트랜잭션이 있는 세션을 종료하면 롤백 및 사용자 영향이 발생할 수 있으니 신중하게 사용하세요.
- 드라이버 설정을 변경해 자동 prepare를 비활성화하거나 prepareThreshold를 높입니다. (애플리케이션 재배포 필요)

코드 예시: Node.js에서 의도치 않은 named prepared statement 누수 예
```js
// 예시: 매 호출마다 name이 바뀌는 경우(누수 가능)
const { Pool } = require('pg');
const pool = new Pool(/* config */);

async function callDb(param) {
  const name = `stmt-${Date.now()}-${Math.random()}`;
  await pool.query({ name, text: 'SELECT col FROM t WHERE id = $1', values: [param] });
}
```

수정 방향 예시
```js
// 재사용 가능한 이름 사용
const stmtName = 'select-by-id';
await pool.query({ name: stmtName, text: 'SELECT col FROM t WHERE id = $1', values: [param] });

// 또는 이름 없이 parameterized query 사용
await pool.query('SELECT col FROM t WHERE id = $1', [param]);
```

이미지: Prepared Statement 개념 표현
![Prepared statement와 세션 관계를 단순화한 일러스트](/assets/img/posts/blog/db-prepared-statement-cache-leak-diagnosis/image-1.webp)
이미지 출처: AI 생성 이미지

드라이버별 체크포인트 비교표
| 항목 | 문제 증상 | 점검 포인트 | 권장 대응 |
|---|---:|---|---|
| JDBC | 서버에 많은 prepared statement | `prepareThreshold` 값 확인 | 0으로 비활성화 또는 적절히 조정 |
| node-postgres | 이름을 매번 다르게 주는 경우 | query `name` 사용 여부 확인 | 이름 고정 또는 이름 제거 |
| psycopg2 | explicit prepare 사용 여부 | 애플리케이션 코드 확인 | 불필요한 PREPARE 제거 |
| pgbouncer | transaction pooling과 충돌 | pooling mode 확인 | session pooling으로 전환하거나 prepare 사용 금지 |

(표는 가독성 위해 간단히 정리했습니다)

더 공부하면서 알게 된 작은 팁들
- pg_prepared_statements 뷰는 유용하지만 세션 매핑이 필요할 땐 애플리케이션 쪽에서 쿼리 준비 로그를 남기게 하는 게 현실적인 방법입니다.
- 커넥션 풀의 커넥션 수와 준비된 statement 수를 기준으로 메모리 소모를 추정해볼 수 있습니다. 예: 평균 준비 항목 수 × 세션 수 × 항목당 평균 메모리(추정).
- 운영 환경에서는 먼저 드라이버 설정을 바꾸고, 재현이 확실하면 코드 변경을 적용하는 순서가 안전합니다.

이미지: 문제 조사 흐름(로그·뷰·코드 점검)
![PG 뷰와 애플리케이션 로그를 비교하며 원인 추적하는 흐름도](/assets/img/posts/blog/db-prepared-statement-cache-leak-diagnosis/image-2.webp)
이미지 출처: AI 생성 이미지

실무에서는 이렇게 확인하면 좋겠다 (체크 포인트 정리)
- DB 측: pg_stat_activity, pg_prepared_statements, 서버 로그(로그 레벨에 따라 parse/describe 로그 가능) 확인
- 애플리케이션: 드라이버의 prepared 관련 설정(prepareThreshold, statement cache 등) 확인 및 로그 활성화
- 풀/프록시: pgbouncer 등 사용 시 pooling mode 확인(특히 transaction 모드 사용 시 주의)
- 임시조치: DEALLOCATE ALL(세션 내부), pg_terminate_backend(pid)로 문제 세션 종료(심각한 경우)
- 장기대응: 쿼리 네이밍 규칙, 드라이버 설정 표준화, 커넥션 풀 최소 필요 수로 조정

주의사항(위험한 조치)
- pg_terminate_backend는 트랜잭션을 강제로 롤백시키므로 서비스 영향이 클 수 있습니다. **가능하면 낮은 트래픽 시간대에** 사용하세요.
- DEALLOCATE ALL은 세션 내부에서 실행해야 하므로 원격에서 시도하려면 해당 세션에 접속 가능한 수단이 필요합니다.

## Q&A
Q: pg_prepared_statements에서 세션 PID를 바로 알 수 있나요?
A: 기본 뷰에는 PID가 포함되어 있지 않아서 바로 매핑하기 어렵습니다. 애플리케이션에서 prepared 생성 시 로그를 남기거나, 각 커넥션의 activity와 타임스탬프를 비교하는 방식으로 추적해야 할 때가 많습니다.

Q: pgbouncer transaction pooling을 안 쓰면 되나요?
A: 가능한 해결책 중 하나이지만, session pooling이 늘어나면 DB 연결 수가 증가하고 리소스 문제가 생길 수 있습니다. 선택은 환경(동시성/리소스)에 따라 달라집니다.

Q: prepareThreshold를 0으로 설정하면 성능이 떨어질까요?
A: 일부 반복 쿼리에서 CPU·파싱 비용이 조금 늘어날 수 있지만, 서버 측 캐시로 인한 메모리·연결 과다 문제를 피할 수 있습니다. 실제 영향은 워크로드에 따라 다릅니다. 테스트를 권합니다.

Q: 자동으로 쌓인 prepared statement를 한 번에 제거하려면?
A: 해당 세션에 접속해 `DEALLOCATE ALL;` 을 실행하거나, 세션을 종료(`pg_terminate_backend`)하면 해제됩니다.

## 나의 의견 1
여기에 직접 겪었던 상황과 내가 취한 조치(예: 어떤 드라이버의 어떤 설정을 바꿨는지, 영향)는 간단히 적어보세요.

## 나의 의견 2
앞으로 시도해볼 개선안이나 재현 케이스(예: 부하테스트에서 어떤 시나리오로 문제를 재현했는지)를 적어보세요.

실무 체크리스트
- [ ] pg_stat_activity에서 연결 분포(어플리케이션별, 호스트별) 확인
- [ ] pg_prepared_statements 총수 및 최근 생성 패턴 확인
- [ ] 애플리케이션 드라이버의 prepare 관련 설정(prepareThreshold, 쿼리 이름 사용) 점검
- [ ] 커넥션 풀러(pgbouncer 등) 모드 확인 및 정책 검토
- [ ] 임시로 문제 세션에 대해 DEALLOCATE ALL 또는 인가된 세션 종료 절차 마련
- [ ] 변경 전/후 성능·메모리 영향 비교 테스트 계획 수립

참고(짧게)
- psql에서의 `pg_stat_activity`, `pg_prepared_statements` 조회는 진단의 첫걸음입니다.
- 드라이버 문서에서 prepared 관련 설정을 꼭 찾아보세요. (JDBC: prepareThreshold, node-postgres: named queries 등)

마무리 — 조심스럽게 정리하자면
Prepared Statement 캐시 누수는 코드·드라이버·풀러가 얽혀 발생하는 경우가 많아 한 번에 해결하기 어렵습니다. 위에서 적은 단계(뷰 확인 → 드라이버 설정 확인 → 임시 해제 → 코드 변경 → 재검증)를 차근차근 따라가면 원인 파악과 안전한 해결에 도움이 될 것 같습니다. 혹시 여러분 환경에서 겪은 비슷한 사례나, 드라이버별 설정값에서 혼란스러운 부분이 있으면 이어서 질문 주세요.