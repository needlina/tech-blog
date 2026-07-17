---
title: "Renovate로 의존성 업데이트 PR을 자동화할 때 설정할 기준"
slug: "renovate-dependency-update-rules"
date: 2026-07-17 09:00:00 +0900
categories: ["DevOps", "GitHub Actions"]
tags: ["renovate", "dependency-updates", "automation", "devops", "github-actions"]
image:
  path: /assets/img/posts/blog/renovate-dependency-update-rules/preview.png
  alt: "Renovate PR 자동화 썸네일"
---

오늘의 주제

Renovate로 의존성 업데이트 PR을 자동화할 때 설정할 기준

저는 최근에 프로젝트의 의존성 관리를 Renovate로 자동화하는 작업을 공부하면서 설정에서 어떤 기준을 두면 좋을지 정리해봤습니다. 이 글은 초보 개발자의 시각에서 공부한 내용을 차근차근 정리한 초안입니다. 완전한 정답은 아닐 수 있으니, 실무 환경에 맞게 검증하시길 권합니다.

공부하면서 알게 된 점
- Renovate는 "업데이트를 자동으로 열어주는 도구" 이상의 유연함이 있어서 세부 정책(스케줄, 그룹핑, 자동머지, 예외 처리 등)을 잘 설계하면 팀에 맞게 운영할 수 있었습니다.
- 패키지 매니저별로 동작과 위험도가 다르고, 동일한 룰이 모든 언어/환경에 잘 맞지 않는다는 것을 알게 되었습니다.
- 자동 PR을 받는 것만으로 끝내지 않고 CI, 보안 스캔, 테스트 파이프라인까지 연결해야 실무에서 안전하게 운영할 수 있다는 점을 체감했습니다.

처음에는 헷갈렸던 부분
- "automerge"를 언제 쓰는 게 좋은지 헷갈렸습니다. 패치/마이너 업데이트는 비교적 안전하다고 하지만, 모든 프로젝트가 같지는 않으므로 자동머지를 무조건 켜면 안 된다는 점을 배웠습니다.
- Renovate의 grouping(패키지 그룹)과 rangeStrategy(버전 범위 전략)이 비슷해 보여 혼동이 있었습니다. 실제로는 목적이 달라서 테스트나 릴리스 정책에 맞게 조합해야 했습니다.

왜 기준이 필요한가?
- 매일 수십 개의 PR이 생성되면 리뷰 비용이 급증합니다.
- 안전하지 않은 업데이트로 인해 빌드/배포 장애가 발생할 수 있습니다.
- 보안 취약점은 신속히 패치해야 하지만, 기능 업데이트는 신중히 검토해야 합니다.

중요하게 고려한 설정 항목들
- schedule: 언제 PR을 생성할지 (업무 시간대, 릴리스 주기 맞춤)
- prConcurrentLimit: 한 번에 열리는 PR 수 제한
- packageRules: 마이너/패치/메이저에 따른 동작(자동머지, 그룹핑 등)
- automerge: 조건부 자동머지 (CI 통과 + 보안 스캔 통과 등)
- semanticCommitType / commitMessageAction: 변경을 알기 쉽게
- ignorePaths / ignoreDeps: 특정 폴더나 라이브러리 제외
- docker, npm, maven 등 패키지 매니저별 설정

간단한 Renovate 설정 예시(.github/renovate.json)
```json
{
  "extends": ["config:base"],
  "timezone": "Asia/Seoul",
  "schedule": ["after 9pm and before 5am on every weekday"],
  "prConcurrentLimit": 5,
  "rangeStrategy": "bump",
  "packageRules": [
    {
      "matchUpdateTypes": ["patch", "minor"],
      "automerge": true,
      "automergeType": "pr",
      "matchManagers": ["npm", "yarn"]
    },
    {
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "labels": ["major-update"],
      "reviewers": ["team-lead"]
    },
    {
      "matchPackageNames": ["react", "react-dom"],
      "groupName": "react-major-and-minor",
      "schedule": ["on monday"]
    }
  ],
  "postUpdateOptions": ["npmDedupe"]
}
```

실무에서는 이렇게 확인하면 좋겠다 (점검 절차)
1. CI 파이프라인에서 Renovate PR을 대상으로 테스트 실행
   - GitHub Actions 예시: PR이 열릴 때 자동으로 테스트를 돌리도록 워크플로우를 설정
   - 특정 오너(renovate[bot])로부터 온 PR만 실행하거나, 모든 PR에 적용

GitHub Actions 예시: PR에서 테스트 실행
```yaml
name: CI for PRs
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  test:
    runs-on: ubuntu-latest
    if: github.actor == 'renovate[bot]' || startsWith(github.head_ref, 'renovate/')
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      - name: Install
        run: npm ci
      - name: Run unit tests
        run: npm test -- --ci
```

2. 보안 스캔 연동
   - Renovate PR이 열리면 Snyk, Dependabot Security, GitHub Code Scanning 등으로 취약점 검사를 수행
   - 보안 스캔에서 실패하면 자동머지를 차단

3. 릴리스/배포 영향 점검
   - 변경된 패키지의 주요 변경 로그(CHANGELOG) 확인
   - Docker 이미지가 있으면 빌드/스모크 테스트 수행
   - Docker 예시: 자동 PR에 대해 이미지 빌드 후 간단한 컨테이너 실행 테스트
