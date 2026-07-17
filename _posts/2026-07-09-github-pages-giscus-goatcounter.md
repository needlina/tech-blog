---
layout: post
title: "GitHub Pages에서 Disqus 없이 giscus 댓글과 GoatCounter 조회수 붙이기"
description: "GitHub Pages로 블로그를 운영하다 보면 댓글과 조회수 기능을 붙이고 싶어집니다. 하지만 GitHub Pages는 정적 호스팅이기 때문에 서버에서 댓글을 저장하거나 조회수를 직접 증가시키는 로직을 실행할 수 없습니다"
date: 2026-07-09 01:02:20 +0900
categories: [Blogging, GitHub Pages]
tags: ["github-pages", "jekyll", "giscus", "goatcounter", "댓글설정"]
comments: true
---

GitHub Pages로 블로그를 운영하다 보면 댓글과 조회수 기능을 붙이고 싶어집니다.   
하지만 GitHub Pages는 정적 호스팅이기 때문에 서버에서 댓글을 저장하거나 조회수를 직접 증가시키는 로직을 실행할 수 없습니다.

그래서 보통은 외부 서비스를 붙입니다. 예전에는 Disqus를 많이 썼지만, 광고나 추적 스크립트가 부담스럽기도 하고 GitHub 기반 블로그와는 결이 조금 다르다고 느껴질 때가 있습니다.   
이번에는 Disqus 없이 `giscus`로 댓글을 붙이고, `GoatCounter`로 조회수를 확인하는 구성을 정리해보려 합니다.

## 목표

구성 목표는 단순합니다.

- 댓글은 GitHub Discussions 기반의 giscus 사용
- 조회수는 GoatCounter 사용
- API Key나 별도 서버 없이 GitHub Pages에 적용
- Jekyll Chirpy 테마의 `_config.yml` 설정을 최대한 활용

이 글은 Chirpy 테마 기준으로 작성했지만, 기본 개념은 다른 Jekyll 블로그에도 비슷하게 적용할 수 있습니다.

## GitHub Pages에서 댓글과 조회수가 까다로운 이유

GitHub Pages는 HTML, CSS, JavaScript 같은 정적 파일을 호스팅합니다.   
즉 서버에서 DB에 값을 저장하거나, 방문자가 들어올 때마다 조회수를 `+1` 하는 백엔드 코드를 직접 실행할 수 없습니다.

그래서 댓글과 조회수는 보통 아래 방식 중 하나를 선택합니다.

- GitHub Discussions 또는 Issues를 댓글 저장소로 사용
- 외부 analytics 서비스를 사용
- Firebase, Supabase 같은 외부 DB를 직접 붙임
- 별도 API 서버를 운영

개인 기술 블로그라면 너무 무겁게 가져갈 필요는 없습니다.   
댓글은 GitHub Discussions 기반의 `giscus`, 조회수는 가벼운 `GoatCounter` 조합이면 충분히 실용적입니다.

## giscus란?

`giscus`는 GitHub Discussions를 댓글 저장소로 사용하는 댓글 시스템입니다.   
방문자가 블로그 글에 댓글을 남기면 실제 데이터는 GitHub Discussions에 저장됩니다.

장점은 다음과 같습니다.

- Disqus처럼 별도 광고가 붙지 않음
- GitHub 계정으로 댓글 작성 가능
- 댓글 데이터가 GitHub Discussions에 남음
- 다크 모드 대응이 좋음
- Jekyll Chirpy에서 기본 지원

단점도 있습니다.

- GitHub 계정이 있어야 댓글 작성 가능
- repository가 public이어야 함
- GitHub Discussions를 켜야 함
- giscus GitHub App 설치가 필요함

개발 블로그라면 방문자도 GitHub 계정이 있을 가능성이 높아서, 오히려 자연스러운 선택이라고 볼 수 있습니다.

## giscus 설정 전 준비

giscus를 사용하려면 먼저 GitHub repository에서 몇 가지 설정을 해야 합니다.

### 1. Repository public 확인

giscus는 public repository에서 사용하는 것이 기본입니다.   
방문자가 댓글 Discussion을 볼 수 있어야 하기 때문입니다.

예를 들어 블로그 repository가 아래와 같다면:

```txt
needlina/tech-blog
```

이 repository가 public인지 먼저 확인합니다.

### 2. GitHub Discussions 활성화

GitHub repository로 이동한 뒤 아래 경로에서 Discussions를 켭니다.

```txt
Repository
→ Settings
→ Features
→ Discussions 체크
```

Discussions를 켜면 repository 상단 메뉴에 `Discussions` 탭이 생깁니다.

### 3. giscus GitHub App 설치

giscus는 GitHub App으로 동작합니다.   
아래 페이지에서 설치합니다.

```txt
https://github.com/apps/giscus
```

가능하면 전체 repository가 아니라 블로그 repository 하나만 선택해서 설치하는 편이 좋습니다.

## giscus 설정값 가져오기

이제 giscus 설정 페이지로 이동합니다.

```txt
https://giscus.app
```

설정은 대략 이렇게 선택합니다.

```txt
Language: 한국어
Repository: needlina/tech-blog
Page ↔ Discussions Mapping: pathname
Discussion Category: Announcements
Features: Enable reactions 체크
Input position: bottom
Theme: Preferred color scheme
```

여기서 중요한 값은 두 개입니다.

```html
data-repo-id="..."
data-category-id="..."
```

