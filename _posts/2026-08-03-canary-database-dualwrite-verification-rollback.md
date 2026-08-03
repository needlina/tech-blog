---
title: "Canary DB dual-write를 준비하며 배운 점: 검증과 롤백을 먼저 설계하기"
description: "DB 전환 과정에서 dual-write를 검토하며 겪은 불안, 검증 쿼리, 모니터링 지표, 롤백 절차를 경험 중심으로 정리한 기록"
slug: "canary-database-dualwrite-verification-rollback"
date: 2026-08-03 10:00:00 +0900
categories: ["Database", "DevOps"]
tags: ["dual-write", "canary-deployment", "database", "장애대응", "배포자동화"]
image:
  path: /assets/img/posts/blog/canary-database-dualwrite-verification-rollback/preview.png
  alt: "Canary DB 쓰기 썸네일"
---

DB 전환 작업에서 제일 무서운 순간은 코드를 배포하는 순간이 아니었다. 배포 후 한참 지나서 "새 테이블에 일부 데이터가 비어 있다"는 사실을 발견하는 순간이었다. Canary DB dual-write를 검토하면서 내가 가장 먼저 정리한 것도 구현 방식이 아니라 **어디까지 확인해야 롤백할 수 있다고 말할 수 있는가**였다.

처음에는 단순하게 생각했다. 기존 테이블에 쓰고, 새 테이블에도 같이 쓰면 되는 일처럼 보였다. 하지만 막상 운영 관점으로 보면 질문이 계속 늘어난다.

- 한쪽 쓰기만 성공하면 요청을 성공으로 봐도 되는가?
- 재시도 중복으로 같은 주문이나 이벤트가 두 번 들어가면 어떻게 찾을 것인가?
- canary 비율을 1%에서 5%로 올리는 기준은 무엇인가?
- 문제가 생겼을 때 새 테이블을 버리면 끝인가, 아니면 이미 흘러간 데이터를 복구해야 하는가?

이 글은 dual-write를 멋진 패턴으로 소개하는 글이 아니다. 실제로 적용하기 전에 내가 체크했던 기준과, 중간에 "이거 그대로 밀면 위험하겠다"고 느꼈던 지점을 정리한 운영 메모에 가깝다.

## 왜 바로 전환하지 않았나

로컬과 스테이징에서는 DB 변경이 대체로 얌전하게 보인다. 데이터 양이 적고, 트래픽이 일정하고, 이상한 입력도 거의 없다. 문제는 운영 데이터다.

예전에 스키마 변경을 할 때 가장 부담스러웠던 부분은 쿼리 자체보다 데이터의 모양이었다. nullable이라고 믿었던 값이 사실상 필수처럼 쓰이고 있거나, 반대로 필수라고 생각한 값이 오래된 레코드에는 비어 있는 경우가 있었다. 이런 상태에서 한 번에 새 테이블로 전환하면 실패 지점이 너무 늦게 보인다.

그래서 canary dual-write를 검토했다. 전체 트래픽을 한 번에 옮기지 않고, 일부 요청만 새 쓰기 경로를 태운 뒤 아래 세 가지를 먼저 확인하고 싶었다.

- 기존 DB와 새 DB 또는 새 테이블의 데이터가 맞는가
- 쓰기 지연이 감당 가능한 수준인가
- 문제가 생겼을 때 canary 경로를 끄고 남은 데이터를 정리할 수 있는가

여기서 핵심은 "일부만 태운다"가 아니었다. 일부만 태워도 **비교할 기준과 멈출 기준이 없으면 그냥 느린 전체 장애**가 된다.

## 내가 먼저 정한 중단 기준

처음에는 성공률만 보면 된다고 생각했다. 하지만 성공률은 생각보다 둔하다. 애플리케이션은 200을 반환했는데 canary 쓰기만 조용히 실패하면, 사용자 입장에서는 성공이고 운영자 입장에서는 데이터 불일치다.

