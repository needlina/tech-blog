---
title: "GitHub Actions Self-hosted 러너: 토큰·시크릿 노출 대응 실무 기준"
description: "GitHub Actions의 self-hosted 러너를 운영하면서 토큰이나 시크릿이 노출되었을 때 실무에서 어떻게 대응할지, 그리고 평소 어떤 점을 점검하면 위험을 줄일 수 있는지 정리했습니다."
slug: "github-actions-self-hosted-runner-secrets-hardening"
date: 2026-07-16 12:00:00 +0900
categories: ["DevOps", "Security", "GitHub Actions"]
tags: ["github-actions", "self-hosted-runner", "시크릿관리", "보안점검", "devops"]
image:
  path: /assets/img/posts/blog/github-actions-self-hosted-runner-secrets-hardening/preview.png
  alt: "셀프호스트 러너 보안 썸네일"
---
- 문제 정의: self-hosted 러너에서 어떤 노출이 발생할 수 있나
- 확인하며 남긴 메모
- 처음 확인할 때 막히는 부분
- 운영 전 확인할 부분 (명령어 · 설정 예시 포함)
- 대응 절차(발생 시)
- 실무 체크리스트

문제 정의: 왜 self-hosted 러너에서 토큰·시크릿 노출이 위험한가

- self-hosted 러너는 우리 통제 하의 머신입니다. 따라서 러너의 환경(로그, 파일시스템, 네트워크)을 통해 외부로 시크릿이 유출되거나 악성 워크플로가 실행될 가능성이 있습니다.
- GitHub의 hosted runner보다 제어권은 높지만, 잘못 구성하면 내부 자원이 노출될 수 있습니다.
- 노출 대상: 등록 토큰(registration token), GitHub 환경 변수(GITHUB_TOKEN), 저장소/조직 시크릿, 사내 서비스의 API 토큰 등.

![self-hosted 러너가 격리된 네트워크 단위로 표시된 단순한 기술 개념 일러스트](/assets/img/posts/blog/github-actions-self-hosted-runner-secrets-hardening/image-1.webp)

확인하며 남긴 메모

- 등록 토큰과 실행 중 토큰의 차이: 러너를 등록할 때 사용하는 "registration token"은 단발성(짧은 수명)인 경우가 많지만, 등록 이후 러너가 실제 워크플로를 실행할 때 사용되는 자격증명은 다릅니다. 등록 토큰은 재발급이 가능하고, 등록 취소가 가능합니다.
- GitHub의 시크릿 마스킹 기능이 로그에서 시크릿 패턴을 숨겨 주지만, 러너 자체에서 파일을 덤프하거나 로그를 조작하면 노출 가능성이 있습니다. 즉 "GitHub가 자동으로 다 막아준다"는 전적으로 믿기는 어렵습니다.
- self-hosted 러너는 일반적으로 unprivileged user로 실행해야 안전합니다. 루트로 실행하면 위험도가 크게 올라갑니다.
- 워크플로 파일 내에서 실수로 echo로 시크릿을 찍는 케이스가 실제로 종종 보입니다. 자동화된 스캔이나 PR 검토 규칙이 도움이 됩니다.

처음 확인할 때 막히는 부분

- "러너가 한 번 노출되면 모든 시크릿이 끝인가?" — 꼭 그렇지는 않습니다. 어떤 자격증명이 노출되었는지, 노출 시점의 로그/아티팩트가 무엇인지에 따라 차이가 있습니다. 빠르게 해당 러너를 비활성화하고 관련 토큰·시크릿을 회수하면 피해를 줄일 수 있습니다.
- "도커로 러너를 격리하면 안전한가?" — 도커는 격리에 도움을 주지만, 잘못된 마운트(예: /var/run/docker.sock 바인드)나 --privileged 옵션 사용은 오히려 더 큰 권한을 줍니다. 격리 방법도 설계가 중요합니다.
- "GitHub가 제공하는 registration token 만으로 공격자가 시스템을 완전히 제어할 수 있나?" — registration token은 러너를 등록하는 데 쓰이며 수명이 짧습니다. 공격자가 등록 token을 이용해 악성 러너를 등록하면 워크플로 실행 권한을 얻을 수 있어, 결과적으로 시크릿을 악용할 수 있습니다. 따라서 등록 토큰 관리와 러너 등록 로그 확인이 중요합니다.

운영 전 확인할 부분 (명령어 · 설정 예시 포함)

- 러너 등록/삭제/목록 확인 (GitHub API, gh CLI)
  - 레포지토리나 조직의 러너 목록 확인 (gh CLI 예시)
    ```
    # 레포지토리 러너 목록
    gh api repos/:owner/:repo/actions/runners --jq '.runners[] | {id,name,os,status}'
    ```
  - 러너 삭제
    ```
    gh api -X DELETE repos/:owner/:repo/actions/runners/{runner_id}
    ```
  - 등록 토큰 생성 (레포지토리 단위)
    ```
    gh api -X POST repos/:owner/:repo/actions/runners/registration-token
    ```
  - 설명: 위 API 호출에는 리포지토리 접근 권한을 가진 토큰이 필요합니다.

