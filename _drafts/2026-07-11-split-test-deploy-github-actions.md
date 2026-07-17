---
title: "GitHub Actions로 테스트와 배포 파이프라인을 분리하는 방법: 안전하고 실무적인 접근"
description: "오늘은 GitHub Actions를 사용하면서 제가 공부한 내용을 정리해보려고 합니다. 주제는 \"테스트와 배포 파이프라인을 분리하는 방법\"입니다"
slug: "split-test-deploy-github-actions"
date: 2026-07-11 10:00:00 +0900
categories: [DevOps, GitHub Actions]
tags: ["github-actions", "ci-cd", "테스트자동화", "배포자동화", "devops"]
---

오늘은 GitHub Actions를 사용하면서 제가 공부한 내용을 정리해보려고 합니다. 주제는 "테스트와 배포 파이프라인을 분리하는 방법"입니다. 개인 프로젝트와 소규모 팀에서 작업하면서 얻은 경험을 바탕으로, 초보자가 실무에서 바로 확인해볼 수 있는 포인트들 위주로 정리합니다. 처음에는 개념이 헷갈렸던 부분도 있었고, 실제로 적용하면서 알게 된 몇 가지 현실적인 제약(권한, 아티팩트 보존, 환경 보호 등)도 있었습니다. 그런 점들을 포함해 최대한 조심스럽게 정리해봅니다.

이미지를 하나 띄워서 전체 그림을 먼저 떠올리면 좋을 것 같아 넣습니다.

![GitHub 마크와 Actions 아이콘을 연상시키는 이미지로, GitHub Actions로 파이프라인을 분리하는 주제를 나타냄](https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png)
이미지 출처: https://github.githubassets.com/

목차(읽는 흐름)
- 왜 테스트와 배포를 분리하나?
- 분리하는 방법(워크플로우 설계 예시)
  - 테스트 워크플로우 예시 (PR/브랜치용)
  - 배포 워크플로우 예시 (태그/메인/후속 워크플로우 트리거)
  - 아티팩트와 캐시 처리
- 실무에서 확인할 포인트(권한, 시크릿, 환경 보호, 롤백)
- 공부하면서 알게 된 점 / 처음 헷갈렸던 부분
- 실무 체크리스트

왜 테스트와 배포를 분리하나?
- 책임 분리: 테스트(유닛/통합/정적 분석)는 PR 단계에서 빠르게 피드백을 주는 데 집중시키고, 배포는 빌드 산출물과 보안/인증을 확인한 뒤 진행하도록 분리하면 이해하기 쉽습니다.
- 안전성: 배포는 종종 권한, 환경 보호 설정, 수동 승인이 필요합니다. 배포를 별도 워크플로우로 처리하면 승인 규칙과 보호를 더 잘 적용할 수 있습니다.
- 재사용성: 테스트가 성공한 결과(아티팩트)를 여러 대상(스테이징/프로덕션)으로 재사용할 수 있습니다.
- 비용/속도 최적화: PR마다 무거운 배포 작업을 돌리지 않음으로써 빌드 시간을 아낄 수 있습니다.

분리 설계 핵심 요약
- 테스트 워크플로우: pull_request, push(branch) 트리거, 빠른 실패, 아티팩트/테스트 리포트 업로드
- 배포 워크플로우: push to tag 또는 workflow_run(on test success) 트리거, 환경(environment) 사용, 수동 승인 옵션
- 아티팩트는 upload/download로 전달하거나, 컨테이너 레지스트리에 이미지를 푸시해서 배포에서 당겨오게 함
- 권한/시크릿/환경 보호 규칙은 배포 워크플로우에 집중

테스트 워크플로우 예시
아래는 Node.js 기반 프로젝트에서 PR/branch에 대해 테스트하고 아티팩트를 올리는 예시입니다.

```yaml
# .github/workflows/test.yml
name: CI - Tests
on:
  pull_request:
  push:
    branches: [ "main", "develop" ]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "18"

      - name: Install
        run: npm ci

      - name: Run tests
        run: npm test -- --ci --reporter=json > test-results.json
        continue-on-error: false

      - name: Upload test report
        uses: actions/upload-artifact@v4
        with:
          name: test-report
          path: test-results.json
```

설명:
- PR에서 빠르게 실패를 알려주는 목적입니다.
- 테스트 결과를 아티팩트로 업로드하면, 나중에 수동 조사나 배포 시 참조할 수 있습니다.

배포 워크플로우 예시
배포는 여러 방식으로 트리거할 수 있습니다. 여기서는 두 가지를 예로 듭니다.
1) 태그 푸시(semantic-release 혹은 manual tag)로 배포
2) 테스트 워크플로우의 성공 후 자동으로 배포(workflow_run) — 단, 권한과 시크릿 동작을 확인해야 합니다.

방법 A: 태그 푸시로 배포

