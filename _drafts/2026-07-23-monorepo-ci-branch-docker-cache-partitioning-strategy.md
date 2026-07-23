---
title: "Monorepo CI에서 브랜치별 Docker 레이어 캐시 충돌 없이 분할·재사용하는 현실적인 전략"
description: "Monorepo 환경에서 브랜치별 캐시 충돌 방지, 레이어 분할 기준, 레지스트리 캐시 사용법, GitHub Actions·buildx 예제, 확인 명령과 실패 증상 점검 포인트"
slug: "monorepo-ci-branch-docker-cache-partitioning-strategy"
date: 2026-07-23 12:00:00 +0900
categories: ["DevOps", "CI/CD"]
tags: ["docker", "monorepo", "ci-cd", "배포자동화", "docker-cache"]
image:
  path: /assets/img/posts/blog/monorepo-ci-branch-docker-cache-partitioning-strategy/preview.png
  alt: "모노레포 Docker 캐시 분할 썸네일"
---

로컬에서 잘 빌드되는데 여러 브랜치가 동시에 CI를 돌리면 캐시가 엉키거나 오래된 레이어가 재사용되는 문제가 자주 발생한다면, 브랜치별로 **캐시 키를 분리**하면서도 공통 레이어는 재사용하도록 빌드 단계(스테이지)를 나누고 레지스트리 기반 캐시를 활용하는 전략이 현실적인 해법이 될 수 있습니다. 실무에서 우선 확인할 항목은 1) 캐시 식별자(태그) 생성 규칙, 2) 캐시 저장소(레지스트리) 접근 권한과 비용, 3) 각 스테이지의 변경 빈도에 따른 분할 기준입니다.

공부하면서 알게 된 점
- Monorepo의 공통 의존성(예: 툴체인, 라이브러리 설치)은 자주 바뀌지 않는 편이라 **별도 레이어로 분리하면 재사용성이 높아진다**.
- 브랜치 단위로 동일한 캐시 태그를 쓰면 캐시 충돌이 발생하고, 반대로 브랜치마다 완전히 분리하면 캐시 히트율이 크게 떨어져 비용과 시간 낭비가 된다.
- 레지스트리 기반 캐시(예: registry as cache-to/cache-from)는 대체로 안정적이지만, 캐시 보존 정책과 스토리지 비용을 반드시 확인해야 한다.

처음에는 헷갈렸던 부분
- "캐시 키를 언제 갱신해야 하는가?" — 코드 변경, 의존성 변경, 베이스 이미지 업데이트 등 원인을 구분해야 한다. 모든 변경에 캐시를 버리면 효과가 없다.
- GitHub Actions 또는 다른 CI에서 레이어 캐시를 레지스트리에 푸시할 때 권한 범위와 토큰 만료로 인해 푸시 실패가 발생할 수 있다는 점을 미처 생각하지 못했다.
- buildx의 cache-from과 cache-to 사용법, 특히 `type=registry`와 `mode=max/pull` 같은 옵션 조합이 초반에는 낯설었다.

핵심 개념 정리
- 브랜치별 변경 빈도가 낮은 스테이지(예: apt 설치, yarn install)는 브랜치 공통 캐시로 두고, 브랜치별 자주 바뀌는 스테이지(예: 소스 복사 후 빌드)는 브랜치 전용 캐시로 둔다.
- 캐시 태그 규칙 예: registry/owner/repo:cache-common, registry/owner/repo:cache-branch-<branch>-<short-sha>
- **브랜치 태그는 반드시 충돌 회피용 식별자를 포함**해야 한다(브랜치 이름 또는 짧은 커밋 SHA).

실무에서 확인하면 좋을 포인트(우선순위)
1. CI 러너에서 `docker buildx inspect`로 빌더가 제대로 설정됐는지 확인 (버전 요구: Docker 24+, buildx 최신 권장).
2. 레지스트리에 캐시 이미지가 실제로 존재하는지 `docker pull registry/...:cache-...`로 검증.
3. 빌드 로그에서 "using cache" 또는 "pulling from" 메시지 유무로 히트 여부 판단.
4. 레지스트리의 보존 정책과 용량(GB) 및 비용 확인.
5. 캐시 만료·무효화 정책(예: 일정 기간 미사용 시 삭제)과 동작 확인.

