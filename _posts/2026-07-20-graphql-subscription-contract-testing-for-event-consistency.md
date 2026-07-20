---
title: "GraphQL Subscription 계약 테스트로 서비스 간 이벤트 정합성 검증하기"
description: "서비스 A가 GraphQL Subscription으로 이벤트를 발행하고 서비스 B가 이를 소비할 때 체크해야 할 스키마, 페이로드 필드, 순서, 중복 처리, 타임아웃·재시도 정책을 계약 테스트·메시지 시뮬레이션·통합 해니슨으로 검증하는 방법과 실무 확인 명령·검증 절차"
slug: "graphql-subscription-contract-testing-for-event-consistency"
date: 2026-07-20 18:00:00 +0900
categories: ["Backend", "Testing"]
tags: ["graphql", "contract-testing", "subscription", "이벤트정합성", "계약테스트"]
image:
  path: /assets/img/posts/blog/graphql-subscription-contract-testing-for-event-consistency/preview.png
  alt: "Subscription 컨트랙트 테스트 썸네일"
---

서비스 A가 발행한 GraphQL Subscription 이벤트를 서비스 B가 실시간으로 소비할 때, **스키마(필드/타입)**, **페이로드 값**, **순서성**, **중복/아이덤포턴시**, **타임아웃·재시도 정책**을 계약 수준에서 확인하는 게 핵심이며, 이를 위해 스키마 검증·메시지 기반 계약(consumer-driven)·로컬 통합(harness) 테스트를 병행하는 실무 확인 포인트를 먼저 요약합니다.

공부하면서 알게 된 점
- GraphQL Subscription은 "쿼리/뮤테이션"과 달리 실시간 스트리밍 특성을 갖기 때문에 스키마 일치만으로는 부족하고 타임아웃·중복·정렬(ordering) 같은 런타임 속성도 계약에 포함해야 한다는 점을 알게 됐습니다.
- 단순 SDL(introspection) 검증은 payload 필드의 실제 값과 전송 타이밍, 에러 재전송 동작까지 보장하지 못한다는 사실이 실무에서 큰 문제로 이어질 수 있었습니다.

![GraphQL Subscription 흐름 일러스트](/assets/img/posts/blog/graphql-subscription-contract-testing-for-event-consistency/image-1.webp)
이미지 출처: AI 생성 이미지

처음에는 헷갈렸던 부분
- 서브스크립션도 HTTP처럼 스키마만 체크하면 되지 않을까 생각했는데, 실제로는 WebSocket 연결 수립, 초기 응답(ack), 이벤트 페이로드 형식, 연결 끊김 후 재구독 정책 등 여러 단계가 있었습니다.
- Pact 같은 메시지 계약 도구가 REST/메시지 큐와는 달리 Subscription 스트리밍에 바로 적용되기 어려워 보였는데, 메시지 단위(비동기 메시지) 계약으로 접근하면 사용 가능한 패턴이 있다는 점을 알게 됐습니다.

실무에서는 이렇게 확인하면 좋겠다
- **스키마 검증**: producer의 SDL을 consumer가 정기적으로 받아 비교.
- **메시지 샘플 계약**: 핵심 이벤트 유형별로 최소 3가지 정상/오류 케이스(정상, 필드 누락, 타입 불일치)를 정의하고 CI에서 시뮬레이션 실행.
- **통합 해니슨**: Docker Compose/Testcontainers로 producer + broker + consumer를 띄워 실제 WebSocket 연결과 이벤트 흐름을 테스트(버전: Node 18.x, graphql-ws 5.x 권장).
- **플래키 검사**: 타임아웃·재시도 횟수 기준을 정하고 반복(run=5)해서 실패율을 모니터링.

핵심 개념 정리
- GraphQL Subscription은 보통 WebSocket(graphql-ws / subscriptions-transport-ws)으로 동작. 초기 연결, 구독 시작, 데이터 전송, 완료(complete) 이벤트 흐름을 갖음.
- 계약 검증 대상: SDL(스키마), 이벤트 페이로드 샘플, 전송 주기/지연, 중복/아이덤포턴시, 연결 복구 정책, 에러 형식
- 테스트 전략: Schema-only 검사 / 메시지 계약(Pact-like) / 통합 해니슨(실제 연결 검증)

비교 표: 계약 확인 방식 선택 기준

| 방식 | 확인 포인트 | 장점 | 단점 |
|---|---:|---|---|
| Schema-only | SDL 일치 | 빠름, 자동화 쉬움 | 런타임 속성 미검증 |
| Message contract | 페이로드 샘플, 오류 케이스 | 소비자-주도 검증 가능 | 스트리밍 특성엔 추가 작업 필요 |
| Integration harness | WebSocket 연결·재시도·지연 | 실제 동작 재현, 가장 현실적 | 환경 세팅 비용↑, 실행 느림 |

실전 예시 — 실패 케이스와 수정 케이스
아래 예시는 Jest를 이용해 GraphQL Subscription 메시지의 페이로드 필드가 기대와 다른 경우를 잡아내는 실패 예시와 수정 예시입니다.

