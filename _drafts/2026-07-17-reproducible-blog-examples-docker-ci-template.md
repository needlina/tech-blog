---
title: "Docker + CI로 누구나 재현 가능한 코드 예제 템플릿 만들기"
slug: "reproducible-blog-examples-docker-ci-template"
date: 2026-07-17 10:00:00 +0900
categories: ["Docker", "DevOps"]
tags: ["docker", "ci-cd", "reproducible-examples", "github-actions", "dev-environment"]
image:
  path: /assets/img/posts/blog/reproducible-blog-examples-docker-ci-template/preview.png
  alt: "블로그용 재현 가능한 예제 썸네일"
---

오늘은 "기술 블로그에 올릴 코드 예제를 누구나 재현할 수 있게 Docker + CI 템플릿으로 만드는 방법"을 제가 공부하면서 정리한 내용을 공유합니다. 작성하는 동안 여러 시행착오가 있었고, 초보 입장에서 이해한 점을 중심으로 차근차근 풀어보려 합니다. 과하게 단정하지 않으려 노력했고, 실무에서 바로 확인하면 좋은 포인트를 많이 포함했습니다.

왜 이런 템플릿이 필요할까?
- 독자가 글을 보며 "내 로컬에서 똑같이 실행"해보는 것은 글의 신뢰도를 크게 높입니다.
- 시스템 의존성(라이브러리 버전, OS 등)에 의한 '작동 안 함'을 줄여줍니다.
- CI 템플릿이 있으면 리뷰나 배포 파이프라인에서 재현 가능한 환경을 만들 수 있습니다.

먼저 전체 구조(제가 실습한 예제 기준)
- 간단한 Node.js(Express) 앱 + Postgres를 Docker로 묶음
- docker-compose로 로컬/CI 양쪽에서 동일하게 구동
- GitHub Actions 워크플로우로 빌드, 테스트, 이미지 스캐닝(간단) 수행

간단한 디렉터리 구조 예시
- repo-root/
  - app/
    - package.json, src/
    - Dockerfile
  - docker-compose.yml
  - .env.example
  - .github/workflows/ci.yml
  - README.md

공부하면서 알게 된 점
- Docker 이미지 레이어를 잘 분리하면 빌드가 빨라집니다. (예: 의존성 설치를 먼저)
- 로컬 개발에서는 소스 바인드 마운트(bind mount)를 쓰면 편한데, CI에서는 바인드 마운트가 없으니 동일 동작을 위해 별도 스텝(예: docker-compose up --build)로 처리해야 합니다.
- DB 초기화(마이그레이션) 시 타이밍 이슈가 많았습니다. healthcheck나 wait-for-it 같은 스크립트로 DB 가용성을 확인하는게 실무적으로 유용하다고 느꼈습니다.

처음에는 헷갈렸던 부분
- CI 환경에서 docker-compose를 사용하면 권한 문제나 네트워크 문제로 컨테이너 간 통신이 안 되는 경우가 있었습니다. Runner 이미지에 docker-in-docker(dind)를 투입하거나 서비스 컨테이너로 Postgres를 띄우는 방식이 필요했습니다.
- 환경변수 관리: .env 를 사용하면 편하지만, CI에서는 시크릿을 워크플로우 시크릿으로 넣는 것이 더 안전하다는 점을 나중에 배웠습니다.
- 다중 환경(로컬, CI, 배포)에서 포트/볼륨/비밀번호 등의 차이를 어떻게 정리할지 처음엔 정하기 어려웠습니다. .env.example + README로 합의된 기본값을 제공하는 방식이 비교적 합리적으로 보였습니다.

실제 코드 예제(간단히 재현 가능한 템플릿)

1) app/Dockerfile (Node.js 예시)
```
# app/Dockerfile
FROM node:18-alpine

WORKDIR /usr/src/app

# package.json 먼저 복사해서 의존성 캐시 활용
COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000
CMD ["node", "src/index.js"]
```

2) docker-compose.yml (루트)
```
version: "3.8"
services:
  app:
    build:
      context: ./app
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/mydb
    depends_on:
      - db
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"] 
      interval: 5s
      timeout: 2s
      retries: 5

  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 2s
      retries: 10

volumes:
  pgdata:
```

3) .env.example (간단)
```
# .env.example
DATABASE_URL=postgres://postgres:postgres@db:5432/mydb
NODE_ENV=development
```

4) GitHub Actions 워크플로우(.github/workflows/ci.yml)
```
name: CI

on: [push, pull_request]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: mydb
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 2s --health-retries 10

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Install dependencies
        run: |
          cd app
          npm ci

      - name: Wait for Postgres
        run: |
          for i in {1..20}; do pg_isready -h localhost -p 5432 && break || sleep 1; done

      - name: Run tests
        run: |
          cd app
          npm test
```

이미지를 한 장 넣어 보겠습니다. 이미지 설명은 간단히 기술 개념 일러스트에 어울리는 문장으로 작성합니다.

![컨테이너와 서비스의 관계를 단순히 보여주는 일러스트](/assets/img/posts/blog/reproducible-blog-examples-docker-ci-template/image-1.webp)
이미지 출처: AI 생성 이미지

이미지 출처: AI 생성 이미지

