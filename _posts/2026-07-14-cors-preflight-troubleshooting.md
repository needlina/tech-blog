---
title: "CORS 프리플라이트 요청 실패 원인 찾는 순서와 실무 점검법"
description: "오늘은 CORS(Cross-Origin Resource Sharing) 프리플라이트(preflight) 요청이 실패할 때 원인을 찾아가는 순서를 정리해봤습니다"
slug: "cors-preflight-troubleshooting"
date: 2026-07-14 10:00:00 +0900
categories: [Backend, Security]
tags: ["cors", "preflight", "http", "장애대응", "nginx"]
image:
  path: /assets/img/posts/blog/cors-preflight-troubleshooting/preview.png
  alt: "CORS 프리플라이트 오류 썸네일"
---

오늘은 CORS(Cross-Origin Resource Sharing) 프리플라이트(preflight) 요청이 실패할 때 원인을 찾아가는 순서를 정리해봤습니다. 개인적으로 프론트엔드와 백엔드 사이에서 CORS 때문에 고생한 경험이 몇 번 있어서, 공부하면서 정리한 내용을 최대한 실무에서 바로 확인할 수 있게 정리하려고 합니다. 가능하면 단정적으로 쓰지 않고, 제가 이해한 선에서 조심스럽게 적겠습니다.

공부하면서 알게 된 점

- 프리플라이트는 브라우저가 보내는 OPTIONS 요청이고, 브라우저가 요구하는 특정 응답 헤더가 없으면 실제 요청을 보내지 않습니다.
- 서버에서 CORS 관련 헤더를 정확히 포함시켜야 하고, 특히 credential(자격증명)을 사용할 때는 Access-Control-Allow-Origin에 '\*'을 쓰면 안 됩니다.
- 브라우저는 CORS를 강제하지만, curl 같은 툴로 요청하면 CORS 제약이 적용되지 않으므로 헤더 확인용으로는 유용하지만 문제 재현은 브라우저에서 해야 합니다.
- 리버스 프록시(Nginx, CDN 등)가 CORS 헤더를 제거하거나 변경하는 경우가 종종 있어서, 백엔드가 정상 응답해도 브라우저에서 실패하는 일이 있습니다.

처음에는 헷갈렸던 부분

- OPTIONS 요청에 대해 204를 보내면 좋은지 200을 보내면 좋은지, 어떤 응답 코드가 적절한지 헷갈렸습니다. 실무에서는 200/204 모두 동작하지만, 중요한 건 응답에 필요한 CORS 헤더가 포함되어 있어야 한다는 점이었습니다.
- Access-Control-Allow-Headers에 어떤 값을 넣어야 하는지도 헷갈렸는데, 브라우저가 보내는 Access-Control-Request-Headers에 명시된 값들을 포함해야 안전합니다.
- 리다이렉트(301/302)가 끼어들면 브라우저가 프리플라이트를 실패로 처리할 수 있다는 점도 처음에는 몰랐습니다.

프리플라이트 개요(짧게)

- 브라우저가 "비단순(simple) 요청" 또는 자격증명을 요구하는 요청을 보내기 전에 OPTIONS 요청(프리플라이트)을 보냅니다.
- 프리플라이트 요청에는 헤더: Origin, Access-Control-Request-Method, Access-Control-Request-Headers가 포함됩니다.
- 서버는 응답에 Access-Control-Allow-Origin, Access-Control-Allow-Methods, Access-Control-Allow-Headers(필요시), Access-Control-Allow-Credentials(필요시), Access-Control-Max-Age(선택적) 등을 포함해야 합니다.

![CORS preflight 흐름을 보여주는 간단한 다이어그램(브라우저 → OPTIONS → 서버 → 응답 헤더 → 실제 요청)](/assets/img/posts/blog/cors-preflight-troubleshooting/image-1.webp)
이미지 출처: AI 생성 이미지

실무에서는 이렇게 확인하면 좋겠다 — 단계별 점검 순서

