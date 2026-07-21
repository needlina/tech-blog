---
title: "서버리스에서 장기 실행 작업 안전하게 취소하고 리소스 해제하기"
description: "서버리스 함수(FaaS/컨테이너)에서 타임아웃·중단 시 리소스 누수 방지하는 체크포인트·타임아웃 검사·외부 작업 위임 패턴, 재시도/회복 절차, 검증 명령과 로그 확인 경로"
slug: "serverless-long-running-task-cancellation-pattern"
date: 2026-07-20 23:59:00 +0900
categories: ["Cloud", "DevOps"]
tags:
  [
    "serverless",
    "aws-lambda",
    "step-functions",
    "resource-cleanup",
    "배포자동화",
    "장애대응"
  ]
image:
  path: /assets/img/posts/blog/serverless-long-running-task-cancellation-pattern/preview.png
  alt: "서버리스 작업 취소 썸네일"
---

서버리스 함수에서 장기 실행 작업을 안전하게 취소하려면 실행 루틴에 외부 상태 체크포인트(예: S3/DynamoDB 체크포인트), 런타임 남은 시간 검사, 그리고 가능하면 외부 워크플로(큐나 Step Functions)로 위임하는 세 축을 결합해 리소스 해제를 설계하는 것이 현실적으로 가장 안전합니다. 실무에서는 **남은 실행 시간 확인**, **작업 재개용 체크포인트 기록**, **외부 작업 취소 신호 지원** 세 가지를 먼저 점검하세요.

왜 이걸 적고 있냐면, 로컬에서는 잘 돌아가는데 실제 클라우드에서 함수가 중간에 잘려서 DB 커넥션이 남아 있거나 잠금이 풀리지 않는 문제를 겪었기 때문입니다. 이번 글은 제가 공부하면서 헷갈렸던 부분과 실무에서 바로 확인할 포인트, 실패 예시와 수정 예시를 중심으로 정리한 초안입니다.

목차

- 문제 상황: 왜 서버리스에서 취소가 어려운가
- 패턴 비교(간단 표)
- 코드 예시: 실패 예시 / 수정 예시 (Node.js, Python)
- 운영·검증: 명령어, 로그 문구, 파일 경로, 런타임 버전
- 처음에 헷갈렸던 점 / 공부하면서 알게 된 점
- 실무에서 이렇게 확인하면 좋겠다(체크리스트 포함)
- Q&A
- 실무 체크리스트

문제 상황: 왜 서버리스에서 취소가 어려운가

- FaaS(예: AWS Lambda, Azure Functions)는 호출 단위로 컨테이너를 관리하고, 플랫폼이 임의로 인스턴스를 종료하거나 타임아웃을 발생시킬 수 있음.
- 컨테이너형 서버리스(예: Cloud Run, Knative)는 SIGTERM 등 graceful shutdown을 제공하지만, 함수형 플랫폼은 그런 시그널을 보장하지 않는 경우가 있어 비교적 취소 제어가 제한적임.
- 그래서 네트워크 연결, DB 트랜잭션, 외부 리소스 잠금이 남는 것이 문제.

간단 비교 표: 선택지별 장단점과 사용 시점

| 패턴                             | 장점                        | 단점                  | 사용 시점                |
| -------------------------------- | --------------------------- | --------------------- | ------------------------ |
| **Step Functions / 워크플로**    | 상태 관리·재시도 내장       | 비용·복잡도 증가      | 긴 작업(수 분 ~ 수 시간) |
| **비동기 큐(예: SQS) + 워커**    | 처리 제어 쉬움, 재시도 유연 | 별도 인프라 필요      | 작업 분해 가능할 때      |
| **함수 내부 체크포인트**         | 간단, 코드만 변경           | 복구 포인트 설계 필요 | 반복 가능한 작업         |
| **컨테이너 기반 종료 신호 처리** | SIGTERM 처리로 graceful     | 컨테이너 실행비용     | 장기 연결이 필요할 때    |

공부하면서 알게 된 점

- **남은 시간 점검이 가장 현실적**: AWS Lambda에서는 context.getRemainingTimeInMillis()로 남은 시간을 확인해 네트워크 호출을 취소하거나 체크포인트를 남기면 실제 타임아웃 상황에서의 손해를 줄일 수 있었다.
- 컨테이너형 서버리스(Cloud Run 등)는 SIGTERM을 받고 graceful shutdown을 시도할 수 있어, 장기 작업을 해야 한다면 컨테이너 패턴이 더 안전할 때가 있다.
- 외부 리소스(예: DB 트랜잭션, 분산 락)는 작업이 중단됐을 때 자동 해제 되지 않을 수 있으므로 **타임아웃내 체크포인트 + 보상(Compensating action)** 설계가 필요했다.

처음에는 헷갈렸던 부분

- "함수 플랫폼에서 SIGTERM을 언제 보내는가?"와 "context.getRemainingTimeInMillis로 모든 문제를 해결할 수 있는가?"는 서로 다른 질문이었다.
  - FaaS는 플랫폼별 제약이 달라 동일한 전략이 통하지 않을 수 있음(예: Lambda는 명시적 SIGTERM 동작을 보장하지 않음).
