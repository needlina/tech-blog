---
title: "메시지 큐에서 재시도와 데드레터 큐 분리 기준: 실무 관점 가이드"
description: "메시지 큐에서 재시도와 데드레터 큐를 나누는 기준 서두 — 왜 이 주제를 공부했나 제가 최근에 메시지 기반 아키텍처를 다루면서 가장 혼란스러웠던 부분 중 하나가 \"언제까지 재시도하고, 언제 데드레터(Dead Letter Queue, DLQ)로 보내야"
slug: "message-queue-retry-dead-letter-queue"
date: 2026-07-14 12:00:00 +0900
categories: [Backend, DevOps]
tags: ["message-queue", "dead-letter-queue", "재시도전략", "장애대응", "observability"]
image:
  path: /assets/img/posts/blog/message-queue-retry-dead-letter-queue/preview.png
  alt: "재시도와 DLQ 나누기 썸네일"
---

메시지 큐에서 재시도와 데드레터 큐를 나누는 기준 서두 — 왜 이 주제를 공부했나 제가 최근에 메시지 기반 아키텍처를 다루면서 가장 혼란스러웠던 부분 중 하나가 "언제까지 재시도하고, 언제 데드레터(Dead Letter Queue, DLQ)로 보내야


메시지 큐에서 재시도와 데드레터 큐를 나누는 기준

서두 — 왜 이 주제를 공부했나
제가 최근에 메시지 기반 아키텍처를 다루면서 가장 혼란스러웠던 부분 중 하나가 "언제까지 재시도하고, 언제 데드레터(Dead Letter Queue, DLQ)로 보내야 하는가"였습니다. 시스템의 안정성과 운영 편의성 사이에서 적절한 균형을 잡는 것이 쉽지 않았습니다. 이 글에서는 공부하면서 정리한 내용과 실무에서 체크해볼 포인트들을 제 경험 중심으로 조심스럽게 적어보겠습니다. 절대적인 정답이라기보다는, 실제로 운영하면서 확인하면 도움이 될 실무 지향의 체크리스트와 예시를 제공하는 목적입니다.

공부하면서 알게 된 점

- 재시도는 실패 원인에 따라 달라진다: 네트워크 일시 장애나 외부 API의 일시적인 과부하는 재시도로 해결될 가능성이 높지만, 데이터 문제(잘못된 포맷, 누락된 필수값)나 비즈니스 예외는 재시도가 의미가 없을 때가 많습니다.
- 재시도 전략(동기/비동기 재시도, 지수 백오프, 최대 시도 횟수)은 큐 시스템과 소비자 구현, SLA에 따라 같이 설계돼야 한다는 점을 배웠습니다.
- 데드레터 큐는 단순히 "버리는 곳"이 아니고, 문제 원인을 조사하고 재처리(또는 수동 복구)를 하도록 돕는 관찰성(Observability) 포인트입니다.
- 관측 가능한 메트릭(예: 큐 길이, 재시도 카운트, 실패 유형 분포)을 갖추면 재시도 정책을 조정하기 수월해집니다.

![메시지 큐와 데드레터 큐의 흐름을 보여주는 단순한 다이어그램(큐와 DLQ, 재시도 화살표 포함).](/assets/img/posts/blog/message-queue-retry-dead-letter-queue/image-1.webp)
이미지 출처: AI 생성 이미지

처음에는 헷갈렸던 부분

- 재시도를 큐 밖에서(consumer 레벨) 할지, 큐 시스템의 기능으로 할지(RabbitMQ DLX, SQS redrive policy, Kafka topic-based DLQ) 선택하는 기준이 불분명했습니다. 공부해보니 둘 다 장단점이 있더군요.
  - 큐에 위임하면 설정이 단순하고 운영적 제어가 쉬움. 하지만 소비자 관점에서 실패 원인을 세밀하게 다루기 어렵고, 메시지에 대한 컨텍스트(어떤 검증 실패인지 등)를 쉽게 붙이기 어렵습니다.
  - 소비자에서 직접 재시도 로직을 구현하면 실패 원인에 따른 분기(예: 바로 DLQ 전송, 특정 에러는 재시도)를 세밀하게 할 수 있지만, 모든 소비자에 재시도 로직을 중복 구현하면 유지비용이 커짐.
- "몇 회" 재시도해야 하는지에 대한 기준도 애매했습니다. 여기서는 경험적으로 자주 보이는 패턴을 정리합니다(서비스마다 달라질 수 있습니다).
  - 일시적 오류: 급격한 외부 의존성 실패 시 3~5회, 지수 백오프(예: 500ms, 1s, 2s...) 추천.
  - 비가역 오류(데이터 문제 등): 즉시 DLQ로 보냄.
  - 시간 민감 메시지(예: 만료시간 있음): 재시도 횟수는 적게, 만료 여부 확인 후 DLQ 또는 discard.

