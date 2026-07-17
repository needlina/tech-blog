---
title: "React Query와 Zustand로 상태를 나누는 실무 가이드 (TypeScript 예제)"
description: "React Query와 Zustand를 함께 사용할 때의 역할 분리"
date: 2026-07-08 09:00:00 +0900
categories: [React, 실무패턴]
tags: [react, typescript, frontend]
---

React Query와 Zustand를 함께 사용할 때의 역할 분리


React Query와 Zustand를 함께 사용할 때의 역할 분리

소개
React Query(이하 RQ)와 Zustand는 각각 서버 데이터 관리와 클라이언트 상태 관리를 위한 훌륭한 도구입니다. 실무에서는 이 둘을 같이 쓰는 경우가 많습니다. 다만 역할을 명확히 나누지 않으면 상태 중복, 데이터 불일치, 복잡한 동기화 로직이 생길 수 있습니다. 이 글은 실무에서 적용하기 쉬운 역할 분리 원칙과 TypeScript 예제를 통한 구현 패턴을 제공합니다. 틀릴 가능성이 있는 부분은 확신어조를 피하고 실무 관점에서 권장되는 방향으로 설명하겠습니다.

기본 원칙(요약)
- 서버(전역) 상태 → React Query: 원천 데이터(REST/GraphQL) 캐시, 페이징, refetch, stale 관리, SSR/하이드레이션.
- 로컬(UI/임시) 상태 → Zustand: 모달, 토글, 폼 드래프트, 편집 중 로컬 상태, 세션 단위의 UI 상태.
- 중복 저장은 피하되, 필요하면 RQ 캐시를 single source of truth로 삼고 Zustand는 참조/뷰 상태만 가짐.
- Optimistic update는 RQ의 cache 조작(setQueryData)을 기본으로 하고, 복잡한 UI 토글 등은 Zustand를 써도 됨.
- 성능을 위해 Zustand는 selector 사용과 미세 분할을 권장.

환경 세팅(간단)
- React Query: @tanstack/react-query, react-query-devtools 등
- Zustand: zustand, 필요하면 zustand/middleware (persist 등)
- TypeScript: 제네릭 타입을 잘 지정하면 컴파일 타임 이점을 얻음

예제 1: 기본 패턴 — 서버 데이터는 React Query, 모달 상태는 Zustand
코드 예제 (TypeScript)

```tsx
// api/posts.ts
export type Post = {
  id: number;
  title: string;
  content: string;
  likes: number;
};

export async function fetchPosts(): Promise<Post[]> {
  const res = await fetch('/api/posts');
  if (!res.ok) throw new Error('fetch posts failed');
  return res.json();
}
```

```tsx
// stores/ui.ts
import create from 'zustand';

type UIState = {
  selectedPostId: number | null;
  isPostModalOpen: boolean;
  openPostModal: (id: number) => void;
  closePostModal: () => void;
};

export const useUIStore = create<UIState>((set) => ({
  selectedPostId: null,
  isPostModalOpen: false,
  openPostModal: (id) => set({ selectedPostId: id, isPostModalOpen: true }),
  closePostModal: () => set({ selectedPostId: null, isPostModalOpen: false }),
}));
```

```tsx
// components/PostList.tsx
import { useQuery } from '@tanstack/react-query';
import { fetchPosts } from '../api/posts';
import { useUIStore } from '../stores/ui';

export function PostList() {
  const { data: posts, isLoading } = useQuery(['posts'], fetchPosts);
  const openPostModal = useUIStore((s) => s.openPostModal);

  if (isLoading) return <div>Loading...</div>;
  return (
    <ul>
      {posts?.map((p) => (
        <li key={p.id}>
          <h3>{p.title}</h3>
          <button onClick={() => openPostModal(p.id)}>Open</button>
        </li>
      ))}
    </ul>
  );
}
```

이 패턴의 장점
- 서버 데이터는 RQ가 관리하므로 페이징/캐시/재요청 정책을 통일할 수 있습니다.
- UI 상태는 즉시 반응해야 하므로 Zustand로 간단히 구현할 수 있습니다.

