---
title: "Docker Compose에서 Healthcheck와 Restart Policy로 서비스 안정화하기"
description: "오늘은 Docker Compose 환경에서 컨테이너의 헬스체크(healthcheck)와 재시작 정책(restart policy)을 이용해 서비스 안정성을 높이는 방법을 정리해봤다"
slug: "docker-compose-health-restart-stabilization"
date: 2026-07-17 12:00:00 +0900
categories: ["Docker", "DevOps"]
tags: ["docker-compose", "healthcheck", "restart-policy", "devops"]
image:
  path: /assets/img/posts/blog/docker-compose-health-restart-stabilization/preview.png
  alt: "Compose 안정화 썸네일"
---

오늘은 Docker Compose 환경에서 컨테이너의 헬스체크(healthcheck)와 재시작 정책(restart policy)을 이용해 서비스 안정성을 높이는 방법을 정리해봤다. 저는 아직 배우는 중인 초보 개발자라서, 실제로 설정해보고 실패한 경험도 있고 문서들을 뒤적이며 하나씩 이해해가는 과정이었다. 이 글은 제가 공부하면서 정리한 핵심 개념, 처음에 헷갈렸던 부분, 실무에서 바로 확인하면 좋은 점들을 중심으로 적었다.

짧게 요약하면:
- **Healthcheck는 컨테이너 내부 서비스의 상태를 검사하는 신호**로, 단순한 프로세스가 살아있는지 여부보다 서비스 레벨(예: HTTP 응답, DB 접속 등)을 보는 데 유용하다.
- **Restart policy는 컨테이너가 중단될 때 Docker가 어떻게 재시작할지 결정**하며, Healthcheck 결과와 조합하면 보다 안정적으로 서비스 복구가 가능하다.
- 실무에서는 헬스체크 명세(명령, 타임아웃, 재시도 등)와 로그/메트릭 기반 확인 절차를 **반드시 점검**하는 편이 안전하다.

간단한 그림으로 개념을 떠올려봤다.

![간단한 컨테이너 헬스체크 일러스트](/assets/img/posts/blog/docker-compose-health-restart-stabilization/image-1.webp)
이미지 출처: AI 생성 이미지

## 공부하면서 알게 된 점

1. 헬스체크는 단순 프로세스 살아있음(ping)이 아니라 서비스 응답을 기준으로 설계하는 게 더 의미가 있다.
   - 예: 웹 서버라면 로컬에서 curl로 루트 엔드포인트를 확인하거나, DB라면 간단한 쿼리를 실행해보는 식.
2. Docker Compose 파일에서 healthcheck와 restart를 함께 쓰면 **Docker가 컨테이너 실패를 감지하고 재시도하는 흐름을 자동화**할 수 있다.
3. Docker 자체의 재시작 정책만으로 모든 상황을 커버하기 어렵고, 애플리케이션 내부의 graceful shutdown/health endpoint 구현이 필요하다.
4. 너무 공격적인 헬스체크(짧은 interval과 낮은 retries)는 과도한 재시작·알람을 유발할 수 있다. **간격과 타임아웃은 서비스 특성에 맞게 조정**해야 한다.

## 처음에는 헷갈렸던 부분

- "헬스체크가 실패하면 바로 컨테이너가 재시작되는가?"  
  -> 꼭 그렇지는 않았다. 헬스체크 실패는 컨테이너의 상태를 'unhealthy'로 표시하고, 어떤 도구가 이 상태를 관찰해 재시작을 유발할 수 있다. Docker 엔진 자체의 restart 정책은 컨테이너 프로세스가 exit(종료)했을 때 동작하는 경우가 많다. 그래서 헬스체크 실패만으로 자동 재시작이 되지 않도록 기본 동작을 이해하는 게 중요했다.

- "restart: always와 unless-stopped의 차이"  
  -> 둘은 비슷하지만 시스템 재부팅 이후 동작이나 사용자가 중지했을 때의 동작 차이가 있다. 실제로는 운영 시에 어느 상황에서 자동으로 켜지길 원하는지에 따라 선택하면 된다.

## 예제: docker-compose.yml에 healthcheck와 restart 적용하기

아래는 nginx와 간단한 app 컨테이너(예: HTTP 서비스)의 예시다.

