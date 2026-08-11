---
title: "모듈 해석 오류 해결 절차 webpack Vite Rollup 공통"
description: "webpack Vite Rollup에서 발생하는 모듈 해석 오류의 공통 원인과 단계별 점검 방법, 재현 명령어, 설정 파일 경로, ESM CJS 호환성 및 캐시 초기화 절차을 정리한 실무 가이드"
slug: "frontend-module-resolution-error-triage"
date: 2026-08-11 10:00:00 +0900
categories: ["Frontend"]
tags: ["javascript", "module-resolution", "webpack", "vite", "rollup", "빌드오류"]
image:
  path: /assets/img/posts/blog/frontend-module-resolution-error-triage/preview.png
  alt: "모듈 해석 오류 점검 썸네일"
---

간단히 해결되면 은근한 성취감이 듭니다.  
모듈 해석 오류는 주로 잘못된 import 경로, 확장자 미지정, alias/paths 누락, ESM/CJS 경계 문제, 또는 빌드 도구별 캐시 때문에 발생합니다. 핵심은 오류 메시로 원인 분류한 뒤(경로 / 확장자 / alias / 형식), 해당 빌드 도구의 resolve 설정과 Node 모듈 해석 규칙을 순서대로 점검하는 것입니다.

왜 이 글을 적는지 짧게: 로컬에서 문제없는데 CI나 다른 환경에서만 깨질 때 바로 확인할 수 있는 절차를 정리하려고 합니다. 실제 해결에 쓸 실무 명령어, 설정 위치, 재현 방법을 중심으로 썼습니다.

## 문제를 빠르게 분류하는 4가지 키워드
- 경로(상대/절대) — import 경로가 실제 파일 위치와 일치하는가
- 확장자 — .ts/.tsx/.jsx/.mjs가 처리되도록 설정됐는가
- alias / paths — @, ~ 또는 사용자 정의 경로가 번들러에 등록됐는가
- 형식(ESM vs CJS) — package.json의 "type", .mjs/.cjs 혼용 여부

오류 메시 예시와 의미(실제 로그를 보면 우선 이 단어들로 분류합니다):
- "Module not found: Error: Can't resolve './Foo' in /src" → 경로/파일 존재 문제
- "Uncaught SyntaxError: Cannot use import statement outside a module" → 파일 형식(ESM/CJS) 불일치
- "Unexpected token" 또는 "Unexpected character '#'" → 확장자 파서 없음(예: JSX/TSX 미처리)
- "Failed to resolve import 'vue' from ... Is it installed?" → 패키지 설치 혹은 resolve alias 문제

## 순차 점검 절차(실무용, 6단계)
1. 오류 메세지 정확히 복사해 두기 — 빌드 로그 전체와 에러 스택(파일/라인) 확보  
2. 로컬에서 최소 재현 명령 실행
   - npm run build (webpack), npx vite build, npm run build (rollup) 등 사용
   - Node 16/18/버전 표기: node -v 출력 포함
3. 파일 존재와 경로 확인
   - ls -la ./src/경로 또는 tree ./src/components | grep Foo
4. 확장자·resolve 설정 확인
   - webpack: webpack.config.js의 resolve.extensions, resolve.alias
   - Vite: vite.config.ts의 resolve.alias, esbuild 옵션
   - Rollup: @rollup/plugin-alias, resolve 플러그인 설정
5. ESM/CJS 호환성 점검
   - package.json의 "type" 값 확인
   - 문제가 되는 파일의 확장자를 .mjs/.cjs로 바꿔 테스트
6. 캐시/lockfile 정리 후 재설치
   - rm -rf node_modules .vite .rpt2_cache node_modules/.cache && npm ci

검증용 명령 예 (복사해서 실행해 볼 수 있음):
- node -v
- npm -v
- cat package.json | grep '"type"'
- ls -la src/components/MyComp.jsx
- rm -rf node_modules && npm ci
- npm run build  # (webpack)
- npx vite build  # (Vite)
- npx rollup -c  # (Rollup)

## 실패 예와 수정 예(코드로 비교)

문제: alias를 사용했는데 빌드에서 모듈을 못 찾음. (자주 발생)

실패 예 (import는 있지만 빌드에 등록 안 된 경우)
```js
// src/main.js
import App from '@/App' // '@/App'을 webpack/Vite에 등록하지 않음
```

수정 예 — webpack
```js
// webpack.config.js
module.exports = {
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  }
};
```

수정 예 — Vite
```js
// vite.config.ts
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, 'src') }]
  }
});
```

수정 예 — Rollup
```js
// rollup.config.js
import alias from '@rollup/plugin-alias';
import path from 'path';

export default {
  plugins: [
    alias({
      entries: [{ find: '@', replacement: path.resolve(__dirname, 'src') }]
    })
  ]
};
```

위 세 예시에서 공통 점검 포인트:
- alias 경로가 절대 경로로 치환되는지
- extensions에 사용 확장자가 모두 포함되는지
- 타이핑 오류(예: '@/' 뒤 슬래시 유무)가 없는지

## ESM과 CJS 충돌 점검
증상: 로컬 dev에서는 괜찮은데 production 빌드에서 "Cannot use import statement outside a module" 발생.

확인할 항목:
- package.json: "type": "module" 유무
- node 버전(최소 12+ 권장, 14/16/18 차이)
- 외부 라이브러리가 CJS 단일 빌드만 제공하는지 확인

간단한 재현/확인 커맨드:
- cat package.json | jq '.type'  # jq 설치된 경우
- node -p "require('module').createRequire(import.meta.url) && 'ok'"

