---
title: "기술 블로그 코드 스니펫을 항상 실행 가능하게 유지하는 자동화 전략"
description: "서문 저는 기술 블로그에 글을 쓰면서 코드 스니펫이 점점 쌓여가는 것을 경험했습니다. 그런데 시간이 지나면 옛날에 썼던 예제가 동작하지 않거나 의존성 충돌로 실패하는 일이 생기더군요"
slug: "tech-blog-snippet-automation"
date: 2026-07-15 10:00:00 +0900
categories: ["Blogging", "DevOps"]
tags:
  [
    "blogging",
    "github-actions",
    "continuous-testing",
    "code-snippets",
    "automation"
  ]
image:
  path: /assets/img/posts/blog/tech-blog-snippet-automation/preview.png
  alt: "블로그 코드 스니펫 관리 썸네일"
---

서문 저는 기술 블로그에 글을 쓰면서 코드 스니펫이 점점 쌓여가는 것을 경험했습니다. 그런데 시간이 지나면 옛날에 썼던 예제가 동작하지 않거나 의존성 충돌로 실패하는 일이 생기더군요


기술 블로그 코드 스니펫을 실행 가능하게 유지하는 자동화 전략

서문
저는 기술 블로그에 글을 쓰면서 코드 스니펫이 점점 쌓여가는 것을 경험했습니다. 그런데 시간이 지나면 옛날에 썼던 예제가 동작하지 않거나 의존성 충돌로 실패하는 일이 생기더군요. 그래서 최근에는 "블로그에 올린 코드가 항상 실행 가능한 상태"를 목표로 작은 자동화 파이프라인을 만들어 보고 있습니다. 이 글은 제가 공부하면서 정리한 내용과 실무에서 확인해볼 만한 포인트를 중심으로 적은 메모입니다. 아직 완벽하지 않을 수 있으니, 제안된 방법을 그대로 적용하기보다는 팀 환경에 맞게 조정하는 게 좋겠습니다.

공부하면서 알게 된 점

- 코드 스니펫이 실행 불가능해지는 주된 원인은 환경(런타임 버전, 의존성) 차이, 누락된 설정(환경변수, 파일), 그리고 인터랙티브 요구(프롬프트)였습니다.
- 스니펫을 문서 안에만 두지 말고, 별도의 "excerpts" 또는 "snippets" 폴더에 실제 실행 가능한 파일 형태로 유지하면 관리가 편합니다.
- CI에서 스니펫을 자동 실행시키면 오래된 예제가 빨리 드러납니다. 처음에는 귀찮았지만, 오히려 글 품질과 신뢰도가 올라가는 걸 느꼈습니다.
- 컨테이너(예: Docker)를 이용하면 로컬 환경과 CI 환경 간의 차이를 줄일 수 있습니다. 하지만 컨테이너도 베이스 이미지 버전이 바뀌면 깨질 수 있으므로 이미지 버전 핀(pin)이 필요합니다.
- 간단한 스모크 테스트(실행 여부 + 기본 출력 확인)를 도입하는 것만으로도 많은 문제를 사전에 잡을 수 있습니다.

처음에는 헷갈렸던 부분

