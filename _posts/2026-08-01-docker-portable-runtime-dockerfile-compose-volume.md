---
title: "도커를 휴대용 실행 환경으로 쓰는 법: Dockerfile, Compose, Volume을 한 세트로 보기"
description: "Dockerfile로 실행 환경을 코드화하고 Docker Compose로 앱·DB·캐시를 묶으며 Volume으로 데이터를 보존하는 도커 활용 기준"
slug: "docker-portable-runtime-dockerfile-compose-volume"
date: 2026-08-01 15:15:00 +0900
categories: ["Docker", "DevOps"]
tags:
  ["docker", "dockerfile", "docker-compose", "volumes", "온보딩", "장애대응"]
image:
  path: /assets/img/posts/blog/docker-portable-runtime-dockerfile-compose-volume/preview.png
  alt: "도커를 휴대용 실행 환경으로 쓰는 법 썸네일"
---

도커를 제대로 쓴다는 말은 컨테이너를 하나 띄우는 명령을 외우는 것보다, 애플리케이션이 돌아가는 환경을 **휴대 가능한 실행 단위**로 만드는 것에 가깝다. Dockerfile은 환경을 코드로 남기고, Docker Compose는 여러 컨테이너를 한 번에 묶고, Volume은 컨테이너가 사라져도 데이터가 남도록 생명주기를 분리한다.

처음에는 도커를 “서버에 뭔가 설치하지 않고 실행하는 도구” 정도로만 생각했다. `docker run nginx` 같은 명령을 보면 굉장히 간단해 보인다. 그런데 실제 프로젝트에 붙여보면 금방 질문이 늘어난다.

- Node 버전은 어디에 고정하지?
- PostgreSQL은 매번 따로 띄워야 하나?
- 로컬에서 만든 DB 데이터는 컨테이너를 지우면 어떻게 되지?
- 다른 사람이 같은 환경을 재현하려면 README를 얼마나 자세히 써야 하지?

이 질문을 따라가다 보니 도커의 편리함은 단순히 “컨테이너 실행”에 있지 않았다. 더 정확히는 **실행 환경을 포장하고, 옮기고, 다시 펼치는 방식**에 있었다.

## Dockerfile은 환경을 말로 설명하지 않게 해준다

프로젝트를 새로 받은 사람이 `README.md`를 보면서 Node.js 22를 설치하고, 패키지를 설치하고, 빌드 명령을 실행하는 흐름은 익숙하다. 문제는 그 과정이 사람의 PC마다 조금씩 달라진다는 점이다.

예를 들어 누군가는 Node.js 20을 쓰고 있고, 누군가는 22를 쓴다. 로컬에는 이미 전역 패키지가 설치되어 있어서 내 PC에서는 되는데 다른 PC에서는 깨질 수도 있다. 이럴 때 Dockerfile은 “이 앱은 이런 환경에서 실행한다”는 기준선을 코드로 고정해준다.

```Dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
```

이 파일이 있으면 실행 환경을 말로 길게 전달하지 않아도 된다. 적어도 앱이 어떤 베이스 이미지에서 시작하는지, 의존성 설치는 어떤 명령으로 하는지, 마지막 실행 명령은 무엇인지 코드로 남는다.

여기서 중요한 건 Dockerfile이 단순한 설치 스크립트가 아니라는 점이다. Dockerfile은 이미지를 만드는 설계도다. 그리고 이미지는 앱 코드와 런타임을 함께 담은 실행 패키지처럼 다룰 수 있다.

```bash
docker build -t my-app:local .
docker run --rm -p 3000:3000 my-app:local
```

이 두 명령만으로 “내 PC에서 직접 Node를 설치해서 실행하는 방식”과 “이미지로 만든 환경 안에서 실행하는 방식”을 분리해볼 수 있다.

물론 Dockerfile을 쓴다고 모든 차이가 사라지는 건 아니다. CPU 아키텍처, 파일 권한, 네트워크, 환경변수, 외부 API 상태는 여전히 영향을 준다. 그래도 Dockerfile이 있으면 최소한 런타임과 패키지 설치 과정은 훨씬 덜 흔들린다.

## docker run만으로는 프로젝트 전체가 잘 보이지 않았다

컨테이너 하나를 띄울 때는 `docker run`도 충분하다. 그런데 백엔드 앱 하나를 제대로 실행하려고 하면 보통 주변 서비스가 따라온다.

