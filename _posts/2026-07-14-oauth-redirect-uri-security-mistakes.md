---
title: "OAuth 리다이렉트 URI 설정 시 흔한 보안 실수와 실무 점검 가이드"
description: "OAuth 리다이렉트 URI 설정에서 자주 생기는 보안 실수 들어가며 제가 OAuth를 처음 공부할 때 가장 헷갈렸던 부분 중 하나가 리다이렉트(redirect) URI였습니다"
slug: "oauth-redirect-uri-security-mistakes"
date: 2026-07-14 10:00:00 +0900
categories: [Security, Backend]
tags: ["oauth", "redirect-uri", "보안점검", "authentication", "open-redirect"]
image:
  path: /assets/img/posts/blog/oauth-redirect-uri-security-mistakes/preview.png
  alt: "OAuth 리다이렉트 URI 점검 썸네일"
---

OAuth 리다이렉트 URI 설정에서 자주 생기는 보안 실수 들어가며 제가 OAuth를 처음 공부할 때 가장 헷갈렸던 부분 중 하나가 리다이렉트(redirect) URI였습니다


OAuth 리다이렉트 URI 설정에서 자주 생기는 보안 실수

들어가며
제가 OAuth를 처음 공부할 때 가장 헷갈렸던 부분 중 하나가 리다이렉트(redirect) URI였습니다. 문서에는 "리다이렉트 URI를 정확히 등록하라"고 적혀 있는데, 실제로는 어떤 경우에 왜 문제가 발생하는지 감을 잡기 어려웠습니다. 최근 프로젝트에서 OAuth를 도입하면서 관련 설정과 공격 벡터를 직접 확인해보니, 실무에서 주의할 포인트들이 꽤 명확해졌습니다. 이 글에서는 제가 공부하면서 알게 된 점, 처음에 헷갈렸던 부분, 그리고 실무에서 어떻게 확인하면 좋은지를 중심으로 정리해보겠습니다. 전문가처럼 단정적으로 말하기보다는 제 경험과 문서를 바탕으로 조심스럽게 정리합니다.

공부하면서 알게 된 점

- 리다이렉트 URI의 정확한 매칭 정책은 OAuth 제공자(예: Google, GitHub, Facebook 등)마다 다릅니다. 어떤 제공자는 완전 일치(exact match)를 요구하고, 어떤 제공자는 쿼리 문자열을 허용하거나 포트 차이를 인정하기도 합니다. 따라서 제공자 문서를 먼저 확인하는 게 중요합니다.
- "와일드카드 허용"은 매우 위험할 수 있습니다. 일부 서비스에서 하위 경로에 대한 와일드카드를 허용하면 오픈 리다이렉트 공격으로 이어질 가능성이 있습니다.
- 리다이렉트 URI를 동적으로 생성하거나, 사용자 입력을 바로 반영해서는 안 됩니다. 인증 흐름의 핵심은 신뢰할 수 있는 장소로만 리디렉션하는 것입니다.
- state 파라미터와 PKCE(특히 공개 클라이언트인 SPA/모바일)를 반드시 사용하면 중간자 공격과 CSRF를 막는 데 도움이 됩니다.
- 로컬 개발 환경(localhost)에서는 편의상 HTTP/비보안 스킴을 허용할 수 있지만, 프로덕션에서는 HTTPS만 허용하는 것이 바람직합니다.

![OAuth 인증 플로우에서 브라우저가 인증 서버로 리다이렉트되는 단순한 순서도](/assets/img/posts/blog/oauth-redirect-uri-security-mistakes/image-1.webp)
이미지 출처: AI 생성 이미지

처음에는 헷갈렸던 부분

- 리다이렉트 URI vs 콜백 URL: 문서에 따라 용어가 섞여 있어 혼동이 있었습니다. 일반적으로 둘은 같은 의미로 쓰이지만, "콜백"은 서버 쪽에서 액세스 토큰을 교환하는 엔드포인트를 지칭하는 경우가 많고, "리다이렉트 URI"는 사용자 에이전트(브라우저)를 통해 전달되는 URL을 뜻하는 경우가 많습니다.
- 쿼리 스트링 허용 여부: 어떤 서비스는 등록된 리다이렉트 URI에 쿼리를 포함해도 허용하지만, 어떤 곳은 등록된 URI와 쿼리까지 완전 일치해야 합니다. 실무에서는 쿼리 파라미터를 토큰 전달에 사용하지 않는 편이 안전합니다.
- 포트와 스킴: 443(https)과 80(http) 외 포트를 사용할 때 제공자 정책이 달라서 당황했습니다. 로컬 개발에서 3000, 8080 포트를 쓰는 경우가 많으니, 프로바이더 문서를 확인하고 등록해야 합니다.
- 모바일/네이티브 앱과 custom URI schemes: 모바일 앱은 custom scheme이나 App Link/Universal Link를 사용합니다. 이 경우에도 오픈 리다이렉트나 URI 스쿼팅(Redirect URI hijacking) 문제가 발생할 수 있다는 점을 숙지해야 했습니다.