그래서 canary 비율을 올리기 전에 아래 기준을 먼저 적어 두었다.

| 항목               | 중단 기준               | 이유                                        |
| ------------------ | ----------------------- | ------------------------------------------- |
| canary 쓰기 실패율 | 0.5% 이상 지속          | 일부 실패라도 나중에 백필 비용이 커짐       |
| p95 쓰기 지연      | 기존 대비 50% 이상 증가 | 사용자가 체감하기 전에 멈추기 위함          |
| count 불일치       | 허용 오차 초과          | 누락 또는 중복 여부를 바로 확인             |
| DLQ 증가           | 5분 이상 누적           | 비동기 재처리가 밀리는 신호                 |
| unknown error      | 원인 분류 불가          | 원인을 모르는 상태에서는 비율을 올리지 않음 |

숫자는 서비스마다 달라진다. 중요한 건 숫자의 정답이 아니라, 배포 전에 팀 또는 나 자신이 "이 상태면 멈춘다"고 합의해 두는 것이다. 혼자 운영할수록 이 기준이 더 필요하다. 장애가 나면 사람은 생각보다 빨리 낙관적이 된다. "조금만 더 보면 괜찮아지지 않을까"라는 마음이 제일 위험했다.

## 구현에서 제일 먼저 본 부분

가장 피하고 싶었던 코드는 이런 형태였다.

```javascript
await primaryDb.insert(item);

secondaryDb
  .insert(item)
  .catch((err) => console.error("canary write failed", err));

return { status: 200 };
```

처음 보면 나쁘지 않아 보인다. 기존 흐름은 살리고, canary 쓰기 실패는 로그만 남기니 사용자 영향도 작아 보인다. 하지만 운영에서는 이 코드가 제일 불편하다. 실패를 알고도 성공으로 덮어버리기 때문이다.

내 기준에서는 최소한 아래 정보가 남아야 했다.

- request id
- idempotency key
- primary write id
- canary write id
- 실패한 DB 또는 테이블 이름
- 재시도 횟수
- 최종 처리 상태

그래서 실제 구현 방향은 아래처럼 잡았다. 예시는 단순화한 Node.js 의사 코드다.

```javascript
const writeContext = {
  requestId: req.headers["x-request-id"],
  idempotencyKey: req.headers["idempotency-key"],
  source: "orders-api"
};

const tx = await primaryDb.beginTransaction();

try {
  const order = await tx.orders.insert({
    ...payload,
    requestId: writeContext.requestId
  });

  await writeCanaryOrder({
    order,
    context: writeContext,
    retry: 3
  });

  await tx.commit();

  metrics.increment("order_write_success_total", {
    path: "dual_write"
  });

  return { status: 200, id: order.id };
} catch (err) {
  await tx.rollback();

  metrics.increment("order_write_failed_total", {
    path: "dual_write",
    reason: classifyError(err)
  });

  await alert("dual-write-failure", {
    requestId: writeContext.requestId,
    idempotencyKey: writeContext.idempotencyKey,
    message: err.message
  });

  throw err;
}
```

여기서 고민이 생긴다. canary 쓰기가 실패했을 때 primary까지 롤백할 것인가, 아니면 primary는 성공시키고 canary만 재처리할 것인가.

나는 데이터 성격에 따라 나눠야 한다고 봤다. 주문, 결제, 정산처럼 한 건의 누락도 부담스러운 데이터라면 실패를 크게 보고 멈추는 쪽이 낫다. 반대로 조회 최적화용 보조 테이블처럼 나중에 다시 만들 수 있는 데이터라면 primary 성공 후 canary 실패를 DLQ로 보내는 방식도 가능하다.

## 검증 쿼리는 배포 전에 써 둔다

dual-write에서 검증 쿼리를 배포 후에 만들면 늦다. 장애 중에는 쿼리도 급하게 만들고, 급하게 만든 쿼리는 대개 틀린다.

내가 먼저 준비한 쿼리는 단순했다. 첫 번째는 기간별 count 비교다.

