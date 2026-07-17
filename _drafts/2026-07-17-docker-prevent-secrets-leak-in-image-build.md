---
title: "Docker 이미지 빌드 중 시크릿(Secrets) 노출을 줄이는 실무 기법"
slug: "docker-prevent-secrets-leak-in-image-build"
date: 2026-07-17 10:00:00 +0900
categories: ["Docker", "DevOps", "Security"]
tags: ["docker", "dockerfile", "secrets", "buildkit", "ci-cd"]
image:
  path: /assets/img/posts/blog/docker-prevent-secrets-leak-in-image-build/preview.png
  alt: "Docker 빌드 시크릿 보호 썸네일"
---

오늘은 Docker 이미지 빌드 과정에서 시크릿(secret) — 예를 들어 API 키, 패스워드, 개인 인증서 등 — 이 이미지에 남아 있거나 레포지토리에 유출되는 것을 어떻게 줄일 수 있는지 공부한 내용을 정리해 봅니다. 초보 개발자 관점에서 처음 헷갈렸던 부분과, 실무에서 확인하면 도움이 될 체크포인트를 중심으로 정리합니다. 제 글은 확실한 정답을 제시하려는 목적이 아니라, 제가 학습하면서 믿을 만하다고 느낀 실무적 방법들을 차근차근 정리한 것입니다. 틀릴 수 있다고 생각되는 부분은 그렇게 적어 두었으니 참고로 읽어 주세요.

시작하기 전에 한 문장 요약:
- 빌드 시점의 시크릿은 "절대" 이미지 레이어에 남기지 않는 것이 목표이고, 이를 위해 BuildKit의 --secret, 멀티스테이지 빌드, .dockerignore, CI 비밀 매핑 등을 조심스럽게 조합하면 실무에서 위험을 많이 낮출 수 있습니다.

## 공부하면서 알게 된 점
- ARG와 ENV의 차이: ARG는 빌드 타임 변수로, 기본적으로 이미지 최종 레이어에 남지 않는다고 알려져 있지만, Dockerfile에서 ARG 값을 ENV로 설정하거나 파일에 쓰면 결국 이미지에 남습니다. 그래서 ARG만으로 안전하다고 완전히 믿을 수는 없습니다.
- BuildKit의 --secret 기능: BuildKit에서 제공하는 --secret은 빌드 컨테이너 내부에 임시 파일로 마운트되며, 통상적으로 레이어에 영구 저장되지 않도록 설계되어 있습니다. 다만 잘못 COPY하거나 파일 내용을 이미지 내부로 복사하면 당연히 남습니다.
- 빌드 컨텍스트에 주의: .dockerignore로 민감한 파일을 빌드 컨텍스트에 포함시키지 않는 것이 가장 기본적이고 중요한 실습 방법 중 하나입니다.
- 이미지 검증 방법들: docker history, docker save + tar 추출, dive(레이어 살펴보기), trivy(이미지 스캔), 단순 grep 등으로 의심스러운 문자열을 찾아볼 수 있습니다. 이들 도구를 조합하면 누락된 시크릿을 찾아낼 가능성이 높아집니다.

(중요) 이 글에 적은 방법들이 모든 상황에서 완전 무결하다고 주장하려는 것은 아닙니다. 실제 환경에서는 조직의 정책, CI 도구, 사용 중인 레지스트리의 특성에 따라 달라질 수 있으니, 아래 내용을 실무에 바로 적용하기 전에는 테스트하고 검증하세요.

## 처음에는 헷갈렸던 부분
- "도커 빌드 중에 쓰인 ARG 값이 이미지에 남지 않나?" — ARG 자체는 최종 이미지 메타데이터에 직접적으로 보관되지 않지만, 다음과 같은 실수로 인해 노출될 수 있습니다.
  - Dockerfile에서 ARG를 ENV로 복사한 경우
  - 빌드 중 파일 생성 시 해당 ARG 값을 파일에 쓰는 경우 (예: RUN echo "$MY_SECRET" > /tmp/key)
  - 캐시 레이어에 내용이 남는 경우
- "BuildKit의 --secret은 무조건 안전한가?" — BuildKit 설계상 임시로 마운트되어 레이어에 남지 않도록 되어 있지만, 실수로 복사하면 남습니다. 그리고 일부 오래된 Docker 엔진/빌드 환경에서는 이 기능을 지원하지 않거나 동작 방식이 다를 수 있습니다.

아래 예시로 몇 가지 상황과 팁을 정리합니다.

## 실무적 기법과 예시

