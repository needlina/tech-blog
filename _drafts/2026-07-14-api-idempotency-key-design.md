---
title: "API 중복 요청 방지: 실무에서 쓰는 멱등성 키(idempotency key) 설계 가이드"
slug: "api-idempotency-key-design"
date: 2026-07-13 10:00:00 +0900
categories: [Backend, DevOps]
tags: [idempotency, api, deduplication, request-id, backend]
image:
  path: /assets/img/posts/blog/api-idempotency-key-design/preview.png
  alt: "중복 요청을 막는 멱등성 키 썸네일"
---

오늘은 API 중복 요청을 막기 위해 멱등성 키(idempotency key)를 설계하고 실무에서 확인할 포인트를 정리해보려고 합니다. 저는 아직 초보 개발자지만, 몇 가지 구현 패턴과 운영에서 확인하면 좋을 것 같은 점들을 공부하면서 정리해봤습니다. 이 글은 제가 공부하면서 알게 된 내용과 실제로 적용해보며 느낀 부분들을 조심스럽게 정리한 것입니다. 환경이나 요구사항에 따라 달라질 수 있으니 참고 정도로 보시면 좋겠습니다.

왜 멱등성 키가 필요할까?
- 네트워크 타임아웃, 클라이언트 재시도, 사용자의 실수 등으로 동일한 요청이 여러 번 서버에 도달할 수 있습니다.
- 결제, 주문 생성, 리소스 프로비저닝 등 '한 번만 실행되어야 하는' 작업에서 중복 실행은 큰 문제가 됩니다.
- 멱등성 키는 클라이언트가 요청마다 고유한 키를 달아서, 서버가 동일 키의 반복 요청을 감지하고 중복 처리하지 않도록 돕습니다.

공부하면서 알게 된 점
- 멱등성은 "결과가 여러 번 실행되어도 같은 상태를 만들어낸다"는 의미로, 안전(읽기만)과는 다른 개념입니다.
- 서버는 단순히 키 존재 여부만 체크하는 것보다, 요청의 최종 상태(성공/실패/진행중)와 응답을 함께 저장하면 이후 재요청 시 더 일관된 응답을 줄 수 있습니다.
- 저장소 선택(데이터베이스 vs Redis 등)은 복구, 확장성, 비용, 일관성 요구사항에 따라 달라집니다. 예를 들어 트랜잭션 원자성 때문에 RDBMS에서 unique constraint를 활용하는 경우가 안전하게 느껴졌습니다.
- TTL(유효기간)은 필수로 생각되며, 너무 짧으면 중복 허용, 너무 길면 저장소 부담이 됩니다. 보통 비즈니스 요구 기준으로 몇 분~몇 달까지 다양했습니다.

처음에는 헷갈렸던 부분
- 멱등성 키의 범위(scope): 전역으로 할지, 사용자별로 할지, 특정 API 엔드포인트별로 할지 헷갈렸습니다. 지금은 "키 조합(user_id + endpoint + client-generated-key)" 형태가 직관적이라는 느낌입니다.
- 실패 처리: 요청이 처리 중에 서버가 죽는 경우를 어떻게 다루냐가 난제였습니다. 이 경우 "처리 중" 상태를 저장하고 재시도 로직에서 적절히 타임아웃을 두는 방법을 사용해봤습니다.
- 응답 저장 여부: 일부는 성공 여부만 저장해도 된다고 하고, 일부는 응답 바디까지 저장하면 더 친절한 재응답이 가능하다고 권하더군요. 응답 크기와 민감정보(PII) 저장 여부를 고려해야 합니다.

멱등성 키 설계 고려사항 (요약)
- 키의 생성 주체: 보통 클라이언트(또는 API 게이트웨이)가 생성합니다. UUIDv4 같은 랜덤 키가 일반적입니다.
- 키의 범위(scope): user_id + endpoint + key 조합으로 중복 범위를 좁히는 편이 안전합니다.
- 저장소: Redis(빠름, TTL 관리 용이), PostgreSQL(영속성, 트랜잭션) 등. 둘을 조합할 수도 있습니다.
- 상태 모델: pending, success, failed 같은 상태와 최종 응답(또는 참조)을 저장.
- TTL/만료: 비즈니스 요구 기준으로 설정. 결제 등 민감한 리소스는 장기간 보존 고려.
- 동시성/원자성: 단일 원자 연산(SETNX, INSERT UNIQUE, Lua 스크립트)을 사용.
- 보안/사이즈: 키에 민감정보를 포함하지 않고, 길이 제한을 둠.

구현 패턴 예시

1) PostgreSQL을 이용한 패턴 (unique constraint + transaction)
- 멱등성 테이블 예시

