---
title: "분산 트레이스 샘플링 손실로 끊긴 트랜잭션 복원 절차와 실무 점검 포인트"
description: "분산 트레이스에서 샘플링 누락으로 끊긴 트랜잭션을 상관관계로 재조합하는 방법, 로그·메트릭 병행 검증 절차, Jaeger/OTel 수집기 설정 예시와 점검 명령·오류 증상 확인 경로 목록"
slug: "tracing-recover-missing-spans-correlation-procedure"
date: 2026-07-20 12:00:00 +0900
categories: ["Observability", "DevOps"]
tags: ["tracing", "distributed-tracing", "observability", "sampling-loss", "장애대응"]
image:
  path: /assets/img/posts/blog/tracing-recover-missing-spans-correlation-procedure/preview.png
  alt: "끊긴 트레이스 복원 썸네일"
---

분산 환경에서 일부 스팬이 샘플링 정책 때문에 빠지면 트랜잭션이 끊긴 것처럼 보이는데, **로그·메트릭·남아있는 스팬들의 타임스탬프·trace_id·parent_id를 기준으로 상관관계 재조합을 시도**할 수 있고, 실무에서는 특정 패턴(예: 누락이 특정 서비스에서 집중되는지, 샘플링 비율 변화, tail-based sampling 미적용 여부)을 먼저 확인하면 시간을 절약할 수 있다.

공부하면서 알게 된 점
- 분산 트레이스는 trace_id와 span_id(및 parent_id)로 연결되는데, 샘플링으로 일부 스팬이 수집되지 않으면 연결이 끊기는 듯 보인다.
- 로그에 trace_id를 남기면 샘플링 누락 스팬을 로그로 보완해 트랜잭션 흐름을 재구성할 수 있다.
- tail-based sampling(수집기 단계에서 샘플링을 결정)으로 바꾸면 중요한 트랜잭션을 보존할 가능성이 높아진다. 

처음에는 헷갈렸던 부분
- "샘플링이 클라이언트 쪽에서만 일어나면 수집기에서 못 보는 것 아니냐?"가 헷갈렸는데, 샘플링은 보통 클라이언트/서비스 에이전트(헤더 기반 결정) 또는 Collector(OTel Collector)에서 모두 설정될 수 있다. 어느 단계에서 샘플링이 적용되는지 확인해야 원인을 좁힐 수 있다.
- trace_id가 로그에도 없고 스팬도 없을 때는 재구성이 불가능하다는 점을 실무에서 체감했다. 따라서 **관계 복원을 위해 trace_id를 로그에 남기는 정책은 거의 필수**로 느꼈다.

왜 이걸 복원해야 하나?
- APM에서 트랜잭션 흐름을 이해할 때 끊긴 트랜잭션은 원인 분석을 방해한다.
- SLA 위반이나 오류 발생시 관련 스팬을 재조합하면 원인 서비스와 시점 추적이 가능하다.
- 비용 때문에 전체 샘플링을 높일 수 없는 경우, 재구성 절차가 실무에서 유용하다.

핵심 개념 정리
- trace_id: 트랜잭션 단위 식별자
- span_id / parent_id: 호출 관계 정의
- 샘플링 위치: 클라이언트(에이전트), 애플리케이션 라이브러리, Collector(서버) — 위치에 따라 누락 원인과 해결책이 달라짐
- tail-based sampling: Collector가 모든 스팬을 잠시 보관한 뒤 중요 트랜잭션을 골라 저장(보존률 향상)
- 로그-트레이스 연계: 로그에 trace_id를 포함하면 샘플링 누락을 로그로 보완 가능

실무에서는 이렇게 확인하면 좋겠다
1. 누락 패턴 파악
   - 어느 서비스에서 parent_id가 많은지, 특정 시간대에 집중되는지 확인
   - Jaeger UI나 Elasticsearch/ClickHouse 스팬 인덱스를 쿼리해서 빈도 확인
2. 샘플링 위치 확인
   - 애플리케이션 에이전트 설정(예: OpenTelemetry SDK sampling config)과 Collector 설정 둘 다 점검
3. 로그와 메트릭 연계
   - 애플리케이션 로그에 trace_id가 기록되는지(로그 포맷), 로그 수집기에서 조회 가능한지 확인
4. 재조합 시나리오 실행
   - 남은 스팬과 로그를 기준으로 타임스탬프·trace_id로 병합해서 단위 트랜잭션을 재구성해본다

예시: Jaeger 쿼리로 누락 패턴 확인 (예시 명령)
- Jaeger API(예, Jaeger 1.43.0)에서 최근 1시간 서비스별 트레이스 개수 확인
  - curl -s "http://jaeger:16686/api/services"
- 특정 서비스의 트레이스 검색(lookback 1h)
  - curl -s "http://jaeger:16686/api/traces?service=my-service&lookback=1h" | jq '.data | length'

