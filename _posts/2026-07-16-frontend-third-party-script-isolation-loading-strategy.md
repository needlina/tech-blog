---
title: "프론트엔드 서드파티 스크립트 최적화: 격리와 로드 전략으로 렌더링 성능 개선하기"
description: "오늘은 프론트엔드에서 서드파티(Third-party) 스크립트가 렌더링 성능에 미치는 영향과, 이를 단계적으로 격리하고 로드하는 전략을 정리해 보려 합니다"
slug: "frontend-third-party-script-isolation-loading-strategy"
date: 2026-07-16 10:00:00 +0900
categories: ["Frontend", "Performance"]
tags: ["frontend", "third-party-script", "성능튜닝", "로드전략", "렌더링최적화"]
image:
  path: /assets/img/posts/blog/frontend-third-party-script-isolation-loading-strategy/preview.png
  alt: "서드파티 스크립트 격리 썸네일"
---

오늘은 프론트엔드에서 서드파티(Third-party) 스크립트가 렌더링 성능에 미치는 영향과, 이를 단계적으로 격리하고 로드하는 전략을 정리해 보려 합니다. 저는 아직 배우는 중인 개발자라서 완벽한 정답을 말할 수는 없지만, 공부하면서 정리한 흐름과 실무에서 체크하면 좋을 포인트 위주로 적어보겠습니다.

목표는 단순합니다. 서드파티 스크립트가 페이지 로드와 인터랙션에 끼치는 부정적 영향을 줄이고, 사용자 체감 성능(특히 LCP, FID, CLS)을 개선할 수 있는 현실적인 절차를 정리하는 것입니다.

왜 이 주제를 선택했나

- 광고, A/B 테스팅, 분석, 위젯 같은 외부 스크립트는 편리하지만 종종 렌더링을 막거나 메인스레드를 점유합니다.
- 한 번에 모든 것을 바꾸기 어렵기 때문에 단계별로 위험을 줄이며 개선할 전략이 필요합니다.

처음에는 헷갈렸던 부분

- async vs defer의 차이: 둘 다 비동기 로드처럼 보이지만 실행 타이밍이 다릅니다. async는 다운로드가 끝나는 즉시 실행되어 순서가 보장되지 않고, defer는 HTML 파싱이 끝난 뒤 순서대로 실행됩니다. 이 차이가 스크립트 의존성에 영향을 줄 수 있어 처음에는 혼동이 있었습니다.
- iframe 격리 vs 동적 로드: iframe은 격리를 제공하지만 스타일/레이아웃 문제와 통신 복잡도가 생깁니다. 반대로 동적 로드는 더 유연하지만 메인스레드에 남아 성능 영향을 줄 수 있습니다.
- 리소스 힌트(preconnect/preload)의 효과와 부작용: 잘 쓰면 이득이지만 과도하면 다른 리소스 우선순위를 밀어낼 수 있습니다.

