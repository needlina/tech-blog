---
title: "macOS에서 윈도우처럼 클립보드 히스토리 쓰기: 무료 Flycut 설치와 실무 팁"
description: "macOS에서 무료 클립보드 매니저 Flycut을 Homebrew로 설치하고 단축키, 권한 문제, 붙여넣기 테스트, 로그 확인 경로와 복구 방법까지 단계별로 정리한 실무 가이드"
slug: "flycut-macos-clipboard-history"
date: 2026-07-25 10:00:00 +0900
categories: ["Blogging", "MacOS"]
tags: ["macos", "flycut", "clipboard-history", "생산성", "도구"]
image:
  path: /assets/img/posts/blog/flycut-macos-clipboard-history/preview.png
  alt: "mac os에서 윈도우의 클립보드 히스토리 기능을 사용하는 무료 flycut 소개 및 사용방법 썸네일"
---

구름이 조금 있는 날씨라 마음이 차분해져서 한 가지 간단한 도구를 정리해봤다. macOS에서 윈도우의 클립보드 히스토리처럼 여러 복사 항목을 관리하려면 **무료 Flycut을 Homebrew Cask로 설치하고 단축키·권한·붙여넣기 동작을 실제로 확인**하는 것이 가장 빠른 방법이다. (확인 포인트: `sw_vers -productVersion`, `brew --version`, `echo "test" | pbcopy` / `pbpaste`)

왜 이걸 정리하냐면, 로컬에선 잘 되는데 새 Mac이나 CI 계정에서 설치하면 단축키가 먹지 않거나 접근 권한 때문에 동작하지 않는 경우를 몇 번 봤다. 그래서 설치→권한→테스트→문제해결 순으로 바로 따라 할 수 있게 적었다.

## Flycut이 왜 쓸 만한가 — 가볍게 던지는 말
윈도우의 클립보드 히스토리(예: Win+V)를 자주 쓰던 사람에게 macOS 기본 클립보드는 한 번에 한 항목만 기억하는 게 불편하다. Flycut은 가볍고 무료이며, 복사한 항목을 목록으로 보여주고 바로 선택해서 붙여넣을 수 있다. Homebrew 커뮤니티와 GitHub에서 오래 유지되는 편이라 설치가 쉽고 업데이트도 간단하다. GitHub 리포지토리나 Homebrew 문서에 관련 정보가 있다.

한편, 커뮤니티 반응을 보면 "단순하고 충분하다"는 평가가 많지만, 보안·권한 관련 우려를 제기하는 사람도 있다. 개인정보가 포함된 클립보드를 오래 보관하지 않도록 설정을 확인해 두길 권한다.

![Flycut 아이콘과 복사 목록이 간단히 그려진 일러스트](/assets/img/posts/blog/flycut-macos-clipboard-history/image-1.webp)
이미지 출처: AI 생성 이미지

## 설치 전 체크리스트 (내가 먼저 보는 것들)
- macOS 버전: sw_vers -productVersion로 확인하세요. (예: 12.x, 13.x, 14.x)
- Homebrew 설치 여부: brew --version
- 터미널 권한(특정 macOS 버전에서 필요할 수 있음): 시스템 설정의 개인정보/보안 항목 확인
- 기존 클립보드 관리 앱 충돌 여부: 다른 앱의 단축키 또는 접근 권한 확인

간단한 확인 명령:
- macOS 버전: sw_vers -productVersion
- Homebrew: brew --version
- 클립보드 테스트: echo "hello" | pbcopy && pbpaste

## 실제 설치 단계 (명령어 포함)
Flycut은 Homebrew Cask로 설치하는 것이 가장 쉬웠다. Homebrew가 없으면 먼저 설치해야 한다.

1) Homebrew 확인
- brew --version

2) Flycut 설치
- brew install --cask flycut

3) 앱 실행
- open /Applications/Flycut.app

설치 후 Flycut 메뉴에서 기본 단축키(예: Command+Shift+V)를 확인하고, 필요하면 변경하세요.

위 명령 중 문제가 날 경우:
- "Error: Cask 'flycut' is unavailable" 같은 에러가 나오면 Homebrew Cask 리스트 업데이트 필요: brew update && brew upgrade
- 앱이 실행되지 않으면 콘솔 로그로 확인: log show --predicate 'process == "Flycut"' --last 1h

