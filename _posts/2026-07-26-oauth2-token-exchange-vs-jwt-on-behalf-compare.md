---
title: "OAuth2 Token Exchange vs JWT On-Behalf: 보안·운영 선택 기준 정리"
description: "OAuth2 Token Exchange(RFC8693)과 JWT On-Behalf(OBO) 흐름 비교, 보안·운영 관점 선택 기준·구현 예시·검증 명령·로그 위치·오류별 조치와 체크리스트 제공"
slug: "oauth2-token-exchange-vs-jwt-on-behalf-compare"
date: 2026-07-26 13:10:00 +0900
categories: ["Security", "Cloud"]
tags: ["oauth2", "jwt", "on-behalf-of", "token-exchange", "인증", "보안설계"]
image:
  path: /assets/img/posts/blog/oauth2-token-exchange-vs-jwt-on-behalf-compare/preview.png
  alt: "Token Exchange vs On-Behalf 썸네일"
---

OAuth2 Token Exchange(RFC8693)은 '토큰을 교환'해 권한을 위임·연결할 때 유용하고, JWT On-Behalf(예: Azure AD OBO)는 사용자 컨텍스트를 유지하며 서비스 간 호출을 위임할 때 편하다. 핵심은 **권한 경계 유지, 인증서 또는 비밀 관리, 로그 추적 쉬움** 중 무엇을 더 중시하느냐다.

여기서는 실제로 내가 구현·운영하면서 먼저 확인할 부분(토큰 엔드포인트, 로그 위치, 에러 메시지), 실패 시 재현 명령어(curl), 그리고 간단한 성공/실패 예시 코드를 같이 둔다. RFC8693과 Azure OBO 문서를 공식 참조했고(본문에 링크 포함), 구현 예시에는 curl, OpenSSL, jwt-cli 같은 도구명을 적었다.

## 언제 어떤 흐름이 더 잘 맞나 — 선택 기준 먼저

- 마이크로서비스가 서로 다른 권한 도메인(예: A 서비스는 read:user, B 서비스는 write:files)을 갖고 있고 **중간 서비스가 관여해 역할을 바꿔야** 하면 Token Exchange가 더 명확하다.
- 클라이언트의 사용자 컨텍스트(예: 사용자 액세스 토큰)를 그대로 이용해 백엔드가 다른 API를 호출해야 하면 OBO가 편하다(특히 Azure AD 환경).
- 보안 관점: **토큰 교환은 교환 토큰의 최소 권한화가 명확**하고, OBO는 사용자 토큰 체인을 잘 관리해야 탈취 위험이 커질 수 있다.
- 운영 관점: 로그 추적과 감사, 토큰 수명·회전 자동화, 권한 스코프 변경의 파급력이 무엇보다 중요하다.

간단하게 질문하여 판단하는 법.

- 권한 범위 조정이 잦고 중앙에서 정책을 강하게 걸고 싶으면 Token Exchange.
- Azure AD와 같은 IdP 통합이 이미 깊고, 사용자 세션 기반 호출이 많으면 OBO.

## 토큰 교환(RFC 8693) 핵심 요청과 예시

토큰 교환 요청은 보통 다음과 같은 형태다. 실무에서는 토큰의 종류(subject_token, actor_token 등)를 명확히 기록한다.

예시 curl (실패/수정 예시 포함):

실패 예시: subject_token을 URL 인코딩하지 않거나 grant_type 오타로 400 반환.

```bash
curl -X POST https://idp.example.com/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=eyJhbGciOi..." \
  -u "client-id:client-secret"
```

수정 예시: subject_token URL 인코딩, 권한(scope) 명시

```bash
curl -X POST https://idp.example.com/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "eyJhbGciOi...")&scope=api:read" \
  -u "client-id:client-secret"
```

오류 메시지 예시:

- invalid_request — 파라미터 누락 또는 형식 문제
- invalid_client — 클라이언트 인증 실패
- invalid_grant — subject_token이 만료되었거나 변조됨

공식 문서: RFC8693 — https://datatracker.ietf.org/doc/html/rfc8693

## JWT On-Behalf (OBO) 흐름 핵심 요점

OBO는 주로 OAuth2 authorization_code로 발급된 사용자 액세스 토큰을 백엔드가 받아서, 백엔드가 IdP에 해당 토큰을 제시하고 다른 리소스 액세스 토큰을 요청하는 방식이다. Azure AD의 경우 grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer 또는 on_behalf_of 파라미터 사용.

