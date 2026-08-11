---
title: "React useRef vs useState 결정 기준"
description: "React 18 환경에서 mutable 값을 저장할 때 useRef와 useState 중 무엇을 선택할지 대상별 기준·점검명령·재현 코드·검증 방법을 정리, 렌더 영향·동시성 이슈·성능 측정 포인트 포함"
slug: "react-useref-vs-usestate-mutable-values"
date: 2026-08-11 12:00:00 +0900
categories: ["Frontend", "React"]
tags: ["react", "javascript", "state-management", "성능튜닝", "디버깅"]
image:
  path: /assets/img/posts/blog/react-useref-vs-usestate-mutable-values/preview.png
  alt: "useRef vs useState 썸네일"
---

useRef는 렌더를 발생시키지 않는 가변 컨테이너이고, useState는 값이 바뀌면 컴포넌트를 다시 그리는 상태 저장 수단입니다. 실무에서는 **UI 갱신이 필요한 값이면 useState, 타이머 id나 이전 값처럼 화면과 직접 연결되지 않는 값이면 useRef**를 먼저 검토하면 됩니다.

아래 예제는 React 18.2.0과 Node 18.x 환경을 기준으로 작성했습니다. 콘솔 로그와 React DevTools Profiler로 확인할 수 있는 범위만 다룹니다.

핵심 차이 요약

- **useState**: 값 변경 시 렌더 트리거 → UI에 반영해야 하는 값에 사용.
- **useRef**: 변경해도 렌더 미발생 → DOM 접근, 타이머 id, 이전 값 보관, 외부 라이브러리 참조 등에 사용.
- React 18의 StrictMode(개발모드)에서 컴포넌트가 두 번 마운트/언마운트되는 점은 useRef와 useState 모두에서 행동 차이를 만들어낼 수 있으니 검사 필요.

언제 useState를 선택해야 하는가

- UI가 바뀌어야 할 때: 입력값, 체크박스 상태, API로 받아와서 렌더되는 데이터 등.
- 렌더 사이드 이펙트가 연계될 때: 변경 후 계산 또는 useEffect에서 의존성으로 쓰일 때.
- React의 동시성 모드에서 안전하게 스케줄링해야 할 때.

실제 예 — 실패 예제: useRef로 카운트 상태를 관리하고 UI에 기대한 값이 보이지 않는 경우
파일: src/components/CounterFail.jsx

```
import React, { useRef } from 'react';

export default function CounterFail() {
  const countRef = useRef(0);

  function onClick() {
    countRef.current += 1;
    // 화면에는 반영되지 않음
  }

  return (
    <div>
      <p>Count ref: {countRef.current}</p>
      <button onClick={onClick}>Increase</button>
    </div>
  );
}
```

증상: 버튼을 클릭해도 화면의 숫자가 바뀌지 않습니다. 콘솔로 확인하면 countRef.current가 증가함이 보이지만, 렌더가 발생하지 않기 때문입니다.

수정 예: UI 갱신이 필요하면 useState를 사용
파일: src/components/CounterFix.jsx

```
import React, { useState } from 'react';

export default function CounterFix() {
  const [count, setCount] = useState(0);

  function onClick() {
    setCount(c => c + 1);
  }

  return (
    <div>
      <p>Count state: {count}</p>
      <button onClick={onClick}>Increase</button>
    </div>
  );
}
```

검증 방법:

- 개발 환경: React 18.2.0, Node 18.x, npm 9.x
- 생성 및 실행: npx create-react-app my-app && cd my-app && npm start
- 동작 확인: 브라우저에서 버튼 클릭, 숫자 증가 확인, 콘솔 로그로 setCount 호출 여부 확인

언제 useRef를 선택해야 하는가

- DOM 접근: input.focus() 같은 직접적인 DOM 조작
- 타이머 id 저장: setTimeout/clearTimeout, setInterval/clearInterval id 보관
- 이전 값(prev)을 비교하거나 외부 라이브러리 인스턴스 보관
- 렌더를 트리거하지 않고 값만 유지하고 싶을 때 (성능 목적)

타이머 예제 — 권장 패턴
파일: src/hooks/useIntervalTimer.js

```
import { useEffect, useRef } from 'react';

export default function useIntervalTimer(callback, ms) {
  const savedCb = useRef(callback);
  const idRef = useRef(null);

  useEffect(() => {
    savedCb.current = callback;
  }, [callback]);

  useEffect(() => {
    if (ms == null) return;
    idRef.current = setInterval(() => savedCb.current(), ms);
    return () => clearInterval(idRef.current);
  }, [ms]);

  return idRef;
}
```

검증 포인트:

- 개발자 도구의 Console에서 콜백이 의도한 빈도로 호출되는지 확인.
- `idRef.current`가 clearInterval로 정리되는지 확인(컴포넌트 언마운트 시).

표: 선택 기준 비교
| 기준 | useState | useRef |
|---|---|---|
| 렌더 트리거 | 예 | 아니오 |
| 값 보존(리렌더간) | 예 | 예 |
| DOM 직접참조 | 아니오 | 예 |
| 동시성 모드 민감도 | 상태 스케줄링과 일관성 보장 | 부작용 관리 필요 |
| 사용 예 | 입력값, UI 토글 | 타이머 id, 외부 인스턴스, 이전값 |

주의: useRef는 렌더를 트리거하지 않으므로 UI와 값이 분리될 수 있습니다. **UI와 항상 동기화되어야 하면 useState를 선택**하세요.

실패 사례와 고치는 예 (클로저 문제)

