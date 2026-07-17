---
title: "Docker 컨테이너 실행 오류 Permission Denied와 No space left on device 해결 방법"
description: "Docker 컨테이너 실행 중 permission denied 또는 No space left on device 에러가 날 때 권한과 디스크 용량을 순서대로 확인하는 방법을 정리했습니다."
slug: "docker-permission-denied-no-space-left-device"
date: 2026-07-15 11:20:00 +0900
categories: [Docker, DevOps]
tags: [docker, permission-denied, disk-space, container, devops]
image:
  path: /assets/img/posts/blog/docker-permission-denied-no-space-left-device/preview.png
  alt: "Docker 컨테이너 실행 오류 Permission Denied와 No space left on device 해결 방법 썸네일"
---

Docker 컨테이너 실행 중 `permission denied` 또는 `No space left on device` 에러가 날 때는 권한과 디스크 용량을 함께 확인해야 합니다. 이 글은 원인을 나눠 보고 빠르게 점검하는 순서를 정리합니다.

Docker 컨테이너 실행 중 `permission denied` 또는 `No space left on device` 에러가 날 때 권한과 디스크 용량을 순서대로 확인하는 방법

Docker를 쓰다 보면 컨테이너가 뜨지 않거나, 빌드는 되는데 실행 단계에서 갑자기 실패하는 경우가 있습니다. 로그를 보면 권한 문제처럼 보이기도 하고, 디스크 용량 문제처럼 보이기도 합니다.

예를 들면 아래 같은 메시지를 만날 수 있습니다.

```text
docker: Error response from daemon: oci runtime error: container process invoked permission denied
```

또는 파일 복사, 이미지 빌드, 볼륨 쓰기 과정에서 아래처럼 나올 수 있습니다.

```text
failed to copy files: error: No space left on device
```

처음에는 두 에러가 완전히 다른 문제라고 생각했는데, 실제로는 둘 다 "컨테이너가 필요한 파일을 읽거나 쓰지 못하는 상태"라는 점에서 같이 점검할 필요가 있었습니다. 이번 글에서는 Docker 초보 입장에서 권한과 용량 문제를 나눠서 확인하는 순서를 정리해보겠습니다.

![Docker 컨테이너가 파일 권한과 디스크 용량 두 갈래 문제를 만나는 단순한 장애 흐름 일러스트.](/assets/img/posts/blog/docker-permission-denied-no-space-left-device/image-1.webp)
이미지 출처: AI 생성 이미지

## 증상 정리

자주 보이는 증상은 아래와 같습니다.

- 컨테이너 시작 직후 `permission denied`로 종료된다.
- Dockerfile의 `COPY`, `RUN`, `ENTRYPOINT` 단계에서 실패한다.
- bind mount한 디렉터리에 애플리케이션이 파일을 쓰지 못한다.
- 이미지 빌드 중 `No space left on device`가 발생한다.
- `docker pull` 또는 `docker compose up` 중 디스크 부족 메시지가 나온다.
- 로그 파일, 캐시, 오래된 이미지가 쌓여 Docker 디스크가 가득 찬다.

중요한 것은 에러 메시지만 보고 바로 `chmod 777`이나 `docker system prune -a`를 실행하지 않는 것입니다. 둘 다 빠른 해결처럼 보일 수 있지만, 권한을 너무 넓게 열거나 필요한 이미지를 지워서 다른 문제가 생길 수 있습니다.

## 공부하면서 알게 된 점

Docker 권한 문제는 크게 세 가지로 나눠볼 수 있었습니다.

첫 번째는 컨테이너 안에서 실행되는 사용자의 권한 문제입니다. 이미지가 root가 아닌 사용자로 실행되는데 실행 파일에 execute 권한이 없거나, 작업 디렉터리에 쓰기 권한이 없으면 실패할 수 있습니다.

두 번째는 호스트와 컨테이너 사이의 bind mount 권한 문제입니다. 호스트의 디렉터리를 컨테이너에 연결하면 호스트의 UID/GID와 permission이 그대로 영향을 줍니다.

세 번째는 Docker 데몬이나 보안 정책 문제입니다. SELinux, AppArmor, Windows/WSL 파일 공유 설정, Docker Desktop의 파일 공유 경로 같은 레이어가 접근을 막을 수 있습니다.

디스크 용량 문제도 단순히 `df -h`만 보면 부족했습니다. 호스트 루트 디스크는 여유가 있어도 Docker data root가 있는 파티션만 꽉 찼을 수 있고, inode가 부족해서 파일을 더 만들지 못하는 경우도 있습니다.

## 1단계: 에러가 권한인지 용량인지 먼저 분리

먼저 로그를 그대로 확보합니다.

```bash
docker compose up
docker logs <container-name>
docker inspect <container-name>
```

빌드 중이라면 빌드 로그를 자세히 봅니다.

```bash
docker build --progress=plain -t my-app .
```

권한 문제는 보통 아래 단어가 보입니다.

