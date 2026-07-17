---
title: "CDN 캐시 무효화: 전체 purge를 피하는 방법과 실무 체크리스트"
description: "CDN 캐시를 무효화할 때 전체 purge를 피하는 방법 서론 — 왜 전체 퍼지(purge)가 문제인가 제가 처음 CDN을 운영할 때, 릴리스 중에 \"전체 캐시 무효화(전체 purge)\"를 습관적으로 사용하곤 했습니다"
slug: "cdn-cache-invalidation-strategy"
date: 2026-07-14 10:00:00 +0900
categories: [DevOps, Cloud]
tags: [cdn, cache-invalidation, cache-control, devops]
image:
  path: /assets/img/posts/blog/cdn-cache-invalidation-strategy/preview.png
  alt: "CDN 캐시 무효화 전략 썸네일"
---

CDN 캐시를 무효화할 때 전체 purge를 피하는 방법 서론 — 왜 전체 퍼지(purge)가 문제인가 제가 처음 CDN을 운영할 때, 릴리스 중에 "전체 캐시 무효화(전체 purge)"를 습관적으로 사용하곤 했습니다


CDN 캐시를 무효화할 때 전체 purge를 피하는 방법

서론 — 왜 전체 퍼지(purge)가 문제인가
제가 처음 CDN을 운영할 때, 릴리스 중에 "전체 캐시 무효화(전체 purge)"를 습관적으로 사용하곤 했습니다. 한 번에 모든 엣지 노드의 콘텐츠를 날려버리면 즉시 모든 사용자에게 최신 콘텐츠를 제공할 수 있다는 안도감이 있었거든요. 하지만 몇 번 겪어보니 문제점이 있었습니다. 전체 퍼지는 다음과 같은 부작용을 초래할 수 있습니다.

- 엣지에서 원본(origin)으로의 트래픽 급증(캐시 워밍업 문제)
- 트래픽 급증으로 인한 원본 과부하나 비용 증가
- CDN 제공업체의 퍼지 제한(요청률/비용)
- 사용자 측에 순간적인 응답 지연 증가

그래서 요즘은 가능한 전체 퍼지를 피하고, 더 세밀한 무효화 전략을 쓰려고 합니다. 이 글에서는 제가 공부하면서 정리한 방법들과 실무에서 체크하면 좋은 포인트들을 정리해봅니다. 초보자의 관점에서 정리한 것이므로 모든 사례에 딱 맞지는 않을 수 있습니다.

공부하면서 알게 된 주요 방법들
아래는 전체 퍼지를 피할 때 흔히 사용되는 전략들입니다. 각 방법의 개념과 실무에서 점검할 포인트를 함께 적었습니다.

1. 자원 버전링(버전된 URL 또는 해시된 파일명)

- 설명: 정적 자원(예: JS/CSS, 이미지)에 파일명에 해시를 붙여서 URL 자체를 바꿉니다. 그러면 기존 캐시는 그대로 두고, 새 URL로 배포되므로 전체 퍼지가 필요 없습니다.
- 장점: 간단하고 안전. CDN 무효화가 거의 필요 없음.
- 체크 포인트: 빌드 파이프라인에서 해시가 제대로 붙는지(예: webpack, parcel), HTML 템플릿이나 텍스트 파일이 새로운 파일명을 참조하도록 자동화됐는지 확인.
- 예시(간단한 HTML):
  ```html
  <!-- 예: 빌드 도구가 app.abc123.js 형태로 만들어줌 -->
  <script src="/assets/app.abc123.js"></script>
  ```
- 실무 팁: CSS/JS는 해시 기반 버전링으로 처리하고, HTML 같은 동적 페이지는 서버 캐시 전략으로 분리합니다.

![CDN 엣지 노드와 오리진 서버 사이의 트래픽 흐름을 단순한 아이콘으로 표현한 다이어그램](/assets/img/posts/blog/cdn-cache-invalidation-strategy/image-1.webp)
이미지 출처: AI 생성 이미지

2. 서러게이트 키 / 태그 기반 무효화 (surrogate key / cache tagging)

- 설명: CDN(또는 캐시 레이어)이 리소스에 태그(예: Surrogate-Key 헤더)를 붙여 관리하면, 특정 키(또는 태그)에 해당하는 리소스만 무효화할 수 있습니다.
- 대표 사례: Fastly의 Surrogate-Key, Varnish + custom header로 구현한 tagging 등.
- 예시(Varnish VCL에서 헤더를 붙이는 간단한 예):
  ```vcl
  sub vcl_deliver {
    set resp.http.Surrogate-Key = "article-123 author-45";
  }
  ```
