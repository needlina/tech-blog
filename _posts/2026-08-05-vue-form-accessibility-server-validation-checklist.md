---
title: "Vue 폼 접근성과 서버 유효성 검증 통합 체크리스트"
description: "Vue 폼에서 label, aria-describedby, role alert, 포커스 이동, 서버 422 응답 매핑, curl 재현 명령, axe와 Lighthouse 검증 방법을 정리한 실무 체크리스트"
slug: "vue-form-accessibility-server-validation-checklist"
date: 2026-08-05 19:00:00 +0900
categories: ["Frontend", "Vue.js"]
tags: ["vue", "accessibility", "server-validation", "폼검증", "접근성"]
image:
  path: /assets/img/posts/blog/vue-form-accessibility-server-validation-checklist/preview.png
  alt: "폼 접근성과 서버 검증 통합 썸네일"
---

Vue 폼에서 접근성과 서버 유효성 검증을 따로 보면 빈틈이 생긴다. **서버가 422 응답으로 내려준 필드 오류를 화면의 실제 input에 매핑하고, 오류 메시지를 `aria-describedby`와 `role="alert"`로 연결하며, 제출 실패 후 첫 오류 필드로 포커스를 옮기는 것**까지 확인해야 한다.

클라이언트 검증은 UX를 빠르게 만들지만 최종 판단은 서버가 해야 한다. 이메일 중복, 권한, 정책 위반처럼 서버 데이터가 필요한 규칙은 브라우저에서 확정할 수 없다. 반대로 서버 오류를 받아도 화면과 스크린리더에 제대로 연결하지 않으면 사용자는 무엇을 고쳐야 하는지 알기 어렵다.

## 먼저 확인할 항목

| 확인 항목        | 확인 방법                                                     | 실패 신호                                       |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| label 연결       | `label[for]`와 `input#id` 비교                                | 입력창 이름을 스크린리더가 읽지 못함            |
| 오류 메시지 연결 | input의 `aria-describedby`가 오류 메시지 id를 가리키는지 확인 | 오류 텍스트는 보이지만 보조기술에 전달되지 않음 |
| 오류 상태 표시   | `aria-invalid="true"` 적용 여부 확인                          | 오류 필드가 프로그램적으로 표시되지 않음        |
| 서버 오류 매핑   | 422 JSON의 필드명과 input `name` 비교                         | 서버 오류가 엉뚱한 필드에 표시됨                |
| 포커스 이동      | 제출 실패 후 `document.activeElement` 확인                    | 사용자가 첫 오류 위치를 직접 찾아야 함          |
| 자동 검사        | axe, Lighthouse 접근성 점검                                   | label 누락, 대비 부족, ARIA 오류 발생           |

표의 항목은 코드 리뷰 때 그대로 체크해도 된다. 특히 `name`, 서버 필드명, 오류 객체 key가 서로 다르면 구현이 쉽게 꼬인다.

## 실패 예시

서버가 오류를 내려줘도 화면에 표시하지 않으면 사용자는 실패 이유를 알 수 없다.

{% raw %}

```vue
<template>
  <form @submit.prevent="submit">
    <label for="email">Email</label>
    <input id="email" name="email" v-model="form.email" />

    <button type="submit">Submit</button>
  </form>
</template>

<script setup>
import { reactive } from "vue";

const form = reactive({ email: "" });

async function submit() {
  await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(form)
  });
}
</script>
```

{% endraw %}

이 코드는 네트워크 탭에서는 422 응답을 확인할 수 있지만, 사용자에게는 아무 설명이 없다. `aria-invalid`, `aria-describedby`, 오류 메시지, 포커스 이동도 없다.

## 수정 예시

아래 예시는 Vue 3 Composition API 기준이다. 서버 응답 형식은 `{"errors":{"email":["is invalid"],"password":["too short"]}}`라고 가정한다.

{% raw %}

```vue
<template>
  <form @submit.prevent="submit" novalidate>
    <label for="email">Email</label>
    <input
      id="email"
      name="email"
      v-model="form.email"
      :aria-invalid="Boolean(errors.email)"
      :aria-describedby="errors.email ? 'error-email' : undefined"
    />
    <p v-if="errors.email" id="error-email" role="alert">
      {{ errors.email[0] }}
    </p>

    <label for="password">Password</label>
    <input
      id="password"
      name="password"
      type="password"
      v-model="form.password"
      :aria-invalid="Boolean(errors.password)"
      :aria-describedby="errors.password ? 'error-password' : undefined"
    />
    <p v-if="errors.password" id="error-password" role="alert">
      {{ errors.password[0] }}
    </p>

    <button type="submit">Submit</button>
  </form>
</template>

<script setup>
import { nextTick, reactive } from "vue";

const form = reactive({ email: "", password: "" });
const errors = reactive({});

function replaceErrors(nextErrors) {
  Object.keys(errors).forEach((key) => delete errors[key]);
  Object.assign(errors, nextErrors);
}

async function submit() {
  replaceErrors({});

  const response = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(form)
  });

  if (response.ok) {
    return;
  }

  if (response.status === 422) {
    const body = await response.json();
    replaceErrors(body.errors ?? {});

    const firstField = Object.keys(errors)[0];
    await nextTick();

    document.querySelector(`[name="${firstField}"]`)?.focus();
  }
}
</script>
```