1. 브라우저 개발자 도구에서 네트워크 탭 확인
   - 프리플라이트 OPTIONS 요청을 찾고 상태 코드와 응답 헤더를 확인합니다.
   - 요청 헤더에 Origin, Access-Control-Request-Method, Access-Control-Request-Headers가 있는지 확인합니다.
   - 응답에 Access-Control-Allow-Origin, Access-Control-Allow-Methods, Access-Control-Allow-Headers 등이 있는지 확인합니다.
   - 콘솔에 관련 CORS 에러 메시지가 무엇인지 읽어봅니다(브라우저가 제공하는 메시지가 단서가 됩니다).

2. curl로 서버가 어떤 헤더를 반환하는지 직접 확인 (참고: curl은 브라우저 정책을 따르지 않음 — 헤더 검증용)
   - 예시:
     ```
     curl -i -X OPTIONS 'https://api.example.com/resource' \
       -H 'Origin: https://app.example.com' \
       -H 'Access-Control-Request-Method: POST' \
       -H 'Access-Control-Request-Headers: x-custom-header, content-type'
     ```
   - 응답 헤더를 보고 서버가 필요한 값을 반환하는지 확인합니다.

3. 서버 로그와 리버스 프록시 확인
   - 프리플라이트가 실제로 백엔드까지 도달하는지, 아니면 Nginx/Cloudflare에서 차단/응답을 가로채는지 확인합니다.
   - Nginx 사용 시 access_log, error_log와 proxy_pass 로그를 봅니다.
   - CDN이나 WAF가 응답 헤더를 조작하는 경우가 있어 설정을 검토합니다.

4. 인증/인증서 관련 검토
   - credential을 보내는 경우(예: withCredentials: true), Access-Control-Allow-Credentials: true 와 함께 Access-Control-Allow-Origin에 정확한 오리진을 넣어야 합니다.
   - HTTPS와 HTTP가 섞여있지는 않은지(Origin의 스킴이 맞는지) 확인합니다.

5. 리다이렉트, 상태 코드, 캐싱 확인
   - 프리플라이트가 3xx로 리다이렉트되면 브라우저에서 문제를 일으킬 수 있습니다. 가능하면 프리플라이트는 리다이렉트 없이 200/204로 응답하는 것이 안전합니다.
   - 캐시된 응답(304 등)에 CORS 헤더가 빠져 있으면 문제가 됩니다. 캐시 레이어가 헤더를 유지하는지 확인하세요.

6. 서버 코드/구성 예시 확인
   - Express 예시:

     ```js
     const express = require("express");
     const cors = require("cors");

     const app = express();
     app.use(
       cors({
         origin: "https://app.example.com",
         methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
         allowedHeaders: ["Content-Type", "Authorization", "X-Custom-Header"],
         credentials: true,
         optionsSuccessStatus: 204
       })
     );

     app.options("*", cors()); // preflight 처리
     ```

   - Nginx 예시(간단):
     ```
     location /api/ {
       if ($request_method = 'OPTIONS') {
         add_header 'Access-Control-Allow-Origin' 'https://app.example.com' always;
         add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
         add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, X-Custom-Header' always;
         add_header 'Access-Control-Allow-Credentials' 'true' always;
         return 204;
       }
       proxy_pass http://backend;
       proxy_set_header Host $host;
       # 프록시 응답에도 CORS 헤더를 붙여야 할 수 있음
       add_header 'Access-Control-Allow-Origin' 'https://app.example.com' always;
       add_header 'Access-Control-Allow-Credentials' 'true' always;
     }
     ```

     - 주: add_header에는 nginx 버전과 컨텍스트에 따라 동작 차이가 있습니다. 항상 붙게 하려면 `always` 옵션이나 적절한 모듈을 써야 합니다.

7. 테스트 케이스
   - 브라우저에서 실제 요청을 보내고 Network 탭의 OPTIONS와 실제 요청 둘 다 확인합니다.
   - 자격증명을 포함시키는 케이스(withCredentials)와 아닌 케이스를 모두 확인합니다.
   - 커스텀 헤더가 있는 요청, application/json 등의 Content-Type이 있는 요청 등 여러 케이스를 테스트합니다.