```sh
# Docker 빌드 예시 (CI 내부)
docker build -t myapp:pr-${{ github.event.number }} .
docker run --rm myapp:pr-${{ github.event.number }} /bin/sh -c "sleep 1 && [ -x /app/start.sh ]"
```

이미지: Renovate 업데이트 흐름 다이어그램
![Renovate 업데이트 흐름 다이어그램](/assets/img/posts/blog/renovate-dependency-update-rules/image-1.webp)
이미지 출처: AI 생성 이미지

4. 로컬에서의 사전 검증 명령어
- Node: npm outdated / npm ci / npm audit
- Python: pip list --outdated && pip install --upgrade <pkg> --dry-run (pip 자체에 완전한 dry-run은 없으니 가상환경 권장)
- Java(Maven): mvn versions:display-dependency-updates
- Go: go list -u -m all

예:
```sh
# npm
npm ci
npm outdated

# pip (가상환경 권장)
python -m venv .venv
source .venv/bin/activate
pip list --outdated

# maven
mvn versions:display-dependency-updates
```

처음에는 헷갈렸던 automerge와 안전성
- 제가 처음 실험했을 때는 패치 업데이트에 자동머지를 켜두고 있었는데, 의외의 빌드 변화나 동작 변동이 발생해 자동머지를 다시 제한하게 됐습니다.
- 그래서 실무에서는 "CI 통과 + 보안스캔 통과"를 반드시 조건으로 두는 편이 안전하다고 느꼈습니다.

Renovate를 로컬/도커로 dry-run 해보기
- Renovate는 docker 이미지로 실행해서 로컬에서 설정을 확인할 수 있습니다. (실제 토큰 사용에는 주의)
```sh
docker run --rm \
  -e RENOVATE_TOKEN=xxxxx \
  -v "$(pwd)/renovate.json:/usr/src/app/config.js" \
  renovate/renovate:latest --dry-run
```
- 위 명령은 설정을 시뮬레이션해주지만, 실제로는 GitHub 앱과 연동한 상태와 다를 수 있으니 프로덕션 전에 소수 저장소에서 테스트해보는 것이 좋습니다.

이미지: CI와 자동머지 체크 흐름을 설명하는 일러스트
![CI와 자동머지 체크 흐름을 설명하는 일러스트](/assets/img/posts/blog/renovate-dependency-update-rules/image-2.webp)
이미지 출처: AI 생성 이미지

운영 팁(제가 실무에서 적용하려고 하는 기준)
- PR 생성 스케줄: 업무 시간 외(예: 밤 9시 이후)로 해서 당일 업무 방해 최소화
- PR 동시 개수 제한: 3~5개로 시작해서 팀 리뷰 역량에 맞게 조정
- 패치/마이너: 가능한 자동머지 허용하되 "CI 통과 + 보안 통과" 필요
- 메이저: 수동리뷰, 레이블/owner 지정
- 중요 라이브러리(예: 인증/보안 관련)는 항상 수동리뷰
- 그룹핑: 관련 패키지(예: react, react-dom)를 묶어 PR 수 줄이기
- 로그/변경내역(CHANGELOG) 확인을 자동화할 수 있으면 PR 템플릿에 링크 포함

실무에서 확인 포인트(정리)
- CI가 해당 PR에서 정확히 같은 테스트를 돌리는지(환경 변수, 시크릿 포함)
- 보안 스캔 툴의 결과와 심각도 기준(예: critical만 즉시 패치)
- PR 템플릿에 자동으로 추가되는 변경 로그 링크가 유용한지
- 롤백/긴급 수정 절차(예: 빠른 revert, 핫픽스 브랜치 전략)
- 팀의 리뷰 정책과 자동화의 균형(자동화가 일을 더 늘리지 않게)

마무리로는…
Renovate 설정은 한 번에 완성되는 게 아니라 팀의 피드백을 보며 조정하는 것이 훨씬 중요하다고 느꼈습니다. 저는 실무에 바로 도입하기 전에 소규모 저장소에서 몇 주간 테스트해보고, CI 로그와 PR 생성 로그를 확인하면서 규칙을 다듬는 것을 권합니다. 이 글도 제 개인 학습 정리라 틀린 점이 있을 수 있고, 더 좋은 방법이 있다면 같이 고민하고 싶습니다.

실무 체크리스트
- [ ] Renovate 앱 설치 및 권한 범위 확인(GitHub/GitLab 등)
- [ ] 기본 config(extends: config:base) 적용 후 dry-run으로 결과 확인
- [ ] schedule 및 prConcurrentLimit 설정으로 PR 폭주 방지
- [ ] packageRules로 패치/마이너/메이저 전략 분리
- [ ] 자동머지 조건: CI 통과 + 보안 스캔 통과로 제한
- [ ] GitHub Actions/CI에서 renovate PR에 대해 테스트 및 보안 스캔 실행
- [ ] 중요한 라이브러리 리스트(예: 인증, 암호화, DB 드라이버) 수동 리뷰로 제외 처리
- [ ] PR 템플릿에 CHANGELOG/릴리스 노트 확인 링크 추가
- [ ] Docker 이미지 빌드/스모크 테스트 자동화
- [ ] 운영팀/개발팀과 롤백 절차 및 책임자 합의

참고로 이 글은 제 개인 학습 기록을 바탕으로 한 초안입니다. 프로젝트 환경(언어, CI, 배포 방식)에 따라 달라질 수 있으니 본문 예시는 그대로 복사해서 쓰기보다 필요한 부분을 골라 검증하시길 권합니다.