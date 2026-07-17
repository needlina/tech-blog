---
title: "Vite + React + TypeScript: 실무에 맞는 폴더 구조 설계 가이드"
description: "소개 --- Vite + React + TypeScript 조합은 빠른 개발 경험과 타입 안정성을 제공해서 최근 프론트엔드에서 널리 쓰입니다. 프로젝트가 커지면 폴더 구조가 유지보수성과 생산성에 큰 영향을 미치는데, 이 글에서는 실무에서 자주 마주치는 요구(협업, 코드"
date: 2026-07-06 10:00:00 +0900
categories: [React, 실무패턴]
tags: ["react", "typescript", "vite", "폴더구조", "실무패턴"]
---


Vite 기반 React 프로젝트의 폴더 구조 설계

소개
---
Vite + React + TypeScript 조합은 빠른 개발 경험과 타입 안정성을 제공해서 최근 프론트엔드에서 널리 쓰입니다. 프로젝트가 커지면 폴더 구조가 유지보수성과 생산성에 큰 영향을 미치는데, 이 글에서는 실무에서 자주 마주치는 요구(협업, 코드 재사용, 테스트, 빌드)를 고려한 폴더 구조 설계 접근법을 제안합니다. 절대 정답은 아니고, 팀 상황과 도메인에 따라 달라질 수 있으니 참고용으로 보시면 좋겠습니다.

핵심 설계 원칙
---
- 가독성 우선: 새로 들어온 개발자가 빠르게 프로젝트 구조를 이해할 수 있어야 합니다.
- 독립성(캡슐화): 도메인(피쳐) 단위로 묶어 내부 구현을 바깥에 노출하지 않도록 합니다.
- 변경 용이성: UI, 비즈니스 로직, 네트워크 계층이 서로 최소한으로 결합되도록 합니다.
- 확장성: 초기엔 간단하게 시작하되, 성장에 맞춰 구조를 확장할 수 있게 만듭니다.
- 빌드/번들러 제약 최소화: Vite의 기능(public, index.html, alias 등)을 고려합니다.

구조 전략: feature-based vs layer-based
---
두 가지 대표 전략이 있습니다. 상황에 따라 혼용해도 됩니다.

- Layer-based (기술 기준): components/, pages/, hooks/, services/ 등 기술별로 분리  
  - 장점: 기술별 작업에 익숙한 개발자에겐 직관적
  - 단점: 한 feature를 수정할 때 여러 폴더를 오가야 할 수 있음

- Feature-based (도메인/화면 기준): features/ 또는 modules/ 아래에 도메인 단위로 묶음  
  - 장점: 기능 변경 시 관련 파일이 한 곳에 모여 있어 수정이 쉬움
  - 단점: 공통 컴포넌트를 재사용할 때 경로가 길어지거나 중복 관리 필요

실무에선 feature-based를 기본으로 두되, design-system(공통 UI)과 같은 레이어를 따로 두는 하이브리드 방식을 추천합니다.

권장 폴더 구조 예시
---
아래 구조는 소규모~중간 규모 애플리케이션을 염두에 둔 예시입니다. 필요에 따라 폴더를 추가/축소하세요.

```
/
├─ index.html
├─ vite.config.ts
├─ package.json
├─ tsconfig.json
├─ public/
│  └─ favicon.ico
└─ src/
   ├─ main.tsx
   ├─ App.tsx
   ├─ pages/                # 라우트 페이지(간단한 앱에서 사용)
   ├─ features/             # 도메인/피쳐 기반 코드
   │  ├─ auth/
   │  │  ├─ components/
   │  │  ├─ hooks/
   │  │  ├─ api.ts
   │  │  ├─ types.ts
   │  │  └─ index.ts
   │  └─ todo/
   ├─ components/           # 전역적으로 재사용되는 컴포넌트(디자인 시스템)
   ├─ hooks/                # 전역 훅
   ├─ libs/                 # 외부 래퍼(axios, i18n 초기화 등)
   ├─ stores/               # 상태 관리(zustand/redux 등)
   ├─ assets/
   ├─ styles/               # 글로벌 스타일, 변수
   ├─ utils/
   ├─ types/                # 글로벌 타입 선언(공통)
   └─ routes.tsx
```

