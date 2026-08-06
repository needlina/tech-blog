---
title: "React 폼 비동기 제출 중 중복 타임아웃 피드백 처리 패턴"
description: "대형 폼이나 네트워크가 불안한 환경에서 중복 제출 방지, 요청 타임아웃 처리, 사용자 피드백 설계와 서버 검증 포인트를 코드 예시와 재현 명령으로 정리한 실무 가이드"
slug: "react-form-async-submit-duplicate-timeout-feedback-patterns"
date: 2026-08-06 12:00:00 +0900
categories: ["Frontend", "React"]
tags: ["react", "frontend", "form-handling", "비동기", "중복방지"]
image:
  path: /assets/img/posts/blog/react-form-async-submit-duplicate-timeout-feedback-patterns/preview.png
  alt: "비동기 폼 안정화 썸네일"
---

비동기 제출 폼에서 흔히 겪는 문제는 사용자가 같은 버튼을 여러 번 누르거나, 요청이 느려서 사용자가 다시 제출하는 경우입니다. 핵심은 **클라이언트에서 중복 시도 예방 + 명확한 피드백 + 서버에서의 중복 방지(idempotency)** 세 축을 조합해 검증 가능한 흐름으로 만드는 것입니다. 실무 확인 포인트는 버튼 상태, 네트워크 타임아웃(예: 5000ms 기준), idempotency key 존재 여부, 서버 로그(요청 ID, 응답 코드)입니다.

문제 상황과 재현 방법
- 상황 A: 대용량 업로드나 느린 API에서 사용자가 제출 버튼을 여러 번 눌러 중복 레코드가 생성된다.
- 상황 B: 네트워크가 느려서 클라이언트 타임아웃으로 요청이 취소되었으나 서버에는 여전히 처리 중인 경우가 있어 최종 상태가 불분명하다.
- 상황 C: 피드백이 부족해 사용자가 여러 번 시도하고 상태가 꼬인다.

간단 재현 명령(로컬 개발 서버 예시)
- 로컬 서버가 0.5초 지연 응답을 반환하도록 만들었다면, 클라이언트 타임아웃을 300ms로 설정해 타임아웃 상황을 재현할 수 있습니다.
- 네트워크 지연을 Linux에서 에뮬레이트:
  - sudo tc qdisc add dev eth0 root netem delay 300ms loss 1%
  - 제거: sudo tc qdisc del dev eth0 root netem
- Chrome DevTools → Network → Throttling에서 “Slow 3G” 선택

실무적으로 고려할 핵심 패턴 요약
- 클라이언트
  - **버튼 비활성화 + 로딩 표시**: 즉각적인 중복 클릭 방지.
  - **Debounce/Throttle**: 연속 입력에서 중복 이벤트 필터링 (예: debounce 300ms).
  - **AbortController / axios timeout**: 느린 요청을 명시적으로 취소.
  - **Idempotency key 전송**: 동일 요청을 구분할 고유 값 헤더 전송.
  - **낙관적/비관적 응답 처리 기준**: 성공을 즉시 반영할지, 서버 확인 후 반영할지 선택.
- 서버
  - **idempotency key 저장 및 체크**: 동일 키로 들어온 요청을 중복 처리하지 않음.
  - **타임아웃 설정과 롤백 정책**: DB 트랜잭션 장시간 대기 방지.
  - **각 요청에 고유 Request ID 로깅**: 재현과 포렌식을 위해 필요.

비교 표 — 선택 기준(간단)

| 목적 | 빠른 UX | 확실한 중복 방지 | 구현 난이도 |
|---|---|---|---|
| 버튼 비활성화 | 높음 | 낮음(클라이언트만) | 낮음 |
| debounce 300ms | 중간 | 낮음 | 낮음 |
| idempotency key | 낮음(지연 가능) | 높음 | 중간 |
| 서버-side unique constraint | 낮음 | 매우 높음 | 중간 |

**주의**: 버튼 비활성화만으로는 네트워크 재시도나 백엔드 중복 처리 문제를 완전히 막을 수 없습니다.

구현 예시 — 실패 예시와 수정 예시
- 환경: React 18.2.0, Axios 1.3.5, Node 18.16.0
- 실패 예시 의도적 단순화: 버튼 상태 처리 없이 fetch로 전송만 하는 경우

실패 예시 (문제점: 반복 클릭 허용, 타임아웃 없음)
```jsx
// 실패 예시
function SubmitForm() {
  const [data, setData] = useState('');
  const submit = () => {
    fetch('/api/submit', {
      method: 'POST',
      body: JSON.stringify({ data })
    }).then(r => r.json()).then(console.log);
  };

  return <button onClick={submit}>제출</button>;
}
```

수정 예시 (권장 조합: disable + AbortController + idempotency key)
```jsx
import { useState, useRef } from 'react';

function SubmitForm() {
  const [data, setData] = useState('');
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef(null);

  const submit = async () => {
    if (loading) return; // 중복 방지
    setLoading(true);
    // 새로운 AbortController 생성
    controllerRef.current = new AbortController();
    const idempotencyKey = crypto.randomUUID(); // 브라우저 지원 환경 가정

    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({ data }),
        signal: controllerRef.current.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      console.log('응답', body);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('요청 취소됨');
      } else {
        console.error('전송 실패', err);
      }
    } finally {
      setLoading(false);
    }
  };

  return <button onClick={submit} disabled={loading}>{loading ? '전송 중...' : '제출'}</button>;
}
```
설명 포인트
- **Idempotency-Key**: 서버가 동일 키를 본 적 있으면 중복 처리 차단 또는 이전 결과 재전송.
- AbortController로 사용자가 취소하거나 타임아웃 처리(클라이언트에서 타임아웃을 구현하려면 setTimeout으로 controller.abort)를 명시적으로 호출.