전략 비교 표(단순, 모바일 가독성 고려)
| 전략 | 장점 | 단점 | 실무 확인 포인트 |
|---|---:|---|---|
| 브랜치별 캐시 키 | 충돌 없음, 브랜치 독립성 | 캐시 히트율 낮음, 공간 증가 | 태그 생성 규칙, 레지스트리 용량 |
| 공통+브랜치 분리 | 히트율 개선, 충돌 최소화 | 구현 복잡도 증가 | 스테이지 분리 기준, 캐시 우선순위 |
| 전역 캐시(공유) | 쉬운 관리 | 충돌/재현성 문제 | 변경 추적, 캐시 무효화 절차 |

간단한 실패 예시와 수정 예시
- 실패 증상: "CI에서 같은 브랜치인데도 오래된 의존성이 다시 설치된다" -> 캐시가 의도치않게 덮어씌워진 경우.
- 원인: 브랜치 A와 B가 같은 캐시 태그를 쓰고 B가 푸시한 캐시가 A의 빌드에 적용됨.
- 조치: 브랜치 식별자 포함 태그로 분리하거나 공통 레이어/브랜치 레이어 분리.

실패 예 (Dockerfile과 build 명령의 조합이 원인)
{% raw %}
```dockerfile
# Dockerfile (간단 실패 예)
FROM node:16
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
```

# CI 빌드 명령 (문제 있는 태그 사용)
docker buildx build --cache-from=type=registry,ref=ghcr.io/org/repo:cache --cache-to=type=registry,ref=ghcr.io/org/repo:cache,push .
{% raw %}
```
{% endraw %}

문제: `ref=...:cache`가 모든 브랜치에서 동일하면 서로 덮어씀. 수정 예: 브랜치 및 짧은 SHA 포함
{% raw %}
```bash
{% endraw %}
# 수정: 브랜치 + sha 사용 (GitHub Actions에서)
BRANCH_NAME=${GITHUB_REF_NAME}
SHORT_SHA=${GITHUB_SHA::7}
CACHE_TAG=ghcr.io/org/repo:cache-${BRANCH_NAME}-${SHORT_SHA}

