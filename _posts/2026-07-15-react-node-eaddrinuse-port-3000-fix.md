---
title: "React/Node.js 실행 오류 listen EADDRINUSE address already in use 3000 해결 방법"
slug: "react-node-eaddrinuse-port-3000-fix"
date: 2026-07-15 11:10:00 +0900
categories: [Frontend, Backend]
tags: [nodejs, react, eaddrinuse, port, troubleshooting]
image:
  path: /assets/img/posts/blog/react-node-eaddrinuse-port-3000-fix/preview.png
  alt: "React/Node.js 실행 오류 listen EADDRINUSE address already in use 3000 해결 방법 썸네일"
---

## 오늘의 주제

React나 Node.js 개발 서버 실행 중 `listen EADDRINUSE: address already in use :::3000` 에러가 날 때 포트를 확인하고 정리하는 방법

프론트엔드 프로젝트를 실행하다 보면 가장 자주 만나는 에러 중 하나가 포트 충돌입니다. 특히 React, Next.js, Express, Vite, NestJS 같은 개발 서버를 띄울 때 `3000`, `5173`, `8080` 같은 포트를 이미 다른 프로세스가 쓰고 있으면 서버가 시작되지 않습니다.

대표적인 에러는 아래처럼 보입니다.

```text
node:events:491
      throw er; // Unhandled 'error' event
      ^

Error: listen EADDRINUSE: address already in use :::3000
```

처음 이 메시지를 봤을 때는 Node.js 자체가 깨진 것처럼 느껴졌는데, 공부해보니 대부분은 "이미 3000번 포트를 쓰고 있는 프로세스가 있다"는 뜻이었습니다. 그래서 이번 글에서는 무작정 재부팅하기 전에 확인할 수 있는 순서를 정리해보겠습니다.

## 에러 의미 먼저 보기

`EADDRINUSE`는 address already in use의 줄임말로 이해하면 됩니다. 서버 프로그램은 특정 IP와 포트에 바인딩해서 요청을 기다리는데, 같은 주소와 포트를 이미 다른 프로세스가 잡고 있으면 새 서버가 열리지 않습니다.

에러 메시지의 `:::3000`은 IPv6 표기에서 모든 인터페이스의 3000번 포트를 의미할 수 있습니다. 실무에서는 보통 "내 로컬 3000번 포트가 이미 사용 중이다" 정도로 해석하고 원인을 찾기 시작하면 됩니다.

자주 발생하는 상황은 아래와 같습니다.

- 이전에 실행한 React 개발 서버가 종료되지 않았다.
- 터미널은 닫았지만 Node 프로세스가 백그라운드에 남아 있다.
- Docker 컨테이너가 호스트의 3000번 포트를 사용 중이다.
- 백엔드 Express 서버와 프론트엔드 개발 서버가 같은 포트를 쓰고 있다.
- 테스트 서버나 Storybook 같은 도구가 같은 포트를 사용한다.
- Windows에서 WSL, Docker Desktop, 로컬 Node가 포트를 같이 쓰고 있다.

## 공부하면서 알게 된 점

포트 충돌은 코드 버그라기보다 실행 환경 문제인 경우가 많았습니다. 물론 서버 코드에서 `app.listen(3000)`을 여러 번 호출하는 실수도 있을 수 있지만, 로컬 개발 중에는 기존 프로세스가 남아 있는 경우가 훨씬 흔했습니다.

또 하나 알게 된 점은 운영체제마다 포트를 확인하는 명령어가 다르다는 것입니다. Windows에서는 `netstat` 또는 PowerShell의 `Get-NetTCPConnection`을 쓰고, macOS/Linux에서는 `lsof`나 `ss`를 많이 씁니다. 그래서 팀 문서에는 OS별 명령어를 함께 적어두는 편이 좋겠다고 느꼈습니다.

![여러 개발 서버가 하나의 3000번 포트를 두고 충돌하는 모습을 단순하게 표현한 기술 일러스트](/assets/img/posts/blog/react-node-eaddrinuse-port-3000-fix./image-1.webp)
이미지 출처: AI 생성 이미지

## 1단계: 어떤 포트가 충돌했는지 확인

에러 메시지에서 포트를 먼저 확인합니다.

```text
Error: listen EADDRINUSE: address already in use :::3000
```