Axios 타임아웃 예시(대체 방법)
```js
// axios 설정 예시
import axios from 'axios';
const instance = axios.create({
  timeout: 5000, // 5000ms 이후 자동 에러
  headers: { 'Idempotency-Key': uuidv4() }
});
```

서버 측 확인 포인트
- 요청 수신 로그: Request-ID 또는 Idempotency-Key 로깅(예: "RequestID: 1234, Key: abc-123").
- DB 제약 조건: 중복이 허용되지 않는 필드는 고유 제약 추가 (예: UNIQUE(user_id, external_id)).
- 처리 정책 예시:
  - 받고 있는 Idempotency-Key가 이미 존재하면 이전 응답(200 또는 409을 선택적으로) 재전송.
  - 처리 중(처리중 상태)인 키가 있으면 202 Accepted + 상태 조회 엔드포인트를 안내.
- 서버 시간 초과 권장 값: **서버 타임아웃은 클라이언트 타임아웃보다 충분히 크게** 설정해 부분완료를 막을 수 있다. 예: 클라이언트 5000ms라면 서버는 최소 10초 이상(요청당 비용 기준 조정).

검증 방법과 재현 명령
- 같은 Idempotency-Key로 두 번 요청 테스트:
  - curl -v -X POST http://localhost:3000/api/submit -H "Idempotency-Key: abc-123" -d '{"data":"x"}'
  - 반복해서 같은 키로 호출하고 서버 로그/응답이 중복 생성 없이 동일 응답을 반환하는지 확인
- 클라이언트 타임아웃 재현:
  - curl --max-time 3 http://localhost:3000/slow-endpoint
  - 서버는 5초 후에 200을 응답하도록 하여 클라이언트 타임아웃(3s) 발생 확인
- 네트워크 조건 테스트:
  - 위의 tc 명령으로 지연 추가 후 브라우저에서 폼 동작 확인
- 로그 확인 포인트:
  - request-id, idempotency-key, 시작/종료 타임스탬프, DB 트랜잭션 상태
- 자동화된 테스트(예시, Jest + msw):
  - msw로 지연 응답 시나리오를 만들어 버튼 두 번 클릭 후 서버에 요청이 하나만 가는지 테스트


간단 점검 목록(빠른 확인 항목)
- 클라이언트
  - 버튼이 제출 중에 disabled 상태인지 확인
  - 네트워크 패널에서 요청이 중복으로 발생하지 않는지 확인
  - Idempotency-Key 헤더가 포함되는지 확인
  - AbortController나 라이브러리 타임아웃이 설정되어 있는지 확인
- 서버
  - Idempotency-Key를 로그와 DB에 저장하고 있는지
  - 동일 키의 재요청 처리 정책(응답 코드·내용)이 문서화되어 있는지
  - DB 유니크 제약 또는 트랜잭션 정책으로 중복을 방지하는지
- 재현/테스트
  - curl/--max-time, tc, Chrome Throttling을 이용해 테스트 케이스 확보

간단 FAQ
Q: AbortController와 axios timeout 중 어느 것을 써야 하나요?
A: 둘은 목적이 약간 다릅니다. axios timeout 설정은 내부적으로 요청을 실패 처리하지만, AbortController는 사용자가 직접 취소하거나 컴포넌트 언마운트 시 요청을 정리할 수 있어 **컴포넌트 수명과 연동하려면 AbortController를 권장**합니다. 둘을 병행해도 무방합니다.

Q: Idempotency-Key는 어떤 값으로 만들면 좋은가요?
A: UUIDv4 같은 충분히 랜덤한 값이 일반적입니다. 클라이언트에서 재시도 시 같은 키를 재사용해야 의미가 있습니다. 요청을 다시 시도하는 로직이 자동으로 키를 바꾸면 idempotency를 잃습니다.

결론 정리 — 먼저 확인할 것과 다른 선택지를 고려할 시점
- 먼저 확인할 것(우선순위)
  1. UI에서 제출 버튼 클릭 시 네트워크 요청이 한 번만 발생하는지 브라우저 Network 탭으로 확인
  2. 서버 로그에 Request ID와 Idempotency-Key가 찍히는지 확인(없으면 로깅부터)
  3. 클라이언트와 서버의 타임아웃 값 비교(클라이언트 < 서버 권장)
- 다른 선택지를 고려할 때
  - 서버에서 완전한 중복 방지를 원하면 **idempotency key + DB unique 제약** 조합이 필요합니다.
  - UX를 최우선으로 하면 낙관적 업데이트(로컬 먼저 반영)를 쓰되 오류 롤백 절차를 명확히 설계하세요.
  - 모바일이나 불안정 네트워크가 많다면 자동 재시도 로직(백오프, 최대 1~2회) + idempotency 키 조합을 추천합니다.

폼 중복 제출 문제는 UI 상태만 보면 해결된 것처럼 보이지만, 실제 사고는 서버 재시도와 느린 응답에서 많이 난다. 최소한 `disabled`, `Idempotency-Key`, 서버 로그, DB 제약 조건까지 한 번에 확인해야 같은 문제가 다시 생겼을 때 원인을 좁히기 쉽다.

## 함께 보면 좋은 글

- [React 상태 복원 패턴: 새로고침과 탭 종료 후 상태 유지](/posts/react-state-persistence-refresh-tab-restore/)
- [React 폼 복잡성 줄이기: 비동기 검증과 서버 유효성 정리](/posts/react-form-complexity-reduce-async-server-validation/)
- [Vue 폼 접근성과 서버 유효성 검증 통합 체크리스트](/posts/vue-form-accessibility-server-validation-checklist/)
