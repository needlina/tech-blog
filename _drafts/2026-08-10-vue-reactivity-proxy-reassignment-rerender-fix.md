---
title: "Vue 반응성 Proxy 재할당과 참조 비교로 인한 불필요 리렌더 해결"
description: "대상 컴포넌트가 자식으로 전달한 객체 참조 변경으로 자주 리렌더되는 증상, 재현용 Vite 명령과 Vue 버전, Devtools·console로 확인하는 절차, 수정 방법 세 가지과 적용 후 검증 경로"
slug: "vue-reactivity-proxy-reassignment-rerender-fix"
date: 2026-08-10 09:00:00 +0900
categories: ["Frontend", "Vue.js"]
tags: ["vue", "vue3", "reactivity", "성능튜닝", "로그분석"]
image:
  path: /assets/img/posts/blog/vue-reactivity-proxy-reassignment-rerender-fix/preview.png
  alt: "Vue 반응성 비용 줄이기 썸네일"
---

Vue 반응성에서 Proxy를 **새 객체 재할당**하거나 props로 **새 참조**를 계속 전달하면 의도치 않게 많은 컴포넌트가 리렌더될 수 있다. 짧게 말하면 "참조(identity) 변화가 트리거가 되는 경우"가 핵심이며, Devtools의 렌더 카운트, console 로그, 그리고 간단한 Vite 프로젝트 명령으로 재현과 검증이 가능하다. 구름이 조금 있는 날씨라 코드를 차근히 정리하기 좋았다.

이 글은
- 어떤 코드 패턴이 불필요 리렌더를 유발하는지 (구체 예제),
- 재현 방법과 검사 절차(명령어·버전·로그·Devtools)와
- 실무에서 바로 쓸 수 있는 세 가지 해결책(수정 예제 포함)
를 중심으로 정리한다.

## 문제 상황을 한 문장으로
부모에서 객체를 새로 만들어 자식에 넘기거나 reactive 객체를 통째로 재할당하면 참조가 바뀌어 **자식이 필요 없이 다시 렌더**되는 일이 자주 발생한다.

## 재현 준비와 실행 명령
빠르게 테스트용 프로젝트를 만들려면 Vite 사용이 편하다. 아래는 검증용 최소 절차(로컬에서 실행).

- 요구사항
  - Node 16+ 권장
  - npm 또는 pnpm
  - Vue 3.2 이상(예제는 3.2.x 기준으로 작성)

실행 명령 (터미널)
```
npm init vite@latest vue-rerender -- --template vue
cd vue-rerender
npm install
# package.json의 "vue" 버전 확인: 예 "vue": "^3.2.47"
npm run dev
```

확인할 파일 경로 예시
- src/App.vue
- src/components/Child.vue

## 불필요 리렌더를 재현하는 실패 예제
아래 예시는 부모가 버튼 클릭마다 같은 내용의 새 객체를 만들어 props로 넘기는 경우다. 내용은 동일하지만 참조가 바뀌므로 자식이 렌더된다.

{% raw %}
```vue
<!-- src/App.vue 실패 예 -->
<template>
  <div>
    <button @click="replaceItem">replace item</button>
    <Child :item="item" />
    <p>parent renders: {{ parentRenders }}</p>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import Child from './components/Child.vue'

const state = reactive({ item: { id: 1, name: 'apple' } })
const parentRenders = ref(0)

function replaceItem() {
  // 같은 내용의 새 객체로 교체 -> 참조가 바뀜
  state.item = { id: 1, name: 'apple' }
}

parentRenders.value++
</script>
```
{% endraw %}

Child 컴포넌트에서는 렌더 횟수를 콘솔에 찍도록 했다면 버튼 클릭마다 "Child render" 로그가 보일 것이다. 이건 의도한 데이터 변경이 아니어도 발생한다.

{% raw %}
```vue
<!-- src/components/Child.vue -->
<template>
  <div>{{ item.name }}</div>
</template>

<script setup>
import { onUpdated } from 'vue'
const props = defineProps({ item: Object })
onUpdated(() => console.log('Child updated'))
</script>
```
{% endraw %}

