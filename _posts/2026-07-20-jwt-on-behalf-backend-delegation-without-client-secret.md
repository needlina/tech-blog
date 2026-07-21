---
title: "JWT on-behalf 패턴으로 OAuth2 클라이언트 시크릿 없이 백엔드 권한 위임하기"
description: "대리권한 위임이 필요한 백엔드 간 통신: 서명된 JWT assertion으로 클라이언트 시크릿 없이 토큰을 요청하는 흐름, 키 관리·토큰 교환·검증 포인트와 점검 명령어"
slug: "jwt-on-behalf-backend-delegation-without-client-secret"
date: 2026-07-20 23:38:00 +0900
categories: ["Backend", "Security"]
tags: ["jwt", "oauth2", "token-exchange", "보안", "백엔드"]
image:
  path: /assets/img/posts/blog/jwt-on-behalf-backend-delegation-without-client-secret/preview.png
  alt: "JWT on-behalf 패턴 썸네일"
---

서명된 JWT(Assertion)를 사용해 서비스 A가 자체 클라이언트 시크릿 없이 서비스 B를 대신해 토큰을 발급받는 방식은, **서비스 간 권한 위임을 비밀값 저장 없이 구현**할 때 유용하며 토큰 교환 엔드포인트, 키 타입, 만료시간 검증을 먼저 확인하면 적용 실패 확률을 줄일 수 있습니다.

안녕하세요. 요즘 백엔드 간 권한 위임을 다룰 일이 생겨서, JWT on-behalf(혹은 JWT assertion) 패턴을 직접 따라가며 정리한 내용을 적어봅니다. 저는 초보 개발자 입장에서 겪은 혼란과 체크 포인트 중심으로 정리하려고 해요. 공식 문서의 용어와 구현 세부가 조금 달라 혼란스러웠는데, 실무에서 어떤 파일과 명령부터 확인하면 좋은지 위주로 썼습니다.

왜 이걸 쓰는가 — 문제 상황

- 로컬 개발 환경이나 사내 서비스에서 A 서비스가 B 서비스 대신 외부 API(또는 인증서버)에 요청해야 하는데, 클라이언트 시크릿을 중앙에 저장하거나 배포하고 싶지 않을 때가 있었습니다.
- 클라이언트 시크릿을 노출하지 않고도 인증서버에 신원을 증명하는 방법이 필요했습니다.

제가 이해한 핵심 흐름(요약)

- 서비스 A는 자체 비공개 키로 JWT assertion(요청자, 발행자, aud 등 포함)을 서명해 인증 서버의 토큰 교환(endpoint)으로 보냅니다.
- 인증 서버는 JWT의 서명과 클레임(iss, sub, aud, exp 등)을 검증한 뒤, 대상 리소스에 맞는 접근 토큰을 발급하거나 교환해줍니다.
- 이 방식은 **비밀값(클라이언트 시크릿) 보관을 줄이고 공개키 기반 검증을 활용**하기 때문에 키 관리와 회전 정책이 중요합니다.

처음에 헷갈렸던 부분

- "JWT assertion"과 "access token(JWT)"의 차이:
  - JWT assertion은 인증서버에 제출하는 증명서(주로 클라이언트 인증용)이고,
  - access token은 리소스 서버가 실제 권한을 확인하는 토큰이에요.
