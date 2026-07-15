---
title: "소프트웨어 공급망 보안: SBOM과 SLSA 도입 가이드 및 CI 연동 실무 점검"
slug: "sbom-slsa-ci-integration-checklist"
date: 2026-07-15 10:00:00 +0900
categories: ["Security", "DevOps"]
tags: ["sbom", "slsa", "software-supply-chain", "ci-cd", "news", "trend"]
image:
  path: /assets/img/posts/blog/sbom-slsa-ci-integration-checklist/preview.png
  alt: "SBOM·SLSA 실무 점검 썸네일"
---

오늘의 주제는 소프트웨어 공급망 보안에서 요즘 자주 보이는 SBOM(Software Bill of Materials)과 SLSA(Supply-chain Levels for Software Artifacts)를 실제 CI(Continuous Integration) 파이프라인에 연동해서 어떻게 검증하고 운영 관점에서 어떤 점을 점검하면 좋을지에 대한 개인적인 정리입니다. 저는 현재 초보 개발자 입장에서 천천히 공부하면서 실제로 해본 실습과 문서들을 정리한 내용이라, 모든 사례가 정답이라고 주장하려는 건 아닙니다. 다만 실무에서 바로 확인해볼 수 있는 포인트, 명령어 예시, 간단한 CI 예제를 위주로 정리했습니다.

목차(간단)
- SBOM과 SLSA의 개념(간단히)
- 공부하면서 알게 된 점
- 처음에는 헷갈렸던 부분
- 실무에서는 이렇게 확인하면 좋겠다(명령어·설정·CI 예시)
- 운영 시 점검 포인트와 주의사항
- 실무 체크리스트

SBOM과 SLSA, 아주 간단히
- SBOM: 소프트웨어가 어떤 구성 요소(라이브러리, 패키지, 버전 등)로 구성되는지의 목록입니다. 취약점 분석, 라이선스 확인, 컴플라이언스에 유용합니다.
- SLSA: 빌드와 공급망의 무결성을 인증하기 위한 프레임워크(레벨)로, 빌드 과정의 증명(provenance)과 무결성 확보를 권장합니다. 단순 규칙이라기보다는 여러 조직에서 활용할 수 있는 권장 사항 모음이라고 이해하고 있습니다.

공부하면서 알게 된 점
- SBOM은 단순한 목록 이상의 가치를 가질 수 있다: 취약점 스캐너와 결합하면 빠르게 파악 가능
  - 예: SBOM을 통해 어떤 라이브러리 버전이 포함됐는지 바로 파악하면, CVE 매칭을 자동화하기가 수월했습니다.
- SLSA는 '증명'의 형태가 중요: 빌드에서 생성된 provenance(누가, 언제, 어떤 입력으로 빌드했나)가 핵심입니다.
  - 빌드 증명을 기록하고, 이 증명을 서명(attestation)하면 나중에 검증이 가능해집니다.
- 도구 생태계가 다양: Syft(Anchore), Syft-action, CycloneDX, SPDX, Cosign(=sigstore 관련), in-toto 등 여러 툴을 조합해 쓰게 됩니다.
- CI에 SBOM·SLSA를 추가하면 배포 루틴이 조금 길어지고 아티팩트 관리가 필요합니다. 하지만 한번 흐름을 잡아두면 자동화로 안정성이 올라갑니다.

처음에는 헷갈렸던 부분
- SBOM 형식 혼란: SPDX, CycloneDX, 기타 JSON 형식이 있는데 각 형식의 필드명이 달라서 비교하기 어려웠습니다.
  - 실무에서는 한 가지 형식을 표준으로 정하고(또는 변환 파이프라인을 마련) 통일하는 편이 편리했습니다.
- SLSA 레벨과 실제 구현: SLSA가 권장하는 것들은 많지만, '어떤 레벨을 목표로 해야 하나'는 조직마다 다릅니다.
  - 작은 팀은 우선 빌드 재현성과 서명(attestation)부터 도입해보는 식으로 단계적으로 진행하는 것이 현실적입니다.
- 서명 키 관리: cosign 같은 도구로 서명하려면 키 관리를 어떻게 할지(키 생성, 보관, 회전)가 어려웠습니다.
  - 실무에서는 KMS(예: AWS KMS, GCP KMS, HashiCorp Vault) 연동 또는 GitHub OIDC(Workload Identity) 사용을 추천하는 글을 많이 봤지만, 내부 사정에 맞게 선택해야 합니다.