{% raw %}
```yaml
# .github/workflows/deploy-tag.yml
name: CD - Deploy on Tag
on:
  push:
    tags:
      - 'v*.*.*'   # SemVer 태그를 사용하는 경우

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://example.com
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Build Docker image
        run: |
          docker build -t ghcr.io/${{ github.repository_owner }}/myapp:${{ github.sha }} .
          echo "${{ secrets.CR_PAT }}" | docker login ghcr.io -u ${{ github.repository_owner }} --password-stdin
          docker push ghcr.io/${{ github.repository_owner }}/myapp:${{ github.sha }}

      - name: Deploy to k8s
        env:
          KUBECONFIG: ${{ secrets.KUBECONFIG }}
        run: |
          kubectl set image deployment/myapp myapp=ghcr.io/${{ github.repository_owner }}/myapp:${{ github.sha }}
          kubectl rollout status deployment/myapp -n my-namespace
```
{% endraw %}

방법 B: workflow_run 트리거로 배포 (테스트 성공 후)

{% raw %}
```yaml
# .github/workflows/deploy-after-tests.yml
name: CD - Deploy after CI
on:
  workflow_run:
    workflows: ["CI - Tests"]
    types:
      - completed

jobs:
  deploy:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Download artifact
        uses: actions/download-artifact@v4
        with:
          name: test-report
          path: ./artifacts

      - name: Deploy step (예시)
        run: echo "여기에 배포 스크립트를 넣습니다."
```
{% endraw %}

주의 및 권한 관련 팁
- workflow_run으로 배포를 트리거할 때, 배포 워크플로우에서 environment protection(예: required reviewers)와 시크릿 접근 동작이 어떻게 되는지 GitHub 문서로 꼭 확인하세요. (제가 적용할 때는 경우에 따라 수동 승인이 필요했고, 어떤 상황에서는 GITHUB_TOKEN 권한이 제한되는 느낌이 있어 문서 확인이 필요했습니다.)
- GITHUB_TOKEN의 권한은 레포지토리 설정과 워크플로우의 permissions 필드에 의해 달라집니다. 예:
  ```yaml
  permissions:
    contents: read
    id-token: write
  ```
- 프로덕션 배포 워크플로우는 가능한 한 수동 승인(environment reviewers)이나 보호 규칙을 적용하는 편이 안전합니다.

아티팩트와 캐시 처리
- 아티팩트를 사용하면 빌드 결과(예: 정적 파일, 빌드된 바이너리)를 테스트 워크플로우에서 업로드하고 배포 워크플로우에서 다운로드할 수 있습니다. 하지만:
  - 아티팩트의 보존 기간(retention)은 기본값(예: 90일) 또는 워크플로우에서 설정 가능하며, 오래된 아티팩트를 참조하면 안 됩니다.
  - 아티팩트 이름 충돌을 방지하려면 이름에 run-id나 commit-sha를 포함하세요.
- 대안: 빌드 결과를 컨테이너 레지스트리(또는 S3 같은 객체 스토리지)에 푸시하면 배포 시 더 안정적으로 당겨오는 방식도 가능합니다.

운영(운영 환경 확인) 관련 명령/점검 예시
실무에서는 워크플로우가 성공했다고 해서 서비스가 정상 동작하는지까지 확인해야 합니다. 몇 가지 확인 명령을 적어봅니다.

- GitHub Actions 관련 확인
  - 최근 실행 리스트 보기: gh run list --repo owner/repo
  - 특정 실행 상세/로그 보기: gh run view <run-id> --repo owner/repo
  - 아티팩트 다운로드(로컬): gh run download <run-id> --repo owner/repo

- Docker 레지스트리/이미지 확인
  - 로컬 이미지 확인: docker images | grep myapp
  - 레지스트리에 푸시 확인: (레지스트리 UI 혹은 ghcr API 확인)

- Kubernetes 배포 확인
  - 롤아웃 상태: kubectl rollout status deployment/myapp -n my-namespace
  - 파드 상태: kubectl get pods -n my-namespace
  - 로그 보기: kubectl logs deployment/myapp -n my-namespace --tail=200

실제로 이런 명령들을 체크리스트처럼 두고 점검하면 문제를 빠르게 찾을 수 있습니다.

중간에 설명을 보완하는 이미지를 하나 더 넣습니다.

