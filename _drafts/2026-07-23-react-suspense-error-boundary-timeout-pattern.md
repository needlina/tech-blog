---
title: "React Suspense와 Error Boundary를 타임아웃과 안전하게 결합하는 패턴"
description: "React 18+ 환경에서 Suspense와 Error Boundary에 타임아웃을 결합하는 방법, AbortController 예제 코드, 타임아웃 값·fallback UI·재시도·로그 확인 포인트 정리"
slug: "react-suspense-error-boundary-timeout-pattern"
date: 2026-07-23 10:00:00 +0900
categories: ["Frontend"]
tags: ["react", "react-suspense", "error-boundary", "사용자경험", "성능튜닝"]
image:
  path: /assets/img/posts/blog/react-suspense-error-boundary-timeout-pattern/preview.png
  alt: "Suspense + Timeout 썸네일"
---

로컬에서는 빠르게 보이는데 프로덕션에서 네트워크 지연으로 컴포넌트가 무한 로딩되는 상황을 겪을 수 있다. React Suspense와 Error Boundary를 **타임아웃(예: 3초)** 및 AbortController와 결합하면 사용자에게 적절한 대체 UI를 보여주고, 오류를 명확히 기록하며 안전하게 재시도할 수 있다 — 실무에서는 타임아웃 값, fallback 디자인, 로그/모니터링 포인트를 먼저 점검하면 좋다.

왜 나한테 필요한가
- 사용자는 무한 스피너를 싫어한다. 일정 시간 이상 로딩되면 명확한 상태(오류 / 재시도 버튼 / 최소 정보)를 주는 편이 UX 측면에서 좋다.
- Suspense만으로는 "무한 대기" 상황을 자동으로 정리하지 못한다. Error Boundary는 예외를 잡지만, 네트워크 지연은 예외가 아닐 수 있어 별도 타임아웃 로직가 필요하다.
- AbortController로 요청을 취소하면 불필요한 리소스 사용을 줄이고, 백엔드 오용을 막을 수 있다.

공부하면서 알게 된 점
- React 18부터 Concurrent 기능과 Suspense 사용 경험이 달라졌다. Suspense로 데이터를 "일시 중단(suspend)"시키는 방식이 편리하지만, 브라우저의 실제 네트워크 지연을 자동으로 에러로 바꾸지는 않는다.
- fetch의 타임아웃은 기본 제공되지 않아서 AbortController를 직접 사용해야 했다.
- Error Boundary는 렌더링/라이프사이클에서 발생하는 예외를 잡지만, Promise가 끝나지 않는 케이스는 Error Boundary가 잡지 못한다는 점이 헷갈렸다.

핵심 개념 요약
- Suspense: 렌더 중인 컴포넌트를 일시 중단하고 fallback을 보여줌.
- Error Boundary: 렌더 오류를 포착하여 대체 UI로 전환.
- Timeout + AbortController: 요청을 일정 시간 이후 취소하고, 취소 시점에 명확히 오류로 전환시켜 Error Boundary로 핸들링하게 함.

이미지: Suspense와 Error Boundary 관계를 간략히 나타낸 다이어그램
![Suspense와 Error Boundary의 흐름을 단순히 보여주는 개념 그림](/assets/img/posts/blog/react-suspense-error-boundary-timeout-pattern/image-1.webp)
이미지 출처: AI 생성 이미지

간단 실패 예시 (문제 상황)
- 문제: Suspense만 쓰고 타임아웃 없이 무한대기. 사용자에게 스피너만 보임.
- 환경: React 18.2.0, 브라우저 네트워크 지연 10초.
- 증상: 네트워크 지연이 길면 화면에 아무런 오류 없이 계속 spinner만 노출.
- 확인 로그: 서버 쿼리는 타임아웃 없이 계속 유지. Sentry에는 관련 에러 없음.

실패 예시 코드 (나쁜 예)
```jsx
// BadFetch.js
import React, { Suspense } from "react";

function fetchUser() {
  return fetch("/api/user").then(res => res.json());
}

function User() {
  const user = fetchUser(); // Promise를 직접 사용하면 동작이 예측 불가
  // (실제로는 resource 래핑이 필요하지만 여기선 단순화)
  throw user; // Suspense로 잡을 목적
}

export default function App() {
  return (
    <Suspense fallback={<div>로딩중...</div>}>
      <User />
    </Suspense>
  );
}
```

위 예시는 네트워크 지연이 길면 사용자에게 아무런 오류도 남기지 않고 계속 로딩 상태가 된다. Error Boundary로도 이 상태를 잡기 어렵다.