- 증상: setInterval 안에서 읽는 값이 초기값으로 고정되는 문제(stale closure)
- 실패 코드:

```
function TimerBad() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setInterval(() => {
      // count는 항상 0으로 참조될 수 있음
      setCount(count + 1);
    }, 1000);
  }, []);
}
```

- 원인: effect의 클로저가 초기 count를 캡처. 또한 clearInterval을 하지 않음.
- 고친 코드 (두 방법):
  방법 A — 함수형 업데이트로 클로저 문제 해결

```
useEffect(() => {
  const id = setInterval(() => {
    setCount(c => c + 1);
  }, 1000);
  return () => clearInterval(id);
}, []);
```

방법 B — useRef로 최신 콜백 보관

```
const cbRef = useRef();
useEffect(() => { cbRef.current = () => setCount(c => c + 1); });
useEffect(() => {
  const id = setInterval(() => cbRef.current(), 1000);
  return () => clearInterval(id);
}, []);
```

둘 다 재현 및 확인:

- npm start 후 브라우저 콘솔에 count 증가 로그 찍기
- React DevTools Profiler로 매 초 렌더가 발생하는지 확인(Profiler>Start profiling 클릭)

React 18과 StrictMode 고려사항

- 개발 모드에서 StrictMode는 마운트/언마운트를 두 번 호출해 사이드 이펙트 재실행을 노출합니다. (예: useEffect의 cleanup/생성 2회)
- **검증 방법**: package.json의 "start"로 개발 서버를 띄우고, 개발자 콘솔에서 effect가 두 번 실행되는지 확인
- 만약 외부 API 호출이나 타이머가 두 번 실행되면 cleanup 누락 또는 의존성 설정 문제일 가능성이 큽니다.

실무 점검 절차 (재현 명령·확인 방법)

1. 프로젝트 생성 및 버전 확인
   - npx create-react-app my-app
   - node -v # 권장: 18.x
   - npm -v # 권장: 9.x
   - 패키지 확인: package.json에 "react": "18.2.0"
2. 코드 적용: src/components/\*.jsx 파일로 예제 추가
3. 실행: npm start
4. 확인:
   - 브라우저에서 UI 동작 확인
   - 개발자 콘솔: render 횟수 로그 추가(컴포넌트 루트에 console.log('render', count))
   - React DevTools Profiler: 렌더 타임과 렌더 횟수 확인(Profiler 탭)
   - 네트워크 패널: 불필요한 API 호출 중복 여부 확인
5. 성능 체크(수치):
   - Profiler에서 "Interactions"과 각 렌더의 시간(ms)을 기록
   - 렌더 횟수가 많다면 useRef로 렌더 방지 가능한지 검토

개발 팁과 주의사항

- 큰 객체(예: 수만 건 로그 버퍼)를 상태로 두면 불필요한 렌더링과 메모리 복사 비용 발생. 이런 경우 **useRef로 저장하고 필요할 때만 상태로 내려 보여주는 패턴**을 고려하세요.
- form 입력처럼 빠르게 변화하는 값일 때는 상태 디바운스(debounce) 또는 useRef + requestAnimationFrame 패턴으로 렌더 비용을 낮출 수 있습니다.
- 테스트 시에는 Jest/Testing Library에서 useRef가 렌더 트리거를 하지 않음을 염두에 두고 assertion 설계: UI 변화가 없음을 검증하거나 내부 ref 값을 직접 읽는 대신 외부 동작(예: 타이머 클리어 여부)을 확인하세요.

검증 우선순위(결론 대신 실무 체크 포인트)

- 먼저 확인할 것: 해당 값이 바뀔 때 UI가 꼭 바뀌어야 하는가? (예: 사용자에게 보이는지 여부)
- 두 번째: 값 변경 빈도와 비용 — 초당 수백 번 변경이면 렌더를 피하는 구조를 검토
- 세 번째: 동시성(React 18)과 StrictMode에서 사이드 이펙트 재실행으로 문제가 생기지 않는지 확인

언제 다른 선택지가 나은가

- UI 일관성이 최우선이면 useState 또는 상태 리듀서(useReducer)를 선택하세요.
- 외부 인스턴스(예: WebSocket, Canvas 컨텍스트)나 타이머 id 같은 경우 useRef가 적절합니다.
- 복잡한 상태 변경과 파생값 계산이 많다면 useReducer나 상태 관리 라이브러리로 이동을 고려하세요.

마지막으로 점검할 항목

- 예제는 React 18.2.0과 Node 18.x 환경에서 재현 가능한 형태로 구성했습니다.
- 실패 예와 수정 예를 나란히 제시해 문제 원인과 해결을 바로 확인할 수 있게 했습니다.
- 검증 명령(npx create-react-app, npm start), 파일 경로(src/components/...), 버전(node/npm/react)과 Profiler 검사 방법을 포함했습니다.

참고로 코드 실행 중에 "Warning: Can't perform a React state update on an unmounted component" 같은 경고가 뜨면 타이머/구독의 cleanup가 빠진 경우일 확률이 높으니 useEffect의 cleanup(return)부터 확인하세요.

## 함께 보면 좋은 글

- [React 폼 비동기 제출 중 중복 타임아웃 피드백 처리 패턴](/posts/react-form-async-submit-duplicate-timeout-feedback-patterns/)
- [React Portal 접근성 포커스 관리 체크리스트](/posts/react-portal-accessibility-focus-checklist/)
- [React 상태 복원 패턴: 새로고침과 탭 종료 후 상태 유지](/posts/react-state-persistence-refresh-tab-restore/)