- 무효화(예시 명령, 제품마다 다름):
  - Fastly: API로 surrogate key로 purge
  - Varnish: varnishadm으로 ban/ban.url
- 체크 포인트: 태그 정책(어떤 리소스에 어떤 키를 붙일지)을 문서화, 무효화 API 사용권한과 속도/비용을 확인.

3. 캐시 제어와 revalidation (Cache-Control, stale-while-revalidate)

- 설명: Cache-Control: s-maxage, stale-while-revalidate 같은 지시자를 이용하면, 엣지에서 오래된 콘텐츠를 바로 제공하면서 백그라운드로 원본을 갱신할 수 있습니다. 즉각적인 퍼지를 피하면서도 점진적으로 최신화가 가능합니다.
- 예시(응답 헤더):
  ```
  Cache-Control: public, s-maxage=3600, stale-while-revalidate=30
  ```
- 체크 포인트: CDN이 해당 지시자를 지원하는지(모든 업체가 동일하게 해석하지 않을 수 있음) 확인, 사용자 경험에 미치는 영향(구형 콘텐츠 수 초 노출)을 검토.

4. 선택적 경로/와일드카드 무효화와 리스트 무효화

- 설명: 전체가 아닌 경로 패턴 또는 URL 리스트만 무효화합니다. CloudFront는 와일드카드 제한이나 속도 제한이 있으니 운영 환경을 고려해야 합니다.
- 예시(AWS CLI로 특정 경로 무효화):
  ```bash
  aws cloudfront create-invalidation --distribution-id E1234ABC --paths "/images/*" "/css/app.css"
  ```
- 체크 포인트: CDN 공급자의 API 제한(초당 요청 수, 비용)을 확인하고, CI에서 무효화 호출을 안전하게 관리할 것.

5. 소프트 퍼지(soft purge) 또는 캐시 우회

- 설명: 소프트 퍼지는 서버가 응답 헤더로 '무효화 신호'를 보내지만, 엣지는 기존 콘텐츠를 당장 버리지 않고 필요 시 재검증을 하게 합니다. 또는 특정 쿼리 파라미터를 사용해 캐시 우회(fetch with cache-bypass)를 유도할 수도 있습니다.
- 체크 포인트: 소프트 퍼지 동작을 로그로 검증, 캐시 우회 쿼리 사용 시 URL 노출 정책 확인(검색엔진/외부 링크 문제).

실무에서 자주 헷갈렸던 부분

- "Cache-Control과 CDN 설정 중 어느 쪽이 우선인가?"
  일반적으로 원본에서 보내는 Cache-Control 헤더가 우선권을 갖는 경우가 많지만, CDN의 설정(behavior, edge control)으로 덮어쓸 수 있습니다. 제공업체마다 우선순위가 다를 수 있으니, 테스트와 문서를 확인하는 습관이 필요합니다.
- "와일드카드 무효화가 비용이 적게 들까?"
  와일드카드 무효화가 전체 퍼지보다는 적은 경우가 많지만, 패턴이 넓으면 원본 트래픽 급증을 막지 못할 수 있습니다. 그리고 일부 CDN은 와일드카드를 내부적으로 여러 경로를 무효화해 역시 비용이 발생할 수 있습니다.

검증·점검 절차 (실무에서 이렇게 확인하면 좋겠다)
아래는 무효화 작업 전후로 확인하면 좋은 절차입니다.

1. 무효화 전 원본 트래픽/엣지 캐시 적중률 확인

- CloudFront/CloudWatch, Fastly/Realtime, CDN 로그에서 origin fetch rate와 hit/miss 비율 체크

![캐시 무효화 전략(버전링, 태그 무효화, TTL)을 세로로 나열해 비교하는 간단한 일러스트](/assets/img/posts/blog/cdn-cache-invalidation-strategy/image-2.webp)
이미지 출처: AI 생성 이미지

2. 무효화 실행(예: 특정 키/경로 무효화)

- 예시: AWS CloudFront invalidation
  ```bash
  aws cloudfront create-invalidation --distribution-id E1234ABC --paths "/css/app.abc123.css"
  ```
- 예시: Varnish ban
  ```bash
  varnishadm 'ban req.url ~ "^/images/2026/07/.*"'
  ```

3. 결과 확인 (Curl로 헤더 보기)

- curl로 엣지에서의 응답 헤더를 확인해 캐시 상태를 점검합니다.
  ```bash
  curl -I -sS https://example.com/path/to/resource
  ```
  확인 포인트:
  - Age, X-Cache, X-Cache-Status 같은 헤더로 캐시 적중 여부 확인
  - Cache-Control 헤더 값이 의도대로 전달되는지 확인

