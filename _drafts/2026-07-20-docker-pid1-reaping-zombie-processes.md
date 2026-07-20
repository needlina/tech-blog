---
title: "Docker 컨테이너에서 PID 1 부재로 인한 좀비 프로세스 해결 절차"
description: "컨테이너에서 부모가 바로 종료될 때 생기는 좀비 프로세스 원인·재현 명령·점검 명령·해결 옵션(--init, tini, dumb-init, 직접 처리)과 Dockerfile/실행 예시 및 검증 절차 정리"
slug: "docker-pid1-reaping-zombie-processes"
date: 2026-07-20 12:00:00 +0900
categories: ["Docker", "DevOps"]
tags: ["docker", "pid-1", "zombie-process", "컨테이너", "장애대응"]
image:
  path: /assets/img/posts/blog/docker-pid1-reaping-zombie-processes/preview.png
  alt: "컨테이너 PID 1 좀비 문제 썸네일"
---

컨테이너에서 PID 1이 제대로 부모 역할을 못 해 좀비 프로세스가 쌓일 때, **원인(시그널/좀비 수거 미동작), 재현/점검 명령, 빠른 대처(--init), Dockerfile 수정(tini/dumb-init) 순서로 확인**하면 비교적 빨리 안정화할 수 있습니다.

제가 로컬에서 컨테이너를 띄웠을 때 몇 시간 지나면 프로세스 목록에 defunct(좀비)가 보이는 상황을 겪으면서 이 주제를 정리하게 됐습니다. 처음엔 "컨테이너는 프로세스 격리인데 왜 좀비가 생기지?" 하고 헷갈렸고, 실무에서 빠르게 확인해야 할 포인트들을 중심으로 차근차근 살펴봤습니다. 아래는 그 과정에서 정리한 절차와 예시, 실무 체크포인트입니다.

왜 PID 1이 문제인가?
- Unix 계열에서 PID 1(최초 프로세스)은 좀비 프로세스의 상태를 수거(reap)하는 특별한 책임이 있습니다.
- 컨테이너에서 앱이 자식 프로세스를 생성하고 부모가 먼저 종료되면, 부모의 역할을 대신할 프로세스가 없어 자식은 좀비(Z) 상태로 남을 수 있습니다.
- 일반 Linux 환경에서는 init(systemd 등)이 이 역할을 하지만, 컨테이너에서 애플리케이션이 직접 PID 1으로 실행될 때 이 기능이 빠지는 경우가 많습니다.

공부하면서 알게 된 점
- 단순히 "애플리케이션이 버그"라기보다 **PID 1의 시그널/종료 처리 특성 차이**가 주된 원인인 경우가 자주 있었습니다.
- Docker는 --init 옵션을 통해 간단히 작은 init 프로세스(tini)를 넣어줄 수 있고, Dockerfile에서도 직접 tini를 설치해 사용할 수 있습니다.
- 일부 언어 런타임(예: Go)은 기본으로 자식 프로세스 관리/시그널 전달을 잘 하지만, 쉘 스크립트나 일부 애플리케이션은 그렇지 않을 수 있습니다.

처음에는 헷갈렸던 부분
- "좀비"와 "고아(orphan)"의 차이: 좀비는 자식의 종료 상태가 수거되지 않아 남아 있는 프로세스(프로세스 테이블 소비), 고아는 부모가 없어진 프로세스(보통 init이 입양).
- 컨테이너 내에서 "init이 없다"는 건 반드시 systemd가 없어야만 생기는 문제가 아니라, PID 1으로 실행되는 프로세스가 수거 로직을 구현하지 않으면 동일하게 발생합니다.

실무에서는 이렇게 확인하면 좋겠다 (핵심 점검 순서)
1. 문제 재현/관찰(짧게): 컨테이너에서 ps로 Z 상태 확인
   - ps 출력에서 STAT 컬럼이 Z 또는 <defunct> 확인
   - 명령 예시:
```bash
ps -eo pid,ppid,stat,cmd | grep -E ' Z |<defunct>'
```
2. 어떤 프로세스가 PID 1인지 확인
{% raw %}
```bash
docker inspect --format '{{.State.Pid}}' <container>   # 호스트 PID 확인
```
{% endraw %}
   - 또는 컨테이너 내부에서 `ps -o pid,ppid,stat,cmd -p 1` 실행
