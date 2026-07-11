---
title: "Docker 이미지 크기 줄이기: 실무에서 확인해야 할 점들"
slug: "docker-image-size-reduction-checkpoints"
date: 2026-07-11 09:00:00 +0900
categories: [Docker, DevOps]
tags: [docker, image-size, devops, linux, container]
image:
  path: /assets/img/posts/blog/docker-image-size-reduction-checkpoints/image-1.png
  alt: "Docker 이미지 최적화 흐름을 간단한 다이어그램으로 보여주는 이미지"
---

오늘은 Docker 이미지 크기를 줄일 때 실무에서 확인하면 도움이 되는 포인트들을 정리해봤습니다. 개인적으로 프로젝트를 운영하면서 이미지가 커져서 빌드·배포 시간이 늘어나고 레지스트리 비용이 올라가는 문제를 겪었는데, 그 과정에서 공부한 내용을 초보자의 관점에서 차근차근 적어보려 합니다. 섣불리 일반화하지 않으려 노력했고, 제가 확인해 본 절차와 예제 중심으로 정리했습니다.

![Docker 이미지 최적화 흐름을 간단한 다이어그램으로 보여주는 이미지](/assets/img/posts/blog/docker-image-size-reduction-checkpoints/image-1.png)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점
- 이미지 크기는 단순히 베이스 이미지 선택만으로 결정되지 않더군요. 패키지 설치 방식, 캐시 잔존, 불필요한 파일 복사, 여러 레이어에 걸친 중복 파일 등이 크게 영향을 줍니다.
- 멀티스테이지 빌드로 빌드 의존성을 분리하면 런타임 이미지를 많이 줄일 수 있었습니다. 특히 컴파일 단계에서 생성된 개발 도구들이 최종 이미지에 남지 않게 하는 게 핵심인 것 같습니다.
- 베이스 이미지를 바꾸는 것(예: ubuntu -> alpine 또는 distroless)은 장단점이 있어, 보안·호환성·이미지 크기 사이의 균형을 고려해야 합니다.

처음에는 헷갈렸던 부분
- "단일 RUN에 여러 명령을 넣으면 무조건 이미지가 줄어드나?" — 어느 정도 맞지만, 각 RUN은 레이어를 생성하므로 같은 파일을 여러 레이어에서 만들고 지우는 경우 최종 이미지에 흔적이 남을 수 있습니다. 그래서 가능한 한 관련된 파일 조작을 하나의 RUN으로 묶는 게 좋습니다.
- apk(Alpine) vs apt(Debian/Ubuntu)에서의 캐시 처리 방식 차이도 헷갈렸습니다. Alpine은 디폴트로 경량이지만 일부 바이너리 호환성 문제나 glibc 의존성 때문에 사용할 수 없는 경우도 있었습니다.

실무에서는 이렇게 확인하면 좋겠다 (절차 중심)
1. 현재 상태 파악
   - 이미지 목록과 크기 확인:
     ```
     docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
     docker image inspect --format='{{.Size}}' my-image:tag
     docker system df
     ```
   - 레이어별 크기와 파일 변화를 확인:
     ```
     docker history --no-trunc my-image:tag
     ```
     또는 더 시각적으로 보려면 dive 같은 도구 사용을 권장합니다:
     ```
     # dive 설치 후
     dive my-image:tag
     ```
2. Dockerfile 점검 포인트 (우선순위 높은 항목)
   - 베이스 이미지 선정: 필요한 최소 기능을 제공하는지 확인. 예: debian-slim, alpine, gcr.io/distroless 등.
   - 멀티스테이지 빌드로 빌드 아티팩트만 복사:
     ```
     # 예: 간단한 Go 앱
     FROM golang:1.20 AS builder
     WORKDIR /app
     COPY . .
     RUN CGO_ENABLED=0 GOOS=linux go build -o app

     FROM gcr.io/distroless/static
     COPY --from=builder /app/app /app
     ENTRYPOINT ["/app"]
     ```
   - 패키지 설치 시 캐시 제거:
     - Debian 계열:
       ```
       RUN apt-get update && apt-get install -y --no-install-recommends \
           build-essential \
         && rm -rf /var/lib/apt/lists/*
       ```
     - Alpine:
       ```
       RUN apk add --no-cache build-base
       ```
   - Python, Node 등 언어별 팁:
     - Python:
       ```
       RUN pip install --no-cache-dir -r requirements.txt
       ```
     - Node:
       ```
       RUN npm ci --only=production
       ```
   - .dockerignore 작성: 불필요한 소스/테스트/문서 파일이 컨텍스트에 포함되지 않도록 설정합니다.
     ```
     node_modules
     .git
     tests
     docs
     *.md
     ```
   - 불필요한 파일을 여러 레이어에서 생성/삭제하지 않도록 RUN을 합치기:
     ```
     # 비권장: 여러 RUN으로 나누면 중간에 캐시가 남을 수 있음
     RUN curl -o /tmp/tool.tar.gz ... 
     RUN tar -xzf /tmp/tool.tar.gz -C /opt
     RUN rm /tmp/tool.tar.gz

     # 권장: 한 RUN에서 처리
     RUN curl -o /tmp/tool.tar.gz ... && \
         tar -xzf /tmp/tool.tar.gz -C /opt && \
         rm /tmp/tool.tar.gz
     ```
