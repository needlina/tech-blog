---
title: "Vue 트랜지션 애니메이션 렌더 성능 점검 체크리스트"
description: "Vue 트랜지션과 애니메이션이 렌더 성능을 떨어뜨릴 때 점검할 핵심 원인, DevTools 재현 절차, CSS·JS 실패 예시와 수정 예시, 자동화 검증 및 실무 적용 확인 경로와 명령"
slug: "vue-transition-animation-performance-triage"
date: 2026-08-07 12:00:00 +0900
categories: ["Frontend", "Vue.js"]
tags: ["vue", "animation", "performance", "성능튜닝", "렌더링"]
image:
  path: /assets/img/posts/blog/vue-transition-animation-performance-triage/preview.png
  alt: "Vue 애니메이션 성능 체크리스트 썸네일"
---

만족. **애니메이션이 프레임 드랍을 만들 때 가장 먼저 확인할 것**: 사용한 CSS 속성이 레이아웃·페인트를 유발하는지, JavaScript가 애니메이션 루프에서 강제 레이아웃을 발생시키는지, 그리고 DevTools의 Performance 타임라인에서 Main 스레드 작업(>16ms)과 Paint/Composite 비용이 높은지부터 살펴보면 빠르게 원인을 좁힐 수 있습니다.

서두에 감정 한 문장과 핵심 요약을 먼저 적었고, 이제 실제 점검과 재현 절차, 실패 예시와 수정 예시, 실무 체크 포인트 순으로 차근차근 정리해보겠습니다.

## 문제 상황(구체적 증상 예시)
- 로컬은 부드러운데 실제 기기에서 리스트 항목을 추가/삭제하거나 드래그할 때 한두 프레임씩 끊김이 발생한다.
- transition-group으로 요소를 애니메이션할 때 전체 레이아웃이 깜박이거나 스크롤이 뚝 끊긴다.
- 모바일에서 opacity는 괜찮은데 transform 기반 애니메이션에서도 재배치 시 성능이 안 좋다.

이런 증상을 만났다면 다음 항목들을 우선 확인하세요.

## 빠른 재현·검증 명령과 환경 정보(예시)
- 개발 환경: Node.js 18.16.0, npm 9.4.0, Vue 3.2.x (실제 프로젝트의 런타임 버전은 package.json으로 확인)
- 로컬 실행: npm install && npm run dev (Vite 기준: 포트 5173)
- 빌드/배포 확인: npm run build && serve -s dist (serve 설치가 필요하면 npm i -g serve)
- Chrome 버전: 100+ 권장. DevTools Performance 탭 사용.

재현 절차(간단):
1. F12로 DevTools 열기 → Performance 탭 선택.
2. Record(녹화) 클릭 후 애니메이션 트리거(예: 항목 추가/삭제) → 녹화 중지.
3. Summary에서 FPS, Main thread long tasks, Rendering→Paint Call 수 확인.
4. Rendering 패널에서 Paint flashing, Layer borders 켜서 어느 요소가 repaint/recalc style을 유발하는지 확인.

(이미지)
![Performance 타임라인 예시 이미지](/assets/img/posts/blog/vue-transition-animation-performance-triage/image-1.webp)
이미지 출처: AI 생성 이미지

## 성능 저하의 주요 원인과 확인 포인트
1. 레이아웃/리플로우 유발 CSS 사용
   - 문제: width, height, margin, top/left 같은 속성 변경은 레이아웃 재계산(reflow)을 유발.
   - 확인: DevTools Performance에서 "Layout" 이벤트가 많거나 Main에서 스타일/레이아웃 작업이 자주 보이면 의심.
2. 잦은 페인트(Paint) 발생
   - 문제: background, border, box-shadow 등 페인트 비용이 큰 속성.
   - 확인: Rendering → Paint flashing으로 깜빡이는 요소 관찰.
