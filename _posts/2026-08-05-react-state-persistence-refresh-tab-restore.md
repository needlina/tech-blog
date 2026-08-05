---
title: "React 상태 복원 패턴: 새로고침과 탭 종료 후 상태 유지"
description: "React 앱에서 새로고침 또는 탭 종료 후 상태를 유지하는 방법. localStorage, sessionStorage, IndexedDB, URL, 서버 세션 비교와 실패 사례, 수정 코드, DevTools 검증 절차 정리"
slug: "react-state-persistence-refresh-tab-restore"
date: 2026-08-05 17:00:00 +0900
categories: ["Frontend", "React"]
tags: ["react", "local-storage", "session-storage", "상태복원", "상태관리"]
image:
  path: /assets/img/posts/blog/react-state-persistence-refresh-tab-restore/preview.png
  alt: "상태 지속화 패턴 썸네일"
---

React 앱에서 새로고침 후 입력값, 필터, 탭 선택값이 사라진다면 먼저 상태의 성격부터 나눠야 한다. **임시 UI 상태는 sessionStorage나 URL, 사용자 설정은 localStorage, 큰 오프라인 데이터는 IndexedDB, 인증 정보는 서버 세션이나 HttpOnly cookie**로 분리하는 편이 안전하다.

상태 복원 문제는 코드보다 기준이 먼저다. 모든 상태를 localStorage에 넣으면 구현은 쉽지만, 보안과 성능 문제가 빨리 온다. 특히 토큰, 개인정보, 권한 정보는 브라우저 스토리지에 두지 않는 쪽으로 설계해야 한다.

## 저장소 선택 기준

| 상태 종류                        | 추천 위치                      | 이유                                    |
| -------------------------------- | ------------------------------ | --------------------------------------- |
| UI 토글, 필터, 페이지 번호       | `sessionStorage` 또는 URL      | 탭 단위로 충분하거나 링크 공유가 필요함 |
| 테마, 언어, 표시 옵션            | `localStorage`                 | 사용자가 다시 방문해도 유지되어야 함    |
| 큰 목록, 오프라인 캐시           | IndexedDB                      | 용량과 구조화 저장에 유리함             |
| 인증 토큰, 민감 정보             | 서버 세션 또는 HttpOnly cookie | XSS 노출 위험을 줄임                    |
| 검색 조건, 공유 가능한 화면 상태 | URL query 또는 hash            | 링크만으로 같은 화면을 재현할 수 있음   |

`localStorage`는 간단하지만 동기 API다. 큰 객체를 자주 `JSON.stringify`하면 렌더링에 영향을 줄 수 있다. 상태 크기가 커지거나 쓰기 빈도가 높다면 IndexedDB나 서버 저장을 검토하는 것이 낫다.

## 먼저 정리할 것

- 복원해야 하는 상태가 필수인지 선택인지 구분한다.
- 상태 크기와 갱신 빈도를 대략이라도 적어 둔다.
- 새로고침만 복원하면 되는지, 여러 탭 동기화까지 필요한지 정한다.
- 민감 정보가 섞여 있으면 브라우저 저장 대상에서 제외한다.
- `Date`, `Map`, `Set`처럼 JSON으로 그대로 복원되지 않는 값이 있는지 확인한다.

이 다섯 가지가 정리되지 않으면 저장소 선택이 계속 흔들린다.

## 실패 사례 1: 없는 값을 바로 JSON.parse 하는 코드

가장 흔한 오류는 `localStorage.getItem()` 결과를 바로 `JSON.parse()`에 넘기는 것이다. 키가 없거나 `"undefined"`가 저장되어 있으면 새로고침 시 앱이 중단될 수 있다.

```javascript
// src/hooks/usePersistedStateFail.js
import { useEffect, useState } from "react";

export function usePersistedStateFail(key, initialValue) {
  const [state, setState] = useState(() =>
    JSON.parse(localStorage.getItem(key))
  );

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);

  return [state, setState];
}
```

최소한 파싱 실패와 저장 실패는 감싸야 한다. 브라우저 저장소는 사용자가 직접 지우거나, 확장 프로그램이나 이전 버전 코드가 예상하지 못한 값을 남길 수 있다.

```javascript
// src/hooks/usePersistedState.js
import { useEffect, useState } from "react";

function safeParse(value) {
  if (value === null || value === "undefined") return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn("Invalid persisted state", error);
    return null;
  }
}

export function usePersistedState(key, initialValue) {
  const [state, setState] = useState(() => {
    if (typeof window === "undefined") return initialValue;

    const parsed = safeParse(window.localStorage.getItem(key));
    return parsed ?? initialValue;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
      console.warn("Failed to persist state", error);
    }
  }, [key, state]);

  return [state, setState];
}
```

Next.js나 SSR 환경에서는 `window`가 없는 시점도 고려해야 한다. 위 예시는 클라이언트에서만 스토리지를 읽도록 방어한다.

## 실패 사례 2: Date를 문자열로 복원하는 코드

JSON은 `Date` 객체를 문자열로 저장한다. 복원 후에도 `Date` 메서드를 써야 한다면 직접 되살리는 로직이 필요하다.