OpenTelemetry Collector sampling 설정 예시 (잘못된 예시 -> 수정 예시 포함)
- 실패 예시: 애플리케이션 SDK에서만 샘플링을 낮춰서 중요한 후속 스팬이 Collector로 전달되지 않는 경우
  - (애플리케이션) sdk 설정: sampling_probability: 0.01
  - 문제: Collector에서 tail-based sampling 비활성화 → 비율 낮음 → 중요 스팬 손실
- 수정 예시: Collector에서 tail-based sampling 추가(OTel Collector v0.74.0 예시)
{% raw %}
```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: error-policy
        type: trace
        # 조건: error 태그가 있는 트레이스는 보존
        selectors:
          - match_type: string
            expressions:
              - attributes.status: "error"
```
{% endraw %}
(위 YAML은 환경에 맞춰 수정 필요. decision_wait은 Collector가 트레이스를 보관하는 시간으로, 지연과 저장 비용 간 트레이드오프가 있음)

로그-트레이스 보완 예시 (애플리케이션에서 로그에 trace_id 남기기)
- Spring Boot 예시 (logback.xml 패턴에 trace_id 추가)
```xml
<pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%X{trace_id}] %logger{36} - %msg%n</pattern>
```
- 확인 명령(예: 로그에서 특정 trace_id 검색)
  - grep "trace-id=abc123" /var/log/myapp/*.log

스팬 재구성 시 유용한 필드
- trace_id, span_id, parent_id
- start_time, end_time (또는 duration)
- service.name, operation.name
- status/error 태그
- 로그의 timestamp와 trace_id

비교: 복원/보존 전략 (짧은 표)
| 방법 | 확인 포인트 | 장점 | 단점 |
|---|---:|---|---|
| 샘플링 비율 상향 | 현재 비율(%) 확인 | 단순, 재현율 증가 | 비용/저장 증가 |
| tail-based sampling | Collector 설정 존재 여부 | 중요한 트랜잭션 보존 | Collector 리소스/설정 복잡 |
| 로그 연계 재구성 | 로그에 trace_id 포함 여부 | 샘플링 누락 보완 가능 | 로그가 없으면 불가능 |
| 지표기반 보존(에러 중심) | error 태그/메트릭 활용 | 문제 트랜잭션 우선 보존 | 정상 트랜잭션은 누락 가능 |

실무 점검 절차(우선 순위)
1. 애플리케이션 로그 포맷에 trace_id가 포함되어 있는지 확인 (로그 경로, 예: /var/log/*)
2. 에이전트/SDK 버전과 sampling 설정 확인 (예: OpenTelemetry SDK v1.16.0, sampling_probability 설정)
3. Collector 설정 확인(OTel Collector config path: /etc/otel-collector/config.yaml), tail_sampling 유무 확인
4. Jaeger/Zipkin UI로 orphan span(부모 없는 스팬) 비율 확인
5. 비용·스토리지 영향 평가 후 샘플링 전략 변경 또는 tail-based sampling 적용 검토

재현과 검증 예시 (실행 가능한 명령어·경로·출력 예)
- 애플리케이션에서 trace 로그 남김(예시)
  - 로그 라인 예: 2026-07-20T11:12:13.456Z INFO [trace_id=abc123] Request received
- Jaeger에서 trace 조회
  - curl -s "http://jaeger:16686/api/traces?service=my-service&traceID=abc123" | jq '.data[0].spans | length'
  - 출력 예: 3 (하지만 로그에는 더 많은 스텝이 기록되어 있다면 누락 존재)
- Elasticsearch에서 span 인덱스 검색(예시)
  - curl -s "http://es:9200/spans/_search?q=trace_id:abc123" | jq '.hits.total.value'

실패 사례와 수정 예시
- 실패 증상: 특정 비동기 작업에서 parent_id가 누락되어 트랜잭션이 끊김
  - 원인: 메시지 큐 전송 시 tracecontext 미전달
  - 수정: 프로듀서에서 traceparent 헤더(또는 B3)를 설정하도록 코드 변경
- 코드 수정 예시 (pseudo)
```go
// 메시지 전송 시 헤더에 tracecontext 복사
ctx := trace.SpanContextFromContext(req.Context())
headers["traceparent"] = formatTraceparent(ctx)
queue.Send(msg, headers)
```
- 재검증: 메시지 소비측 로그에서 동일 trace_id가 찍히는지 확인하고 Jaeger에서 연결된 스팬이 존재하는지 확인

오류 상황별 빠른 원인 추정 체크리스트
- 수집기(Collector) 장애 여부: Collector CPU/메모리 spikes 확인
- 네트워크 장애: 스팬이 Collector로 전달되지 않음 (애플리케이션 로그에 exporter error)
- 샘플링 정책 변경: 최근 배포로 sampling_probability가 바뀌었는지 Git log 확인
- 포맷 불일치: 에이전트와 Collector가 사용하는 trace 포맷(B3 vs W3C) 불일치

## Q&A
Q: 샘플링을 높이면 저장비용이 크게 늘어나는데 대안은?
A: **tail-based sampling**으로 중요한 트랜잭션만 보존하거나, error/latency 기반 샘플링을 적용하면 비용을 줄이며 보존율을 높일 수 있다. 우선 현재 error 트랜잭션의 빈도, 평균 스팬 크기(바이트)를 측정해 비용 예측을 하세요.

Q: 로그에 trace_id를 남겼는데도 재조합이 안 되는 경우는?
A: 로그 타임스탬프의 시계 동기화(NTP) 문제로 순서가 꼬이거나, 로그 레벨/샘플링으로 일부 로그가 남지 않을 가능성이 있다. 로그와 트레이스 타임스탬프 차이를 비교해 보세요.

Q: tail-based sampling의 decision_wait는 어떻게 정하나?
A: 트랜잭션의 최대 예상 지연(예: 5s API, 비동기는 30s)을 기반으로 정한다. **너무 짧으면 트랜잭션 전체를 판단 못하고, 너무 길면 Collector 메모리 비용 상승**이 문제다.

Q: 포맷(B3 vs W3C) 불일치 문제 어떻게 확인하나?
A: 애플리케이션과 Collector의 propagated formats 설정을 확인하고, 실제 요청 헤더(예: curl -v)에서 traceparent 또는 X-B3-TraceId가 존재하는지 검증하세요.

## 나의 의견 1
여기에 직접 경험을 적어보세요. 예: 내 환경의 OTel Collector 버전, 처음 실패했던 curl 명령, 샘플링 비율 변경 전·후 트레이스 수치 등.

## 나의 의견 2
여기에 직접 경험을 적어보세요. 예: 로그에서 trace_id가 누락되었던 케이스와 수정 전후 로그 예시, tail_sampling decision_wait 설정 값과 메모리 영향 수치 등.

실무 체크리스트 (즉시 실행 가능)
- [ ] 애플리케이션 로그 포맷에서 trace_id 출력 여부 확인 (로그 경로: /var/log/<app>/*.log)
  - grep "trace_id=" /var/log/<app>/*.log | head
- [ ] 애플리케이션 SDK sampling 설정 확인 (파일/환경변수, 예: OTEL_TRACES_SAMPLER, OTEL_TRACES_SAMPLER_ARG)
- [ ] Collector 설정 파일 경로 확인 및 tail_sampling 존재 여부 확인 (/etc/otel-collector/config.yaml)
- [ ] Jaeger/Zipkin UI에서 orphan span 비율 확인
  - Jaeger: 서비스별 트레이스 수, span 수 통계 비교
- [ ] 네트워크/Exporter 오류 로그 확인 (애플리케이션 로그에서 exporter 에러 메시지 검색)
- [ ] 로그와 트레이스의 타임스탬프 오차 확인 (NTP 상태)
- [ ] 변경 전후 영향 측정: 트레이스 건수, 저장량(GB/day), 비용 추정
- [ ] 재현 테스트: 특정 흐름(예: 오류 발생 시나리오)을 강제로 실행 → 로그+트레이스 비교
- [ ] 문서 링크 확인:
  - Jaeger docs: https://www.jaegertracing.io/docs/
  - OpenTelemetry Collector: https://opentelemetry.io/docs/collector/
  - Tail-based sampling 참고 자료: Collector 문서 내 processors/tail_sampling

마무리: 무엇을 먼저 확인하고 언제 다른 선택을 고려할지
- 먼저 확인할 것: 로그에 trace_id 존재 여부, 샘플링이 어디서 적용되는지(애플리케이션 vs Collector), orphan span 패턴
- 다른 선택이 나은 경우:
  - 빈도 높은 오류 트랜잭션을 잃고 있다면 tail-based sampling을 도입해 보존을 우선시하세요.
  - 로그가 잘 갖춰져 있지 않다면 우선 로그 포맷에 trace_id를 심어 두는 것이 비용 대비 효과가 큽니다.

참고: 구성·명령어·버전은 예시이며, 실제 환경에서는 사용 중인 SDK/Collector/Jaeger 버전을 확인하고 공식 문서를 기준으로 설정하세요. 이미지와 체크리스트를 바탕으로 환경에서 직접 점검해 보시면 관련 이슈를 빠르게 좁혀갈 수 있을 겁니다.

![분산 트레이스 흐름 일러스트](/assets/img/posts/blog/tracing-recover-missing-spans-correlation-procedure/image-1.webp)
이미지 출처: AI 생성 이미지

![샘플링 손실 복원 절차 다이어그램](/assets/img/posts/blog/tracing-recover-missing-spans-correlation-procedure/image-2.webp)
이미지 출처: AI 생성 이미지