![서드파티 스크립트 로드 플로우(비차단 → 지연 → 격리)를 간단한 아이콘으로 표현한 순서도](/assets/img/posts/blog/frontend-third-party-script-isolation-loading-strategy/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점 (요약)

- 우선 진단이 가장 중요합니다. Lighthouse, DevTools Network/Performance, PerformanceObserver로 문제의 근원을 찾아야 합니다.
- 로드 전략은 순차적으로 적용하는 게 현실적입니다: 비차단 로드( async/defer ) → 지연 로드( after-interactive / idle / intersection ) → 격리( iframe / sandbox ) → 기능 분리( web worker 등).
- 모든 서드파티 스크립트를 iframe에 넣을 수는 없고, 우선순위를 정해 단계적으로 처리해야 합니다.
- 사용자 세그먼트(신규/재방문자, 느린 네트워크 등)에 따라 가변적으로 로드하는 것이 도움이 됩니다.

단계별 격리 및 로드 전략 (실무용 포인트 중심)

1. 진단: 무엇이 문제인지 측정

- Lighthouse에서 LCP, FID(또는 INP), CLS 점수 확인
- Chrome DevTools → Performance 레코딩으로 'Long Tasks'와 스크립트 실행 시간을 확인
- Network 탭에서 서드파티 도메인 요청과 연결(TTFB, latency) 확인
- PerformanceObserver API로 실제 사용자 데이터(RUM) 수집 (예: longtask, first-input)

간단한 PerformanceObserver 예:

```js
if ("PerformanceObserver" in window) {
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      console.log("Long task", entry);
    }
  });
  obs.observe({ entryTypes: ["longtask"] });
}
```

2. 비차단 로드 적용: async / defer

- 의존성이 없는 서드파티 스크립트는 async로 로드해 DOM 파싱을 막지 않게 합니다.
- DOM 조작이나 순서가 중요한 스크립트는 defer로 사용해 파싱 후 순서 보장.
  예:

```html
<script src="https://cdn.example.com/lib.js" async></script>
<script src="/local-script-that-needs-lib.js" defer></script>
```

주의: 일부 태그가 문서 쓰기(document.write)를 사용하는 경우 async/defer가 적용되지 않을 수 있습니다.

3. 사용자 인터랙션 이후나 Idle 타이밍에 로드

- 페이지 로드 초기에 꼭 필요하지 않은 스크립트는 이후에 로드합니다.
- requestIdleCallback이 지원되면 사용하고, 폴리필로 대체 가능.
- 사용자가 특정 요소와 상호작용할 때 로드하는 패턴(예: 채팅 버튼 클릭 시 위젯 로드).
  예:

```js
function loadThirdParty(src) {
  const s = document.createElement("script");
  s.src = src;
  s.async = true;
  document.body.appendChild(s);
}

if ("requestIdleCallback" in window) {
  requestIdleCallback(() => loadThirdParty("https://third.party/sdk.js"));
} else {
  setTimeout(() => loadThirdParty("https://third.party/sdk.js"), 2000);
}
```

또는 화면에 보일 때 로드:

```js
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) {
      loadThirdParty("https://widget.example.com/widget.js");
      io.disconnect();
    }
  });
});
io.observe(document.querySelector("#widget-anchor"));
```

4. 격리: iframe으로 완전 분리

- 레이아웃/스타일/JS 충돌을 피하려면 iframe 격리가 가장 확실합니다.
- sandbox 속성으로 권한을 제한하고, postMessage로 통신합니다.
- 단점: SEO/접근성 영향, 추가적인 네트워크/렌더 비용.
  간단한 예:

```html
<iframe
  src="https://third.example.com/isolated-widget"
  sandbox="allow-scripts allow-same-origin"
  width="100%"
  height="300"
  loading="lazy"
>
</iframe>
```

참고: loading="lazy"는 iframe도 지연 로드할 수 있게 도움됩니다.

5. 리소스 힌트와 우선순위 조정

- preconnect/dns-prefetch는 첫 연결 비용을 줄여주지만 과도 사용은 금물.
- preload는 critical 리소스에만 사용. 서드파티 스크립트를 preload하면 우선순위가 올라가므로 주의.
  예:

```html
<link rel="preconnect" href="https://analytics.example.com" />
<link rel="dns-prefetch" href="//ads.example.net" />
```

6. 안전과 안정성: CSP, SRI, 시간 제한

- 콘텐츠 보안 정책(CSP)로 외부 스크립트 출처를 제한하고 모니터링 가능.
- SRI(Subresource Integrity)는 외부 스크립트 무결성을 검증하지만, 자주 변경되는 서드파티에는 적용이 불편할 수 있음.
- 타임아웃/페일오버 로직을 넣어 서드파티 장애가 서비스 전체에 영향을 주지 않도록 합니다.

간단한 SRI 예:

```html
<script
  src="https://cdn.example.com/lib.js"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>
```

CSP 예(간단히):

```http
Content-Security-Policy: script-src 'self' https://trusted.cdn.example.com;
```

주의: CSP를 엄격히 하면 일부 타사 기능이 깨질 수 있으니 로그부터 확인하면서 점진 적용이 필요합니다.

측정 및 검증 방법 (실무 포인트)

- 로컬 개발 + 스테이징 환경에서 Lighthouse CI를 통과시키는 기준 만들기
- RUM(Real User Monitoring)으로 실제 사용자 디바이스/네트워크 조건에서의 영향 측정
- A/B 테스트로 변경 전후의 KPI(LCP, INP, 전환율) 비교
- 네트워크 차단(예: DevTools에서 특정 도메인 차단)으로 서드파티가 차지하는 비용을 확인
- 퍼포먼스 예산을 정하고(예: main-thread 사용 시간, JavaScript 번들 크기), CI에서 체크

실무에서는 이렇게 확인하면 좋겠다 (단계별 체크 포인트)

1. 서드파티 목록과 목적을 정리: 각 스크립트의 비즈니스적 중요도 판단
2. 각 서드파티의 로드/실행 타이밍(네트워크, 실행시간) 측정
3. 우선순위가 낮은 스크립트는 lazy/load-after-interaction으로 전환
4. 우선순위가 높은 스크립트라도 가능한 비차단 로드(async/defer)로 변경
5. 격리가 필요한 경우 iframe으로 분리하고 메시지 인터페이스 설계
6. RUM과 자동화된 Lighthouse CI로 지속적으로 모니터링

제가 실무에서 바로 활용하려고 정리한 예제 로드 시나리오

- 애널리틱스: 비치명적인 데이터 수집은 requestIdleCallback 또는 after-interaction에 로드
- 광고: 렌더링 핵심 영역 외에는 iframe으로 격리하고 lazy 로드
- 위젯(채팅 등): 사용자가 인터랙션할 때 로드(버튼 클릭, 스크롤 인지점)
- A/B 테스트 도구: 스플래시/클라이언트 렌더링에 영향 주면 서버측 실험 고려

주의할 점 (제가 아직 조심스러워하는 부분)

- 모든 사이트에 동일한 전략이 최적이라는 보장은 없습니다. 트래픽 특성, UX 우선순위에 따라 달라집니다.
- 일부 서드파티 라이브러리는 내부 구현 방식 때문에 비차단 로드 시에도 문제를 일으킬 수 있습니다.
- iframe 격리가 레이아웃/디자인 일관성에 문제를 줄 수 있으므로 UI 검증이 필요합니다.

간단한 점검 절차(핵심 명령/절차)

- Lighthouse(DevTools) 레포트 확인: 데스크톱/모바일 각각
- DevTools Network에서 도메인별 요청과 타이밍 확인: 도메인 필터링으로 서드파티만 보도록
- Performance 탭에서 long tasks, scripting 시간 확인
- RUM 데이터 수집: 웹 비콘 또는 PerformanceObserver 기반 로그 전송
- CI에서 Lighthouse CI 도입: 변경 시 자동으로 성능 회귀 감지

![iframe 격리와 메인 문서 간 postMessage 통신을 화살표로 보여주는 단순 다이어그램](/assets/img/posts/blog/frontend-third-party-script-isolation-loading-strategy/image-2.webp)
이미지 출처: AI 생성 이미지

실무 체크리스트

- [ ] 서드파티 목록과 비즈니스 목적 문서화 완료
- [ ] 각 스크립트의 로드/실행 시간 측정(Lighthouse + DevTools)
- [ ] 우선순위 낮은 스크립트에 대해 lazy 또는 after-interaction 적용
- [ ] 의존성 있는 스크립트는 defer로, 독립 스크립트는 async로 변경 검토
- [ ] 격리가 필요하면 iframe + sandbox 적용 및 postMessage 인터페이스 설계
- [ ] RUM 기반 성능 지표 수집(예: LCP, INP, long tasks)
- [ ] Lighthouse CI나 유사 도구로 성능 회귀 자동화 검사 설정
- [ ] CSP/SRI 적용 가능성 검토(변경 시 영향 테스트)
- [ ] 변경 전/후 A/B 테스팅 또는 로그 기반 KPI 비교

마무리하며
아직 배우는 입장에서 적은 글이라 완전한 정답을 제시할 수는 없습니다. 다만 문제 진단 → 우선순위 결정 → 점진적 적용 → 측정의 사이클을 꾸준히 돌리는 것이 효과적이라는 점은 여러 소스에서 반복적으로 확인할 수 있었습니다. 작은 변경부터 적용해보고, RUM과 자동화된 검사로 회귀를 잡아가면 현실적으로 개선할 가능성이 크다고 느낍니다. 혹시 더 구체적인 사례(광고, 분석, 위젯 등) 중 하나를 같이 깊게 보길 원하시면 그 주제로 다음 글을 준비해보겠습니다.
