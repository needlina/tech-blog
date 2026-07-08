---
title: "TypeScript에서 any 줄이기: 실무 가이드와 점진적 마이그레이션"
date: 2026-07-08 12:00:00 +0900
categories: [React, 실무패턴]
tags: [react, typescript, frontend]
---

오늘의 주제

TypeScript에서 any를 줄이는 실무적인 방법

소개
---
프로젝트가 커지면 any가 여기저기 등장하기 쉽습니다. any는 빠른 해결책이지만 타입 안전성이 떨어지고 런타임 버그로 이어질 가능성이 있습니다. 이 글에서는 "실무" 관점에서 any를 줄이는 전략과 단계별 접근법, 코드 예제, 도구와 체크리스트를 실용적으로 정리합니다. 모든 환경에 완벽히 맞는 정답은 없을 수 있으니, 상황에 맞게 적용하는 것을 권장합니다.

any와 unknown의 차이 (기초)
---
- any: 컴파일러가 타입 검사를 건너뜁니다. 편하지만 타입 안전성 상실.
- unknown: 모든 값을 받을 수 있으나, 사용하려면 타입 좁히기(type narrowing)가 필요합니다. any보다 안전합니다.

간단한 예:
```ts
let a: any = "hello";
let u: unknown = "hello";

const lenA = a.length; // 허용 — 런타임 에러 가능
// const lenU = u.length; // 오류: 객체에 접근하기 전에 좁혀야 함

if (typeof u === "string") {
  const lenU = u.length; // 안전
}
```

실무 전략 (우선순위)
---
1. 점진적 접근: 한 번에 all-or-nothing으로 바꾸려 하지 않습니다. 우선 noImplicitAny 경고를 켜고, 가장 시급한 영역부터 처리합니다.
2. unknown을 사용해 임시 안전망을 만듭니다.
3. API 경계에서 런타임 검증을 적용합니다 (zod, io-ts 등).
4. 타입 추론을 활용하고, as const 같은 키워드로 리터럴 보존.
5. 외부 라이브러리 타입이 없을 때는 최소 선언(declare module)이나 직접 타입 파일을 작성합니다.
6. ESLint 규칙을 통해 점진적 규율을 도입합니다(@typescript-eslint/no-explicit-any).

tsconfig 및 ESLint 설정 팁
---
- tsconfig.json
  - "noImplicitAny": true 로 경고 확인(일부 팀은 먼저 false -> true로 전환 권장).
  - "strict": true 를 켜면 더 많은 검사(점진적으로 켜는 것이 현실적).
  - "skipLibCheck": true 는 빌드 시간을 줄이지만 외부 타입 문제를 숨길 수 있으므로 주의.

- ESLint
  - @typescript-eslint/no-explicit-any: ["error", { "ignoreRestArgs": true }] 처럼 옵션을 줘 예외를 운영.
  - 특정 파일/라인에 대해 // eslint-disable-next-line 사용을 허용하되, 주석에 이유를 남기게 하세요.

API 응답 타입 처리 (실용 예제)
---
API 응답을 any로 받지 않으려면 제네릭을 이용해 타입을 전달하거나 런타임 검증을 병행하는 게 좋습니다.

간단한 제네릭 fetch 유틸:
```ts
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("네트워크 에러");
  const data = await res.json();
  return data as T; // 타입 단언: 런타임 검증이 없으므로 주의
}

// 사용
type User = { id: number; name: string };
const user = await fetchJson<User>("/api/user/1");
```
위 방법은 편리하지만, response가 실제로 User 형태인지 보장하지 않습니다. 실무에서는 zod 같은 런타임 스키마로 검증을 권장합니다:

zod 예:
```ts
import { z } from "zod";

const UserSchema = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof UserSchema>;

async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/api/user/${id}`);
  const parsed = UserSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("응답 스키마 불일치");
  return parsed.data;
}
```

타입 좁히기와 타입 가드
---
런타임 값의 타입을 안전하게 다루려면 타입 가드를 만듭니다.

예:
```ts
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(item => typeof item === "string");
}

function process(v: unknown) {
  if (isStringArray(v)) {
    // 여기서는 v가 string[]으로 좁혀짐
    v.forEach(s => console.log(s));
  } else {
    // 다른 처리
  }
}
```

React 컴포넌트에서 any 줄이기
---
- Props 타입을 명확히 정의하세요.
- React.FC를 무조건 사용하기보다 명확한 함수 시그니처를 쓰는 팀도 있습니다 (취향 차이).
- useState 제네릭을 활용해 초기값 없음(null)을 처리하거나 상태 타입을 분명히 하세요.

예:
```tsx
type Todo = { id: string; title: string; done: boolean };

function TodoItem({ todo }: { todo: Todo }) {
  return <div>{todo.title}</div>;
}