```yaml
version: "3.8"
services:
  web:
    image: nginx:stable
    ports:
      - "80:80"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    restart: on-failure

  api:
    build: ./api
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"]
      interval: 15s
      timeout: 3s
      retries: 5
      start_period: 20s
    restart: unless-stopped
```

설명:
- test: 어떤 명령을 실행해 성공/실패를 판단할지.
- interval: 검사 간격.
- timeout: 검사 명령이 응답해야 하는 시간.
- retries: 실패 허용 횟수(이 횟수 이상이면 unhealthy).
- start_period: 컨테이너 시작 직후 안정화 시간을 주기 위해 검사 시작을 지연.

## Docker 명령으로 상태 확인하기 (실무 점검 절차)

실무에서 문제가 생겼을 때 빠르게 상태를 파악하려면 다음 명령들이 유용했다.

- 실행 중 컨테이너 확인
  - docker ps
- 헬스 상태 간단 확인
  - docker ps --filter "health=unhealthy"
- 특정 컨테이너 헬스 정보 상세 확인
  - docker inspect --format='{{json .State.Health}}' <컨테이너명>
- 로그 확인
  - docker-compose logs -f <서비스명>
  - docker logs --since 10m <컨테이너명>
- 이벤트로 재시작 원인 추적
  - docker events --filter container=<컨테이너명>

예시로 health 상태를 JSON으로 확인하는 명령:

```bash
docker inspect --format='{{json .State.Health}}' myproject_web_1 | jq
```

이걸로 최근 체크 타임스탬프나 failing reason 등을 볼 수 있다.

![docker compose와 재시작 정책을 나타낸 개념도](/assets/img/posts/blog/docker-compose-health-restart-stabilization/image-2.webp)
이미지 출처: AI 생성 이미지

## 헬스체크와 재시작 정책 비교 표

아래 표는 자주 쓰는 restart 정책을 간단히 비교한 것이다.

| Policy | 동작 요약 | 언제 쓰면 좋을까 |
|---|---:|---|
| no | 재시작하지 않음 | 임시 작업, 수동 제어 시 |
| on-failure | 프로세스가 비정상 종료(exit != 0) 시 재시작 | 프로세스 크래시가 주요 실패 원인일 때 |
| unless-stopped | 사용자가 중지하지 않았다면 항상 재시작 | 시스템 재부팅 후 자동 복구 원할 때 |
| always | 항상 재시작 | 항상 켜져 있어야 하는 서비스(주의 필요) |

**중요**: 헬스체크 실패가 곧 재시작으로 이어지는 것은 아니므로, 헬스체크 + 재시작 흐름을 설계할 때는 두 부분을 모두 고려해야 한다.

## 실무에서는 이렇게 확인하면 좋겠다

- 헬스체크 설계
  - 서비스 수준(예: HTTP 200, DB 쿼리 성공)으로 검사 명령을 작성한다.
  - **start_period**를 사용해 초기 과도기 상태를 허용한다.
  - interval/timeout/retries 값을 서비스 특성(응답 시간, 가비지 컬렉션 등)에 맞춰 조정한다.
- 모니터링과 알람
  - 헬스체크 unhealthy 이벤트가 발생하면 로그와 메트릭(예: Prometheus)에 알람을 걸어 수동 개입 가능토록 하자.
- 자동 복구 전략
  - 컨테이너 프로세스가 비정상 종료되어야 자동 재시작이 일어나는 경우가 있으니, 헬스체크 실패 시 프로세스를 종료하게 하는 wrapper script를 도입할지 고려할 수 있다(예: 헬스 실패 시 exit 1).
- 로그와 이벤트 추적
  - docker events나 orchestration(예: Kubernetes/Swarm)을 쓴다면 해당 플랫폼의 이벤트도 함께 확인하자.
- 로컬과 CI환경 차이
  - 로컬에서는 짧은 interval로 테스트해도 되지만, 실운영에서는 네트워크/디스크 IO 등을 고려해 보수적으로 설정하자.

## 코드 예제: 헬스 실패 시 프로세스 종료(간단한 wrapper)

