---
title: "Nix로 개발환경 재현하기: 패키지, 환경설정, CI 연동 실무 가이드"
description: "로컬과 CI 간 환경 불일치 문제를 Nix로 해결하는 절차·필요 파일·핵심 명령어·검증 방법·CI(예: GitHub Actions) 연동 포인트·캐시 설정과 실패 원인별 점검 경로"
slug: "blog-reproducible-examples-with-nix-shell"
date: 2026-07-20 09:00:00 +0900
categories: ["DevOps", "CI/CD"]
tags: ["nix", "devops", "ci-cd", "reproducible-env", "배포자동화"]
image:
  path: /assets/img/posts/blog/blog-reproducible-examples-with-nix-shell/preview.png
  alt: "Nix로 재현 가능한 블로그 예제 썸네일"
---

로컬에서는 빌드가 잘 되는데 GitHub Actions나 다른 CI에서만 깨질 때, **Nix로 패키지와 런타임을 고정하면 재현성이 좋아져 문제 원인 파악이 쉬워집니다**. 이 글은 Nix(Flakes 기준 중심)로 개발환경을 재현하는 핵심 파일 구조·주요 명령어·CI 연동 예시·검증 절차를 먼저 요약하고, 실제로 어떻게 구성하고 확인하면 좋은지 단계별로 정리합니다.

왜 이걸 배웠나: 로컬에서 node 버전·툴체인이 달라서 테스트가 깨지는 상황을 겪으면서, 도커 이미지보다 더 가볍고 패키지 버전까지 고정할 수 있는 Nix에 관심이 생겼습니다. 초반엔 flake, devShell, 캐시 흐름이 헷갈렸는데 실무에서 자주 확인해야 할 지점들을 중심으로 정리해봤습니다.

목차
- 핵심 개념 요약
- 파일 구성 예시: flake.nix / devShell
- 실패 예시와 수정 예시 (코드 포함)
- CI 연동(GitHub Actions) 및 캐시 설정
- 점검·검증 명령과 흔한 오류
- 작은 비교표: Flakes vs non-Flakes
- 자주 묻는 질문(Q&A)
- 나의 의견 1 / 나의 의견 2
- 실무 체크리스트

핵심 개념 요약 (핵심만 먼저)
- **flake.nix**: 입력(nixpkgs, templates)을 고정하고 devShell과 빌드 출력을 선언하는 현대적 방식. 재현성과 의존성 추적에 유리.
- **devShell**: 개발자용 셸 환경(IDE, lint, 테스트 도구 포함)을 정의. 로컬 `nix develop`과 CI의 선행 환경 일치에 사용.
- **binary cache / Cachix**: 빌드 결과를 공유하면 CI 속도를 크게 올릴 수 있음. 공개 캐시 또는 사설 Cachix 사용 권장.
- 실무에서 먼저 확인할 것: Nix 버전, flake.lock의 nixpkgs 커밋 해시, devShell에 선언된 패키지 정확성, CI 로그의 `nix build` 출력과 캐시 히트 여부.

파일 구성 예시
- 프로젝트 루트:
  - flake.nix
  - flake.lock
  - .github/workflows/ci.yml
  - devshell/default.nix (선택적)
- 예시 flake.nix (간단화)
```
{
  description = "dev shell for my project";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-23.11";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ nodejs-18_x yarn git ];
          shellHook = ''
            export NODE_ENV=development
          '';
        };
        packages.default = pkgs.stdenv.mkDerivation {
          name = "my-app";
          src = ./.;
          buildCommand = "echo build";
        };
      });
}
```

로컬 실패 예시와 고친 예시
- 실패 상황: CI에서 `node` 버전이 달라 테스트가 깨짐. 에러 메시지 예:
  - "Error: Unsupported engine for package: wanted: {"node": ">=18"} got: 16.20.0"
