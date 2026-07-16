---
title: "대규모 트래픽 환경에서 분산 트레이싱 샘플링 정책 설계하기"
slug: "distributed-tracing-sampling-policy-high-traffic"
date: 2026-07-16 12:00:00 +0900
categories: ["Observability", "DevOps"]
tags: ["distributed-tracing", "sampling", "observability", "opentelemetry", "jaeger"]
image:
  path: /assets/img/posts/blog/distributed-tracing-sampling-policy-high-traffic/preview.png
  alt: "분산 트레이싱 샘플링 썸네일"
---

오늘의 주제

대규모 트래픽 환경에서 로그·지연 영향 없이 분산 트레이싱 샘플링 정책 설계하기

들어가며

최근 분산 시스템을 다루면서 트레이싱 데이터가 빠르게 늘어나는 문제를 직접 경험했습니다. 샘플링을 적절히 설계하지 않으면 저장 비용과 네트워크·CPU 부담이 커지고, 경우에 따라 애플리케이션 응답성에 영향을 줄 수도 있다는 인상을 받았어요. 이 글은 제가 공부하면서 정리한 내용과 실무에서 확인해 보면 좋을 포인트들을 중심으로, 초보자 입장에서 차근차근 정리한 것입니다. 완전한 정답을 제시하려는 건 아니고, 여러 옵션을 비교하며 실무에 바로 적용해볼 수 있는 점검 항목 위주로 작성합니다.

핵심 개념 요약 (간단)

- Head-based sampling: 애플리케이션(또는 SDK)이 트레이스 시점에 샘플을 결정합니다. 낮은 지연과 단순한 구현이 장점이나, 전체적인 오류나 희귀 이벤트 포착률이 낮을 수 있습니다.
- Tail-based sampling: 수집기(collector)나 뒤단 시스템에서 전체 트레이스를 본 뒤 샘플을 결정합니다. 더 정확한 이벤트 기반 샘플링이 가능하지만, 추가 버퍼링과 계산 자원이 필요합니다.
- Adaptive / Rate-limiting 샘플링: 시간이나 리소스 기준으로 동적으로 샘플 비율을 조정합니다.
- 사업·운영 목적에 맞는 샘플링 정책을 명확히: 오류 조사, SLA 모니터링, 성능 프로파일링 등 목적에 따라 샘플링 전략이 달라집니다.

공부하면서 알게 된 점

- 트레이스의 "스팬 수"와 "트레이스 수"를 혼동하기 쉬웠습니다. 샘플링은 보통 트레이스(한 요청 흐름) 단위로 결정하는 것이 바람직하고, 단일 트레이스 내 스팬 개수는 서비스 아키텍처에 크게 좌우됩니다. 따라서 수집량 예측은 "평균 스팬/트레이스 × 트레이스/sec"로 하면 실제 저장량을 더 현실적으로 추정할 수 있었습니다.
- head-based는 간단하지만 단일 서비스의 랜덤 샘플링으로는 분산된 오류 시나리오(여러 서비스 콜이 함께 실패)를 포착하기 어렵습니다. 반면 tail-based는 비정상 흐름(예: 높은 지연, 오류 발생 트레이스)을 골라낼 수 있어 디버깅에 유리했습니다.
- tail-based를 사용하면 수집기(collector)에 충분한 메모리·버퍼와 처리량이 필요합니다. 수집기 부하가 병목이 되면 전체 시스템의 관측성이 떨어질 수 있다는 것을 체감했습니다.
- 샘플링 정책을 코드에 하드코딩하면 변경이 어려워 실무에서 운영성이 떨어집니다. 중앙 수집기에서 정책을 관리하거나, Feature Flag/Config 서버를 통해 동적으로 조정하는 편이 실무에선 더 편합니다.

처음에는 헷갈렸던 부분

- "왜 로그와 트레이스 샘플링을 분리해야 하는가" — 초기엔 같은 기준으로 처리하려 했는데, 로그는 고빈도·저비용 저장 형태(예: 로그 집계, 압축)에 유리하고 트레이스는 구조화된 대관계 데이터를 포함해서 샘플링 중요도가 다르다는 점을 깨달았습니다. 실무에서는 중요한 오류 로그는 모두 남기고, 정상 트래픽의 트레이스만 샘플링하는 식으로 분리하는 경우가 많았습니다.
- head vs tail 혼용 시의 트레이스 일관성 문제 — 일부 서비스에서 head-based로 이미 드롭된 트레이스는 뒤단에서 복구가 불가능합니다. 따라서 혼용 시 샘플 결정의 일관성을 설계할 필요가 있었습니다(예: 모든 서비스에서 동일한 probability sampler 사용하거나, 중요한 트레이스는 헤더로 우선 표시).
- 샘플링 결정이 로그와 연동되는 방식 — trace id가 로그에 남아 있어야 샘플링된 트레이스와 로그를 연결할 수 있는데, 로그 수집에서 trace id를 제거하지 않도록 주의해야 합니다.