- 어떤 키를 어디에 두는지:
  - 개인키(private key)는 서비스 A만 보관합니다(예: /etc/myapp/keys/private.pem).
  - 인증서버는 공개키(public key)나 JWKs 엔드포인트로 검증합니다(예: https://auth.example.com/.well-known/jwks.json).

실무에서 먼저 확인할 포인트(구체적)

- 인증 서버가 JWT client_assertion 방식을 지원하는지 (예: OAuth2 client assertion, RFC 7523 또는 token exchange RFC 8693)
- 필요한 JWT 클레임: iss, sub, aud, exp, jti 등 (인증서버 문서 확인)
- 토큰 교환 엔드포인트 URL과 요청 형식 (form-encoded vs JSON)
- 키 형식(RS256, ES256 등)과 공개키 노출 방식(JWKs URL 또는 관리 콘솔)
- 토큰 만료 및 재사용 정책(재발급 빈도, jti 중복 검사)
- 로그/에러: 인증서버에서 반환하는 오류 코드(401, invalid_client, invalid_grant, insufficient_scope)와 로깅 경로

실습 예제(환경: node v18.16, jsonwebtoken 9.0.0, openssl 3.0)

1. 개인키 생성(테스트용 RSA 2048)

```bash
openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in private.pem -pubout -out public.pem
```

파일 경로 예시: /etc/myapp/keys/private.pem, /etc/myapp/keys/public.pem

2. JWT assertion 생성 (Node + jsonwebtoken)

```javascript
// package.json에 "jsonwebtoken": "^9.0.0" 필요
import fs from "fs";
import jwt from "jsonwebtoken";

const privateKey = fs.readFileSync("/etc/myapp/keys/private.pem");
const now = Math.floor(Date.now() / 1000);

const payload = {
  iss: "service-a@example.com", // 서비스 A 식별자
  sub: "service-a@example.com", // 경우에 따라 다름
  aud: "https://auth.example.com/token", // 토큰 엔드포인트
  iat: now,
  exp: now + 60, // 짧은 유효기간 권장(예: 60초)
  jti: "unique-id-12345"
};

const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });
console.log(token);
```

- 주의: exp는 매우 짧게 설정하는 편이 안전합니다(예: 30~120초).

![JWT assertion을 사용하는 서비스 간 권한 위임 흐름 다이어그램](/assets/img/posts/blog/jwt-on-behalf-backend-delegation-without-client-secret/image-1.webp)
이미지 출처: AI 생성 이미지

3. 토큰 교환 요청(curl)

```bash
curl -s -X POST https://auth.example.com/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "subject_token=<JWT_ASSERTION>" \
  -d "requested_token_type=urn:ietf:params:oauth:token-type:access_token"
```

- 위 예시는 RFC 8693 token exchange 형식입니다. 인증서버가 클라이언트 assertion을 별도 파라미터로 요구할 수 있어요(문서 확인 필요).

실패 예시와 수정 예시

- 실패 예시: 인증서버가 400/invalid_grant 또는 401/invalid_client 반환
  - 오류 메시지(예): {"error":"invalid_grant","error_description":"JWT validation failed: signature invalid"}
  - 원인: 잘못된 공개키, 서명 알고리즘 불일치, aud가 틀림
- 수정 방법:
  - 공개키가 인증서버의 JWKs에 등록되었는지 확인
  - payload.aud가 정확한 토큰 엔드포인트로 설정되었는지 확인
  - 서명 알고리즘(RS256 vs ES256) 일치 여부 확인

검증/점검 명령(실무용)

- JWT 디코드(로컬 확인):

```bash
# 단순 디코드(서명 확인 아님)
echo "<JWT>" | cut -d. -f2 | base64 --decode | jq .
```

- 서명 검증(예: jwt-cli 또는 node 스크립트 사용)
- 토큰 교환 엔드포인트 호출 시 verbose:

```bash
curl -v -X POST https://auth.example.com/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "..." 2>&1 | tee /tmp/token-exchange.log
```

- 인증서버 로그 경로 확인: /var/log/auth-server/\*.log 또는 중앙 로거(예: ELK)

구성 파일 예시 (/etc/myapp/auth-config.yaml)

```yaml
client_id: service-a
private_key_path: /etc/myapp/keys/private.pem
token_endpoint: https://auth.example.com/token
assertion_audience: https://auth.example.com/token
assertion_algorithm: RS256
assertion_exp_seconds: 60
```

비교표: 선택 기준(간단)

| 방식                               | 장점                                | 단점               | 사용 시점                     |
| ---------------------------------- | ----------------------------------- | ------------------ | ----------------------------- |
| JWT on-behalf (assertion)          | **시크릿 불필요**, 공개키 기반 검증 | 키관리·회전 필요   | 서비스 간 서버 신원 증명 필요 |
| OAuth2 token-exchange (RFC 8693)   | 표준화된 토큰 교환 플로우           | 인증서버 지원 필요 | 토큰 교환 흐름이 명확할 때    |
| Client credentials (client_secret) | 구현 단순                           | 시크릿 저장 부담   | 내부 신뢰 구역에서만 권장     |

실무에서 특히 주의할 점

- **비밀 관리**: 개인키 접근 제한(파일 권한, KMS 연동)과 키 회전 절차를 마련하세요.
- **aud와 iss 정확성**: 가장 자주 실수하는 부분입니다. 인증서버 문서에 맞춰 값을 설정하세요.
- **짧은 exp와 jti 사용**: 재사용 방지와 재생 공격을 줄이기 위해 짧은 만료와 고유 jti를 권장합니다.
- **로깅**: 인증 요청과 응답(민감 데이터 제외)은 추적 가능하도록 로그 경로를 정하세요(/var/log/myapp/auth.log).

![서비스가 JWT를 생성해 서명하는 간단한 일러스트](/assets/img/posts/blog/jwt-on-behalf-backend-delegation-without-client-secret/image-2.webp)
이미지 출처: AI 생성 이미지

검증 시나리오(재현 명령 포함)

1. 로컬에서 JWT 생성 및 디코드 확인
   - node 스크립트로 JWT 생성 → echo 토큰 → base64 디코드로 payload 확인
2. 인증서버로 요청해 에러 재현
   - 잘못된 aud로 요청해 400/invalid_grant 확인
3. 공개키 등록 후 정상 흐름 확인
   - 공개키 등록 → curl로 exchange → HTTP 200과 access_token 획득
4. 적용 후 리소스 서버에 토큰으로 요청해 권한 검증
   - curl -H "Authorization: Bearer <access_token>" https://api.example.com/resource
   - 기대 응답: 200 또는 403(권한 부족) — 응답 코드에 따라 scope/role 확인

## 자주 묻는 질문

Q: 인증 서버가 token-exchange를 지원하지 않으면 어떻게 하나요?  
A: 두 가지 선택이 있습니다. (1) 인증서버 설정 변경/확장으로 RFC 8693 지원을 요청하거나 (2) 서비스 A가 직접 리소스 서버의 위임 허용 로직을 구현해 클라이언트 시크릿 없이 신뢰 관계를 설정하는 방법을 고려할 수 있습니다. 전자는 표준, 후자는 맞춤형입니다.

Q: 공개키는 어떻게 배포해야 하나요?  
A: 보통 JWKs 엔드포인트(예: /.well-known/jwks.json)에 등록하거나 인증서버 관리자 콘솔을 통해 업로드합니다. 자동화가 필요하면 CI/CD로 JWKs 업로드를 구현하거나 KMS/CA를 사용하는 방법을 권장합니다.

Q: JWT를 너무 길게 설정했더니 보안 이슈가 있나요?  
A: 길게 설정하면 재사용 위험이 커집니다. **짧은 만료(예: 30~120초)**와 jti로 재사용을 막는 조합이 안전합니다.

Q: 실패했을 때 어느 로그를 먼저 확인해야 하나요?  
A: 인증서버의 토큰 엔드포인트 로그(/var/log/auth-server/token.log 또는 중앙 로거) → 인증서버가 제공한 에러 문자열 → 클라이언트(서비스 A)에서 전송한 JWT(헤더/페이로드) 확인 순을 권합니다.

## Q&A (추가)

Q: RS256 대신 ES256을 써야 할까요?  
A: ES256은 서명 크기가 작아 네트워크 이점이 있지만, 키 관리와 라이브러리 지원을 먼저 확인하세요(예: OpenSSL vs libsecp256k1 지원). 작은 차이로 운영 부담이 달라질 수 있습니다.

Q: 서비스 디스커버리와 결합하려면?  
A: token_endpoint와 jwks_uri를 서비스 메타데이터로 관리하고 ConfigMap/KV 저장소(Consul, Vault)와 연동하면 좋습니다.

실무 체크리스트

- [ ] 인증서버가 RFC 7523(RFC 8693 포함) 지원 여부 문서 확인
- [ ] token_endpoint URL과 요청 파라미터 형식 확인
- [ ] 필요한 JWT 클레임(iss, sub, aud, exp, jti) 목록 작성
- [ ] 개인키 보관 위치 확인(/etc/myapp/keys/private.pem 등) 및 파일 권한 설정(chmod 640)
- [ ] 공개키가 JWKs 또는 관리 콘솔에 등록되어 있는지 확인
- [ ] assertion_algorithm(RS256 등) 일치 여부 확인
- [ ] 로그 경로(/var/log/myapp/auth.log, auth-server logs)와 에러 메시지 샘플 수집
- [ ] 토큰 발급 후 리소스 서버 호출로 최종 권한 확인(curl + HTTP 상태 코드)
- [ ] 키 회전 정책 및 자동화 계획(주기, 무중단 교체 방법) 수립

참고 문서(우선 확인 경로)

- RFC 7523 (JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication and Authorization Grants)
- RFC 8693 (OAuth 2.0 Token Exchange)
- 사용 중인 인증서버 공식 문서(예: Keycloak, Auth0, Okta 등)에서 "client assertion" 또는 "token exchange" 키워드 검색

마무리 — 무엇을 먼저 확인할지, 언제 다른 선택지가 나은지

- 먼저 확인할 것: 인증서버가 어떤 클라이언트 인증 방식을 지원하는지(클레임 요구사항·엔드포인트·서명 알고리즘), 그리고 **aud/iss 값**이 문서와 일치하는지입니다.
- 다른 선택지가 나은 경우: 인증서버가 token-exchange를 지원하지 않거나 키 관리에 큰 부담이 있다면, 내부 신뢰 구역에서만 사용할 클라이언트 시크릿 방식이나 IP 기반 신뢰, mTLS 같은 대체 방법을 고려하세요.