예제 2: 상세 조회 — RQ로 상세 데이터 불러오기, Zustand로 선택 ID 관리
```tsx
// components/PostDetailModal.tsx
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchPostById, likePost } from '../api/posts';
import { useUIStore } from '../stores/ui';

export function PostDetailModal() {
  const selectedId = useUIStore((s) => s.selectedPostId);
  const close = useUIStore((s) => s.closePostModal);
  const queryClient = useQueryClient();

  const { data: post, isLoading } = useQuery(['post', selectedId], () => fetchPostById(selectedId!), {
    enabled: !!selectedId,
  });

  const mutation = useMutation((id: number) => likePost(id), {
    // optimistic update: RQ 캐시를 우선 수정
    onMutate: async (id) => {
      await queryClient.cancelQueries(['post', id]);
      const previous = queryClient.getQueryData<Post[]>(['posts']);
      // posts 리스트의 likes를 임시로 업데이트
      queryClient.setQueryData(['posts'], (old: any) =>
        old?.map((p: Post) => (p.id === id ? { ...p, likes: p.likes + 1 } : p)),
      );
      queryClient.setQueryData(['post', id], (old: any) => (old ? { ...old, likes: old.likes + 1 } : old));
      return { previous };
    },
    onError: (_err, _id, context: any) => {
      // 롤백
      if (context?.previous) {
        queryClient.setQueryData(['posts'], context.previous);
      }
    },
    onSettled: (data, error, id) => {
      // 서버 데이터와 동기화
      queryClient.invalidateQueries(['posts']);
      queryClient.invalidateQueries(['post', id]);
    },
  });

  if (!selectedId) return null;
  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="modal">
      <h2>{post.title}</h2>
      <p>{post.content}</p>
      <div>Likes: {post.likes}</div>
      <button onClick={() => mutation.mutate(selectedId)}>Like</button>
      <button onClick={close}>Close</button>
    </div>
  );
}
```

설명:
- optimistic update는 RQ cache를 직접 수정(setQueryData)하는 것이 일반적입니다. 이렇게 하면 리스트와 상세가 동시에 반영됩니다.
- 오류 시 이전 값을 복원하도록 onError에서 롤백하는 패턴을 사용합니다.
- Zustand에는 선택 ID와 모달 열림 여부만 저장합니다.

예제 3: 폼(드래프트) 상태 — 서버 데이터는 RQ, 편집중인 폼은 Zustand
편집 폼을 구현할 때 서버에서 받아온 데이터를 곧바로 RQ에서 읽어와 폼 초기값으로 사용하되, 폼의 수정 중인 값은 Zustand(혹은 form 라이브러리)에 저장해 두면 페이지 전환 시에도 드래프트를 쉽게 유지할 수 있습니다.

```tsx
// stores/editPost.ts
import create from 'zustand';

type EditPostState = {
  draft: { title: string; content: string } | null;
  setDraft: (d: { title: string; content: string } | null) => void;
};

export const useEditPostStore = create<EditPostState>((set) => ({
  draft: null,
  setDraft: (d) => set({ draft: d }),
}));
```

컴포넌트에서는 RQ에서 받아온 post를 initial로 사용하고, 사용자가 타이핑하면 setDraft로 상태를 유지합니다. 폼 제출 시 RQ의 mutation을 호출하고, 성공 시 edit store를 비웁니다.

주의 및 팁(실무에서 자주 마주치는 함정)
- 중복 캐시 문제: 같은 데이터(예: posts 리스트와 post 상세)를 RQ와 Zustand에 중복 저장하지 않는 것을 권장합니다. 중복 저장은 싱크 버그의 원인이 됩니다.
- 초기 로딩/하이드레이션: SSR을 사용하는 경우 RQ의 하이드레이션을 고려하세요. Zustand의 persist를 쓸 때는 서버 환경에서의 초기 상태 이슈를 체크해야 합니다.
- selector 사용: Zustand에서 전체 스토어를 읽으면 불필요한 리렌더가 발생할 수 있습니다. 필요한 필드만 선택하도록 selector를 사용하세요.
  - 예: const isOpen = useUIStore(s => s.isPostModalOpen);
