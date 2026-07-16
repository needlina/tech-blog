---
title: "CI/CD에서 시크릿 안전하게 주입하고 로그 노출 방지하기: 실무 가이드"
slug: "ci-secrets-safe-injection-and-no-log-leak"
date: 2026-07-16 09:00:00 +0900
categories: ["DevOps", "Security"]
tags: ["ci-cd", "secrets-management", "github-actions", "gitlab-ci", "docker"]
image:
  path: /assets/img/posts/blog/ci-secrets-safe-injection-and-no-log-leak/preview.png
  alt: "CI 시크릿 안전 주입 썸네일"
---

오늘은 CI/CD 파이프라인에서 시크릿을 안전하게 다루는 방법을 정리해 봤습니다. 저는 최근에 팀에서 파이프라인 보완 작업을 하면서 여러 문서와 도구를 살펴봤고, 공부한 내용을 초보자 관점에서 차근차근 정리하려 합니다. 처음부터 완벽하진 않아서 틀릴 가능성도 있고, 환경마다 차이가 있으니 실무 적용 시에는 반드시 검증하는 과정을 권합니다.

목표는 간단합니다.

- 파이프라인 환경에서 시크릿을 안전하게 주입하는 방법 파악
- 로그에 시크릿이 노출되는 것을 방지하는 절차와 확인 방법 익히기
- 실무에서 바로 적용해볼 만한 예제(명령어 · 설정 · 점검 절차) 제공