- 실패하는 devShell (의도는 node 18 사용)
```
buildInputs = with pkgs; [ nodejs ]; # nodejs가 채택한 기본 버전이 다름
```
- 수정 후 (명시적 버전 지정)
```
buildInputs = with pkgs; [ nodejs-18_x ]; # 명확한 버전 지정으로 재현성 확보
```
위처럼 패키지를 `nodejs-18_x`처럼 명시하면 다른 시스템에서도 동일한 런타임을 사용하게 됩니다.

CI 연동 (GitHub Actions) — 예시와 주의점
- 핵심: CI에서는 Nix 설치, flake 캐시 활용, `nix develop` 또는 `nix build` 실행 순서를 확인해야 함.
- 권장 흐름: 설치 -> cachix 로그인(선택) -> `nix build` 또는 `nix develop --command` -> 테스트
- GitHub Actions 예시(주의: 액션 YAML의 `${{ ... }}` 표현은 Jekyll에서 raw로 감싸야 합니다):
{% raw %}
```yaml
name: CI

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v18
        with:
          nix_path: "nixpkgs=/nix/var/nix/profiles/per-user/root/channels/nixos"
      - name: Use Cachix
        uses: cachix/cachix-action@v10
        with:
          name: myproject
          authToken: ${{ secrets.CACHIX_AUTH_TOKEN }}
      - name: nix build
        run: nix build --flake .#packages.x86_64-linux.default
      - name: run tests
        run: ./result/bin/run-tests.sh
```
{% endraw %}
- 실무 체크: Actions 로그에서 `substituting`/`downloading`/`building` 메시지를 보고 캐시 히트 여부와 빌드 시간을 비교하세요. 캐시 miss 시 빌드가 오래 걸립니다.

캐시와 성능 팁
- 공용 캐시 사용 시 `cachix`로 binary cache를 설정하면 CI 빌드 시간을 크게 줄일 수 있음.
- `nix build --show-trace`와 `nix log`로 실패 시 원인 추적.
- `nix-store --verify --check-contents`로 store 무결성 검증(긴 명령, 주기적 사용 권장).
- 예: Nix 버전 확인
  - `nix --version` (예: 2.13.3)
  - `nix show-config`로 설정 확인

검증 명령·재현 절차 (실무에서 바로 쓸 것)
- 로컬에서 flake 기반 dev shell 실행: `nix develop`
- CI와 동일한 커맨드로 로컬 재현: `nix build --flake .#packages.x86_64-linux.default && ./result/bin/run-tests.sh`
- flake.lock의 nixpkgs 커밋 확인: `jq -r '.nodes["nixpkgs"].locked.rev' flake.lock`
- 빌드 캐시 히트 여부: Actions 로그 또는 `nix store --query --requisites ./result`로 확인
- 실패 로그에서 자주 보는 패턴:
  - 인증/증명서 문제: "certificate verification failed"
  - 패키지 찾기 실패: "error: attribute 'nodejs-18_x' not found"
  - 권한 문제: "permission denied '/nix/store'"

비교: Flakes vs non-Flakes (간단 비교표)
| 기준 | Flakes | non-Flakes |
|---:|:---|:---|
| 의존 고정 | **커밋 해시로 고정** | 채널/버전 불명확 가능 |
| 재현성 | 높음 | 낮음 가능 |
| CI 사용성 | 표준화된 `nix build --flake` | 여러 스크립트 필요 가능 |
| 학습 곡선 | 조금 더 높음 | 낮음(기존 문서 많음) |

자주 묻는 질문 (Q&A)
Q: flake.lock을 커밋해야 하나요?
A: 네. **flake.lock에 있는 nixpkgs의 리비전 정보가 재현성의 핵심**이라 보통 커밋합니다. flake.lock 없이 빌드하면 동일 결과를 보장하기 어렵습니다.

Q: Cachix 없이도 CI를 빠르게 할 수 있나요?
A: 가능하긴 하지만 첫 빌드 시 모든 의존을 소스에서 빌드하므로 오래 걸립니다. 자주 사용하는 의존이 많다면 Cachix를 쓰는 편이 보통 더 효율적입니다.