실무에서는 이렇게 확인하면 좋겠다
다음은 제가 실제로 프로젝트에서 점검하거나 자동화하려 했던 항목들입니다. 가능한 자동 스캔과 로그 기반 감시를 조합해 두면 좋습니다.

1. 제공자 콘솔 확인

- OAuth 클라이언트 설정에서 등록된 리다이렉트 URI 목록을 확인한다.
- 와일드카드(\*)가 등록되어 있는지 확인한다(권장하지 않음).
- 로컬 개발용으로 등록된 URI가 프로덕션 환경에 포함되어 있지 않은지 확인한다.

2. 코드에서 리다이렉트 URI 생성/검증 로직 점검

- 사용자 입력을 그대로 redirect_uri 또는 return_to로 사용하지 않는지 확인한다.
- 허용 목록(allowlist) 방식으로 비교하며, 단순 문자열 포함(contains) 검사가 아닌 정규화(normalize) 후 정확 매칭(exact match) 또는 호스트+경로 패턴 검사만 허용한다.

예시: Node.js(Express)에서 간단한 allowlist 검증

```js
// allowedRedirects는 배포 시 설정 파일에 넣어 관리
const allowedRedirects = [
  "https://example.com/auth/callback",
  "https://app.example.com/oauth/callback"
];

function isAllowedRedirect(url) {
  try {
    const u = new URL(url);
    // 스킴, 호스트, 포트, 경로까지 정확히 매칭하는 방법
    return allowedRedirects.includes(u.origin + u.pathname);
  } catch (e) {
    return false;
  }
}

// 사용 예
app.get("/start-oauth", (req, res) => {
  const redirect = req.query.redirect; // 사용자가 제공한 리턴 URL
  if (!isAllowedRedirect(redirect)) {
    return res.status(400).send("invalid redirect");
  }
  // OAuth 시작 로직...
});
```

3. 테스트(수동/자동)

- curl이나 자동화 스크립트로 허용되지 않은 redirect 값으로 인증 시도 시 어떻게 동작하는지 확인한다(리디렉션 금지, 에러 메시지 등).
- 악성 도메인으로의 리디렉션이 가능한지 검증한다(오픈 리다이렉트 시나리오).
- state 파라미터 없이 인증 요청을 보냈을 때, 리소스 서버가 이를 어떻게 처리하는지 확인한다.
  예시: curl로 인증 엔드포인트 응답 확인

```bash
# 인증 서버가 인증 코드 발급을 위해 리다이렉트하는 URL을 확인
curl -i "https://auth.example.com/authorize?client_id=...&redirect_uri=https://malicious.example.com/callback&response_type=code&state=abc"
# Location 헤더와 상태 코드 확인
```

4. 로그와 모니터링

- 리다이렉트 실패/허용되지 않은 리다이렉트 발생 로그를 수집한다.
- 의심스러운 도메인으로의 리다이렉트 시도를 알림으로 연결한다.

공격 벡터와 방어책(요약)

- 오픈 리다이렉트: 사용자 입력을 그대로 리다이렉트 목적지로 사용하면 공격자가 악성 사이트로 보낼 수 있습니다. 방어는 allowlist(명시적 허용 목록)로 해결합니다.
- CSRF/세션 하이재킹: state 파라미터 미사용 시 공격 가능성이 있습니다. state를 사용하고, 가능한 경우 PKCE를 도입하세요.
- 리디렉션 URL 변조: 리다이렉트 URI를 동적으로 조합할 때 문자열 결합 방식으로 오용되는 경우가 있습니다. 정적 또는 설정 기반의 URI만 허용하세요.
- HTTPS 미사용: 프로덕션에서는 HTTPS를 강제하세요. 토큰이나 인증 코드가 네트워크 상에서 유출될 수 있습니다.

