---
title: "React Vue 다중 탭 상태 동기화 BroadcastChannel localStorage 충돌 해소"
description: "다중 탭에서 상태가 꼬이는 실제 증상과 확인 지점, BroadcastChannel과 localStorage 기반 전략의 장단점 비교, 재현 명령과 수정 코드 예제, DevTools 확인 방법과 동기화 검증 절차"
slug: "multi-tab-state-sync-broadcastchannel-localstorage-strategies"
date: 2026-08-10 09:00:00 +0900
categories: ["Frontend", "Vue.js"]
tags: ["react", "vue", "broadcastchannel", "localstorage", "상태동기화"]
image:
  path: /assets/img/posts/blog/multi-tab-state-sync-broadcastchannel-localstorage-strategies/preview.png
  alt: "다중 탭 상태 동기화 썸네일"
---

로컬에서는 문제없는데 사용자들이 동시에 여러 탭을 사용하면 상태가 엉키는 상황을 겪을 때, **BroadcastChannel과 localStorage 이벤트를 결합해 충돌을 줄이는 실무적 확인 포인트**를 정리합니다. 설계 검토할 때 약간 망설여지는 부분이 있었습니다.

문제 상황을 먼저 한 문장으로 정리하면: 로그인 토큰 갱신, 장바구니 동시 수정, 또는 UI 토글 상태가 탭 간에 일관되지 않아서 사용자 경험이 깨지는 경우가 잦다. 아래 내용은 증상 재현 명령, 실패 예제, 수정 예제, 검증 방법을 중심으로 구성했습니다.

## 언제 이 글이 도움이 될지 빠르게 확인할 포인트
- 두 개 이상의 브라우저 탭이 동일 origin에서 동시에 상태를 변경할 때 **최근 쓰기 우선 정책으로 데이터 충돌**이 발생한다.
- **BroadcastChannel**은 탭 간 빠른 메시지 전달에 적합하고, **localStorage 이벤트**는 브라우저 재시작 후에도 마지막 상태를 남기는 용도로 결합하면 실무에서 보완된다.
- 검증은 개발자 도구 콘솔에서 브로드캐스트 메시지 로그, Application > Local Storage 값, 그리고 타임스탬프 기반 충돌 로그를 확인하면 된다.

<!-- 이미지1 -->
/assets/img/posts/blog/react-vue-multi-tab-sync-broadcastchannel-localstorage/image-1.webp
*다중 탭 간 메시지 흐름을 단순화한 개념도*

## 문제를 구체적으로 재현하는 방법
재현 환경과 명령어를 명시합니다. 검증 가능하도록 브라우저 콘솔 명령 위주로 적습니다.

환경
- 브라우저: Chromium 계열 또는 Firefox 최신 버전(테스트는 Chromium 기반 100.0+에서 수행)
- 앱: 동일 origin으로 여러 탭 열기
- 검사 항목: DevTools Console, Application > Local Storage

간단 재현 절차
1. 같은 origin에서 탭 A와 탭 B를 연다.
2. 탭 A에서 아래 명령을 실행해 상태를 기록한다.
   - localStorage.setItem('cart', JSON.stringify({items:['apple'], v:1, ts: Date.now()}))
3. 탭 B에서 아래 명령을 실행해 상태를 덮어쓴다.
   - localStorage.setItem('cart', JSON.stringify({items:['banana'], v:1, ts: Date.now()}))
4. 탭 A와 B의 상태를 비교한다.
   - JSON.parse(localStorage.getItem('cart'))

여기서 흔한 문제는 두 탭 모두 같은 버전(v) 값을 쓰거나, ts(타임스탬프) 비교 없이 단순 덮어쓰기만 하는 경우입니다. 이 상태에서 탭 간 업데이트 알림 없이 화면이 갱신되지 않으면 UX 충돌이 발생합니다.

## 왜 localStorage 만으로는 부족한가
- **localStorage는 이벤트를 발생시키지만 같은 탭에서의 setItem은 이벤트를 트리거하지 않음**: 다른 탭에서는 storage 이벤트가 발생하지만, 쓰기를 한 탭 자신은 해당 이벤트를 받지 않는다.
- **동시성 제어가 없음**: 두 탭이 거의 동시에 쓰면 마지막 쓰기가 승리하는 *last-write-wins* 현상이 발생한다.
- **브로드캐스트 전용 메시지 기능 부재**: 메시지 형식을 자유롭게 정의해 빠르게 전달하기 어렵다.

이때 **BroadcastChannel**이 빠른 알림 전달(메시지 기반)을 제공하므로 화면 즉시 갱신에는 유리합니다. 다만 브라우저가 탭을 강제로 종료하거나 재시작하면 BroadcastChannel 메시지는 사라지므로 **지속성은 localStorage로 보완**해야 합니다.