구체적인 구성 예시와 코드(간단)

1) 애플리케이션에서 head-based 확률 샘플러 예 (Node.js, OpenTelemetry)

```js
// 간단 예시: 프로바이더에 확률 샘플러 설정
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/core');

const sampler = new ParentBasedSampler({
  root: new TraceIdRatioBasedSampler(0.01) // 1% 샘플
});

const provider = new NodeTracerProvider({ sampler });
// exporter, instrumentation 등 초기화...
provider.register();
```

2) OpenTelemetry Collector에서 tail-based 샘플링(예시 YAML)

```yaml
processors:
  tail_sampling:
    policies:
      - name: error-policy
        type: tail_sampling
        config:
          decision_wait: 30s
          max_traces_per_second: 100
          # 조건 예: 오류가 포함된 트레이스 우선 채택
          selectors:
            - match:
                attribute:
                  - key: http.status_code
                    op: ge
                    value: 500
  memory_limiter:
    # Collector 안정성용
    check_interval: 1s
    limit_mib: 1024
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling]
      exporters: [jaeger, otlpout]
```

(구현체에 따라 구성 키가 다를 수 있으니 공식 문서 참고가 필요합니다.)

실무에서 확인하면 좋은 포인트

- 예측 지표 설정: 평균 스팬/트레이스, 트레이스/sec, 현재 저장되는 트레이스/sec, 샘플링 비율(서비스별) 등을 메트릭으로 수집해 대시보드로 모니터링하세요. 샘플링 정책 변경 후 즉시 반영되는지 확인합니다.
- Collector 자원 사용량: tail-based를 쓰면 collector 메모리, CPU, 네트워크 사용량이 증가할 수 있습니다. docker stats / top / ps / kubectl top 등을 통해 관찰하세요.
  - Docker 예: docker ps, docker stats <container>, docker logs <container>
  - Systemd 예: sudo systemctl status otel-collector && sudo journalctl -u otel-collector -f
  - Linux 체크 예: top, htop, iostat -x 1, vmstat 1
- 네트워크 병목: OTLP/Jaeger UDP/TCP 포트가 포화되지 않았는지 확인(ss -tunlp 또는 netstat -tunlp).
  - 예: sudo ss -tunlp | grep 4317
- 지연 영향 측정: 샘플링 로직이 애플리케이션 트레이싱 경로에 들어가면 p95 응답시간에 영향을 주는지 A/B 테스트로 체크합니다. 부하 도구로 기존과 샘플러 적용 후 비교해보는 것이 안전합니다.
- 손실률 및 대표성 검증: 샘플링 후에도 오류 트레이스가 충분히 보이는지(특히 tail-based에서는 decision_wait 내에 오류가 잡히는지) 로그-트레이스 연계를 통해 검증합니다. 몇 가지 케이스를 의도적으로 발생시켜 샘플링 동작을 확인하세요.
- 추적 ID 전파와 로그 연결: 모든 서비스에서 trace id를 로그 포맷(예: JSON)으로 남기는지 확인합니다. 그래야 샘플링된 트레이스와 로그가 연계됩니다.
- 저장소와 비용: 샘플링 비율을 바꿀 때 스토리지 비용 추계가 어떻게 변하는지 계산해야 합니다. 예측값은 "샘플링 비율 × 평균 스팬/트레이스 × 트레이스/sec × 샘플 보존기간"으로 근사할 수 있습니다.

운영용 점검 절차 예시 (명령어 중심)

- Collector 프로세스 정상 여부 확인
  - docker: docker ps --filter name=otel-collector
  - logs: docker logs -f otel-collector
  - systemd: sudo systemctl status otel-collector && sudo journalctl -u otel-collector -n 200
- 포트/리스너 확인: sudo ss -tunlp | grep 4317
- 리소스 사용 확인: docker stats otel-collector 또는 top/htop
- 디스크 I/O 확인: iostat -x 1 5
- 트레이스 유입량 측정(예시: Prometheus 메트릭이나 Jaeger/Collector 자체 metric)
  - traces_received_total, traces_sent_total, sampling_decisions_total 등 확인
- 샘플링 정책 적용 확인: 변경된 설정이 collector에 반영되었는지 config 파일/ConfigMap 또는 환경변수 확인

주의할 점들 (조심스럽게)