1) .dockerignore로 빌드 컨텍스트에서 시크릿 파일 제외하기
- 가장 쉬운 시작점은 민감한 파일을 빌드 컨텍스트에 넣지 않는 것.
- 예: 레포지토리에 .env, .pem, private keys 같은 파일을 절대 포함시키지 않는 규칙을 둡니다.

.dockerignore 예시:
```
# .dockerignore
.env
*.pem
secrets/
node_modules
```

2) BuildKit의 --secret 사용 (권장되는 패턴 중 하나)
- BuildKit을 활성화하고 --secret을 사용하면 시크릿이 빌드 내부에 임시 파일로 마운트됩니다. 이를 통해 예를 들어 private npm registry 인증을 위한 토큰을 사용하고, 토큰을 이미지에 포함시키지 않을 수 있습니다.

로컬에서 빌드 예시:
```
# BuildKit 활성화
export DOCKER_BUILDKIT=1

# 빌드 (mysecret은 예: ~/.docker/mytoken)
docker build --secret id=mytoken,src=/home/me/.docker/mytoken -t myapp:latest .
```

Dockerfile 예시 (BuildKit 전용 문법이 일부 필요할 수 있음):
```
# syntax=docker/dockerfile:1.4
FROM node:18 AS builder

# mount secret as file during RUN
RUN --mount=type=secret,id=mytoken \
    npm config set //registry.npmjs.org/:_authToken "$(cat /run/secrets/mytoken)" && \
    npm ci && npm run build

FROM nginx:alpine
COPY --from=builder /app/build /usr/share/nginx/html
```

주의: 위 RUN 단계에서 secret 내용을 파일에 직접 넣거나 COPY하면 안 됩니다. 또한 지정한 BuildKit 버전/문법이 필요할 수 있습니다.

3) 멀티스테이지 빌드로 아티팩트만 복사
- 빌드 단계에서 시크릿을 사용하더라도, 최종 이미지에는 빌드 아티팩트(예: 빌드된 바이너리, 정적 파일)만 복사하는 패턴이 안전합니다.
- 위 Dockerfile 예시처럼 builder 스테이지에서 secret을 사용하고, 최종 스테이지에는 필요한 결과물만 COPY합니다.

4) ARG와 ENV 혼동 주의
- 잘못된 예:
```
ARG MY_SECRET
ENV SECRET_VALUE=$MY_SECRET
```
이렇게 하면 ENV로 인해 결국 이미지 안에 값이 남습니다. 빌드 시 값을 전달하더라도 최종 이미지에 남게 됩니다.

5) CI/CD에서 시크릿 다루기
- GitHub Actions 등에서 비밀을 환경변수로 주입하지 말고, 가능한 경우 런너의 임시 파일로 기록한 뒤 BuildKit --secret에 전달하는 방법이 실무에서 쓰입니다.

GitHub Actions 단계 예시 (간단화):
```
- name: Write secret to file
  run: echo "${{ secrets.MY_TOKEN }}" > mytoken && chmod 600 mytoken

- name: Build with BuildKit
  env:
    DOCKER_BUILDKIT: 1
  run: docker build --secret id=mytoken,src=mytoken -t myapp:latest .
```

이때 중요한 점: Actions 로그에 절대 시크릿을 출력하지 않도록 주의하고, 파일을 만들었다면 다음 단계에서 삭제하는 것이 좋습니다.

6) 이미지 검사 및 확인 절차 (실무에서 점검할 것)
- 이미지 레이어 점검:
  - docker history --no-trunc myapp:latest
  - docker image inspect myapp:latest
- 레이어 안 파일 검색 (이미지 tar로 추출):
```
docker save myapp:latest -o myapp.tar
mkdir img && tar -xf myapp.tar -C img
# 각 레이어 tar를 풀어 grep
for f in img/*.tar; do mkdir tmp && tar -xf "$f" -C tmp && grep -R --line-number "SECRET_KEY_VALUE" tmp || true; rm -rf tmp; done
```
- 도구 사용:
  - dive: 이미지의 각 레이어와 파일 변경사항을 시각적으로 확인할 수 있습니다.
    - 설치 후: dive myapp:latest
  - trivy: 이미지 취약점 및 파일 내용으로 비밀 키 형태의 데이터가 있는지 스캔할 수 있습니다.
    - trivy image --security-checks secret myapp:latest
  - gitleaks / detect-secrets: 레포에서 시크릿이 커밋되었는지 확인