![CI/CD 파이프라인 아이콘들과 보호된 시크릿이 연결된 단순 다이어그램](/assets/img/posts/blog/ci-secrets-safe-injection-and-no-log-leak/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점, 처음에는 헷갈렸던 부분, 그리고 실무에서 확인하면 좋은 포인트를 섹션별로 나눠서 적겠습니다.

## 기본 원칙(제가 정리한 요점)

- 시크릿은 코드(레포지토리), 이미지 레이어(Dockerfile의 ENV 등), 로그에 남기면 안 된다.
- 런타임에서 안전하게 주입하고, 빌드 시에는 BuildKit 같은 기능으로 일시적(never saved) 사용을 고려한다.
- CI 제공자(GitHub Actions, GitLab CI 등)의 "마스킹(masking)"과 "보호(protected)" 기능을 활용한다.
- 저장된 시크릿은 주기적으로 회전(rotate)하고 권한을 최소화한다.
- 자동 스캔(gitleaks, truffleHog 등)과 수동 점검(로그 grep 등)을 조합한다.

---

## 공부하면서 알게 된 점

- GitHub Actions나 GitLab CI의 "secrets"는 편리하지만, 워크플로에서 잘못 사용하면 로그에 그대로 남을 수 있습니다. 예를 들어, 스크립트에서 변수를 echo로 출력하면 워크플로 로그에 값이 뜨죠. 그래서 mask·redact 기능이 중요합니다.
- Dockerfile에서 ENV로 시크릿을 넣으면 이미지 레이어에 남습니다. 이미지가 배포되는 동안 누구나 그 레이어를 검사하면 노출될 수 있습니다. BuildKit의 --secret을 이용하면 레이어에 남기지 않고 빌드 시에만 참조할 수 있어서 유용했습니다.
- Kubernetes Secret은 base64로 인코딩되어 있어 "암호화"된 상태처럼 보이지만 실제로는 쉽게 디코딩됩니다. 그러므로 클러스터 내부 접근 제어와 etcd 암호화 설정이 중요합니다.
- 자동화된 스캔 도구(예: gitleaks)로 과거 커밋까지 검사하는 것이 생각보다 자주 문제를 찾아줬습니다. 실무에서는 사전(Pre-commit), CI 스캔, 주기적 리포트 조합이 안전합니다.

---

## 처음에는 헷갈렸던 부분

- "CI secrets"와 "환경변수"의 차이: 둘 다 키/값 형태지만, CI의 secrets는 대개 UI나 API로 저장되며 접근 제어가 붙습니다. 반면 CI에서 단순 환경변수는 소스코드나 설정파일로 관리될 수 있어 노출 위험이 큽니다.
- 마스킹이 완벽하냐는 질문: 마스킹은 대부분의 경우 로그에서 시크릿 문자열을 가리지만, 시크릿이 복합 문자열 일부만 로그에 노출되거나, 다른 방법으로 누출될 경우(파일로 덤프, 에러 스택 등) 마스킹으로 커버되지 않을 수 있습니다.
- 빌드 시 필요하지만 저장하고 싶지 않은 값 관리: Docker BuildKit의 --secret, GitHub Actions의 secrets, GitLab의 masked variables를 함께 고려하면 해결되는 경우가 많았습니다.

---

## 주요 실무 포인트와 예제

아래는 실제로 제가 실무에서 점검하거나 적용해본(또는 실습해본) 예제들입니다. 환경에 따라 다르게 동작할 수 있으니, 꼭 테스트 환경에서 먼저 확인하세요.

### 1) GitHub Actions: 시크릿 사용과 로그 마스킹

- GitHub 저장소 Settings > Secrets에 시크릿을 등록하고, 워크플로에서 ${{ secrets.MY_SECRET }}로 사용합니다.
- 로그에서 노출 방지를 위해 가능하면 GitHub Actions Toolkit의 core.setSecret 또는 workflow 명령어를 사용해 추가 마스킹합니다.

예:

```yaml
# .github/workflows/ci.yml
name: CI

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Use secret safely
        run: |
          # 위험: 아래처럼 단순 echo는 시크릿이 로그에 찍힐 수 있습니다.
          # echo "secret is ${{ secrets.MY_SECRET }}"

          # 권장: 비공개 값은 직접 출력하지 말고, 툴에서 사용하게 합니다.
          # GitHub에서는 set-secret을 이용하면 자동으로 마스킹됩니다.
          echo "::add-mask::${{ secrets.MY_SECRET }}"
          # 예: API 호출 시 curl에 헤더로 전달
          curl -H "Authorization: Bearer ${{ secrets.MY_SECRET }}" https://example.com/api
```

참고: "::add-mask::" 명령으로 마스킹을 요청할 수 있으나, 모든 로그 경로를 완벽히 가리지는 못할 수 있으니 주의합니다.

### 2) GitLab CI: 보호(protected) 변수와 마스킹

- GitLab에서는 프로젝트 Settings > CI/CD > Variables에서 "Protected"와 "Masked" 옵션을 제공합니다. 보호는 특정 브랜치/태그에서만 노출되게 하고, 마스킹은 로그에서 가립니다.
- .gitlab-ci.yml 내에서 변수 사용시 echo로 직접 출력하지 않도록 합니다.

예:

```yaml
# .gitlab-ci.yml
stages:
  - build

build:
  stage: build
  script:
    - echo "Running build"
    # 사용 예: curl로 전달
    - curl -H "Authorization: Bearer $MY_SECRET" https://example.com/api
```

주의: GitLab의 "masked" 변수는 정규식 조건 등에 의해 일부 값만 마스킹되지 않을 수 있습니다(예: 공백 문자 포함 등).

### 3) Docker 빌드: BuildKit --secret 사용 (레이어에 남기지 않음)

Dockerfile에서 RUN 단계에서만 시크릿을 잠깐 쓰고 싶을 때 BuildKit의 secret mount를 활용합니다(도커 빌드시 BuildKit 활성화 필요).

Dockerfile 예:

```dockerfile
# syntax=docker/dockerfile:1.4
FROM alpine:3.18
RUN apk add --no-cache curl

# build-time secret 사용 예
RUN --mount=type=secret,id=mysecret \
    sh -c 'curl -H "Authorization: Bearer $(cat /run/secrets/mysecret)" https://example.com/api'
```

빌드 명령:

```bash
# 로컬 파일을 시크릿으로 전달
DOCKER_BUILDKIT=1 docker build --secret id=mysecret,src=./my_secret.txt -t myimage:latest .
```

주의: 절대 Dockerfile에 ENV로 시크릿을 하드코딩하거나, RUN에서 echo로 파일로 저장해 이미지 레이어에 남기지 않도록 합니다.

### 4) Kubernetes: Secret 생성과 점검

- 민감 정보는 kubernetes Secret으로 관리하지만, Secret 값은 base64로 인코딩되어 저장되므로 etcd 암호화와 RBAC 접근 제어가 중요합니다.
- 시크릿 치명 노출 여부 점검 명령 예:

시크릿 생성:

```bash
kubectl create secret generic my-secret \
  --from-literal=API_KEY='supersecretvalue' \
  -n my-namespace
```

값 확인(관리자가 필요):

```bash
kubectl get secret my-secret -n my-namespace -o jsonpath='{.data.API_KEY}' | base64 --decode
```

포드에서 시크릿 마운트 예:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  containers:
    - name: app
      image: myimage:latest
      env:
        - name: API_KEY
          valueFrom:
            secretKeyRef:
              name: my-secret
              key: API_KEY
```

주의: kubectl describe로는 값이 직접 노출되지 않지만, get -o yaml/ json로는 base64가 보입니다. 실제로 외부에 붙여넣기 하지 않도록 주의하세요.

### 5) 로컬/서버 로그 점검 명령들

실무에서는 로그/아티팩트/이미지/커밋 등 다양한 곳에서 시크릿이 숨어있을 수 있으니 점검 목록을 만들었습니다.

- 레포지토리 과거 커밋 스캔
  - gitleaks 사용:
    ```bash
    gitleaks detect --source . --report-path gitleaks-report.json
    ```
  - truffleHog:
    ```bash
    trufflehog --json . > trufflehog-report.json
    ```

- 레포지토리 텍스트 검색(간단)

  ```bash
  # 패턴 예: "password=" 형태로 검색
  git grep -n "password" || true
  # 전체 커밋 이력 검색(느림)
  git log -p -S "API_KEY" || true
  ```

- 서버/컨테이너 로그에서 의심 문자열 검색

  ```bash
  # 시스템 로그에서 특정 키워드 검색
  sudo journalctl -u gitlab-runner | grep -i "token\|password\|secret" -n || true

  # 도커 컨테이너 로그
  docker logs my-runner-container 2>&1 | grep -i "password\|token\|secret" || true

  # 쿠버네티스 파드 로그
  kubectl logs -n ci-runner my-runner-pod | grep -i "password\|token" || true
  ```

- 이미지 내부 파일 검사(의심스러운 값 유무)
  ```bash
  docker run --rm -it myimage:latest /bin/sh -c "grep -R 'API_KEY\|password' / || true"
  ```

---

## 실무에서는 이렇게 확인하면 좋겠다

제가 실제로 권장하는 점검 흐름은 다음과 같습니다. 모든 항목은 환경에 맞춰 조정하세요.

1. 레포지토리 초기 검사: gitleaks/truffleHog로 전체 이력 스캔.
2. CI 파이프라인 설정 검토: 워크플로에서 시크릿이 echo 되거나 아티팩트에 저장되지 않는지 확인.
3. 빌드 설정 검토: Dockerfile에 ENV로 시크릿이 들어가 있지 않은지, BuildKit --secret 사용 여부 확인.
4. 런타임 점검: 배포된 컨테이너/파드 로그, 어플리케이션 로그, 서버 로그에 시크릿 문자열이 노출되는지 grep으로 확인.
5. 접근 제어 검토: GitHub/GitLab에서 시크릿 접근 권한(Protected, Environment 제한 등) 확인.
6. 주기적 스캔: 주기 잡으로 자동 스캔을 돌려서 신속히 알림을 받도록 설정.
7. 사고 시 회전 계획: 만약 노출이 의심되면 해당 시크릿을 즉시 폐기(rotate)하는 절차를 마련.

---

## 코드와 설정 요약(핵심 예제 모음)

- GitHub Actions: secrets 사용 + add-mask
- GitLab CI: masked/protected 변수 사용
- Docker BuildKit: --secret 사용
- Kubernetes: Secret 생성 및 값 디코딩 명령
- 스캔 도구: gitleaks / trufflehog / git-secrets

위 예제들은 글 중에 이미 포함되어 있으니, 실제로는 각자의 CI/CD 환경에 맞춰 작은 실습을 통해 검증하는 것을 권합니다.

---

## 주의할 점(제가 조심스럽게 적는 팁)

- "마스킹"이 모든 노출 경로를 막지는 못합니다. 예를 들어 시크릿이 로그의 일부로 조합되어 출력되면 masking 패턴과 일치하지 않을 수 있습니다.
- 시크릿이 아카이브(artifact)에 포함될 가능성도 생각해야 합니다. 빌드 아티팩트와 워크스페이스에 민감한 파일이 들어가지 않도록 설정하세요.
- 저장된 시크릿은 주기적으로 회전하고, 사용하지 않는 시크릿은 삭제하세요.
- 로컬 개발자의 실수(예: .env 파일을 깃에 올리는 것)로도 노출이 발생하니, 개발자 교육과 pre-commit 훅이 중요합니다.

![빌드 단계에서 시크릿이 일시적으로 사용되는 모습(레이어에 저장되지 않는 빌드 프로세스 개념도)](/assets/img/posts/blog/ci-secrets-safe-injection-and-no-log-leak/image-2.webp)
이미지 출처: AI 생성 이미지

## 실무 체크리스트

- [ ] 레포지토리 전체(commit 포함)를 gitleaks 등으로 스캔했는가?
- [ ] CI 제공자(또는 self-hosted)에서 시크릿을 "protected"/"masked"로 설정했는가?
- [ ] 워크플로/스크립트 내에서 시크릿을 echo 하거나 아티팩트로 남기지 않도록 했는가?
- [ ] Dockerfile에 ENV로 시크릿을 하드코딩하지 않았는가? BuildKit --secret 사용 검토 완료했는가?
- [ ] Kubernetes Secret 접근 권한(RBAC), etcd 암호화 설정을 점검했는가?
- [ ] 로그(서버/컨테이너/쿠버네티스)에서 민감 문자열을 정기적으로 스캔하도록 했는가?
- [ ] 시크릿 누출 시 회전(rotate) 절차와 책임자가 명확한가?
- [ ] 개발자 대상의 간단한 가이드 또는 pre-commit 훅을 배포했는가?

마지막으로, 이 글은 제가 공부하면서 정리한 초안입니다. 환경별로 세부 동작이 다를 수 있으니, 중요한 변경을 실무에 적용하기 전에 반드시 테스트 환경에서 검증하고 팀의 정책과 맞춰 적용하세요. 추가로 다뤄보고 싶은 도구(예: HashiCorp Vault 연동, AWS Secrets Manager, Azure Key Vault 등)가 있으면 알려주시면 다음 글에서 이어서 정리하겠습니다.