- 타입 안전성: store 인터페이스와 API 응답 타입을 분리하고 공통 타입을 재사용하면 혼선이 줄어듭니다.
- 낙관적 업데이트 롤백 로직을 항상 테스트하세요. 네트워크 실패 시 사용자 경험을 고려한 메시징/복원 순서가 필요합니다.

성능 관련 조언
- 큰 리스트를 렌더링할 땐 RQ의 placeholderData, initialData 기능을 활용해 UX를 부드럽게 할 수 있습니다.
- Zustand는 빠르지만, 너무 많은 로직을 한 스토어에 몰아넣으면 관리가 어려우니 도메인별로 스토어를 분리하는 것이 보통 더 나쁠 때가 적습니다.
- Re-render 최적화: RQ 훅(useQuery)에 선택자(select) 패턴을 적용하거나, Zustand의 selector와 react.memo를 함께 사용하세요.

권장 파일/폴더 구조(한 예)
- src/
  - api/ (fetcher, types)
  - stores/ (zustand 스토어들)
  - queries/ (react-query 키와 custom hooks)
  - components/
  - pages/

실무 예시: 리스트 + 편집 플로우 (요약)
1. 페이지 로드: useQuery(['posts'])로 리스트 로드
2. 상세 열기: Zustand에 selectedId 저장 후 useQuery(['post', id])로 상세 로드
3. 편집 버튼: 편집 페이지에서 RQ의 post 데이터를 initial으로 사용, 사용자 입력은 Zustand의 draft에 저장
4. 제출: useMutation으로 서버 전송 → onSuccess에서 queryClient.invalidateQueries(['posts']) 등으로 최신화, edit store 초기화

테스트 및 디버깅 팁
- React Query Devtools로 캐시 상태를 확인하세요.
- Zustand는 store에 직접 접근해서 초기값을 주입하거나 테스트할 수 있습니다.
- 네트워크 실패 시 optimistic update 롤백 동작을 유닛/통합 테스트로 확인하는 것이 실제 운영에서 유용합니다.

주의 문구(겸손하게)
- 여기서 제시한 패턴은 실무에서 흔히 사용되는 접근 방식입니다. 프로젝트 특성(오프라인 지원, 고빈도 실시간 업데이트, SSR 등)에 따라 다른 선택이 더 적절할 수 있습니다. 절대적인 정답은 없으니, 팀의 요구사항에 맞춰 검증해 보시길 권합니다.

실무 체크리스트
- 서버 데이터는 React Query에서만 관리하도록 설계했는가?
- UI/임시 상태(모달, 토글, 폼 드래프트)는 Zustand에 두었는가?
- 같은 데이터를 RQ와 Zustand에 중복 저장하고 있진 않은가?
- optimistic update 시 RQ cache(setQueryData)를 사용하고, 실패 시 롤백 로직이 있는가?
- Zustand에서 selector를 이용해 불필요한 리렌더를 줄였는가?
- TypeScript로 API 응답 타입과 스토어 타입을 분리/재사용하고 있는가?
- SSR/하이드레이션 및 Zustand persist 관련한 초기 상태 문제를 확인했는가?
- React Query Devtools와 로컬 로그로 캐시/스토어 상태를 점검할 수 있는가?
- 롤백/에러 경로(네트워크 실패, 서버 에러)를 UI 레벨에서 테스트했는가?
- 스토어(특히 persist) 버전 변경 시 마이그레이션 전략을 마련했는가?

마무리
RQ와 Zustand는 역할을 명확히 나누면 상호 보완적으로 잘 동작합니다. 실무에서는 단순한 규칙(서버 데이터는 RQ, UI/임시 상태는 Zustand)을 기본으로 삼되, 프로젝트 상황에 맞게 유연하게 조정하는 것이 현실적입니다. 필요하면 작은 PoC를 통해 예상 시나리오(네트워크 실패, 동시성 등)를 검증해 보시길 권합니다.