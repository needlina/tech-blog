---
title: "CI에서 Docker 빌드 산출물 체크섬 재현: 실무 패턴과 점검 가이드"
description: "로컬·CI 간 Docker 이미지 체크섬 차이 원인, 재현 가능한 체크섬 생성 방법(환경변수·파일정렬·tar 정규화), 검증 명령과 GitHub Actions 예시, 실패 시 점검 포인트."
slug: "ci-docker-build-reproducible-artifact-checksum"
date: 2026-07-24 10:00:00 +0900
categories: ["Docker", "CI/CD"]
tags: ["docker", "reproducible-builds", "github-actions", "이미지무결성", "배포검증"]
image:
  path: /assets/img/posts/blog/ci-docker-build-reproducible-artifact-checksum/preview.png
  alt: "재현 가능한 Docker 아티팩트 썸네일"
---

로컬에서 만든 Docker 이미지와 CI에서 만든 이미지의 체크섬이 달라져서 배포 검증에서 막혔을 때, **어떤 요소들이 무결성을 깨는지**와 **어떻게 빌드·저장·검증 흐름을 고정해서 재현 가능한 체크섬을 만들지**를 우선 확인해야 합니다. 핵심은 빌드타임 메타데이터(타임스탬프, 라벨), 파일 정렬/압축 방식, 그리고 저장(pull/push/save) 과정의 비결정적 요소들을 제거하거나 고정하는 것입니다.

왜 이 문제를 다루는지 바로 겪는 상황으로 시작해볼게요.
로컬에서는 docker save한 파일의 sha256이 항상 같았는데, CI에서 돌리면 값이 다른 경우가 있습니다. 배포 파이프라인에서 이미지 무결성을 검사하려면 동일 소스/동일 명령으로 동일한 결과(바이트 단위)를 얻을 수 있어야 하죠. 실무에서는 이미지 ID(image ID)와 레지스트리 manifest digest(sha256:...)를 혼용하거나, tar 파일을 그대로 비교하는 등 방법이 제각각이라 혼란이 발생하기 쉽습니다.

이번 글은 초보 개발자의 관점에서 실무에서 바로 확인할 포인트와 재현 가능한 체크섬을 만들기 위한 구체 명령, 실패 시 점검 절차를 정리한 겁니다. 저는 아직 배우는 입장이라 단정적으로 말하진 않지만, 아래 절차를 따라가며 변화를 확인해보면 도움이 될 것 같아요.

## 핵심 개념 요약
- 이미지 무결성 비교는 "같은 이미지 바이트 스트림"을 비교해야 안전합니다. 레지스트리의 manifest digest(OCI digest)는 최종 푸시된 아티팩트에 대해 더 안정적인 비교 수단입니다.
- 로컬/CI 불일치는 주로 **타임스탬프**, **파일 순서**, **압축 메타데이터**, **빌드 메타(빌드 ID, 라벨)** 때문에 발생합니다.
- 재현 가능한 체크섬은 (1) 빌드 입력 고정, (2) 빌드 환경 고정(빌드킷/버전), (3) 산출물 정규화(파일 정렬·타임스탬프 고정) 순으로 접근하면 구현 가능성이 높아집니다.

## 실무로 바로 써볼 체크리스트(요약)
- 사용 중인 Docker/BuildKit 버전 확인: docker version, docker buildx version
- 빌드 아규먼트·환경 고정: --build-arg SOURCE_DATE_EPOCH=...
- 소스 아카이브 정렬: tar --sort=name --mtime=...
- 이미지 확인: docker image inspect, docker manifest inspect, docker save → 정규화 → sha256sum
- CI 예시: GitHub Actions에서 빌드 후 정규화 스크립트 실행 및 체크섬 artifact 저장

## 원인별 실무 판단 표 (실패 증상 / 원인 / 확인 명령 / 조치)
| 실패 증상 | 원인(추정) | 확인 명령 | 조치 |
|---:|---|---|---|
| 로컬과 CI의 docker save sha256 불일치 | tar 내부 파일 mtime/정렬이나 gzip 헤더 차이 | docker save my:tag -o image.tar; sha256sum image.tar | image.tar를 추출 후 재패키징(정렬·mtime 고정) 후 sha 검사 |
| 레지스트리 manifest digest 불일치 | 빌드 시 레이어 순서나 라벨이 다름 | docker manifest inspect registry/my:tag | 빌드 명령과 라벨을 고정, 동일 레지스트리로 push 후 digest 사용 |
| 이미지 ID가 달라짐(하지만 기능 같음) | 이미지 ID는 로컬 메타데이터 영향 | docker image inspect <image> | 이미지 내용(파일)과 manifest digest로 비교 |

