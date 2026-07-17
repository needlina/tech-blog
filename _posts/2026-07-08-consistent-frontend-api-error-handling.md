---
title: "프론트엔드에서 API 에러를 일관되게 설계하는 실무 가이드"
description: "프론트엔드에서 API 에러 처리를 일관되게 설계하는 방법 프론트엔드 프로젝트를 오래 운영하다 보면 API 에러 처리가 제각각이라 유지보수 비용이 커지는 경우를 자주 보게 됩니다"
date: 2026-07-08 10:00:00 +0900
categories: [React, 실무패턴]
tags: [react, typescript, frontend]
---

프론트엔드에서 API 에러 처리를 일관되게 설계하는 방법 프론트엔드 프로젝트를 오래 운영하다 보면 API 에러 처리가 제각각이라 유지보수 비용이 커지는 경우를 자주 보게 됩니다


프론트엔드에서 API 에러 처리를 일관되게 설계하는 방법

프론트엔드 프로젝트를 오래 운영하다 보면 API 에러 처리가 제각각이라 유지보수 비용이 커지는 경우를 자주 보게 됩니다. 이 글은 React + TypeScript 환경에서 실제로 적용하기 쉬운 패턴과 코드 예시를 중심으로, 실무에서 고려할 점을 정리한 것입니다. 모든 조직에 정확히 맞는 정답은 없을 수 있으니, 제안한 구조를 참고해 팀 컨텍스트에 맞게 조정하시길 권합니다.

목표는 다음과 같습니다.
- 에러 핸들링을 일관된 타입으로 정리해 재사용성을 높인다.
- 사용자에게 과하게 기술적인 메시지를 노출하지 않는다.
- 로깅/관찰(telemetry)과 사용자 피드백 경로를 분리한다.
- 컴포넌트는 API 에러의 UI 표현만 담당하도록 단순화한다.

아래 내용은 fetch 기반의 예시를 중심으로 설명합니다. axios를 쓰는 팀도 비슷한 패턴(인터셉터 사용)으로 적용할 수 있습니다.

---

### 1) 에러 모델을 명확히 하기
우선 프론트엔드에서 다룰 에러의 종류를 간단히 분류합니다.
- 네트워크/타임아웃/취소 (fetch 실패, Abort)
- HTTP 레벨 에러 (401, 403, 404, 5xx 등)
- 비즈니스 레벨 에러 (validation errors, domain error payloads)
- 클라이언트 내부 에러 (파싱 실패, 코드 버그)

TypeScript로 기본 타입을 정의하면 이후 처리 흐름이 단순해집니다.

```ts
// types/api.ts
export type HttpStatus = number;

export interface ApiErrorPayload {
  code?: string; // 서버가 제공하는 에러 코드 (있을 수 있음)
  message?: string; // 사용자에게 보낼 설명(있을 수 있음)
  details?: Record<string, any>; // validation 등 추가 정보
}

export class ApiError extends Error {
  public status?: HttpStatus;
  public payload?: ApiErrorPayload;
  public isNetworkError: boolean = false;
  public isCanceled: boolean = false;

  constructor(message: string, opts?: { status?: HttpStatus; payload?: ApiErrorPayload; isNetworkError?: boolean; isCanceled?: boolean }) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ApiError';
    this.status = opts?.status;
    this.payload = opts?.payload;
    if (opts?.isNetworkError) this.isNetworkError = true;
    if (opts?.isCanceled) this.isCanceled = true;
  }
}
```

이 구조로 에러를 감싸두면 컴포넌트나 상위 훅에서 일관된 방식으로 판별할 수 있습니다.

---

### 2) API 호출 래퍼 만들기 (fetch 예시)
공통 처리는 한 곳에서 관리하는 편이 실무에서 편합니다. 다음은 간단한 fetch 래퍼 예시입니다.