- 어디까지를 "스니펫"으로 관리할지: 블로그 내 모든 코드 블록을 자동 실행하려다 보니 테스트 비용이 늘었습니다. 그래서 "실행 가능한 예제"와 "설명용 코드"를 구분하는 기준을 정했습니다(예: 실행 가능 여부, 의존성 필요 여부).
- 스니펫 추출 방법: 마크다운에서 코드블록을 자동으로 추출하려면 정규식으로 처리할 수도 있지만, 언어별로 코드 블록 메타데이터(예: ```python linenos=1 run=true)를 사용하는 편이 더 안정적이라는 것을 알게 됐습니다.
- 결과 검증 수준: 단순히 종료 코드만 보는지, 출력 텍스트를 비교할지, 혹은 통합 테스트 수준으로 갈지 결정하는 데 시간이 걸렸습니다. 실무에서는 우선 "실행 + 간단한 출력 검증"으로 시작하는 게 현실적입니다.
- 권한/네트워크 의존성: 일부 예제는 외부 네트워크에 의존하거나 로컬 파일에 접근해야 해서 CI에서 실패했습니다. 이런 경우는 목(mock) 또는 더미 데이터를 사용하도록 예제를 바꾸는 게 더 좋았습니다.

구현 아이디어와 예시
아래는 제가 실험해본 간단한 패턴들입니다. 모든 예시는 초보자도 따라 할 수 있도록 최대한 단순화했습니다.

![코드 스니펫 폴더와 CI 파이프라인이 연결된 단순한 개념 다이어그램](/assets/img/posts/blog/tech-blog-snippet-automation/image-1.webp)
이미지 출처: AI 생성 이미지

1. 스니펫 파일 구조 제안

- repository/
  - snippets/
    - python/
      - hello.py
      - requirements.txt
    - node/
      - hello.js
      - package.json
  - .github/workflows/ci.yml
  - scripts/
    - run-snippets.sh

2. 스니펫 실행 스크립트 예 (scripts/run-snippets.sh)

- 이 스크립트는 snippets 폴더를 순회하면서 파일 확장자에 따라 실행합니다. 실제로는 더 정교한 검증과 타임아웃, 로그 저장을 추가하는 편이 좋습니다.

```
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNIPPETS_DIR="$ROOT/snippets"

# 간단한 타임아웃 함수 (timeout 명령이 없으면 설치 필요)
run_with_timeout() {
  local t="$1"; shift
  timeout "$t" "$@"
}

echo "Running snippets in $SNIPPETS_DIR"

# Python 예제 실행
if [ -d "$SNIPPETS_DIR/python" ]; then
  echo "== Python snippets =="
  pushd "$SNIPPETS_DIR/python" > /dev/null
  if [ -f requirements.txt ]; then
    pip install --upgrade -r requirements.txt
  fi
  for f in *.py; do
    [ -e "$f" ] || continue
    echo "--- $f ---"
    python "$f"
  done
  popd > /dev/null
fi

# Node 예제 실행
if [ -d "$SNIPPETS_DIR/node" ]; then
  echo "== Node snippets =="
  pushd "$SNIPPETS_DIR/node" > /dev/null
  npm ci --silent
  for f in *.js; do
    [ -e "$f" ] || continue
    echo "--- $f ---"
    node "$f"
  done
  popd > /dev/null
fi
```

3. GitHub Actions 예시: 마크다운과 실제 스니펫을 CI로 검사

- 아래 워크플로는 Linux에서 기본적인 스니펫 실행을 예로 듭니다. matrix로 언어를 확장할 수 있습니다.

```
name: Snippets CI

on:
  push:
    paths:
      - 'snippets/**'
      - '.github/workflows/**'
  pull_request:
    paths:
      - 'snippets/**'
      - '.github/workflows/**'

jobs:
  run-snippets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Install dependencies & run snippets
        run: |
          chmod +x scripts/run-snippets.sh
          ./scripts/run-snippets.sh
```

![컨테이너(도커) 기반으로 격리된 실행 환경을 보여주는 단순한 박스 일러스트](/assets/img/posts/blog/tech-blog-snippet-automation/image-2.webp)
이미지 출처: AI 생성 이미지

4. Docker를 이용한 일관된 환경

- 환경 차이로 인한 실패를 줄이려면 스니펫별로 Dockerfile을 만들거나 공용 베이스 이미지를 사용합니다. 예:

Dockerfile (snippets/python/Dockerfile)

```
FROM python:3.11-slim

WORKDIR /app
COPY . /app
RUN pip install --upgrade -r requirements.txt || true

CMD ["bash", "-c", "for f in *.py; do echo '---' $f; python $f || exit 2; done"]
```

빌드 & 실행:

```
docker build -t snippet-python:3.11 ./snippets/python
docker run --rm snippet-python:3.11
```

실무에서는 이렇게 확인하면 좋겠다

- 우선 단계별로 검증 범위를 정합니다.
  1. 스모크 테스트: 코드가 실행되어 종료 코드 0을 반환하는지 확인.
  2. 출력/행동 검증: 핵심 문자열이나 파일 생성 여부를 확인.
  3. 의존성 고정 확인: requirements.txt, package-lock.json 등 잠금 파일이 커밋되어 있는지 검사.
  4. 비상변수/비밀번호 분리: 스니펫에서 민감 정보를 하드코딩하지 않았는지 확인.
  5. 네트워크 의존성 격리: 외부 API 호출이 필요한 예제는 목(mock) 서버나 더미 데이터를 사용하도록 권장.
- CI 구성 팁
  - 워크플로는 변경된 스니펫만 검사하도록 구성하면 비용을 줄일 수 있습니다.
  - 시간 비용이 큰 통합 테스트는 주기적인 배치(예: 매주)로 옮기고, PR에서는 빠른 스모크만 수행하도록 분리합니다.
  - 캐시 히트율을 높이려면 의존성 설치 단계에서 캐시(actions/cache)를 사용합니다.
  - 실패 시 상세 로그를 남기고, 재현 가능한 로컬 명령을 README에 기록해 두면 좋습니다.
- 안정성 확보 팁
  - 베이스 이미지와 런타임 버전은 반드시 명시적으로 핀(pin)합니다(예: python:3.11.4-slim).
  - 타임아웃과 리소스 제한을 설정해 무한 루프나 과도한 메모리 사용을 방지합니다.
  - 셸 스크립트는 set -euo pipefail 등을 사용해 실패를 일찍 포착합니다.
  - 장기적으로는 "코드 스니펫 검증"을 코드 리뷰 체크리스트에 추가합니다.

검증 및 점검 절차(간단한 체크리스트 형태)

- 로컬 재현: ./scripts/run-snippets.sh 로직이 로컬에서도 동일하게 동작하는지 확인
- CI 로그: 실패 시 어떤 스니펫에서 실패했는지, 어떤 의존성이 문제인지 명확히 기록되어 있는지 확인
- 버전 핀: Dockerfile, action 설정, 언어 런타임 버전을 명시적으로 고정
- 보안: 스니펫에 하드코딩된 비밀번호/토큰이 없는지 grep으로 주기 검사
- 문서화: 각 스니펫이 의존하는 파일과 실행 방법을 스니펫 폴더의 README에 적기

예제: 간단한 출력 검증 추가 (bash)

- 스크립트에서 단순 문자열 검증을 추가해 "hello" 출력 여부를 확인하는 예시입니다.

```
python hello.py > out.txt
grep -q "Hello, world" out.txt || { echo "Expected output missing"; exit 1; }
```

주의할 점(조심스럽게)

- 모든 스니펫을 자동으로 실행하는 건 리소스와 유지보수 비용을 유발할 수 있습니다. 예제 수가 많다면 우선순위를 정하는 게 필요합니다.
- 외부 API 호출을 CI에서 직접 수행하면 요금, 가용성, 레ート리밋 문제가 생길 수 있으므로 목(mock) 또는 스텁을 권장합니다.
- 자동화가 완벽한 안전장치가 아니며, 때때로 CI 자체의 환경 변화(이미지 변경, runner 업데이트 등)로 인해 실패가 발생할 수 있습니다. 실패 원인을 정확히 기록하고 재현 절차를 문서화하는 게 중요합니다.

작게 시작하기 위한 권장 단계

1. 스니펫 폴더 구조를 만든다.
2. 실행 가능한 스니펫부터 하나씩 스크립트로 실행 가능하게 만든다.
3. GitHub Actions(또는 CI)에 간단한 워크플로를 추가해서 PR 단위로 실행되게 한다.
4. 실패 시 로컬에서 재현할 수 있는 명령을 README에 남긴다.
5. 점차 검증 수준을 높이고, 필요하면 Docker로 격리한다.

공부하면서 알게 된 점(요약)

- 자동화는 처음에는 귀찮지만 장기적으로 신뢰도를 높여 줍니다.
- 실행 가능한 스니펫을 별도 파일로 관리하면 유지보수가 쉬워집니다.
- 버전 핀, 타임아웃, 로그 남기기 등 기본 규칙만 지켜도 불필요한 붕괴를 줄일 수 있습니다.

처음에는 헷갈렸던 부분(요약)

- 어떤 스니펫을 자동으로 검사할지 우선순위 정하기
- 마크다운에서 코드블록을 추출하는 방식 선택
- 검증 수준(종단간 vs 출럭 비교) 결정

실무에서는 이렇게 확인하면 좋겠다(요약)

- PR에서 변경된 스니펫에 대해 빠른 스모크 테스트 수행
- 주기적으로 전체 스니펫 스위트 실행(예: 주간)
- 실패 원인/재현 절차 문서화
- 의존성 잠금과 베이스 이미지 핀 유지

실무 체크리스트

- [ ] 스니펫이 저장된 별도 폴더 구조가 존재하는가?
- [ ] 스니펫 실행 스크립트(또는 도구)가 있고 로컬에서 재현 가능한가?
- [ ] CI(예: GitHub Actions)에 스니펫 실행 워크플로가 적용되어 있는가?
- [ ] 의존성 잠금 파일(package-lock.json, requirements.txt 등)이 커밋되어 있는가?
- [ ] 베이스 이미지와 런타임 버전이 명시적으로 핀되어 있는가?
- [ ] 타임아웃과 리소스 제한이 설정되어 있는가(무한 루프 방지)?
- [ ] 외부 API 등 네트워크 의존성은 목(mock) 또는 더미 데이터를 사용하도록 처리했는가?
- [ ] 실패 시 원인과 재현 절차를 기록하는 규칙이 있는가?

마무리
제가 해 본 작은 자동화 패턴들이 모든 환경에 그대로 맞지는 않을 수 있습니다. 다만 블로그의 신뢰도를 오래 유지하려면 "코드가 실행 가능한 상태인지 정기적으로 확인"하는 절차를 도입하는 것이 도움이 된다고 느꼈습니다. 이 글이 비슷한 고민을 하는 분들에게 출발점이 되기를 바랍니다. 질문이나 사용중인 도구에 대한 경험 공유가 있다면 편하게 알려 주세요.
