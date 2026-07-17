---
title: "브라우저 토큰 저장 비교: localStorage vs Cookies — 실무에서 확인할 포인트"
description: "오늘은 브라우저에서 인증 토큰을 어디에 저장할지 고민하면서 정리한 내용을 공유하려고 합니다. 제가 이 주제를 처음 접했을 때는 \"localStorage는 무조건 안 되고, 쿠키는 무조건 좋다\" 같은 단순한 이야기만 들었는데, 공부하면서 보니 상황에 따라 장단점이 있고"
slug: "browser-token-storage-localstorage-cookie"
date: 2026-07-14 10:00:00 +0900
categories: [Frontend, Security]
tags: [auth-tokens, localstorage, cookies, web-security, csrf, jwt]
image:
  path: /assets/img/posts/blog/browser-token-storage-localstorage-cookie/preview.png
  alt: "토큰을 어디에 저장할까 썸네일"
---

오늘은 브라우저에서 인증 토큰을 어디에 저장할지 고민하면서 정리한 내용을 공유하려고 합니다. 제가 이 주제를 처음 접했을 때는 "localStorage는 무조건 안 되고, 쿠키는 무조건 좋다" 같은 단순한 이야기만 들었는데, 공부하면서 보니 상황에 따라 장단점이 있고 실무에서는 확인해야 할 항목이 많이 있었습니다. 아래는 제가 공부하면서 정리한 요점과, 처음에 헷갈렸던 부분, 그리고 실무에서 점검하면 좋을 부분들을 중심으로 적어본 초안입니다. 틀릴 가능성이 있으니 참고용으로만 봐 주세요.

![브라우저와 서버 사이에서 토큰이 이동하는 흐름을 단순한 아이콘으로 표현한 다이어그램](/assets/img/posts/blog/browser-token-storage-localstorage-cookie/image-1.webp)
이미지 출처: AI 생성 이미지

## 핵심 요약(간단히)

- localStorage: JavaScript에서 쉽게 접근 가능(장점/단점). XSS에 취약하면 토큰이 탈취될 수 있음. CORS/credential 설정과 별개로 브라우저 저장소에 존재.
- Cookies: HttpOnly + Secure로 설정하면 JS 접근을 차단할 수 있어 XSS 위험을 줄여줌. 그러나 쿠키는 기본적으로 브라우저가 요청에 자동 포함하므로 CSRF에 신경 써야 함. SameSite, Path, Domain, Max-Age 같은 속성으로 위험을 완화 가능.
- 실무적 관점: 액세스 토큰은 가능한 짧게 유지하고(짧은 만료), 리프레시 토큰은 서버에서 관리하거나 HttpOnly Secure 쿠키에 보관하는 패턴이 자주 쓰임. 또한 CSRF와 XSS를 함께 고려해야 함.

---

## 공부하면서 알게 된 점

1. 공격 벡터가 서로 다르다
   - XSS(스크립트 삽입)는 localStorage에 저장된 토큰을 쉽게 탈취할 수 있다. 반면 HttpOnly 쿠키는 JS에서 읽을 수 없어 XSS로부터 직접적인 탈취를 막아준다.
   - CSRF는 브라우저가 쿠키를 자동으로 포함하기 때문에 쿠키 기반 인증에서 특히 문제다. localStorage는 자동 첨부되지 않으므로 CSRF 위험은 상대적으로 낮다(하지만 다른 취약점으로 보완 필요).

2. 쿠키 설정으로 많은 것을 제어할 수 있다
   - SameSite(Lax/Strict/None), Secure(HTTPS에서만 전송), HttpOnly(JS 접근 차단), Path/Domain, Max-Age/Expires 등을 통해 쿠키 동작을 세밀하게 조정할 수 있다.
   - 특히 현대 브라우저는 SameSite 기본값을 변경하거나 강제하는 경우가 있으니 확인이 필요했다.

3. 토큰을 어디에 보관할지는 보안뿐 아니라 편의성, 아키텍처(리소스 서버 요구), CORS 정책에도 영향을 받는다.
   - SPA에서 Authorization 헤더로 Bearer 토큰을 보내려면 JS가 토큰을 읽어야 하므로 localStorage(또는 메모리) 쪽으로 설계하게 된다.
   - 반대로 서버가 세션/쿠키 기반 인증을 선호하면 쿠키에 보관하고 credentials: 'include' 옵션으로 요청을 보낸다.

---

## 처음에는 헷갈렸던 부분

- "HttpOnly 쿠키면 CSRF 완전히 막을 수 있는가?"
  - 아닙니다. HttpOnly는 JS로부터 읽히지 않게 해 XSS로 인한 토큰 노출을 막아주지만, 브라우저가 쿠키를 자동으로 포함하기 때문에 동일 출처 요청인지 여부에 따라 CSRF 공격으로 악용될 수 있습니다. SameSite와 CSRF 토큰(또는 Double Submit Cookie 패턴)을 함께 써야 안심할 수 있다는 점이 처음에는 혼란스러웠습니다.

