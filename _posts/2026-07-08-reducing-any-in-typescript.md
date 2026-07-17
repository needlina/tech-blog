---
title: "TypeScript에서 any 줄이기: 실무 가이드와 점진적 마이그레이션"
description: "TypeScript에서 any를 조금씩 줄여가는 방법을 정리해봤습니다"
date: 2026-07-08 12:00:00 +0900
categories: [React, 실무패턴]
tags: [react, typescript, frontend]
---

# 오늘의 주제

TypeScript에서 `any`를 조금씩 줄여가는 방법을 정리해봤습니다.

## 소개

TypeScript를 사용하다 보면 처음에는 빠르게 개발하기 위해 `any`를 많이 사용하게 되는 것 같습니다. 저도 프로젝트를 진행하면서 당장은 편해서 `any`를 사용했던 적이 많았는데, 시간이 지나고 보니 타입이 꼬이거나 예상하지 못한 오류를 찾는 데 시간이 많이 걸렸습니다.

그래서 이번에는 `any`를 무조건 없애는 것이 아니라, 실무에서 조금씩 줄여갈 수 있는 방법들을 공부하면서 정리해봤습니다.

---

# any와 unknown의 차이

제가 처음에는 `unknown`과 `any`가 거의 비슷한 줄 알았는데 실제로는 꽤 차이가 있었습니다.

* `any`

  * 타입 검사를 하지 않습니다.
  * 편하지만 실수하기 쉽습니다.

* `unknown`

  * 어떤 값이든 받을 수 있습니다.
  * 하지만 사용하기 전에 타입을 확인해야 해서 조금 더 안전합니다.

예를 들어,

```ts
let a: any = "hello";
let u: unknown = "hello";

const lenA = a.length;

// const lenU = u.length; // 오류

if (typeof u === "string") {
  const lenU = u.length;
}
```

이렇게 `unknown`은 한 번 확인하는 과정이 필요합니다.

---

# 실무에서는 어떻게 접근하면 좋을까?

제가 찾아보면서 가장 많이 나온 방법들을 정리해봤습니다.

### 1. 한 번에 모두 고치려고 하지 않기

프로젝트가 크다면 모든 `any`를 한 번에 없애기는 어려운 것 같습니다.

그래서 우선 중요한 부분부터 하나씩 수정하는 방법이 현실적인 것 같습니다.

---

### 2. unknown을 먼저 사용하기

당장 타입을 정확하게 만들기 어렵다면 `any` 대신 `unknown`을 사용하는 것도 좋은 방법이라고 합니다.

---

### 3. API는 런타임 검증도 같이 하기

TypeScript는 컴파일 단계에서만 타입을 확인하기 때문에 API 응답이 정말 올바른지는 보장하지 못합니다.

그래서 `zod` 같은 라이브러리를 같이 사용하는 경우가 많았습니다.

---

### 4. 타입 추론 적극 활용하기

TypeScript는 생각보다 타입 추론을 잘해주기 때문에 굳이 모든 곳에 타입을 적지 않아도 되는 경우가 많았습니다.

---

### 5. 외부 라이브러리 타입 작성하기

가끔 타입이 없는 라이브러리를 사용하는 경우가 있는데,

그럴 때는 최소한 필요한 타입만 직접 선언하는 방법도 사용할 수 있습니다.

---

### 6. ESLint 규칙 활용하기

처음부터 막아버리기보다는

`no-explicit-any` 규칙을 이용해서 조금씩 줄여가는 방식도 괜찮아 보였습니다.

---

# tsconfig 설정

제가 공부하면서 자주 보였던 옵션들입니다.

### tsconfig.json

* `noImplicitAny`

  * 암시적인 any를 찾아줍니다.

* `strict`

  * 타입 검사를 훨씬 강하게 해줍니다.

* `skipLibCheck`

  * 빌드는 빨라질 수 있지만 라이브러리 타입 오류를 놓칠 수도 있습니다.

---

# API 응답은 any 대신 제네릭 사용하기

```ts
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error("네트워크 오류");
  }

  return (await res.json()) as T;
}

type User = {
  id: number;
  name: string;
};

const user = await fetchJson<User>("/api/user/1");
```

다만 이 방식도 실제 응답이 `User` 형태인지 확인하는 것은 아니라는 점을 알게 되었습니다.

그래서 실무에서는 `zod`를 같이 사용하는 경우가 많다고 합니다.