4. 모니터링 대시보드/알람 확인

- 원본(RPS, 5xx 비율) 및 엣지 응답 시간 모니터링
- 무효화 후 원본 요청 급증 시 경보 설정(예: RPS > baseline \* 3)

5. 로그 샘플링으로 사용자 영향 범위 파악

- CDN 로그나 엣지 로그에서 무효화 시점 전후의 응답 코드와 응답시간을 비교

간단한 도구/스크립트 예시

- CloudFront invalidation을 CI에서 호출할 때(예시 쉘 스크립트):
  ```bash
  #!/bin/bash
  DIST_ID=E1234ABC
  PATHS='["/assets/app.*.js","/assets/app.css"]'
  aws cloudfront create-invalidation --distribution-id $DIST_ID --invalidation-batch "{\"Paths\": {\"Quantity\": 2, \"Items\": $PATHS}, \"CallerReference\": \"$(date +%s)\"}"
  ```
- 특정 URL의 캐시 상태를 반복 체크하는 간단한 curl 루프:
  ```bash
  for i in {1..10}; do
    curl -I -sS https://example.com/assets/app.abc123.js | egrep 'HTTP/|Age|X-Cache|Cache-Control'
    sleep 1
  done
  ```

주의할 점(운영 상)

- CDN 제공업체마다 API 한도, 와일드카드 지원, 태그/무효화 방식이 다릅니다. 문서를 꼭 확인하세요.
- 무효화를 너무 자주 쓰면 비용/성능 이슈가 발생할 수 있습니다. 자동화 시 무효화 호출을 데바운스(debounce)하거나 배치로 묶는 것이 좋습니다.
- 캐시 키(쿼리 파라미터 포함), Vary 헤더 설정이 캐시 적중률에 큰 영향을 미칩니다. 의도치 않은 Vary 사용은 캐시 파편화를 초래할 수 있습니다.

처음에는 헷갈렸던 부분

- "정적 자원은 무조건 버전링"이라는 생각이 있었는데, 동적 페이지 일부도 캐시로 보호해야 할 때가 있었습니다. 예를 들어, 트래픽이 많은 사용자 프로필 페이지 일부는 디테일한 무효화 전략(태그 + TTL)으로 관리하는 것이 좋더군요.
- "CDN이 모든 것을 캐시할 수 있다"는 믿음도 위험합니다. 인증된 콘텐츠나 사용자별 응답은 캐시 설계가 까다롭습니다. 개인화된 부분과 공통 부분을 분리하는 설계(Edge-side includes 같은 패턴)를 고려해볼 필요가 있었습니다.

마무리 생각
전체 퍼지를 피하는 핵심은 가능한 한 캐시 키를 분리하고(파일명 버전, 태그), 무효화 범위를 최소화하며, 무효화가 필요한 상황에만 API/명령을 사용하는 것입니다. 또한 사후 검증(헤더, 로그, 모니터링) 절차를 자동화해, 무효화가 의도대로 동작했는지 확인하는 루틴을 갖추는 것이 중요합니다. 제 경험상 처음에는 복잡해 보였지만, 차근차근 정책을 문서화하고 CI 파이프라인에 통합하니 안정성이 많이 좋아졌습니다.

실무 체크리스트

- 배포 파이프라인에서 정적 자원에 해시 기반 버전링 적용 여부 확인
- CDN에서 surrogate-key 또는 tag 기반 무효화 지원 여부와 API 제약 확인
- 무효화 API 호출을 CI에 넣을 때 권한 및 호출 제한(쿼터) 처리 방안 마련
- Cache-Control, s-maxage, stale-while-revalidate 지시자 사용 정책 문서화
- 무효화 실행 전/후 원본(RPS)과 캐시 적중률(hit/miss) 모니터링 설정 및 알람 구성
- 무효화 테스트 절차(샘플 URL에 대해 curl로 헤더 확인)를 플레이북으로 작성
- Vary 헤더, 쿼리 문자열, 쿠키 등 캐시 키 요소를 검토해 불필요한 파편화 제거
- 긴급 전체 퍼지 필요 시의 롤백/트래픽 완화(예: 임시 오토스케일링) 계획 수립

읽어주셔서 감사합니다. 제가 정리한 내용은 실무 환경이나 CDN에 따라 동작 방식이 달라질 수 있으니, 적용 전에 해당 CDN 문서를 확인하고 작은 범위에서 실험해 보시길 권합니다.