간단한 OBO 요청 예시(Azure 스타일):

```
curl -X POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'client_id=BACKEND_CLIENT_ID&client_secret=BACKEND_SECRET&grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&requested_token_use=on_behalf_of&scope=https://graph.microsoft.com/.default&assertion={user_access_token}'
```

주의: assertion(user_access_token)이 만료되면 OBO 실패. 에러로는 "interaction_required" 또는 "invalid_grant"가 흔하다.

참조 문서: Microsoft OBO — https://learn.microsoft.com/azure/active-directory/develop/v2-oauth2-on-behalf-of-flow

## 실패 증상 / 원인 / 확인 명령 / 조치

다음 표는 현장에서 바로 사용할 수 있도록 구성했다. 각 행을 봐서 먼저 어떤 로그를 봐야 하는지 판단하자.

| 실패 증상                     | 가능 원인              | 확인 명령(예시)                                           | 대응 조치                                  |
| ----------------------------- | ---------------------- | --------------------------------------------------------- | ------------------------------------------ |
| 400/invalid_request           | 파라미터 누락/오타     | curl 요청 본문 확인, `grep grant_type`                    | 파라미터 재검증, URL 인코딩 적용           |
| invalid_client                | client 인증 실패       | IdP 로그(/var/log/idp/auth.log) 확인, curl -u 테스트      | client_secret 재발급 또는 시계 동기화 확인 |
| invalid_grant                 | subject/assertion 만료 | jwt decode: `jwt decode <token>` 또는 `openssl base64 -d` | 토큰 만료 시간 확인, refresh 흐름 검토     |
| insufficient_scope            | scope 부족             | 응답 오류 메시지 및 access token payload 확인             | scope 확장 또는 권한 위임 정책 변경        |
| 토큰 교환 후 권한이 너무 넓음 | 교환 규칙 부재         | 교환 규칙 설정 파일 확인(/etc/idp/token-exchange.yml)     | 최소 권한화 정책 적용, mapping 규칙 추가   |

여기서 시간을 많이 쓰는 부분: IdP 로그 경로와 포맷이 팀마다 달라서 확인에 시간이 걸린다.

## 비교 표: 선택 기준 정리

비교 기준을 먼저 정하고 표를 본다(가독성 고려).

| 기준                 | Token Exchange               | JWT On-Behalf (OBO)     |
| -------------------- | ---------------------------- | ----------------------- |
| 사용자 컨텍스트 보존 | 낮음–명시적으로 전달         | 높음–원본 토큰 사용     |
| 권한 최소화          | **용이**(policy 적용)        | 가능하지만 관리 필요    |
| IdP 의존도           | 표준(RFC8693) 지원 IdP 필요  | IdP별 구현 차 있음      |
| 감사·추적            | 토큰 발급 기록으로 분리 가능 | 토큰 체인 추적으로 복잡 |
| 구현 난이도          | 중간(정책/매핑 필요)         | 쉬움(특히 MS 환경)      |

이 차이가 운영에서는 꽤 크다. 예를 들어 권한 회전·감사 요구가 엄격하면 Token Exchange를 권장한다.

## 구현 체크포인트(명령·파일·로그·버전)

운영자가 바로 확인해야 할 항목들:

- IdP 버전/구성: `idp --version` 또는 관리 콘솔에서 확인 (예: Keycloak 17.0.1 이상에서 RFC8693 플러그인 필요).
- 토큰 엔드포인트 경로: /oauth2/token 또는 /protocol/openid-connect/token
- 로그 위치: Keycloak: /opt/keycloak/standalone/log/server.log, Azure AD는 포털 진단 로그
- 테스트 명령: curl로 grant_type 확인(위 예시들)
- JWT 디코드: `jwt decode <token>` 또는 `python3 -c 'import jwt,sys;print(jwt.decode(sys.argv[1], options={"verify_signature":False}))'`
- OpenSSL 버전: `openssl version` (토큰 서명 검증시 필요; 권장 1.1.1+ 또는 3.x)
- 의심되는 오류 메시지 샘플: invalid_grant, invalid_client, insufficient_scope, interaction_required

여기서 확인할 파일 경로 예시:

- /etc/idp/token-exchange.yml (토큰 교환 매핑)
- /etc/idp/keystore.jks (서명 키 저장)
- /var/log/myservice/auth.log (서비스 측 인증 로그)

## 실패 예시와 수정 예시 (코드)

실패 예시(Python 요청 처리에서 subject_token을 그대로 전달해 400 발생):