## 어떤 방법을 선택해야 할지: 선택 기준 비교표
| 방법 | 맞는 상황 | 피해야 할 상황 | 확인 방법 |
|---|---:|---|---|
| 레지스트리 manifest digest 사용 | CI→레지스트리 푸시 후 배포 검증 | 레지스트리 없이 로컬 파일로 검증할 때 | docker manifest inspect |
| 이미지 정규화 후 tar checksum | tar 파일로 배포하거나 외부와 비교할 때 | 레지스트리 푸시가 필수인 파이프라인 | 정규화 스크립트 적용 후 sha256sum |
| SBOM/파일단위 해시 사용 | 파일 변경 추적이 목적일 때 | 전체 이미지 바이트 비교가 필요할 때 | sbom 생성(예: syft), 파일별 해시 확인 |

## 재현 불가의 흔한 원인과 확인 명령
1. 타임스탬프 (mtime/created)
   - 확인: docker image inspect로 created 필드 확인
   - 조치: --build-arg SOURCE_DATE_EPOCH 또는 Dockerfile에서 ENV로 고정
2. 압축 메타(gzip header)
   - 확인: gzip -l image.tar.gz (헤더 확인)
   - 조치: gzip -n 옵션으로 헤더 무효화
3. 파일 정렬
   - 확인: tar -tf image.tar | head
   - 조치: tar --sort=name로 재패키징

## 실패 예시와 수정 예시 (Dockerfile + 스크립트)
아래는 간단한 실패 사례입니다. node 앱을 COPY할 때 파일 시스템의 순서에 의존하면 tar/이미지가 달라질 수 있습니다.

실패 Dockerfile (비결정적)
```dockerfile
FROM node:14.21.3-alpine3.17
WORKDIR /app
# 소스 디렉터리 내 파일 순서에 따라 레이어 내용이 달라짐
COPY . .
RUN npm ci --only=production
CMD ["node", "index.js"]
```

수정 방향:
- 빌드 입력(소스 아카이브)을 정렬해서 전달
- 빌드타임 메타 고정: SOURCE_DATE_EPOCH 설정
- 불필요한 라벨/타임스탬프 제거

수정 Dockerfile (수정 포인트 반영)
```dockerfile
FROM node:14.21.3-alpine3.17
ARG SOURCE_DATE_EPOCH=1609459200
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /app
# 의도적으로 package.json 먼저 복사해 캐시 재현성 확보
COPY package*.json ./
RUN npm ci --only=production
# 소스는 tar로 정렬 후 전달(빌드 스크립트에서)
COPY dist/ ./dist/
CMD ["node", "dist/index.js"]
```

빌드 및 정규화 스크립트 예시 (Linux, CI에서 실행 권장)
```bash
# 빌드
export DOCKER_BUILDKIT=1
docker buildx build --load --build-arg SOURCE_DATE_EPOCH=1609459200 -t my/image:ci .

# 저장 및 정규화
docker save my/image:ci -o image.tar
mkdir -p tmp_image && tar -xf image.tar -C tmp_image

# 재패키징: 파일 이름 순 정렬, mtime 고정, gzip 헤더 제거
tar --sort=name --mtime='1970-01-01' -cf - -C tmp_image . | gzip -n > image-normalized.tar.gz

# 체크섬 계산
sha256sum image-normalized.tar.gz | awk '{print $1}' > image-checksum.sha256
```

위 스크립트에서 사용하는 GNU tar의 --sort, --mtime, gzip -n 옵션이 **핵심**입니다. CI 환경에서 tar의 버전이 다르면 옵션 지원 여부를 확인하세요.

## GitHub Actions 예시: 빌드 → 정규화 → 체크섬 아티팩트 업로드
GitHub Actions에서 체크섬을 만들고 artifact로 보관하는 워크플로 예시입니다. (템플릿 표현식은 Jekyll/Liquid 충돌을 피하려고 raw로 감쌌습니다.)

