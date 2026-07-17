---
title: "Docker 로그와 볼륨 운영 가이드: 로그 관리와 볼륨 점검 포인트"
description: "오늘은 Docker 컨테이너 로그와 볼륨을 운영 관점에서 어떻게 관리하면 좋을지, 제가 공부하면서 정리한 내용을 차근차근 적어보려고 합니다. 아직 초보라 실무에서 바로 적용하기 전에 팀과 상의해야 할 부분도 있고, 제 정리가 틀렸을 가능성도 있으니 참고 정도로 봐주시면"
slug: "docker-logs-volumes-ops-guide"
date: 2026-07-13 10:00:00 +0900
categories: [Docker, DevOps]
tags: [docker, container-logs, volumes, logging, operations]
image:
  path: /assets/img/posts/blog/docker-logs-volumes-ops-guide/image-1.webp
  alt: "도커 컨테이너 로그와 볼륨을 상징적으로 보여주는 단순한 기술 일러스트"
---

오늘은 Docker 컨테이너 로그와 볼륨을 운영 관점에서 어떻게 관리하면 좋을지, 제가 공부하면서 정리한 내용을 차근차근 적어보려고 합니다. 아직 초보라 실무에서 바로 적용하기 전에 팀과 상의해야 할 부분도 있고, 제 정리가 틀렸을 가능성도 있으니 참고 정도로 봐주시면 좋겠습니다.

간단한 목표는 다음과 같습니다.
- 컨테이너 로그가 무한정 커지는 문제를 예방하는 방법
- 볼륨 데이터의 백업, 복구, 점검 절차
- 실무에서 빠르게 디스크·로그 상태를 확인하는 방법