해결 방향:
- 패키지가 CJS만 제공하면 import 대신 require 사용 또는 번들러에서 commonjs 플러그인 사용
  - Rollup: @rollup/plugin-commonjs
  - webpack: default support, but babel로 transpile 필요할 수 있음
  - Vite: 플러그인 또는 optimizeDeps.include 설정

## 확장자 관련 자주 실수하는 것들
- JSX/TSX 파일을 .js로 import하지만 resolve.extensions에 .jsx/.tsx가 없음 → "Unexpected token"  
- .mjs 파일을 처리하지 않음 → Rollup/webpack에서 mjs 로더 혹은 모드 필요

권장 resolve.extensions(예시):
- ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json']

## 번들러별 빠른 참고표
| 문제 증상 | webpack 확인 위치 | Vite 확인 위치 | Rollup 확인 위치 |
|---|---:|---:|---:|
| alias 미작동 | webpack.config.js resolve.alias | vite.config.ts resolve.alias | rollup.config.js @rollup/plugin-alias |
| 확장자 미처리 | resolve.extensions | esbuild 옵션 / 플러그인 | 플러그인 설정(예: rollup-plugin-typescript2) |
| CJS 모듈 호환 | babel/ts-loader, commonjs 처리 | optimizeDeps.include, commonjs 플러그인 | @rollup/plugin-commonjs |

(표는 빠른 점검용으로, 실제 설정 파일 경로와 라인 확인이 필요합니다)

## 실무 확인 절차(재현과 수정 적용 후 검증)
1. 재현
   - 로컬 클린 상태: rm -rf node_modules && npm ci
   - 실패 빌드 실행: npm run build (또는 npx vite build, npx rollup -c)
   - 로그를 파일로 저장: npm run build 2>&1 | tee build.log
2. 원인 수정(예: alias 추가)
   - 수정 후 캐시 제거: rm -rf node_modules/.cache .vite
   - 재설치 및 빌드: npm ci && npm run build
3. 검증
   - 빌드 성공 여부(종료 코드 0)
   - 번들 내 모듈 경로 확인: grep -R "App" dist -n
   - 브라우저 런타임 오류 확인: DevTools Console에 에러가 없는지 확인

공식 문서 확인 경로(검증용)
- webpack resolve: https://webpack.js.org/configuration/resolve/
- Vite resolve: https://vitejs.dev/config/#resolve-alias
- Rollup plugin alias: https://github.com/rollup/plugins/tree/master/packages/alias
- Node module resolution: https://nodejs.org/api/modules.html#modules_all_together

## 자주 마주치는 실전 상황과 판단 기준(간단 표)
| 상황 | 첫 점검 | 다음 선택 |
|---|---:|---|
| 로컬 dev ok, CI 빌드 실패 | node 버전, lockfile(package-lock/yarn.lock) 확인 | CI node 버전 고정 또는 lockfile 재생성 |
| 일부 파일만 에러 | resolve.extensions에 해당 확장자 추가 | 빌드 플러그인 추가(typescript, jsx) |
| 외부 패키지 import 실패 | node_modules 설치 여부 확인 | 패키지 버전 강제, vite optimizeDeps 포함 |

## 흔한 실수와 빠른 해결 팁
- import 경로에 대소문자 문제: Linux CI는 대소문자 구분, macOS는 관대 → 파일명 정확히 맞추기
- package.json 의 "exports" 필드가 있으면 서브패스 접근이 차단될 수 있음 → 해당 패키지 문서 확인
- monorepo에서 경로가 루트 기준으로 꼬이는 경우 tsconfig.baseUrl/paths와 번들러 alias 동기화 필요

![모듈 해석 과정을 도식화한 단순 일러스트](/assets/img/posts/blog/frontend-module-resolution-error-triage/image-1.webp)
이미지 출처: AI 생성 이미지

## 마무리로 바로 확인할 두 가지
- 먼저 확인할 것: 에러 로그의 첫 줄(파일 경로·라인)과 package.json의 "type" 값, 그리고 사용 중인 Node 버전 세 가지를 확인하세요. 이 세 가지면 원인 분류가 빠릅니다.  
- 언제 다른 선택지가 나은가: 로컬에서만 문제라면 캐시와 대소문자; CI에서만 문제라면 Node 버전·lockfile·환경변수 문제를 먼저 의심하세요.

이미지로 한 번 더 정리한 체크 포인트입니다.

![alias 확장자 esm cjs 점검 항목을 요약한 단순 일러스트](/assets/img/posts/blog/frontend-module-resolution-error-triage/image-2.webp)
이미지 출처: AI 생성 이미지

이 글은 제가 직접 겪은 사례를 적은 것이 아니라, 여러 번 빌드 오류를 추적할 때 검증해 본 절차와 공식 문서 경로를 모아 정리한 것입니다. 실제로 적용할 때는 빌드 로그와 설정 파일의 라인을 함께 확인하고, 적용 전후로 빌드를 파일로 저장(tee)해 차이를 비교해 보세요.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

## 함께 보면 좋은 글

- [Vue 반응성 Proxy 재할당과 참조 비교로 인한 불필요 리렌더 해결](/posts/vue-reactivity-proxy-reassignment-rerender-fix/)
- [React Portal 접근성 포커스 관리 체크리스트](/posts/react-portal-accessibility-focus-checklist/)
- [React 폼 비동기 제출 중 중복 타임아웃 피드백 처리 패턴](/posts/react-form-async-submit-duplicate-timeout-feedback-patterns/)
