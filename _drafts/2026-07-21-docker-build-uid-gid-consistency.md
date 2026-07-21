---
title: "컨테이너 빌드에서 UID/GID 일관화로 파일 권한 문제 예방하기"
description: "컨테이너 이미지 빌드 시 호스트와 UID/GID 일치시키는 전략, Dockerfile ARG·chown·rootless 빌드 비교, 검증 명령과 권한 오류 원인 및 실무 점검 포인트"
slug: "docker-build-uid-gid-consistency"
date: 2026-07-21 10:00:00 +0900
categories: ["Docker", "DevOps"]
tags: ["docker", "dockerfile", "linux", "uid-gid", "권한", "배포자동화"]
image:
  path: /assets/img/posts/blog/docker-build-uid-gid-consistency/preview.png
  alt: "Docker UID/GID 일관화 썸네일"
---

컨테이너 빌드 중에 파일 소유자가 의도치 않게 root(또는 다른 UID/GID)로 바뀌는 것을 방지하려면 **빌드 시점에 UID/GID를 명시적으로 맞추고, 런타임·볼륨 마운트까지 확인하는 절차**가 핵심입니다. 실무에서는 Dockerfile ARG로 빌드 사용자 지정, 이미지 내 파일 권한 최소 권한 원칙 적용, 그리고 마운트 후 파일 소유자·권한 검증을 루틴화하면 문제가 줄어드는 편이었습니다.

로컬에서 도커 이미지 빌드하고 컨테이너에서 잘 동작하는데, 호스트 디렉터리를 바인드 마운트하거나 CI에 올렸을 때 파일 권한 때문에 실패하는 경우가 흔합니다. 저는 그 흐름을 따라가며 왜 권한이 달라지는지, 어디서 체크해야 하는지를 하나씩 확인해봤습니다.

공부하면서 알게 된 점
- Docker 이미지 빌드 과정에서 파일 생성/압축/추출 시 소유자가 보존되거나 root로 바뀌는 동작이 있고, 특히 tar/ADD/COPY가 원하지 않는 소유권을 만들기도 합니다.
- 빌드 환경(로컬, CI, BuildKit, rootless Docker)이나 호스트 파일 시스템(NFS, CIFS, ext4)에 따라 같은 UID라도 동작이 달라질 수 있습니다.
- **이미지 자체의 파일 소유자와 컨테이너가 마운트하는 볼륨의 소유자는 별개**라서 둘을 모두 확인해야 합니다.
- `chown`을 Dockerfile에 자주 넣는 방법이 있지만, 불필요한 chown은 빌드 속도를 크게 떨어뜨리고 일부 환경에서 실패를 야기할 수 있습니다.

처음에는 헷갈렸던 부분
- "이미지 빌드시 만든 파일의 소유자"와 "컨테이너 실행 후 마운트 시 권한"이 동일한 개념인지 헷갈렸습니다. 정리해보니 이미지 내 파일은 이미지의 메타데이터이고, 바인드 마운트는 호스트 파일 시스템의 권한을 그대로 반영합니다.
- tar로 복사할 때 발생하는 "Cannot change ownership" 오류의 원인이 무엇인지, 그리고 이 오류가 무조건 실패가 아닌 경고인지 환경마다 달라서 헷갈렸습니다. (예: rootless 빌드에서는 소유권 변경이 제한됩니다.)
- UID/GID를 고정하는 방법(예: Dockerfile에서 사용자 생성 시 ARG로 전달 vs 컨테이너 런타임에서 사용자 전환) 중 어느 것이 더 안전한지 바로 결론을 내리기 어려웠습니다.

실무에서는 이렇게 확인하면 좋겠다
- 빌드 환경 및 런타임 환경의 Docker 버전과 BuildKit 사용 여부 확인
  - 예: Docker 20.10.12, BuildKit enabled
- 호스트의 사용자/그룹 UID/GID 확인
  - 명령: id -u myuser, id -g myuser
- 이미지 내부 파일 소유자 확인
  - docker run --rm --entrypoint ls image:tag -l /app
- 컨테이너 실행 후 마운트된 볼륨의 소유자 확인
  - docker run --rm -v /host/path:/app --entrypoint sh image:tag -c "ls -ln /app"
- 문제 재현 명령(예시)
  - docker build -t myapp:local --build-arg HOST_UID=1000 --build-arg HOST_GID=1000 .
  - docker run --rm -v $(pwd)/data:/app/data myapp:local sh -c "stat -c '%u:%g %n' /app/data/example.txt"

