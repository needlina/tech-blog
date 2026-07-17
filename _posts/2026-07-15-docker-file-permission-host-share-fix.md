---
title: "Docker 볼륨과 파일 권한 문제 해결 순서 — 호스트와 컨테이너 파일 공유가 깨질 때"
description: "Docker 컨테이너에서 파일 권한 문제로 호스트와 파일 공유가 깨질 때 해결 순서 서두 — 왜 이걸 정리하나 나는 컨테이너에 호스트 디렉터리를 바인드 마운트해 개발하거나, 데이터 디렉터리를 공유할 때 권한 문제로 골머리를 앓은 적이 있다"
slug: "docker-file-permission-host-share-fix"
date: 2026-07-15 10:00:00 +0900
categories: ["Docker", "DevOps"]
tags: ["docker", "file-permissions", "linux", "volumes", "권한문제"]
image:
  path: /assets/img/posts/blog/docker-file-permission-host-share-fix/preview.png
  alt: "컨테이너-호스트 파일 권한 문제 썸네일"
---

Docker 컨테이너에서 파일 권한 문제로 호스트와 파일 공유가 깨질 때 해결 순서 서두 — 왜 이걸 정리하나 나는 컨테이너에 호스트 디렉터리를 바인드 마운트해 개발하거나, 데이터 디렉터리를 공유할 때 권한 문제로 골머리를 앓은 적이 있다


Docker 컨테이너에서 파일 권한 문제로 호스트와 파일 공유가 깨질 때 해결 순서

서두 — 왜 이걸 정리하나
나는 컨테이너에 호스트 디렉터리를 바인드 마운트해 개발하거나, 데이터 디렉터리를 공유할 때 권한 문제로 골머리를 앓은 적이 있다. 컨테이너에서는 파일이 root로 보이거나, 쓰기 권한이 없어 애플리케이션이 실패하는 경우가 종종 발생한다. 이번 글에서는 초보 입장에서 공부하면서 알게 된 점과 실제로 점검해보면 도움이 될 실무 중심의 절차를 정리해본다. 틀릴 가능성은 있을 수 있으니, 각 항목을 실무 환경에 맞춰 테스트해 보길 권한다.

문제의 전형적 증상

- 컨테이너 내부에서 파일이 root:root 로 보이거나 권한이 없음
- 애플리케이션이 파일에 쓰지 못함 (permission denied)
- 호스트에서 생성한 파일이 컨테이너에서 다르게 보임 (UID/GID 불일치)
- SELinux, NFS, CIFS 등 공유 방식에 따라 엉뚱한 거부 로그가 남음

공부하면서 알게 된 점

- Docker는 기본적으로 호스트의 파일 시스템을 그대로 바인드 마운트한다. 따라서 파일의 소유자(uid)와 그룹(gid) 정보가 그대로 전달된다.
- 컨테이너 내부의 사용자 계정 이름은 호스트와 일치하지 않을 수 있지만, 권한 결정은 숫자(uid/gid) 기준이라는 점이 핵심이다.
- SELinux나 NFS/CIFS 같은 추가적인 레이어가 있으면 보안 컨텍스트나 네트워크 파일시스템의 매핑 규칙 때문에 예상과 다른 동작이 발생한다.
- 해결책은 여러 가지(UID 맞추기, chown, entrypoint 스크립트, userns-remap, volume driver)이고, 상황에 따라 trade-off가 있다.

![호스트와 컨테이너 간 UID/GID 매핑을 보여주는 단순한 아이콘 기반 다이어그램 (호스트 사용자 → 숫자 UID → 컨테이너 파일 소유자)](/assets/img/posts/blog/docker-file-permission-host-share-fix/image-1.webp)
이미지 출처: AI 생성 이미지

처음에는 헷갈렸던 부분

- "root가 아니면 쓰지 못하는가?" — 꼭 그렇지는 않다. 파일과 디렉터리의 권한 비트와 소유자/그룹 설정에 따라 달라진다.
- "컨테이너의 user:group 옵션이 무시되는가?" — docker run의 --user 옵션은 프로세스의 UID/GID를 바꾸지만 바인드 마운트된 파일의 소유권은 바뀌지 않는다.
- "named volume은 안전한가?" — named volume은 Docker가 관리하는 볼륨이고 초기 소유권을 Docker 엔진이 정할 수 있어 호스트 바인드보다 권한 문제가 덜할 수 있으나, 항상 해결되는 건 아니다.

우선순위 접근법 — 문제 발생 시 단계별 점검 순서
아래 순서는 실제 문제를 빠르게 좁히는 데 유용했다. 각 단계에서 명령어 예시를 적어두었다.