Q: Nix 버전 불일치로 에러가 나면 어떻게 확인하나요?
A: `nix --version`, `nix show-config`, 그리고 CI 로그의 install-nix-action 버전을 확인하세요. 필요하면 flake의 `inputs.nix`에 명시적으로 호환 버전을 고정합니다.

실패 예시: 인증 문제(예)
- 에러:
  - "error: unable to download 'https://github.com/NixOS/nixpkgs/archive/…': certificate verify failed"
- 점검 포인트:
  - CI 환경의 CA 설정, 프록시, `nix.conf`의 `trusted-public-keys` 설정 확인
  - `curl -v https://github.com` 로 네트워크 확인

명령어/버전/로그 예시(구체적)
- Nix 버전: `nix --version` -> "nix (Nix) 2.13.3"
- Node 버전(예): `node --version` -> "v18.20.0"
- 재현 테스트(로컬): `nix build --flake .#packages.x86_64-linux.default && time ./result/bin/run-tests.sh`
- flake.lock 확인: `jq -r '.nodes["nixpkgs"].locked.rev' flake.lock` -> "e8a1b2c..."

코드 예시는 실패 예시 + 수정 예시로 넣으려고 노력했습니다(위에 포함). 직접 복사해서 실행할 때는 시스템에 맞게 `system`(x86_64-linux 등) 값을 확인하세요.

나의 의견 1
- 이 섹션에는 직접 경험을 적어주세요. 예: "내 환경에서는 Nix 버전 ___(예:2.13.3), node ___(예:18.20.0)이었고, 처음 실패한 명령은 ___였으며, 수정 전 로그는 ___, 수정 후 로그는 ___로 바뀌었다."

나의 의견 2
- 여기에도 실제 실무에서 겪은 정보를 채워주세요. 예: "CI에서 캐시 miss였던 횟수, 캐시 도입 전/후 빌드 시간(초), flake.lock 갱신 빈도" 등 구체 숫자를 적어보세요.

마무리 — 무엇을 먼저 확인해야 하나, 언제 다른 선택지가 나은가
- 먼저 확인할 것: `nix --version`, flake.lock의 nixpkgs 리비전, devShell에 명시된 패키지 이름(예: nodejs-18_x). 이 세 가지가 맞지 않으면 재현 실패 가능성이 큽니다.
- 다른 선택지가 나은 경우: 이미 도커 이미지를 표준으로 쓰고 있고 이미지 레이어 관리가 익숙하다면 도커 기반 CI·배포가 더 간단할 수 있습니다. 반면 **개별 패키지 버전까지 세밀히 고정하고 빠른 캐시 재사용을 원하면 Nix가 유리**합니다.

실무 체크리스트
- [ ] `flake.lock` 커밋 여부 확인
- [ ] `nix --version` 로 로컬/CI 버전 일치 확인
- [ ] `nix build --flake .#...`로 빌드 재현 시도
- [ ] Actions 로그에서 캐시 히트 상태 확인(`cached`/`building`)
- [ ] devShell에 node 등 런타임을 **명시적 버전**으로 선언했는지 확인
- [ ] 캐시를 사용할 경우 Cachix token/권한 확인
- [ ] 실패 시 `nix build --show-trace` 로 상세 추적
- [ ] 네트워크/증명서 문제 발생 시 CI 이미지의 CA와 프록시 설정 점검

이미지: Nix 환경 개념 다이어그램
![Nix 환경과 CI 흐름을 단순하게 보여주는 일러스트](/assets/img/posts/blog/blog-reproducible-examples-with-nix-shell/image-1.webp)
이미지 출처: AI 생성 이미지

이미지: devShell과 flake 관계를 단순화한 그림
![devShell과 flake 관계를 단순히 보여주는 다이어그램](/assets/img/posts/blog/blog-reproducible-examples-with-nix-shell/image-2.webp)
이미지 출처: AI 생성 이미지

도움이 되셨다면, 여러분 환경에서 어떤 버전을 사용하고 어떤 문제를 겪었는지 공유해주시면 제가 겪은 것과 비교해서 더 정리해볼게요.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.