여기서 조금 헷갈릴 수 있는 점: macOS의 권한 모델은 버전마다 이름이 달라 종종 혼란스럽다. Flycut이 키보드 입력을 가로채거나 전역 단축키를 사용하려면 **시스템 설정 > 개인정보 및 보안 > 손쉬운 사용(또는 접근성)** 에 앱 허용이 필요하다고 알려진 사례가 있지만, 정확한 권한 이름은 macOS 버전에 따라 다르니 **공식 확인이 필요한 부분**이다.

## 자주 발생하는 증상, 원인, 확인 명령, 조치
아래 표는 실무에서 바로 판단에 쓰기 좋도록 정리했다.

| 증상 | 가능한 원인 | 확인 명령 / 위치 | 우선 조치 |
|---|---:|---|---|
| 단축키가 동작하지 않음 | 다른 앱과 충돌 / 시스템 권한 미부여 | 시스템 설정 > 키보드 > 단축키 / log show --predicate 'process == "Flycut"' --last 1h | Flycut 단축키 변경, 접근성 권한 확인 |
| 클립보드 항목이 저장되지 않음 | 앱 비활성화 / 세션 초기화 | /Applications/Flycut.app 실행 상태, Activity Monitor | 앱 재시작, Mac 로그아웃 후 재로그인 |
| 붙여넣기 시 이상 동작 | 입력 포커스 문제 / 에디터 단축키 우선 | pbpaste로 직접 테스트: echo "t" | pbcopy && pbpaste | 포커스 재설정, 다른 단축키로 바꿔 테스트 |
| 설치 실패 | Homebrew 문제 / 네트워크 | brew install --cask flycut 출력 | brew update && brew doctor, 네트워크 확인 |

이 표에서 시간을 많이 쓰는 부분은 단축키 충돌 확인이다. 단축키가 꼬이면 개발 중에 생산성이 크게 떨어진다.

![터미널에서 Homebrew와 pbcopy/pbpaste를 테스트하는 일러스트](/assets/img/posts/blog/flycut-macos-clipboard-history/image-2.webp)
이미지 출처: AI 생성 이미지

## 설정에서 꼭 확인할 것들 (권한·단축키·보관 개수)
- Accessibility / Input Monitoring: Flycut이 전역 단축키를 사용하려면 허용해야 할 수도 있다. (macOS 버전별 권한 이름이 달라서 공식 문서 확인 권장)
- 보관 항목 수: Flycut 환경설정에서 얼마나 많은 클립을 보관할지 설정하세요. **민감한 내용은 자동 삭제** 설정을 고려하세요.
- 시작 시 실행: 로그인 항목에 Flycut 추가로 재부팅 후 자동 실행 설정

권한을 바꾼 후에는 Flycut을 재시작하거나 로그아웃/로그인해야 반영되는 경우가 많다.

## 실패 예시와 수정 예시 (명령 포함)
실패 예시: 단축키가 먹지 않음
- 증상: Command+Shift+V를 눌러도 목록이 뜨지 않음
- 확인: 시스템 설정 > 키보드 > 단축키에 같은 조합이 다른 항목에 할당되었는지 확인
- 조치:
  - Flycut에서 단축키를 다른 키로 바꿔 테스트
  - 시스템 단축키에서 충돌 항목 비활성화

수정 예시(터미널로 간단히 테스트)
- 클립보드에 내용 복사: echo "flycut-test" | pbcopy
- 클립보드 내용 확인: pbpaste
- Flycut에서 방금 복사한 항목이 보이지 않으면 앱 재시작: killall Flycut || open /Applications/Flycut.app

만약 설치 시 Cask 관련 에러가 뜨면:
- brew update && brew upgrade
- brew install --cask --force flycut

위 명령으로도 해결되지 않으면 Homebrew 공식 문서와 Flycut GitHub 이슈 페이지를 확인해야 한다. (공식 확인이 필요한 부분: 특정 macOS 버전에서의 고유 버그)

## 커뮤니티 반응과 보안 우려
커뮤니티에서는 가벼움과 단순 인터페이스를 높이 평하지만, 복사한 내용이 로컬에 저장된다는 점을 우려하는 목소리도 있다. 개인정보·비밀번호가 클립보드에 남아 있지 않게 주의하고, 필요하면 보관 개수를 줄이거나 앱을 끄는 방식으로 관리하라고 조언하는 글이 많다. OO 조사에 따르면(예: 보안 블로그나 포럼 관찰), 클립보드 매니저 사용 시 민감 데이터 취급 정책을 사내 규정에 맞춰야 한다는 권고가 나온다.