3. 재현용 예시(로컬로 쉽게 실험)
- 실패 예시: 부모가 바로 종료되며 자식을 배경으로 남기는 스크립트
```bash
# fail.sh
#!/bin/sh
sleep 1 &
# 부모가 즉시 종료 -> 자식은 좀비가 될 수 있음
exit 0
```
Dockerfile (문제 상황):
```Dockerfile
FROM alpine:3.18
COPY fail.sh /fail.sh
RUN chmod +x /fail.sh
CMD ["/fail.sh"]
```
이 이미지를 띄우고 몇 초 후 `docker exec`로 ps를 보면 좀비가 생길 수 있습니다.

수정 예시 (빠른 해결): docker run --init 사용
```bash
docker build -t demo-fail .
docker run --rm --init demo-fail
```
--init는 Docker가 경량 init(tini)를 PID 1로 띄워 앱의 시그널 전달과 좀비 수거를 대신해줍니다.

Dockerfile에서 직접 tini 사용하기 (권장 패턴)
```Dockerfile
FROM alpine:3.18
RUN apk add --no-cache tini
COPY fail.sh /fail.sh
RUN chmod +x /fail.sh
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/fail.sh"]
```

옵션 비교 표: 언제 어느 방법을 쓰면 좋을지
| 방법 | 장점 | 단점 | 사용 시점 |
|---|---:|---|---|
| --init (docker run) | 즉시 적용, 설정 간단 | 런타임 옵션 필요, CI 등에서 빠짐 주의 | 빠른 테스트/개발 |
| tini (Dockerfile) | 이미지 단위로 일관성 | 이미지 변경 필요 | 프로덕션 이미지 권장 |
| dumb-init | 시그널 처리에 약간의 차이 | 별도 설치/검증 필요 | 특정 시그널 정책 필요할 때 |
| 애플리케이션 내 처리 | 외부 의존 없음 | 직접 구현 필요, 버그 위험 | 앱에서 직접 관리 가능할 때 |

코드 예시: 실패 vs 수정 (좀 더 현실적)
- 실패 예시(백그라운드 작업을 띄우고 부모 종료):
```bash
# worker.sh
#!/bin/sh
# background로 자식 실행
(sleep 300) &
echo "child started"
exit 0
```
- 수정 예시(적절한 신호 처리 및 wait 사용 — 앱 수준에서 고치기)
```bash
# worker-fixed.sh
#!/bin/sh
trap 'echo received TERM; kill -TERM $child 2>/dev/null; wait' TERM INT
sleep 300 &
child=$!
wait $child
```
이렇게 하면 부모가 종료 신호를 받아 자식을 정리 후 종료합니다. 단, 앱 로직을 바꾸는 건 영향범위가 크므로 신중히 검토해야 합니다.

실무에서 꼭 확인할 포인트(검증 명령/경로)
- 컨테이너 내부에서 좀비 확인:
```bash
docker exec -it <container> sh -c "ps -eo pid,ppid,stat,cmd | grep Z || true"
```
- 호스트에서 프로세스 트리 확인:
```bash
ps -ef --forest | less
pstree -p  # 설치 필요
```
- 컨테이너의 루트 프로세스(PID 1)확인:
```bash
docker exec -it <container> sh -c "ps -p 1 -o pid,cmd,stat"
```
- 컨테이너가 호스트 PID 네임스페이스 사용 중인지 확인:
{% raw %}
```bash
docker inspect --format '{{.HostConfig.PidMode}}' <container>
```
{% endraw %}

에러/증상과 원인/조치 표 (실무 판단용)
| 증상 | 원인 추정 | 즉시 조치 |
|---|---|---|
| ps에 defunct 다수 | PID 1이 좀비 수거 못함 | --init로 테스트, 컨테이너 재시작 후 확인 |
| 컨테이너 메모리 누수 | 좀비가 많아 테이블 소비 | ps로 Z 확인, 재시작 또는 init 도입 |
| 신호 무시(TERM 시그널 무반응) | 앱이 SIGTERM 무시 | 앱에 신호 핸들링 추가 또는 init 사용 |

공부하면서 겪은 시행착오
- 저는 초반에 단순히 "앱이 포그라운드로 돌아가게 하면 된다"라고만 생각했는데, 실제론 시그널 전달 방식과 부모-자식 관계의 종료 순서가 핵심이었습니다.
- --init로 문제 해결이 되는 경우가 많아서, 우선 빠르게 (--init)로 검증하고 이미지 수준에서 tini를 도입하는 게 안전하다는 점을 체감했습니다.

실무 적용 시 권장 절차 (작업 순서)
1. 재현/관찰: ps로 Z 체크, 문제 컨테이너 식별
2. 임시 대응: docker run --init 또는 컨테이너 재시작으로 완화
3. 원인 분석: 어떤 프로세스가 PID 1인지, 어떤 자식이 defunct인지 로그/ps로 확인
4. 영구 조치: 이미지에 tini 추가 또는 앱에 신호 처리 로직 추가
5. 검증: 장시간(예: 24시간) 모니터링, 메트릭(프로세스 수, 프로세스 테이블 사용량) 관찰

