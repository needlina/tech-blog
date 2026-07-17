---
title: "대형 레포에서 Docker 이미지 용량을 레이어별로 실전 최적화하는 방법"
description: "오늘은 대형 레포(여러 서비스/마이크로서비스가 모여 있는 저장소)에서 Docker 이미지 용량을 레이어별로 분석하고 실전에서 줄이는 방법을 정리해봤습니다"
slug: "docker-image-layer-optimization"
date: 2026-07-16 10:00:00 +0900
categories: ["Docker", "DevOps"]
tags: ["docker", "dockerfile", "buildkit", "이미지최적화", "레이어분석"]
image:
  path: /assets/img/posts/blog/docker-image-layer-optimization/preview.png
  alt: "Docker 이미지 레이어 최적화 썸네일"
---

오늘은 대형 레포(여러 서비스/마이크로서비스가 모여 있는 저장소)에서 Docker 이미지 용량을 레이어별로 분석하고 실전에서 줄이는 방법을 정리해봤습니다. 초보 개발자인 제가 하나씩 공부하면서 정리한 내용이라, 모르는 부분은 조심스럽게 적고 실무에서 확인해볼 체크 포인트 중심으로 작성합니다. 처음에는 개념과 도구가 혼동되었는데, 실전에서 바로 써볼 수 있는 절차와 예시를 중심으로 풀어봅니다.

요약(짧게)

- 레이어를 의식하면 원인 파악이 쉬워집니다.
- multi-stage 빌드, 캐시, .dockerignore, 불필요한 파일 제거가 핵심입니다.
- BuildKit의 --mount=type=cache 같은 기능으로 빌드 속도와 이미지 크기 사이의 트레이드오프를 관리할 수 있습니다.
- 실무에서는 도구(dive, docker history 등)로 레이어별 원인을 확인하고, 공통 베이스 이미지 사용 혹은 슬림(base images) 전환을 고려하면 좋습니다.