아래는 컨테이너 내부에서 주기적으로 헬스 체크를 하고 실패하면 종료하는 간단한 스크립트 예제다. 이 방법은 헬스 실패를 Docker의 restart 정책으로 이어지게 한다.

```bash
#!/bin/bash
# /usr/local/bin/health-monitor.sh
set -e

FAIL_COUNT=0
MAX_FAIL=3

while true; do
  if curl -sf http://localhost:8080/health >/dev/null; then
    FAIL_COUNT=0
  else
    ((FAIL_COUNT++))
    echo "$(date) healthcheck failed $FAIL_COUNT/$MAX_FAIL"
  fi

  if [ "$FAIL_COUNT" -ge "$MAX_FAIL" ]; then
    echo "Exiting container to trigger restart"
    exit 1
  fi

  sleep 10
done
```

Dockerfile에서 이 스크립트를 background로 띄우거나 엔트리포인트에서 관리하면 된다. 다만 이 방식은 프로세스 종료에 따른 데이터 정합성과 부하를 고려해야 한다.

## 자주 묻는 질문

Q: 헬스체크 실패만으로 컨테이너가 자동 재시작되게 하려면?  
A: Docker 자체는 헬스체크 실패만으로 재시작을 하진 않는 것으로 기본 동작을 이해하는 편이 안전하다. 두 가지 방법이 있다: (1) 헬스 체크 실패 시 프로세스를 종료하게 하는 wrapper를 사용하거나 (2) 외부 모니터(Orchestrator, 스크립트)가 Docker API를 호출해 재시작한다.

Q: restart: always와 unless-stopped 중 무엇을 골라야 할까?  
A: 시스템 재부팅 후에도 무조건 켜지길 원하면 always, 사용자가 중지한 상태에서는 재시작하지 않길 원하면 unless-stopped가 적절하다. 운영 정책과 재해 복구 전략에 따라 선택하자.

Q: 헬스체크 간격과 retries 값은 어떻게 정하나?  
A: 서비스의 평균 응답 시간, GC나 초기화 시 발생하는 지연, 네트워크 변동성을 고려해 넉넉히 잡는 편이 안전하다. 예: 빠른 HTTP 서비스는 interval 15~30s, timeout 2~5s, retries 3~5 정도를 시작점으로 삼고 실험해 조정한다.

Q: Docker Compose v2/v3에서 헬스체크 차이 있나?  
A: 헬스체크 기본 필드와 동작은 동일하지만 Compose 파일 버전마다 지원 범위가 다르니 사용하는 Compose 스펙 문서를 확인하자.

Q: 헬스체크가 자주 실패하는데 원인 추적 팁은?  
A: docker inspect로 Health.Log를 확인하고, 애플리케이션 로그(특히 startup/GC/DB 연결 문제)를 함께 보면 원인 찾기가 빨라진다.

## 실무 체크리스트

- [ ] 헬스체크 명령이 서비스 수준(HTTP/DB 등)을 검증하도록 작성했는가?
- [ ] interval/timeout/retries/start_period 값을 서비스 특성에 맞게 설정했는가?
- [ ] 로그와 이벤트( docker events, docker inspect .State.Health )로 문제 원인 추적 방법을 마련했는가?
- [ ] 헬스체크 실패 시 자동 재시작이 필요한 경우, 프로세스 종료 또는 외부 모니터링을 통해 재시작 흐름을 구현했는가?
- [ ] 재시작 정책(restart)을 서비스 중요도와 운영 정책에 맞게 선택했는가?
- [ ] 테스트 환경(로컬/CI)과 운영 환경의 설정 차이를 문서화했는가?

마무리하며: 제가 실제로 여러 번 설정을 바꿔가며 확인해보니, 헬스체크와 재시작 정책은 단순한 옵션이 아니라 운영 안정성의 중요한 축이었습니다. 다만 무조건 많은 체크를 넣는 것이 답은 아니더군요. 서비스 특성에 맞게 **적절한 검사, 관찰, 그리고 복구 흐름**을 만들면 운영 부담을 많이 줄일 수 있었습니다. 혹시 여러분이 겪은 헬스체크 관련 사례나, 비교해보고 싶은 상황(예: 데이터베이스, 캐시, 외부 API 등)이 있으면 이어서 물어보세요. 같이 더 깊게 살펴볼게요.