구체적인 실패 예시와 수정 예시
- 실패 예시: Dockerfile에서 루트로 파일을 복사하고, 런타임에서 비루트 사용자로 실행하려다 권한 문제 발생
{% raw %}
```Dockerfile
FROM ubuntu:22.04
RUN useradd -u 1001 appuser
COPY --chown=appuser:appuser ./app /app
USER appuser
CMD ["./app/start.sh"]
```
```
에러: 컨테이너 밖에서 호스트 디렉터리를 바인드하면 호스트 파일이 root:root라 앱이 쓰기 실패
```
{% endraw %}

위와 같은 상황에서 호스트 UID(예: 1000)와 이미지 내부 UID(1001)가 달라서 발생하는 문제입니다. 수정 방법 중 하나는 빌드 시 호스트 UID/GID를 받아 사용자 생성에 반영하는 것입니다.

- 수정 예시: 빌드 인자 사용
{% raw %}
```Dockerfile
FROM ubuntu:22.04
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN groupadd -g $HOST_GID appgroup \
 && useradd -u $HOST_UID -g $HOST_GID -m appuser
COPY --chown=$HOST_UID:$HOST_GID ./app /app
USER appuser
CMD ["./app/start.sh"]
```
```
빌드: docker build --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) -t myapp:local .
```
{% endraw %}

위 방식은 호스트와 UID/GID를 맞춰서 바인드 마운트 시 권한 충돌을 줄여줍니다. 다만 BuildKit이나 rootless 빌드 환경에서 `--chown`이나 `chown` 동작이 제한될 수 있으니 검증이 필요합니다.

권장 확인 명령과 경로(실무 체크 포인트)
- 환경 정보
  - docker version: docker --version (예: Docker version 20.10.12)
  - buildkit 사용 여부: export DOCKER_BUILDKIT=1 또는 echo $DOCKER_BUILDKIT
- 호스트 정보
  - id -u myuser, id -g myuser
  - stat -c '%U:%G %u:%g' /path/to/file
- 이미지/컨테이너 내부 확인
  - docker run --rm -v /host/dir:/app --entrypoint sh image:tag -c "id -u && id -g && ls -ln /app"
  - docker exec -it <container> sh -c "find /app -maxdepth 2 -printf '%u:%g %p\n'"

비교 표: 접근 방식별 핵심 비교
| 방법 | 장점 | 체크포인트 |
|---|---:|---|
| Dockerfile ARG로 UID/GID 설정 | 호스트와 UID 일치 가능, 런타임 권한 문제 감소 | 빌드 시 ARG 전달, BuildKit/루트리스 영향 확인 |
| 이미지 빌드 후 chown 실행 | 단순함, 이미지 내 권한 보장 | chown 비용 체크, 캐시 효율성 저하 주의 |
| 런타임에서 사용자 맵핑(게스트 사용자 전환) | 이미지 불변 유지, 다양한 호스트 대응 | 진입 스크립트에서 uid/gid 조정 필요 |
| rootless / user namespaces 사용 | 호스트 충돌 최소화 | 환경 지원 여부와 성능 영향 확인 |

공부하면서 만난 오류 메시지 몇 가지와 의미
- "tar: Cannot change ownership to uid 1000: Operation not permitted"  
  - 원인: tar 추출 시 소유권 변경이 시스템에서 허용되지 않을 때 발생. rootless 빌드나 권한이 제한된 환경에서 흔함.
- "chown: changing ownership of '/app': Permission denied"  
  - 원인: chown을 실행할 권한이 없거나 파일 시스템이 소유권 변경을 지원하지 않음(NFS 옵션 등).
- "permission denied" on write to mounted dir  
  - 원인: 호스트 측 소유자가 컨테이너 프로세스의 UID/GID와 맞지 않음.