CI에서의 중요한 점들 (실무에서 확인하면 좋은 포인트)
- 서비스 간 통신: CI에서 서비스 컨테이너가 같은 네트워크에서 서로 통신하는지(포트 매핑/hosts 설정 등) 확인합니다.
- DB 초기화/마이그레이션: 테스트 전에 마이그레이션이 필요한 경우, CI 스텝에 명시적으로 넣어 재현성을 확보합니다.
- 로그와 아티팩트: 실패 시 로그를 빠르게 확인할 수 있게 CI에서 콘솔 출력과 가능하면 테스트 리포트(JUnit, coverage 등)를 업로드합니다.
- 이미지 빌드 캐시: CI에서 반복 빌드 속도를 고려해 캐시 전략을 검토합니다(예: GitHub Packages 캐시, buildx 캐시 등).
- 보안 스캔: 취약점 스캐닝을 간단히라도 넣어 보안 이슈를 조기에 발견할 수 있습니다.

실무에서는 이렇게 확인하면 좋겠다 (구체적 점검 절차)
- 로컬: docker-compose up --build 후 app의 /health 엔드포인트와 DB 연결 확인
  - 명령어 예시:
    - docker-compose up --build -d
    - docker-compose ps
    - docker-compose logs -f app
    - curl -sS http://localhost:3000/health
- CI: 실패 시 워크플로우 로그의 첫 200줄, 그리고 테스트 리포트(있다면)를 우선 확인
- 컨테이너 상태: docker ps, docker inspect로 재시작 정책/헬스체크 결과 확인
- DB 상태: docker exec -it <db_container> psql -U postgres -c '\l' 로 데이터베이스 목록 확인

처음에는 헷갈렸던 또 다른 예: healthcheck 명령
- 어떤 명령을 넣어야 할지 애매할 수 있는데, 단순히 포트가 열려 있는지 확인하는 방법과 실제 애플리케이션 레벨의 헬스 엔드포인트를 호출하는 방법은 결과가 다를 수 있습니다. 실무에서는 애플리케이션이 의존하는 외부 리소스까지 체크하는 것이 더 안전할 때가 많습니다.

이미지를 한 장 더 넣습니다. 역시 단순 개념 일러스트로.

![로컬 개발과 CI 파이프라인 흐름을 보여주는 일러스트](/assets/img/posts/blog/reproducible-blog-examples-docker-ci-template/image-2.webp)
이미지 출처: AI 생성 이미지

이미지 출처: AI 생성 이미지

추가 팁 (제가 공부하면서 정리한 작은 팁들)
- .env.example, README.md를 항상 최신 상태로 유지하세요. 독자가 따라오려면 명확한 진입점이 필요합니다.
- 의존성 버전 고정(package-lock.json 또는 yarn.lock)을 공유하면 '작동 안 함' 문제를 줄일 수 있습니다.
- Dockerfile에서 dev/prod 레이어를 분리하면 로컬 개발과 배포 이미지를 모두 효율적으로 관리할 수 있습니다. (multi-stage build)
- CI에서 DB를 서비스로 띄우는 대신, 테스트 자체가 DB를 mock하거나 SQLite 같은 임베디드 DB로도 충분한 경우가 있어요. 테스트 범위를 고려해 선택하면 빌드 속도를 개선할 수 있습니다.
- 로그는 가능한 한 구조화된 포맷(JSON 등)으로 남기면 CI/관측 시스템에서 분석하기 편합니다.

간단한 문제 해결 절차(체크하는 순서)
1. 로컬에서 docker-compose로 정상 실행되는지 확인
2. 컨테이너 헬스체크/로그 확인 (docker-compose logs)
3. CI 로그 확인: 빌드 단계 → 서비스 기동 단계 → 테스트 단계 순으로 에러 포인트 확인
4. DB 마이그레이션/초기 데이터 문제라면, CI에 마이그레이션 스텝을 추가해 재현해본다
5. 권한/유저/포트 충돌 문제는 환경변수(.env)와 docker-compose의 ports/volumes 설정 확인

마무리하며 (조심스러운 어투로)
- 이 방법이 "정답"이라고 말하긴 어렵고, 서비스 규모와 요구사항에 따라 달라질 수 있습니다. 다만 제가 해보니 작은 예제라도 Docker와 CI 템플릿을 함께 제공하면 독자의 재현 가능성이 크게 올라갔습니다. 처음에는 세부 설정(헬스체크, DB 대기, 포트 등)이 헷갈렸지만, 한 번의 템플릿으로 여러 번 재사용하면서 점점 정리가 되었습니다.

실무 체크리스트
- [ ] README에 "로컬 실행 방법"과 "CI 실행 흐름"이 명확히 적혀 있는가
- [ ] .env.example이 있고, 민감정보가 포함되어 있지 않은가
- [ ] Dockerfile이 캐시를 활용하도록 잘 구성되어 있는가 (의존성 먼저 복사 등)
- [ ] docker-compose에 healthcheck가 있고, 필요 시 depends_on 외에 대기 로직이 있는가
- [ ] CI 워크플로우에서 DB 등 서비스 의존성을 재현하도록 설정했는가
- [ ] 테스트 리포트 또는 로그를 CI에서 쉽게 접근할 수 있는가 (아티팩트/리포트 업로드)
- [ ] 이미지 스캔/취약점 체크가 최소한의 형태로라도 포함되어 있는가
- [ ] 로컬과 CI에서 동일한 환경 변수를 사용하도록 문서화되어 있는가
- [ ] 재현에 실패했을 때 확인할 우선순위(로그 → 헬스체크 → 컨테이너 상태 등)를 적어두었는가

읽어주셔서 감사합니다. 실제로 템플릿을 만들어 보면서 생긴 질문이나 제가 놓친 점이 있다면 같이 고민해보고 싶습니다.