{% raw %}
```yaml
name: build-and-checksum
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up QEMU and buildx
        uses: docker/setup-buildx-action@v2
      - name: Build image
        run: |
          export DOCKER_BUILDKIT=1
          docker buildx build --load --build-arg SOURCE_DATE_EPOCH=${{ github.run_started_at }} -t ghcr.io/${{ github.repository }}/my-app:${{ github.sha }} .
      - name: Save image
        run: |
          docker save ghcr.io/${{ github.repository }}/my-app:${{ github.sha }} -o image.tar
          mkdir tmp && tar -xf image.tar -C tmp
          tar --sort=name --mtime='1970-01-01' -cf - -C tmp . | gzip -n > image-normalized.tar.gz
          sha256sum image-normalized.tar.gz | awk '{print $1}' > checksum.txt
      - name: Upload checksum
        uses: actions/upload-artifact@v4
        with:
          name: image-checksum
          path: checksum.txt
```
{% endraw %}

주의: 위 워크플로에서 사용하는 `${{ github.sha }}`와 같은 표현은 워크플로 내부에서만 동작합니다. 또한 `github.run_started_at`은 ISO 형식이므로 필요 시 정수형 epoch로 변환해서 쓰는 것이 안전합니다.

## 레지스트리 digest를 신뢰해도 될까?
- 레지스트리에 푸시한 뒤 `docker manifest inspect` 또는 `skopeo inspect docker://registry/repo:tag`로 얻는 manifest digest(예: sha256:...)는 레지스트리에 올라간 아티팩트를 기준으로 안정적입니다.
- 다만 레지스트리 푸시 과정에서 레이어가 변형되거나 중간에 변환되면 달라질 수 있으니, CI에서 푸시 직후 digest를 저장하고 배포 시 그 digest를 직접 참조하는 편이 현업에서 흔히 쓰입니다.

검증 명령 예:
{% raw %}
```bash
# manifest digest 확인
docker manifest inspect registry.example.com/my/image:tag | jq -r '.[0].Descriptor.digest'
# 또는
skopeo inspect docker://registry.example.com/my/image:tag --format '{{.Digest}}'
```
{% endraw %}

(주의: 위 중 `skopeo`는 별도 설치 필요)

## 재현 가능한 체크섬 만들 때 버전/환경 정보를 기록하라
재현성을 위해 아래 정보를 체크하면 문제 해석이 쉬워집니다.
- docker version (예: Docker version 24.0.2)
- buildx / buildkit 버전
- base image 태그(예: node:14.21.3-alpine3.17)
- 사용한 tar/gzip 버전 (tar --version, gzip --version)
- SOURCE_DATE_EPOCH 값(예: 1609459200)
- 빌드 아규먼트 목록과 값

## 확인 절차(검증 순서)
1. 로컬에서 같은 명령으로 이미지 빌드, 저장, 정규화, 체크섬 생성
2. CI에서 동일한 스크립트(같은 버전의 도구)로 빌드·정규화·체크섬 생성
3. 두 체크섬 비교(sha256)
4. 레지스트리에 push했다면 manifest digest 비교
5. 필요시 이미지 내용 비교: docker save → 파일 추출 → 파일별 해시 비교

## 실무 점검 표: 실패 증상 / 원인 / 확인 명령 / 조치 (구체 예)
| 실패 증상 | 원인 | 확인 명령 | 권장 조치 |
|---:|---|---|---|
| CI 체크섬 != 로컬 체크섬 | CI에서 gzip 헤더 포함 / tar 항목 mtime 불일치 | tar --version; gzip -l image-normalized.tar.gz | tar/gzip 옵션으로 재패키징, gzip -n 적용 |
| manifest digest가 레지스트리와 로컬 다름 | 로컬 이미지는 푸시 전 형태 | docker image inspect <local> ; docker manifest inspect <remote> | CI에서 push 직후 manifest를 읽어 저장 |
| 동일 소스·동일 Dockerfile인데도 달라짐 | 빌드 환경(빌드킷) 버전 차이 | docker buildx version; docker version | 빌드 환경 버전 고정, 컨테이너화된 빌더 사용 |

## Q&A (자주 묻는 질문)
Q: "docker image inspect"의 어떤 필드를 봐야 하나요?
A: manifest digest는 레지스트리 푸시 후에 확인 가능한 RepoDigests/Manifest digest를 우선 봅니다. 로컬 Id는 메타데이터 영향을 더 받습니다.

Q: gzip -n 없이도 동일 체크섬을 얻을 수 있나요?
A: gzip -n은 gzip 헤더의 타임스탬프를 제거하므로 일반적으로 사용 권장입니다. 다른 방법으로는 gzip 대신 uncompressed tar를 사용하고 tar의 mtime/정렬을 고정하는 방식이 있습니다.

