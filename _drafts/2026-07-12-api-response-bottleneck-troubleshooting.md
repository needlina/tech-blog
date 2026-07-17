---
title: "API 응답 지연 원인 찾기: 단계별 병목 진단 가이드"
description: "들어가며 — 왜 단계별로 접근할까 제가 최근에 API 응답 지연 문제를 처음 겪었을 때, 어디서부터 확인해야 할지 혼란스러웠습니다. 로그를 막 뒤적이고, DB 쿼리를 의심하고, 서버 재시작을 시도하곤 했는데 결국 원인을 정확히 못 찾았던 경험이 있습니다"
slug: "api-response-bottleneck-troubleshooting"
date: 2026-07-12 09:00:00 +0900
categories: [Backend, Observability]
tags: ["api-performance", "observability", "병목진단", "장애대응", "backend"]
image:
  path: /assets/img/posts/blog/api-response-bottleneck-troubleshooting/image-1.webp
  alt: "API 요청-응답 과정과 주요 병목 지점을 단순 아이콘으로 보여주는 일러스트"
---

들어가며 — 왜 단계별로 접근할까 제가 최근에 API 응답 지연 문제를 처음 겪었을 때, 어디서부터 확인해야 할지 혼란스러웠습니다. 로그를 막 뒤적이고, DB 쿼리를 의심하고, 서버 재시작을 시도하곤 했는데 결국 원인을 정확히 못 찾았던 경험이 있습니다


API 응답 속도가 느릴 때 병목을 찾는 단계별 접근

들어가며 — 왜 단계별로 접근할까
제가 최근에 API 응답 지연 문제를 처음 겪었을 때, 어디서부터 확인해야 할지 혼란스러웠습니다. 로그를 막 뒤적이고, DB 쿼리를 의심하고, 서버 재시작을 시도하곤 했는데 결국 원인을 정확히 못 찾았던 경험이 있습니다. 그래서 여러 자료를 보며 단계적으로 검증하는 방법을 정리해봤습니다. 완벽한 정답은 아닐 수 있지만, 실무에서 먼저 확인해볼 포인트들을 실용적으로 모아봤습니다.

![API 요청-응답 과정과 주요 병목 지점을 단순 아이콘으로 보여주는 일러스트](/assets/img/posts/blog/api-response-bottleneck-troubleshooting/image-1.webp)
이미지 출처: AI 생성 이미지

무엇을 목표로 할까
- "응답 지연"이 발생했을 때 빠르게 병목을 좁히는 것
- 재현 가능한 테스트로 원인 후보를 검증하는 것
- 실무에서 바로 사용할 수 있는 명령어/설정/점검 절차 제공

공부하면서 알게 된 점
- 응답 지연은 한 계층(네트워크, 로드밸런서, 앱, DB, 외부 API, 리소스 제약)에서만 발생한다고 단정하기 어렵습니다. 여러 계층이 겹쳐 나타나는 경우가 많았습니다.
- 로그·메트릭·트레이스(분산 추적)를 함께 보면 원인 파악 속도가 크게 빨라졌습니다.
- 간단한 부하 테스트로 재현하면 문제 범위를 좁히는 데 큰 도움이 됩니다.

처음에는 헷갈렸던 부분
- "응답 시간이 긴 요청"인지, "처리율(throughput) 한계"인지 구분하는 것이 초반에 헷갈렸습니다. 응답 시간은 개별 요청의 지연, 처리율은 동시성 증가 시 성능 저하를 뜻합니다. 둘을 구분해야 대응이 달라지더군요.
- 네트워크인지 애플리케이션인지 DB인지 모를 때, 어느 지표를 먼저 보는지도 혼란스러웠습니다. 저는 크게는 (1) 클라이언트/네트워크 (2) 프록시/로드밸런서 (3) 앱 서버 (4) DB/외부 API 순으로 점검하는 게 실용적이라고 느꼈습니다.

단계별 점검 흐름 (초보자가 따라하기 쉽게)
1) 사용자 관점 확인 (빠른 체크)
- 특정 클라이언트/지역에서만 느린지, 전체인지 확인
- curl로 간단히 응답 시간 확인
  - 예: curl -s -w "%{time_total}s\n" -o /dev/null https://api.example.com/endpoint
  - 출력된 time_total을 기본 지표로 삼습니다.