![Docker 이미지 레이어 구조를 단순한 블록으로 나타낸 기술 개념 일러스트](/assets/img/posts/blog/docker-image-layer-optimization/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점

- Docker 이미지는 여러 레이어(명령어마다 쌓이는 스냅샷)로 구성되어 있고, 가장 큰 비중을 차지하는 건 보통 RUN/ADD/COPY로 추가된 파일들이었습니다.
- 같은 파일을 여러 레이어에서 반복적으로 추가하면 이미지가 불필요하게 커지네요. 예를 들어 빌드 중 생성된 임시 파일을 지웠더라도 그 파일이 생성된 레이어는 남아있어 용량을 줄이지 못하는 경우가 있었습니다.
- multi-stage 빌드는 빌드 도구와 런타임을 분리해 최종 이미지 크기를 크게 줄여주었습니다. Go, Rust, Node 같은 언어에서 특히 효과가 있었습니다.
- apt, pip, npm 등 패키지 매니저가 남기는 캐시(apt lists, pip cache, npm cache)는 빌드 레이어에 그대로 남을 수 있어 주의해야 했습니다.

처음에는 헷갈렸던 부분

- "레이어가 정확히 무엇을 포함하는가"와 "각 RUN을 합치면 캐시가 깨지지 않는가"가 헷갈렸습니다. 요약하면, 각 Dockerfile 명령은 새로운 레이어를 만들고, 해당 레이어의 변경사항(파일 추가/삭제 등)이 포함됩니다. 따라서 DELETE(파일 삭제)를 한 레이어가 있어도 이전 레이어에 있던 파일의 데이터는 이미지 전체에서 사라지지 않아서 결과 이미지에서 용량이 줄어들지 않을 수 있습니다. 그래서 가능하면 불필요 파일 생성 자체를 줄이거나, 생성 및 제거를 같은 RUN 명령 안에서 처리해서 하나의 레이어로 만드는 게 좋습니다.
- BuildKit과 기존 빌드 방식의 차이(캐시 전략, --mount=type=cache 같은 기능 제공)는 처음엔 헷갈렸고, CI에서 BuildKit을 켜는 방법도 따로 확인해야 했습니다.

실무에서는 이렇게 확인하면 좋겠다 (절차 중심)

1. 기본 정보 확인
   - 이미지 목록과 사이즈 확인
     docker image ls
   - 전체 디스크 사용량 확인
     docker system df
   - 특정 이미지의 레이어별 정보 확인
     {% raw %}
     docker history --no-trunc --format "{{.ID}}\t{{.Size}}\t{{.CreatedBy}}" 이미지:태그
     {% endraw %}

   예시:

   {% raw %}
   ```
   docker image ls myorg/service-a
   docker system df -v
   docker history --no-trunc --format "{{.ID}}\t{{.Size}}\t{{.CreatedBy}}" myorg/service-a:latest
   ```
   {% endraw %}

2. 레이어 상세 분석
   - dive(https://github.com/wagoodman/dive) 같은 툴로 레이어 내부 파일 구성을 시각적으로 확인하면 원인 파악이 빠릅니다.
   - 로컬에서 간단히 레이어 tar 파일을 추출하여 확인하려면 docker save로 저장 후 tar로 풀어볼 수도 있습니다. (다만 번거로움)

3. Dockerfile 점검 포인트 (우선순위)
   - .dockerignore로 불필요 소스/파일 제외
   - 베이스 이미지 재검토: alpine, slim, distroless 등으로 대체 가능한지 검토
   - multi-stage 빌드 적용: 빌드 도구(컴파일러, node_modules dev deps 등)를 아예 최종 이미지에서 제외
   - RUN 명령 통합: apt-get update && apt-get install && rm -rf /var/lib/apt/lists/\* 처럼 캐시 생성과 제거를 같은 RUN에서 처리
   - 패키지 설치시 --no-install-recommends, pip --no-cache-dir, npm ci --only=production 등 옵션 사용
   - 빌드 캐시 활용: BuildKit의 --mount=type=cache로 빌드 속도는 올리고 이미지는 깨끗하게 유지 가능

유용한 Dockerfile 예시들

- Node (multi-stage)

```
# 빌드 스테이지
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 런타임 스테이지
FROM node:18-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --only=production
CMD ["node", "dist/index.js"]
```

- Go (multi-stage, 결과를 아주 작게)

```
# 빌드
FROM golang:1.20-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o app ./cmd/app

# 런타임
FROM scratch
COPY --from=builder /src/app /app
ENTRYPOINT ["/app"]
```

- apt 패키지 설치 시 한 줄로 처리 (Ubuntu/Debian)

```
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential ca-certificates && \
    rm -rf /var/lib/apt/lists/*
```

BuildKit 예시: 캐시를 사용한 pip 빌드

```
# syntax=docker/dockerfile:1.4
FROM python:3.11-slim AS builder
WORKDIR /app
COPY pyproject.toml poetry.lock ./
# BuildKit cache for pip/pip wheel cache
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

COPY . .
RUN python -m build

FROM python:3.11-slim
COPY --from=builder /app/dist /app
```

위처럼 cache mount를 사용하면 빌드 속도는 빨라지고 이미지는 불필요한 캐시를 포함하지 않습니다.

실전에서 자주 보는 문제와 대응

- 문제: apt-get install 후 rm -rf /var/lib/apt/lists/\* 를 깜빡함 → 이미지에 apt lists가 남아 커짐
  대응: 설치와 정리를 같은 RUN에서 처리
- 문제: 빌드 산출물이 여러 레이어에 걸쳐 중복 복사됨 (예: .next, node_modules 등)
  대응: .dockerignore로 소스/테스트/로컬 파일 제외, multi-stage로 빌드 아티팩트만 복사
- 문제: 공통 베이스 이미지가 다르면 캐시 활용이 어려워 여러 서비스가 각각 큰 이미지를 가짐
  대응: 조직 차원에서 공통 베이스 이미지(보안 패치 포함)를 만들고 각 서비스가 이를 사용하도록 유도

레이어별 용량을 스크립트로 빠르게 확인해보기
아래는 docker history 출력에서 레이어 크기와 명령어를 간단히 확인하는 예시 (환경에 따라 포맷 차이 있음):

{% raw %}
```
docker history --no-trunc --format "{{.Size}}\t{{.CreatedBy}}" myorg/service-a:latest | nl -ba
```
{% endraw %}

또는 보다 정교하게 파싱해 상위 N개 레이어를 추려볼 수 있습니다(awk, sort 활용).

정리하면서 드는 조심스러운 팁

- 무조건 "작게" 만드는 것보다 운영 편의성(보안 패치, 빌드 비용, 캐시 유지)과의 균형이 중요하다고 느꼈습니다.
- 이미지를 너무 작게 만들기 위해 디버깅 정보를 완전히 제거하면, 장애 시 문제 원인 파악이 어려울 수 있습니다. 상황에 맞게 debug/production 이미지를 분리하는 전략이 유용합니다.
- 이미지 사이즈 최적화는 반복적인 과정입니다. 한 번 개선했다고 끝나는 게 아니라 CI 파이프라인에 사이즈 검사나 기준을 넣어 변화가 생기면 알 수 있게 하는 게 좋습니다.

CI/빌드 파이프라인에서 확인할 포인트(실무)

- 이미지 빌드 로그에 BuildKit 활성화 여부 확인
- 빌드 후 이미지 사이즈 비교(기준 초과 시 실패)
- 레이어별 상위 N개 명령어/파일 리스트 자동 수집(예: dive를 CI에서 사용하거나 history 파싱)
- 공통 베이스 이미지의 버전 관리 및 재빌드 주기(보안 패치 적용)
- 빌드 캐시 전략(예: builder 캐시를 레지스트리에 저장해 재사용)

실무에서 바로 쓸 수 있는 명령/절차 요약

1. 이미지 사이즈 확인
   docker image ls myorg/service-a
2. 레이어별 확인
   {% raw %}
   docker history --no-trunc --format "{{.ID}}\t{{.Size}}\t{{.CreatedBy}}" myorg/service-a:latest
   {% endraw %}
3. 불필요 이미지 정리(로컬)
   docker image prune -f
   docker system prune -af --volumes
   (주의: 프로덕션에서 사용중인 이미지까지 지우지 않도록 주의)
4. 레시피 적용 후 재빌드 및 비교
   docker buildx build --platform linux/amd64 -t myorg/service-a:latest .
   docker image ls myorg/service-a

제 경험상 작은 단계부터 천천히 개선하는 것이 좋았습니다. 먼저 .dockerignore 정리, 불필요 파일 제거, 패키지 설치/정리 한 줄 구성, 그 다음 multi-stage 적용, 마지막으로 베이스 이미지 변경과 BuildKit 고급 옵션 적용 순서로 진행하면 위험도가 낮고 효과를 바로 확인할 수 있었습니다.

![Dockerfile의 명령(RUN, COPY, FROM)이 레이어에 어떻게 쌓이는지를 보여주는 간단한 다이어그램](/assets/img/posts/blog/docker-image-layer-optimization/image-2.webp)
이미지 출처: AI 생성 이미지

실무 체크리스트

- [ ] .dockerignore에 빌드/테스트/로컬 파일 제외되어 있는가?
- [ ] apt/pip/npm 등 패키지 설치 후 캐시 제거를 같은 RUN에서 처리했는가?
- [ ] multi-stage 빌드로 빌드 도구와 런타임을 분리했는가?
- [ ] 베이스 이미지(또는 조직 공통 베이스)를 재검토했는가(alpine/slim/distroless 등)?
- [ ] docker history 또는 dive로 레이어별 큰 항목을 확인했는가?
- [ ] CI에서 이미지 사이즈 임계값/검사 파이프라인을 마련했는가?
- [ ] BuildKit을 이용해 캐시를 적절히 활용하고 있는가?
- [ ] 로컬 정리(docker system prune 등)로 불필요한 빌드 캐시가 쌓여 있지 않은가?

끝으로, 제가 정리한 방법이 모든 케이스에 딱 맞지는 않을 수 있습니다. 각 레포/서비스 성격(디버깅 필요성, 보안 요구사항, 빌드 빈도 등)에 맞춰 우선순위를 조정하며 적용해 보세요. 혹시 여러분의 환경에서 시도해본 사례나 궁금한 점이 있으면 공유해주시면 같이 보완해보고 싶습니다.
