---
title: "통합 테스트 경량화: Factory 대체 패턴으로 실행 시간 줄이기"
description: "통합 테스트 실행시간 단축을 위한 factory 대체 패턴 설명 · 적용 조건 · 간단 코드 예 · CI에서 검증할 포인트 · 주의사항과 체크리스트"
slug: "lightweight-integration-tests-factory-substitutions"
date: 2026-07-18 12:00:00 +0900
categories: ["Testing", "DevOps"]
tags: ["testing", "integration-testing", "test-factory", "테스팅", "배포자동화"]
image:
  path: /assets/img/posts/blog/lightweight-integration-tests-factory-substitutions/preview.png
  alt: "통합 테스트 경량화 썸네일"
---

통합 테스트가 느려서 CI 파이프라인 전체를 지연시키는 문제는, **비용이 큰 전체 환경 시동과 외부 의존성 호출을 테스트용 가벼운 factory(대체 구현)로 바꿔 실행시간을 줄이는 것**으로 실질적 개선을 볼 수 있습니다. 핵심은 필요한 통합 검증을 유지하면서도 환경 구성 비용(데이터베이스 시드, 외부 API, 컨테이너 시작 등)을 최소화하는 점검 포인트를 명확히 하는 것입니다.

서두는 요약만 짧게 적었고, 아래부터는 제가 공부하면서 정리한 흐름대로 천천히 설명할게요. 실무에서 바로 확인하면 좋을 포인트와, 제가 처음에 헷갈렸던 부분도 같이 적어뒀습니다.

왜 이런 패턴을 고민했나
- 우리 CI에서 느린 통합 테스트는 주로 외부 DB 초기화, 컨테이너 시작, 외부 API 호출 때문에 느렸습니다.
- 전체 E2E를 매번 띄우면 안정성은 높아지지만 빌드 시간이 지나치게 길어져 개발자 피드백 루프가 깨졌습니다.
- 그래서 일부 검증을 '가볍게' 대체하는 패턴을 공부하게 되었고, 그 과정을 정리합니다.

공부하면서 알게 된 점
- 모든 테스트를 factory로 대체할 수는 없고, **검증 목적(무엇을 보장해야 하는가)에 따라 대체 여부를 결정**해야 합니다.
- 빠른 피드백이 필요한 단위/통합 경계의 테스트는 대체 구현을 사용해도 괜찮지만, 실제 운영 환경 변화를 감지해야 하는 테스트(예: 마이그레이션 검증, 실제 네트워크 장애 시 동작)는 실제 환경에서만 확인해야 할 가능성이 큽니다.
- CI에서는 빠르게 실패를 알려주는 테스트(문법, 계약, 비즈니스 로직)를 우선 실행하고, 느린 전체 통합 테스트는 야간․주간으로 분리하는 것이 현실적이라는 점을 배웠습니다.

처음에는 헷갈렸던 부분
- "factory로 대체하면 실제 문제가 가려지지 않을까?"가 가장 큰 고민이었어요. 경험적으로는, 대체된 테스트가 통과해도 정기적으로(예: PR 머지 후, 또는 매주) 실제 통합 환경에서 E2E를 돌리는 규칙을 두면 위험을 줄일 수 있었습니다.
- mock(인터페이스 수준 대체)과 factory(데이터/경량 서비스 대체)의 경계가 모호했는데, 목적에 따라 선택하면 됐습니다. 표준화된 가이드가 없으면 팀마다 혼동이 올 수 있으니 이 부분은 문서로 남기면 좋아요.

패턴별 비교 (언제 어떤 걸 선택하면 좋을지)
| 패턴 | 장점 | 단점 | 추천 시점 |
|---|---:|---|---|
| Full E2E (컨테이너/실 DB) | 현실과 가장 비슷함 | 느림, 비용 큼 | 배포 전 최종검증, 마이그레이션 |
| Mocking (인터페이스 수준) | 빠름, 안정적 | 통합 문제는 놓칠 수 있음 | 유닛/계약 검증 |
| Factory 대체 (경량 서비스/데이터) | 속도 개선, 실제 로직 검증 가능 | 일부 인프라 이슈 미검출 | CI 빠른 피드백, 통합 로직 검증 |

