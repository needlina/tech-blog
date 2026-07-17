---
title: "테스트 피라미드로 보는 단위 테스트와 통합 테스트 분리 가이드"
description: "테스트 피라미드를 기준으로 단위 테스트와 통합 테스트를 나누는 방법"
slug: "test-pyramid-unit-integration"
date: 2026-07-13 12:00:00 +0900
categories: [Testing, DevOps]
tags: ["testing", "unit-testing", "integration-testing", "테스트전략", "ci-cd"]
image:
  path: /assets/img/posts/blog/test-pyramid-unit-integration/image-1.webp
  alt: "테스트 피라미드와 단위/통합 테스트 층을 보여주는 단순한 일러스트"
---

테스트 피라미드를 기준으로 단위 테스트와 통합 테스트를 나누는 방법


테스트 피라미드를 기준으로 단위 테스트와 통합 테스트를 나누는 방법

서두 — 왜 이걸 정리하려고 했는지
저는 최근 여러 프로젝트에서 테스트를 정리하면서 '단위 테스트(unit tests)'와 '통합 테스트(integration tests)'를 어디까지로 나눠야 할지 헷갈렸습니다. 문서마다 정의가 조금씩 달랐고, 실제 코드베이스에서는 경계가 애매한 경우가 많더군요. 그래서 테스트 피라미드를 기준으로 개인적으로 정리해보고, 실무에서 확인하면 좋을 포인트들을 모아봤습니다. 완벽한 정답을 제시하려는 건 아니고, 제가 공부하면서 정리한 방식과 실무에서 바로 적용해볼 체크리스트 위주로 적습니다.

