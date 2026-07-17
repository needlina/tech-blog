---
title: "JWT 인증 보안 체크리스트: 실무에서 점검할 핵심 포인트"
description: "오늘은 JWT(Json Web Token)를 인증에 사용할 때 실무에서 주의할 점들을 제가 공부하면서 정리한 내용을 공유하려고 합니다. 처음 접했을 때는 개념은 간단해 보였지만, 실제로 적용·운용할 때 놓치기 쉬운 보안 포인트가 꽤 많다는 걸 느꼈습니다"
slug: "jwt-security-practical-checks"
date: 2026-07-12 12:00:00 +0900
categories: [Security, Backend]
tags: [jwt, authentication, security, token, jwks]
image:
  path: /assets/img/posts/blog/jwt-security-practical-checks/image-1.webp
  alt: "JWT 토큰 구조를 단순히 보여주는 원형 다이어그램"
---

오늘은 JWT(Json Web Token)를 인증에 사용할 때 실무에서 주의할 점들을 제가 공부하면서 정리한 내용을 공유하려고 합니다. 처음 접했을 때는 개념은 간단해 보였지만, 실제로 적용·운용할 때 놓치기 쉬운 보안 포인트가 꽤 많다는 걸 느꼈습니다. 이 글에서는 제가 공부하면서 알게 된 점, 처음에 헷갈렸던 부분, 그리고 실무 환경에서 확인해보면 좋은 항목들을 중심으로 정리합니다. 가능한 한 초보자 관점에서 차근차근 설명하려고 합니다.

![JWT 토큰 구조를 단순히 보여주는 원형 다이어그램](/assets/img/posts/blog/jwt-security-practical-checks/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점, 처음에는 헷갈렸던 부분, 실무에서는 이렇게 확인하면 좋겠다 같은 흐름으로 적겠습니다. 틀릴 가능성이 있는 부분은 확신을 피하며, 실무 점검용 명령어와 예시 코드도 포함합니다.

1) JWT가 무엇인지(간단히)
- JWT는 header.payload.signature 세 부분으로 구성됩니다. header에는 alg, typ 같은 메타, payload에는 클레임(iss, aud, exp 등), signature는 header+payload에 비밀키/개인키로 서명한 값입니다.
- 중요한 점은 JWT 자체가 '암호화'된 형태가 아니라 '서명'된 형태라는 것입니다(물론 JWE 같은 암호화 규격도 있지만 보통은 JWS를 말할 때가 많습니다). 그래서 payload는 쉽게 디코드해서 볼 수 있습니다(민감한 데이터는 넣지 않는 것이 좋습니다).

2) 처음에는 헷갈렸던 부분
- alg 필드: HS256(대칭키)인지 RS256(비대칭키)인지에 따라 검증 방법이 달라집니다. 특히 과거 취약점 사례처럼 서버가 alg 값을 신뢰하고 동적으로 처리하면 위험할 수 있습니다(예: alg=none 허용).
- 어디에 토큰을 저장해야 하나?: localStorage vs cookie 논쟁. 각각 CSRF/XSS 취약성 측면에서 장단점이 있어 단순 결론을 내리기 어려웠습니다.
- refresh token의 관리: 액세스 토큰 만료, 리프레시 토큰의 회전(rotating refresh tokens), 블랙리스트 방식 등 여러 패턴이 있어 처음에는 구조 정리가 필요했습니다.

3) 실무에서 꼭 점검해볼 포인트(요약)
- 서명 알고리즘과 키 관리: alg 허용 목록을 고정하고, 공개 키(JWKS) 사용 시 kid 처리와 키 회전 절차를 점검하세요.
- 토큰 검증 절차: iss, aud, exp, nbf, iat, typ 등을 검증하고, clock skew(시차) 허용 범위를 정하세요.
- 민감한 정보 금지: payload에 비밀번호나 주민번호 같은 민감값을 넣지 마세요.
- 토큰 저장과 전송: HTTPS만 허용, SameSite/HttpOnly 등 쿠키 속성 검토, CORS 정책 점검.
- 리프레시 토큰 전략: 저장 위치, 회전, 재사용 방지, 블랙리스트/저장소 설계.
- 로깅·모니터링: JWT 실패율, 서명 에러, 키 문제를 모니터링하세요.

실무 점검을 위해 바로 써먹을 수 있는 예시와 명령어들을 아래에 정리합니다.

실전 예제 1 — Node.js(Express)에서 안전하게 검증하는 미들웨어 예시
- 설명: RS256을 쓰는 경우 JWKS(공개키 집합)을 조회해 서명을 검증하는 방식이 보편적입니다. 라이브러리 사용 예시는 비교적 안전합니다만, 검증 항목(issuer, audience, algorithms 등)을 명시적으로 지정하는 것이 중요합니다.

