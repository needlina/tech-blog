---
title: "서비스 장애를 빠르게 발견하는 기본 모니터링 지표와 실무 점검법"
slug: "basic-monitoring-metrics-for-quick-incident-detection"
date: 2026-07-11 10:00:00 +0900
categories: [Observability, DevOps]
tags: [monitoring, observability, metrics, devops, alerting]
image:
  path: /assets/img/posts/blog/basic-monitoring-metrics-for-quick-incident-detection/image-1.png
  alt: "서비스 장애로 로그와 모니터링 대시보드를 확인하는 화면의 개념도"
---

오늘의 주제

서비스 장애를 빨리 파악하기 위한 기본 모니터링 지표

서투른 초보 개발자로서 관측(Observability)과 모니터링을 공부하면서, "어떤 지표를 먼저 봐야 빠르게 이상을 감지할 수 있을까" 하는 질문이 자주 들었습니다. 이 글에서는 제가 공부하면서 정리한 기본 지표들, 처음에 헷갈렸던 점, 그리고 실무에서 장애가 의심될 때 빠르게 확인할 수 있는 절차들을 가능한 쉽게 정리해보려 합니다. 틀릴 수 있는 부분은 제가 이해한 범위 내에서 조심스럽게 적겠습니다.

![서비스 장애로 로그와 모니터링 대시보드를 확인하는 화면의 개념도](/assets/img/posts/blog/basic-monitoring-metrics-for-quick-incident-detection/image-1.png)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점
- 빠른 이상 감지는 보통 4가지 축에서 시작하면 좋았습니다: latency(지연), error rate(오류율), traffic(트래픽/요청량), saturation(리소스 포화). 이를 약자로 L, E, T, S라고 부르는 경우도 있더군요.
- 메트릭과 로그, 트레이스는 서로 보완적이라는 점을 더 분명히 알게 되었습니다. 예컨대 error rate이 올랐을 때 로그로 원인을 좁히고, 트레이스로 병목이 어느 서비스인지 확인하는 흐름이 유용했습니다.
- 단일 숫자(CPU 90% 등)를 그대로 임계치로 쓰기보다, 평상시 패턴과의 비교(비율 변화, 급격한 상승)를 보는 게 더 안전했습니다.

기본으로 볼 메트릭(요약)
1. Latency (응답 시간)
   - p50, p95, p99 같은 백분위(latency percentiles)를 봅니다. p95까지는 보통 사용자 경험에 직접 영향이 큽니다.
   - 예시 PromQL:
     ```promql
     histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
     ```
   - 실무 포인트: p95가 평상시보다 갑자기 치솟았는지, 그리고 어떤 엔드포인트에서 발생하는지 먼저 확인합니다.

2. Error rate (오류율)
   - HTTP 5xx, 내부 예외 비율, 실패율(예: 요청 대비 실패 수) 등을 모니터링합니다.
   - 예시 PromQL:
     ```promql
     sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
     ```
   - 실무 포인트: 에러가 특정 서비스/버전/호스트에 집중되어 있는지 태그(라벨)로 분해해서 봅니다.

3. Traffic (트래픽)
   - 요청 수(RPS), 동시 세션 수, 큐 길이 등을 확인합니다.
   - 급격한 트래픽 증가가 지연과 에러의 원인일 수 있습니다.

4. Saturation (포화)
   - CPU, 메모리, 디스크 I/O, 네트워크 대역, DB 연결 수 등 리소스 포화를 봅니다.
   - 예: DB max_connections 접근, 큐 소비율 감소 등은 보통 saturation 신호입니다.

