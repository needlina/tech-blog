---
title: "React useEffect 실무 패턴: 흔한 실수와 안전한 개선 방법"
description: "React에서 useEffect를 잘못 쓰는 대표적인 패턴과 개선 방법"
date: 2026-07-07 12:00:00 +0900
categories: [React, 실무패턴]
tags: [react, typescript, frontend]
---


React에서 useEffect를 잘못 쓰는 대표적인 패턴과 개선 방법

서론
-------
useEffect는 React 함수형 컴포넌트에서 사이드 이펙트를 처리하는 표준 API입니다. 하지만 실무에서는 의도치 않은 리렌더·무한 루프·메모리 누수·경합(race) 등을 유발하는 잘못된 사용이 자주 보입니다. 이 글은 초보자도 이해할 수 있게 대표적인 잘못된 패턴을 짚고, 현실적인 개선 방법과 코드 예제를 제공합니다. 모든 방법이 항상 최선은 아닐 수 있으니 각 패턴의 트레이드오프도 간단히 언급합니다.

useEffect 기본 개념(간단히)
-----------------
- useEffect(fn, deps)는 deps가 바뀔 때마다 fn을 실행합니다.
- fn은 정리(cleanup) 함수를 반환할 수 있습니다: return () => { ... }.
- 빈 deps([])면 마운트/언마운트 시만 실행됩니다.
- deps를 생략하면 매 렌더마다 실행됩니다(대부분 의도치 않음).
- React 18의 StrictMode 개발 환경에서는 mount 관련 이펙트가 두 번 실행되는 점을 유의하세요(개발 모드 한정).

1) 실수: deps 생략(또는 빈 deps에 필요한 의존 누락)
-----------------------------------
문제
- 함수나 값에 의존하는데 deps에 포함하지 않으면 stale 값 사용 또는 Linter 경고 발생.
- 반대로 모든 것을 포함시키면 불필요한 재실행이 발생할 수 있음.

잘못된 예
```tsx
import React, { useState, useEffect } from "react";

function MyComponent({ userId }: { userId: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    // userId에 따라 데이터를 가져와야 하는데 deps에 userId가 없음
    fetch(`/api/users/${userId}`).then(res => res.json()).then(console.log);
  }, []); // 잘못: userId가 deps에 없음

  // ...
  return <div>{count}</div>;
}
```

자주 실수하는 부분....

개선
- 의존성을 정확히 명시하거나, 의도적으로 제외할 때는 이유를 주석으로 남깁니다.
- 복잡한 연산은 useMemo/useCallback으로 안정화합니다.

수정 예
```tsx
useEffect(() => {
  let mounted = true;
  fetch(`/api/users/${userId}`)
    .then(res => res.json())
    .then(data => {
      if (!mounted) return;
      console.log(data);
    });
  return () => { mounted = false; };
}, [userId]);
```

2) 실수: 이펙트 내부에서 async 함수를 직접 선언/사용
------------------------------------------------
문제
- useEffect 콜백 자체는 sync이어야 합니다. 즉 async 콜백을 바로 쓰면 Promise가 반환되므로 정리 함수로 사용될 수 없습니다(정리 동작 혼란).

잘못된 예
```tsx
useEffect(async () => {
  const res = await fetch(url);
  setData(await res.json());
}, [url]); // 경고/예상치 못한 동작 가능
```

개선
- 내부에서 async 함수를 선언해 호출하거나, AbortController로 취소 처리를 합니다.

이것도 처음에는 많이헷갈렸던 부분임.

수정 예
```tsx
useEffect(() => {
  const controller = new AbortController();
  async function load() {
    try {
      const res = await fetch(url, { signal: controller.signal });
      const json = await res.json();
      setData(json);
    } catch (err) {
      if ((err as any).name === "AbortError") return;
      console.error(err);
    }
  }
  load();
  return () => controller.abort();
}, [url]);
```

3) 실수: 의존성으로 객체/배열/함수 직접 전달 — 불필요한 재실행
-------------------------------------------------------
문제
- props로 전달되거나 컴포넌트 내부에서 매 렌더 새로 생성되는 객체/함수는 참조가 변해 deps가 바뀐 것으로 간주되어 이펙트가 다시 실행됩니다.

잘못된 예
```tsx
function Parent() {
  const options = { page: 1 };
  return <Child options={options} />;
}

function Child({ options }: { options: { page: number } }) {
  useEffect(() => {
    // options가 매번 새 객체라서 effect가 잦음
  }, [options]);
}
```

개선
- 부모에서 useMemo/useCallback으로 안정화하거나, 자식에서 필요한 primitive 값만 deps로 사용합니다.
- 다만 useMemo/useCallback 자체 비용과 메모리 사용을 고려해야 합니다.

수정 예
```tsx
function Parent() {
  const options = React.useMemo(() => ({ page: 1 }), []);
  return <Child options={options} />;
}
```
또는 Child가 내부적으로 페이지를 deps로 사용
```tsx
useEffect(() => {
  // options.page만 사용
}, [options.page]);
```

4) 실수: cleanup(정리) 누락으로 인한 메모리 누수 / 중복 구독
---------------------------------------------------
문제
- 이벤트 리스너, 타이머, 구독 등을 등록하고 정리하지 않으면 언마운트 후에도 살아있어 메모리 누수나 예상치 못한 콜백 호출이 발생.

예
```tsx
useEffect(() => {
  const id = setInterval(() => {
    setCount(c => c + 1);
  }, 1000);
  // return이 없어서 언마운트 후에도 동작
}, []);
```

수정
```tsx
useEffect(() => {
  const id = setInterval(() => {
    setCount(c => c + 1);
  }, 1000);
  return () => clearInterval(id);
}, []);
```