// useState
const [items, setItems] = useState<Todo[] | null>(null);
```

Redux / useReducer에서 Action 타입 안전하게 만들기
---
액션을 any로 처리하면 타입 안전성이 사라집니다. Discriminated union(판별 유니온)을 활용하세요.

```ts
type Action =
  | { type: "add"; payload: { title: string } }
  | { type: "toggle"; payload: { id: string } };

function reducer(state: Todo[], action: Action): Todo[] {
  switch (action.type) {
    case "add":
      return [...state, { id: Date.now().toString(), title: action.payload.title, done: false }];
    case "toggle":
      return state.map(t => (t.id === action.payload.id ? { ...t, done: !t.done } : t));
    default:
      return state;
  }
}
```

외부 라이브러리 타입이 없을 때
---
- DefinitelyTyped(@types/...)를 먼저 검색하세요.
- 없으면 최소 타입 선언 파일을 작성(declare module 'lib';)하거나, 사용 범위를 좁혀서 필요한 타입만 선언합니다.
- 임시로 any를 쓰는 경우 // TODO 주석과 이슈 트래킹을 남기세요.

예:
```ts
// types/external-lib.d.ts
declare module "external-lib" {
  export function doThing(input: unknown): unknown;
}
```

유틸리티 타입 적극 활용
---
- Partial<T>, Required<T>, Pick<T, K>, Omit<T, K>, Record<K, T>, ReturnType<>, Parameters<> 등은 any를 대체할 수 있는 좋은 도구입니다.

예:
```ts
type ApiResponse = Record<string, unknown>;
type Handler = (arg: Parameters<typeof someFn>[0]) => ReturnType<typeof someFn>;
```

점진적 마이그레이션 전략 (실무 플랜)
---
1. tsconfig에서 noImplicitAny를 켜고, 발생하는 경고 목록을 확인.
2. 핵심 도메인(비즈니스 로직, API 경계)부터 타입을 적용.
3. UI 레이어(렌더링 중심)는 마지막에 정리.
4. 큰 파일은 작은 단위로 분리하며 타입을 정의.
5. 테스트(단위/통합)로 러이트 범위를 보호.
6. PR 정책: any 사용 시 코멘트와 사유/대체 계획을 명시.

주의할 점
---
- any를 모두 제거한다고 해서 런타임 버그가 완전히 사라지는 것은 아닙니다. 타입은 도움일 뿐입니다.
- 과도한 제네릭·유틸 타입 남용은 오히려 코드 가독성을 해칠 수 있으니 팀 합의가 필요합니다.
- 성능 이슈(빌드/편집기 반응 속도)가 생기는 경우 tsconfig와 빌드 전략을 조정하세요.

실무 예제: Axios 제네릭 + zod 조합
```ts
import axios from "axios";
import { z } from "zod";

const UserSchema = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof UserSchema>;

async function getUser(id: string): Promise<User> {
  const res = await axios.get(`/api/user/${id}`);
  const parsed = UserSchema.safeParse(res.data);
  if (!parsed.success) throw new Error("Invalid response");
  return parsed.data;
}
```

결론
---
any는 빠른 임시 방편으로 유용하지만, 장기적 관점에서는 비용(디버깅 시간, 버그 위험)이 있습니다. 실무에서는 unknown, 제네릭, 런타임 검증, 유틸리티 타입, 그리고 점진적 마이그레이션 전략을 조합해 any를 줄이는 것이 현실적입니다. 모든 팀과 코드베이스가 다르니 우선순위와 범위를 조정해 적용하세요.

실무 체크리스트
---
- [ ] tsconfig에서 noImplicitAny 켰는지 확인(경고 목록 확보).
- [ ] "핵심 API 경계"에 대해 런타임 검증(zod/io-ts/ajv 등) 적용 계획 수립.
- [ ] 외부 라이브러리 타입이 없는 경우 우선순위별로 타입 선언 파일 작성(또는 @types 검색).
- [ ] ESLint 규칙(@typescript-eslint/no-explicit-any) 도입 및 예외 정책 마련.
- [ ] 코드에 any 사용 시 TODO/이유/대체 계획 주석 남기기.
- [ ] 큰 파일·모듈을 작게 나누어 타입 적용 범위를 좁히기.
- [ ] useState/useReducer/dispatch 등 상태 관리 코드에 명시적 타입 적용.
- [ ] 제네릭 유틸(fetchJson<T>, axios.get<T>) 사용 시 런타임 검증 병행 여부 결정.
- [ ] 팀 합의된 스타일 가이드(예: React.FC 사용 여부, as any 허용 범위) 문서화.
- [ ] 변경 사항을 커밋/PR로 배포하기 전 간단한 테스트(유닛/통합) 실행.

참고(권장)
- zod, io-ts 등 런타임 스키마 라이브러리
- @typescript-eslint 규칙 문서
- DefinitelyTyped 리포지토리

이 글은 실무에서 바로 적용 가능한 패턴을 중심으로 정리한 초안입니다. 프로젝트 상황에 맞게 조정하시길 권합니다.