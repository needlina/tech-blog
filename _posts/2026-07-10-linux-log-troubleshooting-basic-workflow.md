---
title: "Linux 서버에서 로그로 장애 원인 좁히기: 기본 흐름과 실무 팁"
description: "Linux 서버에서 로그를 확인하고 장애 원인을 좁히는 기본 흐름"
slug: "linux-log-troubleshooting-basic-workflow"
date: 2026-07-10 10:00:00 +0900
categories: [Linux, DevOps, Observability]
tags: [linux, logs, troubleshooting, devops, monitoring]
image:
  path: /assets/img/posts/blog/linux-log-troubleshooting-basic-workflow/image-1.png
  alt: "Linux 서버 로그를 확인하며 장애 원인을 좁히는 터미널 작업 화면"
---

Linux 서버에서 로그를 확인하고 장애 원인을 좁히는 기본 흐름

서두에 한마디: 저는 아직 초보 개발자이고, 이 글은 공부하면서 정리한 개인적인 체험과 실무에서 제가 자주 사용하는 기본 흐름을 모아둔 것입니다. 전문가의 절대적인 지침이라기보다는 함께 점검해보면 좋을 포인트로 봐주시면 좋겠습니다.

![Linux 서버 로그를 확인하며 장애 원인을 좁히는 터미널 작업 화면](/assets/img/posts/blog/linux-log-troubleshooting-basic-workflow/image-1.png)
이미지 출처: AI 생성 이미지

왜 로그 확인이 중요한가
- 장애가 났을 때 로그는 시간(time)과 증상(message)을 남겨둔 가장 직접적인 단서입니다.
- 로그를 통해 어떤 컴포넌트(커널, 시스템 서비스, 애플리케이션, 컨테이너 등)에서 문제가 발생했는지 범위를 좁힐 수 있습니다.
- 다만 로그가 항상 친절하지는 않아서, 조합해서 읽고 다른 체크(리소스, 네트워크 등)와 대조해야 합니다.

간단한 흐름 요약(전체 그림)
1. 문제 정의: 증상, 시간, 영향 범위 파악
2. 타임라인 생성: 문제 발생 전후 로그 타임라인 확보
3. 컴포넌트 범위 좁히기: 커널? systemd? 애플리케이션? 컨테이너?
4. 로그 필터링/검색: 키워드, 레벨, PID, 유닛 등으로 필터링
5. 추가 확인: 리소스(디스크, 메모리), 프로세스, 포트, 타임 동기
6. 조치/재현/모니터링: 원인 추정 → 임시 조치 → 재현 시도 → 장기 조치


공부하면서 알게 된 점
- journalctl과 /var/log의 차이: systemd가 있는 환경에서는 systemd-journald에 로그가 모이고 journalctl로 볼 수 있습니다. 전통적으로 /var/log 안의 파일을 다루던 방식과 병행되는 경우가 많아서, 어떤 서비스가 어디로 로그를 쓰는지 알아두는 것이 편합니다.
- 시간 동기와 타임존 문제: 로그 타임스탬프가 다른 시스템과 맞지 않으면 잘못된 원인 추론을 하게 됩니다. timedatectl로 시스템 시간이 올바른지 확인하는 습관이 제일 도움이 됐습니다.
- 로그는 항상 원인(primary cause)을 말해주지 않습니다. 종종 후속 에러(예: DB 연결 실패로 인한 애플리케이션 예외)가 먼저 보이고, 실제 원인은 네트워크나 인증 문제일 수 있습니다.

처음에는 헷갈렸던 부분
- journalctl 옵션들이 헷갈렸습니다. --since/--until, -u(unit), -b(boot), -f(follow) 등 조합으로 타임라인을 잘라내야 하는데, 어떤 조합이 빠르고 정확한지 익히는 데 시간이 걸렸습니다.
- 로그 레벨과 메시지 내용의 의미: ERROR, WARN, INFO 같은 레벨이 항상 상황 심각도를 명확히 하진 않았습니다. INFO지만 핵심 원인인 경우도 있었습니다.
- 컨테이너 환경에서는 로그가 여러 레이어(docker/k8s, container stdout, host syslog)에 걸쳐 흩어져 있어 어디를 봐야 할지 헷갈렸습니다.