5) 실수: 상태를 의존성으로 넣고 setState로 무한 루프
------------------------------------------------
문제
- 이펙트에서 상태를 변경하고 그 상태가 deps에 있으면 반복 실행되어 무한 루프가 발생할 수 있습니다.

잘못된 예
```tsx
useEffect(() => {
  setData(computeSomething()); // computeSomething이 매번 새 값이면 루프
}, [data]);
```

개선
- 보통은 deps에 넣을 값과 상태 갱신의 원인을 분리해야 합니다. 상태 자체를 deps로 사용하는 대신 입력(source)만 deps로 둡니다.
- setState 내부에서 이전 값을 기준으로 안전하게 계산(useState updater)을 사용하세요.

6) 실수: 상태 유도(derived state)를 useEffect로 처리
----------------------------------------------
문제
- 텍스트 길이에 따라 다른 상태를 만들기 위해 useEffect로 setState하면 복잡성/버그 유발. 가능하면 파생 값을 직접 계산하거나 useMemo 사용.

예
```tsx
const [text, setText] = useState("");
const [isLong, setIsLong] = useState(false);

useEffect(() => {
  setIsLong(text.length > 100);
}, [text]);
```

개선
- 간단한 파생 값이라면 state로 관리할 필요 없이 계산해서 사용:
```tsx
const isLong = text.length > 100;
```
- 비용이 큰 계산일 때는 useMemo 사용:
```tsx
const isLong = useMemo(() => text.length > 100, [text]);
```

7) 실수: 언마운트 후 setState 호출(경고 및 버그)
--------------------------------------------
문제
- 비동기 작업이 끝난 후 컴포넌트가 언마운트됐다면 setState 호출은 불필요하거나 경고를 발생시킬 수 있음.

패턴
- AbortController, 플래그(mounted)를 사용해 조건부로 setState 합니다.

예
```tsx
useEffect(() => {
  let mounted = true;
  fetch(url).then(r => r.json()).then(data => {
    if (mounted) setData(data);
  });
  return () => { mounted = false; };
}, [url]);
```
- AbortController를 사용하는 것이 fetch와 잘 어울립니다.

디버깅 팁 및 도구
-----------------
- eslint-plugin-react-hooks의 exhaustive-deps 규칙을 활성화하세요. 대부분의 deps 실수를 잡아줍니다. 때로는 의도적으로 deps를 제외해야 할 수 있으니 그 경우 주석으로 설명을 남기세요.
- React DevTools로 렌더/재렌더 원인 확인.
- console.log를 이용해 deps 변화 추적(특히 참조형 값).
- 개발 환경에서 React 18 StrictMode가 이펙트 두 번 실행을 유발할 수 있으니 그것도 감안해 로직 작성.

추가 고려사항(실무적 조언)
-----------------------
- useCallback/useMemo는 성능 최적을 위해 사용하지만 남용하면 코드 복잡도가 증가합니다. profile(프로파일링) 전에는 최적화 사용을 권장하지 않습니다.
- 서버 상태(fetching 캐시 등)는 react-query나 SWR 같은 라이브러리를 사용하는 것이 안전하고 간단할 수 있습니다. 다만 라이브러리 도입은 팀 상황을 고려해야 합니다.
- 테스트: 이펙트 관련 코드는 유닛/통합 테스트에서 mock/버튼 클릭/타이머 제어(jest.useFakeTimers) 등을 활용해 검증하세요.

종합 예제 — 안전한 데이터 패칭 패턴 (TypeScript)
------------------------------------
```tsx
import React, { useEffect, useState } from "react";

type User = { id: string; name: string };

function useUser(userId: string | null) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) {
      setUser(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/users/${userId}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: User = await res.json();
        setUser(data);
      } catch (err) {
        if ((err as any).name === "AbortError") return;
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [userId]);

  return { user, loading, error };
}
```

결론
-----
useEffect는 매우 유용하지만 의존성 관리, 비동기 취소, 정리(cleanup) 등을 신경써야 합니다. 패턴을 잘 익히고 eslint 규칙과 도구를 활용하면 흔한 실수 상당 부분을 예방할 수 있습니다. 모든 선택에는 트레이드오프가 있으니 팀 합의와 프로파일링을 통해 최적의 선택을 하세요.

실무 체크리스트
--------------
- [ ] useEffect의 deps를 정확히 명시했는가? 의도적으로 제외했다면 주석을 남겼는가?
- [ ] async 콜백을 useEffect에 직접 쓰지 않았는가? (내부 async 함수 또는 AbortController 사용)
- [ ] 이벤트/타이머/구독을 등록했다면 cleanup을 등록했는가?
- [ ] 객체/함수를 deps로 넣을 때 참조 안정성을 확인했는가? (useMemo/useCallback 검토)
- [ ] 무한 루프를 유발할 수 있는 setState 패턴이 없는가?
- [ ] 언마운트 후 setState 호출을 막기 위한 취소/체크 로직이 있는가?
- [ ] eslint-plugin-react-hooks의 exhaustive-deps 규칙을 활성화했는가?
- [ ] React 18 StrictMode에서 개발 중 double effect로 인한 부작용을 고려했는가?
- [ ] 필요하면 react-query/SWR 같은 라이브러리로 서버 상태 관리를 대체 가능한가?
- [ ] 변경 사항을 로컬에서 프로파일링/테스트로 검증했는가?

참고
- 위 내용은 실무 경험에 기반한 일반적인 권장사항입니다. 상황에 따라 다른 선택이 더 적합할 수 있으니 팀 내 스타일과 코드베이스 맥락을 함께 고려하세요.