이 값들은 API Key가 아닙니다.   
비밀값이 아니라 GitHub repository와 discussion category를 식별하기 위한 공개 ID입니다.

## Chirpy에서 giscus 설정하기

Chirpy 테마는 `_config.yml`에서 댓글 provider를 바꿀 수 있습니다.

기존에 Disqus를 사용하고 있었다면 아래처럼 되어 있을 수 있습니다.

```yml
comments:
  provider: disqus
  disqus:
    comments: true
    shortname: 'henjini'
```

이제 provider를 `giscus`로 바꾸고, giscus 설정값을 넣습니다.

```yml
comments:
  provider: giscus
  disqus:
    comments:
    shortname:
  utterances:
    repo:
    issue_term:
  giscus:
    repo: needlina/tech-blog
    repo_id: "giscus에서 받은 data-repo-id"
    category: Announcements
    category_id: "giscus에서 받은 data-category-id"
    mapping: pathname
    strict: 0
    input_position: bottom
    lang: ko
    reactions_enabled: 1
```

여기서 `repo_id`와 `category_id`는 꼭 실제 값으로 바꿔야 합니다.   
`TODO_GISCUS_REPO_ID` 같은 placeholder가 남아 있으면 댓글 위젯이 정상적으로 동작하지 않을 수 있습니다.

## Disqus 흔적 제거하기

Disqus를 더 이상 쓰지 않는다면 `_config.yml`만 바꾸는 것으로 끝내도 되지만, `ads.txt`에 Disqus 관련 항목이 남아 있을 수 있습니다.

예를 들어 이런 항목입니다.

```txt
disqus.com, 4958469, DIRECT
inventorypartnerdomain=disqus.com
```

Disqus 광고 연동을 쓰지 않는다면 제거해도 됩니다.

## GoatCounter로 조회수 붙이기

조회수는 `GoatCounter`를 사용합니다.   
GoatCounter는 가볍고, 개인 블로그에 붙이기 부담이 적습니다.

Chirpy는 GoatCounter pageviews를 기본으로 지원합니다.   
`_config.yml`에서 아래처럼 설정하면 됩니다.

```yml
analytics:
  goatcounter:
    id: tech-henjini

pageviews:
  provider: goatcounter
```

여기서 `tech-henjini`는 GoatCounter의 site code입니다.   
즉 아래 주소에 대응됩니다.

```txt
https://tech-henjini.goatcounter.com
```

GoatCounter에 가입한 뒤 site code를 만들고, `_config.yml`의 `analytics.goatcounter.id` 값과 맞추면 됩니다.

## API Key가 필요한가?

이 구성에서는 API Key가 필요하지 않습니다.

giscus에서 필요한 값은 다음 정도입니다.

- `repo`
- `repo_id`
- `category`
- `category_id`

이 값들은 비밀키가 아니라 공개 설정값입니다.

GoatCounter도 일반적인 Chirpy 연동에서는 별도 API Key가 필요하지 않습니다.   
site code만 맞으면 됩니다.

다만 Firebase, Supabase, 자체 서버로 조회수를 직접 구현한다면 이야기가 달라집니다.   
그 경우에는 anon key, RLS, abuse 방어, 중복 조회 방지 등을 따로 설계해야 합니다.

개인 블로그라면 처음부터 복잡하게 가져가기보다는 giscus와 GoatCounter 조합으로 시작하는 편이 좋습니다.

## 배포 후 확인할 것

설정을 끝내고 배포했다면 글 상세 페이지에서 아래를 확인합니다.

- 댓글 영역에 giscus iframe이 보이는지
- 댓글 작성 버튼을 누르면 GitHub 인증으로 넘어가는지
- GitHub Discussions에 글별 Discussion이 생성되는지
- GoatCounter dashboard에 방문 기록이 찍히는지
- 글 상세 페이지의 조회수 영역이 비어 있지 않은지

조회수가 바로 안 보인다면 광고 차단기가 GoatCounter 요청을 막고 있을 수도 있습니다.   
브라우저 확장 프로그램을 잠시 끄거나 다른 브라우저에서 확인해보면 원인 파악이 쉽습니다.

## 정리

GitHub Pages는 정적 호스팅이라 댓글과 조회수를 직접 저장할 수 없습니다.   
하지만 GitHub 생태계와 잘 맞는 도구를 붙이면 별도 서버 없이도 충분히 블로그다운 기능을 만들 수 있습니다.

내 기준에서 가장 무난한 조합은 다음입니다.

```txt
댓글: giscus
조회수: GoatCounter
```

Disqus 없이도 댓글과 조회수를 구현할 수 있고, API Key나 서버 운영 없이 시작할 수 있다는 점이 가장 큰 장점입니다.

## 실무 체크리스트

- [ ] repository가 public인지 확인한다.
- [ ] GitHub Discussions를 활성화한다.
- [ ] giscus GitHub App을 설치한다.
- [ ] giscus 설정 페이지에서 `repo_id`, `category_id`를 가져온다.
- [ ] `_config.yml`의 `comments.provider`를 `giscus`로 변경한다.
- [ ] Disqus를 사용하지 않는다면 `ads.txt`의 Disqus 항목을 제거한다.
- [ ] GoatCounter site code를 만든다.
- [ ] `_config.yml`의 `analytics.goatcounter.id`와 `pageviews.provider`를 확인한다.
- [ ] 배포 후 글 상세 페이지에서 댓글과 조회수를 확인한다.
