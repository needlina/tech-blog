---
title: "Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드"
description: "Vue 3 기반 재사용 폼 필드 설계 핵심: 라벨과 id 매핑, 에러 힌트 연결, 키보드 접근성, 스크린리더 검증; Node 16 이상, axe, jest-axe, Lighthouse 사용법 및 검증 명령 포함"
slug: "vue3-reusable-accessible-form-field-guide"
date: 2026-08-04 12:00:00 +0900
categories: ["Vue.js", "Frontend"]
tags: ["vue", "vue3", "accessibility", "접근성", "form-component"]
image:
  path: /assets/img/posts/blog/vue3-reusable-accessible-form-field-guide/preview.png
  alt: "폼 컴포넌트 재사용 썸네일"
---

Vue 3에서 폼 필드를 재사용 컴포넌트로 만들 때는 디자인보다 먼저 `label`, `id`, `aria-describedby`, 에러 노출 방식을 고정해 두는 편이 낫습니다. 예전에 입력 컴포넌트를 예쁘게 쪼개 놓고도 스크린리더에서 라벨이 읽히지 않아 다시 갈아엎은 적이 있습니다. 그 뒤로는 폼 컴포넌트를 만들 때 “보이는 UI”보다 “읽히고 이동되는 흐름”을 먼저 확인합니다.

폼 접근성 문제는 대체로 복잡한 곳에서 터지지 않습니다. 라벨과 입력이 연결되지 않았거나, 에러 메시지가 화면에는 보이는데 입력과 연결되지 않았거나, 키보드로 이동했을 때 현재 위치가 불분명한 식입니다. 그래서 재사용 컴포넌트일수록 기본값을 보수적으로 잡아야 합니다.

## 먼저 확인하는 기준

새 폼 필드를 만들 때 저는 아래 다섯 가지를 먼저 봅니다.

- `label[for]`와 `input[id]`가 정확히 연결되는가
- 같은 페이지에 여러 개 렌더링해도 id가 충돌하지 않는가
- 힌트와 에러 메시지가 `aria-describedby`로 연결되는가
- 라벨 클릭과 Tab 이동으로 입력에 접근할 수 있는가
- axe, jest-axe, Lighthouse에서 기본 위반이 없는가

이 기준을 통과하면 디자인 시스템으로 확장해도 덜 흔들립니다.

## 컴포넌트 API는 작게 시작하기

처음부터 모든 폼 케이스를 흡수하려고 하면 컴포넌트가 금방 무거워집니다. 저는 아래 정도로 시작하는 편입니다.

- props: `modelValue`, `label`, `id`, `hint`, `error`
- emits: `update:modelValue`, `blur`, `focus`
- slots: `label`, `hint`, `error`

기본은 prop으로 빠르게 쓰고, 라벨에 아이콘이나 보조 설명이 들어가는 화면만 slot으로 확장합니다. 이 정도면 로그인, 설정, 검색 필터 같은 반복 폼을 대부분 처리할 수 있습니다.

## 실패 예시

아래 코드는 화면만 보면 그럴듯합니다. 하지만 라벨과 입력이 연결되어 있지 않습니다.

{% raw %}

```vue
<template>
  <div class="field">
    <label>Name</label>
    <input
      type="text"
      :value="modelValue"
      @input="$emit('update:modelValue', $event.target.value)"
    />
    <p class="error" v-if="error">{{ error }}</p>
  </div>
</template>

<script setup>
defineProps(["modelValue", "error"]);
</script>
```

{% endraw %}

이 상태에서는 라벨을 클릭해도 입력으로 포커스가 가지 않을 수 있고, 스크린리더가 입력의 이름을 제대로 읽지 못할 수 있습니다. 자동화 검사에서는 “form field has no label” 계열 경고를 보게 됩니다.

## 수정 예시

아래는 제가 기본 형태로 두고 시작하는 패턴입니다.

{% raw %}