Q: SOURCE_DATE_EPOCH는 어디에 쓰는 값인가요?
A: 빌드 과정에서 생성되는 파일의 타임스탬프(예: 빌드 도구가 embed하는 created 필드)를 고정하는 표준 관행입니다. CI에서는 일정한 epoch를 build-arg로 전달하는 경우가 많습니다.

Q: 레지스트리 digest와 tar checksum 중 무엇을 신뢰해야 하나요?
A: 레지스트리 digest는 푸시된 아티팩트의 고유 식별자라서 배포 파이프라인에서는 보통 더 신뢰합니다. 다만 tar checksum은 오프라인 전달이나 아카이브 검증에 유용합니다.

Q: GitHub Actions에서 파일 정렬·정규화 스크립트를 어디에 두는 게 좋을까요?
A: 빌드 저장소 내 scripts/normalize-image.sh처럼 두고, CI에서 같은 스크립트를 호출하면 재현성이 좋아집니다.

Q: 높은 수준의 자동화가 필요한 경우 어떤 도구가 도움이 되나요?
A: Skopeo, ORAS, umoci, buildkit의 정규화 기능(때때로 확장)을 검토해볼 수 있습니다. 각 도구의 버전과 옵션을 반드시 확인하세요.

## 나의 의견 1
여기에 직접 작성하세요: 내 환경의 Docker/BuildKit 버전은 무엇이었는지, 처음 실패한 체크섬 값과 수정 후 값은 어떻게 달라졌는지 적어보세요.

## 나의 의견 2
여기에 직접 작성하세요: CI에서 사용한 tar/gzip 버전과 SOURCE_DATE_EPOCH 값, 그리고 적용한 정규화 방법(예: tar --sort=name)을 적어보세요.


## 함께 보면 좋은 글

- [Monorepo CI에서 브랜치별 Docker 레이어 캐시 충돌 없이 분할·재사용하는 현실적인 전략](/posts/monorepo-ci-branch-docker-cache-partitioning-strategy/)
- [컨테이너 빌드에서 UID/GID 일관화로 파일 권한 문제 예방하기](/posts/docker-build-uid-gid-consistency/)
- [Docker 이미지 크기 줄이기: 실무에서 확인해야 할 점들](/posts/docker-image-size-reduction-checkpoints/)

## 실무 체크리스트
- [ ] docker version 및 docker buildx version 확인: `docker version`, `docker buildx version`
- [ ] 빌드 스크립트에 SOURCE_DATE_EPOCH 고정 추가: `--build-arg SOURCE_DATE_EPOCH=1609459200`
- [ ] 이미지 저장/정규화 스크립트 실행: `docker save my/image -o image.tar` → `tar --sort=name --mtime='1970-01-01' -cf - -C tmp . | gzip -n > image-normalized.tar.gz`
- [ ] 체크섬 생성 및 아티팩트 저장: `sha256sum image-normalized.tar.gz > checksum.txt` (CI artifact로 업로드)
- [ ] 레지스트리에 push 후 manifest digest 확인: `docker manifest inspect registry/repo:tag` 또는 `skopeo inspect`
- [ ] 실패 시 상세 로그 수집: `docker buildx build --progress=plain` 및 `docker save` 이후 tar 리스트 `tar -tf image.tar | head -n 50`
- [ ] 롤백/검증: 배포 전 CI에서 저장한 manifest digest를 사용해 대상 환경에서 정확히 그 digest를 pull하도록 스크립트 검증

![Docker 이미지 체크섬 재현 흐름도](/assets/img/posts/blog/ci-docker-build-reproducible-artifact-checksum/image-1.webp)
이미지 출처: AI 생성 이미지

![CI 파이프라인에서 체크섬 생성 및 검증 단계](/assets/img/posts/blog/ci-docker-build-reproducible-artifact-checksum/image-2.webp)
이미지 출처: AI 생성 이미지

마무리로, 이 주제에서 먼저 확인해야 할 것은 "내가 비교하려는 값이 무엇인지(manifest digest vs image tar checksum)와 빌드 입력이 완전히 고정되어 있는지"입니다. 만약 레지스트리 기반 배포라면 푸시 직후의 manifest digest를 기준으로 검증하는 것이 보통 더 간단합니다. 반면 오프라인 전달이나 아카이브 비교가 필요하면 tar 정규화(파일 정렬·mtime 고정·gzip -n) 방식이 더 적합합니다. 언제 다른 선택지가 나은지(예: 레지스트리 사용 불가, 빌드 환경 통제 불가 등)는 위 표의 선택 기준을 참고해 보시면 좋겠습니다.