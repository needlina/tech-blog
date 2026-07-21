---
title: "서비스 워커·쿠키 변경으로 인한 세션 불일치 복구 절차"
description: "서비스 워커와 쿠키 변경으로 세션이 어긋날 때 확인할 항목(브라우저 캐시, SW scope, 쿠키 도메인/경로, SameSite/secure), 재현 명령, 서버 로그와 브라우저 검사 방법, 안전한 복구 순서와 검증 명령"
slug: "service-worker-cookie-session-recovery"
date: 2026-07-21 00:10:00 +0900
categories: ["Frontend", "Security"]
tags:
  [
    "service-worker",
    "cookies",
    "session-management",
    "세션복구",
    "보안점검",
    "배포검증"
  ]
image:
  path: /assets/img/posts/blog/service-worker-cookie-session-recovery/preview.png
  alt: "서비스워커·쿠키 세션 복구 썸네일"
---

서비스 워커가 배포되거나 쿠키 이름·속성이 바뀌었을 때 브라우저에 남은 서비스 워커/캐시 때문에 클라이언트가 옛 쿠키를 보내거나 새로운 쿠키를 무시해 서버와 세션이 불일치하는 사례가 자주 발생하며, **브라우저에서 SW 등록 상태, 쿠키 도메인·경로·SameSite·secure, 서버 로그의 세션 ID 비교**를 순서대로 확인하면 안전하게 복구할 수 있습니다.

제가 공부하면서 정리한 내용을 차근차근 적어볼게요. 실무에서 바로 확인할 포인트, 재현 및 복구 명령과 실패/수정 코드 예시도 포함했습니다.

왜 이런 불일치가 발생하나

- 서비스 워커는 네트워크 요청을 가로채고 캐시된 응답이나 오프라인 동작을 제공한다. SW가 오래된 캐싱 로직을 가지고 있으면 새로운 쿠키를 우회하거나, 응답 헤더를 덮어쓰는 일이 생길 수 있다.
- 쿠키 속성이 바뀌면 (ex: domain, path, SameSite, secure) 브라우저가 쿠키를 보내지 않거나 기존 쿠키를 덮어쓰지 못해 세션 탐지 실패로 이어집니다.
- 특히 HTTPS 전환(secure 속성), 서브도메인 변경(도메인 속성), 혹은 HttpOnly 변경 같은 경우에 불일치가 자주 발생합니다.

공부하면서 알게 된 점

- **브라우저 단에서의 우선순위**: 서비스 워커가 네트워크 요청을 가로채면 서버에 도달하기 전 응답이 결정된다. 그래서 서버 로그만 보면 원인을 놓치기 쉽습니다.
- **쿠키 검사 우선순위**: 개발자 도구의 Application 탭에서 보이는 쿠키와 실제 요청에 붙는 쿠키는 다를 수 있습니다(특히 SameSite/secure 조건으로 인해).
- **배포 전 SW 버전 관리 중요성**: SW 변경 시 scope와 캐시 네임을 명확히 관리하면 롤백/업그레이드 시 충돌 빈도를 줄일 수 있었습니다.

![브라우저 콘솔에 401이 뜨는데 서버에는 요청이 아예 안 찍혀요](/assets/img/posts/blog/service-worker-cookie-session-recovery/image-1.webp)
이미지 출처: AI 생성 이미지

처음에는 헷갈렸던 부분

- "브라우저 콘솔에 401이 뜨는데 서버에는 요청이 아예 안 찍혀요" — 이 경우 대개 SW가 응답을 가로채서 클라이언트에 에러를 반환한 사례였습니다. SW를 unregister 하지 않으면 재현이 어렵더군요.
- 쿠키가 Application에 보이는데 request headers에는 없는 경우 — SameSite 또는 secure/HTTP vs HTTPS 차이가 원인일 가능성이 높았습니다.

간단 재현(로컬)

1. 기존 세션 쿠키 이름: session_id, path=/, domain=example.test
2. 배포로 cookie 이름을 변경: session_v2, 또는 SameSite=None, secure 추가
3. 브라우저는 이전 SW와 캐시를 그대로 쓰고 있음
4. 결과: 브라우저가 여전히 session_id를 보내거나 아무 쿠키도 보내지 않아 서버에서 세션 미검증(로그: "Invalid session: cookie missing" 또는 "Session ID mismatch: cookie=abc, store=def")

검증·진단 절차(실무용 체크 순서)