실무에서는 이렇게 확인하면 좋겠다 — 명령어·설정·점검 절차 예시
아래 예시는 제가 직접 해본 간단한 흐름을 바탕으로 한 예시입니다. 환경에 따라 경로나 옵션이 다를 수 있으니, 그대로 복붙하기 전에 문서 확인을 권합니다.

1) 로컬/CI에서 SBOM 생성 (Syft 예시)
- Syft 설치(간단히 curl로 설치하는 방식):
  - Linux 예시:
    sudo apt-get update && sudo apt-get install -y curl
    curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin

- Docker 이미지에서 SBOM 생성:
  - 이미지가 로컬에 있는 경우:
    syft my-image:latest -o cyclonedx-json > sbom.json
  - 디렉터리(소스)에서 생성:
    syft dir:. -o cyclonedx-json > sbom.json

- SBOM 내용 간단 확인 (jq 이용):
    jq '.components | length' sbom.json   # 컴포넌트 수 확인
    jq '.components[] | {name, version, type}' sbom.json | head

2) SBOM을 attestation(증명)으로 만들고 서명하기 (cosign 간단 예시)
- cosign 설치(간단한 설치 예):
    curl -sSL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 -o /usr/local/bin/cosign
    chmod +x /usr/local/bin/cosign

- 키 생성(로컬 테스트용):
    cosign generate-key-pair
  이로써 cosign.key (private)와 cosign.pub (public)이 생성됩니다. 실무에서는 KMS 연동을 권장합니다.

- SBOM을 predicate(증명서)로 사용해 attestation 생성:
    cosign attest --key cosign.key --predicate sbom.json ghcr.io/myorg/myrepo@sha256:<digest>
  (이미지 레퍼런스를 실제 아티팩트 식별자로 바꿔야 합니다.)

- attestation 검증:
    cosign verify-attestation --key cosign.pub ghcr.io/myorg/myrepo@sha256:<digest>

(주의) 실제 옵션이나 동작은 cosign 버전과 사용 방식에 따라 다를 수 있습니다. 위는 흐름 이해용 예시입니다.

3) GitHub Actions CI 예시(간단한 흐름)
- 목표: 소스 빌드 → 이미지 푸시 → SBOM 생성 → SBOM attestation 생성(서명) → 아티팩트로 보관

간단한 단계(요약, YAML 스니펫은 간략화):
- checkout
- build image (docker build)
- push image (registry)
- syft로 sbom 생성 (또는 anchore/syft-action 사용)
- cosign으로 attestation 생성(키는 KMS 또는 GitHub Secrets 활용)
- upload-artifact로 sbom + attestation 저장

예(의사 코드 형태):
name: build-and-sbom
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build image
        run: |
          docker build -t ghcr.io/${{ github.repository }}:${{ github.sha }} .
          docker push ghcr.io/${{ github.repository }}:${{ github.sha }}
      - name: Generate SBOM (syft)
        run: |
          curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin
          syft ghcr.io/${{ github.repository }}:${{ github.sha }} -o cyclonedx-json > sbom.json
      - name: Sign attestation (cosign)
        run: |
          curl -sSL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 -o /usr/local/bin/cosign
          chmod +x /usr/local/bin/cosign
          cosign attest --key ${{ secrets.COSIGN_KEY }} --predicate sbom.json ghcr.io/${{ github.repository }}:${{ github.sha }}
      - uses: actions/upload-artifact@v4
        with:
          name: sbom-and-attestation
          path: |
            sbom.json
            *.att.json

(설정 팁)
- 키 관리는 GitHub secrets에 직접 키를 넣기보다 OIDC 기반 워크로드 아이덴티티로 접근해 KMS에서 서명하도록 구성하면 노출 리스크를 줄일 수 있습니다.
- 이미지 식별자는 태그보다 digest(sha256:...)를 사용하는 편이 무결성 측면에서 안전합니다.

4) 로컬 및 운영에서의 빠른 점검 명령들
- 이미지에 SBOM이 붙어 있는지(이미지 레지스트리 연결 여부):
    # SBOM 파일이 레지스트리의 OCI artifact로 업로드된 경우, registry API로 확인
    curl -s https://ghcr.io/v2/myorg/myrepo/manifests/<digest> | jq '.'