추가 코드 예제 — 서버에서 리디렉트 허용 목록 구성(환경변수 기반)

```bash
# .env 예시
ALLOWED_REDIRECTS="https://example.com/auth/callback,https://app.example.com/oauth/callback"
```

```js
// config.js
const allowedRedirects = process.env.ALLOWED_REDIRECTS.split(",");

function normalizeUrl(url) {
  const u = new URL(url);
  // 트레일링 슬래시 제거 등 간단한 정규화
  const pathname = u.pathname.replace(/\/$/, "");
  return `${u.protocol}//${u.host}${pathname}`;
}

function isAllowedRedirect(url) {
  try {
    const norm = normalizeUrl(url);
    return allowedRedirects.map(normalizeUrl).includes(norm);
  } catch (e) {
    return false;
  }
}
```

![허용 목록(allowlist) 기반의 리다이렉트 검증을 나타내는 간단한 도형(입력 URL이 검증기를 통과하는지 여부를 표시)](/assets/img/posts/blog/oauth-redirect-uri-security-mistakes/image-2.webp)
이미지 출처: AI 생성 이미지

실무에서 체크할 포인트(세부)

- 등록된 리다이렉트 URI가 모두 HTTPS인지 확인
- 와일드카드 사용 여부 및 그 이유(필요하면 최소 범위로 제한)
- 모바일의 경우 custom scheme을 악의적으로 가로챌 가능성 확인
- OIDC를 사용한다면 response_type, scope, prompt 등 설정이 적절한지 확인
- 토큰 전달 방식(Authorization Code Grant + PKCE 권장)
- 로그에서 비정상적인 redirect_uri 시도(특히 외부 도메인) 탐지
- 프레임바운딩(X-Frame-Options)과 같은 브라우저 보안 헤더가 적절히 설정되어 있는지 확인

처음부터 완벽할 수는 없겠지만, 제가 실무에서 가장 먼저 확인하는 몇 가지는 다음과 같습니다.

- OAuth 제공자 콘솔에서 리다이렉트 URI 목록을 내보내어 검토한다.
- 코드에서 redirect_uri 혹은 return_to 파라미터를 받는 모든 부분을 검색해 allowlist 검증을 추가한다.
- 자동화 테스트로 허용되지 않은 도메인에 리다이렉트가 시도되는지 확인한다.

주의사항(제가 덜 확실한 부분)

- 일부 OAuth 제공자는 내부적으로 쿼리 파라미터를 다르게 처리하거나 포트 번호를 무시할 가능성이 있습니다. 따라서 각 제공자의 문서를 신중히 확인하는 것이 필요합니다.
- 모바일 앱에서 발생하는 URI 스킴 문제는 플랫폼(안드로이드, iOS)마다 권장 방식이 다르므로, 플랫폼 가이드라인을 따르는 것이 중요해 보입니다.

실무 체크리스트

- [ ] OAuth 제공자 콘솔에서 등록된 리다이렉트 URI 목록 확인
- [ ] 와일드카드(\*)가 사용되고 있지 않은지 확인(불필요하면 제거)
- [ ] 프로덕션에 HTTP가 아닌 HTTPS만 허용되도록 설정
- [ ] 코드에서 사용자 입력을 리다이렉트 대상으로 사용하지 않도록 검증 로직 적용(allowlist)
- [ ] state 파라미터 사용 및 검증 구현(그리고 가능한 경우 PKCE 사용)
- [ ] 로그에서 비정상/외부 도메인으로의 리다이렉트 시도 모니터링 설정
- [ ] 자동화 테스트로 리다이렉트 검증(허용/비허용 케이스) 추가
- [ ] 모바일 앱의 경우 custom scheme/앱 링크에 대한 보안 검토

마치며
OAuth 설정은 한 번 해놓고 잊기 쉬운 부분이지만, 리다이렉트 URI 하나만 잘못 설정돼도 심각한 보안 문제가 될 수 있습니다. 저는 이 글을 통해 제가 공부하면서 직접 확인한 것과 실무에서 적용 가능한 점들을 정리해보았습니다. 상황에 따라 세부 구현은 달라질 수 있으니, 사용 중인 OAuth 제공자의 문서를 늘 먼저 참고하시고, 가능한 경우 보안 담당자나 시큐리티 리뷰를 통해 추가 확인하시는 것을 권장합니다.