- API 서버
- PostgreSQL
- Redis
- Nginx 또는 reverse proxy
- 테스트용 mail 서버나 mock 서버

이걸 전부 `docker run`으로 실행하려면 포트, 네트워크, 환경변수, 볼륨 이름을 계속 기억해야 한다. 명령이 길어지고, 한 번 성공한 명령을 다시 재현하기가 애매해진다.

예를 들어 PostgreSQL만 따로 띄운다면 이런 명령이 된다.

```bash
docker run --name local-postgres \
  -e POSTGRES_USER=app \
  -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=appdb \
  -p 5432:5432 \
  -v postgres_data:/var/lib/postgresql/data \
  postgres:16
```

이 정도는 괜찮아 보이지만, 여기에 앱 컨테이너와 Redis까지 붙으면 점점 기억력 테스트가 된다. Docker Compose는 이 구성을 파일로 끌어내린다.

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/appdb
      REDIS_URL: redis://redis:6379
    depends_on:
      - db
      - redis

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: appdb
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

volumes:
  postgres_data:
```

이제 실행은 짧아진다.

```bash
docker compose up --build
```

중지할 때는 이렇게 한다.

```bash
docker compose down
```

Compose가 좋은 이유는 명령이 짧아져서만은 아니다. 앱과 DB와 Redis의 관계가 `docker-compose.yml` 안에 보인다. 앱은 `localhost`가 아니라 `db`, `redis`라는 서비스 이름으로 다른 컨테이너에 접근한다. Compose가 같은 프로젝트 네트워크 안에 서비스를 묶어주기 때문이다.

이 지점에서 도커가 “휴대용”이라는 말이 조금 더 선명해진다. Dockerfile만 있으면 앱 컨테이너 하나를 들고 다닐 수 있다. Compose까지 있으면 **앱이 기대하는 주변 환경까지 함께 펼칠 수 있다**.

## Volume은 컨테이너와 데이터를 분리한다

도커를 처음 쓸 때 제일 무서운 부분은 데이터였다. 컨테이너는 지우고 다시 만들 수 있다고 하는데, DB 컨테이너도 그렇게 다뤄도 되는지 헷갈렸다.

정리해보면 컨테이너는 일회용에 가깝게 다루는 편이 좋다. 이미지를 바꾸거나 설정을 수정하면 새 컨테이너로 갈아끼우는 일이 자연스럽다. 대신 DB 데이터처럼 사라지면 안 되는 것은 컨테이너 안에만 두면 위험하다.

그래서 Volume을 쓴다.

```yaml
services:
  db:
    image: postgres:16
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

`postgres_data`는 Docker가 관리하는 named volume이다. 컨테이너 내부의 `/var/lib/postgresql/data` 경로를 이 볼륨에 연결한다. 컨테이너가 새로 만들어져도 같은 볼륨을 다시 붙이면 DB 데이터가 유지된다.

```bash
docker compose down
docker compose up -d
```

위 명령은 컨테이너를 내렸다가 다시 띄우지만 named volume은 남긴다. 반대로 아래 명령은 조심해야 한다.

```bash
docker compose down -v
```

`-v`는 Compose 프로젝트에 연결된 볼륨까지 제거한다. 개발 환경 초기화에는 편하지만, DB 데이터가 들어 있는 볼륨이라면 그대로 날아갈 수 있다. 그래서 `down -v`는 “깨끗하게 지우기”가 아니라 **데이터 삭제 명령**에 가깝게 받아들이는 편이 안전하다.

현재 볼륨을 확인하려면 다음 명령을 쓴다.

```bash
docker volume ls
docker volume inspect docker-portable-runtime-dockerfile-compose-volume_postgres_data
```

Compose가 만든 볼륨 이름은 보통 `<프로젝트명>_<볼륨명>` 형태가 된다. 실제 이름은 `docker volume ls`로 확인하는 게 좋다.

## 이 관점으로 보면 도커 사용법이 꽤 달라진다

도커를 휴대용 실행 환경으로 보면 재미있는 사용법이 생긴다. 단순히 “배포 편하게 하기”에서 끝나지 않는다.

첫 번째는 버그 타임캡슐이다. 특정 오류가 났을 때 Dockerfile, Compose 파일, 최소 DB dump, 로그 샘플을 같이 묶어두면 나중에 그 환경을 다시 열어볼 수 있다. 버그를 말로 설명하는 대신, 버그가 발생한 조건을 최대한 작은 실행 환경으로 보존하는 방식이다.