1. 브라우저에서 SW 등록 상태 확인
   - Chrome: DevTools > Application > Service Workers
   - 확인 항목: 등록된 SW 파일 경로(/service-worker.js), scope, last updated
   - 명령(자동화 재현): 브라우저에서 수동으로 unregister 또는 헤드리스 테스트로 unregister
     - DevTools 프로토콜 명령 사용 가능(예: puppeteer 페이지.serviceWorker.unregister())
2. 네트워크 요청에 붙는 쿠키 확인
   - DevTools > Network > 요청 선택 > Headers > Request Headers: Cookie
   - curl로 재현:
     - 재현 커맨드(쿠키 첨부): curl -i -b "session_v2=abc123" https://app.example.test/api/profile
     - 쿠키 없음 재현: curl -i https://app.example.test/api/profile
3. 서버 로그에서 세션 비교
   - 로그 예: 2026-07-21T09:12:03Z WARN Session ID mismatch: cookie=abc123 store=def456
   - 로그 파일 경로 예: /var/log/myapp/access.log, /var/log/myapp/error.log
4. 쿠키 속성 점검
   - 서버 설정(Express 예시):
     ```js
     // 실패 예: session cookie가 secure 없이 생성되어 https에서 무시되는 경우
     app.use(
       session({
         name: "session_v2",
         secret: "keyboard-cat",
         resave: false,
         saveUninitialized: false,
         cookie: { httpOnly: true } // secure 누락
       })
     );
     ```
     ```js
     // 수정 예: https 전환 시 secure, SameSite 명시
     app.use(
       session({
         name: "session_v2",
         secret: "keyboard-cat",
         resave: false,
         saveUninitialized: false,
         cookie: { path: "/", httpOnly: true, secure: true, sameSite: "Lax" }
       })
     );
     ```
   - Express 버전 예: express-session v1.17.3, Node.js v18.16.0
5. SW 캐시/응답 변경 여부 확인
   - SW 코드에서 fetch 이벤트 리스너 확인(예: 캐시 우선 전략이 인증 응답을 캐시하는 경우 문제)
   - SW 파일 경로: /service-worker.js, scope: '/'
   - 실패 예 SW (캐시된 인증 응답 반환):
     ```js
     self.addEventListener("fetch", (event) => {
       event.respondWith(
         caches
           .match(event.request)
           .then((resp) => resp || fetch(event.request))
       );
     });
     ```
   - 수정 예 (인증 API는 네트워크 우선으로 처리):
     ```js
     self.addEventListener("fetch", (event) => {
       if (event.request.url.includes("/api/")) {
         event.respondWith(fetch(event.request));
         return;
       }
       event.respondWith(
         caches
           .match(event.request)
           .then((resp) => resp || fetch(event.request))
       );
     });
     ```
6. 브라우저와 서버에서 동기화된 상태 만들기
   - 사용자에게 안전한 처리: 강제 로그아웃 후 재로그인 유도(예: 401 응답 시 클라이언트에서 clear cookies + unregister SW 후 /login 리디렉션)
   - 브라우저 자동화 예(Puppeteer):
     ```js
     await page.evaluate(() => {
       navigator.serviceWorker
         .getRegistrations()
         .then((rs) => rs.forEach((r) => r.unregister()));
       document.cookie = "session_v2=; Max-Age=0; path=/; domain=example.test";
     });
     ```
   - API로 쿠키 만료시키기: Set-Cookie: session_v2=; Max-Age=0; Path=/; HttpOnly; Secure

복구 절차 요약(안전한 순서)

1. 사용자 영향 최소화: 에러 페이지에서 "세션 만료/재로그인" 안내 제공
2. 서버에서 문제 원인 잠정 차단: 새 쿠키에 대해 이전 쿠키도 허용(롤백 토큰) 또는 로그인 상태 강제 갱신 API 제공
3. 브라우저 레벨에서 SW unregister 권장(긴급): 사용자에게 안내(버전 업데이트 메시지)
4. 배포 후 모니터링: 5분 간격으로 성공/실패 요청 비율, 401/403 건수 확인

![서비스 워커가 네트워크 요청을 가로채는 간단한 개념도](/assets/img/posts/blog/service-worker-cookie-session-recovery/image-2.webp)
이미지 출처: AI 생성 이미지

비교: 세션 불일치 복구 전략

