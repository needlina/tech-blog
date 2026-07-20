---
title: "JWT 키·알고리즘 롤링과 기존 토큰 단계적 무효화 실무 가이드"
description: "JWT 서명키·알고리즘 교체 시 단계적 무효화 절차, kid/jwks 점검 포인트, 롤링 전략 비교, 테스트 명령과 장애 증상 확인 경로 포함"
slug: "jwt-key-rotation-stepwise-invalidation-procedure"
date: 2026-07-20 10:00:00 +0900
categories: ["Security", "DevOps"]
tags: ["jwt", "key-rotation", "token-revocation", "보안점검", "배포자동화"]
image:
  path: /assets/img/posts/blog/jwt-key-rotation-stepwise-invalidation-procedure/preview.png
  alt: "JWT 무중단 롤링 썸네일"
---

로컬에서는 새 키로 서명해도 문제가 없는데, 운영에서는 기존 토큰을 갑자기 끊으면 사용자 불편과 장애가 생길 수 있으니 **새 키를 병행 적용하고 일정 기간 동안 둘 다 검증한 뒤 기존 토큰을 만료시키는 것**과, JWKS/kid/토큰 TTL 확인이 핵심이라는 점을 먼저 요약합니다.

처음 이 주제를 접했을 때 저는 "키를 바꾸면 그냥 배포하면 되지?"라고 생각했는데, 실제로는 사용자에게 발급된 액세스 토큰과 리프레시 토큰의 만료 시간, 인증서 캐시(예: JWKS 캐시), 서명 알고리즘 변경 이슈 때문에 서비스 중단이나 보안 구멍이 생길 수 있다는 점이 헷갈렸습니다. 이 글은 제가 공부하면서 정리한 개념, 실무에서 바로 확인할 포인트, 실패 사례와 수정 예시, 검증 명령을 중심으로 단계별로 적어둔 초안입니다.

공부하면서 알게 된 점
- JWT 롤링의 기본 패턴은 **신규 키로 서명 시작 → 서버는 새/구 키 둘 다 검증 허용(그레이스 기간) → 기존 키 청소(블랙리스트 또는 만료 대기)** 순서입니다.
- JWKS(또는 JWK endpoint)는 키 교체 시 서비스가 새 공개키를 바로 받아올 수 있게 하는 핵심 채널입니다. 클라이언트와 API 게이트웨이는 이 엔드포인트를 주기적으로 재조회하거나 캐시 만료를 짧게 두어야 합니다.
- 알고리즘을 바꿀 때(예: HS256 → RS256)는 특히 주의해야 합니다. 잘못된 구성은 서명 검증 우회(alg none 취약점 등)를 유발할 수 있습니다.

처음에는 헷갈렸던 부분
- kid(header)와 실제 키 버전을 어떻게 동기화할지: auth 서버에서 토큰 발급 시 kid를 명시하고, JWKS 엔드포인트에 동일 kid의 공개키가 있어야 합니다.
- 리프레시 토큰을 어떻게 처리할지: 리프레시 토큰은 만료를 길게 두는 경우가 많아, 롤링 정책을 별도로 설계해야 합니다(예: 리프레시 토큰은 서버 측 DB에서 상태를 관리).

핵심 개념 간단 정리
- kid: 토큰 헤더의 키 식별자. 검증 시 사용할 공개키 선택에 사용.
- JWKS: 공개키 집합 JSON. 예: https://auth.example.com/.well-known/jwks.json
- 그레이스 기간: 신규 키로 서명 후 구 키를 일정 시간 허용하는 기간(예: 3600초 = 1시간).
- 단기 만료(TTL): 액세스 토큰은 보통 60~3600초, 리프레시 토큰은 며칠~수개월.