- 브라우저에서 네트워크 패널로 확인 (요청/응답 헤더, 타이밍)
  - DNS 조회, TCP 핸드쉐이크, TLS, Wait(Time To First Byte) 등을 보면 네트워크 vs 서버 문제 대략 구분 가능

2) 네트워크 레벨 점검
- ping / traceroute / mtr로 라우팅/지연 확인
  - ping api.example.com
  - traceroute api.example.com
- 포트 연결 확인: ss 또는 nc
  - ss -tnlp | grep :80
  - nc -vz api.example.com 443
- 로드밸런서/프록시(예: Nginx, HAProxy) 로그와 상태 확인
  - Nginx의 경우 access.log, error.log, stub_status (설정 예시는 아래)
  - 간단한 Nginx stub_status 설정 예시:
    ```
    location /nginx_status {
      stub_status on;
      allow 127.0.0.1;
      deny all;
    }
    ```
  - status에서 Active connections, accepts, handled, requests 값을 보면 연결 병목 여부를 추정할 수 있습니다.

3) 애플리케이션 서버 레벨 점검
- 서버 리소스 확인: CPU, 메모리, I/O, 네트워크
  - top, htop, free -m, vmstat 1 5, iostat -xz 1 3
- 프로세스별 리소스 확인
  - ps aux --sort=-%cpu | head
- 컨테이너 환경이라면
  - docker stats <container> 또는 kubectl top pod
  - docker logs, kubectl logs로 에러/타임아웃 확인
- 스레드/이벤트 루프/큐 대기 확인
  - JVM 기반: jstack, jstat, jcmd로 스레드 상태·GC 확인
  - Node.js: event loop lag 체크 (process.hrtime 기반 스크립트) 또는 clinic 도구
- 간단한 부하 테스트로 이상 증상 재현
  - hey 사용 예:
    ```
    hey -n 1000 -c 50 https://api.example.com/endpoint
    ```
  - latency 분포, 실패율(5xx) 확인

4) DB 및 외부 API 점검
- DB 쿼리 지연 확인 (예: PostgreSQL)
  - 현재 실행중인 쿼리
    ```
    SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
    FROM pg_stat_activity
    WHERE state <> 'idle'
    ORDER BY duration DESC;
    ```
  - 느린 쿼리를 EXPLAIN ANALYZE로 분석
    ```
    EXPLAIN ANALYZE SELECT ...;
    ```
  - pg_stat_statements가 있다면 빈도/총시간 상위 쿼리 확인
- 인덱스·계획 변경 여부 의심
  - 통계(ANALYZE)가 오래되어 플랜이 안 좋은 경우가 있음: ANALYZE 또는 autovacuum 상태 확인
- 외부 API 의존성
  - 외부 호출이 느리면 전체 응답 지연 유발. 타임아웃·리트라이 정책, 비동기 처리 고려

5) 분산 추적·메트릭·로그의 활용
- 트레이스(예: OpenTelemetry, Jaeger)로 요청 흐름 추적하면 어느 서비스/구간에서 시간 소요되는지 정확하게 보입니다.
- 메트릭(Prometheus)에서 p50/p95/p99 latency, error rate, concurrent requests 추이를 확인
- 로그에서 특정 요청 ID로 end-to-end 추적하면 추가적인 단서 확보 가능

중간 심화: 예시 명령 모음 (운영 관점)
- 시스템 리소스
  - free -m
  - vmstat 1 5
  - iostat -xz 1 3
  - ss -s
- 프로세스/컨테이너
  - ps aux --sort=-%mem | head
  - docker ps && docker stats
  - kubectl top pod -n mynamespace
- 네트워크
  - ss -tnlp
  - ip -s link
- DB(Postgres)
  - SELECT * FROM pg_stat_activity WHERE state <> 'idle';
  - EXPLAIN ANALYZE ...
  - SELECT * FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;
- 간단 부하 테스트
  - hey -n 500 -c 20 https://host/api