docker buildx build \
  --cache-from=type=registry,ref=ghcr.io/org/repo:cache-common \
  --cache-from=type=registry,ref=${CACHE_TAG} \
  --cache-to=type=registry,ref=${CACHE_TAG},mode=max,push \
  -t ghcr.io/org/repo:${SHORT_SHA} .
{% raw %}
```
{% endraw %}

GitHub Actions 예제 (중요: ${{ }} 문법 포함 → raw로 보호)
{% raw %}
```yaml
{% endraw %}
# .github/workflows/ci.yml (필수 예시)
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3
      - name: Set up buildx
        uses: docker/setup-buildx-action@v3
      - name: Login to registry
        uses: docker/login-action@v2
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build with cache
        run: |
          BRANCH=${{ github.ref_name }}
          SHA=${{ github.sha }}
          SHORT=${SHA::7}
          CACHE_COMMON=ghcr.io/org/repo:cache-common
          CACHE_BRANCH=ghcr.io/org/repo:cache-${BRANCH}-${SHORT}

          docker buildx build \
            --cache-from=type=registry,ref=${CACHE_COMMON} \
            --cache-from=type=registry,ref=${CACHE_BRANCH} \
            --cache-to=type=registry,ref=${CACHE_BRANCH},mode=max,push \
            -t ghcr.io/org/repo:${SHORT} \
            --platform linux/amd64,linux/arm64 .
{% raw %}
```
{% endraw %}

공식 문서 확인 루트(검증용)
- Docker Buildx: https://docs.docker.com/buildx/
- buildx cache 옵션 설명: https://docs.docker.com/buildx/working-with-buildx/#caching
- GitHub Actions: https://docs.github.com/actions
- GitHub Packages / Container Registry 권한 문서: https://docs.github.com/packages

실행 가능한 점검 명령(빠른 확인)
- docker version && docker buildx version
- docker buildx inspect --bootstrap
- docker pull ghcr.io/org/repo:cache-branch-name || true
- 빌드 로그에서 "Using cache" / "pulled from" 문자열 검색

공부하면서 적용해본 체크 포인트(검증 사례: 포함해야 할 항목)
- CI 러너: ubuntu-22.04, Docker 24.0.6, buildx v0.10.4 확인
- 캐시 태그 예: ghcr.io/org/repo:cache-common, ghcr.io/org/repo:cache-feature-abc-1a2b3c4
- 실패 로그 예시: "failed to push layer: unauthorized" → 권한/토큰 만료 점검 필요

Q&A (자주 묻는 질문)
Q1: 브랜치마다 캐시를 다 나누면 비용이 크게 늘까요?
A1: 캐시 수가 늘어나면 레지스트리 저장 비용이 늘 가능성이 큽니다. 우선 **공통 레이어는 하나로 유지**하고, 브랜치 전용 캐시는 최근 N개만 보관하거나 자동 삭제 정책을 두는 방식으로 균형을 맞추는 걸 권합니다.

Q2: 캐시 무효화는 어떻게 관리하나요?
A2: 주요 방법:
- 베이스 이미지 업데이트 시 common 캐시를 수동 혹은 자동으로 무효화(태그 변경).
- 일정 기간 미사용 캐시 자동 삭제(레지스트리 수명 규칙).
- CI에서 특정 커밋/릴리스에 대해 강제 키(예: cache-clear-<date>)를 사용.

Q3: 캐시가 사용되었는지 어떻게 확실히 확인하나요?
A3: 빌드 로그에서 "pulling from" 또는 "Using cache" 메시지 확인, 레지스트리에서 캐시 이미지의 레이어 생성 시간 비교, 그리고 빌드 시간을 비교(예: 캐시 사용 전후 빌드 시간 차이 측정).

Q4: Docker 레이어가 너무 커져서 관리가 힘든데요.
A4: 레이어를 작게 유지하려면 불필요한 파일 복사 방지(.dockerignore), multi-stage 빌드로 최종 이미지에 필요한 것만 복사, 그리고 의존성 설치 단계는 가능한 캐시 효율적으로 묶기.

실무에서 바로 쓸 점검 절차 (재현·검증)
1. CI에서 사용 중인 Docker/Buildx 버전 확인
   - 명령: docker version && docker buildx version
2. 레지스트리 로그인과 권한 확인
   - CI 시: docker/login-action 설정(토큰, 만료, 권한 범위)
3. 캐시 태그 규칙 검토(.github/workflows/ci.yml)
   - 브랜치 식별자 포함 여부 확인
4. 빌드 로그에서 캐시 히트/풀 메시지 확인
5. 레지스트리에서 최근 캐시 이미지 목록 확인(레지스트리 UI 또는 API)
6. 빌드 시간(초) 및 네트워크 트래픽(GB) 측정: 캐시 적용 전후 비교

나의 의견 1
- 이 섹션에는 직접 겪은 환경(예: CI 러너 OS, Docker 버전, 실패했던 로그 줄, 수정 전후 빌드 시간)을 적어 보세요.

나의 의견 2
- 이 섹션에는 팀 정책(예: 캐시 보존 기간, 브랜치별 캐시 유지 개수, 레지스트리 선택 이유)을 적어 보세요.

실무 체크리스트 (핵심 확인 항목)
- [ ] docker & buildx 버전 확인 (예: Docker >=24.0, buildx 최신)
- [ ] CI 워크플로에 브랜치 식별자로 캐시 태그 적용
- [ ] 공통 레이어와 브랜치 전용 레이어 분리 설계
- [ ] 레지스트리 권한/토큰 만료 정책 검토
- [ ] 레지스트리의 스토리지/비용 정책 확인
- [ ] .dockerignore, multi-stage 활용으로 레이어 크기 최소화
- [ ] 캐시 무효화 절차(수동/자동) 문서화
- [ ] 빌드 로그에서 캐시 히트 여부와 빌드 시간 수치 기록

마무리 — 무엇을 먼저 확인해야 하나, 언제 다른 선택지가 나은가
- 먼저 확인할 것: CI 환경의 Docker/buildx 버전, 현재 캐시 태그 규칙, 레지스트리 권한과 보존 정책. 이 세 가지는 문제 재현성과 원인분석에 가장 큰 영향을 줍니다.
- 다른 선택지가 나은 경우:
  - 매우 짧은 브랜치 수명(실험 브랜치가 빠르게 사라짐)이라면 브랜치별 캐시를 안 두고 공통 캐시만으로 충분할 수 있습니다.
  - 레지스트리 비용이 민감하면 로컬 레이어 캐시(러너별) + 공통 캐시만 사용하고 브랜치별 캐시 푸시는 제한하는 편이 낫습니다.

참고: 구현·검증 시 공식 문서(위 링크)와 CI 로그, 레지스트리 UI를 함께 보면서 작은 변경을 적용해 증분으로 확인하는 것을 권합니다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

{% endraw %}