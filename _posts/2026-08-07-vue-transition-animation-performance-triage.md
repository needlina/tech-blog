---
title: "Vue 트랜지션 애니메이션 렌더 성능 점검 체크리스트"
description: "Vue transition과 transition-group에서 프레임 드랍이 생길 때 CSS 속성, 강제 레이아웃, 레이어, DevTools Performance 기록을 순서대로 확인하는 실무 체크리스트"
slug: "vue-transition-animation-performance-triage"
date: 2026-08-07 12:00:00 +0900
categories: ["Frontend", "Vue.js"]
tags: ["vue", "animation", "performance", "성능튜닝", "렌더링"]
image:
  path: /assets/img/posts/blog/vue-transition-animation-performance-triage/preview.png
  alt: "Vue 애니메이션 성능 체크리스트 썸네일"
---

Vue 애니메이션이 버벅이면 `transition` 코드보다 먼저 어떤 CSS 속성이 움직이고 있는지 확인해야 합니다.

`transition`이나 `transition-group` 자체가 느린 경우는 생각보다 적습니다. 대부분은 `top`, `left`, `width`, `height`처럼 레이아웃을 다시 계산하게 만드는 속성을 움직이거나, JavaScript에서 DOM 읽기와 쓰기를 한 프레임 안에 섞어서 강제 레이아웃을 만드는 쪽에 원인이 있었습니다.

아래 내용은 Vue 3 기준이지만, Vue 2에서도 큰 흐름은 같습니다.

## 흔한 증상

다음 증상이 보이면 애니메이션 렌더링 비용을 먼저 봅니다.

- 로컬 PC에서는 괜찮은데 모바일 기기에서 리스트 추가/삭제가 끊긴다.
- `transition-group`으로 정렬 애니메이션을 걸었더니 스크롤이 잠깐 멈춘다.
- 모달이나 드롭다운이 열릴 때 첫 프레임이 튄다.
- `opacity`만 바꿨다고 생각했는데 실제로는 주변 레이아웃까지 다시 계산된다.
- 개발 서버에서는 괜찮지만 production 화면에서 더 느리게 느껴진다.

성능 문제는 느낌만으로 고치면 다시 돌아오는 일이 많습니다. 먼저 DevTools로 녹화하고, 그다음 CSS와 JS를 줄이는 쪽이 안전합니다.

## 빠른 확인 순서

Chrome DevTools 기준입니다.

1. Performance 탭을 연다.
2. Record를 누른 뒤 문제가 되는 애니메이션을 실행한다.
3. 녹화를 멈추고 Main, Rendering, Frames 영역을 본다.
4. Rendering 패널에서 Paint flashing과 Layer borders를 켠다.
5. 같은 동작을 한 번 더 실행해 어떤 요소가 다시 칠해지는지 본다.

로컬 실행 예시는 프로젝트에 맞게 바꿔 쓰면 됩니다.

```bash
npm ci
npm run dev
```

production 빌드도 같이 봅니다.

```bash
npm run build
npx vite preview
```

Vite가 아니라 Nuxt나 별도 번들러를 쓴다면 해당 프로젝트의 preview/start 명령으로 바꾸면 됩니다.

## 원인 1. 레이아웃을 건드리는 속성을 움직인다

아래 속성은 애니메이션할 때 비용이 큽니다.

- `top`, `left`, `right`, `bottom`
- `width`, `height`
- `margin`, `padding`
- `border-width`

이 값이 바뀌면 브라우저가 주변 요소의 위치를 다시 계산할 수 있습니다. 리스트나 카드가 많을수록 비용이 커집니다.

실패 예시는 이런 형태입니다.

```css
.card {
  position: relative;
  transition:
    top 240ms ease,
    left 240ms ease;
}
```

가능하면 `transform`으로 바꿉니다.

```css
.card {
  transition: transform 240ms ease;
}

.card.is-moving {
  transform: translate3d(12px, 0, 0);
}
```

