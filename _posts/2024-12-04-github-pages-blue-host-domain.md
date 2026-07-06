---
layout: post
title: "[Blog] Github 블로그 Domain 설정 (Feat. Bluehost)"
categories: blog github
tags: [blog, domain, bluehost, github, githubPage, 도메인, 블로그, 블루호스트]
image:
  path: https://henjini.com/assets/img/posts/blog/2024-12-04-github-pages-blue-host-domain/preview.png
  alt: ""
comments: true
---

# [Blog] Github 블로그 Domain 설정 (Feat. Bluehost)
Github 블로그를 도메인 구입 후 적용해보았습니다.   
블루호스트라는 서비스를 이용했고요, 매년 자동결제로 진행하고 있습니다.   
사실 도메인 구입은 오래전에 했지만 최근 도메인 관련 이슈가 있어서 내용을 정리해 놓으려합니다.   

## 사이트가 접속이 안된다!
블로그에 글 두개 작성해놓고.. 방치된 상태였는데, 곧 자동결제 시기도 오고 그래서, 오랜만에 사이트에 접속을 해보았습니다.   
아래와 같은 이미지가 뜨면서 접속이 안되는 현상...   

<img src="https://henjini.com/assets/img/posts/blog/2024-12-04-github-pages-blue-host-domain/err_connection_timed_out.jpg" width="600" height="500" alt=""/>

곰곰히 생각해보니 몇달 전 워드프레스 호스팅 관련 서비스를 해지했는데 그 영향인가 싶어서 고객센터에 채팅 요청을 했습니다.   
24/7이라서 빠른 응답이 가능하네요. bot인지 진짜 사람인지는 모르겠지만.. 자기 이름까지 대면서 채팅을 합니다.   

대화 내용은 이랬습니다.   
대기 시간동안 크롬브라우저와 사운드를 켜놓으면 띵동하면서 채팅이 왔다는 알림소리가 들리네요.   


>나 : 제 도메인이 갑자기 안들어가지는데 확인 부탁드립니다.   
>고객센터 : 도메인 주소를 알려주세요.   
>....   
>고객님의 보안 핀번호도 말씀부탁드립니다. (이건 내 정보페이지에 6자리 핀코드를 말합니다.)   
>고객센터 : 네 잠시만 기다려주세요   
>(10분 소요)   
>고객센터 : 고객님 호스팅 서비스가 만료되어서 접속이 안되는 것 같네요. 호스팅 플랜을 구입하셔야돼요.   
>나 : 아 그런가요 링크좀 주세요..   
>...   


이런 식으로 진행되어서 호스팅 구매를 진행했는데요,,,   
그래도 해결되지는 않았습니다. 제가 구매한것은 워드프레스 베이직 3년치였는데...   
서비스 연결해보면 워드프레스 공사중입니다 페이지가 뜨기 시작합니다.   
뭔가 불안하고 잘못된 느낌이 듭니다.   
호스팅 구매가 해결책이 아니라는걸 알게되어 바로 구매상품 설명 찾아보니 30일까지는 아묻따 환불이네요.(다행)   
잘 생각해보면 저는 Github Pages에서 제공하는 무료 호스팅에 그냥 도메인 링크만 이동시키는 것 뿐인데요.(멍청)   
다시 채팅을 겁니다.   


>나 : 제가 착오가 있었네요 호스팅 서비스 환불하려고합니다.   
>고객센터 : 네 잠시만 기다려주세요, 혹시 어떤 이유때문인가요?   
>나 : Github Pages를 이용하기 때문에 호스팅 서비스가 필요가 없습니다.   
>고객센터 : 그러시군요. 그럼 환불 진행을 위해 회원님의 이메일 주소를 알려주세요.   
>환불을 위해 확인이라고 말씀하시고 신용카드/페이팔인지 말씀해주세요.   
>...   


이런식으로 환불처리가 진행되었고 10영업일 이내에 처리가 된다고합니다.   


