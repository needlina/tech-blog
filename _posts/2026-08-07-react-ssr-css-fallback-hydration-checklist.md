---
title: "React 서버 사이드 CSS 폴백으로 하이드레이션 깨짐 방지 체크리스트"
description: "React SSR 환경에서 CSS 로딩 순서, critical CSS, CSS-in-JS SSR 설정, hydrateRoot 사용 여부를 확인해 하이드레이션 경고와 FOUC를 줄이는 실무 점검 순서"
slug: "react-ssr-css-fallback-hydration-checklist"
date: 2026-08-07 10:00:00 +0900
categories: ["Frontend", "React"]
tags: ["react", "ssr", "css", "하이드레이션", "fouc"]
image:
  path: /assets/img/posts/blog/react-ssr-css-fallback-hydration-checklist/preview.png
  alt: "SSR CSS 폴백 체크리스트 썸네일"
---

React SSR에서 하이드레이션 경고와 화면 깜빡임이 같이 보이면, 먼저 서버 HTML의 `<head>`에 실제 스타일이 들어갔는지부터 확인하는 편이 빠릅니다.

이 문제는 원인이 다양해 보이지만, 막상 열어보면 세 갈래로 좁혀지는 경우가 많았습니다. 서버가 보낸 HTML에는 스타일이 없거나, CSS-in-JS가 서버에서 수집되지 않았거나, 클라이언트 진입점이 SSR 결과를 하이드레이션하지 않고 새로 렌더링하고 있는 경우입니다.

아래 순서는 React 18 기준으로 적었습니다. Next.js, Remix, 직접 구성한 Express SSR 모두에서 같은 방식으로 먼저 확인할 수 있습니다.

## 증상

브라우저 콘솔에 이런 경고가 보이면 하이드레이션 불일치를 의심합니다.

```text
Warning: Text content did not match. Server: "..." Client: "..."
Warning: Expected server HTML to contain a matching ...
Warning: Did not expect server HTML to contain a <div> in <main>.
```

사용자 화면에서는 보통 다음처럼 보입니다.

- 첫 화면이 잠깐 스타일 없이 보였다가 다시 잡힌다.
- 서버에서 본 레이아웃과 브라우저에서 완성된 레이아웃이 다르다.
- 새로고침 직후만 깨지고, 이후 라우팅에서는 정상처럼 보인다.
- 개발 모드에서는 괜찮은데 production 빌드에서만 경고가 난다.

특히 마지막 케이스는 빌드 결과물의 CSS 추출 방식, chunk 로딩 순서, minify 결과와 엮이는 경우가 있어서 개발 서버만 보고 판단하면 시간을 꽤 잃습니다.

## 먼저 볼 것

처음부터 컴포넌트 코드를 뒤지기보다, 서버 HTML과 브라우저 로딩 순서를 먼저 봅니다.

```bash
node -v
npm ls react
npm ls react-dom
```

React 18을 쓰는 프로젝트라면 클라이언트 진입점에서 `hydrateRoot`를 쓰는지도 확인합니다.

```bash
rg "hydrateRoot|hydrate\\(|createRoot" src app pages
```

서버가 내려주는 HTML의 `<head>`도 바로 확인합니다.

```bash
curl -sS http://localhost:3000 | grep -i "<style\\|<link" -n
```

Next.js처럼 자체 SSR을 쓰는 경우에도 이 확인은 유효합니다. HTML 안에 기대한 CSS 링크나 style 태그가 없다면, 브라우저가 나중에 CSS를 받아서 화면을 다시 그리게 됩니다. 이때 FOUC가 생기고, 일부 CSS-in-JS 환경에서는 클래스명 불일치까지 같이 터집니다.

## 원인별 점검

### 1. 서버 HTML에 초기 스타일이 없다

FOUC만 보이고 React 경고는 없을 수도 있습니다. 하지만 레이아웃이 CSS 적용 전후로 크게 달라지면 하이드레이션 경고로 이어질 수 있습니다.

확인할 내용은 단순합니다.

```bash
curl -sS http://localhost:3000 | grep -i "<link" -n
curl -sS http://localhost:3000 | grep -i "<style" -n
```

브라우저에서는 Network 탭을 열고 document 요청 직후 CSS 요청이 언제 끝나는지 봅니다. CSS가 늦게 오는데 첫 렌더가 이미 일어났다면, 서버에서 critical CSS를 넣거나 CSS 로딩 우선순위를 조정해야 합니다.

### 2. CSS-in-JS SSR 설정이 빠져 있다

`styled-components`, `emotion` 같은 CSS-in-JS를 쓰는 프로젝트에서 자주 나옵니다. 서버에서 스타일을 수집하지 않으면 서버 HTML에는 클래스만 있고 실제 style 태그는 빠질 수 있습니다.

`styled-components`라면 서버 렌더 코드에 `ServerStyleSheet`가 있어야 합니다.

```js
import { ServerStyleSheet } from "styled-components";
import ReactDOMServer from "react-dom/server";

app.get("/", (req, res) => {
  const sheet = new ServerStyleSheet();

  try {
    const html = ReactDOMServer.renderToString(sheet.collectStyles(<App />));
    const styles = sheet.getStyleTags();

    res.send(`
      <!doctype html>
      <html>
        <head>${styles}</head>
        <body>
          <div id="root">${html}</div>
          <script src="/client.js"></script>
        </body>
      </html>
    `);
  } finally {
    sheet.seal();
  }
});
```

검증은 서버 HTML에 실제 style 태그가 들어갔는지 보면 됩니다.

```bash
curl -sS http://localhost:3000 | grep -n "data-styled\\|sc-\\|<style"
```

