---
title: "대용량 SPA 목록에서 가상화(virtualization)로 스크롤 성능과 키보드 접근성 개선하기"
description: "대용량 SPA 목록에 virtualization 도입 시 스크롤 성능 저하 원인, 키보드 접근성 문제 진단 포인트, 라이브러리 선택 기준과 실무 점검 절차, 코드 예시와 디버깅 방법 제공"
slug: "spa-list-virtualization-scroll-accessibility"
date: 2026-07-18 10:00:00 +0900
categories: ["Frontend", "Performance"]
tags: ["virtualization", "react", "performance", "접근성", "키보드내비게이션"]
image:
  path: /assets/img/posts/blog/spa-list-virtualization-scroll-accessibility/preview.png
  alt: "리스트 가상화 최적화 썸네일"
---

대용량 SPA 목록에서 virtualization을 쓰면 렌더링 성능은 크게 좋아지지만, 스크롤 버벅임(주로 레이아웃/재계산)과 키보드 접근성(포커스 관리, 스크롤 보정) 같은 새로운 문제가 생기는 경우가 많습니다. 이 글에서는 **실무에서 빠르게 확인해야 할 포인트**와 함께 코드 예시, 라이브러리 비교, 디버깅 방법을 제가 공부하면서 정리한 순서대로 풀어봅니다.

왜 이걸 정리하냐면, 처음에는 라이브러리 문서만 보고 바로 적용했더니 화면은 빨라졌는데 키보드로 항목을 이동할 때 포커스가 엉키거나 스크롤 위치가 튀는 문제가 생겨서 의외로 골치가 아팠거든요. 그래서 같은 문제를 겪는 분들이 바로 확인할 수 있게 핵심만 모아봤습니다.

목차

- 가상화(virtualization)와 생기는 주요 증상
- 처음에 헷갈렸던 부분들
- 실무에서 꼭 확인할 체크포인트
- 간단한 코드 예시 (react-window 중심)
- 라이브러리 비교 표
- 자주 묻는 질문(FAQ)
- 실무 체크리스트

![가상화 개념을 단순히 보여주는 일러스트](/assets/img/posts/blog/spa-list-virtualization-scroll-accessibility/image-1.webp)
이미지 출처: AI 생성 이미지

가상화와 생기는 주요 증상

- virtualization은 DOM 노드 수를 줄여 렌더링 비용을 낮추지만, 스크롤 위치와 DOM 재사용에 따른 레이아웃 재계산, 포커스 이동 시 스크롤 처리 로직이 복잡해집니다.
- 실무에서 자주 보이는 문제: 스크롤 지연(프레임 드랍), 키보드 포커스가 시야에서 사라짐, 스크롤 앵커(anchor) 위치가 틀어짐, 화면 리더와의 상호작용이 부자연스러움.

공부하면서 알게 된 점

- 가상화가 느려지는 주된 원인은 JavaScript에서 계산이 무거워서가 아니라 **레이아웃(브라우저 리플로우)**이 자주 발생해서라는 점이었습니다. 즉, 렌더링할 노드를 줄여도 레이아웃 트리 변동이 잦으면 프레임 드랍이 발생합니다.
- 키보드로 아이템 이동 시 포커스를 DOM에서 제거했다가 재사용하는 방식으로 처리하면, 브라우저가 예상치 못한 스크롤 보정을 하면서 화면이 튈 수 있습니다.
- 화면 리더(스크린리더)는 가상화로 인해 실제 DOM에 존재하지 않는 항목을 인식하지 못할 수 있으므로 **대체 텍스트/ARIA 상태를 잘 관리**해야 합니다.

처음에는 헷갈렸던 부분

- "overscan을 많이 주면 성능이 저하되지 않나?" — overscan은 스크롤을 좀 더 매끄럽게 하려는 타협점이라 상황에 따라 장단점이 있습니다. 리스트 항목의 렌더 비용이 작고 메모리 여유가 있으면 overscan을 늘려 사용자 체감을 개선할 수 있습니다.
- "variable height(가변 높이)를 꼭 지원해야 할까?" — 항목 높이가 같다면 fixed-size 가 훨씬 단순하고 빠릅니다. 가변 높이는 복잡도와 비용이 늘어나므로 진짜 필요할 때만 선택하는 편이 낫습니다.
- "스크린리더 지원은 라이브러리 몫인가?" — 일부 라이브러리는 기본적인 ARIA를 제공하지만, 화면 리더 호환성은 앱의 구조와 콘텐츠에 따라 달라집니다. 개발자가 직접 확인하고 보완해야 할 경우가 많습니다.

