---
title: "폐쇄망 GitLab CI/CD에서 Node.js 빌드하기: npm install 없이 Docker 이미지로 해결한 방법"
description: "고객사 폐쇄망 GitLab CI/CD 환경에서 Node.js 버전 차이, npm repository 부재, npm-cache와 node_modules 반입 문제를 Docker 이미지로 우회하며 정리한 실무 기록"
slug: "gitlab-cicd-closed-network-node-docker-npm-cache"
date: 2026-07-28 00:00:00 +0900
categories: ["DevOps", "Docker"]
tags:
  [
    "gitlab-ci",
    "cicd",
    "nodejs",
    "docker",
    "npm-cache",
    "closed-network",
    "nexus"
  ]
image:
  path: /assets/img/posts/blog/gitlab-cicd-closed-network-node-docker-npm-cache/preview.png
  alt: "폐쇄망 GitLab CI/CD에서 Node.js 프로젝트 빌드하기"
---

# 폐쇄망 GitLab CI/CD에서 Node.js 빌드하기: npm install 없이 Docker 이미지로 해결한 방법

최근 회사에서 개발한 프로젝트를 고객사의 GitLab CI/CD 환경에 적용하는 작업을 진행했다.  
일반적인 환경이라면 `.gitlab-ci.yml`에 빌드 스크립트를 작성하고, 필요한 Node.js 버전과 npm install 환경만 맞추면 크게 어렵지 않았을 것이다.

하지만 이번에는 조금 달랐다.

고객사는 GitLab CI/CD를 사용하고 있었지만, 프로젝트에서 사용하는 Node.js 버전과 고객사 서버에 설치된 Node.js 버전이 달랐다. 우리가 개발한 프로젝트는 Node.js 22 기준이었고, 고객사 환경에는 Node.js 18 버전이 준비되어 있었다.

게다가 더 큰 문제는 npm repository, 예를 들면 Nexus 같은 사내 npm 저장소가 아직 구축되어 있지 않다는 점이었다. 고객사 환경은 외부 인터넷 접근이 제한된 폐쇄망이었기 때문에 CI/CD 과정에서 `npm install`을 자유롭게 실행할 수 없는 상황이었다.

## 문제는 Node 버전만이 아니었다

처음에는 단순히 Node.js 버전 문제라고 생각했다.

고객사 개발 서버와 운영 서버에 Node.js 22를 설치하고, 각 서버에서 직접 빌드를 수행하면 되지 않을까 하는 방식도 검토했다.

예를 들면 이런 흐름이다.

```bash
npm install
npm run build
```

그리고 빌드된 결과물을 각 서버에 배포하는 방식이다.

하지만 이 방식에는 몇 가지 아쉬운 점이 있었다.

첫째, 이미 준비해 둔 설치 스크립트를 수정해야 했다.  
둘째, 개발 서버와 운영 서버에 각각 Node.js를 설치하고 관리해야 했다.  
셋째, 서버마다 빌드 환경이 미묘하게 달라질 수 있었다.  
넷째, 장기적으로 봤을 때 CI/CD 환경의 통일성이 떨어질 수 있었다.

특히 고객사 환경처럼 변경 절차가 까다로운 곳에서는 서버에 직접 런타임을 설치하는 방식이 생각보다 부담이 될 수 있다.

## Docker 이미지로 방향을 바꾸다

그래서 방향을 바꿨다.

실무에서 많이 사용해 본 방식은 아니었지만, 이번에는 Docker 이미지를 만들어 고객사에 전달하는 방식을 선택했다.

핵심 아이디어는 단순하다.

> 빌드에 필요한 Node.js, npm, npm-cache, node_modules 환경을 Docker 이미지 안에 최대한 포함해서 전달한다.

이렇게 하면 고객사 GitLab CI/CD에서는 우리가 전달한 Docker 이미지를 기반으로 빌드를 수행할 수 있다. 서버에 Node.js를 직접 설치하지 않아도 되고, 개발/운영 환경 사이의 차이도 줄일 수 있다.

## 폐쇄망에서 가장 큰 문제는 npm install이다

폐쇄망 환경에서 Node.js 프로젝트를 빌드할 때 가장 먼저 부딪히는 문제는 `npm install`이다.