각 폴더 설명 (실무 관점)
---
- src/features/*  
  - 도메인(예: auth, todo, product) 별로 컴포넌트, 훅, API, 타입을 모아둡니다. 한 기능을 수정할 때 파일들이 한곳에 모여 있어 편합니다.
  - index.ts로 외부에 노출할 API(컴포넌트/훅/유틸)를 제한적으로 재수출(re-export)하면 캡슐화에 도움이 됩니다.

- src/components/  
  - 버튼, 입력, 레이아웃 같은 디자인 시스템/공통 컴포넌트. 디자인 토큰(변수)나 스타일 가이드에 따라 관리합니다.

- src/hooks/  
  - 프로젝트 전체에서 재사용되는 커스텀 훅. 피쳐 전용 훅은 해당 피쳐 폴더에 둡니다.

- src/libs/  
  - axios 인스턴스, i18n 초기화, date-utils 래퍼 등 외부 라이브러리의 설정을 모아둡니다.

- src/stores/  
  - 전역 상태 관리 로직. Redux/RTK, Zustand 등을 선택할 수 있고, 상태가 큰 경우 feature 슬라이스로 분리합니다.

- src/routes.tsx 또는 src/pages/  
  - React Router 설정. 페이지 파일은 pages/에 두고 각 페이지에서 features/components를 조합합니다.

TypeScript + Vite 실무 설정 예시
---
tsconfig에서 path alias 설정 후 Vite에서 매핑해주는 방식이 일반적입니다.

tsconfig.json (일부)
```json
{
  "compilerOptions": {
    "baseUrl": "src",
    "paths": {
      "@/*": ["*"],
      "@components/*": ["components/*"],
      "@features/*": ["features/*"],
      "@libs/*": ["libs/*"]
    }
  }
}
```

vite.config.ts (일부)
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // 필요 시 alias 직접 지정 가능
})
```

간단한 코드 예제: feature 내부 컴포넌트와 API
---
src/features/todo/api.ts
```ts
import axios from '@libs/axios' // libs에서 axios 인스턴스 관리

export type Todo = {
  id: string
  title: string
  completed: boolean
}

export async function fetchTodos(): Promise<Todo[]> {
  const { data } = await axios.get('/todos')
  return data
}
```

src/features/todo/components/TodoList.tsx
```tsx
import React, { useEffect, useState } from 'react'
import { fetchTodos, Todo } from '../api'

export default function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let mounted = true
    setLoading(true)
    fetchTodos()
      .then(data => mounted && setTodos(data))
      .catch(err => {
        // 에러 처리: 실제론 toast나 에러 페이지 등으로 대체
        console.error(err)
      })
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [])

  if (loading) return <div>로딩중...</div>
  return (
    <ul>
      {todos.map(t => (
        <li key={t.id}>{t.title}</li>
      ))}
    </ul>
  )
}
```

재수출(barrel) 패턴 예시
---
feature/index.ts
```ts
export { default as TodoList } from './components/TodoList'
export * from './api'
export * from './types'
```
장점: import 경로가 깔끔해집니다.
주의: 너무 큰 barrel 파일은 빌드 시 사이드이펙트를 만들거나 순환 의존(circular dependency)을 유발할 수 있으니 주의하세요.

라우팅 예제 (React Router v6)
---
src/routes.tsx
```tsx
import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import { TodoList } from '@features/todo' // 재수출 사용 예

export default function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/todos" element={<TodoList />} />
      </Routes>
    </BrowserRouter>
  )
}
```

스타일 전략 (실무 팁)
---
- 디자인 시스템이 있다면 components/ 아래에 분리하고 변수(토큰)는 styles/tokens로 관리하세요.
- CSS Modules는 로컬 스코프 관리에 유리합니다. styled-components 또는 Emotion을 사용하면 JS 레벨 테마 작업이 편합니다.
- 글로벌 스타일은 src/styles/global.css 또는 styled-components의 createGlobalStyle에 둡니다.

테스트와 문서화
---
- 각 feature에 unit test와 간단한 통합 테스트를 함께 두는 것이 편합니다 (e.g. features/todo/__tests__).
- Storybook은 UI 컴포넌트 문서화에 유용합니다. 디자인 시스템과 연계하면 재사용성 검증이 쉬워집니다.
- 테스트 코드에서도 가능한 한 외부 의존(네트워크 등)을 모킹해 반복가능한 테스트를 유지하세요.

실무에서 자주 마주치는 문제와 회피법
---
- 순환 의존(circular dependency): barrel 파일이 원인인 경우가 많습니다. 파일 간 의존도를 낮추고, utils 또는 types 같이 공통 모듈을 분리하세요.
- 대형 index.ts 재수출: 작은 규모에선 편하지만, 빌드 성능이나 의존성 추적에 부담을 줄 수 있습니다. 필요한 것만 재수출하는 것이 안전합니다.
- import 경로 길어짐: tsconfig paths를 활용해 @features/todo처럼 짧게 쓰는 편이 가독성에 유리합니다.
- 상태 관리 과도 사용: 간단한 로컬 상태에 굳이 전역 상태를 사용하면 복잡도만 늘어납니다. 필요할 때 도입하세요.

마이그레이션/리팩토링 팁
---
- 기존 layer-based 구조에서 feature-based로 전환할 때는 점진적으로 이동하세요. 예: 하나의 큰 피쳐를 새 구조로 옮겨 테스트 후 나머지로 확장.
- 타입 정의는 초기에 잘 정해두면 리팩토링 시 안전합니다. 하지만 과도한 타입 추상화는 개발 속도를 늦출 수 있으니 균형을 맞추세요.

배포/빌드 관련
---
- public/ 디렉토리는 정적자산을 두고 Vite는 빌드 시 이를 그대로 복사합니다. index.html에서 메타 설정을 관리하세요.
- build 결과물을 확인해 번들 크기와 중복 라이브러리를 점검하세요. 필요하다면 코드 스플리팅(dynamic import)로 라우트 단위 분할을 고려하세요.

마무리: 실무에서의 태도
---
구조는 팀과 프로젝트 특성에 맞춰 지속적으로 조정해야 합니다. 한 번 정하면 끝나는 것이 아니라, 코드가 커지고 난이도가 올라가면 구조를 재검토해야 합니다. 이 글의 제안은 출발점으로 삼아 팀 규칙, 컨벤션, 린트 규칙(ESLint), 포맷터(Prettier), CI 파이프라인과 함께 운영하면 효과적입니다.

실무 체크리스트
---
- 프로젝트 초기 tsconfig paths와 Vite alias가 설정되어 있는가?
- feature(도메인) 단위로 코드가 묶여 있어 관련 파일을 한 번에 찾을 수 있는가?
- 디자인 시스템(공통 컴포넌트)은 components/에 모여 있고, 스타일 토큰은 별도 관리되는가?
- API 통신 로직(axios 등)은 libs/ 또는 features/*/api.ts로 잘 분리되어 있는가?
- 재수출(index.ts)은 편리함과 사이드 이펙트, 순환 의존 가능성을 고려하여 최소화했는가?
- 각 피쳐에 대한 단위/통합 테스트가 있고, Storybook 또는 컴포넌트 문서화가 되어 있는가?
- 불필요한 전역 상태 사용은 없는가? 로컬 상태와 전역 상태의 경계가 명확한가?
- static 파일(public/)과 src/assets의 역할이 명확히 구분되어 있는가?
- 빌드 결과(번들 크기, 중복 라이브러리)를 CI에서 정기적으로 체크하도록 설정했는가?
- 팀 컨벤션(폴더 네이밍, 파일 네이밍, import 순서 등)이 문서화되어 있는가?

참고/권장
- 위 내용은 여러 조직에서 검증된 패턴을 바탕으로 정리한 실무 가이드입니다. 프로젝트 성격(단일 페이지 앱, 마이크로 프론트엔드, 라이브러리 등)에 따라 적절히 조정하시길 권합니다.