{% endraw %}

실서비스에서는 서버 메시지를 그대로 노출하지 않는 편이 안전하다. 스택 트레이스, SQL 오류, 내부 정책명은 로그에만 남기고, 사용자에게는 수정 가능한 문장으로 바꿔 보여준다.

## 서버 응답 재현

먼저 API가 어떤 구조로 오류를 내려주는지 고정해야 한다.

```bash
curl -i -X POST http://localhost:4000/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"bad","password":"123"}'
```

기대 응답 예시는 다음과 같다.

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json
```

```json
{
  "errors": {
    "email": ["is invalid"],
    "password": ["too short"]
  }
}
```

프론트엔드는 이 구조를 기준으로 오류 객체를 매핑한다. 서버가 `email_address`를 주는데 input 이름은 `email`이면 변환 레이어가 필요하다. 이 규칙을 명시하지 않으면 폼이 늘어날수록 오류 표시가 흔들린다.

## 접근성 검증 명령

```bash
npx @axe-core/cli http://localhost:3000 --save --json
```

```bash
npx lighthouse http://localhost:3000 \
  --only-categories=accessibility \
  --output=json \
  --output-path=./lh-a11y.json
```

자동 점검은 빠뜨린 label, 대비 부족, 잘못된 ARIA 속성을 찾는 데 좋다. 다만 포커스 이동이나 서버 오류 매핑처럼 사용 흐름이 필요한 항목은 직접 테스트나 E2E 테스트로 확인해야 한다.

## 수동 테스트 순서

1. 빈 값이나 잘못된 값으로 제출한다.
2. Network 탭에서 422 응답과 JSON 구조를 확인한다.
3. 화면에 필드별 오류가 표시되는지 확인한다.
4. 해당 input에 `aria-invalid`와 `aria-describedby`가 붙었는지 DOM에서 확인한다.
5. 콘솔에서 `document.activeElement.name`을 실행해 첫 오류 필드로 포커스가 이동했는지 확인한다.
6. 키보드만으로 오류를 수정하고 다시 제출해 본다.

여기까지 통과하면 최소한 “서버는 거절했는데 사용자는 이유를 모르는” 상태는 피할 수 있다.

## 클라이언트 검증과 서버 검증 분리

| 구분      | 클라이언트 검증                  | 서버 검증                    |
| --------- | -------------------------------- | ---------------------------- |
| 역할      | 즉시 피드백과 입력 실수 방지     | 최종 유효성 판단             |
| 예시      | 이메일 형식, 필수값, 길이        | 중복 이메일, 권한, 정책 위반 |
| 실패 처리 | 화면에서 바로 안내               | 422 응답을 필드 오류로 매핑  |
| 검증 도구 | 브라우저 테스트, axe, Lighthouse | curl, API 테스트, 서버 로그  |

클라이언트 검증은 편의를 위한 장치다. 같은 규칙이 있어도 서버에서 다시 검증해야 한다. API를 직접 호출하는 사용자는 브라우저 폼을 거치지 않을 수 있기 때문이다.

## 실무 체크리스트

- 모든 input에 명시적인 label이 있는가?
- 서버 오류 key와 input `name`이 일치하는가?
- 오류 메시지 id가 `aria-describedby`로 연결되는가?
- 오류 필드에 `aria-invalid`가 적용되는가?
- 제출 실패 후 첫 오류 필드로 포커스가 이동하는가?
- 서버 내부 오류 문구가 사용자 화면에 노출되지 않는가?
- axe와 Lighthouse 결과를 CI 또는 배포 전 점검에 포함했는가?

폼 검증은 사용자가 막히는 지점을 줄이는 작업이다. 서버 응답, 화면 표시, 보조기술 전달, 포커스 이동을 한 흐름으로 묶어 확인하면 재현과 수정이 훨씬 쉬워진다.

## 참고 문서

- Vue Form Input Bindings: https://vuejs.org/guide/essentials/forms.html
- WAI-ARIA Authoring Practices: https://www.w3.org/WAI/ARIA/apg/
- MDN Form validation: https://developer.mozilla.org/ko/docs/Learn/Forms/Form_validation
- MDN HTTP 422: https://developer.mozilla.org/ko/docs/Web/HTTP/Status/422
- axe-core CLI: https://github.com/dequelabs/axe-core

## 함께 보면 좋은 글

- [Vue 3 재사용 가능한 접근성 좋은 폼 필드 컴포넌트 가이드](/posts/vue3-reusable-accessible-form-field-guide/)
- [React 폼 복잡도 줄이기: 비동기 검증과 서버 유효성 정리](/posts/react-form-complexity-reduce-async-server-validation/)
- [Oracle HINT 사용 전 점검해야 할 실무 체크리스트](/posts/oracle-hints-usage-checklist-risks/)