실무에서 확인하면 좋겠다 — 체크 포인트 (즉시 확인 가능한 항목)
- JWKS 엔드포인트 응답(포트 443, 경로 /.well-known/jwks.json) 정상 여부: curl -sS https://auth.example.com/.well-known/jwks.json | jq
- 인증 서비스 로그에서 "InvalidSignatureError" 또는 "InvalidAlgorithmError" 탐지: journalctl -u auth-service | grep -E "InvalidSignature|InvalidAlgorithm"
- 토큰 발급 시 헤더의 kid 값과 JWKS의 키 ID 일치 확인(예: 발급 토큰 헤더에서 kid="k20260720-v2"인지 확인)
- 토큰 만료 시간(exp)과 리프레시 정책 확인: 발급시 exp 값이 900(15분)인지, 리프레시 토큰은 604800(7일)인지 점검

구체적 명령과 파일 예시 (실행 가능한 예시 포함)
- 키 생성(예시: RSA 2048, OpenSSL 3.0.0)
  - private: /etc/auth/keys/private-20260720.pem
  - public: /etc/auth/keys/public-20260720.pem
  - 명령:
    - openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /etc/auth/keys/private-20260720.pem
    - openssl rsa -in /etc/auth/keys/private-20260720.pem -pubout -out /etc/auth/keys/public-20260720.pem
- 공개키를 JWK로 변환(예시 도구는 사용 환경에 따라 다름)
  - 예: Node.js의 pem-jwk나 python-jose를 사용
- JWKS 배포 위치: /var/www/auth/.well-known/jwks.json (웹 서버로 서빙)
- JWKS 테스트:
  - curl -I https://auth.example.com/.well-known/jwks.json    # HTTP 200 확인
  - curl -sS https://auth.example.com/.well-known/jwks.json | jq '.keys | length'  # 키 개수 확인
- 토큰 검증(파이썬 예시, Python 3.10, PyJWT 2.8.0)
  - 설치: python3.10 -m pip install pyjwt cryptography==40.0.1
  - 검증 예시(실패 예시와 수정 예시 포함):

실패 예시 (잘못된 알고리즘 허용으로 인한 실패)
```python
# 실패: 서버가 HS256만 허용하도록 설정했는데 토큰 alg이 RS256으로 설정됨
import jwt
token = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsyMDI2MDcyMC12MiJ9..."  # 예시
try:
    payload = jwt.decode(token, "wrong-secret", algorithms=["HS256"])
except Exception as e:
    print("검증 실패:", type(e).__name__, e)
# 출력 예: 검증 실패: InvalidAlgorithmError The specified alg is not allowed
```

수정 예시 (공개키로 RS256 검증)
```python
from jwt import PyJWKClient, decode
jwks_url = "https://auth.example.com/.well-known/jwks.json"
jwk_client = PyJWKClient(jwks_url)
signing_key = jwk_client.get_signing_key_from_jwt(token).key
payload = decode(token, signing_key, algorithms=["RS256"], options={"verify_aud": False})
print("payload:", payload)
```

JWT 검증 실패 시 흔한 로그 메시지 예
- InvalidSignatureError: Signature verification failed
- ExpiredSignatureError: Signature has expired
- InvalidAlgorithmError: The specified alg is not allowed

롤링 전략 비교 (실무 관점 — 선택 기준과 확인 명령 중심)

| 방식 | 언제 선택 | 실패 증상 | 실무 확인 명령 |
|---|---:|---|---|
| 단기 TTL(예: 15분) | 배포 간섭 최소화, 사용자 재인증 허용 | 짧은 세션 불만 | 토큰 exp 값 확인: jwt.decode(...)[ 'exp'] |
| 그레이스 기간 병행 검증 | 제로 다운타임 롤링 필요 | 오래된 키가 계속 사용됨(보안) | JWKS 갱신 주기, 서비스 로그 검색 |
| 서버 사이드 블랙리스트(Redis) | 리프레시 토큰 강제 취소 필요 | 블랙리스트 미등록 시 토큰 통과 | redis-cli GET jti:... |
| 토큰 인스펙션(central introspection) | 고신뢰 환경 (성과 비용 상충) | 성능 저하 | introspection endpoint 응답 시간 측정(curl -w) |