인터넷이 되는 환경이라면 npm registry에서 패키지를 내려받으면 된다.  
사내 Nexus나 Verdaccio 같은 npm repository가 있다면 그쪽을 바라보게 설정하면 된다.

하지만 이번 고객사 환경에는 npm repository가 없었다.

즉, CI/CD가 실행되는 시점에 외부 npm registry로 접근할 수 없고, 내부 npm repository에서도 패키지를 받을 수 없었다.

결국 필요한 의존성을 외부에서 미리 준비해서 폐쇄망 안으로 반입해야 했다.

## npm-cache와 node_modules를 이미지에 포함하기

이번에 선택한 방식은 Docker 이미지 안에 빌드에 필요한 요소를 함께 넣는 것이었다.

이미지에는 다음 요소들을 포함했다.

- Node.js 22
- npm
- 프로젝트 빌드에 필요한 npm-cache
- 프로젝트의 node_modules
- 추가로 활용할 수 있는 깨끗한 Node.js/NPM 기본 이미지들

특히 npm-cache와 node_modules를 함께 준비한 이유는 폐쇄망 안에서 패키지 다운로드 없이 빌드를 수행하기 위해서다.

CI/CD 입장에서는 외부 네트워크 없이도 이미 준비된 의존성을 활용해서 빌드할 수 있어야 한다. 그래서 단순히 Node.js만 설치된 이미지가 아니라, 프로젝트 의존성까지 고려한 이미지가 필요했다.

## 예시 Dockerfile

실제 고객사 정보와 프로젝트 이름은 공개할 수 없으므로, 구조만 단순화하면 아래와 같은 방식이다.

```dockerfile
FROM node:22

WORKDIR /app

COPY package.json package-lock.json ./
COPY .npm-cache /root/.npm
COPY node_modules ./node_modules

COPY . .

RUN node -v
RUN npm -v
RUN npm run build
```

여기서 핵심은 `node:22` 기반 이미지 위에 npm cache와 `node_modules`를 함께 올려두는 것이다. 일반적인 환경이라면 Dockerfile 안에서 `npm ci`를 실행하는 편이 더 자연스럽다.

```dockerfile
FROM node:22

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
```

하지만 이번 환경에서는 고객사 내부에서 npm registry에 접근할 수 없었다. 그래서 폐쇄망 안에서 패키지를 새로 내려받는 방식이 아니라, 외부망에서 미리 준비한 의존성을 이미지에 포함해 반입하는 방식을 선택했다.