```ts
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
});

type User = z.infer<typeof UserSchema>;

async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/api/user/${id}`);

  const parsed = UserSchema.safeParse(await res.json());

  if (!parsed.success) {
    throw new Error("응답 스키마 불일치");
  }

  return parsed.data;
}
```

---

# 타입 가드 활용하기

처음에는 타입 가드가 어려워 보였는데 생각보다 자주 사용하는 것 같습니다.

```ts
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === "string")
  );
}
```

이렇게 만들어 두면 이후에는 안전하게 사용할 수 있습니다.

---

# React에서는?

React에서는 Props 타입을 명확하게 작성하는 것이 가장 기본인 것 같습니다.

```tsx
type Todo = {
  id: string;
  title: string;
  done: boolean;
};

function TodoItem({ todo }: { todo: Todo }) {
  return <div>{todo.title}</div>;
}

const [items, setItems] = useState<Todo[] | null>(null);
```

---

# useReducer에서는 Action 타입 만들기

`any` 대신 판별 유니온을 사용하면 타입 안전성이 좋아집니다.

```ts
type Action =
  | {
      type: "add";
      payload: {
        title: string;
      };
    }
  | {
      type: "toggle";
      payload: {
        id: string;
      };
    };
```

이 방식은 저도 앞으로 많이 사용해보려고 합니다.

---

# 타입이 없는 라이브러리라면?

우선 `@types` 패키지가 있는지 찾아보고,

없다면 필요한 부분만 간단하게 선언하는 방법도 있다고 합니다.

```ts
declare module "external-lib" {
  export function doThing(input: unknown): unknown;
}
```

---

# 유틸리티 타입도 많이 사용하기

TypeScript에는 생각보다 유용한 타입이 많았습니다.

* Partial
* Required
* Pick
* Omit
* Record
* Parameters
* ReturnType

이런 타입들을 잘 활용하면 `any`를 많이 줄일 수 있을 것 같습니다.

---

# 점진적으로 바꾸는 방법

제가 찾아본 내용들을 정리하면 이런 순서가 가장 현실적인 것 같습니다.

1. noImplicitAny 켜기
2. API와 비즈니스 로직부터 수정하기
3. UI는 나중에 정리하기
4. 큰 파일은 나누기
5. 테스트하면서 수정하기
6. PR에서 any 사용 이유 남기기

---

# 주의할 점

무조건 `any`를 없앤다고 해서 모든 문제가 해결되는 것은 아닌 것 같습니다.

또 너무 복잡한 제네릭을 사용하면 오히려 읽기 어려워질 수도 있어서 적절한 균형이 중요한 것 같습니다.

---

# Axios + Zod 예제

```ts
import axios from "axios";
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
});

type User = z.infer<typeof UserSchema>;

async function getUser(id: string): Promise<User> {
  const res = await axios.get(`/api/user/${id}`);

  const parsed = UserSchema.safeParse(res.data);

  if (!parsed.success) {
    throw new Error("Invalid response");
  }

  return parsed.data;
}
```

---

# 마무리

예전에는 `any`를 사용하는 것이 크게 문제라고 생각하지 않았는데, 공부하면서 조금씩 줄여가는 것이 유지보수나 안정성 측면에서 훨씬 도움이 된다는 것을 알게 되었습니다.

물론 모든 프로젝트에서 `any`를 완전히 없애는 것은 쉽지 않을 것 같습니다.

그래도 `unknown`, 제네릭, 타입 가드, 런타임 검증 등을 적절히 활용하면 조금씩 더 안전한 코드로 개선할 수 있을 것 같습니다.

저도 앞으로 프로젝트를 진행하면서 하나씩 적용해보려고 합니다.

---

# 체크리스트

* [ ] noImplicitAny 설정 확인
* [ ] API 응답 검증 방식 정하기
* [ ] 외부 라이브러리 타입 확인하기
* [ ] ESLint 규칙 적용하기
* [ ] any 사용 이유 남기기
* [ ] 큰 파일 나누기
* [ ] 상태 관리 타입 명시하기
* [ ] 제네릭 사용 시 런타임 검증 고려하기
* [ ] 팀 스타일 가이드 확인하기
* [ ] 테스트 후 PR 올리기

---

# 참고

* zod
* io-ts
* DefinitelyTyped
* @typescript-eslint 문서

혹시 잘못 이해한 부분이나 더 좋은 방법이 있다면 댓글로 알려주시면 저도 공부하는 데 큰 도움이 될 것 같습니다. 🙂