공식 문서 확인 경로(검증 방법)
- MDN BroadcastChannel API: https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- MDN StorageEvent(localStorage): https://developer.mozilla.org/en-US/docs/Web/API/StorageEvent

위 링크에서 브라우저별 지원 여부와 동작 특성을 먼저 확인하세요.

## 실패 예제와 수정 예제 비교
아래 예시는 프레임워크와 독립적인 브라우저 코드입니다. 먼저 실패 예제(동시 쓰기 충돌), 그 다음에 수정 예제(브로드캐스트 + 버전/타임스탬프 기반 충돌 해소)를 보여줍니다.

실패 예제 (간단히 동시 덮어쓰기)
```js
// 탭 A, 탭 B 공통으로 사용
function writeCart(items) {
  const payload = { items, v: 1, ts: Date.now() };
  localStorage.setItem('cart', JSON.stringify(payload));
  // 화면 갱신 알림 없음
}
```

이 코드는 두 탭이 거의 동시에 쓰면 마지막 저장이 모든 것을 결정합니다. 탭 내부에서 자체적으로 화면을 갱신하지 않는다면 사용자는 상태가 반영되지 않은 것으로 보일 수 있습니다.

수정 예제 (BroadcastChannel + 로컬스토리지 동기화, 간단한 충돌 해결)
```js
// 브로드캐스트 채널 초기화
const bc = new BroadcastChannel('app-sync');

// 상태 쓰기 함수
function writeCart(items) {
  const v = (JSON.parse(localStorage.getItem('cart') || '{}').v || 0) + 1;
  const payload = { items, v, ts: Date.now() };
  // 1. 로컬 저장
  localStorage.setItem('cart', JSON.stringify(payload));
  // 2. 탭에게 즉시 알림
  bc.postMessage({ type: 'cart:update', payload });
}

// 메시지 수신 처리
bc.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'cart:update') {
    const remote = ev.data.payload;
    const local = JSON.parse(localStorage.getItem('cart') || '{}');
    // 충돌 해결: v 우선, v 같으면 ts로 최신 판별
    if (!local.v || remote.v > local.v || (remote.v === local.v && remote.ts > local.ts)) {
      localStorage.setItem('cart', JSON.stringify(remote));
      // 화면 갱신 로직 호출 (프레임워크별로 처리)
      // updateUI(remote.items)
    }
  }
});

// localStorage 변경(다른 탭에서만 트리거됨)도 수신해 안전하게 동기화
window.addEventListener('storage', (e) => {
  if (e.key === 'cart' && e.newValue) {
    const remote = JSON.parse(e.newValue);
    // 위와 동일한 충돌 해소 로직을 여기에도 넣는다
  }
});
```

위 패턴의 핵심
- **v(버전)**과 **ts(타임스탬프)**를 모두 포함해서 충돌을 판별
- BroadcastChannel로 즉시 알리고, localStorage는 영구 상태 저장소로 사용
- storage 이벤트도 수신해 탭 간 동기화를 보완

프레임워크별로 적용 예시(간단한 React Hook)
```js
import { useEffect } from 'react';

function useCartSync(updateUI) {
  useEffect(() => {
    const bc = new BroadcastChannel('app-sync');
    const onMessage = (ev) => { /* 위와 동일한 로직으로 updateUI 호출 */ };
    bc.addEventListener('message', onMessage);
    const onStorage = (e) => { if (e.key === 'cart') { /* 동일 처리 */ } };
    window.addEventListener('storage', onStorage);
    return () => {
      bc.removeEventListener('message', onMessage);
      bc.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [updateUI]);
}
```

Vue용 간단한 composable은 구조만 다를 뿐 동일한 처리 로직을 쓴다.

## 실무에서 꼭 확인할 것들 (검증 포인트)
- DevTools Console에 BroadcastChannel 메시지 수신 로그가 출력되는가?
  - 재현 명령: 탭 A에서 bc.postMessage({type:'ping'}); 탭 B의 콘솔에 수신 로그가 있는지 확인
- Application > Local Storage에 저장된 객체에 v와 ts 필드가 있는가?
- 동시 수정(동일 v값을 가진 상태에서 거의 같은 ts로 쓰기) 상황에서 어느 탭의 데이터가 살아남는가?
  - 테스트: 탭 A와 B에서 거의 같은 시간(차이 10ms 이내)으로 writeCart 호출 후 cart 값을 확인
- 네트워크 요청 없이 화면이 즉시 갱신되는가? (BroadcastChannel 없이 localStorage만으로는 즉시 갱신되지 않음)
- 브라우저 재시작 후 마지막 저장값이 보존되는가? (localStorage 검사)

검증 명령 샘플
- 탭 A 콘솔: {% raw %}bc.postMessage({type:'cart:update', payload:{items:['x'], v:2, ts:Date.now()}});{% endraw %}
- 탭 B 콘솔: console.log(JSON.parse(localStorage.getItem('cart')))