3. 레이어 과다 생성 또는 너무 적음
   - 문제: will-change 남발로 레이어가 과다 생성되면 GPU 메모리·스레드 경쟁 발생.
   - 확인: Layers 패널에서 레이어 수 확인(수치가 갑자기 늘어나는 부분 확인).
4. JS 애니메이션에서 강제 동기화(Forced Reflow)
   - 문제: offsetWidth/offsetHeight, getBoundingClientRect 호출이 애니메이션 루프 안에 있으면 매프레임 레이아웃 계산을 강제.
   - 확인: 코드 검토로 DOM 읽기(read)와 쓰기(write)를 섞어 사용하는지 확인. Performance의 Main 스택에서 Layout 관련 함수 호출 빈도 확인.
5. 큰 DOM 노드/비효율적인 재렌더링
   - 문제: transition-group으로 인해 전체 리스트가 재정렬될 때 DOM 업데이트가 광범위하게 발생.
   - 확인: Vue DevTools와 Performance 타임라인으로 어떤 컴포넌트가 업데이트되는지 추적.

## 실패 예시와 수정 예시(코드)
아래는 흔한 실패 예시와 고친 예시를 나란히 둡니다.

실패 예시 (CSS로 top/left 사용)
```css
.card {
  transition: top 300ms ease, left 300ms ease;
  position: relative;
}
```

수정 예시 (transform 사용)
```css
.card {
  transition: transform 300ms ease;
  /* 이동 시 transform: translate(x, y) 사용 */
}
```

JS에서 강제 레이아웃을 발생시키는 실패 예
```js
function animate(el, dx, dy) {
  // 매 프레임마다 offsetWidth를 읽어서 강제 레이아웃 발생
  const w = el.offsetWidth;
  el.style.left = (parseInt(el.style.left || 0) + dx) + 'px';
}
```

수정 예 (requestAnimationFrame + transform)
```js
let rafId;
function animateRaf(el, tx, ty) {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    el.style.transform = `translate(${tx}px, ${ty}px)`;
  });
}
```

**검증 방법**: 변경 전/후에 DevTools Performance에서 녹화하여 Main 스레드의 함수 실행 시간과 Paint 횟수가 줄었는지 비교하세요. 프레임 예산은 16ms 이므로 개별 프레임에서 Main 작업이 16ms를 초과하면 프레임 드랍이 발생할 가능성이 큽니다.

(이미지)
![Rendering 패널의 paint flashing 예시](/assets/img/posts/blog/vue-transition-animation-performance-triage/image-2.webp)
이미지 출처: AI 생성 이미지

## 우선적으로 시도할 완화 방법(권장 순서)
- 1단계: 애니메이션 대상 속성 확인 — 가능한 한 transform과 opacity만 사용.
- 2단계: requestAnimationFrame으로 JS 애니메이션 이관. setTimeout/setInterval 피하기.
- 3단계: transition-group 사용 시 key와 FLIP 기법 적용으로 최소 DOM 변경만 발생하도록 개선.
- 4단계: will-change는 필요한 요소에만, 짧은 시간만 적용. 예: will-change: transform.
- 5단계: 가상화(virtualized list) 적용 — 수백~수천 항목 렌더링 환경에서 우선 시도.
- 6단계: 레이어 관리 — Layers 패널로 레이어 스냅샷을 보고 불필요한 레이어를 제거.

아래 표는 속성별 성능 특성과 사용 지침을 간단히 정리합니다.

| 속성 | 비용 | 언제 사용 |
|---|---:|---|
| transform | 낮음 (composite 전용) | 이동·회전·스케일에 우선 사용 |
| opacity | 낮음 (composite 전용) | 투명도 애니메이션에 사용 |
| top/left/right/bottom | 높음 (layout) | 피하거나 필요 시 transition 끝부분에서만 |
| width/height | 높음 (layout + paint) | 레이아웃 변화가 불가피할 때만 |
| box-shadow | 중간~높음 (paint) | 사용 최소화 |

