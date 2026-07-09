---
title: "Docker Compose로 안정적인 로컬 개발 환경 구성하기"
slug: "docker-compose-local-development-setup"
date: 2026-07-09 10:00:00 +0900
categories: [Docker, DevOps]
tags: [docker-compose, docker, local-development, devops, linux]
---

로컬에서 여러 서비스(웹앱, 데이터베이스, 캐시 등)를 함께 띄워 개발할 때 Docker Compose를 쓰면 편리합니다. 제가 공부하면서 직접 적용해본 경험을 정리해보면, 단순히 컨테이너를 띄우는 것을 넘어서 "안정적이고 재현 가능한" 개발 환경을 만드는 데 신경 써야 할 포인트가 꽤 있었습니다. 이 글은 제가 배운 내용을 초보자 관점에서 정리한 것이며, 실무에서 점검해볼 항목 위주로 적었습니다. 틀릴 수 있으니 한 가지 방법으로만 받아들이지 말고 프로젝트에 맞게 조정해 보세요.

목차
- 왜 Docker Compose인가
- 기본 구조와 예제 구성 파일
- 주요 설정 설명(볼륨, 네트워크, 환경변수, healthcheck 등)
- 권장하는 실행/점검 명령어와 절차
- 처음에 헷갈렸던 부분
- 공부하면서 알게 된 점
- 실무에서는 이렇게 확인하면 좋겠다
- 실무 체크리스트

왜 Docker Compose인가
- 복수 서비스(앱 + DB + 캐시 등)를 한 번에 정의하고 실행/정지할 수 있어 반복성이 좋아집니다.
- 구성 파일(docker-compose.yml)로 팀원 간 동일한 로컬 환경을 공유하기 쉽습니다.
- 다만 Compose가 모든 문제를 해결해주지는 않습니다. 특히 "서비스가 완전히 준비되었는지" 확인하는 부분은 추가 조치가 필요하더군요.

기본 구조와 예제 구성 파일
간단한 예제로 Node.js 앱 + PostgreSQL을 띄우는 구성을 보여드립니다.

docker-compose.yml (예시)
```yaml
version: "3.8"
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    env_file:
      - .env
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/mydb
    volumes:
      - ./:/usr/src/app:cached
      - node_modules:/usr/src/app/node_modules
    depends_on:
      - db
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3

  db:
    image: postgres:15
    restart: unless-stopped
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=mydb
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
  node_modules:
```

간단한 Dockerfile (Node 앱)
```dockerfile
FROM node:20-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

.env 예시
```
NODE_ENV=development
# 민감한 값은 .env 대신 다른 비밀 관리 방식 고려
```

주요 설정과 실무 포인트
- volumes: 소스 코드를 바인드 마운트하면 편하지만 파일 권한 문제(특히 Linux에서 UID/GID)가 발생할 수 있습니다. 필요하면 Compose에서 user: "${UID}:${GID}"로 매핑하거나 Dockerfile 내에서 적절히 권한을 조정하세요.
- named volumes: DB 데이터는 named volume을 쓰는 게 안전합니다. 개발에서 자주 초기화하려면 docker-compose down -v로 지울 수 있지만, 실수로 데이터 손실이 생길 수 있으니 주의하세요.
- env_file vs environment: .env 파일로 기본값을 두고, 기밀 정보는 별도로 관리하세요. Git에 절대 업로드하지 마세요.
- depends_on: 컨테이너 시작 순서를 보장하지만 "서비스 준비(ready)"는 보장하지 않습니다. 따라서 DB가 "시작"되었더라도 연결이 바로 가능한 상태가 아닐 수 있습니다.
- healthcheck: 각 서비스의 가용성을 판단하기 위해 healthcheck를 적극 활용하면 좋습니다. 다만 healthcheck가 완벽한 준비 상태 판별을 보장하지 않을 수도 있으니 애플리케이션 레벨 검사(endpoint)나 초기화 스크립트를 함께 사용하세요.
- 데이터베이스 마이그레이션: 컨테이너 시작 시 자동으로 마이그레이션을 실행하려면 별도 entrypoint 스크립트나 init 컨테이너 패턴을 고려하세요. 단, 로컬 개발에서는 수동 실행이 안전할 수 있습니다.

서비스 준비(wait-for)의 한계와 접근법
- depends_on은 시작순서만 제어합니다. "db가 연결 가능한지"까지 기다리려면 다음 중 하나를 고려합니다.
  - 앱에서 재시도 로직을 구현(권장).
  - wait-for.sh 같은 스크립트로 포트나 HTTP 엔드포인트를 체크한 뒤 앱을 실행.
  - healthcheck와 함께 컨테이너 상태를 확인하고 CI 스크립트에서 대기.

예: 간단한 wait-for.sh 사용 예
```bash
#!/usr/bin/env bash
# wait-for.sh host:port -- command
set -e
hostport="$1"
shift
cmd="$@"

until nc -z $(echo $hostport | cut -d: -f1) $(echo $hostport | cut -d: -f2); do
  echo "waiting for $hostport..."
  sleep 1
done