- "localStorage는 안전하지 않은가?"
  - localStorage 자체가 '안전하지 않다'기보다는 XSS 공격에 노출되면 위험하다는 뜻입니다. XSS 방어(CSP, 입력 검증 등)를 충분히 하면 위험을 줄일 수 있고, 토큰만을 저장하지 않는 아키텍처(짧은 수명 + 리프레시 정책)로 보완할 수 있습니다.

- "Access token을 cookie로 보내면 서버가 자동으로 인증해주니 편한가?"
  - 편리하긴 하나, CORS 설정, SameSite 설정, 서브도메인/도메인 정책, 프록시(예: CDN) 동작을 확인해야 합니다. 일부 경우에는 브라우저가 쿠키 전송을 제한해 API 호출이 실패할 수 있었습니다.

---

## 구체적 비교 (기술적 포인트)

- 접근성
  - localStorage: window.localStorage.getItem/setItem으로 JS에서 바로 사용 가능.
  - cookie: document.cookie로 읽거나 서버의 Set-Cookie로 설정(단, HttpOnly면 JS에서 읽을 수 없음).

- 전송 방식
  - localStorage: 브라우저가 자동 전송하지 않음. 매 요청마다 Authorization 헤더에 넣어 보내야 함.
  - cookie: 브라우저가 서버에 자동으로 전송(도메인, 경로, SameSite 규칙에 따름).

- 보안 속성
  - localStorage: HttpOnly 불가, CSRF 영향 적음, XSS 취약.
  - cookie: HttpOnly, Secure, SameSite 설정 가능, CSRF 영향 큼(하지만 Mitigation 존재).

- 저장량 및 성능
  - localStorage: 도메인 당 용량 제한(대략 몇 MB). 동기 API라 대용량 읽기/쓰기 시 UI 차단 가능.
  - cookie: 각 요청에 쿠키가 포함되므로 많은 쿠키는 요청/응답 오버헤드를 증가시킴(네트워크 비용).

- 만료/회전
  - localStorage: 기본적으로 만료 기능 없음(수동 삭제 필요). 만료 관리는 별도 로직 필요.
  - cookie: Max-Age/Expires로 브라우저에서 자동 만료 가능.

---

## 코드 예제 (간단한 패턴)

아래 예시는 이해용으로 최소한의 코드입니다. 환경에 맞게 보안 속성을 더 추가하세요.

1. localStorage에 액세스 토큰 저장 후 요청에 사용

```javascript
// 로그인 후
localStorage.setItem("accessToken", token);

// API 호출
const token = localStorage.getItem("accessToken");
fetch("/api/protected", {
  method: "GET",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  }
});
```

2. 서버에서 HttpOnly 쿠키(리프레시 토큰) 설정 예시(응답 헤더)

```
Set-Cookie: refreshToken=<token-value>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800
```

- 이 쿠키는 JS에서 읽을 수 없고, HTTPS에서만 전송되며 같은 사이트 요청에 한해 전송됩니다(Strict).

3. 쿠키 기반 리프레시 엔드포인트 호출 (브라우저에서 credentials 포함)

```javascript
// 리프레시 토큰은 HttpOnly 쿠키에 있으므로 JS에서 읽을 수 없다.
// 서버가 쿠키를 보고 새 access token을 발급함.
fetch("/api/auth/refresh", {
  method: "POST",
  credentials: "include" // 쿠키를 포함해서 보냄
})
  .then((res) => res.json())
  .then((data) => {
    // 보통 access token은 메모리나 localStorage에 보관
    // 이 예시는 메모리에 저장(페이지 리로드 시 초기화)
    window._accessToken = data.accessToken;
  });
```

4. Double Submit Cookie (간단한 CSRF 완화 패턴)

- 서버: CSRF 토큰을 쿠키로 발급(읽을 수 있게), 응답 바디에도 토큰 반환
- 클라이언트: 요청 시 X-CSRF-Token 헤더에 값을 넣어 보냄(서버는 쿠키와 헤더 값을 비교)

```javascript
// 받은 csrfToken을 헤더에 넣어 요청
fetch('/api/modify', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfTokenFromCookieOrResponse
  },
  body: JSON.stringify({ ... })
});
```

---

![localStorage와 쿠키의 장단점을 비교하는 두 개의 원형 아이콘(간단한 체크 표시와 경고 표시)](/assets/img/posts/blog/browser-token-storage-localstorage-cookie/image-2.webp)
이미지 출처: AI 생성 이미지

## 실무에서는 이렇게 확인하면 좋겠다 (체크포인트 중심)