처음에는 헷갈렸던 부분
- p95 vs p99: 처음엔 무조건 p99만 보면 안전하다고 생각했는데, p99는 이상치(Outlier)에 민감해서 노이즈가 많더군요. 서비스 특성에 따라 p95가 더 의미 있을 때가 있고, p99는 심각한 소수의 사용자 영향을 볼 때 주로 씁니다.
- CPU 90%가 항상 문제인가?: 아니었습니다. 배치 처리 서버는 CPU가 항상 높은 게 정상일 수 있습니다. "상대적 변화"와 "서비스 유형"을 고려해야 했습니다.
- Alert 임계치는 단순 숫자보다 "연속성"을 봐야: 짧게 튀는 spike에 바로 알림이 오면 알람 피로도가 올라갑니다. 그래서 보통 5~10분 이상 연속 지속되는 조건을 쓰는 편이었습니다.

실무에서 빠르게 확인하는 절차(제가 정리한 기본 플레이북)
아래는 장애 의심 시 제가 따라 해보려는 우선순위 절차입니다. 환경마다 다르니 상황에 맞게 조절해야 합니다.

1) 전반적 증상 파악
   - 사용자 신고/알림(alert) 확인
   - 어떤 지표가 이상한지(L, E, T, S 중 무엇) 식별

2) 서비스 레벨 상태 확인 (인프라/컨테이너)
   - Linux 기본 확인 (원격 접속 후)
     ```bash
     # 시스템 로드/프로세스
     top -b -n 1 | head -n 20
     ps aux --sort=-%cpu | head

     # 디스크
     df -h

     # IO 확인 (iostat가 설치되어 있다면)
     iostat -x 1 3

     # 네트워크 포트 상태
     ss -tulpen | head
     ```
   - systemd 서비스 확인
     ```bash
     systemctl status myapp.service
     journalctl -u myapp.service --since "10 minutes ago" --no-pager
     ```

   - Docker 환경
     ```bash
     docker ps
     docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
     docker logs --tail 200 mycontainer
     ```
   - Kubernetes 환경
     ```bash
     kubectl get pods -n mynamespace
     kubectl top pod -n mynamespace
     kubectl logs deployment/my-deployment -n mynamespace --tail=200
     kubectl describe pod <pod-name> -n mynamespace
     ```

3) 애플리케이션 레벨 빠른 확인
   - 애플리케이션 로그에서 에러 패턴 검색 (예: 최근 10분간 ERROR)
     ```bash
     # 단순 예시 (grep 사용)
     journalctl -u myapp.service --since "10 minutes ago" | grep -i error
     ```
   - 외부 의존성(데이터베이스, 캐시, 메시지 큐) 상태 확인
     - PostgreSQL 예시:
       ```bash
       # 접속 체크
       pg_isready -h db.example.com -p 5432

       # 동시 연결, 대기 쿼리 확인 (psql 접속 필요)
       psql -h db.example.com -U myuser -d mydb -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"
       psql -h db.example.com -U myuser -d mydb -c "SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY duration DESC LIMIT 10;"
       ```
     - Redis: PING, INFO command 확인
       ```bash
       redis-cli -h cache.example.com PING
       redis-cli -h cache.example.com INFO memory
       ```

4) 메트릭 세부 조회 (Prometheus/Grafana 사용 가정)
   - Latency 패널에서 특정 엔드포인트 필터링 (예: route="/api/v1/orders")
   - Error rate을 서비스/버전/호스트로 분해
   - 예시 PromQL(특정 라벨로 분해하는 패턴):
     ```promql
     sum by (instance, job) (rate(http_requests_total{status=~"5..", job="my-service"}[5m]))
     ```
   - 알람이 떴다면 해당 알람의 증상(라벨)을 따라 어느 호스트/컨테이너/버전인지 좁힙니다.

알림(Alert) 설계 예시(간단)
- 짧은 순간의 spike로 인한 불필요 알람을 줄이기 위해 연속 조건과 복수 샘플을 사용합니다. 예시 Prometheus alert rule:
  ```yaml
  groups:
  - name: app.rules
    rules:
    - alert: HighErrorRate
      expr: |
        sum(rate(http_requests_total{job="my-service", status=~"5.."}[5m])) 
        / sum(rate(http_requests_total{job="my-service"}[5m])) > 0.02
      for: 10m
      labels:
        severity: page
      annotations:
        summary: "High error rate for my-service ({{ $labels.job }})"
        description: "Error rate > 2% for more than 10 minutes"
  ```