```sql
CREATE TABLE idempotency_keys (
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  endpoint TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL, -- pending, success, failed
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX ux_idempotency_user_endpoint_key
  ON idempotency_keys (user_id, endpoint, key);
```

- 요청 처리 흐름(의사코드)
  1. 트랜잭션 시작
  2. INSERT INTO idempotency_keys (user_id, endpoint, key, state='pending')  
     - conflict 발생 시 기존 row 조회
  3. 기존 row가 success이면 저장된 response를 반환
  4. 기존 row가 pending이고 오래되지 않았다면 재시도 제한 응답(또는 wait)
  5. 비즈니스 로직 실행
  6. 응답을 row에 저장하고 state='success'로 업데이트
  7. 커밋

- 장점: 트랜잭션과 고유 인덱스로 원자성을 확보할 수 있습니다.
- 주의: DB 부하, 대용량 response 저장 고려

2) Redis SETNX 패턴 (빠른 검증, TTL 함께 사용)
- 단순 예시 (bash + redis-cli)

```bash
# 클라이언트가 보낸 idempotency-key
IDEMP_KEY="idemp:users:123:create-order:uuid-...:20260713"

# SETNX + TTL을 원자적으로 하기 위해서는 redis 2-step 아닌 SET with NX PX 사용
redis-cli SET $IDEMP_KEY "pending" NX PX 600000
# 반환이 OK면 작업 진행, nil이면 이미 존재
```

- Redis에서 Lua 스크립트를 사용하면 "체크 + 작업 + 응답 저장"을 원자화할 수 있습니다.
- 응답을 저장하려면 값에 JSON으로 상태+응답을 넣거나 별도 key로 저장.

3) API 게이트웨이/프록시에서의 처리
- Nginx 또는 API 게이트웨이에서 idempotency-key header를 강제하고, 리퀘스트 라우팅 전에 빠른 캐시 체크를 할 수 있습니다.
- Nginx example (헤더 차단/검증은 보통 Lua 혹은 sidecar에서 처리)

HTTP 헤더 예시
- 권장: Idempotency-Key: <uuid>
- 함께 보내기 좋은 헤더: X-Request-Id, Authorization, Content-Type, Date 등

간단한 Node.js(Express) + Redis 예시

```js
// 의사코드
const express = require('express');
const redis = require('redis').createClient();

app.post('/orders', async (req, res) => {
  const idemp = req.get('Idempotency-Key');
  const userId = req.user.id;
  const key = `idemp:${userId}:orders:${idemp}`;

  const locked = await redis.set(key, JSON.stringify({state: 'processing'}), {NX: true, PX: 10*60*1000});
  if (!locked) {
    const stored = await redis.get(key);
    // stored가 성공 응답 정보를 포함하면 그걸 그대로 리턴
    return res.status(409).json({message: 'duplicate request', detail: stored});
  }

  try {
    const result = await createOrder(...);
    await redis.set(key, JSON.stringify({state: 'success', response: result}));
    res.json(result);
  } catch (err) {
    await redis.del(key); // 또는 상태를 failed로 남김
    throw err;
  }
});
```

실무에서 확인하면 좋겠다 (운영 포인트)
- 키 수집: 요청 로그에 Idempotency-Key와 client IP, user_id, endpoint를 함께 로깅해서 문제 추적에 도움되게 합니다.
- 모니터링: 멱등성 키 충돌율(중복 요청율), 처리 중(pending) 비율, TTL 만료로 인한 재발급률 등을 지표로 노출합니다.
- 데이터 보존 정책: DB나 Redis에 쌓이는 키의 TTL을 주기적으로 확인하고, 과거 데이터 정리 정책을 세웁니다.
- 재시도 정책 문서화: 클라이언트가 어떤 경우에 재시도해야 하는지(예: 네트워크 타임아웃, 5xx 등) 가이드합니다.
- 장애 복구: 서버가 처리 중 다운된 경우, 'processing' 상태가 너무 오래 지속되면 수동 또는 자동 회복 절차를 마련합니다.
- 보안: Idempotency-Key는 단순 식별자일 뿐 권한 검증을 대체하지 않습니다. 반드시 인증/인가 체크를 별도로 하세요.

운영 명령어/점검 절차 예시 (DB, Redis, Docker, Linux 관련)
- PostgreSQL에서 중복 키 확인
```bash
# 문제 있는 키 찾기 (예시)
psql -d mydb -c "SELECT user_id, endpoint, key, state, created_at FROM idempotency_keys WHERE created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 50;"
```

- Redis에서 특정 패턴 키 개수 확인
```bash
docker exec -it redis redis-cli --scan --pattern "idemp:*" | wc -l
# 키 샘플 보기
docker exec -it redis redis-cli --scan --pattern "idemp:*" | head -n 20 | xargs -I{} docker exec -it redis redis-cli GET {}
```