![파이프라인과 빌드, 배포 과정을 설명하는 다이어그램 형식의 이미지로, 테스트와 배포를 분리해 구성하는 개념을 보여줌](https://images.unsplash.com/photo-1555949963-aa79dcee981d?auto=format&fit=crop&w=1350&q=80)
이미지 출처: https://unsplash.com/photos/jpqyfK7GB4w

공부하면서 알게 된 점
- workflow_run은 유용하지만 권한/시크릿 주변 동작(특히 환경 보호와 연동되는 방식)을 꼭 문서로 확인해야 한다는 것: 자동화된 흐름이 항상 곧바로 프로덕션 권한을 얻는 건 아닙니다.
- 아티팩트 전달은 편하지만, 대용량 바이너리를 많이 전달하면 비용과 보존 문제(보관 기간)가 생깁니다. 컨테이너 레지스트리를 이용하는 방법이 더 현실적일 때가 많았습니다.
- 테스트와 배포를 깔끔히 분리하면, PR 단계에서는 속도에 더 집중하고 배포 단계에서는 안정성/승인/롤백에 더 집중할 수 있다는 점이 장점으로 느껴졌습니다.

처음에는 헷갈렸던 부분
- workflow_run과 needs의 차이: 같은 workflow 파일 내에서 job 간에 needs로 의존성을 걸면 동시성/캐싱 면에서 더 직접적입니다. 반면 workflow_run은 "완성된 다른 워크플로우"를 관찰해서 트리거하므로 레포지토리 수준에서 분리된 흐름을 만들기 좋지만, 권한 이슈가 번거로울 수 있습니다.
- 환경(environment)와 시크릿의 적용 범위: 예컨대 환경 보호(승인자 설정)는 배포 워크플로우에서만 작동하게 하고 싶을 때, 어디에 설정해야 하는지 바로 이해하기 힘들었습니다. (환경 설정 UI와 워크플로우 파일의 environment: name: production가 연결됩니다.)

실무에서는 이렇게 확인하면 좋겠다
- 병렬로 실행되는 워크플로우가 저장소 자원(특히 도커 레지스트리 태그, 데이터베이스 마이그레이션 등)을 건드리지 않도록 리소스 접근을 설계하세요.
- 배포 전후로 헬스체크를 자동화하세요(예: 배포 후 특정 엔드포인트에 대해 curl로 상태 확인).
- 배포가 실패할 경우를 대비해 롤백 절차(이미지 태그 롤백, 이전 배포 재적용)를 문서로 남겨두세요.
- 권한 문제는 먼저 작은 테스트 레포에서 workflow_run -> deploy 시나리오를 테스트해보고, 실제 레포에서 사용할 권한/승인 규칙을 정하세요.

추가 팁: reusable workflows 활용
- 공통 배포 로직을 .github/workflows/deploy.yml 같은 재사용 가능한 워크플로우로 만들면 여러 레포에서 같은 정책을 적용하기 편합니다.
- 재사용 워크플로우를 호출할 때 인자(inputs)로 환경 이름, 이미지 태그를 넘기면 유연합니다.

작은 실무 예시: 배포 후 헬스체크 추가

```yaml
- name: Health check
  run: |
    for i in {1..10}; do
      if curl -fsS https://example.com/health; then
        echo "OK"
        exit 0
      fi
      sleep 6
    done
    echo "Health check failed"
    exit 1
```

마무리(요약)
- 테스트와 배포를 분리하면 속도와 안정성을 각각 최적화할 수 있습니다.
- workflow_run과 태그 기반 배포는 각각 장단점이 있으니 레포와 팀 요구에 따라 선택하세요.
- 권한, 시크릿, 환경 보호 규칙은 사전에 꼭 문서로 확인하고 테스트 레포에서 시도해보는 것이 안전합니다.

실무 체크리스트
- [ ] 테스트 워크플로우: PR/브랜치에서 빠르게 실패를 알리도록 구성했는가?
- [ ] 아티팩트/이미지 전달 방식: 아티팩트 vs 컨테이너 레지스트리 중 어느 쪽을 사용할지 결정했는가?
- [ ] 배포 트리거: 태그 기반 / workflow_run / 수동 중 어떤 방식을 쓸지 문서화했는가?
- [ ] 환경 보호: production environment에 required reviewers나 protection rules를 설정했는가?
- [ ] 권한 검토: GITHUB_TOKEN 권한과 필요한 시크릿(예: DOCKER_PASSWORD, KUBECONFIG)을 안전하게 저장했는가?
- [ ] 롤백 계획: 실패 시 이전 버전으로 롤백하는 절차와 커맨드를 문서화했는가?
- [ ] 헬스체크 자동화: 배포 후 서비스 상태를 자동으로 확인하는 스크립트를 추가했는가?
- [ ] 모니터링 연결: 배포 후 오류(500, 실패 지표)를 모니터링하고 경고를 받을 수 있는지 확인했는가?

참고(제가 직접 확인한 흐름)
- 작은 프로젝트에서는 태그 푸시로 배포하는 방식이 간단하고 안전하게 느껴졌습니다.
- 조직 환경에서는 environment protection과 수동 승인을 추가해야 하는 경우가 많았습니다. workflow_run을 쓰면 자동화가 좋아보이지만, 권한/시크릿 동작에 대해 반드시 사전 테스트가 필요했습니다.

이 글은 제가 실습하면서 정리한 내용입니다. 혹시 실제 환경에서 적용하면서 제가 놓친 부분이나 더 좋은 패턴을 발견하면 다음 글에 업데이트해보겠습니다. 질문이나 실무에서 겪은 사례가 있다면 공유해주시면 같이 정리해보고 싶습니다.