```text
permission denied
operation not permitted
exec format error
cannot execute
```

용량 문제는 아래 표현이 직접적으로 나옵니다.

```text
No space left on device
failed to copy files
write failed
ENOSPC
```

둘이 같이 나오는 경우도 있습니다. 예를 들어 컨테이너가 로그 파일을 쓰지 못해서 권한 에러처럼 보였는데, 실제로는 디스크가 가득 차서 쓰기가 실패한 경우도 있을 수 있습니다.

## 2단계: Permission denied 확인 순서

실행 파일 권한부터 확인합니다. 특히 entrypoint 스크립트가 있는 이미지에서 자주 발생합니다.

```bash
ls -l entrypoint.sh
```

실행 권한이 없다면 Dockerfile에서 명시적으로 부여합니다.

```dockerfile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

Windows에서 만든 shell script라면 줄바꿈 문제도 같이 볼 수 있습니다. CRLF가 섞이면 리눅스 컨테이너에서 이상한 실행 오류가 날 수 있습니다.

```bash
file entrypoint.sh
```

필요하면 LF로 변환합니다.

```bash
dos2unix entrypoint.sh
```

`USER`를 지정한 이미지라면 해당 사용자가 작업 디렉터리에 쓸 수 있는지 확인합니다.

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app

CMD ["npm", "start"]
```

핵심은 `USER app`으로 바꾸기 전에 필요한 디렉터리 소유권을 맞춰두는 것입니다.

## 3단계: bind mount 권한 확인

docker compose에서 호스트 디렉터리를 컨테이너에 연결했다면 권한을 꼭 확인합니다.

```yaml
services:
  app:
    image: my-app
    volumes:
      - ./data:/app/data
```

호스트에서 소유권과 권한을 봅니다.

```bash
ls -ln ./data
stat ./data
```

컨테이너 안에서도 똑같이 확인합니다.

```bash
docker exec -it <container-name> sh
id
ls -ln /app/data
touch /app/data/test.txt
```

여기서 `id`로 나온 UID/GID가 `/app/data`에 쓸 수 있어야 합니다. 권한을 해결하는 방법은 여러 가지가 있지만, 저는 우선 UID/GID를 맞추는 방향을 선호합니다.

```yaml
services:
  app:
    image: my-app
    user: "1000:1000"
    volumes:
      - ./data:/app/data
```

또는 호스트 디렉터리 소유권을 조정합니다.

```bash
sudo chown -R 1000:1000 ./data
```

다만 운영 서버에서 무작정 `chown -R`을 실행하면 영향 범위가 클 수 있으니 대상 경로를 정확히 확인해야 합니다.

## 4단계: SELinux와 Docker Desktop 환경 확인

Linux에서 SELinux가 Enforcing이면 일반 권한이 맞아도 컨테이너 접근이 막힐 수 있습니다.

```bash
getenforce
ls -Z ./data
journalctl -k | grep -i avc
```

SELinux 환경에서는 compose volume에 `:z` 또는 `:Z` 옵션이 필요할 수 있습니다.

```yaml
services:
  app:
    volumes:
      - ./data:/app/data:Z
```

단, `:z`와 `:Z`는 SELinux label을 바꾸는 옵션이라 공유 범위를 이해하고 써야 합니다.

Docker Desktop이나 WSL에서는 파일 공유 경로 문제도 확인합니다. Windows 경로, WSL 경로, Docker Desktop의 파일 공유 설정이 섞이면 리눅스 서버와 다르게 동작할 수 있습니다.

## 5단계: No space left on device 확인 순서

디스크 부족이 보이면 먼저 전체 용량을 봅니다.

```bash
df -h
```

inode 부족도 확인합니다.

```bash
df -i
```

Docker가 실제로 어디에 데이터를 쌓는지도 봅니다.

```bash
docker info | grep -i "Docker Root Dir"
docker system df
```

`docker system df`는 이미지, 컨테이너, 로컬 볼륨, 빌드 캐시가 각각 얼마나 쓰는지 보여줘서 원인을 나누는 데 좋았습니다.

```text
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          20        5         12GB      8GB
Containers      8         2         1GB       900MB
Local Volumes   10        4         15GB      7GB
Build Cache     50        0         6GB       6GB
```

여기서 reclaimable이 크다고 해서 바로 모두 지우기보다는 무엇이 필요한지 확인해야 합니다.

![이미지, 컨테이너, 볼륨, 빌드 캐시가 Docker 디스크 공간을 나눠 쓰는 구조를 보여주는 개념도.](/assets/img/posts/blog/docker-permission-denied-no-space-left-device/image-2.webp)
이미지 출처: AI 생성 이미지

## 6단계: 안전하게 Docker 용량 정리하기

멈춘 컨테이너만 먼저 정리합니다.

```bash
docker container prune
```

사용하지 않는 이미지 정리:

```bash
docker image prune
```

빌드 캐시 정리:

```bash
docker builder prune
```

네트워크 정리:

```bash
docker network prune
```