- 실무 포인트: severity를 나누고(정보/warn/page), 알람 수신 채널별로 라우팅하는 것이 좋습니다.

![대시보드의 주요 지표(latency, error rate, cpu, db connections)를 확인하는 흐름도](/assets/img/posts/blog/basic-monitoring-metrics-for-quick-incident-detection/image-2.png)
이미지 출처: AI 생성 이미지

실무에서는 이렇게 확인하면 좋겠다
- 초기에 문제를 좁힐 때는 "서비스 경계"를 먼저 확인합니다. 즉, 사용자 → CDN/로드밸런서 → API 게이트웨이 → 서비스 → DB 순으로 어느 레이어에서 이상이 시작됐는지 확인합니다.
- 로그에서 아무것도 나오지 않으면 네트워크(로드밸런서, 보안그룹, 라우팅)나 컨테이너/VM 시작 문제일 확률이 있습니다.
- DB 포화(연결수, 느린 쿼리)로 인한 서비스 장애는 트래픽은 정상인데 latency와 error가 같이 올라가는 경우가 많습니다. 이때는 pg_stat_activity, slow query log, DB 모니터링 패널을 바로 확인합니다.
- 알람은 노이즈를 줄이도록 설정하세요. 예: 에러율 0.5%에서 바로 page를 띄우지 말고, 지속 시간/상태(아웃라이어 제외) 기반으로 구성합니다.
- 평상시에는 주요 지표(위 4가지)를 1-2분 간격으로 수집하고, 알람 조건은 더 완만하게(예: 5~10분 연속)를 쓰는 게 일반적입니다.

추가로 제가 정리해본 간단한 트러블슈팅 우선순위(예시)
1. 전체 서비스가 모두 다운: 인프라(예: 로드밸런서, DNS, 네트워크) 먼저 확인
2. 일부 요청만 실패: 특정 엔드포인트/버전/호스트로 분해
3. 성능 저하(지연): p95/p99 확인 → CPU/메모리/IO/DB 확인
4. 점진적 에러 증가: 최신 배포나 구성 변경 체크

주의사항(제가 헷갈렸던 점이라 조심히 쓰는 부분)
- 수집 지연: 메트릭 수집 주기와 알람 평가 주기가 상황 인식에 영향을 줍니다. "메트릭이 올라갔는데 알람이 늦게 왔다"는 경우는 보통 수집/스크래핑 주기 때문일 수 있습니다.
- 샘플링: 트레이스는 모든 요청을 샘플링하지 않으면 특정 이슈를 놓칠 수 있습니다. 샘플링 정책을 잘 설계해야 합니다.

실무 체크리스트
- [ ] 알람 수신(이메일/슬랙/PagerDuty 등) 확인: 누가 받을지 라우팅 확인
- [ ] 문제 유형 식별: L, E, T, S 중 어느 축인지 적어두기
- [ ] 관련 로그(서비스/로드밸런서/DB) 최근 10~30분 추이 확인
- [ ] 리소스 포화 점검: CPU, 메모리, 디스크 I/O, 네트워크, DB connections
- [ ] 컨테이너/포드 상태 확인: 재시작/CrashLoopBackOff 여부
- [ ] 배포/구성 변경 이력 확인: 최근 배포가 문제인지 확인
- [ ] 임시 완화 조치 고려: 트래픽 셰이핑, 롤백, 캐시 비율 조정 등
- [ ] 사후 조사(RCA)용으로 타임라인과 스크린샷/메트릭 덤프 저장

마무리하면서
제가 정리한 내용은 개인적으로 공부하면서 시도해본 기본 흐름과 실무에서 제안받은 팁을 섞은 것입니다. 환경에 따라 우선순위와 지표는 달라질 수 있으니, 팀의 서비스 특성에 맞게 메트릭과 알람을 튜닝해보시길 권합니다. 제가 놓친 부분이나 더 좋은 방법을 알고 계시면 알려주시면 감사하겠습니다.