```javascript
const user = { loggedAt: new Date() };

localStorage.setItem("user", JSON.stringify(user));

const restored = JSON.parse(localStorage.getItem("user"));
console.log(restored.loggedAt instanceof Date); // false
```

간단한 방식은 `JSON.parse`의 reviver를 쓰는 것이다.

```javascript
function reviver(key, value) {
  if (typeof value !== "string") return value;

  const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
  return iso8601.test(value) ? new Date(value) : value;
}

const restoredWithDate = JSON.parse(localStorage.getItem("user"), reviver);
console.log(restoredWithDate.loggedAt instanceof Date); // true
```

`Map`, `Set`, class instance까지 섞이면 직접 규칙을 만들기보다 상태 구조를 단순하게 바꾸는 편이 유지보수에 유리하다.

## 라이브러리 선택

| 도구            | 맞는 경우                                        | 주의할 점                              |
| --------------- | ------------------------------------------------ | -------------------------------------- |
| `redux-persist` | Redux store 일부를 자동 저장해야 할 때           | 저장할 slice를 whitelist로 제한해야 함 |
| `idb`           | IndexedDB를 Promise 기반으로 다루고 싶을 때      | 스키마 버전 관리가 필요함              |
| `localForage`   | localStorage보다 큰 저장소를 간단히 쓰고 싶을 때 | 내부 저장 방식 차이를 테스트해야 함    |
| 직접 hook 구현  | 상태가 작고 규칙이 단순할 때                     | 예외 처리와 SSR 처리를 빠뜨리기 쉬움   |

작은 설정값 몇 개라면 직접 hook으로 충분하다. 장바구니, 임시 문서, 오프라인 큐처럼 데이터가 커지는 기능은 처음부터 IndexedDB 계열을 검토하는 것이 낫다.

## 여러 탭 동기화

같은 origin의 다른 탭에서 `localStorage`가 바뀌면 `storage` 이벤트가 발생한다.

```javascript
window.addEventListener("storage", (event) => {
  if (event.key === "my-app-state") {
    const nextState = safeParse(event.newValue);
    // 필요한 상태 갱신 처리
  }
});
```

단, 같은 탭에서 실행한 `setItem`에는 `storage` 이벤트가 발생하지 않는다. 같은 탭 안의 컴포넌트끼리 즉시 동기화해야 한다면 React 상태, context, store를 기준으로 삼고 저장소는 백업 위치로만 쓰는 편이 깔끔하다. 탭 간 실시간 동기화가 중요하면 `BroadcastChannel`도 검토할 수 있다.

## 검증 절차

1. 복원 대상 상태와 저장 키 이름을 문서화한다.
2. Chrome DevTools의 Application 탭에서 Local Storage, Session Storage, IndexedDB 값을 확인한다.
3. 값이 없는 상태, 깨진 JSON, `"undefined"` 문자열을 넣고 새로고침해 본다.
4. 여러 탭을 열어 상태 변경이 필요한 방향으로 동기화되는지 확인한다.
5. 프로덕션 빌드에서 새로고침, 탭 닫기, 재접속을 반복한다.

자동화 테스트를 넣는다면 Playwright나 Cypress로 `set state -> reload -> assert` 흐름을 만든다. 저장소를 직접 세팅한 뒤 `page.reload()` 또는 `cy.reload()`로 복원 결과를 확인하면 된다.

## 실무 체크리스트

- 인증 토큰과 개인정보를 localStorage에 넣지 않았는가?
- 저장 값이 없거나 깨졌을 때 기본값으로 복구되는가?
- `Date`, `Map`, `Set` 같은 값이 문자열로 망가지지 않는가?
- 상태 저장이 너무 자주 발생해 렌더링을 막지 않는가?
- 여러 탭에서 같은 상태를 수정할 때 충돌 규칙이 있는가?
- URL로 공유해야 하는 상태를 스토리지에만 숨겨두지 않았는가?

상태 복원은 “어디에 저장할까”보다 “이 상태가 어떤 수명을 가져야 하는가”가 먼저다. 수명이 짧은 UI 상태, 오래 남겨야 하는 사용자 설정, 서버가 책임져야 하는 보안 정보를 섞지 않으면 구현도 단순해진다.

## 참고 문서

- React 공식 문서: https://react.dev/learn/state-a-components-memory
- MDN localStorage: https://developer.mozilla.org/ko/docs/Web/API/Window/localStorage
- MDN IndexedDB: https://developer.mozilla.org/ko/docs/Web/API/IndexedDB_API
- Redux Persist: https://github.com/rt2zz/redux-persist
- idb: https://github.com/jakearchibald/idb

## 함께 보면 좋은 글

- [React 폼 복잡도 줄이기: 비동기 검증과 서버 유효성 정리](/posts/react-form-complexity-reduce-async-server-validation/)
- [Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드](/posts/vue3-reusable-accessible-form-field-guide/)
- [Event-driven 아키텍처에서 스키마 변경을 무중단 적용하는 전략 Top 6](/posts/event-driven-schema-change-zero-downtime-top6/)