기술별로 조금 다른 관점(간단 요약)

- RabbitMQ: Dead Letter Exchange(DLX)를 이용해 특정 이유(reason)로 메시지를 DLQ로 라우팅. 재시도는 소비자에서 재퍼블리시하거나 토픽/큐 구조로 구현.
- AWS SQS: RedrivePolicy(최대 수신 횟수)를 통해 자동 DLQ 전송. 단, 세부 실패 이유를 붙이기 어렵다.
- Kafka: 일반적으로 실패한 메시지를 별도의 dead-letter-topic으로 보내고, 재처리 워크플로우를 만든다. 트랜잭션 처리와 offset 제어가 중요.

예시 코드와 설정
아래 예시들은 개념을 이해하기 위한 간단한 스니펫입니다. 환경에 맞게 더 안전하게(에러 처리, 로깅 등) 다듬어야 합니다.

1. Node.js 소비자 예시(메시지에 attempt 헤더를 붙여 재시도 카운트 관리)

```javascript
// 소비자(간단한 pseudocode)
async function handleMessage(msg) {
  const body = JSON.parse(msg.body);
  const attempt = parseInt(msg.attributes.attempt || "0", 10) + 1;

  try {
    await processBusinessLogic(body);
    // 성공 시 ack
    channel.ack(msg);
  } catch (err) {
    if (isTransientError(err) && attempt < 5) {
      // 지수 백오프를 적용해 재퍼블리시
      const delayMs = Math.pow(2, attempt) * 100;
      setTimeout(() => {
        channel.publish("", "work-queue", Buffer.from(JSON.stringify(body)), {
          headers: { attempt: String(attempt) }
        });
      }, delayMs);
      channel.ack(msg); // 원본 메시지는 ack하고 재발행
    } else {
      // DLQ로 이동: 실패사유와 함께
      channel.publish(
        "",
        "dead-letter-queue",
        Buffer.from(
          JSON.stringify({
            original: body,
            error: String(err),
            attempt
          })
        )
      );
      channel.ack(msg);
    }
  }
}
```

2. RabbitMQ DLX 바인딩 예시(큐 생성 시 설정)

- 토대로 한 예시 설정(관리 콘솔 또는 정책 이용)

```
# RabbitMQ에서 큐를 만들 때 x-dead-letter-exchange를 지정
# 예시(AMQP 선언 코드 또는 rabbitmqadmin/관리 콘솔에서 설정)
queueDeclare('work-queue', {
  arguments: {
    'x-dead-letter-exchange': 'dlx-exchange'
  }
});
# dlx-exchange에 바인딩된 dead-letter-queue가 존재해야 함
```

3. AWS SQS RedrivePolicy 예시 (AWS CLI)

```
# DLQ가 이미 만들어져 있다고 가정
aws sqs set-queue-attributes \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/work-queue \
  --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:ap-northeast-1:123456789012:my-dlq\",\"maxReceiveCount\":\"5\"}"}'
# 모니터링:
aws sqs get-queue-attributes --queue-url <URL> --attribute-names All
```

운영(실무)에서 확인하면 좋은 포인트
아래는 운영 중 문제가 생겼을 때 확인하면 유용한 항목들입니다. 모니터링과 로그를 함께 보세요.

1. 큐 길이와 소비 지연

- RabbitMQ: rabbitmqctl list_queues name messages_ready messages_unacknowledged
- SQS: ApproximateNumberOfMessagesVisible, ApproximateNumberOfMessagesNotVisible
- Kafka: consumer lag (kafka-consumer-groups.sh --describe)

2. 재시도 횟수와 실패 유형 분포

- 메시지에 실패 유형(error code, exception type)을 메타데이터로 기록하면 집계가 쉬움. DLQ로 들어간 메시지에 실패 사유를 같이 넣어야 나중에 분석하기 편함.

3. 재처리 가능성 확인

- DLQ에 쌓인 메시지 중 재처리할 수 있는 것과 수동 개입이 필요한 것을 분리해야 합니다. 예: 단순 타임아웃이라면 재발행으로 해결, 데이터 누락이면 수동 조치.

4. 경보(알람) 설정

- DLQ 증가율이 특정 임계를 넘으면 알람. 소비자 에러율, 평균 재시도 횟수 증가 등도 알람 대상.

5. 상호의존성 확인

