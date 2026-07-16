---
title: "Sigstore 기반 CI 코드·이미지 서명 파이프라인 도입 체크리스트"
slug: "sigstore-cosign-code-signing-pipeline"
date: 2026-07-16 10:00:00 +0900
categories: ["DevOps", "Security"]
tags: ["sigstore", "cosign", "ci-cd", "supply-chain-security", "news", "trend"]
image:
  path: /assets/img/posts/blog/sigstore-cosign-code-signing-pipeline/preview.png
  alt: "CI/CD 서명 자동화 썸네일"
---

오늘의 주제
: Sigstore(cosign/rekor/fulcio) 기반 CI 코드·이미지 서명 파이프라인 도입 체크리스트를 정리합니다. 개인적으로 공부하면서 정리한 초안이라 틀릴 가능성이 있고, 실무 환경에 맞게 조정하면 좋겠습니다.

들어가며
: 소프트웨어 공급망 보안이 점점 중요해지면서 빌드 산출물(바이너리, 컨테이너 이미지 등)에 서명해 진위와 무결성을 검증하려는 요구가 늘고 있습니다. Sigstore는 이 흐름에서 주목받는 오픈소스 프로젝트로, cosign(서명/검증), fulcio(인증서 발급), rekor(투명성 로그)를 축으로 합니다. 저는 최근 CI 파이프라인에 cosign을 적용해보면서 실무에서 체크하면 유용한 포인트들을 모았습니다. 아래는 공부하면서 알게 된 점, 처음 헷갈렸던 부분, 그리고 실무에서 확인하면 좋을 것들을 중심으로 정리한 초안입니다.

공부하면서 알게 된 점
- Sigstore 구성요소 간 역할 구분이 비교적 명확하다.
  - cosign: 실제로 서명(sign)하고 검증(verify)하는 도구입니다. 컨테이너 이미지나 임의의 바이너리(블롭)도 서명할 수 있습니다.
  - fulcio: 서명할 때 키를 직접 관리하지 않는 "keyless" 흐름에서 인증서를 발급해 주는 CA 역할을 합니다. OIDC 토큰을 바탕으로 인증서를 발급합니다.
  - rekor: 서명 이벤트를 불변(immutable) 로그로 보관하는 투명성(log) 서비스입니다. 나중에 감사(audit)나 위조 방지를 위해 유용합니다.
- keyless(오픈ID 기반) 서명은 운영상 편리하지만, OIDC 공급자 설정과 토큰 유효성 검증을 꼼꼼히 해야 한다는 점을 알게 되었습니다.
- OCI 레지스트리 지원이 넓어서 Docker Hub, GCR, ECR 등 대부분 레지스트리를 대상으로 이미지 서명/검증이 가능했습니다. cosign은 서명 정보를 이미지의 "referrer" 또는 별도 artifact로 저장할 수 있습니다.
- 실무에서는 "서명만 한다"로 끝나지 않고, 배포 시점에 검증(예: k8s Admission, 배포 스크립트, CI 검증 단계 등)까지 자동화해야 의미가 있다는 점을 느꼈습니다.

처음에는 헷갈렸던 부분
- keyless vs key-based
  - 처음에는 keyless와 전통적 키쌍(개인키/공개키)을 혼동했습니다. keyless는 개발자가 개인키를 직접 관리하지 않고 OIDC 토큰으로 임시 인증서를 발급받아 서명하는 방식입니다. 반면에 키 기반은 cosign으로 키 쌍을 생성하고 개인키를 안전하게 보관한 뒤 CI에서 그 키로 서명합니다.
- Rekor 로그 확인 흐름
  - cosign으로 서명하면 자동으로 rekor에 엔트리가 생성되는 것이 보통이지만, 이 엔트리가 실제로 존재하는지 확인하는 절차가 필요합니다. rekor 서버의 가용성이나 프라이빗 rekor를 사용하는 경우 접근 권한이 달라진다는 점도 헷갈렸습니다.
- 서명과 이미지 digest 관계
  - 이미지 태그는 mutable하기 때문에 서명은 가능하면 이미지의 digest(예: sha256:...) 단위로 하는 것이 안전합니다. 태그로만 서명하면 태그가 바뀌었을 때 진위를 잃을 수 있습니다.