- 러너 등록(예: 리눅스에서)
  1. 러너 다운로드 및 압축 해제
     ```
     mkdir actions-runner && cd actions-runner
     curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.x.x/actions-runner-linux-x64-2.x.x.tar.gz
     tar xzf actions-runner.tar.gz
     ```
  2. 등록
     ```
     ./config.sh --url https://github.com/owner/repo --token REGISTRATION_TOKEN --unattended --labels self-hosted,linux,my-runner
     ```
  3. 서비스로 실행 (systemd 예시)
     /etc/systemd/system/actions.runner.my.service

     ```
     [Unit]
     Description=GitHub Actions Runner
     After=network.target

     [Service]
     User=actionsrunner
     WorkingDirectory=/home/actionsrunner/actions-runner
     ExecStart=/home/actionsrunner/actions-runner/run.sh
     Restart=always

     [Install]
     WantedBy=multi-user.target
     ```

     ```
     sudo systemctl daemon-reload
     sudo systemctl enable --now actions.runner.my.service
     ```
  - 권한: 위 예시처럼 전용 유저(actionsrunner)를 만들어서 실행하는 것을 권장합니다.
    ```
    sudo useradd -m -s /bin/bash actionsrunner
    sudo chown -R actionsrunner:actionsrunner /home/actionsrunner/actions-runner
    ```

- Docker로 러너 실행 시 주의점
  - 가능한 경우 docker 네트워크를 제한하고 불필요한 볼륨 마운트를 피합니다.
  - 예시(권장 아님 — 참고용): TLS, 최소 권한 토큰을 환경변수로 주고 네트워크 제한
    ```
    docker run -d --name gh-runner \
      --restart unless-stopped \
      --env RUNNER_TOKEN=xxx \
      --env RUNNER_NAME=my-runner \
      --network none \
      my-gh-runner-image
    ```
  - 주의: /var/run/docker.sock을 바인드하면 컨테이너에서 호스트 도커에 접근 가능해져 위험합니다.

- 파일 퍼미션과 워크스페이스 보호

  ```
  # 작업 디렉터리 최소 권한
  sudo chown -R actionsrunner:actionsrunner /home/actionsrunner/_work
  sudo chmod -R 700 /home/actionsrunner/_work
  ```

  - 로그, 임시 파일에 접근할 수 있는 계정을 제한합니다.

- 네트워크 egress 제한 (간단 예시)
  - ufw로 외부 특정 포트 차단(환경에 따라 조심해서 적용)
    ```
    sudo ufw default deny outgoing
    sudo ufw allow out to 192.0.2.1 port 443 proto tcp     # 허용 필요 대상만 추가
    ```
  - 실무에서는 더 세분화된 네트워크 정책(프록시, egress gateway)을 권장합니다. 무작정 차단하면 정상 작업이 실패할 수 있으니 테스트가 필요합니다.

- 워크플로 로그에서 시크릿 노출 탐지
  - 레포지토리 내 워크플로 파일에서 echo나 printf로 환경변수를 출력하는 패턴 검색:
    ```
    grep -R --line-number -E "echo .*\\$|printf .*\\$" .github/workflows || true
    ```
  - 최근 실행된 워크플로 중 self-hosted 러너를 사용한 항목 확인:
    ```
    gh api repos/:owner/:repo/actions/runs --jq '.workflow_runs[] | select(.runner_name != null) | {id, name, head_branch, status, runner_name}'
    ```
  - 로그 내 민감 문자열 검색은 조심해서 해야 합니다(로그에 시크릿이 이미 마스킹되어 있을 수 있음).

대응 절차(발생 시)

1. 우선 해당 러너 즉시 오프라인 처리
   - GitHub UI 또는 API로 러너 비활성화/삭제
2. 관련 토큰 및 시크릿 회수·재발급
   - 노출 가능성이 있는 모든 토큰(GITHUB_TOKEN 외 포함)을 회수하고 재발급
   - 관련 API 키, DB 자격증명, 사내 서비스 토큰 등 우선순위에 따라 회수
3. 최근 워크플로 실행 조사
   - 어떤 워크플로가 언제 실행되었는지, 아티팩트·로그·환경변수에 접근한 흔적이 있는지 확인
   - 워크플로가 외부 네트워크로 데이터를 전송했는지 여부를 조사
4. 호스트 시스템 점검
   - /var/log, /tmp, /home/actionsrunner 등 의심스러운 스크립트나 파일 확인
   - 프로세스 목록에서 이상한 백그라운드 작업 감지
5. 근본 원인 분석 및 재발 방지 조치
   - 권한 최소화, 네트워크 제한, 러너 자동 갱신·폐기 정책 도입 등

실무에서 적용하면 좋은 설정·절차(권장)

- 러너는 전용 계정으로 실행하고 루트 권한으로 실행하지 않기
- 러너용 머신은 정기적으로 재빌드(이미지로 배포)하고, ephemeral한 인스턴스로 교체
- registration token 발급은 자동화로 최소화하고, 발급 로그를 감사
- 워크플로 파일에 대한 PR 검토 규칙과 시크릿 출력 금지 기준라인 추가
- 중요한 시크릿은 환경변수 외에 HashiCorp Vault 같은 비밀관리 솔루션 사용(환경과 정책을 함께)
- 워크플로 권한(GITHUB_TOKEN 권한)을 최소화하여 필요 없는 권한은 제거

![러너 등록·비활성화 과정을 아이콘으로 나타낸 단계별 흐름도](/assets/img/posts/blog/github-actions-self-hosted-runner-secrets-hardening/image-2.webp)