![도커 컨테이너 로그와 볼륨을 상징적으로 보여주는 단순한 기술 일러스트](/assets/img/posts/blog/docker-logs-volumes-ops-guide/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점
- Docker 기본 로그 드라이버는 json-file인데, 기본 설정으로 두면 로그가 계속 쌓여 디스크를 채울 수 있다는 점을 실무에서 가장 먼저 확인해야 할 것 같습니다.
- 로그 드라이버는 데몬 레벨(daemon.json)이나 컨테이너 실행 시 옵션(--log-driver, --log-opt)으로 제어할 수 있고, 로그 회전과 보관 정책을 여기서 설정하는 게 비교적 쉬운 방식입니다.
- 볼륨은 컨테이너의 상태와 별개로 데이터를 유지해 주지만, 볼륨 자체도 디스크를 차지하므로 주기적으로 사용량을 점검하고 백업 전략을 마련해야 합니다.

처음에는 헷갈렸던 부분
- "로그는 어디에 저장되는가?"가 헷갈렸습니다. 기본적으로는 /var/lib/docker/containers/<container-id>/<container-id>-json.log 같은 경로에 json 형식으로 저장되지만, 로그 드라이버를 syslog, journald, fluentd 등으로 바꾸면 호스트의 다른 경로나 외부 수집기 쪽으로 전달됩니다.
- "볼륨과 바인드 마운트의 차이"도 처음엔 헷갈렸습니다. 간단히 말하면 볼륨은 Docker가 관리하는 저장소(권장되는 방식)이고, 바인드 마운트는 호스트 파일시스템의 경로를 그대로 사용하는 방식으로 권한/SELinux 등의 이슈가 더 자주 발생할 수 있습니다.
- 로그 회전과 logrotate의 위치: 도커 자체 로그 회전에서 설정이 가능한데, 일부 환경에서는 시스템 수준의 logrotate를 별도로 사용하는 경우도 있어 중복 설정으로 충돌이 날 수도 있겠다 싶었습니다.

핵심 개념 정리 (짧게)
- 로그 드라이버: json-file, syslog, journald, fluentd, awslogs 등. 각 드라이버별로 특징과 외부 연동 유무를 확인하세요.
- 로그 회전: json-file의 경우 --log-opt max-size, max-file 같은 옵션으로 회전을 설정할 수 있습니다.
- 볼륨 백업: docker run --rm -v <volume>:/data busybox tar cvf - /data > backup.tar 같은 방식으로 간단히 백업 가능.
- 디스크 모니터링: df -h, docker system df, du -sh /var/lib/docker/volumes 등으로 확인.

실무에서 이렇게 확인하면 좋겠다 (명령어 중심)
- 컨테이너 로그 확인
  - docker logs --since 1h --tail 200 -f <container>
  - 로그에 타임스탬프가 필요하면 docker logs --timestamps
- 각 컨테이너의 로그 파일 위치 확인 (json-file 사용 시)
  - {% raw %}docker inspect --format='{{.LogPath}}' <container>{% endraw %}
- 데몬 레벨 로그 설정 확인
  - /etc/docker/daemon.json 파일 확인
  - 예: cat /etc/docker/daemon.json
- 전체 디스크 사용량과 도커 관련 사용량
  - df -h
  - sudo du -sh /var/lib/docker/containers/* | sort -h | tail -n 10
  - docker system df
- 볼륨 리스트와 상세
  - docker volume ls
  - docker volume inspect <volume>
  - du -sh /var/lib/docker/volumes/<volume>/_data

실습 예제: 로그 회전 설정 (daemon.json)
- daemon.json 예시 (호스트에 적용)
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
- 변경 후 도커 데몬 재시작 필요(systemd 사용 시)
sudo systemctl restart docker

컨테이너별 로그 옵션 (docker run)
- docker run 예시
docker run -d --name myapp \
  --log-driver=json-file \
  --log-opt max-size=10m \
  --log-opt max-file=5 \
  myimage:latest

docker-compose 예시
version: '3.8'
services:
  app:
    image: myimage:latest
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

로그 수집과 중앙화
- 운영에서는 로그를 중앙으로 모아 검색/대시보드화하는 경우가 많습니다. 예: fluentd → Elasticsearch, or fluentbit → Loki, 또는 클라우드 제공 로그 서비스.
- 중앙화로 얻는 장점: 검색, 상관분석, 롱텀 보존. 단점: 구성 복잡도와 비용 증가.
- 실무 팁: 우선 내부에서 로그 드라이버만으로 기본 회전 정책을 만들어 디스크 문제를 방지한 뒤, 점진적으로 중앙 수집을 도입하면 부담이 덜합니다.

볼륨 백업/복구 예시 (명령어)
- 백업
docker run --rm -v my_volume:/data -v $(pwd):/backup busybox \
  tar czf /backup/my_volume-backup-$(date +%F).tar.gz -C /data .

- 복구 (주의: 덮어쓰기)
docker run --rm -v my_volume:/data -v $(pwd):/backup busybox \
  tar xzf /backup/my_volume-backup-2026-07-13.tar.gz -C /data

- 직접 파일 복사(권한 주의)
docker run --rm -v my_volume:/data alpine sh -c "chown -R 1000:1000 /data && ls -la /data"

권한과 SELinux 관련
- 바인드 마운트나 볼륨에 접근 권한 문제가 생길 수 있습니다. 컨테이너에서 uid/gid가 호스트와 다르면 파일 쓰기 권한에 실패할 수도 있으니, 필요하면 chown/chmod로 조정하거나 Dockerfile에서 사용자 설정을 맞추는 편이 안정적입니다.
- SELinux가 활성화된 호스트에서는 :z 또는 :Z 옵션을 사용해 컨테이너와 호스트의 라벨을 조정해야 할 수 있습니다.

로그 파일이 갑자기 커졌을 때 점검 순서 (간단한 절차)
1. df -h로 디스크 여유 확인
2. docker system df와 du로 도커 내부 사용량 확인
3. docker ps -a로 최근에 재시작이 잦은 컨테이너 확인
4. {% raw %}docker inspect --format='{{.LogPath}}' <container>{% endraw %}로 로그 파일 위치 확인
5. tail -n 200 <logfile>으로 로그 내용 확인(에러/반복 로그 원인)
6. 임시 완화: docker logs --since 1h로 최근 로그 점검, 불필요한 로그 레벨을 낮추거나 컨테이너 재기동(신중)
7. 장기적 해결: 로그 레벨/회전 정책 설정, 중앙 로그 수집 도입

처음遇했던 작은 실수들 (제가 겪은 사례)
- daemon.json에 문법 오류가 있어서 도커가 부팅되지 않았던 적이 있었습니다. JSON 편집 후 항상 sudo systemctl restart docker 하면서 journalctl -u docker -f로 오류 로그를 확인하는 습관을 들였습니다.
- 로그 회전 크기를 너무 작게 잡아 실제로 필요한 로그를 잃을 뻔한 적이 있어, 보존 정책은 팀과 상의해서 적절히 정하는 편이 낫겠습니다.

중간 설명 섹션 — 로그 드라이버 비교와 선택 포인트
- json-file: 장점은 기본값이라 별도 구성 없이 동작, 단점은 호스트 디스크에 로그가 쌓임.
- journald: 시스템 로그와 통합 관리 가능. systemd 환경이라면 유리.
- syslog: 기존 syslog 인프라(예: rsyslog)와 연결할 때 유용.
- fluentd/fluentbit: 로그를 외부 수집기로 전송할 때 유연하게 사용.
- 클라우드 로그 드라이버(awslogs, gcp 등): 직접 클라우드 서비스로 전송 가능해 중앙화가 쉬움.
- 선택 포인트: 운영 환경의 로그 집계 체계, 저장 비용, 장애 복구 시점에 따라 결정하면 될 듯합니다.

![디스크 사용량과 로그 관리를 점검하는 운영자 도식 일러스트](/assets/img/posts/blog/docker-logs-volumes-ops-guide/image-2.webp)
이미지 출처: AI 생성 이미지

주의사항과 권장 패턴
- 로그 보존 정책은 단순히 디스크 용량으로만 결정하지 말고, 컴플라이언스나 감사 요구사항을 함께 고려하세요.
- 컨테이너의 stdout/stderr를 이용한 로그 수집은 간편하지만, 어플리케이션 내부에서 파일로 로그를 쓰는 경우 볼륨을 통한 로그 보존 정책을 별도로 생각해야 합니다.
- 볼륨 백업은 주기적 자동화(크론, CI 파이프라인)로 하는 것이 실수 가능성을 줄여줍니다.
- 스냅샷 기반 스토리지를 사용하는 경우 스냅샷과 앱 일관성(consistency)을 고려해, 가능하면 애플리케이션의 상태를 정지하거나 fsync/flush 후에 스냅샷을 찍으세요.

실무에서는 이렇게 확인하면 좋겠다 (점검 리스트 예시)
- 매일/주간: df -h, docker system df, 상위 컨테이너 로그 파일 크기 확인
- 장애 발생 시: docker inspect로 로그 경로 확인 → tail로 최근 로그 확인 → 컨테이너 재시작 전에 로그 수집
- 배포 전: 이미지에서 불필요한 디버그 로그를 끄고 환경변수로 로그 레벨 조정
- 백업: 중요한 볼륨은 주간 백업, 보존 정책과 테스트 복구 절차를 문서화

예시 logrotate 설정 (대체 접근법)
- 만약 json 로그 파일을 시스템 logrotate로 관리하려면 /etc/logrotate.d/docker-containers 같은 파일을 만들어 아래와 같이 설정할 수도 있습니다. 다만, 이 방식은 도커 자체의 log rotation 옵션과 중복되지 않도록 조심해야 합니다.
/var/lib/docker/containers/*/*-json.log {
  rotate 7
  daily
  compress
  missingok
  notifempty
  copytruncate
}

마무리 — 제가 정리한 핵심 포인트
- 우선 디스크 모니터링(특히 /var/lib/docker)을 자동화하고, 로그 회전 정책을 기본으로 설정해 두면 예기치 않은 디스크 부족 사고를 줄일 수 있습니다.
- 볼륨은 단순히 생성만 한다고 안전한 것이 아니라, 백업/복구 및 권한 처리를 미리 테스트해 두는 것이 중요합니다.
- 로그 중앙화는 장기적으로 많은 이점을 주지만 처음부터 복잡하게 도입하기보다는 우선 로컬 회전 정책을 마련한 뒤 점진적으로 확장하는 편이 실무적으로 안전한 방법 같습니다.

실무 체크리스트
- [ ] /var/lib/docker 사용량 주기적 모니터링(알람 설정)
- [ ] daemon.json 또는 컨테이너 옵션으로 로그 회전(max-size, max-file) 설정
- [ ] 중요한 볼륨에 대해 백업 스케줄과 복구 테스트 문서화
- [ ] 로그 중앙화 전략(플랫폼/비용/보존기간) 결정 및 PoC 진행
- [ ] 데몬 설정 변경 시 syntax 체크와 재시작 후 journalctl 로 상태 확인
- [ ] 권한/SELinux 이슈 체크 및 필요한 마운트 옵션(:z/:Z) 적용 여부 확인

참고로 제가 정리한 내용은 환경에 따라 달라질 수 있으니, 실제 운영 환경에 적용하기 전에는 팀의 운영 정책과 스토리지 특성을 확인하고 작은 범위에서 먼저 테스트해 보시길 권합니다. 질문이나 함께 정리하면 좋을 포인트가 있으면 알려주세요 — 저도 계속 정리하면서 업데이트하겠습니다.