기본 명령어와 예제
- 키 기반 서명 (로컬 키 생성 후 서명)
  - 키 생성
    ```
    cosign generate-key-pair
    # 생성 결과: cosign.key (private), cosign.pub (public)
    ```
  - 이미지 서명
    ```
    cosign sign --key cosign.key ghcr.io/myorg/myimage:1.0.0
    ```
  - 이미지 검증
    ```
    cosign verify --key cosign.pub ghcr.io/myorg/myimage@sha256:<digest>
    ```
- Keyless 서명 (OIDC를 사용하는 경우)
  - 서명
    ```
    # CI에서 OIDC 토큰을 이용해 실행되면
    cosign sign --keyless ghcr.io/myorg/myimage:1.0.0
    ```
  - 검증
    ```
    cosign verify --keyless ghcr.io/myorg/myimage@sha256:<digest>
    ```
- 바이너리(블롭) 서명/검증
  ```
  # 서명
  cosign sign-blob --keyless ./artifact.jar > artifact.sig

  # 검증
  cosign verify-blob --keyless --signature artifact.sig ./artifact.jar
  ```

CI 파이프라인 적용 예시 (GitHub Actions)
- 간단한 예시: 빌드 → 푸시 → 서명(키리스)
  ```
  name: Build and Sign

  on:
    push:
      branches: [main]

  jobs:
    build:
      runs-on: ubuntu-latest
      permissions:
        contents: read
        id-token: write   # OIDC 토큰 발급 허용
      steps:
        - uses: actions/checkout@v4
        - name: Build image
          run: |
            docker build -t ghcr.io/myorg/myimage:1.0.0 .
            echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u USERNAME --password-stdin
            docker push ghcr.io/myorg/myimage:1.0.0
        - name: Install cosign
          run: |
            curl -sSL -o cosign https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
            chmod +x cosign && sudo mv cosign /usr/local/bin/
        - name: Sign image (keyless)
          run: |
            cosign sign --keyless ghcr.io/myorg/myimage:1.0.0
  ```
  위 예시는 GitHub Actions의 OIDC 지원을 이용해 keyless로 서명하는 흐름입니다. CI 런너가 적절한 권한을 갖고 OIDC 토큰을 얻을 수 있어야 합니다.

실무에서는 이렇게 확인하면 좋겠다
- 서명 존재 여부 + Rekor 로그 확인
  - cosign verify --keyless 또는 cosign verify --key <pubkey>로 기본 검증을 실행합니다. 이 때 재현 가능한(deterministic) digest로 검증하는 게 중요합니다.
  - Rekor 엔트리가 실제로 남았는지 재확인합니다. cosign verify는 기본적으로 rekor 확인을 시도하지만, 별도 rekor 서버를 쓰는 경우 해당 서버 접근을 확인해야 합니다.
- 서명된 이미지의 digest 일치 확인
  - 배포 시점에 "이미지 태그" 대신 "이미지 digest"로 검증하는 절차를 갖추면 태그 변조 위험을 줄일 수 있습니다.
  - 예: docker pull ghcr.io/myorg/myimage@sha256:<digest>
- certificate/issuer 확인 (keyless인 경우)
  - fulcio가 발급한 인증서의 issuer, subject, 만료일(expiration)을 확인합니다. OIDC issuer 정보와 연계해 발급 주체가 신뢰할 수 있는지 검증하는 것이 필요합니다.
- 권한 분리와 비밀 관리
  - 키 기반이라면 개인키를 CI 비밀(secrets)로 넣을 때 KMS(HSM, cloud KMS)를 이용해 직접 키를 노출하지 않는 것이 좋습니다. 예를 들어 GCP KMS, AWS KMS로 서명 요청을 위임하는 방식을 고려할 수 있습니다.
- 런타임 정책 적용
  - Kubernetes 환경에서는 Admission Webhook(또는 OPA Gatekeeper, Kyverno 등)으로 cosign 검증을 자동화해서 서명되지 않은 이미지를 차단하도록 설정하면 안전합니다.
  - 단, admission 정책 도입 시 성능과 실패 모드를 고려해 테스트 환경에서 충분히 검증하세요.

설정/점검 절차 예시 (배포 전/후)
- 배포 전
  1. 이미지가 서명되었는지 cosign verify로 확인
  2. rekor에 엔트리가 존재하는지 확인(로그 ID나 리소스 해시)
  3. 인증서(fulcio) 체인과 만료일 확인
  4. 이미지 digest가 배포 스펙과 일치하는지 점검