![클라이언트와 서버, 리버스 프록시가 있고 헤더가 오가며 검사되는 구성도(간단한 아이콘과 화살표)](/assets/img/posts/blog/cors-preflight-troubleshooting/image-2.webp)
이미지 출처: AI 생성 이미지

자주 발생하는 실수(체크 포인트)

- Access-Control-Allow-Headers에 Authorization, Content-Type 등이 빠져 있어서 preflight가 실패하는 경우
- withCredentials 사용 시 Access-Control-Allow-Origin을 '\*'로 두는 실수
- 리버스 프록시가 CORS 헤더를 제거하거나 캐시된 응답을 반환하는 경우
- 서버가 OPTIONS 요청을 404/405로 응답하는 경우 (특히 프레임워크에서 OPTIONS를 자동 처리하지 않는 경우)
- Content-Type이 application/json일 때 브라우저가 preflight를 발생시키는 점을 간과하는 경우

실무에서의 추가 팁

- 로컬 개발에서는 브라우저 플래그나 프록시(예: webpack dev server의 proxy)를 이용해 문제를 우회할 수 있지만, 실제로는 백엔드와 프록시 구성을 바로잡는 것이 장기적으로 낫습니다.
- 로그 쌓을 때 프리플라이트(OPTIONS) 요청을 너무 무시하면 문제 추적이 어려워집니다. 필요하면 최소한의 로그를 남기세요.
- 보안을 위해 CORS 정책은 최소 권한 원칙을 따르세요(필요한 오리진/메서드/헤더만 허용).

공부하면서 개인적으로 정리한 요약

- 브라우저는 프리플라이트 결과를 엄격하게 보므로, 서버는 브라우저가 기대하는 정확한 헤더를 반환해야 한다.
- curl로 확인할 때는 브라우저 정책은 안 따르지만, 서버 응답 헤더 검증에는 유용하다.
- 프록시나 CDN이 문제를 일으키는 경우가 생각보다 자주 있다.

관련 이미지 주제

1. CORS preflight 흐름을 보여주는 간단한 다이어그램(브라우저 → OPTIONS → 서버 → 응답 헤더 → 실제 요청)
2. 클라이언트와 서버, 리버스 프록시가 있고 헤더가 오가며 검사되는 구성도(간단한 아이콘과 화살표)

실무 체크리스트

- [ ] 브라우저 Network 탭에서 OPTIONS 요청과 응답 헤더를 확인했는가?
- [ ] 서버가 Access-Control-Allow-Origin, Access-Control-Allow-Methods를 반환하는가?
- [ ] 필요한 커스텀 헤더(Authorization, X-\* 등)가 Access-Control-Allow-Headers에 포함되어 있는가?
- [ ] withCredentials(쿠키/인증)을 사용하는 경우 Access-Control-Allow-Credentials: true 와 정확한 Origin을 반환하는가?
- [ ] 프록시/CDN이 CORS 헤더를 제거하거나 변경하지 않는가?
- [ ] 프리플라이트가 3xx 리다이렉트나 4xx/5xx 응답을 반환하지 않는가?
- [ ] 서버 로그에서 OPTIONS 요청이 정상적으로 처리되는지 확인했는가?
- [ ] 여러 브라우저와 환경(HTTPS/HTTP, 포트 포함)에서 테스트했는가?

마무리하며 — 조심스러운 권고
CORS는 브라우저의 보안 정책이므로, 브라우저 개발자 도구와 서버/프록시 로그를 함께 보면서 문제를 좁혀 가는 것이 좋습니다. 제가 정리한 순서는 저의 경험과 문서를 바탕으로 한 방법일 뿐이며, 환경에 따라 예외가 있을 수 있으니 실제 구성에서는 하나씩 확인해 보시길 권합니다.