여기서는 3000번 포트가 문제입니다. 만약 메시지가 `127.0.0.1:5173`이라면 5173번 포트, `0.0.0.0:8080`이라면 8080번 포트를 보면 됩니다.

Node.js 서버 코드에 포트가 하드코딩되어 있는지도 확인합니다.

```js
app.listen(3000, () => {
  console.log("server started");
});
```

환경 변수로 포트를 받는 프로젝트라면 `.env`, `package.json`, 실행 스크립트를 같이 봅니다.

```bash
PORT=3000 npm run dev
```

## 2단계: Windows에서 포트 사용 프로세스 찾기

Windows PowerShell에서는 아래 명령으로 3000번 포트를 쓰는 프로세스를 찾을 수 있습니다.

```powershell
Get-NetTCPConnection -LocalPort 3000 | Select-Object LocalAddress,LocalPort,State,OwningProcess
```

`OwningProcess`에 나온 PID를 기준으로 프로세스 이름을 확인합니다.

```powershell
Get-Process -Id <PID>
```

예를 들어 PID가 12345라면 이렇게 봅니다.

```powershell
Get-Process -Id 12345
```

전통적인 `netstat` 방식도 사용할 수 있습니다.

```cmd
netstat -ano | findstr :3000
tasklist /FI "PID eq 12345"
```

여기서 `LISTENING` 상태인 프로세스가 있으면 그 프로세스가 포트를 잡고 있는 것입니다.

## 3단계: macOS/Linux에서 포트 사용 프로세스 찾기

macOS나 Linux에서는 `lsof`가 가장 익숙한 편입니다.

```bash
lsof -i :3000
```

Linux에서는 `ss`로도 확인할 수 있습니다.

```bash
ss -ltnp | grep :3000
```

출력에서 PID와 프로세스 이름을 확인합니다. Node 개발 서버라면 보통 `node` 또는 패키지 매니저에서 실행한 프로세스로 보일 수 있습니다.

## 4단계: 프로세스를 종료하기 전에 확인할 것

포트를 잡고 있는 프로세스를 찾았다고 바로 종료하면 안 되는 경우도 있습니다. 특히 회사 장비나 공용 개발 서버에서는 다른 사람이 띄운 프로세스일 수 있습니다.

로컬 개인 개발 환경이라면 보통 아래를 확인합니다.

- 내가 방금 실행한 개발 서버가 맞는가?
- Docker 컨테이너가 포트를 쓰는 것은 아닌가?
- IDE나 테스트 도구가 자동으로 서버를 띄운 것은 아닌가?
- 백엔드 서버가 3000번 포트를 쓰고 있는데 프론트엔드도 같은 포트를 쓰려는 것은 아닌가?

Docker가 의심되면 아래처럼 봅니다.

```bash
docker ps
```

포트 매핑에 `0.0.0.0:3000->3000/tcp` 같은 값이 있다면 컨테이너가 3000번 포트를 쓰고 있는 것입니다.

## 5단계: 포트 강제 종료

내가 종료해도 되는 프로세스가 맞다면 PID 기준으로 종료합니다.

Windows PowerShell:

```powershell
Stop-Process -Id <PID> -Force
```

Windows cmd:

```cmd
taskkill /PID <PID> /F
```

macOS/Linux:

```bash
kill -9 <PID>
```

다만 `kill -9`는 강제 종료라서 마지막 수단에 가깝게 보는 편이 좋겠습니다. 가능하다면 먼저 실행 중인 터미널에서 `Ctrl + C`로 정상 종료하고, 그래도 남아 있을 때 PID 종료를 사용합니다.

Docker 컨테이너가 원인이면 컨테이너를 중지합니다.

```bash
docker stop <container-id>
```

## 6단계: 포트를 바꿔서 실행하기

기존 프로세스를 죽일 수 없는 상황이라면 새 개발 서버의 포트를 바꾸는 방법도 있습니다.

React Create React App:

```bash
PORT=3001 npm start
```

Windows PowerShell에서는 환경 변수 지정 방식이 다릅니다.

```powershell
$env:PORT=3001
npm start
```

Vite:

```bash
npm run dev -- --port 3001
```

Next.js:

```bash
next dev -p 3001
```

Express 서버라면 `.env`를 사용하도록 코드를 정리해두면 편합니다.