- 외부 API 호출 실패로 재시도가 많이 발생하면 그 외부 시스템의 상태와 연동 로그를 함께 확인하세요.

![재시도 정책(지수 백오프)을 설명하는 간단한 그래프(시도 횟수에 따른 지연 시간 증가를 선으로 표시).](/assets/img/posts/blog/message-queue-retry-dead-letter-queue/image-2.webp)
이미지 출처: AI 생성 이미지

실무에서는 이렇게 확인하면 좋겠다 (실제 점검 절차 예시)

- 1. 큐 상태 점검: 큐 길이, unacked 수, consumer 연결 상태 확인
  - RabbitMQ: rabbitmqctl list_queues ... / management UI
  - SQS: CloudWatch metrics / CLI
- 2. 최근 DLQ 메시지 샘플 10개 추출(최신 순)해서 실패 사유 패턴 확인
  - 메시지 헤더/본문에 실패코드가 있는지 확인
- 3. 소비자 로그에서 correlation-id로 트레이스
- 4. 외부 의존성 상태 체크(서드파티 API, DB 연결 등)
- 5. 재처리 전략 검토: 수동 재처리 스크립트/배치 있는지, 자동 재처리 조건은 어떤지
- 6. 알람 임계치 조정: 정상적인 급증(배치 작업 등)에 의한 일시적 증가를 오탐지하지 않게 조정

Kafka 관련 실무 팁(간단)

- 실패 메시지는 별도 topic으로 보내고, DLQ 토픽에 실패 메타를 포함하세요.
- consumer 그룹 재처리 시 offset 조정이 필요하며, 재처리 도중 중복 처리를 고려해야 합니다.

모니터링 메트릭(참고용)

- RabbitMQ: messages_ready, messages_unacknowledged, message_stats.publish, queue_count
- SQS: ApproximateNumberOfMessagesVisible, ApproximateNumberOfMessagesNotVisible, ApproximateAgeOfOldestMessage
- Kafka: consumer lag, topic partition offsets, dlq topic message rate

주의할 점(제가 공부하면서 조심스럽게 느낀 것)

- "무조건 DLQ로 보내라" 혹은 "무조건 재시도해라" 같은 일반화는 피해야 할 것 같습니다. 서비스의 특성(금융 거래 vs 로그 수집 등), 메시지의 중요도, 복구 가능성, 재시도로 인한 부하 등을 고려해야 합니다.
- 재시도 정책을 너무 공격적으로 설정하면(짧은 간격 높은 빈도) 대상 시스템에 더 큰 부하를 줄 수 있습니다. 백오프 전략을 권장합니다.
- DLQ에 쌓이는 메시지도 보안/개인정보(PII) 규정을 고려해 저장 주기나 접근 제어를 설계해야 합니다.

예시: 간단한 운영 스크립트(큐 상태 점검, RabbitMQ + Docker 환경 가정)

```
# docker container가 rabbitmq인 경우
docker exec -it rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged

# 특정 큐의 최근 메시지(관리 UI나 로그에서 확인 권장)
# SQS는 CLI로 속성 확인
aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

실무 체크리스트

- 재시도 정책 문서화: 어떤 에러를 재시도할지, 최대 몇 회, 백오프 방식은 무엇인지
- DLQ 구조 설계: DLQ에 포함할 메타(원본 메시지, 실패 사유, 시도 횟수, timestamp)
- 모니터링 설정: 큐 길이, DLQ 증가율, 재시도 횟수 분포에 대한 대시보드와 알람
- 접근/보관 정책: DLQ 메시지 보관 기간, 열람 권한, PII 처리를 위한 마스킹/암호화
- 재처리 프로세스: 자동/수동 재처리 도구와 책임자, 재처리 시 중복 처리 대책
- 점검 절차: 장애 발생 시 확인 순서(큐 상태 → DLQ 샘플 → 소비자 로그 → 외부 의존성)
- 테스트 케이스: 재시도/DLQ 동작을 검증하는 단위 테스트와 통합 테스트(예: 고의 실패 유발 메시지 전송)

마치며
메시지 큐에서 재시도와 데드레터 큐를 언제 분리할지는 정답이 하나는 아닌 것 같습니다. 다만 실패 원인 분류, 재시도 비용(시스템 부하), 재처리 가능성, 관찰성 확보 등 여러 관점에서 기준을 세우고 운영에 반영하면 훨씬 실무에서 편해진다는 것을 느꼈습니다. 제 정리는 개인적으로 실무에 적용해보며 계속 다듬을 생각입니다. 혹시 비슷한 경험이나 다른 패턴을 알고 계시면 공유해주시면 감사하겠습니다.