실무에서 꼭 확인할 체크포인트

- 퍼포먼스 측정
  - Chrome Performance 탭에서 스크롤 시 프레임 타임(프레임당 ms)을 관찰
  - Layers 패널로 레이어가 자주 재생성되는지 확인
  - 렌더 스레드가 아닌 메인 스레드에서 자바스크립트 작업이 너무 긴지 확인
- 레이아웃/스타일
  - CSS 속성 중 will-change, transform을 적절히 사용해 레이아웃 쓰레싱을 줄일 수 있는지 검토
  - 이미지, 폰트 로딩이 스크롤 시 레이아웃 변화를 유발하지 않는지 확인
- 가상화 설정
  - fixed vs variable item height 결정
  - overscan 설정: 사용자 체감/메모리 비용 간 트레이드오프 테스트
  - key 지정: 항목 고유 키(itemKey)를 꼭 제공해 DOM 재사용을 예측 가능하게 함
- 키보드 접근성
  - 포커스 이동 시 scrollIntoView나 라이브러리 제공 API를 사용해 시야에 들어오도록 처리
  - 포커스가 DOM 재사용으로 사라지지 않도록, 가능하면 포커스용 요소를 별도로 두거나 aria-activedescendant 패턴 사용 고려
  - tabindex 관리(0, -1)로 키보드 포커스 흐름을 제어
- 접근성 / 스크린리더
  - 가상화로 DOM에 없는 항목은 스크린리더에 보이지 않을 수 있으니 역할(role), aria-setsize, aria-posinset와 같은 속성으로 위치 정보를 보완
  - 화면리더에서 리스트 탐색(SR virtual buffer)로 테스트

간단한 코드 예시 (react-window 사용, 키보드 포커스 보정 포함)

- react-window 설치

```
npm install react-window
```

- 리스트 기본 구조(간단 예시). 아래 코드는 JSX에 중괄호가 들어 있어 Jekyll/Liquid 충돌을 막기 위해 {% raw %} 로 감쌌습니다.

{% raw %}

```jsx
import { FixedSizeList as List } from "react-window";
import { useRef } from "react";

function VirtualList({ items, height = 600, itemHeight = 50 }) {
  const listRef = useRef(null);

  // 키보드로 포커스가 이동할 때 호출
  function onFocusItem(index) {
    if (listRef.current) {
      // react-window API: scrollToItem
      listRef.current.scrollToItem(index, "smart");
    }
  }

  function Row({ index, style }) {
    const item = items[index];
    return (
      <div
        className="list-item"
        tabIndex={0}
        style={style}
        onFocus={() => onFocusItem(index)}
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={items.length}
      >
        {item.title}
      </div>
    );
  }

  return (
    <List
      height={height}
      itemCount={items.length}
      itemSize={itemHeight}
      ref={listRef}
      overscanCount={3}
      role="list"
    >
      {Row}
    </List>
  );
}
```

{% endraw %}

포커스 이동 보정 예 (간단)

```js
// 포커스된 요소가 화면에 보이지 않으면 보이도록 함
function ensureVisible(el) {
  if (!el) return;
  // 브라우저 기본 scrollIntoView 옵션 사용 (부드럽게)
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
}
```

라이브러리 비교 (간단)
| 라이브러리 | 번들 크기 | 가변 높이 | API 난이도 | 권장 상황 |
|---:|:---:|:---:|:---:|:---|
| react-window | 작음 | 제한적(추가 구현 필요) | 쉬움 | 고정 높이, 성능 중요 시 |
| react-virtualized | 큼 | 지원 | 보통 | 다양한 기능, 레거시 지원 필요할 때 |
| react-virtual | 작음 | 지원 | 쉬움 | 최신 API, 유연성 원할 때 |

![키보드 포커스와 스크롤 보정을 설명하는 단순 일러스트](/assets/img/posts/blog/spa-list-virtualization-scroll-accessibility/image-2.webp)
이미지 출처: AI 생성 이미지