코드/설정 배포 예시 (GitHub Actions로 JWKS 업로드)
- 아래 예시는 GitHub Actions에서 S3에 JWKS를 업로드하는 간단한 스텝 예시입니다. Jekyll/Liquid와 충돌할 수 있는 표현식(${ { ... }})가 있으므로 raw 블록으로 감쌌습니다.

{% raw %}
```yaml
- name: Upload JWKS to S3
  uses: jakejarvis/s3-sync-action@master
  with:
    args: --acl public-read --delete
  env:
    AWS_S3_BUCKET: ${{ secrets.AWS_S3_BUCKET }}
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    SOURCE_DIR: "./deploy/jwks"
```
{% endraw %}

실패 사례와 고친 방법(사례 기반)
- 문제: 알파 서비스에서 HS256 → RS256으로 전환 후 일부 클라이언트가 인증 실패
  - 원인: 클라이언트 라이브러리가 JWKS를 캐시하고 있어 새 키를 못 읽음(캐시 TTL 86400초 = 24시간)
  - 조치: 클라이언트 라이브러리의 JWKS 캐시 TTL을 300초(5분)로 단축, 서버는 그레이스 기간 3600초(1시간) 설정 후 구 키 회수
- 문제: 키 유출 의심
  - 원인: S3 버킷에 개인키 권한 설정 오류(chmod 644)
  - 조치: 개인키 권한을 600으로 변경(chmod 600 /etc/auth/keys/private-20260720.pem), 버킷 private로 재설정, 모든 토큰 강제 재발급(블랙리스트 + 리프레시 토큰 무효화)

이미지: JWT 키 롤링 개념도
![키 롤링: 새 키와 구 키를 병행 검증하는 개념도](/assets/img/posts/blog/jwt-key-rotation-stepwise-invalidation-procedure/image-1.webp)
이미지 출처: AI 생성 이미지

자주 묻는 질문 (Q&A)
Q: 액세스 토큰 TTL을 얼마로 해야 하나요?
A: 일반적인 시작점은 900초(15분). 트래픽과 UX를 고려해 60~3600초 범위에서 서비스 특성별로 조정하세요. 짧게 잡을수록 키 유출 시 위험 노출 시간이 짧아지지만 인증 요청이 늘어납니다.

Q: 리프레시 토큰은 어떻게 무효화하나요?
A: 리프레시 토큰은 서버에 상태를 저장(예: DB 테이블 또는 Redis)에 두고 jti를 기준으로 블랙리스트를 관리하는 편이 안전합니다. 블랙리스트 저장소는 TTL(예: 리프레시 만료 + 1일)로 관리하세요.

Q: 알고리즘을 HS256에서 RS256으로 바꾸면 무조건 안전한가요?
A: RS256은 공개/개인키 구조로 비밀 공유 위험을 줄여주지만, 구현 실수(alg 필터링 미비, 키 관리 미흡)는 여전히 위험합니다. 헤더의 alg을 신뢰하지 말고 서버에서 허용 목록을 검증하세요.

Q: 키 합의(kid) 충돌이 나면 어떻게 알 수 있나요?
A: 로그에서 "No matching JWK found for kid" 또는 "get_signing_key_from_jwt failed" 같은 메시지를 확인하세요. JWKS와 발급 로직의 키 이름 규칙을 동기화해야 합니다.

