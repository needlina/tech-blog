---
title: "React 상태 복원 패턴 새로고침 탭 닫음 이후 상태 유지"
description: "React 앱에서 새로고침 또는 탭 종료 이후 상태 유지 전략 정리. localStorage sessionStorage IndexedDB URL 서버 세션 비교, 코드 예제(실패/수정), DevTools로 검증하는 재현 절차와 확인 포인트"
slug: "react-state-persistence-refresh-tab-restore"
date: 2026-08-05 09:00:00 +0900
categories: ["Frontend", "React"]
tags: ["react", "local-storage", "session-storage", "상태복원", "상태관리"]
image:
  path: /assets/img/posts/blog/react-state-persistence-refresh-tab-restore/preview.png
  alt: "상태 지속화 패턴 썸네일"
---

맑은 날씨라 차분히 정리해봅니다.  
로컬에서는 상태가 유지되는데 브라우저 새로고침이나 탭 닫음 후에 상태가 사라지는 문제를 겪는 경우, **어떤 상태를 어느 저장소에 어떤 방식으로 직렬화해 둘지**를 먼저 정하면 해결이 훨씬 수월합니다. 핵심 체크포인트: 저장소 용량 한도(예: localStorage 약 5MB), 보안 민감성(토큰은 저장 금지), 직렬화 비용(객체 크기와 Date/Map 같은 비직렬화형 처리).

왜 이 주제가 실무에서 자주 헷갈릴까
- 개발 중에는 메모리 상태만 테스트하는 경우가 많고, 배포 환경에서는 새로고침과 탭 재진입이 빈번해 상태 손실이 드러납니다.
- 상태의 성격(임시 UI 상태 vs 영구 사용자 설정 vs 인증 토큰)에 따라 저장 위치와 복원 방법이 달라야 하는데, 이를 혼합해버리면 보안/성능 문제로 이어집니다.

우선 패턴 개요부터 실무 확인 포인트, 코드 예제(실패 사례 + 수정), 검증 절차 순으로 정리하겠습니다.

## 언제 어떤 전략을 쓰는지(요약 기준)
간단 비교표로 빠르게 판단 기준을 정리했습니다.

| 목적 또는 상태 | 추천 저장소 | 이유 요약 |
|---|---:|---|
| UI 토글, 필터, 페이지 인덱스(임시) | sessionStorage / URL | 탭 간 공유 불필요, 세션 단위 보존, URL은 공유 가능 |
| 사용자 설정(테마, 언어) | localStorage | 영구 보존, 간단 직렬화 |
| 큰 데이터, 오프라인 캐시 | IndexedDB | 용량 큼, 구조화된 저장 가능 |
| 인증 토큰(민감) | 서버 세션 / HttpOnly cookie | XSS 위험 회피 |
| 공유 가능한 상태(링크 복원) | URL 쿼리 또는 hash | 링크만으로 재현 가능 |

(표는 모바일에서 읽기 쉽게 간결하게 만들었습니다)

## 실무에서 먼저 확인할 것들
- 복원해야 할 상태 목록: 우선순위(필수/선택), 크기(예상 바이트), 갱신 빈도
- 브라우저 저장 한도: 로컬스토리지 약 5MB(브라우저별 상이), IndexedDB는 훨씬 큼
- 보안 민감성: 토큰이나 개인정보는 로컬스토리지에 둬선 안 됨
- 직렬화/역직렬화 비용: JSON.stringify로 직렬화 시 CPU와 렌더에 영향
- 동시성/경합: 여러 탭에서 상태 동기화가 필요한지 여부

## 간단한 실패 예제와 수정 예제
실무에서 흔히 하는 실수 두 가지를 보여주고 고치는 예시입니다. 환경: React 18.2.0, Node 16+.

1) 실패 사례 A — JSON.parse 에러나 undefined 파싱
- 증상: 새로고침 시 "Uncaught SyntaxError: Unexpected token u in JSON at position 0" 또는 앱이 중단됨
- 원인: localStorage에 값이 없거나 "undefined"가 들어가 있음, parse 시 예외 미처리

실패 코드:
```javascript
// src/hooks/usePersistedStateFail.js
import { useState, useEffect } from "react";

export function usePersistedStateFail(key, initialValue) {
  const [state, setState] = useState(() => JSON.parse(localStorage.getItem(key)));
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);
  return [state, setState];
}
```