```ts
// lib/apiClient.ts
import { ApiError } from './types/api';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};

export async function apiFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const signal = controller.signal;

  // caller가 필요하면 AbortController를 반환하거나 외부에서 주입할 수 있음
  const mergedInit: RequestInit = {
    credentials: 'include',
    headers: DEFAULT_HEADERS,
    ...init,
    signal,
  };

  try {
    const res = await fetch(input, mergedInit);

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      // 서버가 에러 페이로드를 준다면 파싱해서 ApiError에 담아 던집니다.
      const payload = (data && typeof data === 'object') ? data : undefined;
      throw new ApiError(payload?.message || `Request failed with status ${res.status}`, { status: res.status, payload });
    }

    return data as T;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new ApiError('Request canceled', { isCanceled: true });
    }
    if (err instanceof ApiError) {
      throw err;
    }
    // 네트워크/파싱 에러 등
    throw new ApiError(err?.message || 'Network error', { isNetworkError: true });
  }
}
```

이 방식은 다음 장점이 있습니다.
- 모든 요청이 동일한 에러 타입(ApiError)으로 반환되어 컴포넌트에서 판별이 쉬움
- status 및 payload를 통해 세부 처리가 가능

단점으로는 fetch에 따른 브라우저 차이나 폴리필 이슈가 있을 수 있으니 팀 상황에 맞게 조정해야 합니다.

---

### 3) 훅으로 묶기: 컴포넌트는 최소한의 책임만
컴포넌트 수준에서는 로딩/성공/실패 UI를 담당하도록 단순화합니다. 예시로 커스텀 훅을 만듭니다.

```tsx
// hooks/useApi.ts
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/apiClient';
import { ApiError } from '../types/api';

export function useApi<T>(getPromise: () => Promise<T> | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let mounted = true;
    const p = getPromise();
    if (!p) return;

    setLoading(true);
    setError(null);

    p.then((res) => {
      if (!mounted) return;
      setData(res);
    }).catch((e) => {
      if (!mounted) return;
      setError(e instanceof ApiError ? e : new ApiError(e?.message || 'Unknown error'));
    }).finally(() => {
      if (!mounted) return;
      setLoading(false);
    });

    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error };
}
```

컴포넌트 사용 예:

```tsx
function Profile({ userId }: { userId: string }) {
  const { data, loading, error } = useApi(() => apiFetch(`/api/users/${userId}`), [userId]);

  if (loading) return <div>로딩중...</div>;
  if (error) {
    if (error.isNetworkError) return <div>네트워크 오류가 발생했습니다. 다시 시도해 주세요.</div>;
    if (error.status === 401) return <div>로그인이 필요합니다.</div>;
    return <div>{error.payload?.message ?? '오류가 발생했습니다.'}</div>;
  }
  return <div>이름: {data?.name}</div>;
}
```

---

### 4) 전역 에러/토스트/로깅 분리
사용자 메시지(UX)와 내부 로깅(Sentry, Datadog 등)은 분리하는 것이 좋습니다. 예를 들어 전역 ErrorProvider를 두고, 특정 고의적 에러(예: 인증 실패)는 전역에서 로그인 모달을 띄우고, 나머지는 컴포넌트 레벨에서 처리할 수 있게 합니다.

- 전역 처리: 인증(401), 전역 서버 점검(5xx, 특정 코드), 공통 푸시(예: 서비스 중단 메시지)
- 로컬 처리: 폼 검증 오류(필드별), 페이지 한정 리소스 로드 실패

또한 사용자에게 보여줄 메시지는 서버의 raw message를 그대로 쓰기보다는 i18n 키나 친절한 문장으로 매핑하는 게 보통 안전합니다.

---

### 5) 인증 토큰 갱신(자동 재요청) 패턴
토큰 만료가 흔한 경우, 인터셉터(axios)나 공통 래퍼에서 401을 감지해 refresh token 흐름을 넣는 방식을 자주 씁니다. 구현 시 주의할 점:
- 동시 요청에서 중복된 refresh 요청을 막기 (mutex 또는 queue)
- refresh 실패 시 모든 대기 요청을 실패 처리하고 사용자 재로그인 유도
- 토큰 갱신 로직은 서버 명세에 따라 달라짐