수정 방법: AbortController + 타임아웃 + Error Boundary 결합
- 목표: 요청을 타임아웃 시점에 Abort하고 Error Boundary로 전달해 fallback UI로 전환.
- 핵심: fetch 요청에 AbortController 전달, 타임아웃은 setTimeout으로 취소 트리거, Suspense로는 "비동기 데이터 준비" 흐름 유지.

좋은 예시 코드 (실무형)
```jsx
// dataResource.js
function wrapPromise(promise) {
  let status = "pending";
  let result;
  const suspender = promise.then(
    r => {
      status = "success";
      result = r;
    },
    e => {
      status = "error";
      result = e;
    }
  );
  return {
    read() {
      if (status === "pending") throw suspender;
      if (status === "error") throw result;
      return result;
    }
  };
}

// fetchWithTimeout.js
export function fetchWithTimeout(url, { timeout = 3000 } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const promise = fetch(url, { signal: controller.signal })
    .then(async res => {
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });

  // 실패 이유가 abort일 때 구분하려면 .catch에서 처리 가능
  return { resource: wrapPromise(promise), controller };
}
```

컴포넌트 쪽
```jsx
// UserComponent.js
import React, { Suspense } from "react";
import { fetchWithTimeout } from "./fetchWithTimeout";
import ErrorBoundary from "./ErrorBoundary";

const { resource } = fetchWithTimeout("/api/user", { timeout: 3000 });

function User() {
  const data = resource.read();
  return <div>{data.name}</div>;
}

export default function App() {
  return (
    <ErrorBoundary fallback={<div>사용자 정보를 불러올 수 없습니다.</div>}>
      <Suspense fallback={<div>로딩중...</div>}>
        <User />
      </Suspense>
    </ErrorBoundary>
  );
}
```

위 방식의 핵심 포인트
- **타임아웃 값(예: 3000ms)**은 서비스의 p95 응답시간과 UX 기대치에 따라 결정.
- Abort 시 fetch가 "AbortError"를 던져 Error Boundary로 전파 가능.
- Error Boundary에서 사용자용 메시지와 재시도 버튼을 제공하면 좋다.

테스트/재현 방법 (구체적)
1. 로컬 테스트 서버(예: Node/Express)를 만들어 응답 지연 시뮬레이션:
```js
// server.js
const express = require("express");
const app = express();
app.get("/api/user", (req, res) => {
  setTimeout(() => res.json({ name: "jun" }), 5000); // 5s delay
});
app.listen(4000);
```
- 실행: node server.js (Node v16+ 권장)
2. 클라이언트 타임아웃을 3000ms로 설정하고 페이지 로드.
3. 브라우저 네트워크 탭에서 요청이 abort되는지 확인(원인: aborted).
4. 애플리케이션 로그/Sentry에서 "AbortError" 또는 커스텀 오류 메시지 확인.

비교 표: 패턴별 실무 판단 기준
| 패턴 | 실패 증상 | 확인 포인트 | 조치 |
|---|---:|---|---|
| Suspense 단독 | 무한 스피너 | 네트워크 지연 시간, Sentry 없음 | 타임아웃 도입 |
| Suspense + ErrorBoundary + Timeout | 스피너→오류 표기 | AbortEvent, HTTP 상태, 사용자 재시도 흐름 | 타임아웃 값 조정, 재시도 전략 |
| 수동 fetch(useEffect) | 복잡한 로딩 상태 | 상태 관리 복잡성, 메모리 누수 | custom hook으로 추상화 |

처음에는 헷갈렸던 부분
- Suspense가 "모든 비동기"를 자동으로 해결해줄 것 같았는데, 실제로는 Promise가 끝나지 않으면 Error Boundary로 넘어오지 않아 별도 타임아웃 관리가 필요했다.
- AbortController가 브라우저와 node fetch 구현에 따라 동작이 조금씩 달라서, polyfill 필요 여부를 확인해야 했다.

실무에서는 이렇게 확인하면 좋겠다 (우선순위)
1. 서비스의 p50/p95 응답 시간 확인 (예: p95 > 2000ms이면 타임아웃 긴급 검토).
2. Sentry/애플리케이션 로그에서 "AbortError" 또는 fetch 관련 에러를 필터링.
3. 네트워크 탭에서 abort 여부 확인 및 서버 로그에서 해당 요청이 취소되었는지(서버 처리 중단) 확인.
4. UX: fallback 문구, 재시도 버튼, 최소 콘텐츠(Partial UI)를 제공했는지 점검.
5. 테스트: 로컬 지연 서버(위 예제)로 재현 후 재시도 동작, 메모리 누수 확인.