실무에서는 이렇게 확인하면 좋겠다 (기본 체크리스트 흐름)
1) 증상·영향 수집
- 사용자/서비스 영향(404, 5xx, 느린 응답 등)
- 최초 발생 시간, 재현성 여부
- 영향 범위(특정 호스트? 전체 서비스? 특정 경로?)

2) 시간 동기 및 타임존 확인
- timedatectl
  ```
  timedatectl status
  ```
- ntp/chrony 동기 확인

3) 로그 수집 우선순위 결정
- system service (systemd unit): journalctl -u
- 일반 로그 파일: /var/log/nginx/*.log, /var/log/syslog 또는 /var/log/messages
- 커널 로그: dmesg 또는 journalctl -k
- 컨테이너: docker logs CONTAINER, kubectl logs POD

4) 타임라인 확보
- journalctl 예시: 최근 1시간의 nginx 서비스 로그
  ```
  journalctl -u nginx.service --since "1 hour ago" --no-pager
  ```
- 파일 로그 예시:
  ```
  sudo tail -n 200 /var/log/nginx/error.log
  sudo sed -n '1,200p' /var/log/nginx/error.log
  ```
- 컨테이너 로그 예시:
  ```
  docker logs --since 1h my-container
  kubectl logs --since=1h my-pod
  ```

중간 설명 이미지 (로그 필터링과 시스템 체크 예시)
![터미널에서 journalctl과 tail로 로그를 확인하는 모습의 이미지로, Linux 로그 조사와 관련된 화면을 보여준다](/assets/img/posts/blog/linux-log-troubleshooting-basic-workflow/image-2.avif)
이미지 출처: Unsplash / Caroline

5) 키워드/문맥으로 필터링
- 특정 에러 키워드로 grep + 컨텍스트
  ```
  grep -nC3 "connection refused" /var/log/myapp/*.log
  journalctl -u myapp.service | grep -i "timeout"
  ```
- PID나 프로세스 이름으로 좁히기:
  ```
  ps aux | grep myapp
  lsof -p <PID>
  journalctl _PID=1234
  ```

6) 리소스/환경 점검 (로그만으로 확신하기 어려운 경우)
- 디스크 사용량: 로그가 가득 차서 문제가 발생하는 경우가 흔합니다.
  ```
  df -h
  df -i
  du -sh /var/log
  ls -lh /var/log | sort -k5 -h
  ```
- 메모리/스왑:
  ```
  free -h
  top 또는 htop
  ```
- 프로세스 상태:
  ```
  systemctl status myapp.service
  ps -ef | grep myapp
  ```
- 포트/네트워크:
  ```
  ss -tulnp | grep 80
  netstat -plant (legacy)
  curl -v http://localhost:8080/health
  ```

7) 로그 순서대로 읽기(타임라인 상관관계)
- 애플리케이션 로그 → 프레임워크/라이브러리 로그 → 시스템 로그 → 커널 로그 순으로 관련성 있는 이벤트를 연결해 봅니다.
- 예: 애플리케이션 연결 예외 → 시스템 수준의 "out of memory" 또는 네트워크 인터페이스 재시작 로그가 있는지 확인

8) 로그 레벨/추가 로깅 활성화
- 재현 가능하고 원인을 특정하지 못하면 로그 레벨을 올려 더 자세한 정보를 얻습니다. 단, 운영환경에서는 로그 볼륨과 성능 영향에 유의해야 합니다.
- 예: nginx debug 로그 활성화, 애플리케이션 프레임워크의 debug 모드 등

예시: journalctl로 특정 키워드 + 시간 범위 탐색
```
# 2026-07-10 09:00 ~ 09:30 사이 nginx 관련 에러 검색
journalctl -u nginx.service --since "2026-07-10 09:00:00" --until "2026-07-10 09:30:00" | grep -i "error"
```

로그 관리(회전 및 보존) 예시
- logrotate 설정 간단 예시 (/etc/logrotate.d/myapp)
```
/var/log/myapp/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0640 myuser mygroup
    postrotate
        systemctl reload myapp.service > /dev/null 2>/dev/null || true
    endscript
}
```
- 점검 포인트: 로그 소유자/권한, 로테이션 시 서비스 재시작 필요 여부, 압축 여부

컨테이너 환경에서 로그 확인 팁
- Docker: 컨테이너 stdout/stderr가 호스트의 json-file 또는 journald로 가는 경우가 많습니다. docker logs / journalctl -u docker.service 확인
- Kubernetes: kubectl logs, 그리고 kubelet/CRI 로그(예: /var/log/containers, /var/log/pods) 확인
- 서비스별 로그 수집(Fluentd/Fluentbit, Filebeat 등) 구성 유무 확인

권한/SELinux 관련 문제
- SELinux 활성 환경에서 애플리케이션이 로그 파일에 쓰지 못하는 경우가 종종 있습니다.
  ```
  sestatus
  ausearch -m avc -ts today | aureport -f
  ```
- 파일 권한 확인:
  ```
  ls -l /var/log/myapp
  stat /var/log/myapp/error.log
  ```

몇 가지 경험적 팁(제가 써먹어본 것들)
- 먼저 영향 범위 좁히기: "전체 사이트 다운?" vs "특정 API만 실패?"가 가장 빠른 분기점입니다.
- 시간 동기 먼저 체크: 로그 타임스탬프가 어긋나면 원인 추적이 꼬입니다.
- 로그 원문을 그대로 캡처해 두기: 나중에 검색/공유할 때 편합니다. (예: /tmp/incident-logs-20260710.txt)
- 로그 수집이 안 되어 있다면 복구보다 로그 확보를 먼저 시도합니다(가능하면 메모리 덤프나 프로세스 상태 캡처도).

틀릴 가능성이 있는 내용이라는 표현
- 위에 적은 명령어와 패턴은 일반적인 Linux 시스템에서 자주 쓰이는 방식입니다. 다만 배포 방식(systemd vs SysV), 배포된 어플리케이션, 클라우드 벤더(예: GCP의 Stackdriver, AWS CloudWatch) 등에 따라 접근 방법이나 로그 위치가 달라질 수 있습니다. 환경에 맞게 명령어나 경로를 조정해야 합니다.

실무 체크리스트
- 문제 정의: 최초 발견 시간, 영향 범위, 증상(응답 코드/에러 메시지)
- 시간/타임존: timedatectl 확인, NTP/chrony 상태 확인
- 로그 위치 파악: systemd journal vs /var/log vs 컨테이너 로그
- 타임라인 확보: journalctl --since/--until, tail -n, docker logs --since 등
- 리소스 확인: df -h, df -i, free -h, top, ss -tulnp
- 프로세스/서비스 확인: systemctl status, ps, lsof
- 권한/SELinux 확인: ls -l, sestatus, audit 로그
- 로그 로테이션 설정 점검: /etc/logrotate.d/* 파일 확인
- 로그 수집/중앙화 여부 확인: Fluentd/Fluentbit/ELK/CloudWatch 설정
- 조치 기록: 캡처한 로그/명령어 결과를 별도 파일로 보관
- 재발 방지: 원인에 따른 장기 대책(RCA, 모니터링 알람, 로그 레벨 조정 등)

마무리하면서
- 아직 많은 부분을 더 공부해야 한다고 느낍니다. 특히 분산 시스템(컨테이너, 쿠버네티스) 환경에서는 로그가 여러 레이어에 흩어지기 쉬워서 중앙화와 타임라인 구성 연습이 더 필요했습니다.
- 이 글은 제가 현장에서 자주 쓰는 기본 흐름과 체크포인트를 모은 것입니다. 환경에 따라 필요 없는 항목도 있고, 추가로 확인해야 할 항목도 있을 수 있으니 참고용으로 보시면 좋겠습니다.

읽어주셔서 감사합니다. 혹시 특정 환경(예: nginx + gunicorn, k8s cluster, AWS EC2 등)에 맞춰 예시 로그 확인 절차를 더 원하시면 알려주세요.