실무 검증 절차(재현·테스트용)
1. 새 키로 샌드박스 환경에서 토큰 발급(Python 3.10, PyJWT 2.8.0).
2. JWKS 엔드포인트에 새 공개키가 반영되었는지 curl로 확인(curl -sS https://auth.example.com/.well-known/jwks.json | jq).
3. 서버를 새 서명 코드로 배포하고, 인증 서버는 그레이스 기간 동안 구 키도 검증하도록 설정(예: GRACE_SECONDS=3600).
4. 클라이언트에서 기존 토큰(구 키로 발급)으로 API 호출하여 정상 동작 확인.
5. 그레이스 기간 이후 구 키 제거, 블랙리스트 적용 여부 점검(redis-cli keys jti:* 등).
6. 모니터링: 인증 실패율 증가(5xx, 401) 혹은 JWKS fetch 오류(404/5xx)를 30분 단위로 확인.

이미지: 단계별 롤링 절차 흐름도
![단계별 키 롤링과 검증 플로우](/assets/img/posts/blog/jwt-key-rotation-stepwise-invalidation-procedure/image-2.webp)
이미지 출처: AI 생성 이미지

공식 문서·검증 경로
- RFC 7515 JSON Web Signature (JWS): https://datatracker.ietf.org/doc/html/rfc7515
- OAuth 2.0 JWT 권장사항 및 JWKS 표준: https://tools.ietf.org/html/rfc7517
- 라이브러리 문서: PyJWT, node-jose, Auth0 JWKS 문서(각 라이브러리 버전별 사용법 확인)

## 나의 의견 1
여기에 직접 겪은 환경(예: 토큰 만료 시간, 사용한 라이브러리 버전, 처음 실패한 로그 메시지 등)을 적어 보세요. 가능한 한 버전과 명령(예: Python 3.10, PyJWT 2.8.0, 로그 내용)을 포함하면 좋습니다.

## 나의 의견 2
롤링 정책을 실제로 적용하면서 관찰한 결과(예: 사용자 불편 발생 시간대, JWKS 캐시 문제 발생 빈도, 블랙리스트 조회 성능 영향 등)를 적어 보세요. 실패 전후의 구체적인 수치(에러율, 응답 시간 등)를 남기면 추후 개선에 도움이 됩니다.

실무 체크리스트
- [ ] 현재 액세스 토큰 TTL 확인 (예: exp 값, 기본 900초인지)
- [ ] 리프레시 토큰 저장 위치와 무효화 절차 확인(DB/Redis 경로, 테이블/키 명)
- [ ] JWKS 엔드포인트 경로와 응답(HTTP 200, key count) 확인: curl -sS https://auth.example.com/.well-known/jwks.json | jq
- [ ] 배포 전 그레이스 기간 정의(초 단위, 예: 3600초) 및 서버 설정 반영
- [ ] 배포 파이프라인에서 비밀(개인키) 권한 확인(chmod 600, S3 버킷 private)
- [ ] 인증 로그에서 InvalidSignature/InvalidAlgorithm 에러 탐지 규칙 추가
- [ ] 클라이언트 라이브러리의 JWKS 캐시 TTL 점검(예: 기본 24시간이면 300초로 단축 고려)
- [ ] 키 유출 의심 시 즉시 다음 3단계 실행: (1) 새로운 키 생성, (2) 기존 키 블랙리스트 등록/리프레시 무효화, (3) 모든 서비스에 JWKS 강제 재로드
- [ ] 관련 문서 링크(RFC, 라이브러리 가이드) 저장 및 배포팀과 공유

마무리 — 무엇을 먼저 확인해야 하나요, 언제 다른 선택을 고려하나요
- 먼저 확인할 것: 현재 운영 중인 토큰의 평균 TTL(초), JWKS 캐시 정책, 발급 토큰 헤더의 kid 규칙. 이 세 가지를 모르면 롤링 중 서비스 장애 가능성이 높습니다.
- 다른 선택이 나은 경우: 만약 사용자 세션이 거의 실시간으로 끊기면 안 되는 상황(예: 금융 트랜잭션)은 토큰 인스펙션/서버 사이드 세션 관리를 고려하세요. 반대로 인증 요청이 빈번하고 성능이 중요하면 **짧은 TTL + 그레이스 병행**이 보편적으로 무난한 타협일 수 있습니다.

읽으면서 더 궁금한 점이나, 제가 넣은 명령/파일 경로 예시(예: /etc/auth/keys/private-20260720.pem, /var/www/auth/.well-known/jwks.json)를 실제 환경에 맞게 바꾸는 방법이 궁금하면 이어서 질문해 주세요.