위 표에서처럼 저는 **CI 기본 파이프라인은 factory 대체 중심 + 정기적인 Full E2E로 보완**하는 방식을 추천하고 싶습니다. 단, 어떤 검증을 factory로 대체할지 기준을 세워두는 게 중요합니다.

간단한 예제 (pytest + Python 스타일)
- 상황: 외부 결제 API 호출이 포함된 통합 테스트가 느림. 실제 네트워크 대신 경량 factory로 대체해서 테스트 속도를 개선한다.
```python
# tests/conftest.py
import pytest

class PaymentFactory:
    def create_success_response(self, amount):
        return {"status": "OK", "amount": amount, "tx_id": "fake-123"}

@pytest.fixture
def payment_factory():
    return PaymentFactory()

# application code uses a PaymentGateway interface that in prod calls external API
# In tests, we inject payment_factory to simulate responses.
```

```python
# tests/test_order_flow.py
def test_order_payment_success(app_client, payment_factory, monkeypatch):
    # app_client는 테스트용 앱 클라이언트
    # monkeypatch로 외부 호출을 factory로 대체
    def fake_charge(amount):
        return payment_factory.create_success_response(amount)

    monkeypatch.setattr("app.payment_gateway.charge", fake_charge)

    resp = app_client.post("/order", json={"amount": 100})
    assert resp.status_code == 200
    assert resp.json()["payment"]["status"] == "OK"
```

위 예제에서 중요한 점은 대체를 적용한 테스트가 `비즈니스 로직`을 검증하는 데 충분해야 한다는 것입니다. 외부 API의 실패 모드를 검증하려면 factory에서 실패 케이스도 만들면 됩니다.

실무에서 이렇게 확인하면 좋겠다
- 테스트 레벨별 책임 정의: 팀 내 문서로 "Unit / Integration(factory) / Full E2E"의 기준을 정의해 두세요.
- CI 파이프라인 배치: PR 빌드에서는 빠른 그룹(유닛+factory 통합)만 실행하고, 머지 후 브랜치 빌드나 스케줄러로 Full E2E를 돌리는 전략을 권장합니다.
- 데이터 초기화 비용 측정: DB 시드/마이그레이션 시간이 전체 빌드에서 차지하는 비율을 측정하면 어떤 부분을 factory로 대체해야 할지 판단이 쉬워집니다.
- 실패 케이스 테스트: factory는 정상 케이스뿐 아니라 실패 케이스도 제공해서 경로 커버리지를 확보하세요.
- 로그와 트레이스: factory 사용 시 실제 네트워크 호출이 없어도, **요청/응답 포맷 체크**와 내부 로깅이 동일하게 동작하는지 확인하세요.

실제 적용 시 주의사항 (위험 포인트)
- **데이터 스키마 불일치**: factory가 오래되어 스키마 변경을 반영하지 않으면 테스트가 통과해도 런타임에서 깨집니다. 정기 점검이 필요합니다.
- 환경 차이로 인한 오탐: 로컬/CI/프로덕션에서 다르게 동작할 수 있으니, 환경별 설정을 명확히 해두세요.
- 과도한 대체: 보이는 모든 느린 테스트를 대체하면 통합 리스크가 축적될 수 있습니다. 중요 경로는 실제로 검증하세요.

이미지 예시: 테스트 레이어와 교체 포인트를 시각화한 다이어그램
![테스트 레이어와 대체 포인트를 단순화한 다이어그램](/assets/img/posts/blog/lightweight-integration-tests-factory-substitutions/image-1.webp)
이미지 출처: AI 생성 이미지

자주 묻는 질문 (Q&A)
Q: 모든 통합 테스트를 factory로 바꿔도 되나요?
A: 아마도 아닐 가능성이 큽니다. 핵심은 무엇을 보장해야 하는지에 따라 결정하세요. 운영 이슈로 이어질 수 있는 경로는 실제 통합 테스트로 확인하는 편이 안전합니다.