다만 이 방식은 권장 아키텍처라기보다 **npm repository가 없는 폐쇄망 환경에서 선택한 우회 방식**에 가깝다. npm cache는 말 그대로 cache이고, [npm 공식 문서](https://docs.npmjs.com/cli/cache/)에서도 npm cache를 패키지 저장소처럼 신뢰하는 용도로 보지는 않는다. 그래서 장기적으로는 내부 Nexus, Verdaccio, GitLab Package Registry 같은 사내 npm repository를 두는 편이 더 안정적이다.

## GitLab CI/CD 설정 예시

고객사에서 사용한 설정을 그대로 공개할 수는 없지만, 핵심 구조는 아래처럼 단순하게 볼 수 있다.

```yaml
image: registry.internal.example.com/frontend/node22-project-cache:2026-07-28

stages:
  - build

build:
  stage: build
  script:
    - node -v
    - npm -v
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 week
```

여기서 중요한 부분은 `image`다. GitLab Runner가 실행될 때 고객사 내부 registry에 반입된 Docker 이미지를 사용하도록 맞춘다.

`script`에서는 별도의 `npm install`이나 `npm ci`를 수행하지 않고 바로 빌드를 실행한다. 이미 이미지 안에 빌드에 필요한 `node_modules`가 들어 있다고 가정했기 때문이다.

빌드 결과물이 프론트엔드 정적 파일이라면 `artifacts.paths`에 `dist/` 또는 `build/` 디렉터리를 지정한다. 프로젝트에 따라 실제 산출물 경로는 달라질 수 있다.

```yaml
artifacts:
  paths:
    - build/
```

운영 배포 단계가 별도로 있다면 `deploy` stage를 추가할 수 있지만, 이번 글에서는 폐쇄망에서 Node.js 빌드 환경을 맞추는 문제가 핵심이므로 build 단계까지만 예시로 두는 편이 이해하기 쉽다.

## Docker 이미지 반입 절차

폐쇄망 환경에서는 CI/CD가 외부 Docker Hub에서 `node:22` 이미지를 직접 가져올 수 없다. 따라서 외부망에서 이미지를 만들고 파일로 저장한 뒤, 고객사 반입 절차를 거쳐 내부망에서 다시 로드해야 한다.

외부망에서는 먼저 이미지를 빌드한다.

```bash
docker build -t frontend-node22-build:2026-07-28 .
```

그 다음 이미지를 tar 파일로 저장한다.

```bash
docker save -o frontend-node22-build-2026-07-28.tar frontend-node22-build:2026-07-28
```

이 tar 파일을 고객사 보안 반입 절차에 맞게 전달한다. 폐쇄망 내부에서는 다음처럼 이미지를 다시 로드한다.

```bash
docker load -i frontend-node22-build-2026-07-28.tar
```

만약 고객사 내부 Docker registry가 있다면, 내부 registry 주소에 맞게 태그를 다시 붙인다.

```bash
docker tag frontend-node22-build:2026-07-28 registry.internal.example.com/frontend/node22-project-cache:2026-07-28
```

그리고 내부 registry로 push한다.

```bash
docker push registry.internal.example.com/frontend/node22-project-cache:2026-07-28
```

이후 `.gitlab-ci.yml`에서는 내부 registry의 이미지를 바라보게 한다.

```yaml
image: registry.internal.example.com/frontend/node22-project-cache:2026-07-28
```

내부 registry가 없다면 GitLab Runner가 실행되는 서버에 직접 `docker load`한 이미지를 사용해야 한다. 다만 Runner 실행 방식과 executor 설정에 따라 로컬 Docker 이미지 사용 가능 여부가 달라질 수 있으므로, 이 부분은 고객사 GitLab Runner 구성을 함께 확인해야 한다.

## 이 방식의 한계: package.json이 바뀌면 이미지도 바뀐다

물론 이 방식이 완벽한 해결책은 아니다.

가장 큰 한계는 `package.json` 또는 `package-lock.json`이 변경될 때마다 Docker 이미지를 다시 만들어야 한다는 점이다.

새로운 패키지가 추가되거나 기존 패키지 버전이 바뀌면, 기존 이미지에 들어 있는 npm-cache나 node_modules만으로는 빌드가 실패할 수 있다.

즉, 의존성이 바뀔 때마다 다음 작업이 필요해진다.

```text
package.json 변경
→ 외부망에서 npm install 또는 npm ci 수행
→ npm-cache/node_modules 갱신
→ Docker 이미지 재생성
→ 고객사 폐쇄망 반입
→ GitLab CI/CD 이미지 교체
```

다행히 이번 프로젝트에서는 package.json이 자주 변경될 가능성이 높지 않았다. 그래서 우선은 이 방식으로 진행해도 운영상 큰 문제는 없을 것이라고 판단했다.

하지만 장기적으로는 더 나은 방식도 검토할 필요가 있다.

그리고 `node_modules`를 이미지에 포함하는 방식에는 몇 가지 주의점이 있다.

- 이미지 크기가 커진다.
- `package-lock.json` 기준으로 의존성을 고정해야 한다.
- OS나 CPU 아키텍처가 달라지면 일부 네이티브 모듈에서 문제가 생길 수 있다.
- 패키지 보안 취약점과 라이선스 검토 책임이 이미지 안으로 함께 들어온다.
- 의존성 변경이 생기면 이미지 생성, 반입, registry push 과정을 다시 반복해야 한다.

그래서 이 방식은 “변경이 적은 프로젝트를 폐쇄망에 빠르게 올려야 하는 상황”에는 쓸 수 있지만, 여러 프로젝트가 계속 배포되는 환경이라면 내부 npm repository를 구축하는 쪽이 더 낫다.

## 왜 깨끗한 Node/NPM 이미지도 함께 전달했나

이번에 고객사에 전달한 이미지는 프로젝트 빌드 전용 이미지뿐만이 아니었다.

Node.js와 npm만 설치된 깨끗한 버전의 이미지도 여러 개 함께 반입했다.

이유는 나중에 고객사가 npm repository를 구축할 가능성이 있었기 때문이다. 향후 Nexus 같은 내부 npm repository가 준비된다면, 프로젝트별 node_modules를 이미지에 포함하지 않고도 CI/CD에서 필요한 패키지를 내부 저장소로부터 설치할 수 있다.

그때는 지금보다 훨씬 일반적인 구조로 바꿀 수 있다.

예를 들면 다음과 같은 방식이다.

```yaml
image: node:22

stages:
  - build

build:
  stage: build
  script:
    - npm ci
    - npm run build
```

물론 실제 폐쇄망에서는 `node:22` 이미지를 외부에서 직접 가져올 수 없기 때문에, 내부 Docker registry에 반입된 Node 이미지를 사용해야 한다.

하지만 npm repository만 준비된다면 현재처럼 프로젝트 의존성을 이미지에 강하게 묶어둘 필요는 줄어든다.

## 다른 선택지는 무엇이 있었을까

이번에는 Docker 이미지에 npm-cache와 node_modules를 포함하는 방식을 선택했지만, 상황에 따라 다른 방법도 가능하다.

첫 번째는 고객사 내부에 Nexus나 Verdaccio 같은 npm repository를 구축하는 방식이다.  
이 방식이 가장 정석에 가깝다. 의존성 관리가 쉬워지고, package.json이 변경되어도 이미지를 매번 교체하지 않아도 된다.

두 번째는 빌드 결과물만 외부에서 만들어 반입하는 방식이다.  
프론트엔드 프로젝트라면 외부 빌드 환경에서 `dist`나 `build` 결과물을 만들고, 고객사에는 정적 파일만 전달하는 방식도 가능하다. 다만 고객사 CI/CD에서 직접 빌드해야 한다는 요건이 있다면 맞지 않을 수 있다.

세 번째는 서버에 Node.js를 직접 설치하는 방식이다.  
가장 단순해 보이지만 서버별 환경 차이가 생길 수 있고, 운영 서버에 빌드 도구를 설치하는 것 자체가 부담이 될 수 있다.

네 번째는 Docker 이미지와 내부 registry를 함께 운영하는 방식이다.  
폐쇄망 안에 Docker registry가 있다면, 필요한 Node 이미지와 프로젝트 빌드 이미지를 내부 registry에 올려두고 GitLab Runner에서 사용하는 구조를 만들 수 있다.

## 정리

이번 작업을 하면서 폐쇄망 환경에서 CI/CD를 구성할 때는 단순히 빌드 스크립트만 볼 것이 아니라는 점을 다시 느꼈다.

특히 Node.js 프로젝트는 npm registry 접근이 자연스럽게 전제되는 경우가 많다. 하지만 폐쇄망에서는 이 전제가 깨진다.

그래서 다음 질문들을 먼저 확인하는 것이 중요하다.

- GitLab Runner는 어떤 방식으로 실행되는가?
- Docker 이미지를 사용할 수 있는가?
- 내부 Docker registry가 있는가?
- Node.js 버전은 프로젝트와 맞는가?
- npm repository 또는 Nexus가 있는가?
- 외부 패키지를 폐쇄망으로 반입하는 절차가 있는가?
- package.json 변경이 얼마나 자주 발생하는가?

이번에는 npm repository가 없는 환경이었기 때문에 Node.js, npm, npm-cache, node_modules를 포함한 Docker 이미지를 만들어 전달하는 방식으로 해결했다.

다만 이 방식은 package.json이 변경될 때마다 이미지를 다시 만들어야 하는 한계가 있다. 장기적으로는 고객사 내부에 npm repository를 구축하고, Node.js 기본 이미지를 내부 registry에서 관리하는 구조가 더 안정적일 수 있다.

폐쇄망 GitLab CI/CD 환경에서는 “빌드가 되느냐”보다 “빌드에 필요한 모든 것을 어디서 가져올 수 있느냐”가 더 중요한 문제가 된다. 이번 작업은 그 차이를 체감한 경험이었다.