```
# 잘못된 처리: subject_token을 URL 인코딩 안함
data = {
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": user_token
}
resp = requests.post(token_endpoint, data=data, auth=(client_id, client_secret))
```

수정 예시(인코딩 및 scope 최소화):

```
import urllib.parse
data = {
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": urllib.parse.quote_plus(user_token),
  "scope": "api:read"
}
```

이 차이로 실제로 "invalid_request" 오류가 사라진다면 토큰 전달 방식을 먼저 의심하자.

## Q&A

Q: Token Exchange와 OBO를 같이 써도 되나?
A: 가능하다. 예: 프론트엔드→백엔드(OBO) → 다른 서비스에선 Token Exchange로 최소 권한 토큰 발급. 단, 감사 로그 복잡도가 올라간다.

Q: 어떤 IdP가 RFC8693을 기본 지원하나?
A: Keycloak(플러그인 또는 최신 버전), ForgeRock 등은 지원한다. 공식 문서와 버전 릴리스 노트를 확인하라.

Q: subject_token이 만료되면 어떻게 재현하나?
A: 만료 토큰을 curl로 전송 후 응답(오류 코드)을 캡처. 재현 명령: 위의 curl 실패 예시.

Q: OBO에서 사용자의 consent가 필요하면?
A: IdP 정책에 따라 require_interaction 상태가 됨. 사용자 재인증 흐름을 설계해야 한다.

Q: 토큰 교환 시 토큰 유통기한을 어떻게 제한하나?
A: IdP 측 설정(토큰 매핑 룰)에서 issued_token_lifetime을 조정하거나 교환 시 scope를 좁혀 제한한다.

![토큰 교환과 OBO 흐름 단순 비교 다이어그램](/assets/img/posts/blog/oauth2-token-exchange-vs-jwt-on-behalf-compare/image-1.webp)

## 함께 보면 좋은 글

- [JWT on-behalf 패턴으로 OAuth2 클라이언트 시크릿 없이 백엔드 권한 위임하기](/posts/jwt-on-behalf-backend-delegation-without-client-secret/)
- [브라우저 토큰 저장 비교: localStorage vs Cookies — 실무에서 확인할 포인트](/posts/browser-token-storage-localstorage-cookie/)
- [JWT 키·알고리즘 롤링과 기존 토큰 단계적 무효화 실무 가이드](/posts/jwt-key-rotation-stepwise-invalidation-procedure/)

## 실무 체크리스트

- curl로 토큰 엔드포인트 기본 요청 실행해 응답 확인: grant_type, subject_token 포함 (예: 위 curl 예시).
- IdP 로그에서 요청 타임스탬프와 오류 메시지 캡처: Keycloak server.log 또는 IdP 콘솔 진단 로그 확인.
- 서비스 쪽 로그(/var/log/myservice/auth.log)에서 incoming token과 outgoing token 매핑 라인 확인.
- 토큰 페이로드(jwt)에서 exp, scope, azp(또는 aud) 확인: `python3 -c 'import jwt,sys;print(jwt.decode(sys.argv[1], options={"verify_signature":False}))'`.
- 토큰 교환 규칙 파일(/etc/idp/token-exchange.yml) 백업 및 변경 시 정책 적용 테스트(스테이징) 수행.
- 클라이언트 시크릿 또는 키 변경 시 롤링 전략 문서화 및 비밀 저장소 업데이트(AWS Secrets Manager/HashiCorp Vault).
- 실패 재현 명령과 성공 명령 스크립트 저장(ci/scripts/token-test.sh) — CI에서 주기적 검사 권장.
- 롤백 전에 사용자 영향 범위(토큰 유효 기간, 세션 수) 확인 및 커뮤니케이션 준비.

![curl로 토큰 엔드포인트 기본 요청 실행해 응답 확인 일러스트](/assets/img/posts/blog/oauth2-token-exchange-vs-jwt-on-behalf-compare/image-2.webp)

마지막으로 내가 먼저 볼 로그는 IdP의 토큰 발급 로그와 서비스의 auth.log다. 처리가 꼬였을 때는 먼저 grant_type과 subject_token 값이 정확히 전달됐는지 curl로 재현하고, JWT의 exp와 aud, scope를 디코드해서 확인하라. 권한 모델 변경이 잦다면 Token Exchange로 정책 중심 설계를 고려하고, 이미 IdP 통합이 깊다면 OBO로 먼저 가서 운영 부담을 줄일 수 있다.