Q: factory 구현도 테스트 유지보수 부담이 크지 않나요?
A: 맞습니다. factory도 코드이므로 유지보수가 필요합니다. 이를 줄이려면 factory를 단순하고 명시적으로 만들고, 변경 시 관련 테스트를 함께 수정하는 규칙을 두세요.

Q: CI에서 어느 정도 비율로 Full E2E를 돌려야 하나요?
A: 정답은 없지만 실무에서는 매주/야간 전체 E2E, PR 머지 후 브랜치 대상으로 최소한 한 번 실행을 권장합니다. 서비스 변경 빈도와 위험도에 맞춰 조절하세요.

Q: flaky 테스트가 factory 때문에 가려질 수 있나?
A: 네. factory가 flakiness 원인을 가릴 수 있습니다. flaky 원인은 파악해서 별도로 트래킹하고, 실제 환경에서 재현 가능한지 확인해야 합니다.

비교 표: 실행 전략별 요약
| 체크포인트 | Full E2E | Factory 대체 | Mocking |
|---|---:|---:|---|
| 속도 | 느림 | 보통→빠름 | 빠름 |
| 현실성 | 높음 | 중간 | 낮음 |
| 유지보수 비용 | 높음 | 중간 | 중간 |
| 발견 가능한 문제 | 대부분 | 비즈니스 로직 중심 | 인터페이스 중심 |
| CI 적용 권장 | 주기적/배포 전 | PR/머지 단계 | 개발 중 빠른 피드백 |

이미지 예시: CI 단계에서 테스트 분리와 실행 우선순위
![CI 파이프라인에서 테스트 그룹을 나누어 실행하는 개념도](/assets/img/posts/blog/lightweight-integration-tests-factory-substitutions/image-2.webp)
이미지 출처: AI 생성 이미지

코드와 도구 팁
- pytest: fixture와 monkeypatch를 활용해 의존성 대체를 깔끔하게 구현하세요.
- Java(Spring): profile이나 TestConfiguration으로 test bean을 주입해 factory 대체를 구현할 수 있습니다.
- GitHub Actions / GitLab CI: 빠른 빌드는 PR용 워크플로로, Full E2E는 스케줄러용 워크플로로 분리하면 좋습니다.
- 모니터링: E2E 실패시 어떤 레이어에서 실패했는지 알 수 있도록 로그/트레이스를 남기는 것이 중요합니다.

## 나의 의견 1
여기에 직접 겪은 경험(예: 어느 테스트를 factory로 바꿨더니 CI 시간이 얼마나 줄었는지)을 짧게 적어보세요.

## 나의 의견 2
여기에 이번 글을 바탕으로 팀에 적용해본 결과나, 앞으로 시도해볼 개선 아이디어를 적어보세요.

실무 체크리스트
- [ ] 테스트 레벨별 책임(유닛/통합(factory)/Full E2E) 문서화
- [ ] 느린 테스트의 비용(시작 시간, 데이터 시드 시간) 측정
- [ ] factory에서 다뤄야 할 정상/실패 케이스 목록 작성
- [ ] CI 파이프라인에서 빠른 그룹과 느린 그룹 분리 구현
- [ ] 주기적(예: 주간/야간) Full E2E 스케줄러 설정
- [ ] factory 코드와 실제 통합 환경(스키마, 프로토콜) 정합성 주기 검토
- [ ] flaky 테스트 추적용 티켓/대시보드 준비

마무리하며
제가 이 패턴을 적용하면서 가장 도움이 됐던 건 **"무엇을 검증하려고 하는지 명확히 하는 일"**이었습니다. 대체 패턴은 도구일 뿐 목적을 대체하면 안 된다는 점을 계속 확인하세요. 궁금한 점이나 팀 적용 사례에 대해 더 깊게 알고 싶으면 어떤 환경(언어, CI, 외부 의존성)을 사용하는지 알려주시면 그에 맞는 예시를 더 준비해볼게요.