- "체크포인트를 얼마나 자주 남겨야 하는가?"는 비용·성능·중복 작업 양의 트레이드오프가 있었다.

실무에서 이렇게 확인하면 좋겠다 (핵심 포인트)

- **런타임 버전**: Node.js 18.x, Python 3.10 등 실제 런타임을 명시하고 테스트하기.
- **타임아웃 설정**: 함수 설정 파일(template.yaml / function.json) 또는 클라우드 콘솔에서 timeout 값을 확인/조정.
- **로그에서 타임아웃 문구 확인**: AWS Lambda 실패 메시지는 보통 "Task timed out after X.XX seconds" 형태로 남음.
- **체크포인트 적중률 측정**: 체크포인트 파일(S3 객체)이나 DB 레코드에서 정상 완료된 작업 대비 중단 재시도 케이스 비율을 수치로 수집(예: 95% 복구 성공).
- **리소스 누수 점검**: DB 연결 수(pg_stat_activity 쿼리), 락 테이블, 외부 서비스의 미완료 작업 목록 확인.

코드 예시: 실패 예시와 수정 예시 (Node.js)

- 실패 예시: 남은 시간 검사 없이 긴 루프 또는 외부 요청 블로킹

```js
// handler-fail.js
// Node.js 18.x, Lambda 스타일
exports.handler = async function (event) {
  // 긴 연산: 외부 API 여러 번 호출
  for (let i = 0; i < 10000; i++) {
    await fetch(`https://example.com/work/${i}`); // 블로킹
  }
  return { status: "done" };
};
```

- 수정 예시: 남은 시간 확인, AbortController로 요청 취소, 체크포인트 기록

```js
// handler-fixed.js
// Node.js 18.x
const fetch = globalThis.fetch;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