- SBOM 내용과 취약점 매칭(예: trivy, grype 등 사용)
    grype sbom:sbom.json   # grype는 sbom 입력을 받아 취약점 스캔 가능

- attestations(증명) 확인:
    cosign verify-attestation --key cosign.pub ghcr.io/myorg/myrepo@sha256:<digest>

운영 관점에서 체크해야 할 포인트(제가 실무에서 신경 썼던 것들)
- 어떤 형식의 SBOM을 표준으로 할지(Spdx vs CycloneDX)과 변환 파이프라인 유무
- 빌드 증명(provenance)을 어디에 저장할지(레지스트리의 attestation, artifact repo, 내부 저장소)
- 키 관리: 서명 키의 생성, 보관, 회전 정책
- CI 실패 규칙: SBOM 생성/서명 실패 시 파이프라인을 중단할지 여부
- 실시간 알림: SBOM 기반 취약점이 새로 밝혀졌을 때 알림 흐름
- 아티팩트 연결: 배포 시 해당 이미지의 SBOM과 attestation을 쉽게 조회할 방법(메타데이터 연동)

주의 및 한계(겸손하게)
- 도구와 옵션은 자주 업데이트됩니다. 위 명령이나 액션 이름은 시간이 지나면 바뀔 수 있으니 도구 공식 문서를 참고하는 것이 안전합니다.
- 모든 조직이 처음부터 최상위 SLSA 레벨을 목표로 삼을 필요는 없다고 생각합니다. 현실적인 범위에서 단계적으로 도입하는 것이 비용 대비 효과가 좋았습니다.

실무에서는 이렇게 확인하면 좋겠다 — 점검 절차 예시(간단한 워크플로우)
1. CI에서 이미지가 만들어지고 레지스트리에 푸시되는지 확인
2. 같은 CI에서 SBOM이 자동 생성되고 저장(또는 아티팩트로 업로드)되는지 확인
3. SBOM이 attestation으로 서명되어 레지스트리 또는 아티팩트 저장소에 함께 보관되는지 확인
4. 빌드 후론 해당 이미지의 digest를 이용해 cosign verify-attestation으로 증명 검증
5. 주기적으로 SBOM을 가지고 취약점 스캐너로 재검사(새 CVE 등장 대비)
6. 키 회전 테스트를 CI에서 주기적으로 수행해 키 교체 절차가 동작하는지 점검

관련 이미지 주제
1. SBOM(구성요소 목록)을 상자 안의 작은 블록들이 나열된 형태로 보여주는 단순 일러스트
2. CI 파이프라인에서 SBOM 생성과 서명(attestation)을 표시하는 흐름도 형태의 단순 아이콘 일러스트

실무 체크리스트
- [ ] SBOM 형식(SPDX/CycloneDX)을 팀 표준으로 정했는가?
- [ ] CI 파이프라인에서 SBOM 자동 생성이 구현되어 있는가? (syft 등)
- [ ] 빌드 아티팩트에 대해 attestation/증명이 생성되고 서명되는가? (cosign 등)
- [ ] 서명 키 관리 정책(생성/보관/회전)이 문서화되어 시행 중인가?
- [ ] 이미지 식별에 digest(sha256) 사용을 보장하고 있는가?
- [ ] SBOM을 기반으로 한 취약점 재스캔 자동화가 있는가? (grype, trivy 등)
- [ ] 증명 검증(cosign verify 등)을 배포 전/감사 시점에서 할 수 있는 절차가 있는가?
- [ ] 레지스트리나 아티팩트 저장소에서 SBOM·attestation을 쉽게 조회 가능한가?
- [ ] 도구 버전·설정 변경에 대한 테스트(예: cosign, syft 업데이트) 절차를 마련했는가?

마무리 (조심스러운 권고)
제가 해본 바로는 SBOM과 SLSA 관련 흐름은 한 번 도입하면 분석과 감사, 사고 대응에서 확실히 도움이 되는 점이 있었습니다. 다만 도입 초기에는 형식, 키 관리, CI 정책 등 결정을 내려야 할 항목이 많아서 작게 시작해 점진적으로 범위를 넓히는 전략이 현실적이라고 느꼈습니다. 이 글이 같은 입장의 분들이 실무 체크포인트를 빠르게 잡는 데 도움이 되길 바랍니다. 틀린 부분이 있을 수 있으니, 도구 공식 문서와 최신 가이드도 함께 참고하세요.