이미지: 타임아웃 및 재시도 흐름을 보이는 단순 다이어그램
![타임아웃 발생 후 재시도 흐름을 단순히 보여주는 그림](/assets/img/posts/blog/react-suspense-error-boundary-timeout-pattern/image-2.webp)
이미지 출처: AI 생성 이미지

Q&A (자주 묻는 질문)
Q: 타임아웃 값은 어떻게 정하나요?
A: 기본값으로 2000~5000ms 범위를 많이 쓰지만, **서비스의 p95 응답시간**, 사용자 기대(대화형인지, 배치성인지), 네트워크 환경을 기준으로 정하세요. 예: p95가 800ms이면 timeout 2000ms가 합리적일 수 있습니다.

Q: AbortController는 어디서 생성해야 하나요?
A: 요청 단위로 생성하는 게 안전합니다. 여러 요청을 한 번에 취소해야 한다면 상위 로직에서 여러 controller를 묶어 관리할 수 있습니다. 공유 시 의도치 않은 취소가 발생하지 않도록 주의해야 합니다.

Q: Error Boundary로 모든 오류를 처리할 수 있나요?
A: 렌더/라이프사이클에서 발생하는 예외는 잡지만, Promise가 끝나지 않거나 외부 이벤트는 직접 예외로 만들지 않으면 잡히지 않습니다. 그래서 타임아웃으로 강제로 에러를 발생시키는 패턴이 필요합니다.

Q: 재시도 정책은 어떻게 세우나요?
A: 간단한 정수 기반(최대 2회) 또는 지수 백오프를 권장합니다. 다음을 고려하세요: idempotency, 서버 비용, 사용자 혼란.

코드 예시: 실패 예시와 수정 예시를 나란히 보여주기 (요약)
- 실패: Suspense만 사용 → 무한 스피너
- 수정: fetchWithTimeout + wrapPromise + ErrorBoundary

## 나의 의견 1
여기에 나의 환경(예: React 버전, Node 버전, 브라우저, p95 수치)을 적어보세요. 예: "React 18.2, Node 18, p95 = 2.5s"

## 나의 의견 2
처음 실패했을 때의 짧은 메모(예: 처음 실패한 요청, 콘솔 로그, 네트워크 탭에서 보인 상태)를 적어보세요.

실무 체크리스트
- [ ] React 버전 확인: React >= 18.0.0 (확인 명령: package.json 또는 npm ls react)
- [ ] 브라우저/환경에서 AbortController 지원 여부(폴리필 필요 시 명시)
- [ ] p50/p95 응답시간 확인(예: Prometheus, Datadog)
- [ ] 타임아웃 값 설정(권장 시작값: 2000~5000ms) 및 A/B 테스트 계획
- [ ] Error Boundary에 사용자용 메시지 및 재시도 UX 구현
- [ ] 로그/에러 수집: AbortError, HTTP status, 사용자 재시도 이벤트를 수집
- [ ] 재현 스크립트 준비: 로컬 delay 서버(node/express)로 테스트 (server.js 예시)
- [ ] 모니터링: 네트워크 abort 비율, 재시도 성공률, p95 개선 여부 확인
- 재현 명령 예시:
  - 서버 실행: node server.js
  - 브라우저에서 페이지 열기 또는 curl로 확인: curl -v http://localhost:4000/api/user (지연 관찰)
- 공식 문서 확인 경로:
  - React Suspense: https://reactjs.org/docs/concurrent-mode-suspense.html
  - Error Boundaries: https://reactjs.org/docs/error-boundaries.html
  - AbortController: https://developer.mozilla.org/en-US/docs/Web/API/AbortController

마무리(무작정 요약 대신)
- 이 주제에서 먼저 확인할 것: 현재 p95 응답시간과 사용자에게 보여지는 최대 허용 로딩 시간(예: 2~5초).
- 언제 다른 선택지가 나은가: 데이터가 작고 빠르며 실패 시 자동 재시도가 불필요하면 Suspense 단독도 괜찮지만, 네트워크 불안정성이 있거나 사용자에게 명확한 피드백이 필요하면 **타임아웃 + Error Boundary** 조합을 권한다.

읽어주셔서 고맙습니다. 궁금한 점이나 내 환경에 맞춘 예제가 필요하면 어떤 환경(React/Node 버전, 현재 p95 등)을 쓰는지 알려주시면 같이 정리해볼게요.