```bash
psql -h primary-host -At -c "SELECT count(*) FROM public.orders WHERE created_at >= '2026-08-01';"
psql -h canary-host -At -c "SELECT count(*) FROM public.new_orders WHERE created_at >= '2026-08-01';"
```

두 번째는 primary에는 있는데 canary에는 없는 id를 찾는 쿼리다.

```sql
SELECT p.id
FROM public.orders p
LEFT JOIN public.new_orders c ON p.id = c.id
WHERE p.created_at >= '2026-08-01'
  AND c.id IS NULL
LIMIT 100;
```

세 번째는 반대 방향이다. 재시도나 idempotency 처리 실수로 canary 쪽에만 생긴 데이터도 확인해야 한다.

```sql
SELECT c.id
FROM public.new_orders c
LEFT JOIN public.orders p ON p.id = c.id
WHERE c.created_at >= '2026-08-01'
  AND p.id IS NULL
LIMIT 100;
```

처음에는 count만 보면 충분하다고 생각했는데, count는 중복과 누락이 동시에 생기면 속을 수 있다. 그래서 count 비교는 빠른 경보용으로만 보고, 실제 판단은 id 기준 비교로 했다.

## 모니터링은 예쁜 대시보드보다 라벨이 중요했다

대시보드 자체보다 중요한 것은 canary 흐름만 따로 볼 수 있는 라벨이었다. 기존 쓰기와 canary 쓰기가 같은 메트릭에 섞이면, 1% canary의 실패는 전체 그래프에서 거의 보이지 않는다.

최소한 아래 메트릭은 분리해서 보려고 했다.

- `app_write_success_total{path="primary"}`
- `app_write_success_total{path="canary"}`
- `app_write_errors_total{path="canary", reason="duplicate_key"}`
- `app_write_latency_seconds{path="canary"}`
- `dual_write_mismatch_total`
- `dual_write_dlq_messages`

Grafana에서는 전체 평균보다 p95, p99를 먼저 봤다. 평균은 너무 쉽게 착해 보인다. canary 쓰기에서 일부 요청만 2초 이상 튀어도 평균으로는 묻힌다.

알림도 처음부터 크게 잡지 않았다. 1% canary 단계에서는 아래 정도면 충분했다.

| 알림             | 조건                                  |
| ---------------- | ------------------------------------- |
| canary 쓰기 실패 | 5분 동안 실패율 0.5% 이상             |
| 지연 증가        | canary p95가 primary p95의 1.5배 이상 |
| 불일치 증가      | 비교 작업에서 mismatch 발생           |
| DLQ 누적         | DLQ 메시지가 5분 이상 감소하지 않음   |

혼자 운영하는 프로젝트라면 Slack, Discord, 이메일 중 하나만이라도 바로 울리게 두는 편이 낫다. 로그에만 남기는 건 알림이 아니다.

## 롤백은 "끄기"와 "정리"를 나눠야 했다

처음에는 canary 비율을 0%로 내리면 롤백이라고 생각했다. 실제로는 절반만 맞는 말이다. 트래픽을 끄는 것은 확산을 멈추는 일이고, 이미 생긴 데이터 차이를 정리하는 것은 별도 작업이다.

내가 정리한 롤백 순서는 이랬다.

1. 로드밸런서 또는 feature flag에서 canary 쓰기 비율을 0%로 낮춘다.
2. 비동기 큐를 쓴다면 consumer를 잠시 멈추고 DLQ 상태를 확인한다.
3. primary와 canary의 count 차이를 확인한다.
4. id 기준 불일치 목록을 파일로 뽑는다.
5. 백필 또는 삭제 스크립트를 작은 배치로 실행한다.
6. count, id 샘플, 애플리케이션 에러율을 다시 확인한다.

예를 들어 누락된 id를 뽑아 백필해야 한다면 이런 식으로 시작한다.