이동, 확대/축소, 회전은 `transform`이 기본 선택지입니다. 투명도 변화는 `opacity`로 처리합니다.

## 원인 2. JavaScript에서 DOM 읽기와 쓰기를 섞는다

애니메이션 중에 `offsetWidth`, `offsetHeight`, `getBoundingClientRect()`를 읽고 바로 style을 쓰면 강제 레이아웃이 생길 수 있습니다.

```js
function move(el, dx) {
  const width = el.offsetWidth;
  el.style.left = `${width + dx}px`;
}
```

이 코드는 단순해 보이지만, 반복되면 매 프레임 레이아웃 계산을 강제로 당겨올 수 있습니다. 읽기와 쓰기를 분리하고, 실제 쓰기는 `requestAnimationFrame` 안에서 처리하는 편이 낫습니다.

```js
let rafId = 0;

function move(el, x) {
  cancelAnimationFrame(rafId);

  rafId = requestAnimationFrame(() => {
    el.style.transform = `translate3d(${x}px, 0, 0)`;
  });
}
```

Vue 컴포넌트 안에서는 상태 변경이 DOM 업데이트를 유발하므로, 측정이 필요한 경우 `nextTick()` 이후에 읽는 것도 같이 봅니다.

```js
import { nextTick } from "vue";

async function measureAfterUpdate(el) {
  await nextTick();
  return el.getBoundingClientRect();
}
```

## 원인 3. transition-group에서 너무 많은 DOM이 움직인다

`transition-group`은 리스트 추가/삭제/정렬에 편하지만, 항목 수가 많으면 비용이 커집니다. 특히 key가 불안정하면 브라우저와 Vue가 재사용할 수 있는 DOM을 놓칩니다.

확인할 내용은 세 가지입니다.

- `:key`가 index가 아니라 고유 id인지
- 한 번에 바뀌는 항목 수가 너무 많지 않은지
- 실제로 움직여야 하는 요소만 transition 대상인지

나쁜 예시는 index key입니다.

```vue
<TransitionGroup name="list" tag="ul">
  <li v-for="(item, index) in items" :key="index">
    {{ item.title }}
  </li>
</TransitionGroup>
```

정렬이나 삭제가 있는 리스트에서는 고유 id를 쓰는 편이 안전합니다.

```vue
<TransitionGroup name="list" tag="ul">
  <li v-for="item in items" :key="item.id">
    {{ item.title }}
  </li>
</TransitionGroup>
```

항목이 수백 개 이상이면 애니메이션보다 가상화가 먼저일 수 있습니다. 모든 항목을 부드럽게 움직이게 만드는 것보다, 화면에 보이는 항목만 렌더링하는 쪽이 효과가 큽니다.

## CSS 속성별 기준

대략적인 기준은 아래처럼 잡으면 됩니다.

| 속성              | 비용      | 메모                                            |
| ----------------- | --------- | ----------------------------------------------- |
| `transform`       | 낮음      | 이동, 회전, 확대/축소에 우선 사용               |
| `opacity`         | 낮음      | fade in/out에 적합                              |
| `top`, `left`     | 높음      | 레이아웃 계산을 유발할 수 있어 피하는 편이 좋음 |
| `width`, `height` | 높음      | 주변 레이아웃까지 흔들 수 있음                  |
| `box-shadow`      | 중간~높음 | 큰 그림자나 blur가 많으면 paint 비용 증가       |
| `filter`          | 중간~높음 | 모바일에서 비용이 커질 수 있음                  |

`will-change`는 만능 스위치가 아닙니다. 계속 켜두면 레이어가 늘고 메모리를 더 씁니다. 애니메이션 직전에 붙이고 끝난 뒤 제거하는 방식이 더 낫습니다.

```css
.panel.is-animating {
  will-change: transform, opacity;
}
```

## DevTools에서 보는 기준