![테스트 피라미드와 단위/통합 테스트 층을 보여주는 단순한 일러스트](/assets/img/posts/blog/test-pyramid-unit-integration/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점 (요약)
- 테스트 피라미드는 '빠르고 많은 단위 테스트' 밑에 '적은 수의 느린 통합/엔드투엔드 테스트'가 쌓이는 형태로 이해하는 게 실무에서 유용했습니다.
- 단위 테스트는 외부 의존(네트워크, DB, 파일시스템 등)을 가능한 모킹(mocking)해 코드 단위(함수/클래스)를 검증합니다. 빠르고 격리된 테스트가 목표입니다.
- 통합 테스트는 여러 컴포넌트가 함께 작동하는지 확인합니다. 실제 DB나 메시지 큐를 띄우거나, 최소한의 컨테이너 기반 환경으로 검증하는 경우가 많습니다.
- 중요한 건 '테스트의 목적'을 기준으로 나누는 것이지, 단순히 파일 위치만으로 판단하지 않는다는 점이었습니다.

처음에는 헷갈렸던 부분
- "모든 외부 호출을 모킹하면 단위 테스트인가?" — 실무적으로는 외부 호출을 모킹하면 단위 테스트로 보지만, 함수가 모킹된 의존성과 어떻게 상호작용하는지까지 검증하는 것도 중요합니다. 모킹을 과도하게 하면 내부 로직의 통합성 문제를 놓칠 수 있습니다.
- "DB 스키마 변경을 통합 테스트로 확인해야 하나?" — 스키마 관련 검증은 통합 테스트 영역이 맞는 경우가 많습니다. 다만 마이그레이션 스크립트를 별도의 파이프라인에서 검사하기도 합니다.
- "테스트 속도 vs 신뢰성" — 빠른 단위 테스트를 많이 두는 것이 좋지만, 중요한 흐름(특히 데이터 관련)은 통합 테스트로 반드시 확인해야 합니다.

테스트 구분의 실무 기준 (제가 적용해본 원칙)
- 단위 테스트
  - 책임: 단일 함수/클래스의 동작을 검증.
  - 외부 의존성: 모두 모킹 또는 스텁 처리.
  - 속도: 매우 빠름(수 ms~수 십 ms).
  - 위치: tests/unit 또는 __tests__/unit 같은 폴더.
  - 실행: 로컬 개발자 PC와 PR에서 빠르게 실행. (예: npm run test:unit, pytest -m unit)
- 통합 테스트
  - 책임: 여러 모듈/서비스가 함께 동작하는지 확인.
  - 외부 의존성: 실제 DB/외부서비스(또는 최소한의 컨테이너화된 스탬)를 사용하거나, 실제와 유사한 환경을 띄움.
  - 속도: 느림(수 초~수 분).
  - 위치: tests/integration 또는 __tests__/integration.
  - 실행: CI에서 병렬화하거나 별도 스테이지에서 실행. 로컬에서는 docker-compose로 재현.

간단한 예제 — Jest (Node.js) 구조
프로젝트 구조 예시:
- src/
  - lib.js
- tests/
  - unit/
    - lib.unit.test.js
  - integration/
    - lib.integration.test.js

package.json 스크립트 예시:
```json
{
  "scripts": {
    "test": "npm run test:unit && npm run test:integration",
    "test:unit": "jest --testPathPattern=tests/unit",
    "test:integration": "jest --testPathPattern=tests/integration --runInBand"
  }
}
```

단위 테스트 (lib.unit.test.js)
```js
const { add } = require('../../src/lib');
jest.mock('../../src/db'); // 외부 DB 의존을 모킹

test('add should return sum', () => {
  expect(add(1, 2)).toBe(3);
});
```

통합 테스트 (lib.integration.test.js)
```js
// real DB가 필요하거나, 테스트 DB 컨테이너가 켜져 있을 때 실행
const { addWithDb } = require('../../src/lib');
const db = require('../../src/db');

beforeAll(async () => {
  await db.connect(process.env.TEST_DB_URL);
});
afterAll(() => db.disconnect());

test('addWithDb should persist and return result', async () => {
  const res = await addWithDb(2, 3);
  expect(res).toBe(5);
  const saved = await db.findLast();
  expect(saved.value).toBe(5);
});
```

간단한 예제 — pytest (Python) 구조
- tests/unit/test_math.py
- tests/integration/test_api_db.py

pytest 마커를 사용해 구분:
pytest.ini:
```ini
[pytest]
markers =
    integration: mark test as integration
```

실행법:
- 단위: pytest -m "not integration"
- 통합: pytest -m integration

통합 테스트 환경 구성 (Docker 사용 권장)
간단한 docker-compose.test.yml 예:
```yaml
version: '3.8'
services:
  db:
    image: postgres:15
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: test_db
    ports:
      - "5433:5432"
  app:
    build: .
    environment:
      DATABASE_URL: postgres://test:test@db:5432/test_db
    depends_on:
      - db
```

로컬 통합 테스트 실행 예:
1. docker-compose -f docker-compose.test.yml up --build -d
2. (필요시) docker-compose exec app /bin/sh -c "pytest tests/integration"
3. docker-compose -f docker-compose.test.yml down

실무에서는 이렇게 확인하면 좋겠다 (체크 포인트 중심)
- 테스트 파일의 위치와 네이밍 규칙이 일관되는지 확인하세요.
  - 예: tests/unit/*.py, tests/integration/*.py 또는 __tests__/unit
- CI에서 단위/통합 테스트를 분리해 실행하는지 확인하세요.
  - 단위는 빠른 PR 피드백용으로, 통합은 병렬화/별도 스테이지로.
- 통합 테스트는 가능한 한 격리된 리소스(테스트 DB, 임시 큐)를 사용하도록 구성하세요.
  - CI에선 ephemeral DB, 테스트 전후 데이터 초기화/마이그레이션 스크립트 필요.
- 테스트 데이터 초기화와 마이그레이션 절차를 문서화하세요.
  - 데이터 잔존으로 인한 flaky 테스트를 줄이는 게 중요합니다.
- 테스트 태깅/마커를 활용해 원하는 테스트만 선별 실행할 수 있게 하세요.
  - pytest -m integration, jest --testPathPattern 등.
- 느린 통합 테스트는 병렬화하거나 적절한 타임아웃을 설정하세요.
  - Jest는 --maxWorkers, pytest는 xdist 사용 가능.
- 테스트 실패 시 로그와 상태를 잘 수집하는지 확인하세요.
  - DB 로그, HTTP 응답, 컨테이너 상태 등을 아카이빙하면 원인 파악에 도움이 됩니다.

중간 팁: 플라키(간헐적 실패) 줄이기
- 네트워크 호출이나 시간에 민감한 로직은 단위 테스트에서 모킹하세요.
- 통합 테스트에선 재시도 로직과 충분한 준비 시간(wait-for-service) 사용을 고려하세요.
- 로컬과 CI 환경의 시간 동기화(타임존, NTP) 차이로 실패하는 경우도 있었습니다.

![단위 테스트와 통합 테스트 분리 시나리오를 간단히 도식화한 일러스트](/assets/img/posts/blog/test-pyramid-unit-integration/image-2.webp)
이미지 출처: AI 생성 이미지

CI 예시 — GitHub Actions 워크플로 간단 스니펫
(실무에 맞게 수정해서 사용하세요)
```yaml
name: CI

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm ci
      - run: npm run test:unit

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test_db
        ports:
          - 5433:5432
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm ci
      - run: npm run test:integration
```

실무에서의 추가 고려사항 (제가 겪은 작은 팁)
- 로컬에서 통합 테스트용 스크립트를 만들어 두면 환경 재현이 쉬워집니다. 예: ./scripts/test-integration.sh
- 통합 테스트의 로그를 CI artifact로 남기면 실패 원인 추적에 도움이 됩니다.
- 테스트 커버리지는 참고지표로만 사용하세요. 100% 목표는 비용 대비 이득이 작을 수 있습니다.
- 테스트 데이터는 가능한 고정(seed)와 모듈화된 fixture로 구성하세요.

마무리 — 조심스럽게 정리한 제 경험
저는 위 원칙을 기준으로 테스트를 정리하니 PR 피드백 속도가 좋아지고, 배포 전 큰 데이터 관련 문제가 줄었습니다. 다만 팀과 프로젝트 성격에 따라 경계는 달라질 수 있으니, 이 글을 그대로 적용하기보다는 팀 규칙으로 합의하고 점진적으로 개선하는 것을 권합니다.

실무 체크리스트
- [ ] 단위/통합 테스트 폴더 구조와 네이밍 규칙이 문서화되어 있는가?
- [ ] CI에서 unit과 integration을 분리된 job/stage로 실행하고 있는가?
- [ ] 통합 테스트용 리소스(DB, 큐 등)가 격리되어 프로비저닝되는가?
- [ ] 테스트 전후 데이터 초기화(마이그레이션/롤백)가 자동화되어 있는가?
- [ ] 느린 통합 테스트는 병렬화/리트라이/타임아웃 처리가 되어 있는가?
- [ ] 테스트 실패 시 로그/아티팩트를 수집하는가?
- [ ] 개발자가 로컬에서 통합 테스트를 쉽게 재현할 수 있는 스크립트가 있는가?

참고로, 제가 정리한 내용은 한 가지 방법일 뿐이고, 프로젝트 특성에 맞춰 조정하는 게 중요합니다. 필요하면 제 예제를 기반으로 여러분의 프로젝트 설정에 맞춘 예시(예: Django, Spring Boot, Go 등)도 이어서 정리해볼게요.