- Docker 컨테이너 로그 확인
```bash
docker logs -f backend-api
# 또는 systemd 서비스 로그
journalctl -u my-backend.service -f
```

- curl로 재현 테스트
```bash
curl -X POST https://api.example.com/orders \
  -H "Idempotency-Key: 123e4567-e89b-12d3-a456-426614174000" \
  -H "Authorization: Bearer <token>" \
  -d '{"product_id": 1, "qty": 1}'
```

- Nginx/Proxy에서 헤더 전달 여부 확인
```bash
# nginx 로그에 $http_idempotency_key 등으로 로깅 설정했는지 확인
grep idempotency nginx.conf
```

Pitfalls / 주의사항
- 키 충돌: 클라이언트가 같은 키를 다른 목적으로 재사용하면 문제가 생길 수 있습니다. 키 생성 규칙을 문서화하세요.
- 응답 저장 용량: 큰 응답을 그대로 저장하면 저장소가 금방 차므로 요약 또는 참조 ID 저장을 고려하세요.
- 시간이 오래 걸리는 작업: 처리 중 상태가 오래 지속되면 클라이언트가 재요청을 보낼 수 있으니 타임아웃과 백그라운드 처리 전략을 고민하세요.
- 멱등성은 모든 API에 적용할 필요는 없습니다. GET/PUT 같은 idempotent 메서드와 POST의 중요한 엔드포인트를 우선 적용하는 것이 현실적입니다.

공부하면서 알게 된 점 (다시 정리)
- 클라이언트에서 키를 만들도록 하는 것이 보통이지만, 서버가 대체 키를 발급해주는 패턴도 존재합니다(특히 모바일 SDK 등).
- Redis는 빠르지만 데이터가 날라갈 가능성이 있어서, 장기 보존 또는 재빌드가 필요하면 RDBMS로 동기화하는 패턴을 고려하게 되었습니다.
- 테스트 자동화: 동시성 테스트(동일 키로 여러 요청을 동시에 보내는 테스트)를 꼭 넣어야 합니다.

처음에는 헷갈렸던 부분 (요약)
- "멱등성 키가 실패 케이스도 처리하나?" — 네, 실패 상태를 상태 모델에 포함시키는 것이 좋지만, 실패를 저장할지 삭제할지는 정책에 따라 달라질 수 있습니다.
- "키의 범위를 어디까지 좁혀야 하나?" — 사용자별 + 엔드포인트별이 일반적이지만, 엄격성은 서비스 요구에 따라 다릅니다.

실무에서는 이렇게 확인하면 좋겠다
- 매일/주간 지표로 중복 요청 비율, 처리 중(pending) 키 비율, TTL 만료로 삭제된 키 수를 확인하세요.
- 사고 발생 시 로그에서 Idempotency-Key별로 모든 관련 로그를 묶어 추적하면 원인 파악이 빠릅니다.
- 배포 전에는 동시성 부하 테스트로 race condition이 없는지 검증하세요(예: k6, wrk 사용).

관련 이미지 주제
1. 클라이언트에서 Idempotency-Key를 생성해 서버로 보내는 흐름(간단한 화살표 다이어그램).
2. 서버 저장소(Redis/Postgres)에 key와 상태가 기록되는 간단한 구성도(상태 전이 포함).

실무 체크리스트
- [ ] API 스펙에 Idempotency-Key 헤더와 사용 가이드를 문서화했는가?
- [ ] 키의 범위(user_id+endpoint+key 등)와 길이 제한을 정했는가?
- [ ] 원자성을 보장하는 저장 방식(SET NX or INSERT UNIQUE)을 구현했는가?
- [ ] 처리 중(pending), success, failed 상태 모델을 설계했는가?
- [ ] 키 보존 기간(TTL)과 정리 정책을 정의했는가?
- [ ] 로그에 Idempotency-Key를 포함시키고, 탐지/추적이 가능한가?
- [ ] 동시성 테스트(동일 key 다중 요청)를 자동화하여 검증했는가?
- [ ] 응답 저장 시 용량/보안(PII) 문제를 검토했는가?
- [ ] 운영 중 지표(중복율, pending 비율)를 모니터링하고 있는가?

마무리: 제가 정리한 방법들이 모든 상황에 딱 맞지는 않을 수 있습니다. 다만 설계할 때 고려해야 할 핵심 포인트와 실무에서 점검하면 좋은 사항들을 모아봤습니다. 직접 적용하면서 발견한 문제나 개선점이 있으면 계속 보완하려고 합니다. 질문이나 특정 환경(예: 서버리스, 모바일 클라이언트 등)에 맞춘 예제가 필요하면 알려주세요. 같이 더 살펴볼 수 있습니다.