실행 후 동작 확인 포인트
- Devtools Profiler에서 Child 컴포넌트의 render count가 버튼 클릭마다 증가하는지
- 콘솔에 'Child updated'가 찍히는지

문제 원인 핵심: 부모에서 객체를 "재할당"하면 객체의 참조(identity)가 바뀌고, Vue는 그 참조 변화를 기반으로 의존성을 다시 평가한다.

이미지: Vue 반응성 개념 일러스트
![Vue 반응성 개념 일러스트](/assets/img/posts/blog/vue-reactivity-proxy-reassignment-rerender-fix/image-1.webp)
이미지 출처: AI 생성 이미지

## 실패 예제와 수정 예제를 나란히 보기
아래는 같은 목적(값 갱신)이지만 리렌더를 줄이는 방법 두 가지를 보여준다.

- 실패: state.item를 통째로 교체 -> 참조 변경
- 수정 A: 기존 객체의 속성만 변경 -> 참조 유지
- 수정 B: 자식에게 필요한 필드만 primitive로 전달하거나 toRef 사용

{% raw %}
```vue
<!-- 수정 A: 속성만 변경 -->
<script setup>
function updateName(newName) {
  // 참조는 유지, 내부 값만 바꿈
  state.item.name = newName
}
</script>
```
```vue
<!-- 수정 B: toRef로 자식에 명시적 ref 전달 -->
<script setup>
import { toRef } from 'vue'
const itemRef = toRef(state, 'item') // itemRef은 ref로 전달 가능
</script>

<!-- 자식에서는 itemRef.value를 직접 사용 -->
```
{% endraw %}

수정 A는 가장 간단하고 참조를 유지하므로 불필요 리렌더가 줄어드는 경우가 많다. 수정 B는 부모 상태를 그대로 쓰되 자식에서 예상한 방식(ref)을 사용하게 해 **의존성 추적을 명확히** 하는 방법이다.

## 실무에서 선택하는 기준표
아래 표는 상황별로 어떤 방식이 더 적합한지 간단 비교다.

| 상황 | 권장 선택 | 이유 |
|---|---:|---|
| 빈번한 내부 필드 변경 | 속성 변경 (mutate) | 참조 유지로 리렌더 최소화 |
| 큰 객체를 캐시성으로 전달 | shallowRef 또는 markRaw | 깊은 관찰 비용 회피 |
| 자식이 일부 필드만 사용 | toRef / primitive로 분해 | 의존성을 좁혀 불필요 추적 방지 |

**주의**: 객체를 계속 mutate하는 방식은 불변성 패턴을 기대하는 외부 코드(예: Redux 스타일)와 충돌할 수 있으니 팀 컨벤션을 먼저 확인해야 한다.

## Devtools와 콘솔로 검증하는 방법
검증 단계(순서대로 수행)
1. 프로젝트 실행: npm run dev
2. Vue Devtools 열기(브라우저 확장)
   - Profiler 탭에서 기록 시작 -> 버튼 클릭 시 어떤 컴포넌트가 렌더되는지 확인
   - Components 탭에서 각 컴포넌트의 render count, props 변화를 관찰
3. 코드 레벨 로그
   - 자식 컴포넌트에 onUpdated 또는 setup 내 콘솔 로그 추가
   - render 함수에 console.count('Child render') 넣어 횟수 계측
4. 퍼포먼스 타이머
   - console.time/console.timeEnd으로 렌더 시작·끝 시점 측정
5. 브라우저 Performance 탭 스냅샷으로 재사용성(레이아웃/페인트 비용) 확인

예시: 자식 렌더 로그 추가
```
import { onUpdated, onMounted } from 'vue'
onMounted(() => console.log('Child mounted'))
onUpdated(() => console.count('Child render'))
```

## 추가 기법들(상황에 따라)
- shallowRef: 내부 깊은 변경 추적이 필요 없을 때 사용하면 하위 객체 변경으로 부모가 불필요하게 반응하지 않음.
- markRaw: 외부 라이브러리 객체(예: 대형 캔버스 컨텍스트)를 반응성에서 제외.
- computed: 파생 데이터가 자주 재계산될 때 캐시를 활용.
- key 최적화: 리스트 렌더에서 key를 적절히 주지 않으면 재사용이 일어나지 않아 많은 컴포넌트가 새로 마운트될 수 있음.