| 전략                      | 언제 쓰나              | 장점                    | 단점                                   |
| ------------------------- | ---------------------- | ----------------------- | -------------------------------------- |
| 강제 재로그인 유도        | 빠르게 일괄 복구 필요  | 안전하고 간단           | 사용자 불편, 이탈 위험                 |
| SW unregister + 쿠키 만료 | SW가 원인일 때 우선    | 브라우저 상태 정리 가능 | 사용자 브라우저 조치 필요(자동화 필요) |
| 서버에서 이전 쿠키 허용   | 쿠키 이름/속성 변경 때 | 무중단 롤백 가능        | 복잡한 로직, 잠재 보안 위험            |
| 캐시 정책 수정(SW)        | 인증 응답이 캐시될 때  | 근본 원인 제거          | 배포 후 동기화 문제 여전               |

실패 예시와 수정 예시 (재현 가능한 명령 포함)

- 실패 상황: Chrome(버전 115)에서 HTTPS 전환 후 secure 속성 추가. 서버 로그:
  - "WARN Session cookie missing for request /api/data from 192.0.2.1"
  - Reproduce with curl (브라우저와 다르게 동작 확인):
    - curl -i -H "Host: app.example.test" https://app.example.test/api/data
- 수정 후 확인:
  - 서버에서 Set-Cookie 확인: Set-Cookie: session_v2=abc123; Path=/; Secure; HttpOnly; SameSite=Lax
  - curl -k -i -b "session_v2=abc123" https://app.example.test/api/data
  - 성공 시 HTTP/1.1 200 OK

자주 묻는 질문
Q: 서비스 워커를 완전히 비활성화하려면?  
A: DevTools > Application > Service Workers > Unregister 또는 스크립트에서 navigator.serviceWorker.getRegistrations()로 unregister. 자동화는 Puppeteer/Playwright로 가능.

Q: 쿠키가 Application에는 보이는데 요청에 안 붙는 이유는?  
A: SameSite, secure 속성, 도메인/경로 불일치 또는 서브도메인 차이일 가능성이 큽니다. 또한 HttpOnly는 JS에서 안 보이지만 요청엔 붙습니다.

Q: 서버에서 이전 쿠키를 허용해도 보안상 문제 없나요?  
A: 잠정적으로는 가능하지만 **장기적으로는 위험**할 수 있습니다. 이전 쿠키가 탈취된 상태라면 허용은 공격 표면을 늘립니다. 단기간의 롤백 용도로만 쓰세요.

Q: 자동화로 사용자의 SW를 정리하는 게 가능한가요?  
A: 브라우저 내부에서만 가능하므로 클라이언트 코드나 PWA 업데이트 로직으로 안내/유도해야 합니다. 원격에서 일괄 삭제는 불가능합니다.

실무 체크리스트

- 브라우저 측
  - [ ] DevTools > Application > Service Workers에서 등록 상태·scope 확인
  - [ ] Network 탭에서 실제 Request Headers의 Cookie 확인
  - [ ] Application > Cookies에서 domain/path/SameSite/secure 확인
- 서버 측
  - [ ] 로그에서 "Session ID mismatch" 혹은 401 증가 시점 확인 (로그 경로: /var/log/myapp/\*.log)
  - [ ] Set-Cookie 헤더가 의도한 속성으로 발급되는지 확인 (curl -I -k https://...)
  - [ ] 세션 저장소(예: Redis)에서 session keys 갱신/중복 여부 확인
- 배포·SW
  - [ ] 서비스 워커 파일명/캐시 네임을 배포마다 변경하여 캐시 충돌 방지
  - [ ] 인증 관련 API를 캐시하지 않도록 SW 정책 수정
  - [ ] 롤백 계획: 이전 쿠키 허용 기간, 강제 로그아웃 경로 준비
- 검증 명령(재현·확인)
  - curl -i -b "session_v2=abc123" https://app.example.test/api/profile
  - tail -n 200 /var/log/myapp/error.log | grep "Session"
  - Puppeteer 스크립트로 navigator.serviceWorker.getRegistrations()

마무리

- 우선순위로는 1) 브라우저에서 SW 등록/캐시 여부 확인, 2) 요청에 실제 어떤 쿠키가 붙는지 검사, 3) 서버 로그에서 세션 ID 불일치 증거 확인을 먼저 하세요.
- 만약 SW가 인증 응답을 캐시해 생긴 문제라면 SW 수정(캐시 정책 변경)과 함께 빠르게 unregister 유도하는 것이 좋습니다.
- 반대로 쿠키 속성 변경(secure/SameSite/domain)으로 인한 문제라면 서버에서 이전 쿠키를 일시 허용해 무중단 롤백을 쓰되, **허용 기간은 최소화**하고 모니터링을 강화하는 편이 안전할 것 같습니다.