정말 전체적으로 사용하지 않는 리소스를 정리해야 할 때만 아래 명령을 고려합니다.

```bash
docker system prune
```

볼륨까지 지우는 명령은 더 조심해야 합니다.

```bash
docker system prune --volumes
```

볼륨에는 DB 데이터, 업로드 파일, 개발 데이터가 들어 있을 수 있습니다. 그래서 운영 환경에서는 `docker volume ls`, `docker volume inspect`로 확인한 뒤 삭제해야 합니다.

```bash
docker volume ls
docker volume inspect <volume-name>
```

## 7단계: 로그와 캐시가 계속 쌓이는지 확인

디스크를 정리했는데 금방 다시 가득 찬다면 로그나 캐시가 계속 쌓이는지 봐야 합니다.

컨테이너 로그 크기 확인:

{% raw %}
```bash
docker inspect <container-name> --format='{{.LogPath}}'
sudo du -h <log-path>
```
{% endraw %}

로그 회전을 설정하지 않으면 json-file 로그가 매우 커질 수 있습니다. Docker daemon 설정에서 제한을 둘 수 있습니다.

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

설정 변경 후에는 Docker 데몬 재시작이 필요할 수 있습니다.

```bash
sudo systemctl restart docker
```

Compose 단위로도 logging 옵션을 둘 수 있습니다.

```yaml
services:
  app:
    image: my-app
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

## 처음에는 헷갈렸던 부분

저는 `No space left on device`가 나오면 항상 디스크 용량만 부족한 줄 알았습니다. 그런데 inode가 부족해도 같은 계열의 문제가 생길 수 있고, Docker Desktop에서는 내부 VM 디스크가 꽉 찬 것일 수도 있었습니다.

또 `permission denied`를 보면 `chmod 777`로 바로 해결하려고 했는데, 이 방식은 보안상 좋지 않고 원인을 숨길 수 있습니다. 실제로는 실행 파일 권한, UID/GID, bind mount, SELinux label, Docker Desktop 파일 공유 설정을 나눠서 보는 편이 더 안전했습니다.

## 실무에서는 이렇게 확인하면 좋겠다

운영 환경에서는 아래 순서가 가장 덜 위험해 보입니다.

1. 에러 로그를 그대로 저장합니다.
2. 권한 문제인지 용량 문제인지 키워드로 분리합니다.
3. 권한 문제라면 실행 파일, 컨테이너 사용자, bind mount, 보안 정책 순서로 봅니다.
4. 용량 문제라면 `df -h`, `df -i`, `docker system df`를 함께 봅니다.
5. prune 명령은 작은 범위부터 실행합니다.
6. 볼륨 삭제 전에는 반드시 어떤 데이터가 들어 있는지 확인합니다.
7. 재발하면 로그 회전과 빌드 캐시 관리 정책을 추가합니다.

## 실무 체크리스트

- [ ] 원본 에러 로그에서 `permission denied`와 `No space left on device` 중 어느 쪽이 핵심인지 확인했다.
- [ ] entrypoint나 실행 파일에 execute 권한이 있는지 확인했다.
- [ ] 컨테이너의 `USER`, `id`, 작업 디렉터리 소유권을 확인했다.
- [ ] bind mount 경로의 UID/GID와 permission을 호스트와 컨테이너 양쪽에서 확인했다.
- [ ] SELinux, AppArmor, Docker Desktop 파일 공유 설정을 확인했다.
- [ ] `df -h`, `df -i`, `docker system df`로 용량과 inode를 확인했다.
- [ ] Docker prune 명령은 컨테이너, 이미지, 빌드 캐시처럼 작은 범위부터 실행했다.
- [ ] 볼륨 삭제 전에는 반드시 데이터 성격과 백업 여부를 확인했다.
- [ ] 로그 파일이 계속 커지는 경우 Docker logging 옵션을 설정했다.

## 참고 자료

- [Docker Docs: Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) - bind mount가 호스트 파일 시스템과 직접 연결되고, 기본적으로 쓰기 접근을 가질 수 있다는 점과 SELinux `:z`, `:Z` 옵션 설명을 참고했습니다.
- [Docker Docs: docker system df](https://docs.docker.com/reference/cli/docker/system/df/) - Docker 데몬이 사용하는 이미지, 컨테이너, 볼륨, 빌드 캐시 용량을 확인하는 명령 설명을 참고했습니다.
- [Docker Docs: docker system prune](https://docs.docker.com/reference/cli/docker/system/prune/) - 사용하지 않는 컨테이너, 네트워크, 이미지, 빌드 캐시 및 선택적 볼륨 정리 범위를 확인할 때 참고했습니다.

Docker의 `permission denied`와 `No space left on device`는 단순해 보이지만 원인이 여러 층에 걸쳐 있을 수 있습니다. 그래도 권한, 사용자, 마운트, 보안 정책, 디스크, inode, 로그 순서로 차근차근 보면 대부분은 재현 가능한 문제로 좁혀갈 수 있었습니다.