```vue
<template>
  <div class="field">
    <label :for="inputId">
      <slot name="label">{{ label }}</slot>
    </label>

    <input
      :id="inputId"
      :value="modelValue"
      :aria-invalid="hasError ? 'true' : 'false'"
      :aria-describedby="describedBy"
      @input="onInput"
      @blur="$emit('blur')"
      @focus="$emit('focus')"
    />

    <p v-if="hint" :id="hintId" class="hint">
      <slot name="hint">{{ hint }}</slot>
    </p>

    <p v-if="error" :id="errorId" class="error" role="alert">
      <slot name="error">{{ error }}</slot>
    </p>
  </div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  modelValue: [String, Number],
  label: {
    type: String,
    required: true
  },
  id: String,
  hint: String,
  error: String
});

const emit = defineEmits(["update:modelValue", "blur", "focus"]);

const fallbackId = `field-${Math.random().toString(36).slice(2, 9)}`;
const inputId = props.id || fallbackId;
const hintId = `${inputId}-hint`;
const errorId = `${inputId}-error`;

const hasError = computed(() => Boolean(props.error));
const describedBy = computed(() => {
  const ids = [];
  if (props.hint) ids.push(hintId);
  if (props.error) ids.push(errorId);
  return ids.length ? ids.join(" ") : undefined;
});

function onInput(event) {
  emit("update:modelValue", event.target.value);
}
</script>
```

{% endraw %}

핵심은 세 가지입니다.

- 라벨의 `for`와 입력의 `id`를 반드시 맞춥니다.
- 힌트와 에러의 id를 만들고 `aria-describedby`에 함께 연결합니다.
- 에러가 있을 때 `aria-invalid="true"`가 되도록 명시합니다.

## SSR에서는 id를 더 조심하기

위 예시는 클라이언트 렌더링 기준으로는 충분히 단순합니다. 하지만 Nuxt 같은 SSR 환경에서는 `Math.random()`으로 만든 id가 서버와 클라이언트에서 달라져 hydration warning이 날 수 있습니다.

SSR 프로젝트라면 아래 둘 중 하나를 고릅니다.

- 부모에서 항상 `id`를 넘기도록 팀 규칙을 둡니다.
- Vue/Nuxt에서 제공하는 안정적인 id 생성 유틸을 사용합니다.

저는 운영 서비스에서는 보통 첫 번째 방식을 택합니다. 폼 필드가 많아도 `id="email"`, `id="password"`처럼 명시하는 쪽이 디버깅하기 쉽습니다.

## 테스트 코드

접근성은 눈으로만 확인하면 놓치기 쉽습니다. 최소한 라벨로 입력을 찾는 테스트와 axe 검사는 붙여둡니다.

{% raw %}

