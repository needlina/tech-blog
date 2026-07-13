---
title: "Node.js API 에러 처리 설계 가이드: 실무에서 확인할 포인트"
slug: "nodejs-api-error-handling-practices"
date: 2026-07-13 10:00:00 +0900
categories: [Backend, Observability]
tags: [nodejs, api, error-handling, logging, observability]
image:
  path: /assets/img/posts/blog/nodejs-api-error-handling-practices/image-1.webp
  alt: "일관된 에러 응답과 로깅을 보여주는 단순한 기술 일러스트"
---

오늘은 Node.js 기반 API 서버에서 에러 처리를 어떻게 일관되게 설계하고, 실무에서 어떤 점을 확인하면 좋은지 정리해봤습니다. 저는 아직 초보 개발자라 모든 방식이 정답이라고 말하긴 어렵지만, 공부하면서 정리한 내용을 최대한 실무 지향적으로 정리해 보았습니다. 처음에 헷갈렸던 부분들과, 실제 운영 환경에서 손으로 확인해볼 수 있는 절차도 함께 적었습니다.

![일관된 에러 응답과 로깅을 보여주는 단순한 기술 일러스트](/assets/img/posts/blog/nodejs-api-error-handling-practices/image-1.webp)
이미지 출처: AI 생성 이미지

목표는 단순합니다.
- API에서 에러가 발생했을 때 클라이언트와 운영팀(로그/알림)이 같은 정보를 신뢰할 수 있게 전달되도록 설계하기
- 에러 종류(사용자 입력 오류, 외부 서비스 실패, 프로그램 버그)에 따라 적절히 분류하고, 민감한 정보는 노출하지 않기
- 운영 측면에서 장애 원인을 빠르게 파악할 수 있도록 로그·메트릭·트레이스가 연결되도록 하기

아래는 제가 공부하면서 정리한 핵심 개념과 코드/설정 예시, 그리고 실무에서 확인하면 좋을 점들입니다.

1) 핵심 개념 요약
- 에러 형태(Error Shape): API의 에러 응답은 일관된 JSON 스키마를 가지는 것이 좋습니다. 예: { error: { code, message, requestId, details? } }
- 에러 구분: 사용자 입력(validation) 에러 vs 외부 의존성 실패 vs 내부 서버 오류(버그). 각각 다르게 처리/모니터링 합니다.
- 보안: 프로덕션에서는 스택 트레이스나 내부 DB 쿼리 같은 민감한 정보를 응답에 노출하지 않습니다.
- 로깅/관측: 에러 발생 시 structured log(JSON), request id, 사용자/세션 식별자, 관련 메타데이터가 포함되어야 원인 추적이 쉬워집니다.
- 전파/집계: Sentry 같은 에러 집계 도구, Prometheus 같은 메트릭 수집은 별도 파이프라인으로 설정합니다.

2) 간단한 코드 예제 (Express 기준)
아래 코드는 제가 실습하면서 정리한 패턴입니다. 완전한 프로덕션 코드를 대체하진 못하지만, 기본 아이디어는 다음과 같습니다.

- custom error class
- 에러 미들웨어에서 일관된 응답 생성
- 로그는 pino 같은 structured logger로 기록

예시: custom error, 라우트, 에러 미들웨어

```js
// errors.js
class AppError extends Error {
  constructor({ message, status = 500, code = 'internal_error', details = null }) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}
module.exports = { AppError };
```

```js
// app.js (Express)
const express = require('express');
const pino = require('pino')();
const { AppError } = require('./errors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// 간단한 request id 미들웨어
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// 예시 라우트
app.get('/items/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) {
      throw new AppError({ message: 'Invalid id', status: 400, code: 'invalid_id' });
    }
    // ... 비즈니스 로직
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

// 에러 핸들러 미들웨어 (마지막)
app.use((err, req, res, next) => {
  const isOperational = err instanceof AppError;
  const status = isOperational ? err.status : 500;
  const code = isOperational ? err.code : 'internal_error';

  // 로그는 구조화된 형태로 남김
  pino.error({
    msg: err.message,
    code,
    requestId: req.requestId,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    meta: err.details || null
  });

  const payload = {
    error: {
      code,
      message: isOperational ? err.message : 'Internal server error',
      requestId: req.requestId
    }
  };
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    payload.error.stack = err.stack;
  }
  res.status(status).json(payload);
});
```