```bash
psql -h primary-host -At -c "COPY (
  SELECT p.id
  FROM public.orders p
  LEFT JOIN public.new_orders c ON p.id = c.id
  WHERE p.created_at >= '2026-08-01'
    AND c.id IS NULL
) TO STDOUT" > missing_ids.txt
```

그리고 한 번에 전부 처리하지 않는다. 작은 배치로 돌리고 실패 id를 따로 남긴다.

```bash
while read id; do
  node backfill-order.js "$id" || echo "$id" >> failed_ids.txt
done < missing_ids.txt
```

이 스크립트도 배포 전에 한 번은 staging 데이터로 돌려봐야 한다. 운영 장애 중에 처음 실행하는 복구 스크립트는 너무 비싸다.

## 내가 피하려고 한 함정

첫 번째 함정은 "canary니까 안전하다"는 착각이었다. canary는 안전장치가 아니라 노출 범위를 줄이는 방법이다. 검증 쿼리, 알림, 중단 기준이 없으면 1% 장애도 그냥 천천히 쌓인다.

두 번째 함정은 idempotency를 나중에 붙이려는 생각이었다. dual-write에서 재시도는 거의 반드시 필요하고, 재시도를 넣는 순간 중복 문제가 따라온다. request id나 idempotency key 없이 시작하면 나중에 누락과 중복을 설명하기 어렵다.

세 번째 함정은 롤백을 코드 배포만으로 생각하는 것이다. DB 작업의 롤백은 데이터 정리까지 포함해야 한다. 코드를 되돌렸는데 데이터가 이미 어긋나 있으면 장애는 끝난 게 아니다.

## 언제 dual-write를 쓰지 않을 것인가

dual-write가 항상 답은 아니었다. 아래 상황이라면 더 단순한 방법을 먼저 본다.

- 컬럼 추가처럼 비파괴적 변경으로 충분한 경우
- backfill 후 읽기 경로만 점진 전환하면 되는 경우
- 새 테이블이 조회 최적화용이라 재생성이 쉬운 경우
- 일관성 요구가 너무 높아 두 저장소를 동시에 운영하는 것이 더 위험한 경우

특히 결제나 정산처럼 틀리면 바로 돈 문제로 이어지는 데이터는 dual-write를 가볍게 쓰면 안 된다. 이 경우에는 감사 로그, 재처리 큐, 수동 검수 화면까지 같이 봐야 한다.

## 최종 체크리스트

내가 다음에 같은 작업을 한다면 이 순서로 확인할 것이다.

- canary를 끄는 feature flag가 있는가
- request id와 idempotency key가 모든 쓰기 경로에 남는가
- primary와 canary를 비교하는 count/id 쿼리가 준비되어 있는가
- canary 전용 성공률, 실패율, p95/p99 지표가 분리되어 있는가
- DLQ 또는 실패 재처리 경로가 있는가
- 백필 스크립트와 실패 id 기록 파일이 준비되어 있는가
- canary 비율을 올리는 기준과 멈추는 기준이 문서화되어 있는가

정리하면, dual-write에서 중요한 건 동시에 쓰는 코드 자체가 아니었다. **쓰기 실패를 숨기지 않는 것, 비교할 수 있는 식별자를 남기는 것, 되돌릴 때 데이터까지 정리할 수 있는 것**이 핵심이었다. 이 세 가지가 준비되지 않았다면 canary 비율을 1%로 낮춰도 마음이 편하지 않았다.

## 함께 보면 좋은 글

- [Event-driven 아키텍처에서 스키마 변경을 무중단 적용하는 전략 Top 6](/posts/event-driven-schema-change-zero-downtime-top6/)
- [도커를 휴대용 실행 환경으로 쓰는 법: Dockerfile, Compose, Volume을 한 세트로 보기](/posts/docker-portable-runtime-dockerfile-compose-volume/)
- [폐쇄망 GitLab CI/CD에서 Node.js 빌드하기: npm install 없이 Docker 이미지로 해결한 방법](/posts/gitlab-cicd-closed-network-node-docker-npm-cache/)