실패 예시 (테스트에서 기대한 필드가 없음)
```js
// tests/subscription.spec.js
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';

test('orderCreated payload has orderId', async () => {
  const client = createClient({
    url: 'ws://localhost:4000/graphql',
    webSocketImpl: WebSocket,
  });

  const messages = [];
  const dispose = await new Promise((resolve) => {
    const onNext = (data) => {
      messages.push(data);
      resolve(); // 첫 메시지 받으면 끝
    };

    client.subscribe(
      { query: 'subscription { orderCreated { orderId amount } }' },
      {
        next: onNext,
        error: (err) => { throw err; },
        complete: () => {},
      }
    );
  });

  // 실제로 producer에서 보낸 페이로드가 { id: '123', amount: 100 } 였다면 실패
  expect(messages[0].data.orderCreated.orderId).toBeDefined();
});
```

실패 시 흔히 보는 오류 메시지 예시:
- TypeError: Cannot read property 'orderId' of undefined
- Received payload: {"orderCreated":{"id":"123","amount":100}}

수정 예시 (테스트를 프로덕션 데이터에 맞춰 수정하거나, producer를 고침)
1) Producer 쪽을 수정(권장 경우: 필드 네이밍 표준화)
```js
// producer: publish event
pubsub.publish('ORDER_CREATED', {
  orderCreated: { orderId: '123', amount: 100 } // id -> orderId로 변경
});
```
2) 아니면 테스트를 현실 데이터에 맞춤(consumer가 id를 사용하도록)
```js
expect(messages[0].data.orderCreated.id || messages[0].data.orderCreated.orderId).toBeDefined();
```

실무 팁: 어느 쪽을 고를지 결정할 때는 서비스 경계와 소유권을 확인하세요. 이벤트 스키마는 **producer 소유**가 일반적이라면 producer 변경을 우선 고려합니다. 반대로 consumer가 다양한 버전을 지원해야 하거나 이행 기간이 필요하면 consumer를 완화형으로 수정합니다.

환경 샘플: 로컬 재현 명령
- Node 버전: 18.16.0
- graphql-ws: 5.11.0
- docker-compose 파일 경로: ./docker/docker-compose.yml
- 실행
  - docker compose -f ./docker/docker-compose.yml up --build -d
  - npm ci (root)
  - npm run test:subscriptions

WebSocket 직접 연결 확인(수동)
- wscat 설치: npm i -g wscat
- 연결: wscat -c ws://localhost:4000/graphql
- 구독 시작(JSON 전송 예시):
```json
{ "type": "subscribe", "id": "1", "payload": { "query": "subscription { orderCreated { orderId amount } }" } }
```
(참고: 실제 프로토콜은 graphql-ws 규약을 따름. 위는 간단화한 예시입니다.)

검증 명령(재현·확인 절차)
1. producer SDL 확인
   - curl http://localhost:4000/graphql -H "Content-Type: application/json" -d '{"query":"{ __schema { types { name } } }"}'
2. WebSocket 구독 테스트
   - wscat 연결 후 상기 구독 쿼리 전송, 이벤트 발행 시 수신 확인
3. 메시지 샘플 계약 테스트
   - 테스트 스크립트 실행: npm run test:contract (Jest로 메시지 샘플 5케이스)
4. 통합 반복성 검사
   - 반복 실행: for i in {1..5}; do npm run test:integration || break; done

재현 가능한 오류 메시지 예시(복수)
- "Protocol error: connection ack not received" — 초기 핸드셰이크 실패
- "Payload validation failed: orderId is required" — 스키마/validator가 페이로드를 거부
- "Timeout waiting for subscription event (5s)" — publisher 지연 또는 라우팅 문제

공부하면서 적용해본 패턴
- Consumer-driven message contract: 핵심 필드(식별자, 타입, 타임스템프)만 엄격히 검증하고, 확장 필드는 허용하는 방식으로 계약을 유연하게 잡음.
- 재시도·중복 정책은 계약서에 숫자(예: maxRetries=3, dedupWindow=10s)로 명시하여 테스트 자동화에 사용.

![GraphQL 서비스 간 계약 테스트 구성도](/assets/img/posts/blog/graphql-subscription-contract-testing-for-event-consistency/image-2.webp)
이미지 출처: AI 생성 이미지

실무에서 확인할 포인트(체크리스트 형태)
- SDL 버전(semver)과 마지막 변경 시각 확인
- 대표 이벤트 샘플(정상 x2, 오류 x1) 저장 및 CI 실행
- WebSocket handshake 성공/ack 로그 확인 (서비스 로그, 브로커 로그)
- 연결 복구 시나리오(브로커 재시작, 네트워크 지연)에서 소비자 동작 확인
- 소비자에서의 idempotency 처리(예: requestId로 중복 제거) 검증

코드 예시: 간단한 producer(Apollo-like)와 consumer 테스트
```js
// producer (간략)
import { PubSub } from 'graphql-subscriptions';
const pubsub = new PubSub();

const typeDefs = `
  type Order { orderId: ID!, amount: Int! }
  type Subscription { orderCreated: Order }
  type Mutation { createOrder(amount: Int!): Order }