위 패턴의 장점은:
- 모든 응답에 requestId가 붙어서 로그와 응답을 매칭할 수 있음
- 운영 이슈(예: 외부 API 실패)는 AppError로 래핑해서 status/code를 일관되게 노출 가능
- 프로덕션에서는 스택을 숨기고 로그에서만 확인하게 함

3) 로그·모니터링·에러 수집 연계 예시
- Structured logs: pino나 winston을 사용해 JSON 로그를 남기면, ELK/Fluentd/Datadog 등으로 파이프라인이 쉬워집니다.
- Error tracking: Sentry나 Rollbar에 uncaughtException, unhandledRejection을 전송해 집계합니다.
- Metrics: 에러 비율(error_count / request_count), latency, external dependency error rates를 Prometheus로 노출합니다.

간단한 pino 설정 예:
```js
const logger = require('pino')({
  level: process.env.LOG_LEVEL || 'info',
  prettyPrint: process.env.NODE_ENV === 'development'
});
```

Sentry 연동 예 (간단):
```js
const Sentry = require('@sentry/node');
Sentry.init({ dsn: process.env.SENTRY_DSN });
// 에러 미들웨어에서 필요시 Sentry.captureException(err);
```

![에러 흐름, 로그, 모니터링을 연결한 시스템 개념 일러스트](/assets/img/posts/blog/nodejs-api-error-handling-practices/image-2.webp)
이미지 출처: AI 생성 이미지

4) 운영(DevOps) 관점에서 확인할 포인트 및 명령어/설정 예시
공부하면서 특히 중요하게 느낀 부분은 "개발자가 설계한 에러 응답이 실제 운영 환경에서도 동일하게 동작하는가" 입니다. 아래는 실무에서 직접 실행해볼 수 있는 점검 단계들입니다.

A. 프로세스/컨테이너 상태 점검
- Docker
  - 현재 컨테이너 확인: docker ps --filter "name=my-app"
  - 로그 확인: docker logs -f my-app-container
  - 종료 코드 확인: docker inspect --format='{{.State.ExitCode}}' my-app-container
  - 재시작 정책 확인: docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' my-app-container

- Kubernetes
  - 파드 상태: kubectl get pods -n myns
  - 파드 로그: kubectl logs -f deployment/my-app -n myns
  - 파드 이벤트: kubectl describe pod <pod-name> -n myns

- 프로세스 매니저 (pm2/systemd)
  - pm2 status
  - pm2 logs my-app
  - systemctl status my-app.service
  - journalctl -u my-app.service -f

B. API 응답 검증 (기본적인 체크)
- 헬스 체크: curl -sS -w '\n%{http_code}' http://localhost:3000/health
- 에러 응답 샘플: curl -i -XGET 'http://localhost:3000/items/abc' -H 'Accept: application/json'
  - 응답에 requestId, error.code, message가 일관되게 있는지 확인
- 요청 헤더에 X-Request-Id를 넣어서 로그와 매칭: curl -H "X-Request-Id: test-123" http://...

C. 로그 확인 포인트
- 로그에 requestId가 있는가
- 로그 포맷이 JSON이고, 필요한 필드(requestId, level, timestamp, error.code 등)를 포함하는가
- 에러 발생 시 로그 레벨과 내용이 적절한가(예: validation은 warn, 시스템 오류는 error)

D. 메트릭·알림 확인
- Prometheus에서 에러 비율, 5xx 수치, latency 증가 등의 알람이 설정되어 있는지 확인
- Sentry나 유사 서비스에서 빈도 높은 error.code를 모니터링하고 있는지 확인

E. 설정 예시 (docker-compose 일부)
```yaml
services:
  api:
    image: myorg/my-api:latest
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
      - SENTRY_DSN=${SENTRY_DSN}
    restart: on-failure
    ports:
      - 3000:3000
```