- 배포 중
  1. admission webhook이 정상 동작하는지 모니터링(거부 로그, 레이턴시)
  2. 레지스트리 접근 권한(쓰기는 제한, 서명 권한 분리 등) 확인
- 배포 후
  1. 배포된 노드에서 이미지 digest로 검사(예: kubectl describe pod -> imageID 확인)
  2. 운영 중 재검증 로그 보관(검증 실패 경보 설정)

주의할 점들(제가 공부하면서 조심스럽게 느낀 것들)
- Keyless가 완전 무관리 솔루션은 아니다
  - 운영 입장에서는 OIDC 공급자(예: GitHub, GCP, Azure) 설정, CI 서비스의 id-token 권한, fulcio 신뢰 루트 등 다양한 요소가 보안에 영향을 줍니다.
- Rekor 단일 의존성
  - 공개 rekor 서비스를 그대로 신뢰하기보다는 조직 내 프라이빗 rekor를 운영하거나 공개 rekor를 보조 수단으로 사용하는 방안을 고려할 수 있습니다.
- 서명 검증 실패 시의 정책 결정
  - 자동 차단, 경고 후 수동 승인 등 운영 정책을 사전에 정의해야 합니다. 서명 검증 실패가 빈번하면 배포 파이프라인이 멈출 위험이 있습니다.

실습용 체크 명령 모음(요약)
- 서명(로컬 키)
  ```
  cosign generate-key-pair
  cosign sign --key cosign.key ghcr.io/myorg/myimage:1.0.0
  ```
- 서명(keyless)
  ```
  cosign sign --keyless ghcr.io/myorg/myimage:1.0.0
  ```
- 검증
  ```
  cosign verify --keyless ghcr.io/myorg/myimage@sha256:<digest>
  cosign verify --key cosign.pub ghcr.io/myorg/myimage@sha256:<digest>
  ```
- rekor 엔트리 직접 확인(예: rekor URL이 있으면)
  ```
  # rekor 서버 URL을 지정해 검증 시도
  cosign verify --rekor-server https://rekor.example.org --keyless ghcr.io/myorg/myimage@sha256:<digest>
  ```

관련 이미지 주제
1. Sigstore의 세 구성요소(cosign, fulcio, rekor)를 심플 아이콘으로 연결한 일러스트.
2. CI 파이프라인에서 이미지 빌드 → 푸시 → 서명 → 검증 흐름을 화살표로 표현한 단순 다이어그램.

마무리(조심스러운 권고)
: Sigstore와 cosign은 비교적 사용성이 좋아 빠르게 도입할 수 있지만, "서명"은 단순한 기술 적용을 넘어 조직의 인증/권한 모델, 키관리 정책, CI 플레이스홀더, 런타임 검증까지 함께 설계되어야 합니다. 저는 아직 배우는 중이라 더 공부할 점이 많고, 이 글은 실무 도입을 위한 출발점으로 보시면 좋겠습니다.

실무 체크리스트
- [ ] 어떤 서명 방식(keyless / key-based)을 채택할지 결정했는가?
- [ ] CI에서 OIDC 토큰 발급과 권한(scope)을 안전하게 설정했는가?
- [ ] 서명된 아티팩트가 rekor에 기록되는지 확인하는 절차가 있는가?
- [ ] 이미지 검증을 배포 파이프라인(또는 k8s Admission)에 통합했는가?
- [ ] 이미지는 가능한 digest(sha256)로 취급하도록 배포 스펙이 구성되어 있는가?
- [ ] 키 기반이면 개인키는 KMS/HSM 같은 안전한 저장소에 보관하는가?
- [ ] fulcio/rekor의 신뢰 루트를 조직 정책에 맞게 검증했는가?
- [ ] 검증 실패 시의 운영 정책(차단, 경고, 예외 처리)을 정의했는가?
- [ ] 레지스트리 접근 권한(쓰기/읽기)과 서명 권한 분리가 되어 있는가?

참고(제가 참고했던 문서와 리소스)
: Sigstore 및 cosign 공식 문서와 GitHub Actions OIDC, 각 클라우드 KMS 연동 문서를 함께 보며 테스트했습니다. 공식 문서를 우선 참고하고 조직 환경에 맞게 검증 절차를 추가하시길 권합니다.

주의: 이 글 내용은 학습 중 정리한 초안이며, 버전이나 환경에 따라 명령어 옵션이나 동작이 달라질 수 있습니다. 실제 도입 전에는 공식 문서와 테스트를 통해 확인하세요.