짧은 비교표

| API | 트래킹 범위 | 주용도 |
|---|---:|---|
| reactive | 깊은 Proxy | 상태 트리 전체 관찰 |
| ref | 단일 값 래핑 | primitive 또는 객체 참조 관리 |
| shallowRef | 얕은 추적 | 참조만 관찰, 내부 수정 무시 |

## 실패 예제 추가와 수정 예시(코드 비교)
아래는 자식에게 map 형태의 데이터를 넘기고, 부모에서 계속 새 Map을 만드는 패턴의 실패와 수정이다.

실패:
```js
// 부모
const mapData = reactive({ m: new Map([[1,'a']]) })
function replaceMap() {
  mapData.m = new Map(mapData.m) // 참조 변경 -> 자식 다시 렌더
}
```

수정 예:
```js
// 부모
function updateMapKey(k, v) {
  mapData.m.set(k, v) // 참조 유지 -> 자식은 필요 시만 반응
}
```

Map/Set 같은 내장 컬렉션은 reactive로 싸더라도 주의가 필요하다. 필요 시 shallowRef로 관리하고 내부 조작은 직접 하는 편이 안전할 수 있다.

이미지: 리렌더 분석 흐름도
![리렌더 분석 흐름도](/assets/img/posts/blog/vue-reactivity-proxy-reassignment-rerender-fix/image-2.webp)
이미지 출처: AI 생성 이미지

## 적용 후 검증 체크포인트
- Devtools Profiler에서 동일 동작 전/후의 render count 비교 (수치로 확인)
- 콘솔 카운트가 줄었는지 확인 (예: Child render 횟수)
- 메모리(Heap) 및 프레임 드랍 여부 간단 확인: 브라우저 Performance 탭에서 프레임 시간 확인
- 린트 규칙이나 팀 컨벤션과 충돌하지 않는지 코드리뷰에서 확인

검증 명령 예
- 개발서버에서 재현: npm run dev
- Devtools 프로파일러로 10회 반복 액션 녹화 후 비교

## 언제 다른 선택지가 더 나은가
- 전체 상태를 불변성으로 관리하는 팀(예: Vuex 또는 Pinia에서 strict 패턴)을 따르는 경우, 객체를 mutate하는 방식이 코드 일관성을 해칠 수 있다. 이때는 참조를 교체하면서도 메모리·성능 영향을 줄이는 방법으로 shallowRef나 memoization을 고려한다.
- 외부 라이브러리 객체(캔버스, 서드파티 인스턴스)는 반응성에서 제외(markRaw)하거나 별도 관리하는 편이 낫다.

## 결론 대신 점검 우선순위
- 먼저 확인할 것: Devtools Profiler에서 어떤 컴포넌트의 render count가 많이 증가하는지, 그리고 그 컴포넌트에 전달되는 props가 클릭 전후에 참조(identity)만 바뀌고 내용은 같은지
- 그 다음 선택 기준: 팀의 상태 관리 스타일(immutable vs mutable), 전달 데이터의 크기와 변경 빈도에 따라 **속성 단위 수정**, **toRef/primitive 분해**, **shallowRef/markRaw** 중에서 선택

추가로 확인할 지점
- 팀 컨벤션(불변성 규칙)과 충돌 여부
- 외부 라이브러리 객체가 reactive로 감싸여 있지 않은지
- 반복 렌더(리스트)라면 key 설정 문제는 없는지

필요하면 해당 프로젝트의 간단한 재현 코드(최소 예제)를 공유해 주시면, Devtools 로그와 코드 조작을 함께 보며 어느 접근이 나을지 구체적으로 제안할 수 있다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

## 함께 보면 좋은 글

- [Vue 트랜지션 애니메이션 렌더 성능 점검 체크리스트](/posts/vue-transition-animation-performance-triage/)
- [Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드](/posts/vue3-reusable-accessible-form-field-guide/)
- [Vue 폼 접근성과 서버 유효성 검증 통합 체크리스트](/posts/vue-form-accessibility-server-validation-checklist/)