exec $cmd
```

실행 및 점검 명령어(실무에서 유용)
- 빌드 및 백그라운드 실행
  - docker-compose up --build -d
- 로그 확인
  - docker-compose logs -f app
  - docker-compose logs --tail=200
- 상태 확인
  - docker-compose ps
  - docker ps --filter "name=project"
- 컨테이너 내부 진입
  - docker-compose exec app sh
  - docker exec -it <container-id> bash
- 리소스 사용 확인
  - docker stats
- 네트워크/볼륨 확인
  - docker network ls
  - docker inspect <network>
  - docker volume ls
  - docker volume inspect <volume>
- 구성 검증
  - docker-compose config  # 합쳐진 구성 확인
- 정리
  - docker-compose down -v --remove-orphans
  - docker system prune -f (주의: 모든 dangling 자원 정리)

처음에는 헷갈렸던 부분
- "depends_on이 서비스 준비를 기다린다"는 오해: 실제로는 컨테이너가 '시작'된 것까지만 확인해줍니다. DB가 초기화 중이면 앱이 연결에 실패합니다.
- 볼륨과 바인드 마운트의 차이: 개발 편의를 위해 소스 코드를 마운트하면 실시간 변경이 가능하지만, 호스트와 컨테이너 간 권한/퍼미션 충돌이 종종 일어났습니다.
- healthcheck 설정법: Dockerfile에 넣을 수도 있고 Compose에 넣을 수도 있는데, 테스트 커맨드를 어떻게 구성하느냐에 따라 신뢰도가 달라졌습니다.

공부하면서 알게 된 점
- 로컬에서 "실제 운영 환경과의 차이"를 너무 작게 잡으면 운영에서 이슈가 납니다. 예를 들어, 운영에서는 데이터베이스 비밀번호를 시크릿 관리 도구로 두는데 로컬에서는 .env를 쓰기 쉽습니다. 이 차이를 의식해 두는 게 좋았습니다.
- 애플리케이션 수준의 재시도/지연(backoff) 로직이 있으면 Compose와의 조합에서 훨씬 안정적입니다. 인프라 측에서만 해결하려 하기보다 앱 쪽 회복 능력도 고려하는 것이 더 현실적인 접근 같습니다.
- team의 온보딩 문서화: docker-compose로 띄우는 환경은 문서화(예: README, Makefile 명령)와 함께 제공해야 온보딩 속도가 상당히 빨라졌습니다.

실무에서는 이렇게 확인하면 좋겠다
- 기초 점검(환경 구성 직후)
  - docker-compose config로 유효성 확인
  - docker-compose up --build -d 후 docker-compose ps로 서비스 상태 확인
  - docker-compose logs --tail=100으로 최근 로그 확인
- 서비스 가용성 점검
  - 앱 엔드포인트(예: /health)에 curl로 접근해 200 응답 확인
  - DB 연결 확인: docker-compose exec app psql "$DATABASE_URL" -c '\l' 또는 호스트에서 psql -h localhost -p 5432 ...
  - 컨테이너의 health 상태 확인: docker inspect --format='{{json .State.Health}}' <container>
- 리소스/성능 점검(로컬 개발에서도)
  - docker stats로 CPU/메모리 확인. 너무 큰 리소스 소비가 있는지 확인.
  - 디스크 사용량: docker system df
- 권한/파일 이슈 점검
  - 파일 소유자와 권한 문제: docker-compose exec app ls -la
  - node_modules 같은 의존성 디렉터리는 volume으로 격리하거나 컨테이너 빌드 내에서 처리
- 종료/정리
  - docker-compose down -v으로 깨끗하게 정리(주의: 데이터 삭제)

실무 체크리스트
- [ ] docker-compose.yml에 version과 서비스가 명확히 정의되어 있는가?
- [ ] docker-compose config로 문법 에러를 확인했는가?
- [ ] .env 파일이나 시크릿 관리 방식을 문서화했는가? 민감 데이터가 Git에 올라가 있지 않은가?
- [ ] DB 등 상태 의존 서비스에 대해 healthcheck 또는 재시도 메커니즘이 있는가?
- [ ] 로컬에서 마이그레이션을 실행하는 방법(자동/수동)을 팀에서 합의했는가?
- [ ] 권한 이슈(Uid/Gid, 파일 소유권)로 개발이 막히지 않도록 처리했는가?
- [ ] docker-compose logs, docker stats, docker exec로 빠르게 문제를 진단할 수 있는가?
- [ ] 불필요한 볼륨/이미지가 남지 않도록 정리 절차가 있는가(down -v, prune 등)?
- [ ] 온보딩 문서(README, Makefile 등)가 있어 새 팀원이 빠르게 환경을 띄울 수 있는가?

마치며
이번 글에서는 로컬 개발 환경을 안정적으로 만들기 위해 Docker Compose를 어떻게 구성하고 점검하면 좋은지 제가 공부하면서 정리한 내용을 적었습니다. 중요한 점은 "Compose가 모든 걸 알아서 해주지 않는다"는 점과 "앱 레벨의 회복성(retry/backoff)까지 함께 설계하면 더 안정적"이라는 체험적 인사이트였습니다. 프로젝트나 팀의 요구에 따라 구성은 달라질 수 있으니 이 글을 출발점으로 삼아 적용해 보시길 권합니다. 질문이나 제가 놓친 점이 있으면 같이 살펴보면 좋겠습니다.