```js
// express-jwt + jwks-rsa 예시 (개념용)
const express = require('express');
const jwt = require('express-jwt');
const jwksRsa = require('jwks-rsa');

const app = express();

const jwtCheck = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    jwksUri: 'https://YOUR-ISSUER/.well-known/jwks.json',
    rateLimit: true,
    jwksRequestsPerMinute: 10
  }),
  audience: 'your-api-audience',
  issuer: 'https://YOUR-ISSUER/',
  algorithms: ['RS256']
});

app.use('/api', jwtCheck);

app.get('/api/hello', (req, res) => {
  res.json({ hello: 'world', user: req.user });
});

app.listen(3000);
```

주의: 위 코드는 개념 예시입니다. 실제 운영에서는 캐시 정책·타임아웃·예외 처리·로깅을 더 꼼꼼히 해야 합니다.

실전 예제 2 — 토큰 디코드(빠른 검사용) (Linux/Bash)
- 설명: JWT는 Base64URL로 인코딩되어 있으므로 간단히 디코드해서 payload를 확인할 수 있습니다. 아래 함수는 URL-safe Base64를 보정해서 디코드합니다.

```bash
jwt_decode_payload() {
  token="$1"
  payload=$(echo "$token" | awk -F. '{print $2}')
  # URL-safe base64 -> base64 표준으로 변환, 패딩 추가
  payload=$(echo "$payload" | sed 's/-/+/g; s/_/\//g; s/$/==/g')
  echo "$payload" | base64 --decode 2>/dev/null | jq .
}

# 사용
jwt_decode_payload eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

참고: 위 방법은 서명 검증을 하지 않습니다. 단지 payload를 읽는 용도입니다.

실무에서 키(JWKS) 점검하는 방법
- JWKS 엔드포인트를 직접 조회해서 kid 목록과 공개키 자료를 확인합니다.
- 명령어 예시:

```bash
curl -s https://YOUR-ISSUER/.well-known/jwks.json | jq .
```

- 확인 포인트: kid가 바뀌었을 때 서비스가 새 키를 올바르게 받아서 서명 검증에 실패하지 않는지(키 회전 테스트)를 점검하세요. 또한 JWKS 호출에 대한 rate limit이나 장애 시 대체 경로(캐시)도 고려해야 합니다.

서명 알고리즘 취약점 주의
- 과거 사례에서는 서버가 alg 값을 그대로 신뢰하면서 HS256/RS256을 혼동해 공격을 허용하는 경우가 있었습니다. 따라서 서버 쪽에서 '허용된 알고리즘 목록'을 고정하고, possible values가 아닌 실제 검증 방법을 강제해야 합니다.
- 검증 시에는 항상 signature 체크를 수행하세요. 라이브러리를 쓸 때도 검증 옵션을 누락하면 위험합니다.

토큰 저장과 전송에 대한 실무 체크
- HTTPS: 항상 TLS를 사용하세요. 토큰이 평문으로 노출되면 끝입니다.
- Cookie 설정(쿠키에 JWT 저장할 경우):
  - HttpOnly: XSS로부터 읽기를 어렵게 함
  - Secure: HTTPS 전송만 허용
  - SameSite=Lax/Strict: CSRF 완화에 도움
- localStorage 사용 시 XSS에 취약하다는 점을 명확히 인지하고, CSP(콘텐츠 보안 정책) 도입 같은 보완책을 고려하세요.

리프레시 토큰 전략 간단 정리
- 단순 영구 리프레시 토큰 저장은 재사용 공격에 취약할 수 있습니다. 가능한 회전(rotating) 방식이나 서버 측 블랙리스트(또는 상태 저장)를 사용해 재사용 검사(replay detection)를 하는 것이 바람직합니다.
- 리프레시 토큰은 액세스 토큰보다 보안 등급을 높게 두고, 수명과 재발급 정책을 엄격히 하세요.

로그와 모니터링
- JWT 검증 실패(서명 불일치, 만료 등) 이벤트를 로깅하고, 실시간 알람(예: 실패율 급증)을 설정하면 공격 징후를 빠르게 파악할 수 있습니다.
- JWKS 조회 오류, 라이브러리 예외, 키 회전시 검증 실패 등은 별도 지표로 수집하면 유용합니다.

중간 요약 및 추가 이미지
- 지금까지 핵심 개념과 실무 점검 포인트를 살펴봤습니다. 다음 섹션에서는 실제 운영 환경에서 확인할 만한 체크리스트와 간단한 점검 절차를 정리합니다.

![운영 환경에서 JWT 검증 로그와 경고를 모니터링하는 단순한 일러스트](/assets/img/posts/blog/jwt-security-practical-checks/image-2.webp)
이미지 출처: AI 생성 이미지

실무에서는 이렇게 확인하면 좋겠다 (구체적 절차)
- JWKS/공개키 확인
  - curl로 JWKS를 조회해 kid와 키 형태(예: RSA 키의 n/e)를 확인
  - 키 교체(rotate) 시 서비스가 정상적으로 키를 갱신하는지 스테이징에서 테스트
- 토큰 발급·만료 정책 점검
  - 발급 로그에서 exp/iat 값 분포를 확인(너무 긴 수명은 위험)
  - clock skew를 고려한 허용 범위를 문서화
- 토큰 유효성 검증 점검
  - iss, aud, typ, exp, nbf 등 필수 클레임을 검증하도록 코드 리뷰
  - 라이브러리 사용 시 검증 옵션(algorithms, issuer, audience)을 명시
- 네트워크·보안 설정 확인
  - TLS 강제 적용(포트, 로드밸런서 설정 포함)
  - CORS 정책: 허용 출처를 최소화
  - 쿠키 속성: Secure, HttpOnly, SameSite 설정 여부 확인
- 공격 시나리오 테스트
  - 만료 토큰 재사용 시도, 변조된 payload 전송, 잘못된 alg 값 시도 등 단순 펜테스트를 자동화된 테스트에 포함
- 로깅·알림
  - JWT 검증 실패를 모니터링 지표로 등록하고 임계치를 정해 알림 설정

간단한 점검 명령 모음 (운영 인스턴스에서)
- JWKS 확인: curl + jq
  - curl -s https://issuer.example/.well-known/jwks.json | jq '.'
- 토큰 디코드(내용 확인): bash 함수 사용 (위 예시)
- 쿠키 속성 확인: curl -I --cookie "jwt=..." https://api.example.com
- 서비스 응답 확인: curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" https://api.example.com/health

공부하면서 알게 된 점(짧게)
- JWT는 설계상 단순하지만, 안전하게 운영하려면 여러 주변 요소(키관리, TLS, 저장 위치, 토큰 회전 등)를 함께 고려해야 한다는 점.
- 라이브러리를 쓰는 편이 안전할 때가 많지만, 옵션을 잘못 주면 취약해질 수 있어서 검증 항목을 명시적으로 설정해야 한다는 점.
- 리프레시 토큰을 포함한 전체 인증 흐름을 설계·시험하지 않으면 작은 착오가 큰 취약점으로 이어질 수 있다는 점.

마무리 소감(초보자의 시선)
- 저는 아직도 모든 케이스를 완벽히 이해했다고는 자신할 수 없습니다. 다만 실무에서 우선으로 점검해야 할 항목들을 목록화해두면 사고 가능성을 줄이는 데 도움이 된다는 느낌을 많이 받았습니다.
- 이 글이 다른 초보 개발자 분들이 실무에서 체크해야 할 포인트를 빠르게 확인하는 데 작은 가이드가 되면 좋겠습니다. 혹시 잘못된 점이나 더 좋은 방법을 아시는 분은 피드백 주시면 같이 정리해보고 싶습니다.

실무 체크리스트
- [ ] 서명 알고리즘(alg) 허용 목록을 고정하고 검증 코드에 명시했는가?
- [ ] iss, aud, exp, nbf 등 필수 클레임 검증을 적용했는가?
- [ ] 민감한 정보를 payload에 저장하지 않는가?
- [ ] TLS가 항상 적용되는지(로드밸런서 포함) 확인했는가?
- [ ] 쿠키 사용 시 Secure, HttpOnly, SameSite 설정을 적용했는가?
- [ ] JWKS 엔드포인트의 응답과 키 회전 동작을 검증했는가?
- [ ] 리프레시 토큰의 저장·회전 정책(또는 블랙리스트)을 설계했는가?
- [ ] JWT 검증 실패를 로깅·모니터링하고 알림을 설정했는가?
- [ ] 스테이징 환경에서 만료·변조·잘못된 alg 등 공격 시나리오를 테스트했는가?

카테고리: Security, Backend
태그: jwt, authentication, security, token, jwks

끝으로: 이 글은 제가 공부하면서 정리한 개인 노트입니다. 환경과 요구사항에 따라 더 적합한 설계가 있을 수 있으니, 실제 도입 전에는 팀 내 보안 담당자 또는 보안 가이드라인을 꼭 참고하시길 권합니다.