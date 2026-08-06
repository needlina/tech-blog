---
title: "React Portal 접근성 포커스 관리 체크리스트"
description: "모달 팝업이나 포털로 렌더된 UI에서 키보드 포커스 초기화 이동 복원과 스크린리더 무시 처리 방법, 테스트 명령과 확인 경로, 코드 예시와 실패 사례 대비 수정 예제 포함"
slug: "react-portal-accessibility-focus-checklist"
date: 2026-08-06 10:00:00 +0900
categories: ["Frontend", "React"]
tags: ["react", "accessibility", "focus-management", "접근성", "프론트엔드"]
image:
  path: /assets/img/posts/blog/react-portal-accessibility-focus-checklist/preview.png
  alt: "React Portal 실무 가이드 썸네일"
---

React Portal로 렌더된 모달이나 팝오버는 **포커스 초기 위치**, **포커스 트랩(한정된 포커스 루프)**, **포커스 복원**, 그리고 배경 콘텐츠를 스크린리더에서 숨기는 **aria-hidden 처리**를 반드시 확인해야 합니다.

이 글은 실제로 확인할 포인트와 재현, 실패 예시와 수정 예시, 자동/수동 테스트 명령을 모아 초보가 실무에서 바로 점검할 수 있게 정리한 체크리스트입니다. React 버전은 17/18 기준으로 설명하고, 확인 절차는 로컬 개발서버(예: http://localhost:3000)에서 실행 가능한 명령과 테스트 스크립트 예를 함께 제공합니다.

## 문제 상황과 재현 예시

현장에서 자주 헷갈리는 증상

- 키보드로 Tab을 눌러도 포커스가 모달 안으로 들어오지 않음
- 모달을 닫아도 포커스가 원래 위치로 돌아가지 않음(포커스 손실)
- 뒤쪽에 있는 버튼들이 스크린리더에서 계속 읽히는 현상
- 포커스가 모달 외부 요소로 빠져나가 사용자가 키보드로 닫기나 조작을 못함

간단한 재현 절차(로컬)

1. React 앱을 생성하고 모달 컴포넌트에 Portal 사용
   - Node 16+, React 17 또는 18 권장
   - 로컬 서버: npm start → http://localhost:3000
2. 키보드만으로 모달 열기(예: Enter), Tab 순회 관찰
3. 스크린리더 또는 자동 점검 툴로 aria 관련 상태 확인

공식 문서 확인 경로

- React Portals: https://reactjs.org/docs/portals.html
- WAI ARIA dialog pattern: https://www.w3.org/TR/wai-aria-practices-1.2/#dialog_modal
- MDN aria-hidden: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-hidden

## 핵심 원리 요약(짧게)

- 포털은 DOM 트리상 외부에 렌더링되지만, 시맨틱·접근성은 애플리케이션 레이어에서 관리해야 함.
- **포커스 트랩**은 모달이 열린 동안 Tab 순회가 모달 내부에 머물도록 만드는 것.
- **포커스 복원**은 모달을 닫을 때 사용자가 있던 논리적 위치로 포커스를 돌려주는 것.
- **aria-hidden**으로 모달 외 요소를 스크린리더에서 숨기면 읽기 충돌을 줄일 수 있음.

## 실패 예시와 수정 예시 (코드)

아래 예시는 나쁜 예시와 고친 예시를 함께 보여줍니다.

나쁜 예시: 포커스 관리 없음, aria-hidden 누락

```jsx
// BadModal.jsx
import React from "react";
import { createPortal } from "react-dom";

export default function BadModal({ open, onClose }) {
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true">
        <h2>타이틀</h2>
        <button onClick={onClose}>닫기</button>
        <button>다른 동작</button>
      </div>
    </div>,
    document.body
  );
}
```

문제: 포커스 초기화, 트랩, 복원 없음. 배경 요소는 aria-hidden 처리되지 않아 스크린리더에 노출될 수 있음.

수정 예시 1: 수동 포커스 관리와 aria-hidden 토글

```jsx
// ManagedModal.jsx
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export default function ManagedModal({ open, onClose }) {
  const modalRef = useRef(null);
  const lastFocusedRef = useRef(null);

  useEffect(() => {
    const appRoot = document.getElementById("root");
    if (open) {
      lastFocusedRef.current = document.activeElement;
      // 배경 숨기기
      if (appRoot) appRoot.setAttribute("aria-hidden", "true");
      // 포커스 초기화
      modalRef.current
        ?.querySelector(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
        )
        ?.focus();
      // 키보드 닫기
      const onKey = (e) => {
        if (e.key === "Escape") onClose();
      };
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("keydown", onKey);
      };
    } else {
      if (appRoot) appRoot.removeAttribute("aria-hidden");
      // 포커스 복원
      lastFocusedRef.current?.focus?.();
    }
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" ref={modalRef}>
        <h2>타이틀</h2>
        <button onClick={onClose}>닫기</button>
        <button>다른 동작</button>
      </div>
    </div>,
    document.body
  );
}
```

수정 예시 2: 라이브러리 사용 (focus-trap-react)

```jsx
// TrappedModal.jsx
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import FocusTrap from "focus-trap-react";

export default function TrappedModal({ open, onClose }) {
  const lastFocusedRef = useRef(null);
  useEffect(() => {
    const appRoot = document.getElementById("root");
    if (open) {
      lastFocusedRef.current = document.activeElement;
      if (appRoot) appRoot.setAttribute("aria-hidden", "true");
    } else {
      if (appRoot) appRoot.removeAttribute("aria-hidden");
      lastFocusedRef.current?.focus?.();
    }
  }, [open]);

  if (!open) return null;
  return createPortal(
    <FocusTrap>
      <div className="modal-backdrop">
        <div className="modal" role="dialog" aria-modal="true">
          <h2>타이틀</h2>
          <button onClick={onClose}>닫기</button>
          <button>다른 동작</button>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
}
```

설명

- 수동 방식은 DOM 조작(aria-hidden 토글, focus 복원)을 직접 하므로 조건 분기와 예외 처리가 늘어남.
- focus-trap-react 같은 검증된 라이브러리는 Tab 순환, Shift+Tab, 포커스 초기화, 가끔 포커스 복원까지 제공해 구현 실수를 줄이는 장점이 있음.

## 실무 확인 포인트(체크리스트 형태)

- 포커스 초기화
  - 확인 방법: 모달이 열린 직후 document.activeElement가 모달 내의 적절한 컨트롤인지 확인
  - 테스트 명령/코드: @testing-library/react로
    ```js
    // modal.test.jsx
    render(<App />);
    userEvent.click(screen.getByText("모달 열기"));
    expect(document.activeElement).toBe(screen.getByText("닫기"));
    ```
- 포커스 트랩
  - 확인 방법: Tab을 계속 눌러도 모달 외부로 포커스가 나가는지 확인
  - 자동 도구: npx pa11y http://localhost:3000/modal-path, npx lighthouse http://localhost:3000 --output=json --output-path=lighthouse.json
- 포커스 복원
  - 확인 방법: 모달을 닫은 뒤 포커스가 원래 엘리먼트(예: 모달을 연 버튼)로 돌아오는지 확인
  - 테스트 코드: 마지막 활성 엘리먼트 저장 후 복원 assert
- 스크린리더 노출
  - 확인 방법: modal이 열린 상태에서 background(root 등)에 aria-hidden="true"가 적용되는지 확인
  - 수동: 브라우저 개발자 도구에서 해당 속성 존재 확인
- role/aria 속성
  - role="dialog" 또는 role="alertdialog", aria-modal="true" 적용 여부 확인
- ESC 동작 및 키보드 접근성
  - 확인 방법: ESC로 닫힘, Tab/Shift+Tab 정상 동작, Enter/Space로 액션 수행
- 포커스 표시(visual)
  - 확인 방법: CSS로 outline 또는 focus-visible 처리가 되어 키보드 사용자에게 포커스가 보이는지 확인

간단 점검 명령(예시)

- 개발 서버 시작: npm start
- 라이트하우스(로컬): npx lighthouse http://localhost:3000 --output=json --output-path=lh.json
- Pa11y(접근성 체크): npx pa11y http://localhost:3000/modal-case
- axe-core CLI(가능한 경우): npx @axe-core/cli http://localhost:3000 --save=axe-report.json

## 자동화 테스트 예시

Playwright로 포커스 트랩 확인 (단계형 자동화)

```js
// playwright-focus.spec.js
const { test, expect } = require("@playwright/test");

test("modal traps focus", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.click("text=모달 열기");
  // 첫 버튼에 포커스 존재
  expect(
    await page.evaluate(() => document.activeElement.textContent)
  ).toContain("닫기");
  // Tab 10번 눌러도 document.activeElement가 모달 내부인지 확인
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    const el = await page.evaluate(
      () => document.activeElement.closest(".modal") !== null
    );
    expect(el).toBe(true);
  }
});
```

테스트 팁

- 자동 테스팅 시 포커스 시맨틱이 브라우저별(Chrome/Firefox) 차이날 수 있으니 CI 환경(예: GitHub Actions)에서 최소 2 브라우저로 검증하면 안전합니다.
- Playwright/PS/CI 환경에서 화면 없이 실행하면 focus 관련 타이밍 이슈가 발생할 수 있으니 waitForSelector나 small delay(예: await page.waitForTimeout(50))로 안정화 포인트를 넣어 확인하세요.

## 방법 비교 표

| 방법 | 장점 | 단점 | 언제 선택 |
|---|---|---|---|
| 수동 포커스/aria-hidden 토글 | 의존성 없음, 세밀 제어 가능 | 구현·유지 비용 높음, 실수 발생 가능 | 단순한 프로젝트거나 커스텀 요구가 많을 때 |
| focus-trap-react 등 라이브러리 사용 | 검증된 포커스 트랩 제공, 구현 단순 | 번들 크기 증가, 커스터마이징 제약 | 표준 모달 패턴 빠르게 적용할 때 |
| 완전한 접근성 프레임워크 사용(Dialog 컴포넌트 포함) | 일관된 UX, ARIA 패턴 내장 | 러닝 커브, 라이브러리 종속 | 큰 제품, 일관된 접근성 보장이 필요할 때 |

(**중요**) aria-hidden를 루트에 설정할 때는 스크린리더가 변화를 인지하지 못하는 경우가 있어 상태 변경 직후에 포커스를 설정하거나 원하면 포커스 갱신을 강제해야 할 수 있습니다.

## 재현 가능한 오류 사례와 원인 판단

표준화된 증상별 원인 · 조치 요약

| 증상 | 가능한 원인 | 우선 조치 |
|---|---|---|
| Tab으로 모달 밖으로 포커스가 나감 | 포커스 트랩 미구현 | focus-trap-react 적용 또는 키 이벤트로 트랩 구현 |
| 모달 닫아도 스크린리더가 배경 읽음 | aria-hidden 미적용 | root에 aria-hidden="true" 토글 |
| 포커스 복원 안됨 | 마지막 포커스 요소 저장 누락 | 열기 직전 document.activeElement 저장 후 복원 |
| ESC로 닫히지 않음 | keydown 이벤트 미등록 또는 이벤트 전파 차단 | document에 keydown 리스너 추가, stopPropagation 확인 |

위 표는 실제 로그나 오류 메시지 대신 증상과 원인으로 빠르게 진단할 수 있게 만든 체크표입니다. 구현한 코드에 console.log로 document.activeElement, aria-hidden 상태, 이벤트 핸들러 등록 여부를 출력하면 원인 파악에 도움이 됩니다.

## 검증 방법 정리(Verification Score 대응)

- 수동 확인
  - 1. 모달 열기 → 개발자 도구에서 document.activeElement 확인
  - 2. 개발자 도구 Elements 탭에서 루트 엘리먼트(#root)에 aria-hidden 속성 존재 확인
  - 3. Tab/Shift+Tab로 포커스 순회 확인
  - 4. 모달 닫기 → 포커스가 모달을 연 버튼으로 돌아오는지 확인
- 자동 확인
  - Playwright 테스트(예 코드 참고)
  - npx pa11y, npx lighthouse, npx @axe-core/cli 로 보고서 생성: lighthouse.json, axe-report.json 저장
- 재현 명령
  - npm start (로컬 실행)
  - npx playwright test playwright-focus.spec.js
  - npx pa11y http://localhost:3000/modal-case

## 언제 다른 선택지가 나은가

- 모달이 단순한 알림이고 포커스 복원·트랩이 필요 없을 정도로 비대화형이면 aria-live 또는 aria-atomic으로 대체 고려 가능.
- 복잡한 포커스 요구(드래그 앤 드롭, 컨텐츠 동적 로딩)는 검증된 라이브러리 또는 접근성 전문 컴포넌트 라이브러리 사용이 더 안전.
- SPA가 아닌 서버 렌더링 환경에서는 초기 포커스 설정 타이밍을 서버-렌더링 후 클라이언트 수화 단계에서 조정해야 할 수 있음.

마지막으로, 이 주제에서 먼저 확인할 항목은 다음 두 가지입니다.

1. 모달을 연 직후 document.activeElement가 모달 내부의 적절한 컨트롤로 바뀌는지 (포커스 초기화)
2. 배경 루트에 aria-hidden="true"가 설정되어 스크린리더가 배경을 읽지 않는지

이 두 항목이 만족되면 포커스 트랩과 복원, ESC 동작을 순서대로 확인하면 된다. 모달은 작은 변경에도 회귀가 잘 생기므로, 반복해서 쓰는 컴포넌트라면 Playwright와 pa11y/lighthouse 검사를 CI에 넣어두는 편이 안정적이다.

## 함께 보면 좋은 글

- [React 상태 복원 패턴: 새로고침과 탭 종료 후 상태 유지](/posts/react-state-persistence-refresh-tab-restore/)
- [Vue 폼 접근성과 서버 유효성 검증 통합 체크리스트](/posts/vue-form-accessibility-server-validation-checklist/)
- [Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드](/posts/vue3-reusable-accessible-form-field-guide/)