수정 코드:
```javascript
// src/hooks/usePersistedState.js
import { useState, useEffect } from "react";

function safeParse(value) {
  try {
    return value === null ? null : JSON.parse(value);
  } catch (e) {
    console.warn("JSON parse failed for persisted state", e);
    return null;
  }
}

export function usePersistedState(key, initialValue) {
  const [state, setState] = useState(() => {
    const raw = localStorage.getItem(key);
    const parsed = safeParse(raw);
    return parsed ?? initialValue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {
      console.warn("Failed to persist state to localStorage", e);
    }
  }, [key, state]);

  return [state, setState];
}
```

검증 방법:
- 재현: key 미존재 상태에서 앱 시작 -> setState로 값 저장 -> 새로고침
- DevTools에서 Application > Storage > Local Storage 검사, 해당 key 값이 JSON 형식인지 확인
- 에러 메시지(콘솔)로 parse 예외가 사라지는지 확인

2) 실패 사례 B — Date, Map, Set 같은 비직렬화형 객체 처리 누락
- 증상: Date 객체를 string으로 저장했다가 복원 후 메서드 사용 시 타입 오류 또는 비교 실패
- 원인: JSON 직렬화는 Date를 ISO 문자열로 변환하지만 복원 시 Date 객체로 복원하지 않음

실패 코드:
```javascript
const user = { loggedAt: new Date() };
localStorage.setItem("user", JSON.stringify(user));
// 복원
const restored = JSON.parse(localStorage.getItem("user"));
console.log(restored.loggedAt instanceof Date); // false
```

수정 방법(리바이브 사용):
```javascript
function reviver(key, value) {
  if (typeof value === "string") {
    // ISO 8601 간단 체크
    const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
    if (iso8601.test(value)) return new Date(value);
  }
  return value;
}

// 저장
localStorage.setItem("user", JSON.stringify(user));
// 복원
const restoredWithDate = JSON.parse(localStorage.getItem("user"), reviver);
console.log(restoredWithDate.loggedAt instanceof Date); // true
```

주의점:
- 정규 표현식은 프로젝트의 타임존/형식 요구에 맞게 조정하세요.
- Map/Set 등은 Array로 변환하거나 라이브러리(예: flatted)를 사용해 처리할 수 있습니다.

## 라이브러리와 구현 옵션
- redux-persist: Redux store를 자동으로 localStorage/sessionStorage/IndexedDB에 직렬화. 버전 예시: redux-persist 6.x. 사용 시 blackList/whitelist로 어떤 리듀서를 저장할지 제한해야 함.
- idb: IndexedDB를 Promise 기반으로 쉽게 다루는 라이브러리. 설치: npm install idb
- localForage: localStorage/IndexedDB/WebSQL를 추상화. 설치: npm install localforage

간단 비교(선택 기준 중심):

| 항목 | 장점 | 단점 |
|---|---|---|
| localStorage | 간단, 동기 API, DevTools 바로 확인 | 5MB 제한, 동기라 블로킹, XSS 위험 |
| sessionStorage | 탭 세션 단위 보존 | 탭 닫으면 소실 |
| IndexedDB | 대용량, 비동기, 구조화 가능 | 구현 복잡도, 라이브러리 권장 |
| URL 쿼리 | 공유/복원 쉬움 | 길이 제한, 민감 데이터 불가 |
| 서버 세션 | 안전(서버 저장) | 네트워크 필요, 서버 비용 |

**민감한 토큰은 로컬 스토리지에 두지 마세요.** 인증 토큰은 가능하면 HttpOnly cookie 또는 서버 세션으로 처리해야 XSS 리스크를 줄일 수 있습니다.

## 검증 절차(재현 및 확인 명령)
- 개발 실행
  - npm run start (예: create-react-app 기준)
  - 브라우저: Chrome DevTools 열기(단축키 F12)
- 로컬 저장 확인
  - DevTools > Application > Local Storage / Session Storage 확인
  - IndexedDB는 같은 곳의 IndexedDB 탭에서 확인
- 프로덕션 빌드에서 확인
  - npm run build
  - npx serve -s build (또는 배포 서버)
  - 브라우저에서 새로고침, 탭 닫음 후 재접속으로 복원 동작 확인
- 자동화 테스트(간단)
  - E2E: Cypress/Playwright로 시나리오 작성(상태 설정 -> 새로고침 -> 복원 확인)
  - 예: cypress test 시나리오에서 localStorage.setItem, cy.reload() 후 값 assert