![분산 추적과 메트릭 차트, 로그가 함께 표시된 단순화된 대시보드 일러스트](/assets/img/posts/blog/api-response-bottleneck-troubleshooting/image-2.webp)
이미지 출처: AI 생성 이미지

실무에서는 이렇게 확인하면 좋겠다 (우선순위 중심)
- 1순위: 고객에게 영향 있는 범위 먼저 판별
  - 특정 엔드포인트만 느린가? 전체 서비스인가? 특정 리전/클라이언트인가?
- 2순위: 간단한 지표로 빠르게 좁히기
  - time_to_first_byte, time_total, 에러율, 동시 연결 수
- 3순위: 재현 가능한 부하 테스트로 증상 재현
  - 재현이 안 되면 운영 환경 메타데이터(트래픽 패턴, 인증 토큰, 유저 세션 등) 차이가 있는지 확인
- 4순위: 트레이스/메트릭으로 병목 구간 확정
  - p95/p99 값을 우선 보며, 스팬별 지연 시간 확인
- 5순위: 원인 대응(캐시 추가, 쿼리 튜닝, 리소스 증설, 비동기화, 타임아웃/리트라이 정책 조정)

작고 유용한 팁들
- 타임아웃/리트라이 정책이 잘못되어 있으면 오히려 장애를 악화시킬 수 있으므로 기본값을 신중히 설정하세요.
- 로그에 요청 ID를 항상 함께 남기면 문제 추적이 훨씬 쉬워집니다.
- 배포 직후 성능 회귀를 막으려면 간단한 부하 테스트 스모크를 파이프라인에 넣는 게 도움이 됩니다.
- p99 지연은 고객 경험에 큰 영향을 줍니다. 평균보다 고위 퍼센타일을 모니터링하세요.

예시: 느린 DB 쿼리 잡기 (PostgreSQL)
- 느린 쿼리 찾기
  ```
  -- 실행 중 오래된 쿼리 보기
  SELECT pid, now() - query_start AS duration, query
  FROM pg_stat_activity
  WHERE state = 'active' AND now() - query_start > interval '2 seconds';
  ```
- EXPLAIN ANALYZE 결과로 인덱스/시퀀스 확인
  ```
  EXPLAIN ANALYZE SELECT a.* FROM orders a WHERE a.user_id = 123 ORDER BY a.created_at DESC LIMIT 10;
  ```
- 인덱스가 필요하면
  ```
  CREATE INDEX CONCURRENTLY idx_orders_user_created ON orders (user_id, created_at DESC);
  ```

주의사항 (틀릴 가능성 있는 부분은 조심스럽게)
- 여기 적은 방법들이 모든 상황에 맞는 해답은 아닙니다. 환경(언어, 프레임워크, 인프라)에 따라 측정 방법과 우선순위가 달라질 수 있습니다.
- 리소스 증설은 임시방편이 될 수 있으므로 원인 분석 없이 단순 증설은 비용만 늘릴 위험이 있습니다.

실무 체크리스트
- [ ] 고객 영향 범위(엔드포인트/리전/클라이언트) 파악
- [ ] 간단한 curl/브라우저 네트워크 타이밍으로 기본 확인
- [ ] 네트워크(라우팅, 포트)와 로드밸런서 상태 확인
- [ ] 서버 리소스(CPU, 메모리, I/O) 체크
- [ ] 애플리케이션 로그에서 오류/타임아웃 패턴 확인
- [ ] 부하 테스트로 증상 재현(hey/wrk)
- [ ] 트레이싱으로 스팬별 지연 확인
- [ ] 데이터베이스 slow query / EXPLAIN ANALYZE 확인
- [ ] 타임아웃/리트라이 정책 검토
- [ ] 변경(쿼리 튜닝, 캐시, 리팩토링, 리소스 조정) 후 회귀 테스트

마치며
이 글은 제가 공부하며 정리한 '먼저 확인하면 실무에서 도움이 되는' 절차 모음입니다. 문제에 따라 추가 도구나 깊은 프로파일링이 필요할 수 있으니, 여기서 소개한 단계들을 기반으로 점차 자신의 체크리스트를 만들어가면 좋겠습니다. 혹시 더 궁금하거나 직접 겪으신 사례가 있으면 함께 이야기해보면 좋겠습니다.