```js
import { render, fireEvent } from "@testing-library/vue";
import { toHaveNoViolations } from "jest-axe";
import axe from "jest-axe";
import AccessibleField from "./AccessibleField.vue";

expect.extend(toHaveNoViolations);

test("label is connected to the input", async () => {
  const { getByLabelText, container } = render(AccessibleField, {
    props: {
      id: "name",
      label: "Name",
      modelValue: "",
      hint: "Use your real name."
    }
  });

  const input = getByLabelText("Name");
  await fireEvent.update(input, "Anna");

  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

{% endraw %}

의존성은 프로젝트 테스트 러너에 맞게 조정하면 됩니다.

{% raw %}

```bash
npm i -D @testing-library/vue @testing-library/jest-dom jest-axe axe-core
```

{% endraw %}

## 수동 확인도 필요하다

자동화 검사는 기본 안전망입니다. 그래도 실제 키보드와 스크린리더 확인은 한 번 해야 합니다.

- Tab으로 입력에 도달하는가
- 라벨을 클릭하면 입력에 포커스가 가는가
- 에러가 생겼을 때 입력 이름, 힌트, 에러가 자연스러운 순서로 읽히는가
- `role="alert"`가 너무 자주 읽혀 사용자를 방해하지 않는가
- 색상 대비가 낮아 Lighthouse나 axe에서 경고가 나지 않는가

Windows에서는 NVDA와 Chrome 조합으로, macOS에서는 VoiceOver와 Safari 조합으로 한 번씩 보는 것이 좋습니다.

## 증상별로 바로 보는 곳

| 증상                          | 먼저 볼 곳                | 조치                             |
| ----------------------------- | ------------------------- | -------------------------------- |
| 스크린리더가 라벨을 읽지 않음 | `label[for]`, `input[id]` | id 매핑 추가                     |
| 힌트가 읽히지 않음            | `aria-describedby`        | hint id 연결                     |
| 에러가 읽히지 않음            | error id, `role="alert"`  | 에러 메시지 연결                 |
| Tab 순서가 이상함             | DOM 순서, `tabindex`      | 불필요한 `tabindex` 제거         |
| SSR 경고가 뜸                 | 랜덤 id 생성              | 부모 id 전달 또는 안정적 id 생성 |

## prop과 slot 선택 기준

| 방식                | 쓰기 좋은 경우                         | 주의할 점                 |
| ------------------- | -------------------------------------- | ------------------------- |
| `label` prop        | 로그인, 설정 화면처럼 반복되는 단순 폼 | 커스텀 마크업이 어렵다    |
| `label` slot        | 아이콘, 설명, 링크가 섞인 라벨         | API와 테스트가 복잡해진다 |
| `hint`/`error` prop | 문구만 바뀌는 일반 폼                  | 디자인 자유도가 낮다      |
| `hint`/`error` slot | 링크나 강조가 필요한 안내문            | 접근성 연결을 놓치기 쉽다 |

개인 프로젝트나 MVP에서는 prop 중심으로 시작하는 편이 빠릅니다. 결제 폼, 가입 폼처럼 전환에 직접 영향을 주는 화면만 slot 확장을 열어두면 유지보수 부담이 줄어듭니다.

## CI에 넣을 최소 검증

PR마다 아래 정도만 돌아도 기본 사고는 많이 줄어듭니다.

- `@testing-library/vue`로 `getByLabelText` 테스트
- `jest-axe` 접근성 위반 검사
- 주요 폼 페이지에 Lighthouse accessibility 점수 확인
- Storybook을 쓴다면 컴포넌트별 axe 스캔

Lighthouse는 로컬 서버를 띄운 뒤 이렇게 돌릴 수 있습니다.

{% raw %}

```bash
lighthouse http://localhost:5173 \
  --only-categories=accessibility \
  --chrome-flags="--headless" \
  --output=json \
  --output-path=./lighthouse-accessibility.json
```

{% endraw %}

## 마무리

폼 컴포넌트는 한 번 잘못 추상화하면 프로젝트 전체 입력 화면에 같은 문제가 퍼집니다. 그래서 저는 재사용성을 보기 전에 라벨, id, 힌트, 에러, 키보드 흐름부터 고정합니다.

정리하면 기준은 단순합니다. **라벨로 입력을 찾을 수 있어야 하고, 보이는 안내 문구는 입력과 연결되어야 하며, 자동화 검사와 수동 키보드 확인을 둘 다 통과해야 합니다.** 이 정도만 지켜도 Vue 3 폼 컴포넌트의 기본 품질은 꽤 안정됩니다.

## 함께 보면 좋은 글

- [React 폼 복잡성 줄이기: 비동기 검증과 서버 유효성 정리](/posts/react-form-complexity-reduce-async-server-validation/)
- [OAuth2 Token Exchange vs JWT On-Behalf: 보안·운영 선택 기준 정리](/posts/oauth2-token-exchange-vs-jwt-on-behalf-compare/)
- [Event-driven 아키텍처에서 스키마 변경을 무중단 적용하는 전략 Top 6](/posts/event-driven-schema-change-zero-downtime-top6/)