검증 체크리스트(빠른 순서)
1. 대상 상태 목록을 텍스트 파일에 정리(키, 용량 추정, 민감성)  
2. 개발 환경에서 저장/복원 흐름을 수동으로 실행, DevTools로 key 확인  
3. 오류 로그: JSON parse 예외, quota exceeded 메시지 확인  
4. 다중 탭: storage 이벤트가 잘 수신되는지 확인(window.addEventListener('storage', ...))  
5. 프로덕션 번들에서 직렬화 비용으로 인해 UI 지연이 없는지 Lighthouse CPU 프로필로 확인

## 멀티탭 동기화(선택적)
- localStorage 변경은 같은 origin의 다른 탭에 storage 이벤트로 전파됩니다.
```javascript
window.addEventListener("storage", (e) => {
  if (e.key === "my-app-state") {
    // e.newValue 처리
  }
});
```
- 단, 같은 탭에서 setItem을 수행한 탭에서는 직접 이벤트가 발생하지 않으므로 필요하면 브로드캐스트 채널(BroadcastChannel API)을 고려

## 오프라인과 대용량 데이터
- 오프라인 동작이 필요하면 IndexedDB + service worker 조합을 고려
- IndexedDB는 수 MB~수십 MB 이상의 저장이 가능(브라우저마다 상이). 실제 용량은 테스트가 필요
- 오프라인 동기화 정책: 쓰기 큐를 구성하고 재연결 시 서버와 conflict resolution 규칙 필요

다음 이미지는 상태 복원 패턴을 한눈에 보여주는 개념도입니다.

![간단한 상태 복원 아키텍처 개념도](/assets/img/posts/blog/react-state-persistence-refresh-tab-restore/image-1.webp)
이미지 출처: AI 생성 이미지

이미지 설명: localStorage, IndexedDB, URL, 서버 세션이 어떻게 역할을 나누는지 단순화한 도식

두 번째 이미지는 저장 흐름과 복원 시점에서의 체크포인트를 요약합니다.

![저장과 복원 시점의 체크포인트 다이어그램](/assets/img/posts/blog/react-state-persistence-refresh-tab-restore/image-2.webp)
이미지 출처: AI 생성 이미지

이미지 설명: 상태 직렬화, 저장, 복원, 검증 단계의 흐름

## 마무리 메모와 우선 확인 항목
- 먼저 확인할 것: **이 상태가 민감한가**, **영구 저장이 필요한가**, **다중 탭 동기화가 필요한가** 이 세 가지를 결정하세요. 이 질문들이 저장소 선택의 핵심입니다.
- 언제 서버 세션이나 HttpOnly 쿠키가 나은가: 인증 토큰·개인정보처럼 XSS로부터 보호해야 하는 데이터는 로컬 저장 대신 서버 측 저장 또는 HttpOnly 쿠키를 사용하세요.
- 언제 IndexedDB가 필요한가: 데이터 크기가 localStorage 한도를 초과하거나 구조화된 로컬 쿼리/색인이 필요한 경우.

참고 문서(검증 경로)
- React 공식 문서 상태 관리 섹션: https://reactjs.org/docs/state-and-lifecycle.html  
- MDN Web Docs localStorage: https://developer.mozilla.org/ko/docs/Web/API/Window/localStorage  
- MDN IndexedDB: https://developer.mozilla.org/ko/docs/Web/API/IndexedDB_API  
- Redux Persist: https://github.com/rt2zz/redux-persist  
- idb 라이브러리: https://github.com/jakearchibald/idb

실제로 적용하면서 작은 단위로 검증(DevTools 확인, 콘솔 로그, E2E 재현)을 반복하는 게 비용과 위험을 줄여줍니다. 필요하면 여러분이 복원하려는 특정 상태(예: 폼 입력, UI 토글, 인증 흐름)에 맞춘 예제를 이어서 정리해볼게요.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

## 함께 보면 좋은 글

- [React 폼 복잡성 줄이기: 비동기 검증과 서버 유효성 정리](/posts/react-form-complexity-reduce-async-server-validation/)
- [Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드](/posts/vue3-reusable-accessible-form-field-guide/)
- [Event-driven 아키텍처에서 스키마 변경을 무중단 적용하는 전략 Top 6](/posts/event-driven-schema-change-zero-downtime-top6/)