```js
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`server started on ${port}`);
});
```

이렇게 해두면 로컬, 테스트, 운영 환경에서 포트를 다르게 줄 수 있습니다.

## 7단계: package.json 스크립트 정리

팀 프로젝트에서는 포트가 겹치지 않도록 `package.json`에 명시해두는 것도 좋았습니다.

```json
{
  "scripts": {
    "dev:frontend": "vite --host 0.0.0.0 --port 3000",
    "dev:api": "node server.js"
  }
}
```

백엔드와 프론트엔드를 동시에 띄우는 프로젝트라면 포트를 미리 나눕니다.

```text
frontend: 3000
backend: 4000
storybook: 6006
mock-server: 4010
```

이런 규칙이 없으면 새로 합류한 사람이 매번 같은 에러를 만날 수 있습니다.

![포트 확인, PID 조회, 프로세스 종료, 재실행으로 이어지는 문제 해결 흐름도](/assets/img/posts/blog/react-node-eaddrinuse-port-3000-fix./image-2.webp)
이미지 출처: AI 생성 이미지

## 처음에는 헷갈렸던 부분

저는 처음에 `node:events:491 throw er`라는 줄 때문에 Node.js 이벤트 처리 코드에 문제가 있다고 생각했습니다. 하지만 실제 원인은 그 아래 `EADDRINUSE`였습니다. 에러 로그는 위에서부터 읽는 것도 중요하지만, Node.js에서는 마지막에 있는 `code`, `errno`, `syscall`, `address`, `port`가 더 직접적인 단서가 되는 경우가 많았습니다.

예를 들어 아래처럼 정리해서 보면 원인이 더 빨리 보입니다.

```text
code: EADDRINUSE
syscall: listen
address: ::
port: 3000
```

즉, "listen 하려던 3000번 포트가 이미 사용 중"이라고 해석하면 됩니다.

## 실무에서는 이렇게 확인하면 좋겠다

실무에서는 포트 충돌을 단순히 프로세스 종료로만 끝내지 않고, 왜 남았는지까지 보는 편이 좋겠습니다.

- 개발 서버 종료 스크립트가 제대로 동작하는지
- 테스트가 끝난 뒤 서버를 정리하는지
- Docker Compose 종료 시 `docker compose down`을 사용했는지
- 로컬 문서에 서비스별 포트가 정리되어 있는지
- CI나 preview 환경에서 동적 포트를 사용하는지

특히 여러 서비스를 동시에 띄우는 모노레포에서는 포트 관리가 꽤 중요합니다. 포트 표를 README에 넣어두면 생각보다 많은 시간을 줄일 수 있습니다.

## 실무 체크리스트

- [ ] 에러 메시지에서 충돌한 포트 번호를 확인했다.
- [ ] Windows에서는 `Get-NetTCPConnection` 또는 `netstat`로 PID를 찾았다.
- [ ] macOS/Linux에서는 `lsof` 또는 `ss`로 PID를 찾았다.
- [ ] 해당 PID가 종료해도 되는 개발 프로세스인지 확인했다.
- [ ] Docker 컨테이너가 같은 포트를 쓰고 있지 않은지 확인했다.
- [ ] 가능한 경우 `Ctrl + C`로 정상 종료한 뒤, 필요할 때만 강제 종료했다.
- [ ] 기존 프로세스를 종료할 수 없으면 새 서버 포트를 변경했다.
- [ ] 팀 문서나 `package.json`에 서비스별 포트 규칙을 정리했다.

## 참고 자료

- [Node.js Errors: Common system errors](https://nodejs.org/api/errors.html#common-system-errors) - `EADDRINUSE`가 로컬 주소를 이미 다른 서버가 사용 중일 때 발생한다는 설명을 확인할 때 참고했습니다.
- [Node.js net server.listen](https://nodejs.org/api/net.html#serverlisten) - Node.js 서버가 포트에 바인딩해 요청을 기다리는 구조를 이해할 때 참고했습니다.

`EADDRINUSE`는 무서운 에러라기보다 로컬 개발 환경에서 자주 생기는 포트 충돌 문제에 가깝습니다. 에러 로그에서 포트를 찾고, 포트를 잡고 있는 PID를 확인하고, 종료하거나 다른 포트로 실행하면 대부분 해결할 수 있었습니다.