`;

const resolvers = {
  Subscription: {
    orderCreated: { subscribe: () => pubsub.asyncIterator('ORDER_CREATED') },
  },
  Mutation: {
    createOrder: (_, { amount }) => {
      const order = { orderId: String(Math.random()), amount };
      pubsub.publish('ORDER_CREATED', { orderCreated: order });
      return order;
    }
  }
};
```

공부하면서 알게 된 테스트 설정 경로·파일 예시
- 테스트 파일: tests/subscription.spec.js
- CI 스크립트: .github/workflows/ci.yml (subscription 테스트 job 포함 권장)
- Docker Compose: docker/docker-compose.yml (services: producer:4000, consumer:5000, redis:6379)

Q&A
## 자주 묻는 질문

Q: Subscription 이벤트 순서(ordering)를 보장해야 할까요?
A: 순서 보장이 필요하면 **프로토콜 또는 브로커가 순서를 보장하는지**, 그리고 재연결 시 resume/offset을 지원하는지를 먼저 확인하세요. 확인 명령: 브로커 로그에서 message.sequence 확인 또는 consumer가 수신한 sequence를 테스트로 검증하세요.

Q: 재시도 정책을 어디에 명시하나요?
A: 계약 문서에 maxRetries, retryBackoff, retryWindow(초) 같은 숫자 항목으로 명시하고 CI 시나리오에 해당 값을 사용해 실패/복구 테스트를 자동화하세요.

Q: 어떻게 flaky한 구독 테스트를 줄이나요?
A: 1) 타임아웃을 현실적으로 늘리고(예: 5s→15s) 2) 테스트에 재시도 로직을 넣고 3) 환경 단순화(네트워크 지연 제거) 후 실패율을 관찰하세요.

Q: Pact 같은 도구로 Subscription을 검증할 수 있나요?
A: Pact의 메시지 기능을 이용하면 비동기 메시지 페이로드 계약은 가능하지만, WebSocket 연결/재구독 동작까지는 별도 시뮬레이터로 보완해야 합니다.

Q: 실패 시 어디 로그를 먼저 보나요?
A: 1) consumer 로그(수신/파싱 오류) 2) broker 로그(전송/큐잉 상태) 3) producer 로그(발행 시점 payload) 순으로 보세요.

실무에서 바로 쓰는 설정 비교(짧은 표)
| 항목 | 권장 값/도구 |
|---|---|
| Node 버전 | 18.x |
| WebSocket lib | graphql-ws 5.x |
| Broker(선택) | redis pubsub 또는 nats |
| Contract tool | pact-js(메시지) 또는 커스텀 JSON 샘플 |

검증 경로(공식 문서)
- GraphQL Subscriptions 개념: https://graphql.org/blog/subscriptions-in-graphql-and-relay/
- graphql-ws 사용법: https://github.com/enisdenjo/graphql-ws
- Pact 메시지 가이드: https://docs.pact.io/

중요한 주의 사항
- **테스트 플래키를 무작정 timeout 늘려 해결하지 마세요**. 타임아웃 증가는 문제를 숨길 수 있습니다. 먼저 원인(브로커 처리량, 네트워크, backpressure)을 분석하는 게 좋습니다.
- 이벤트 계약은 **스키마 + 런타임 규약**(ex: dedupWindow=10s)을 함께 관리해야 합니다.


실무 체크리스트
1. SDL(스키마) 최신화: producer SDL을 저장하고 consumer가 CI에서 비교하도록 설정
   - 확인 명령: curl http://producer:4000/graphql -d '{"query":"{ __schema { types { name } } }"}'
2. 메시지 샘플 등록: 정상 2개, 오류 1개, 필드 누락 1개
   - 테스트 파일: tests/fixtures/order-created/*.json
3. 통합 해니슨 구성: docker/docker-compose.yml로 producer+broker+consumer 기동
   - 명령: docker compose -f docker/docker-compose.yml up --build -d
4. WebSocket 핸드셰이크 확인: wscat 연결 후 ack 수신 확인
5. 반복성 테스트: for i in {1..5}; do npm run test:integration || break; done (실패율 기록)
6. 로그 확인 포인트: producer publish time, broker queue depth, consumer receive time
7. 계약 변경 프로세스: 스키마 변경 시 consumer와 사전 협의/마이그레이션 기간 명시

마무리(무작정 요약 대신 행동 우선)
- 이 주제에서 먼저 확인해야 할 것: **producer가 내보내는 실제 페이로드(샘플)와 연결 시나리오(handshake/ack/reconnect)**.  
- 다른 선택지가 나을 때: 스키마만 자주 바뀌고 런타임 특성이 중요하지 않다면 Schema-only 검증으로 빠르게 자동화하고, 반대로 실시간 성능·중복·정합성이 더 중요하면 통합 해니슨과 메시지 계약 병행을 추천합니다.