실무 체크: 스크롤 튐/지연 디버깅 절차

1. Chrome Performance로 스크롤 녹화(약 5~10초). Long task, Layout, Recalculate Style 빈도 확인.
2. 레이아웃 원인 찾기: 특정 CSS(예: width: auto로 인해 리플로우가 자주 발생) 또는 JS에서 element.getBoundingClientRect 호출 여부 점검.
3. Overscan 조정으로 체감 테스트: 0 / 3 / 10 같은 값으로 비교.
4. 키보드 이동 시 scrollIntoView 호출과 브라우저 기본 보정 충돌 확인. (중복 호출을 피함)
5. 스크린리더 테스트(VoiceOver/NVDA/JAWS)로 읽힘 확인.

공부하면서 적용해본 간단 팁

- 포커스 대상은 가능한 한 항목 전체가 아닌 내부의 버튼/링크처럼 포커스 요소를 따로 두는 편이 예측 가능했습니다.
- 키보드에서 ArrowUp/Down으로만 이동하는 경우, aria-activedescendant 패턴을 쓰면 DOM 재사용과 독립적으로 상태를 관리하기 좋았습니다.
- variable-height가 꼭 필요하지 않다면 fixed-size로 단순화하는 편이 빠르고 안정적입니다.

자주 묻는 질문
Q: virtualization을 언제 사용하면 좋을까요?
A: 리스트가 수백~수천 항목이고, 한 번에 렌더되는 DOM 노드 수가 성능 문제를 일으킬 때 고려하세요. 단순 목록(고정 높이, 단일 컬럼)이라면 도입 이득이 큽니다.

Q: variable height를 써야 할지 어떻게 결정하나요?
A: 항목 높이가 천차만별이고 레이아웃이 내용에 따라 달라져야 한다면 필요합니다. 가능하면 고정 높이로 디자인을 조정해 단순화하세요.

Q: 키보드 포커스가 튈 때 우선 확인할 것들?
A: 포커스 이동 시 scrollIntoView 중복 호출, 라이브러리의 scrollToItem API 사용 방식, item key 재사용으로 인한 포커스요소 교체 여부를 점검하세요.

Q: 스크린리더에서 리스트 항목이 보이지 않아요. 해결책은?
A: aria-setsize, aria-posinset로 목록 크기와 위치를 보완하고, 중요한 항목은 가상화 예외(예: 최근 항목)로 렌더링하는 방법도 생각해보세요.

Q: react-window와 react-virtualized 중 어떤 걸 추천하나요?
A: **간단하고 경량**을 원하면 react-window, **다양한 기능**(셀 렌더링, 테이블 등)이 필요하면 react-virtualized를 고려하세요. 다만 커뮤니티와 유지보수 상태도 확인하세요.

Q: overscan 값을 너무 크게 잡으면 어떤 문제가 있나요?
A: 메모리 사용과 렌더 시간 증가로 초기 스크롤 성능 저하가 발생할 수 있습니다. 적절한 균형을 찾아야 합니다.

실무 체크리스트

- [ ] Performance 프로파일링: Chrome Performance로 스크롤 상황 녹화하기
- [ ] Layout 원인 파악: Recalculate Style / Layout 빈도 체크
- [ ] 라이브러리 설정: fixed vs variable 결정, overscan 테스트
- [ ] key 관리: itemKey 제공으로 DOM 재사용 예측성 확보
- [ ] 포커스 흐름: tabindex, aria-activedescendant, scrollIntoView 호출 중복 방지
- [ ] 스크린리더 테스트: aria-setsize/posinset 보완 및 실제 리더 테스트
- [ ] E2E/통합 테스트: 키보드 네비게이션 시나리오 자동화(예: Cypress, Playwright)
- [ ] 모니터링: 실제 사용자 환경에서의 FPS/Long task 알림(필요 시 RUM 도입)

virtualization은 성능 문제를 해결하는 강력한 도구지만, 그로 인해 생기는 포커스·스크롤·접근성 문제들을 놓치면 사용성에 악영향을 줄 수 있습니다. 저는 실무에서 먼저 프로파일링으로 병목 원인을 확인하고, fixed-height로 단순화할 수 없을 때에만 variable-height로 복잡도를 늘리는 방식으로 접근하려 합니다.