## 사용 팁: 실전에서 바로 유용한 6가지
- pbcopy/pbpaste로 기본 동작을 먼저 확인한다.
- Flycut 단축키를 Emacs/IDE 단축키와 충돌 나지 않는 조합으로 바꾼다.
- 로그인 항목으로 등록해 재부팅 후 자동 실행되게 한다.
- 보관 항목 개수를 적당히 줄여 민감 데이터 노출을 줄인다.
- 문제가 생기면 log show로 최근 로그를 확인: log show --predicate 'process == "Flycut"' --last 1h
- Homebrew로 설치했으면 cask 재설치 전 brew update && brew doctor로 상태 점검

여기서 한 줄 판단: 단축키 충돌을 그냥 넘기면 개발 중에 생각보다 시간을 많이 잃는다.

## Q&A
아래는 실제로 검색할 법한 질문들만 뽑아 답을 짧게 달았다.

Q1: Flycut을 Homebrew 없이 수동 설치해도 되나요?  
A: 가능하지만 Homebrew로 설치하면 업데이트와 제거가 편합니다. 수동 설치는 GitHub 릴리즈에서 dmg를 받아 /Applications에 복사하세요.

Q2: Flycut이 클립보드의 이미지도 저장하나요?  
A: 기본적으로 텍스트 중심입니다. 이미지 저장 지원 여부는 앱 버전과 설정을 봐야 해서 공식 문서 확인이 필요합니다.

Q3: 단축키가 다른 앱과 겹치면 어떻게 찾나요?  
A: 시스템 설정 > 키보드 > 단축키에서 우선 확인하고, 의심되는 앱의 단축키를 일시 변경해 테스트하세요.

Q4: 클립보드 항목을 영구 삭제하려면?  
A: Flycut 환경설정에서 보관 항목을 조정하거나 앱을 종료하고 macOS 기본 클립보드를 비우세요: printf "" | pbcopy

Q5: 회사 정책상 클립보드 매니저 사용이 금지라면 어떻게 하나요?  
A: 보통 민감자료 보관 금지 규정을 따르라는 권고가 있습니다. IT 정책 담당자에게 문의하거나 앱 사용을 제한하세요.

## 나의 의견 1
여기에 직접 적어보세요: 내 Mac의 macOS 버전은 무엇이었는지, Flycut 설치 당시 보였던 첫 번째 에러 메시지(있었다면)는 무엇인지, 단축키 충돌이 있었다면 어떤 앱과 겹쳤는지 기록해 보세요.

## 나의 의견 2
여기에 직접 적어보세요: 보관 항목 수를 몇 개로 설정했는지, 민감 데이터 처리 규칙을 어떻게 정할지 팀과 어떤 합의가 필요한지 적어보세요.

## 마무리로 남기는 생각거리
개인적으로는 가볍게 설치하고 바로 쓰는 도구가 생산성을 생각보다 많이 올려주는 편이라 Flycut 같은 소형 앱을 선호한다. 다만, 팀 환경이나 보안 규정에서는 조금 더 신중하게 도입해야 한다. 먼저 볼 것: macOS 버전, Homebrew 상태, 단축키 충돌 여부. 다른 선택지가 나을 때: 이미지 중심 작업이나 고급 동기화(클라우드 백업 등)가 필요하면 더 무거운 상용 솔루션을 검토하는 편이 낫다.


## 함께 보면 좋은 글

- [GitHub Pages에서 Disqus 없이 giscus 댓글과 GoatCounter 조회수 붙이기](/posts/github-pages-giscus-goatcounter/)
- [기술 블로그 코드 스니펫을 항상 실행 가능하게 유지하는 자동화 전략](/posts/tech-blog-snippet-automation/)
- [GitHub Pages에 Bluehost 도메인 연결하기](/posts/github-pages-blue-host-domain/)

## 실무 체크리스트
- sw_vers -productVersion로 macOS 버전 확인
- brew --version으로 Homebrew 상태 확인
- 설치: brew install --cask flycut
- 단축키 테스트: Flycut 환경설정에서 단축키 변경 후 동작 확인
- 클립보드 동작 테스트: echo "test" | pbcopy && pbpaste
- 권한 확인: 시스템 설정 > 개인정보 및 보안 > 접근성(또는 입력 모니터링)에서 Flycut 허용(필요 시)
- 로그 확인: log show --predicate 'process == "Flycut"' --last 1h
- 문제 발생 시 복구: killall Flycut && open /Applications/Flycut.app, 필요하면 brew reinstall --cask flycut

끝으로, 설치할 때 나타난 에러 메시지와 권한 화면 스크린샷을 남겨두면 다음에 같은 문제를 겪을 동료에게 크게 도움이 됩니다.