1. 환경과 증상 파악

- 호스트 환경: Linux 배포판, Docker 버전, Docker Desktop(mac/Windows이면 VM 레이어 존재), SELinux 활성 여부 등 확인
  명령 예:
  - uname -a
  - docker version
  - getenforce # SELinux (Enforcing/Permissive/Disabled)
- 어떤 파일/디렉터리에서 문제가 발생하는지 구체적으로 파악

2. 호스트에서 권한/소유권 확인

- ls -l /path/to/dir
- stat -c "%U %G %a %n" /path/to/file
- 필요하면 getfacl로 ACL 확인: getfacl /path/to/file

3. 컨테이너에서 실제로 어떻게 보이는지 확인

- docker run --rm -it -v /host/path:/mnt ubuntu:22.04 bash
- 컨테이너 내부에서 ls -ln /mnt # 숫자 uid/gid 확인
- id # 컨테이너 내부에서 현재 프로세스 uid/gid 확인

중요 포인트: 컨테이너의 사용자 이름보다 숫자 UID/GID가 권한 판정에 사용된다.

4. 마운트/볼륨 타입 확인

- 바인드 마운트인지(named) 볼륨인지 확인:
  - docker inspect <container> --format '{{ json .Mounts }}' | jq
  - docker volume inspect <volumename>
- NFS, CIFS 같은 네트워크 마운트라면 서버측의 export 옵션, uid/gid 매핑 확인

5. SELinux/ AppArmor 로그 확인 (해당 시)

- SELinux가 활성화된 경우에는 보안 컨텍스트 때문에 거부될 수 있다.
- 로그 확인: sudo ausearch -m avc,user_avc -ts recent 또는 journalctl -k | grep avc
- ls -Z /path 로 컨텍스트 확인

6. 간단한 실험으로 원인 좁히기

- 같은 호스트에서 파일을 새로 생성해보고 권한/소유권 변화를 관찰
  - touch /host/path/testfile; sudo chown 1000:1000 /host/path/testfile
- 컨테이너에서 touch /mnt/tryfile 로 파일 생성해보고 호스트에서 어떻게 보이는지 확인

해결 방법들 — 상황별 제안 (장단점 포함)
아래는 여러 상황에서 자주 쓰이는 방법과 예시다.

![바인드 마운트와 named volume의 차이를 단순 그림으로 설명하는 일러스트 (호스트 폴더 연결 vs Docker 볼륨 컨테이너 연결)](/assets/img/posts/blog/docker-file-permission-host-share-fix/image-2.webp)
이미지 출처: AI 생성 이미지

A. 호스트와 컨테이너의 UID/GID 일치시키기 (권장되는 근본적 방법)

- 호스트 사용자와 컨테이너의 사용자 UID/GID를 맞추면 많은 문제가 사라진다.
- Dockerfile에서 사용자 생성 시 특정 UID/GID로 생성:
  예:
  ```
  FROM ubuntu:22.04
  RUN groupadd -g 1000 appgroup && useradd -m -u 1000 -g 1000 appuser
  USER appuser
  ```
- 또는 docker run/compose에서 --user 1000:1000 옵션 사용

장점: 런타임에 추가 chown이 필요 없음. 단점: 이미지 설계 시 고려 필요.

B. 컨테이너 시작 시 chown으로 권한 재설정 (간단하지만 비용 존재)

- entrypoint 스크립트에서 마운트된 디렉터리 소유권을 변경:
  예 entrypoint.sh
  ```
  #!/bin/sh
  chown -R appuser:appgroup /data || true
  exec su-exec appuser "$@"
  ```
- docker-compose 예:
  ```
  services:
    app:
      image: myapp
      volumes:
        - ./data:/data
      entrypoint: /entrypoint.sh
  ```

장점: 간단히 적용 가능. 단점: 큰 디렉터리의 경우 컨테이너 시작이 느려지고 퍼포먼스 이슈가 생길 수 있음.

C. userns-remap 사용하여 호스트와 격리된 UID 네임스페이스 사용

- Docker 데몬 레벨에서 userns-remap 활성화하면 컨테이너의 root가 호스트의 비특권 UID로 매핑된다.
- /etc/docker/daemon.json 예:
  ```
  {
    "userns-remap": "default"
  }
  ```
  장점: 보안 향상. 단점: 설정이 복잡하며, 기존 볼륨과의 상호작용을 주의해야 함.

D. named volumes 사용

- Docker가 관리하는 볼륨은 초기 소유권을 엔진이 제어하기 때문에 바인드 마운트보다 덜 골치 아플 수 있다.
- docker-compose 예:
  ```
  volumes:
    app-data:
  services:
    app:
      volumes:
        - app-data:/var/lib/myapp
  ```