간단한 의사 코드:

```ts
// pseudo: 한 번만 refresh 시도하고 대기중인 요청을 재시도
let refreshing: Promise<void> | null = null;

async function fetchWithAutoRefresh(input: RequestInfo, init?: RequestInit) {
  try {
    return await apiFetch(input, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      if (!refreshing) {
        refreshing = doRefreshToken().finally(() => { refreshing = null; });
      }
      await refreshing;
      return apiFetch(input, init); // 재시도 (토큰이 갱신되었을 것이라 가정)
    }
    throw err;
  }
}
```

이 패턴은 편리하지만 race condition이나 무한 재시도 루프 등에 주의해야 합니다.

---

### 6) 폼 검증/필드 에러 처리 (422 예시)
서버가 필드별 에러를 내려주는 경우, 이를 폼 라이브러리(react-hook-form 등)에 매핑하면 UX가 좋아집니다.

```ts
// 서버 응답 예: { message: 'Validation failed', details: { email: 'invalid', password: 'too short' } }
if (error.status === 422 && error.payload?.details) {
  // react-hook-form의 setError 사용
  // Object.entries(error.payload.details).forEach(([field, msg]) => setError(field, { type: 'server', message: msg }));
}
```

항상 모든 필드가 클라이언트에 있는 것은 아니므로 매핑 시 안전하게 처리하세요.

---

### 7) 테스트와 모니터링
- 에러 매핑 로직(HTTP -> ApiError) 단위 테스트를 작성하세요.
- E2E에서 서버가 실패 상태일 때의 UI 흐름을 검증하세요.
- Sentry 같은 도구를 통해 실제 발생한 에러 유형과 빈도를 모니터링하면, UX 우선순위를 정하는 데 도움이 됩니다.

---

### 8) 기타 고려사항(권장되거나 상황에 따라 다름)
- 타임아웃: fetch는 기본 타임아웃이 없으니 직접 구현해야 할 수 있습니다.
- 재시도 전략: 500/429 등에 대해 지수 백오프(retry with backoff)를 고려할 수 있습니다.
- 요청 취소: 컴포넌트 언마운트 시 불필요한 setState 를 막기 위해 AbortController을 사용하는 것이 일반적입니다.
- 민감한 에러 메시지(서버 스택 등)는 로그로만 남기고 사용자에게는 노출하지 않는 것이 보통 안전합니다.

---

실무 체크리스트
- [ ] ApiError 같은 공통 에러 타입을 정의했는가?
- [ ] 모든 API 호출이 공통 래퍼(apiFetch / axios 인스턴스)를 거치도록 했는가?
- [ ] 네트워크/취소/HTTP/비즈니스 에러를 구분해서 처리하도록 구성했는가?
- [ ] 인증 토큰 만료 시 안전한 refresh/재시도 로직을 구현했는가? (동시성 고려)
- [ ] 폼 필드 에러(422 등)를 UI 라이브러리와 매핑하는 인터페이스가 있는가?
- [ ] 사용자에게 보여줄 메시지와 내부 로깅을 분리했는가?
- [ ] AbortController나 equivalent로 요청 취소 처리를 하고 있는가?
- [ ] 에러 매핑 및 핵심 흐름에 대한 단위 테스트가 있는가?
- [ ] Sentry/Datadog 등으로 실제 에러를 모니터링하고 있는가?
- [ ] 민감한 서버 메시지를 그대로 노출하지 않도록 검토했는가?

마무리: 위 패턴들은 대부분의 React/TypeScript 프로젝트에서 적용할 수 있는 출발점입니다. 팀의 API 규격(에러 페이로드 구조, 인증 방식 등)에 따라 세부 구현은 달라질 수 있으니, 우선 공통 래퍼와 일관된 에러 타입을 도입해 작은 범위부터 적용해 보시길 권합니다.