5) 처음에는 헷갈렸던 부분들
- "status code와 internal code를 어떻게 분리해야 하나?" : HTTP status는 클라이언트에게 의미 있고, 내부/운영 용도는 코드(code)로 상세하게 남기는 게 저는 더 유연하다고 생각하게 됐습니다. 예: 400 + code: invalid_input_email
- "스택을 응답에 포함해도 되나?" : 로컬 개발에선 유용하지만, 프로덕션에서는 보안·사용자 경험 상 권장하지 않는다는 점을 실무에서 확인했습니다.
- "언제 에러를 래핑(wrap)해야 하나?" : 외부 라이브러리/네트워크 실패 등 운영상 다시 시도하거나 경고해야 하는 에러는 AppError로 래핑해 metadata를 추가하면 추후 집계가 쉬워집니다.

6) 공부하면서 알게 된 점
- request id 하나만 있어도 로그와 응답을 연결하는 데 큰 도움이 됩니다. 단, 클라이언트가 id를 제공할 수 있는 경우(프론트엔드에서 전달)와 없는 경우를 모두 고려해야 합니다.
- structured logging이 있으면 ELK나 Datadog에서 필터링·집계가 훨씬 쉽습니다. 평범한 텍스트 로그는 나중에 추적 비용이 큽니다.
- 에러 핸들링의 목적은 단순히 500을 반환하는 게 아니라, 원인 규명과 빠른 대응을 가능하게 만드는 것입니다. 그래서 로그, 에러코드, 메트릭이 같이 설계되어야 합니다.

7) 실무에서는 이렇게 확인하면 좋겠다 (간단 체크 시나리오)
- 배포 직후(또는 새 릴리스 이후)
  1. 헬스 체크: curl /health - 응답 200, payload에 version/uptime 확인
  2. 샘플 에러 케이스 호출: validation error, 외부 API 실패를 유도(모킹) -> 응답 스키마와 status 확인
  3. 로그 일치 확인: 위 호출에서 받은 requestId를 이용해 ELK/직접 로그에서 해당 로그 항목 검색
  4. Sentry 등 연동 확인: 에러가 집계되는지 확인
  5. 메트릭 확인: Prometheus에서 에러 카운터가 예상대로 올라가는지 확인

- 장애 대응 시
  - 가장 먼저 로그에서 requestId와 에러 코드 확인
  - 외부 의존성(예: DB, 다른 서비스) 상태 확인: kubectl, docker, netstat, ps 등
  - 재현 가능한 경우라면 샌드박스에서 동일 시나리오를 재생해 원인 좁히기

8) 주의할 점(제가 조심해서 권장하는 방식)
- 너무 많은 정보(민감한 필드, DB 쿼리 등)를 응답에 담지 않기
- 에러 메시지 국제화(i18n)를 고려할 때는 외부 노출 메시지와 내부 로그 메시지를 분리하는 것이 편할 때가 있음
- 모든 것을 자동화된 알림으로 만들면 노이즈가 늘 수 있으니, alert 기준(에러 비율, 절대 수치 등)을 실적 데이터로 조정하길 권장합니다

실무 체크리스트
- [ ] 모든 API 응답에 일관된 에러 스키마가 적용되어 있는가? (error.code, message, requestId)
- [ ] requestId가 요청/응답/로그에 일관되게 포함되는가?
- [ ] 로거가 JSON 구조로 기록되는가? (timestamp, level, requestId, service)
- [ ] 프로덕션에서 스택 트레이스가 응답에 노출되지 않도록 설정되어 있는가?
- [ ] Sentry(혹은 유사 서비스)와 연동되어 주요 에러가 집계되는가?
- [ ] Prometheus 같은 메트릭에서 에러 비율/5xx 알람이 설정되어 있는가?
- [ ] 컨테이너/프로세스 상태 점검 절차(docker ps, kubectl logs, systemctl/journalctl 등)가 문서화되어 있는가?
- [ ] 배포 후 헬스 체크·샘플 에러 케이스를 자동으로 검증하는 스모크가 있는가?

마무리하며
제가 정리한 내용은 지금까지 공부하면서 실제로 써보며 느낀 권장 패턴입니다. 환경이나 팀의 요구에 따라 구현 세부는 달라질 수 있으니, 여기 적은 원칙(일관성, 식별자(requestId), 구조화된 로그, 운영에서 확인 가능한 절차)을 우선으로 두고 팀 규약에 맞춰 조정하면 좋을 것 같습니다. 틀린 부분이 있거나 더 좋은 사례가 있으면 함께 논의하면서 보완해보고 싶습니다.