exports.handler = async function (event, context) {
  for (let i = 0; i < 10000; i++) {
    // 남은 시간 체크: 2000ms 이하이면 중단하고 체크포인트 저장
    const remaining = context.getRemainingTimeInMillis();
    if (remaining < 2000) {
      // 체크포인트 저장(예: S3/DynamoDB)
      await saveCheckpoint({ lastIndex: i });
      return { status: "checkpointed", lastIndex: i };
    }

    // AbortController로 네트워크 호출 취소 가능
    const ac = new AbortController();
    const timeoutId = setTimeout(
      () => ac.abort(),
      Math.min(remaining - 500, 5000)
    );

    try {
      await fetch(`https://example.com/work/${i}`, { signal: ac.signal });
    } catch (err) {
      if (err.name === "AbortError") {
        await saveCheckpoint({ lastIndex: i });
        return { status: "aborted", lastIndex: i };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return { status: "done" };
};

async function saveCheckpoint(data) {
  // 예시: S3나 DynamoDB에 기록
  // S3 업로드 또는 DynamoDB PutItem 코드
  await sleep(10); // 네트워크 대기 시뮬레이션
}
```

Python (Azure Functions 스타일) 예시: 타임아웃을 체크해서 DB 트랜잭션을 안전히 종료하는 패턴

```py
# handler_fixed.py
# Python 3.10
import time
import requests
from azure.functions import Context

def main(req, context: Context):
    start = time.time()
    for i in range(10000):
        elapsed = time.time() - start
        remaining = context.remaining_time() if hasattr(context, 'remaining_time') else 300
        if remaining < 2:
            save_checkpoint(i)
            return {"status": "checkpointed", "last": i}
        try:
            r = requests.get(f"https://example.com/work/{i}", timeout=5)
        except requests.exceptions.Timeout:
            save_checkpoint(i)
            return {"status": "request-timeout", "last": i}
    return {"status": "done"}

def save_checkpoint(i):
    # DB에 기록하거나 파일 업로드
    pass
```

![서버리스 작업 취소 개념 다이어그램](/assets/img/posts/blog/serverless-long-running-task-cancellation-pattern/image-1.webp)
이미지 출처: AI 생성 이미지

운영·검증: 실행 가능한 명령어와 확인 방법 (구체성 충족)

- 로컬 재현
  - SAM 로컬(예: AWS SAM CLI): sam local invoke MyFunction -e event.json
  - Docker 런타임 테스트(Cloud Run용 컨테이너): docker run --rm -p 8080:8080 my-image:latest
- 로그 확인
  - AWS: aws logs tail /aws/lambda/my-function --since 1h --follow
  - GCP: gcloud functions logs read my-function --limit 50
- 함수 설정/파일 위치 예시
  - AWS SAM template: template.yaml (Resource > Properties > Timeout)
  - Lambda 핸들러 파일: src/handler.js
  - 컨테이너 Dockerfile: ./Dockerfile
- 런타임/도구 버전 예시
  - Node.js 18.x, Python 3.10, Docker 20.10.x, AWS SAM CLI 1.x
- 흔한 실패 메시지 예시
  - "Task timed out after 300.00 seconds" (Lambda 타임아웃 로그 예시)
  - 네트워크 호출 취소 시 "AbortError" (Node fetch)
- 측정 수치 예시(검증 지표)
  - 체크포인트 성공률: 99% 이상 권장(서비스 SLA에 따라 다름)
  - 평균 복구 시간(RTO): 체크포인트 기반 복구로 30초 이내 목표

실패 사례와 수정 흐름(재현 명령 포함)

1. 문제 재현
   - 배포한 Lambda에 대량 작업 이벤트를 넣음: sam local invoke 또는 AWS 콘솔에서 테스트
   - 로그에서 "Task timed out after ..." 메시지 확인
2. 원인 추적
   - handler 코드에 남은 시간 체크가 없는지 확인
   - DB에서 열린 연결 확인: PostgreSQL 예시
     - psql -h host -U user -c "SELECT state, count(\*) FROM pg_stat_activity GROUP BY state;"
3. 수정
   - 코드에 context.getRemainingTimeInMillis 검사 추가
   - 장기 외부 호출은 비동기 큐로 이동(SQS) 또는 Step Functions로 분리
4. 검증
   - sam local invoke -e event-long.json
   - aws logs tail /aws/lambda/my-function --since 10m

실무 팁(짧게)

- **작업을 작게 쪼개기**: 1회 호출이 최대 1분 미만일 수 있도록 작업을 분해하면 복구가 쉬움.
- **체크포인트 설계**: 중간상태를 덮어쓰기 식으로 저장하면 재시도 시 중복 처리 로직이 단순해짐.
- **외부 리소스 보상 처리**: 트랜잭션이 중단되면 보상 작업(compensating action)을 스케줄링하는 것이 안전.

Q&A (자주 묻는 질문)

Q: Lambda에서 SIGTERM을 받을 수 있나?  
A: Lambda는 플랫폼 내부적으로 인스턴스를 관리하고 SIGTERM 동작을 사용자에게 보장하지 않을 수 있으니 **context.getRemainingTimeInMillis** 기반 방어가 더 현실적입니다.

Q: 체크포인트를 너무 자주 쓰면 비용이 큰가?  
A: 네. 체크포인트 빈도는 비용/복구정확성/중복 처리 비용의 균형입니다. 예산과 SLA를 고려해 1회 작업 단위를 기준으로 결정하세요.

Q: Step Functions와 큐, 어느 쪽이 더 쉬운가?  
A: 아래 표 참고하세요.

| 항목        | Step Functions  | 큐 + 워커      |
| ----------- | --------------- | -------------- |
| 상태 관리   | O               | 워커 구현 필요 |
| 복잡한 분기 | 좋음            | 코드로 구현    |
| 비용        | 상대적으로 높음 | 워커 비용 변동 |

![서버리스 작업 체크포인트와 재시도 흐름 일러스트](/assets/img/posts/blog/serverless-long-running-task-cancellation-pattern/image-2.webp)
이미지 출처: AI 생성 이미지

실무 체크리스트 (바로 따라할 것)

- 코드 점검
  - handler 파일 경로 확인: src/handler.js 또는 src/handler.py
  - 남은 시간 검사 사용: Node(context.getRemainingTimeInMillis), Azure(context.remaining_time)
- 배포 설정
  - template.yaml / function.json에서 Timeout 값 확인 및 주석으로 기록
  - 컨테이너의 경우 Dockerfile에 HEALTHCHECK 명시
- 로그/재현
  - sam local invoke MyFunction -e tests/event-long.json
  - aws logs tail /aws/lambda/my-function --since 1h --follow
- DB / 리소스 점검
  - PostgreSQL: psql -h HOST -U USER -c "SELECT count(\*) FROM pg_stat_activity WHERE state = 'idle';"
  - 남은 락 확인: SELECT \* FROM pg_locks;
- 복구/검증
  - 체크포인트 파일 존재 여부: aws s3 ls s3://my-bucket/checkpoints/
  - 재시도 성공률 측정: 최근 24시간 체크포인트 복구 이벤트 / 총 이벤트 비율
- 문서·참고
  - AWS Lambda timeout 및 context: https://docs.aws.amazon.com/lambda/latest/dg/
  - Step Functions: https://docs.aws.amazon.com/step-functions/
  - Cloud Run graceful shutdown: https://cloud.google.com/run/docs

마무리 — 무엇을 먼저 확인하고, 언제 다른 선택지가 나은지

- 먼저 확인할 것: 현재 플랫폼(FaaS인지 컨테이너형인지), 런타임 버전, 함수의 timeout 설정, 그리고 로그에서 "Task timed out..." 같은 타임아웃 문구. 이 네 가지가 문제 해결 우선순위를 결정합니다.
- 다른 선택지가 나은 때:
  - 작업이 수 분~수 시간 걸린다면 Step Functions 또는 컨테이너 기반(Cloud Run)으로 옮기는 것이 더 안전합니다.
  - 작업이 잘게 쪼갤 수 있다면 큐 + 워커 패턴을 추천합니다.

참고(공식 문서)

- AWS Lambda 개발자 가이드: https://docs.aws.amazon.com/lambda/latest/dg/
- AWS Step Functions: https://docs.aws.amazon.com/step-functions/
- Cloud Run graceful shutdown: https://cloud.google.com/run/docs/