Emotion을 쓴다면 `@emotion/server` 설정을 확인합니다. 프레임워크별 예제가 조금씩 달라서, 라이브러리 공식 문서의 SSR 섹션을 그대로 맞추는 쪽이 낫습니다.

### 3. 클라이언트가 SSR 결과를 버리고 새로 렌더링한다

서버에서 SSR을 했는데 클라이언트에서 `createRoot`로 시작하면, React는 기존 HTML을 이어받지 않고 새로 렌더링합니다.

실패 예시는 이런 형태입니다.

```js
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")).render(<App />);
```

SSR 결과를 하이드레이션해야 한다면 React 18에서는 보통 이렇게 시작합니다.

```js
import { hydrateRoot } from "react-dom/client";
import App from "./App";

hydrateRoot(document.getElementById("root"), <App />);
```

이 차이 하나로 경고가 사라지는 경우도 있습니다. 다만 경고가 사라졌다고 끝은 아닙니다. 서버 HTML과 클라이언트 첫 렌더 결과가 같은지, CSS가 같은 순서로 적용되는지까지 봐야 합니다.

## CSS 로딩 방식 비교

CSS가 큰 프로젝트에서는 어떤 방식을 고를지 헷갈립니다. 아래 기준 정도로 먼저 나눠보면 됩니다.

| 방식                       | 장점                                 | 단점                                  | 어울리는 경우                                         |
| -------------------------- | ------------------------------------ | ------------------------------------- | ----------------------------------------------------- |
| critical CSS 인라인        | 첫 렌더가 안정적이다                 | HTML 크기가 커지고 관리가 번거롭다    | 랜딩, 결제, 로그인처럼 첫 화면 안정성이 중요한 페이지 |
| 일반 stylesheet 링크       | 구조가 단순하고 캐시가 쉽다          | 네트워크가 느리면 FOUC가 보일 수 있다 | CSS가 작거나 화면 깜빡임 영향이 작은 페이지           |
| preload 후 stylesheet 전환 | CSS 다운로드 우선순위를 올릴 수 있다 | CSP와 브라우저 동작을 확인해야 한다   | CSS 파일이 크고 초기 로딩 순서가 중요한 경우          |
| CSS-in-JS SSR 수집         | 클래스명 불일치를 줄인다             | 서버 설정이 빠지면 바로 깨진다        | styled-components, emotion을 SSR에서 쓰는 경우        |

`preload`를 쓸 때는 아래처럼 많이 작성합니다.

```html
<link
  rel="preload"
  href="/styles.css"
  as="style"
  onload="this.rel='stylesheet'"
/>
<noscript><link rel="stylesheet" href="/styles.css" /></noscript>
```

다만 CSP에서 inline handler를 막고 있으면 `onload`가 동작하지 않을 수 있습니다. 운영 환경에 CSP가 있다면 헤더까지 같이 확인해야 합니다.

## 재현 체크리스트

- [ ] `npm ls react react-dom`으로 서버와 클라이언트가 같은 React 계열 버전을 쓰는지 확인
- [ ] production 빌드로 실행해서 재현
- [ ] 서버 HTML의 `<head>`에 CSS 링크 또는 style 태그가 있는지 확인
- [ ] Network 탭에서 document 이후 CSS 요청 완료 시점 확인
- [ ] Console 탭에서 하이드레이션 경고 문자열과 컴포넌트 스택 확인
- [ ] CSS-in-JS 사용 시 서버 스타일 수집 코드 확인
- [ ] 클라이언트 진입점에서 `hydrateRoot`를 쓰는지 확인
- [ ] CSP가 inline style, inline handler, nonce/hash 정책으로 CSS 로딩을 막지 않는지 확인

production 빌드 재현은 꼭 해보는 게 좋습니다.

```bash
npm run build
npm run start
```

Next.js라면 보통 아래처럼 확인합니다.

```bash
npm run build
npm run start
```

직접 만든 SSR 서버라면 빌드 산출물 기준으로 서버를 띄운 뒤 같은 curl과 DevTools 확인을 반복하면 됩니다.

## 정리

React SSR에서 CSS 때문에 하이드레이션이 흔들릴 때는 컴포넌트 로직보다 렌더링 경계부터 보는 게 빠릅니다. 서버 HTML에 무엇이 들어갔는지, 브라우저가 CSS를 언제 받는지, 클라이언트가 기존 HTML을 하이드레이션하는지 이 세 가지를 먼저 확인하세요.

개인적으로는 아래 순서가 가장 덜 헤맸습니다.

1. production 빌드로 재현한다.
2. curl로 서버 HTML의 `<head>`를 본다.
3. DevTools Network에서 CSS 완료 시점을 본다.
4. CSS-in-JS SSR 수집 여부를 확인한다.
5. 클라이언트 진입점의 `hydrateRoot` 사용 여부를 확인한다.

이 순서로 보면 "CSS가 늦게 온 문제"와 "React 렌더 결과가 다른 문제"를 분리할 수 있습니다. 둘을 섞어서 보면 원인도 섞여 보입니다.

## 참고 문서

- React hydrate API: https://reactjs.org/docs/react-dom.html#hydrate
- styled-components Server Side Rendering: https://styled-components.com/docs/advanced#server-side-rendering
- MDN Preloading content: https://developer.mozilla.org/en-US/docs/Web/HTML/Preloading_content

## 함께 보면 좋은 글

- [React 폼 비동기 제출 중 중복 타임아웃 피드백 처리 패턴](/posts/react-form-async-submit-duplicate-timeout-feedback-patterns/)
- [React Portal 접근성 포커스 관리 체크리스트](/posts/react-portal-accessibility-focus-checklist/)
- [React 상태 복원 패턴: 새로고침과 탭 종료 후 상태 유지](/posts/react-state-persistence-refresh-tab-restore/)