(위 BroadcastChannel 직접 호출 샘플은 Jekyll/Liquid 충돌 방지를 위해 raw 블록으로 감쌌습니다.)

<!-- 이미지2 -->
/assets/img/posts/blog/react-vue-multi-tab-sync-broadcastchannel-localstorage/image-2.webp
*브로드캐스트와 로컬 저장소를 조합한 동기화 플로우 다이어그램*

## 선택 기준 표
방법별 장단점과 선택 기준을 짧게 정리합니다.

| 기준 | BroadcastChannel | localStorage 이벤트 |
|---|---:|---|
| 즉시성 | 빠름 | 느림(또는 탭 자신 미수신) |
| 영속성 | 없음 | 있음 |
| 브라우저 지원 | 대부분 지원 | 모든 주요 브라우저 지원 |
| 충돌 제어 | 메시지 설계 필요 | 버전/타임스탬프 로직 필요 |
| 사용 시점 | UI 즉시 갱신, 실시간 협업 | 마지막 상태 저장, 복구용 |

위 표를 기준으로 선택하세요. 예: 즉시 화면 갱신이 1순위면 BroadcastChannel 우선, 복구 보장은 localStorage에 맡기기.

## 실패 케이스 원인별 빠른 판별표
(실무에서 로그만 보고 원인 분류할 때 유용함)

| 증상 | 가능 원인 | 확인 명령 |
|---|---:|---|
| 화면이 즉시 안 바뀜 | BroadcastChannel 메시지 누락 | bc.postMessage로 수동 테스트 |
| 서로 덮어씀 | 버전 관리 누락 | localStorage 값에 v 필드 유무 확인 |
| 재시작 후 상태 불일치 | localStorage에 최신값 미저장 | Application > Local Storage 확인 |
| 특정 브라우저에서 작동 안함 | 브라우저 지원 문제 | MDN 지원표 확인 |

각 항목을 DevTools에서 바로 확인하면 원인을 좁힐 수 있다.

## 추가 고려사항과 한계
- BroadcastChannel 메시지는 탭이 완전히 종료되면 유실될 수 있으니 **복구 가능한 상태는 반드시 localStorage에 남겨야** 한다.
- 탭 간 선출(leader election)을 구현하면 한 탭이 주기적으로 서버 싱크를 담당하게 해 충돌을 더욱 줄일 수 있다. 간단한 선출은 localStorage의 leader 키에 탭 식별자와 ts를 기록하고 주기적으로 갱신하는 방식으로 구현할 수 있다.
- 모바일 브라우저의 백그라운드 탭은 메시지 전달이 지연될 수 있으니 타임아웃과 재시도 로직을 두는 것이 안전하다.
- 보안: 민감한 데이터는 localStorage에 그대로 두지 말고 암호화 또는 세션 토큰 교체 전략을 사용하세요.

## 무엇을 먼저 확인해야 하고 언제 다른 선택지가 나은가
- 먼저 확인할 것: DevTools에서 BroadcastChannel 수신 로그, localStorage에 v/ts 필드 존재, storage 이벤트 수신 여부.
- BroadcastChannel을 도입하지 말아야 할 경우: 브라우저 지원을 보장할 수 없거나 메시지 전달 신뢰도가 너무 낮아야 할 때(이때는 서버 기반 실시간(SSE/WebSocket) 접근 고려).
- localStorage만으로 충분한 경우: 단순한 설정 토글처럼 즉시성 요구가 낮고 마지막 값만 중요할 때.

마지막으로 제가 정리하면서 남긴 검증 체크리스트(개발자 도구에서 단계별 확인)
1. 두 탭을 열고 BroadcastChannel 수동 메시지 전송해 수신 확인
2. 한 탭에서 writeCart 실행 후 다른 탭의 localStorage와 화면 상태 동기화 확인
3. 동시 쓰기(두 탭에서 0~100ms 차) 테스트 후 v/ts 비교 로그 확인
4. 브라우저 재시작 후 Application > Local Storage에 값이 남아있는지 확인

이 글에 있는 코드는 패턴 제안입니다. 실제 앱에서는 프레임워크 상태 관리(store)에 반영하는 부분과 네트워크 재동기화, 보안 관점을 추가로 설계해야 합니다. 필요하면 여기서 제시한 충돌 해결 로직을 React Context나 Vuex/Pinia에 연결하는 예시를 다음 글로 이어서 정리할 수 있습니다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

## 함께 보면 좋은 글

- [React 상태 복원 패턴: 새로고침과 탭 종료 후 상태 유지](/posts/react-state-persistence-refresh-tab-restore/)
- [Vue 트랜지션 애니메이션 렌더 성능 점검 체크리스트](/posts/vue-transition-animation-performance-triage/)
- [Vue 폼 접근성과 서버 유효성 검증 통합 체크리스트](/posts/vue-form-accessibility-server-validation-checklist/)