아래는 실제 서비스에서 배포 전에 점검하면 도움이 될 항목들입니다. 저는 팀에서 작업할 때 이 중 일부를 체크리스트로 사용했습니다.

1. 쿠키 관련 점검
   - Set-Cookie에 HttpOnly, Secure, SameSite가 올바르게 설정되어 있는가?
   - Domain/Path 정책이 의도한 범위(서브도메인 포함/제외)를 반영하는가?
   - 쿠키의 Max-Age/Expires가 적절한가(리프레시 토큰은 길게, 액세스 토큰은 짧게)?
   - 쿠키 크기가 너무 커서 요청 오버헤드가 발생하지 않는가?

2. XSS 관련 점검
   - CSP(Content Security Policy)로 스크립트 출처를 제한하고 있는가?
   - 사용자 입력을 제대로 이스케이프/검증하고 있는가?
   - React/Vue 같은 프레임워크에서 위험한 innerHTML 사용을 최소화하고 있는가?

3. CSRF 관련 점검
   - 쿠키 기반 인증을 쓰면 CSRF 방어(토큰, SameSite, Referer 체크 등)가 준비되어 있는가?
   - API가 Cross-Origin 요청을 받는 경우 CORS 설정과 credentials 사용이 의도대로 동작하는가?

4. 토큰 수명 및 회전
   - 액세스 토큰의 만료 시간이 짧고, 리프레시 토큰은 안전하게 관리되는가?
   - 토큰 무효화(로그아웃 시 서버 측 블랙리스트 혹은 회전)를 설계했는가?

5. 개발/운영 환경 점검
   - 개발 환경에서 토큰이 콘솔 로그, 오류 보고, 스크린샷 등으로 유출되고 있지 않은가?
   - CI/CD로 배포 시 HTTPS 설정, SameSite 정책, 프록시(예: Nginx, CDN)에서 쿠키가 변경되지 않는가?
   - 브라우저별 정책(특히 SameSite: None과 Secure 요구)을 확인했는가?

6. 네트워크/성능 점검
   - 많은 쿠키가 요청마다 포함돼 네트워크 오버헤드가 생기지 않는가?
   - localStorage 사용 시 동기 API가 성능 병목을 만들지 않는가?

7. 로깅/모니터링
   - 로그에 토큰 값이 남지 않도록 주의했는가?
   - 인증 실패/성공 빈도, 리프레시 실패율 등을 모니터링하는가?

---

## 처음에 헷갈렸던 패턴에 대한 제 나름의 결론(조심스러운 정리)

- "가장 안전한 저장소"라는 건 상황에 따라 달라진다고 느꼈습니다. 예컨대 공용 PC에서 긴 수명의 토큰을 localStorage에 두는 건 확실히 위험하지만, 같은 출처에서 엄격한 CSP와 함께 짧은 수명 토큰 + HttpOnly 리프레시 쿠키 패턴을 쓰면 위험을 줄일 수 있습니다.
- 개인적으로는 다음과 같은 패턴을 선호합니다(절대적인 정답은 아닙니다):
  - 액세스 토큰: 가능한 짧게 유지(메모리 또는 localStorage), 매 요청마다 Authorization 헤더로 전송
  - 리프레시 토큰: HttpOnly Secure 쿠키로 보관(서버에서 토큰 교환 및 회전 처리)
  - CSRF 방어: SameSite와 CSRF 토큰(또는 Double Submit) 병행
  - XSS 방어: CSP, 입력 검증, 프레임워크 안전한 템플릿 사용

---

## 실무 체크리스트

- [ ] Set-Cookie에 HttpOnly, Secure, SameSite 설정 확인
- [ ] 쿠키 Domain/Path/Max-Age가 의도대로 설정되어 있는지 확인
- [ ] 액세스 토큰 만료시간이 짧게 설정되어 있는지 확인
- [ ] 리프레시 토큰 회전(logout/재발급) 로직 구현 여부 확인
- [ ] CSP 정책 적용 여부 확인(스크립트 출처 제한 등)
- [ ] 사용자 입력에 대한 적절한 이스케이프/검증 적용 여부 확인
- [ ] 브라우저 개발자 도구로 localStorage, Cookies 내용 확인(배포 전)
- [ ] 서버 로그/에러 리포트에 토큰이 남지 않도록 확인
- [ ] CORS 설정(Access-Control-Allow-Credentials 등)과 클라이언트 fetch의 credentials 옵션 일치 여부 확인
- [ ] 성능 영향(쿠키 크기, localStorage 동기 호출 등) 점검
- [ ] 모니터링(인증 실패율, 리프레시 실패율) 설정 여부 확인

---

마지막으로, 이 내용은 제가 학습하면서 정리한 개인적인 메모입니다. 실제 서비스에 적용할 때는 팀 정책, 공격 모델, 법적 요구사항(예: 개인정보 처리 규정) 등을 함께 고려하시길 권합니다.