- tail-based 샘플링은 디테일한 분석에 유리하지만, decision_wait 때문에 전체 지연이 늘어나거나 collector 메모리 요구가 커질 수 있습니다. 무조건 tail을 선택하기보다는 목적과 리소스를 고려해 결정하는 편이 좋습니다.
- 샘플링 정책을 바꿀 때 기존 데이터와의 비교가 어려워질 수 있습니다. 변경 시점과 정책을 메타데이터로 남기고, 비교 분석을 위한 버전 관리를 도입하면 도움이 됩니다.
- 샘플링이 과도하면 희귀한 버그를 놓칠 수 있고, 너무 적으면 비용이 과다해집니다. 여러 수준(서비스별, 엔드포인트별, 오류 우선 등)을 섞어 적용해보는 것이 현실적입니다.

실무에서는 이렇게 확인하면 좋겠다

- A/B 실험으로 샘플러 성능 영향 측정: 프로덕션 일부 트래픽에만 적용해 P95 응답시간, CPU, 메모리, 네트워크 사용량, 그리고 디버깅 케이스 수(오류 추적 가능성)를 비교합니다.
- 정책 변경 전/후 메타데이터 기록: 누가, 언제, 어떤 정책을 변경했는지 기록(예: git config, configmap change history). 나중에 문제 원인 추적에 도움이 됩니다.
- 기본 정책 + 예외 룰: 대부분 요청은 확률 샘플링(예: 0.1~1%)으로 처리하되, 오류, 중요 사용자, 특정 경로 등은 항상 샘플링하도록 예외 규칙을 둡니다.
- 비용 감시와 경보 설정: 트레이스 유입량, 스토리지 사용량, 샘플링 비율 급변에 대한 알림을 설정합니다.
- 테스트 케이스 자동화: 테스트 환경에서 다양한 트래픽 패턴(정상, 에러 폭주, 지연 폭주)을 시뮬레이션해 샘플링 정책의 동작을 검증합니다.

예시: Docker Compose로 간단한 Jaeger + OTEL Collector (운영용 아님, 테스트 목적)

```yaml
version: '3.7'
services:
  jaeger:
    image: jaegertracing/all-in-one:1.41
    ports:
      - "16686:16686"
      - "14268:14268"
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.80.0
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317" # OTLP gRPC
```

실무 체크리스트 (마지막에 정리)

- 목적 파악: 트레이싱을 하는 목적(디버깅, SLA 모니터링, 성능 분석 등)을 문서화했는가?
- 샘플링 전략 선택: 서비스별로 head/tail/혼합 중 어떤 전략을 쓸지 정했는가?
- 예외 규칙 정의: 오류/특정 사용자/중요 엔드포인트에 대한 예외 규칙을 만들었는가?
- 리소스 산정: Collector 메모리/CPU, 네트워크, 스토리지 필요량을 계산했는가?
- 모니터링 지표: traces/sec, avg spans/trace, sampling_ratio_by_service 등을 대시보드에 추가했는가?
- 변경 기록: 샘플링 정책 변경은 버전 관리나 감사 로그로 남기는가?
- 테스트: 샘플링 정책 변경을 부분 트래픽 A/B로 검증했는가?
- 로그-트레이스 연계: 모든 서비스 로그에 trace id가 일관되게 남도록 했는가?
- 경보: 트레이스 유입 급감/급증, collector 메모리/디스크 경고에 대한 알림을 설정했는가?

마무리 — 느낀 점과 다음 계획

샘플링은 비용과 문제 탐지력을 절충하는 작업이라서 "완벽한" 설정은 없다고 느꼈습니다. 중요한 건 목적을 정하고 적절한 레이어(애플리케이션 / 수집기)에 정책을 두며, 정책 변경이 실시간으로 어떤 영향을 주는지 측정 가능한 상태를 만드는 것 같아요. 다음에는 특정 서비스 유형(예: 긴 체인 호출 vs 단일 호출)별로 권장 샘플링 값 범위를 실험해 기록해보려고 합니다.

## 관련 이미지 주제

1. 분산 트레이싱 샘플링의 head vs tail 비교를 단순한 화살표와 박스로 표현한 개념도 한 장  
2. 샘플링 정책 레이어(애플리케이션, Collector, 저장소)와 데이터 흐름을 도식화한 단순한 일러스트 한 장

실무 체크리스트 (요약 재표기)

- 목적 문서화
- 전략 선택(서비스별)
- 예외 규칙 정의
- Collector/스토리지 리소스 계산
- 모니터링 지표 대시보드 적용
- 정책 변경 이력 관리
- A/B 테스트로 영향 검증
- 로그에 trace id 포함 확인
- 경보 설정

끝으로, 제가 정리한 내용은 공부하면서 모아본 실무 지침입니다. 환경과 요구에 따라 다르게 적용될 수 있으니, 자신만의 안전한 검증 절차를 두고 점진적으로 정책을 적용해 보시길 권합니다.