7) 로컬 빌드 캐시와 CI 캐시 주의
- 빌드 캐시나 레이어 캐시를 공유하는 환경에서는 과거에 실수로 남긴 시크릿이 캐시로 보존돼 있을 수 있습니다. 캐시를 청소하거나 새로운 빌드 컨텍스트로 테스트해 보는 것이 안전합니다.

## 실무에서는 이렇게 확인하면 좋겠다 (체크포인트)
- .dockerignore에 민감파일이 있는지 확인
- Dockerfile에서 ARG -> ENV로 복사하는 곳이 없는지 검토
- BuildKit 사용 시 --secret을 활용하고, secret이 파일로 결국 COPY되는 부분이 없는지 확인
- 멀티스테이지 빌드를 사용해 빌드 아티팩트만 최종 스테이지로 복사
- CI에서는 시크릿을 직접 로그에 찍지 않도록 설정, 임시 파일로만 전달 후 파기
- 빌드 완료 후 dive, docker history, docker save + grep, trivy 등으로 이미지를 검사
- 레지스트리에 push 전에 이미지 스캔 규칙을 통과시키기 (이미지 서명/스캔 정책을 적용할 것)

이미지로 개념을 간단히 정리해 봤습니다.

![도커 이미지 보안 개념 일러스트](/assets/img/posts/blog/docker-prevent-secrets-leak-in-image-build/image-1.webp)
이미지 출처: AI 생성 이미지

이미지도 하나 더 — 빌드 시크릿 흐름을 단순화한 다이어그램입니다.

![빌드 시크릿 흐름 다이어그램](/assets/img/posts/blog/docker-prevent-secrets-leak-in-image-build/image-2.webp)
이미지 출처: AI 생성 이미지

## 자주하는 실수와 회피 방법 (경험 기반)
- 실수: 개발 편의상 .env 파일을 레포에 포함하고, docker build 컨텍스트에 넣음 → 회피: 모든 비밀은 레포 외부에서 관리하고 .dockerignore로 차단
- 실수: RUN echo "$SECRET" > /app/key.pem 처럼 이미지 내부에 직접 쓰기 → 회피: 비밀은 런타임에 주입하거나 BuildKit secret으로 임시 마운트, 빌드 시 생성한 파일은 절대 COPY 하지 않기
- 실수: CI 스크립트에서 set -x나 echo로 비밀 출력 → 회피: CI에서 비밀을 출력하지 않도록 옵션 비활성화, 로그 필터링

## 간단한 실습 시나리오 (해보면 도움이 되는 실무 연습)
1. 간단한 Dockerfile 작성 (시크릿 없이)로 기본 이미지 빌드
2. 로컬에서 .env 파일을 만들고 .dockerignore 없이 빌드하여 이미지 내부에 노출되는지 확인
3. .dockerignore 추가 후 재빌드로 차단되는지 확인
4. BuildKit --secret 사용해 같은 작업을 해보고, 이미지에 시크릿이 남지 않는지 검사(dive, trivy)
5. CI에서 임시 파일로 시크릿을 넘기고 빌드하는 흐름을 구성해 로그를 확인

이 과정을 통해 어디에서 위험이 발생하는지 더 명확히 체감할 수 있을 것입니다.

## 실무 체크리스트
- [ ] 레포지토리에 시크릿 파일(.env, *.pem 등)이 커밋되어 있지 않은지 확인 (gitleaks 등으로 검사)
- [ ] .dockerignore에 민감 파일/경로가 포함되어 있는지 확인
- [ ] Dockerfile에서 ARG를 ENV로 복사하는 실수가 없는지 검토
- [ ] BuildKit을 사용 가능하면 --secret으로 시크릿을 주입하도록 CI 파이프라인에 적용
- [ ] 멀티스테이지 빌드로 최종 이미지에는 아티팩트만 포함되도록 구성
- [ ] 빌드 로그/CI 로그에 시크릿이 찍히지 않도록 설정
- [ ] 빌드 후 이미지 검사(dive, docker history, docker save+grep, trivy) 절차를 수행
- [ ] 레지스트리에 푸시 전 자동 스캔(취약점/시크릿 검출) 파이프라인을 두었는지 확인
- [ ] 캐시(빌드 캐시, 레지스트리 등)에 민감한 정보가 남아있지 않은지 고려

마지막으로: 이 글은 제가 실무에서 적용해보려고 정리한 체크리스트와 방법들입니다. 환경마다 차이가 있어서 바로 적용하기 전에 테스트 환경에서 검증해 보시길 권합니다. 질문이나 더 깊게 다뤄보고 싶은 사례가 있으면 알려 주세요 — 함께 실험해 보며 정리해 보겠습니다.