## Q&A
Q: --init과 tini 중 뭐를 먼저 써야 하나요?
A: 빠른 확인은 --init(런타임 옵션), 장기적/프로덕션은 이미지 레벨에서 tini를 설치하는 것이 보통 권장됩니다.

Q: Kubernetes 환경에서는 어떻게 적용하나요?
A: Kubernetes는 컨테이너 런타임이 제공하는 init이 기본 적용되지 않는 경우가 있어, Dockerfile에 ENTRYPOINT로 tini를 넣거나, Pod spec에 lifecycle hook으로 앱을 제어하는 방법을 씁니다. (클러스터 환경에 따라 데몬셋/런타임 차이 존재)

Q: 이미 프로덕션에서 좀비가 쌓이면 어떻게 신속 복구하나요?
A: 우선 해당 컨테이너를 재시작하거나 롤링 재배포로 복구하고, 원인 분석 후 이미지에 init 도입 또는 앱 수정 절차를 진행하세요.

Q: PID 1 관련 Docker inspect 출력에 {{.State.Pid}}가 있는데요 어떻게 해석하나요?
A: 그 값은 호스트에서의 PID로, 컨테이너 내부의 PID 1과 호스트 프로세스 매핑을 확인할 때 사용합니다.

## 나의 의견 1
여기에 직접 겪은 환경(OS/도커 버전/애플리케이션 런타임 등)과 실제 처음 실패한 명령, 그리고 수정 후의 ps 출력 변화(예: 좀비 수 5 → 0)를 적어보세요.

## 나의 의견 2
여기에 적용 후 장기 모니터링 결과(예: 24시간 후 프로세스 수 변화, 재발 생기면 어떤 증상인지)를 기록해 보세요.

이미지: 컨테이너 PID 구조를 단순화한 개념도
/ assets/img/posts/blog/docker-pid1-zombie-reaping/image-1.webp
이미지 출처: AI 생성 이미지

이미지: init 프로세스(tini) 흐름도 간단 일러스트
/ assets/img/posts/blog/docker-pid1-zombie-reaping/image-2.webp
이미지 출처: AI 생성 이미지

실무 체크리스트
- 확인 명령
  - 컨테이너 내부 좀비 확인: docker exec <c> ps -eo pid,ppid,stat,cmd | grep Z
  - 컨테이너 PID 1 확인: docker exec <c> ps -p 1 -o pid,cmd,stat
  - 호스트에서 컨테이너의 호스트 PID 확인:
{% raw %}
```bash
docker inspect --format '{{.State.Pid}}' <container>
```
{% endraw %}
  - 프로세스 트리: ps -ef --forest / pstree -p
- 적용 명령(임시)
  - docker run --init --rm -it <image>
- 적용 명령(영구)
  - Dockerfile에 tini 추가: apk/apt로 tini 설치 후 ENTRYPOINT로 사용
- 파일/경로 확인
  - Dockerfile, ENTRYPOINT/CMD 스크립트(신호 처리 여부)
  - 컨테이너 로그(종료 시그널 관련 로그)
- 버전/환경 체크
  - Docker Engine 버전 확인: docker version (권장: 20.10+에서 --init 동작 확인)
  - 이미지 베이스(Alpine, Debian 등)와 설치 가능한 tini 버전(예: tini v0.18.0 이상 권장)
- 재현/검증
  - 문제 재현 스크립트로 테스트: fail.sh 같은 간단한 스크립트로 Z 상태 유무 확인
  - 변경 전/후 비교: ps 출력, 컨테이너 Uptime, 메트릭(프로세스 수)
- 공식 문서 확인 경로
  - Docker run reference (init 옵션 관련) 및 tini 프로젝트 페이지(설치/사용법)
- 모니터링 목표
  - 장시간(예: 24시간) 프로세스 Z 수 0 유지
  - 재배포 후 1주일간 재발률 0% 또는 기준치 이하

마지막으로 정리하자면, 이 주제에서는 **먼저 컨테이너 내부에서 PID 1이 무엇인지와 Z 상태를 빠르게 확인**하는 것이 우선이고, 빠른 완화는 --init, 영구 적용은 이미지 레벨(tini) 또는 앱 레벨의 신호 처리를 고려하는 것이 일반적입니다. 어떤 선택이 더 나은지는 운영 환경(배포 방식, 이미지 수정 가능성, 시그널 정책)에 따라 달라질 수 있으니, 위 체크리스트로 우선 검증해 보시길 권합니다.