E. NFS/CIFS 특수한 설정

- NFS: export 옵션(anonuid/anongid 또는 root_squash)과 마운트 옵션(uid=,gid=) 확인
- CIFS: mount 옵션으로 uid=,gid=,file_mode=,dir_mode= 설정 필요
  예:
  ```
  mount -t cifs //server/share /mnt -o username=user,password=pass,uid=1000,gid=1000,file_mode=0644,dir_mode=0755
  ```

실무에서는 이렇게 확인하면 좋겠다 (체크 절차)

- 어떤 파일/디렉터리에서 실패하는지 정확히 로그에서 추출
- 호스트와 컨테이너에서 각각 ls -ln /path 로 uid/gid와 권한 비트 확인
- docker inspect로 마운트 타입 확인
- SELinux 활성 여부와 audit 로그 확인
- (네트워크 파일시스템일 경우) 서버측 export/SMB 설정 확인
- 컨테이너 시작 스크립트나 이미지 내부에 chown 같은 작업이 있는지 확인
- 가능하면 테스트 컨테이너로 간단한 재현 환경 만들어서 원인 좁히기

실전에서 유용한 명령 요약

- 호스트에서:
  - ls -l /path
  - stat -c "%n %u %g %a" /path/\*
  - getfacl /path
  - getenforce
- 컨테이너에서:
  - docker exec -it <c> bash
  - id
  - ls -ln /mounted/path
- Docker 정보:
  - docker inspect <container> --format '{{ json .Mounts }}'
  - docker volume inspect <volumename>

예시: docker-compose로 --user 지정하고 entrypoint로 안전하게 권한 맞추기

```
version: '3.8'
services:
  app:
    image: myapp:latest
    user: "1000:1000"
    volumes:
      - ./data:/data
    entrypoint: ["/bin/sh", "-c", "chown -R 1000:1000 /data || true; exec myapp"]
```

이 방식은 컨테이너 내부 프로세스를 비루트 유저로 실행하면서, 최초 기동 시 소유권을 보정하는 절충안이다.

주의할 점들 (내가 실수했던 것들)

- Docker Desktop(mac/Windows)은 내부 VM에서 파일을 공유하므로 퍼포먼스와 권한 처리가 리눅스 호스트와 다를 수 있다.
- entrypoint에서 chown을 남발하면 시작 시간이 길어질 수 있다.
- SELinux에서 :z 또는 :Z 옵션을 잘못 사용하면 컨테이너가 파일에 접근하지 못할 수 있다. (SELinux 컨텍스트를 수정하는 옵션임)
- 사용자 이름만 같으면 안 되고 UID/GID 숫자가 일치해야 효과가 있다.

마무리하며 — 권장 접근

- 가능하면 개발 환경의 UID/GID와 컨테이너 사용자를 맞추는 것이 가장 확실한 방법 같다. (이미지 빌드 시 사용자 생성 고려)
- 운영 환경에서는 named volumes나 전용 스토리지 드라이버를 사용해 호스트 바인드의 복잡도를 줄이는 편이 안전할 수 있다.
- 문제 발생 시 위에서 제시한 단계대로 원인부터 좁히는 습관을 들이면 시간을 절약할 수 있었다.

실무 체크리스트

- [ ] 문제가 발생한 파일/디렉터리와 에러 로그(권한 관련)를 확보했다.
- [ ] 호스트에서 ls -ln 및 stat로 uid/gid와 permission 비트를 확인했다.
- [ ] 컨테이너 내부에서 ls -ln 및 id로 실제 보이는 uid/gid를 확인했다.
- [ ] docker inspect로 마운트 타입(바인드/volume)을 확인했다.
- [ ] SELinux 활성 여부와 관련 audit 로그를 확인했다(필요 시 :z/:Z 옵션 검토).
- [ ] NFS/CIFS 사용 시 서버측 export/smb 설정과 마운트 옵션(uid/gid/file_mode) 점검했다.
- [ ] 해결책 적용 전 작은 재현 환경에서 테스트해봤다(chown, user 변경, userns-remap 등).
- [ ] 장기적인 해결은 이미지 설계(정확한 UID/GID 사용자 생성) 또는 named volume/전용 스토리지 고려로 정리했다.

참고로 이 글은 내가 공부하면서 정리한 개인 메모 형태이며, 환경에 따라 적용 방법이나 옵션이 달라질 수 있다. 혹시 실무에서 겪은 구체적 상황(예: NFS 서버 설정, SELinux 로그 등)이 있으면 그 사례 기반으로 더 세부적으로 같이 점검해볼 수 있다.