## 다시 세팅...
그럼 이제 다시 원점으로 돌아와서 확인을 해봐야겠죠.   
도메인과 Github Pages간의 연결이 끊어진 느낌이 들어서 확인해보니   
GithubPage주소가 아닌 IP주소가 박혀있네요,   
이유는 모르겠습니다만, 호스팅 서비스가 해제되면서 뭔가 정보가 날아간걸까요?   
아직도 미스터리..   
어쨌든 다시 제대로된 세팅을 해줘야합니다.   


### Domain과 Github Pages의 연결

#### **1. Github Page에서 Custom domain 설정**   
   
  아래 화면처럼 Github Repository에 접속하여 Pages항목에 들어갑니다.   
  아래쪽에 커스텀 도메인에 구매하신 도메인을 적어주면 됩니다.   
  이제 OOO.github.io로 이루어진 주소는 적어준 커스텀 도메인으로 연결되게 될거에요.   
  <img src="https://henjini.com/assets/img/posts/blog/2024-12-04-github-pages-blue-host-domain/github-pages.jpg" width="800" height="600" alt=""/>


#### **2. BlueHost에서 도메인 설정 수정하기**   
   
  그다음은 BlueHost에 접속하여 해당 도메인으로 접속된 주소를 Github Pages로 이동하도록 수정해야합니다.   
  구매한 도메인 옆에 Settings 버튼을 눌러 세팅 화면에 들어갑니다.   
  <img src="https://henjini.com/assets/img/posts/blog/2024-12-04-github-pages-blue-host-domain/domain-setting.jpg" width="800" height="600" alt=""/>   
  맨 아래쪽에 Advanced Tools에서 Advanced DNS Records 옆에 MANAGE를 눌러줍니다.   

  <img src="https://henjini.com/assets/img/posts/blog/2024-12-04-github-pages-blue-host-domain/advanced-tool.jpg" width="800" height="600" alt=""/>   

  경고 팝업이 뜨는데 무시하시고...(전문가가 아니면 건들지마시오,, 뭐 그런내용입니다.)   
  이제 화면이 뜨면 A 라고 적혀있는 곳에 www, @, *을 찾아줍니다. (안 보이시면 show more)   
  value에 엉뚱한 IP 주소가 적혀있네요 상단에 보면 under construction page에 해당하는 IP 주소네요..   
  이 주소를 Github Pages에서 제공하는 내 Github.io IP 주소로 변경해줘야 합니다.   
  <img src="https://henjini.com/assets/img/posts/blog/2024-12-04-github-pages-blue-host-domain/dns-aType.jpg" width="618" height="600" alt=""/>   

  아래처럼 터미널이나 명령 프롬프트 창에 명령어를 치면 
  ``` {bash}
  ping OOO.github.io
  ```

  이렇게 주소가 뜹니다.   
  <img src="https://henjini.com/assets/img/posts/blog/2024-12-04-github-pages-blue-host-domain/ping-check.jpg" width="593" height="383" alt=""/>   

  세 군데 모두 같은 IP를 적어줍니다. (TTL은 저는 1시간을 주었어요 (1 hour))


## 정리   
   
  다 하고나면 적용되기까지 조금 시간이 걸린다 그런 메시지가 나오네요.   
  제 경우에는 30분 정도면 정상적으로 페이지 접속이 되었네요.   
  조금만 생각해봤으면 알았을 문제를 오랜만에 하다보니 이것저것 찾아보면서 해결했네요.   
  이렇게 적어두면 까먹지 않겠죠.   
  근데 갑자기 잘되던 도메인 설정이 바뀐거는 이유가 뭘까요...   
  어쨌든 방치된 블로그에 글쓸 주제가 생겼던 에피소드였습니다.   
  그리고 얼마 후에 블루호스트에서 결제문자가 왔네요. 또 뭐야했더니 1년에 한번 도메인 정기결제...   
  환율이 올라서 그런지 한화 7만원 정도가 결제됐네요. (도메인 + 도메인 보호 기능 등)   
  결제 문자 볼때마다 동기부여가 됩니다.   
  앞으로 조금 더 열심히 블로그를 해보려합니다.   