3. 빌드/레지스트리 측정과 CI 연동
   - CI에서 빌드할 때 이미지 사이즈를 아티팩트나 메트릭으로 기록 (예: GitHub Actions에서 docker build 후 이미지 크기 출력).
   - 이미지를 푸시하기 전에 로컬에서 docker image inspect로 크기를 확인하고, 예외 기준(예: 200MB 이상이면 알림)을 설정.
   - 레지스트리 비용 및 보관 정책: 오래된 태그를 자동 정리하는 정책 구축.

중간 설명: 레이어와 캐시, 그리고 도구 활용
- 레이어는 파일시스템 차이를 담고 있기 때문에 같은 파일이 여러 레이어에 있으면 모든 레이어의 크기가 합쳐집니다. 그래서 빌드 아티팩트나 임시 파일은 최종 이미지에 남지 않도록 주의해야 합니다.
- 이미지 분석 도구:
  - dive: 레이어별 파일 크기, 어떤 파일가 어느 레이어에서 추가되었는지 확인 가능.
  - docker history: 레이어별 명령과 크기 확인.
  - hadolint: Dockerfile linting으로 비효율적이거나 보안 취약한 패턴을 찾아줌.
- 보안 스캐닝도 함께 고려: 이미지 경량화만큼 취약점이 줄어들지 않을 수 있습니다. 오히려 라이브러리를 줄이면 관리가 쉬워져 패치 적용이 빠를 수 있습니다.

![dive로 Docker 이미지 레이어를 분석하는 예시 화면을 보여주는 이미지](/assets/img/posts/blog/docker-image-size-reduction-checkpoints/image-2.png)
이미지 출처: AI 생성 이미지

실무 팁: 구체적인 명령과 점검 절차 예시
- 이미지 크기 빠르게 비교하기:
  ```
  # 최근 10개 이미지 크기 확인
  docker images --format "{{.Repository}}:{{.Tag}}\t{{.Size}}" | head -n 10
  ```
- 레이어별 분석:
  ```
  docker history --no-trunc my-image:tag
  # 또는
  dive my-image:tag   # 시각적으로 레이어와 파일 기여도 확인
  ```
- 불필요한 이미지 정리 (주의: 공유 레지스트리에서 사용하는 이미지는 삭제하지 않도록 유의):
  ```
  docker image prune -f
  docker system prune -a --volumes
  ```
- CI에서 사이즈 체크 예시 (GitHub Actions 간단 스크립트):
  ```
  - name: Build image
    run: docker build -t my-image:${{ github.sha }} .
  - name: Print image size
    run: docker image inspect --format='{{.Size}}' my-image:${{ github.sha }}
  - name: Fail on too large
    run: |
      size=$(docker image inspect --format='{{.Size}}' my-image:${{ github.sha }})
      max=200000000
      if [ "$size" -gt "$max" ]; then
        echo "Image too large: $size"
        exit 1
      fi
  ```
- 레지스트리 정책: 오래된 태그 자동 삭제 및 스토리지 사용량 모니터링 (예: Harbor, ECR 라이프사이클 규칙 등).

공부하면서 정리한 작은 체크리스트 (개념용)
- 베이스 이미지가 필요한 것만 포함하는가? (glibc/openssl 등 필요 여부)
- 빌드 도구가 런타임 이미지에 남아있진 않은가?
- 패키지 캐시(apt lists, pip cache 등)를 삭제했는가?
- .dockerignore로 빌드 컨텍스트가 최소화되었는가?
- 레이어 합치기(RUN 하나에 여러 명령)로 중복 데이터가 남지 않게 했는가?
- 이미지 스캔(취약점) 결과가 허용 범위인가?

마무리하면서 (조심스러운 한마디)
제가 해본 방법들은 대부분의 케이스에서 도움이 되었지만, 모든 프로젝트에 그대로 적용하면 안 되는 경우도 있었습니다. 예컨대 Alpine을 썼다가 특정 바이너리나 라이브러리 호환성 문제로 되돌린 경험이 있습니다. 그래서 작은 실험(예: 베이스 이미지 교체로 인한 런타임 테스트, 멀티스테이지 적용 후 통합 테스트)을 통해 신중히 도입하는 게 좋겠다는 게 제 결론입니다.

실무 체크리스트
- [ ] 현재 이미지 목록과 사이즈를 기록해 기준(베이스라인)을 만들기
- [ ] Dockerfile에 .dockerignore가 적절히 적용되어 있는지 확인
- [ ] 멀티스테이지 빌드로 빌드 의존성을 분리했는지 점검
- [ ] 패키지 설치 후 캐시(apt/pip/npm 등)를 반드시 삭제하는지 확인
- [ ] 레이어별 변경사항을 dive 또는 docker history로 분석해서 큰 항목을 줄일 수 있는지 검토
- [ ] CI에서 빌드 후 이미지 크기를 자동으로 측정하고 임계값을 설정
- [ ] 레지스트리의 보관/정리 정책을 도입하여 오래된 태그를 자동으로 정리
- [ ] 이미지 취약점 스캐닝을 정기적으로 수행하고 치명적인 취약점은 바로 대응

끝으로, 제가 해 본 작은 실험들을 바탕으로 정리한 글이라 혹시 틀린 부분이 있을 수도 있습니다. 여러분이 시도해보신 사례나 더 좋은 팁이 있으면 공유해주시면 같이 배우는 데 큰 도움이 될 것 같습니다.