검증 절차(재현 및 확인)
1. 빌드: DOCKER_BUILDKIT=1 docker build --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) -t myapp:test .
2. 실행(바인드 마운트): docker run --rm -v $(pwd)/data:/app/data myapp:test sh -c "stat -c '%u:%g %n' /app/data/*"
3. 실패 시 로그 수집: docker run --rm -v $(pwd)/data:/app/data myapp:test sh -c "id -u && id -g && ls -l /app/data || true"
4. 호스트 측 확인: ls -ln $(pwd)/data; stat -c '%u:%g %n' $(pwd)/data/*

공부하면서 알게 된 작은 팁들
- Docker의 COPY --chown는 이미지 빌드 속도에 영향을 미치므로 대용량 파일을 다룰 때는 주의가 필요합니다.
- NFS/CIFS 같은 원격 파일 시스템은 UID/GID 매핑을 별도 설정해야 해서 로컬 ext4와 다르게 동작합니다.
- CI에서는 빌드 에이전트의 UID가 고정되어 있지 않을 수 있으니, 빌드 스크립트에서 명시적으로 --build-arg를 넣는 것이 안전한 편입니다.

자주 묻는 질문
Q: Dockerfile에서 항상 --chown을 사용해야 하나요?  
A: 항상 필요한 것은 아닙니다. 소규모 파일이나 빌드 캐시가 중요하지 않다면 편리하지만, 빈번한 chown은 빌드 시간을 늘립니다. **호스트와 UID 매칭이 필요하면 빌드 인자 방식**을 먼저 고려해 보세요.

Q: rootless Docker와 UID/GID 문제는 어떻게 다른가요?  
A: rootless Docker는 컨테이너 프로세스의 내부 UID가 호스트의 다른 UID로 매핑될 수 있어 소유권 변경이 제한될 수 있습니다. 에러 메시지(예: tar나 chown 실패)를 보고 rootless 여부를 의심해 보세요.

Q: NFS에 마운트한 디렉터리를 컨테이너에서 쓰기 가능하게 하려면?  
A: NFS 서버 쪽에서 `anon_uid`, `anon_gid` 또는 idmap 설정을 맞추거나, 컨테이너 사용자 UID와 NFS 매핑을 일치시키는 방법을 사용해야 합니다.

Q: CI에서 빌드 후 테스트가 권한 때문에 실패하면 어디부터 볼까요?  
A: 1) CI 에이전트의 uid/gid, 2) 빌드 로그에서 chown/tar 관련 경고, 3) 테스트가 바인드 마운트하는 경로의 소유자 정보를 순서대로 확인하세요.

나의 의견 1
- 여기에는 본인의 개발 환경(호스트 OS, Docker 버전, CI 종류 중 하나)과 처음 권한 문제를 본 정확한 에러 메시지를 적어보세요.

나의 의견 2
- 여기에 처음 실패했을 때 시도한 명령(예: 사용한 Dockerfile, build 명령)과 수정 후 달라진 로그 일부를 적어보세요.

실무 체크리스트
- [ ] Docker 버전과 BuildKit 사용 여부 확인: docker --version, echo $DOCKER_BUILDKIT
- [ ] 호스트의 UID/GID 확인: id -u <user>, id -g <user>
- [ ] Dockerfile에 ARG로 UID/GID 전달이 필요한지 검토
- [ ] 빌드 후 이미지 내부 파일 소유자 확인: docker run --rm --entrypoint ls image:tag -l /app
- [ ] 바인드 마운트 후 파일 소유자 확인: docker run --rm -v /host/path:/app --entrypoint sh image:tag -c "ls -ln /app"
- [ ] NFS/CIFS 사용 시 서버측 매핑 설정 검토
- [ ] CI 에이전트의 uid/gid 정책 문서화 (예: GitHub Actions runner UID)
- [ ] 권한 관련 실패 로그(예: tar chown 오류) 캡처 및 재현 스크립트 저장

이미지 예시(개념 일러스트)
/assets/img/posts/blog/container-uid-gid-consistency/image-1.webp
이미지 출처: AI 생성 이미지

이미지 예시(검증 절차 다이어그램)
/assets/img/posts/blog/container-uid-gid-consistency/image-2.webp
이미지 출처: AI 생성 이미지

마무리 — 먼저 확인할 것과 다른 선택지를 고려할 때
- 먼저 확인할 것: 빌드 환경(BuildKit/rootless), 호스트의 UID/GID, 바인드 마운트 대상 파일 시스템 타입(NFS/로컬) 세 가지를 우선 점검하세요.  
- 다른 선택지가 나은 경우: 빌드 시간이 중요하고 파일 소유권 변경이 부담이면 런타임에서 사용자 매핑을 하거나, rootless/user-namespace 전략을 고려하는 편이 낫습니다.

참고(공식 문서)
- Dockerfile reference (COPY, ADD): https://docs.docker.com/engine/reference/builder/  
- Docker BuildKit guide: https://docs.docker.com/develop/develop-images/build_enhancements/  
- Rootless Docker: https://docs.docker.com/engine/security/rootless/

필요하면 제가 사용한 예시 Dockerfile과 재현 스크립트를 더 붙여 드릴게요. 추가로 점검해보고 싶은 환경(예: NFS, GitHub Actions runner, 특정 언어 런타임)을 알려주시면 그 환경에 맞춘 체크 절차를 같이 만들어 보겠습니다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.