Performance 녹화 후 다음 항목을 봅니다.

- Main thread에 긴 작업이 있는지
- Layout, Recalculate Style 이벤트가 반복되는지
- Paint가 애니메이션 프레임마다 발생하는지
- Frames 영역에서 빨간 표시나 긴 프레임이 있는지
- Layers에서 레이어 수가 갑자기 늘어나는지

프레임 예산은 60fps 기준 약 16.7ms입니다. Main 작업이 매번 16ms를 넘으면 화면이 부드럽기 어렵습니다. 실무에서는 평균보다 최악의 몇 프레임이 더 중요했습니다. 사용자는 평균 FPS보다 순간적으로 끊기는 장면을 더 잘 느낍니다.

## 작업 전후 비교 방법

수정 전후를 같은 동작으로 녹화합니다.

1. 기존 코드에서 Performance 녹화
2. `top/left`를 `transform`으로 변경
3. DOM 읽기/쓰기 분리
4. 다시 같은 동작 녹화
5. Layout, Paint, Long task 수 비교

가능하면 PR에 before/after 숫자를 남깁니다.

```text
Before: Layout 42회, Long task 5회, 최장 프레임 48ms
After: Layout 9회, Long task 1회, 최장 프레임 19ms
```

정확한 숫자가 아니어도 됩니다. "느낌상 나아짐"보다 기록 하나가 나중에 훨씬 도움이 됩니다.

## 실무 체크리스트

- [ ] 애니메이션 대상 속성이 `transform` 또는 `opacity` 중심인지 확인
- [ ] `top`, `left`, `width`, `height`, `margin` transition 제거 또는 축소
- [ ] JS 애니메이션에서 `offsetWidth`, `getBoundingClientRect()` 반복 호출 확인
- [ ] DOM 읽기와 쓰기 분리
- [ ] `requestAnimationFrame` 사용 여부 확인
- [ ] `transition-group`의 key가 고유 id인지 확인
- [ ] 리스트 항목이 많으면 가상화 검토
- [ ] `will-change`를 상시 적용하지 않는지 확인
- [ ] 모바일 실기기에서 한 번 더 확인

CI에서 성능 회귀를 잡고 싶다면 Lighthouse CI를 붙일 수 있습니다.

```bash
npx @lhci/cli autorun --collect.url=http://localhost:4173
```

다만 애니메이션의 미세한 끊김은 Lighthouse 점수만으로 잡기 어렵습니다. transition을 바꾼 PR에는 DevTools 녹화 화면이나 간단한 before/after 메모를 남기는 쪽이 더 현실적입니다.

## 정리

Vue 애니메이션 성능 문제는 `transition` 문법보다 브라우저 렌더링 비용에서 갈리는 경우가 많습니다. 먼저 움직이는 CSS 속성을 보고, 그다음 DOM 읽기/쓰기 패턴을 보고, 마지막으로 레이어와 리스트 크기를 봅니다.

제가 보통 잡는 순서는 이렇습니다.

1. DevTools Performance로 실제 끊기는 장면을 녹화한다.
2. `top/left/width/height` transition을 찾는다.
3. `transform/opacity`로 바꿀 수 있는 부분을 먼저 바꾼다.
4. JS에서 강제 레이아웃을 만드는 코드를 찾는다.
5. `transition-group`의 key와 렌더링 범위를 줄인다.

이 순서가 좋은 이유는 간단합니다. 코드 변경량이 적고, 측정 결과가 바로 보이며, 실패해도 되돌리기 쉽습니다.

## 함께 보면 좋은 글

- [Vue 폼 접근성과 서버 유효성 검증 통합 체크리스트](/posts/vue-form-accessibility-server-validation-checklist/)
- [Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드](/posts/vue3-reusable-accessible-form-field-guide/)
- [Oracle HINT 사용 전 점검과 실무 대응 체크리스트](/posts/oracle-hints-usage-checklist-risks/)