두 번째는 온보딩 키트다. 새로 합류한 사람이 긴 설치 문서를 따라가기보다 아래 명령으로 시작할 수 있다면 프로젝트 첫 진입 장벽이 많이 낮아진다.

```bash
git clone <repository-url>
cd <repository>
docker compose up --build
```

물론 실제 프로젝트에서는 `.env.example`, seed 데이터, migration 명령까지 맞춰야 한다. 그래도 기준은 분명하다. **프로젝트 실행에 필요한 지식을 사람의 기억이 아니라 파일에 남기는 것**이다.

세 번째는 실행 가능한 블로그 글이다. 기술 글에서 설정 예시만 보여주는 대신, 독자가 그대로 실행할 수 있는 Compose 예제를 함께 두면 글의 신뢰도가 올라간다. 예를 들어 Volume을 설명하는 글이라면 독자가 직접 데이터를 넣고, 컨테이너를 내렸다 올린 뒤, 데이터가 유지되는지 확인할 수 있다.

```bash
docker compose up -d
docker compose exec db psql -U app -d appdb -c "create table memo(id serial primary key, body text);"
docker compose exec db psql -U app -d appdb -c "insert into memo(body) values ('volume test');"
docker compose down
docker compose up -d
docker compose exec db psql -U app -d appdb -c "select * from memo;"
```

이 실험에서 `volume test`가 다시 조회되면 컨테이너가 바뀌어도 데이터가 볼륨에 남았다는 뜻이다.

## 실무에서 먼저 확인할 명령들

도커 구성을 만들고 나면 “잘 뜬다”에서 끝내기보다 몇 가지 명령으로 상태를 확인해두는 편이 좋다.

| 확인 대상     | 명령                         | 보는 것                |
| ------------- | ---------------------------- | ---------------------- |
| Compose 문법  | `docker compose config`      | 최종 병합된 설정       |
| 컨테이너 상태 | `docker compose ps`          | 실행 여부, 포트        |
| 앱 로그       | `docker compose logs -f app` | 시작 오류, 연결 실패   |
| DB 볼륨       | `docker volume ls`           | named volume 생성 여부 |
| 이미지 빌드   | `docker image ls my-app`     | 태그, 생성 시각        |

특히 `docker compose config`는 생각보다 유용하다. YAML 들여쓰기 실수, 환경변수 치환 결과, Compose가 실제로 해석한 최종 구성을 확인할 수 있다.

```bash
docker compose config
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 app
```

DB 연결 오류가 나면 앱 코드부터 보기 전에 Compose 서비스 이름을 확인하는 편이 좋다. Compose 네트워크 안에서 PostgreSQL 서비스 이름이 `db`라면 앱의 연결 주소도 `localhost`가 아니라 `db`를 바라봐야 한다.

```text
ECONNREFUSED 127.0.0.1:5432
```

컨테이너 안에서 이런 오류가 보인다면 DB 컨테이너가 죽었거나, 앱이 컨테이너 내부의 `localhost`를 DB로 착각하고 있을 수 있다. 컨테이너 내부의 `localhost`는 호스트 PC가 아니라 자기 자신이다.

## 내가 잡아둔 기준

지금은 도커를 볼 때 아래 순서로 생각하는 편이 이해하기 쉬웠다.

1. 앱 하나의 실행 환경은 `Dockerfile`에 남긴다.
2. 앱 주변에 필요한 DB, 캐시, 프록시는 `docker-compose.yml`에 묶는다.
3. 사라지면 안 되는 데이터는 named volume으로 분리한다.
4. 환경변수는 `.env.example`로 필요한 키를 드러내되, 실제 비밀값은 커밋하지 않는다.
5. `docker compose config`, `ps`, `logs`, `volume ls`로 재현 가능한지 확인한다.

이렇게 정리하면 도커는 단순한 실행 도구보다 “프로젝트 환경을 담는 상자”처럼 보인다. 코드는 Dockerfile로 이미지가 되고, 여러 실행 단위는 Compose로 하나의 작은 시스템이 되고, 데이터는 Volume으로 따로 살아남는다.

그래서 “도커는 휴대용인가?”라고 묻는다면, 나는 이제 “앱 자체보다 앱의 실행 환경을 휴대 가능하게 만든다”고 답할 것 같다. 다만 그 휴대성은 공짜가 아니다. Dockerfile, Compose, Volume을 각각 따로 외우는 데서 멈추지 않고, 셋을 한 세트로 설계해야 제대로 힘이 난다.