## DevTools로 단계별 재현·검증 체크리스트
1. 로컬 빌드 및 실행
   - npm ci && npm run dev (개발 서버), npm run build (프로덕션 빌드 비교)
2. Chrome DevTools Performance 녹화
   - 레코드 전 Rendering → Enable paint flashing 체크
   - 녹화: 녹화 시작 → 애니메이션 트리거 → 녹화 중지
   - 확인 포인트: FPS 평균, Long Tasks(>50ms), Layout/Style Recalc 비율
3. Rendering과 Layers 확인
   - Rendering 패널의 Paint flashing/Layer borders 사용
   - Layers 탭에서 레이어 수와 GPU 메모리 사용 패턴 확인
4. JS 측정
   - Performance의 "Main"에서 함수 콜스택 확인 → offsetWidth 등 DOM 읽기/쓰기가 많은지 확인
5. 모바일 실기기 테스트
   - 에뮬레이터 수치와 실제 기기(중저가 CPU 포함)에서 비교. 목표: 60fps에 가까운 체감인지 확인

검증 기준 예시: 애니메이션 실행 시 Main thread의 평균 처리 시간이 8ms 이하, 최대 작업이 16ms 이하이면 안정적으로 보통 부드럽다고 판단할 수 있습니다. FPS가 지속적으로 50 이하라면 추가 최적화 고려.

## 실무 적용 시 점검 포인트
- CI에서 Lighthouse CI로 성능 회귀 검증: 예시 명령
  - npx @lhci/cli autorun --collect.url=http://localhost:4173
- PR 템플릿에 성능 체크 항목 추가: animation·transition 변경 시 Performance 녹화 스크린샷 첨부 요구
- 브라우저 호환성: 일부 모바일 브라우저는 compositing 동작이 다르므로 대상 기기 목록에 대한 수동 검증 필요
- 메모리·레이어 경계: will-change 남발로 인한 OOM 이슈는 프로파일로 확인

## 언제 어떤 방법을 먼저 확인해야 하는지와 대안 선택 기준
- 무엇을 먼저 확인할지: 애니메이션으로 인한 문제라면 **CSS 속성(특히 top/left/width/height 사용 여부), JS에서의 DOM 읽기/쓰기 패턴, DevTools Performance 타임라인의 Main 작업 분포**를 차례로 확인하세요. 이 세 가지만으로도 원인의 상당 부분을 좁힐 수 있습니다.
- 언제 다른 선택지가 나은지:
  - 애니메이션 대상이 레이아웃 자체(예: 그리드의 재배치)라면 transform으로의 단순 전환만으로 해결 안 될 수 있습니다. 이때는 FLIP 기법이나 레이아웃 애니메이션 전용 로직(virtualize, placeholder 사용)을 고려하세요.
  - will-change는 즉시 성능 개선을 줄 수 있지만 장기 적용 시 GPU 메모리와 레이어 수 증가로 역효과가 날 수 있으니 단기간 적용·측정 후 제거하는 방식이 낫습니다.

마지막으로 몇 가지 검증 명령과 확인 경로를 다시 정리합니다.
- 로컬 실행: npm install && npm run dev
- 프로덕션 빌드 테스트: npm run build && serve -s dist
- DevTools 재현: F12 → Performance → Record 후 애니메이션 트리거
- Lighthouse CI 자동화: npx @lhci/cli autorun --collect.url=http://localhost:5173

여기까지 점검해보고도 원인이 애매하면, DevTools Performance 녹화 파일(.json) 또는 스크린샷을 기준으로 어떤 단계에서 Layout/Style/ Paint가 많은지 함께 살펴볼 수 있습니다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

## 함께 보면 좋은 글

- [Vue 폼 접근성과 서버 유효성 검증 통합 체크리스트](/posts/vue-form-accessibility-server-validation-checklist/)
- [Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드](/posts/vue3-reusable-accessible-form-field-guide/)
- [Oracle HINT 사용 전 점검과 실무 대응 체크리스트](/posts/oracle-hints-usage-checklist-risks/)
