---
title: "Nginx에서 대용량 파일 업로드 성능 문제(연결 고정·버퍼링) 해결 가이드"
slug: "nginx-large-file-upload-buffering-fixes"
date: 2026-07-17 09:00:00 +0900
categories: ["DevOps", "Backend"]
tags: ["nginx", "large-file-upload", "buffering", "performance", "devops"]
image:
  path: /assets/img/posts/blog/nginx-large-file-upload-buffering-fixes/preview.png
  alt: "대용량 업로드 최적화 썸네일"
---

오늘은 Nginx에서 대용량 파일(예: 수백 MB~수 GB)을 업로드할 때 종종 느려지거나 연결이 오래 고정되는 문제를 정리해봤습니다. 저는 아직 초보 개발자라서 문서와 실무 조언을 찾아가며 하나씩 확인해봤는데요, 공부한 내용을 독자인 여러분과 함께 천천히 정리하려고 합니다. 공식 문서만 요약하는 게 아니라, 제가 처음에 헷갈렸던 부분과 실무에서 체크하면 좋은 포인트 중심으로 풀어쓸게요.

공부하면서 알게 된 핵심 문제는 크게 두 가지로 보였습니다.
- 클라이언트가 느리게 업로드할 때 Nginx가 임시 파일로 버퍼링하면서 디스크 IO가 병목이 되는 경우
- Nginx와 백엔드(업스트림) 사이에서 요청 바디를 모두 버퍼링해서 느려지는 경우(=연결 고정)

처음에는 헷갈렸던 부분
- "proxy_buffering"과 "proxy_request_buffering"의 차이
- client_body_buffer_size가 메모리냐 디스크냐를 결정하는 기준
- sendfile/directio/tcp_nodelay가 업로드 성능에 미치는 영향

이 글에서는 위 개념을 천천히 설명하고, 실무에서 확인할 명령어, 설정 예제, 점검 절차를 적어놓았습니다. 마지막에 Q&A와 실무 체크리스트도 준비했으니 필요하면 바로 확인하세요.

이미지로 전체 흐름을 한 번 보겠습니다.

![파일 업로드 흐름도 일러스트](/assets/img/posts/blog/nginx-large-file-upload-buffering-fixes/image-1.webp)
이미지 출처: AI 생성 이미지

1. 문제 원인과 개념 정리
- client -> Nginx -> upstream(app)
- 클라이언트가 업로드 속도가 느리면 Nginx는 기본적으로 요청 바디를 다 받아서(버퍼링) 업스트림으로 보내려고 합니다.
- 이때 메모리 기준 client_body_buffer_size보다 큰 바디는 임시 디스크(기본: client_body_temp_path)로 쓰여집니다.
- 업스트림으로 전송할 때는 proxy_request_buffering(기본 on)이 켜져 있으면 Nginx가 업스트림에 요청 바디를 모두 버퍼링한 뒤 전송을 시작합니다. 이 상황에서 업스트림 연결이 오래 유지되거나 대기열이 생기면 "연결 고정" 현상이 발생합니다.

제가 공부하면서 느낀 점: **업로드 성능 문제는 Nginx 설정만이 아니라 디스크 IO, 백엔드 처리 방식, 네트워크 상태가 복합적으로 작용**합니다. 따라서 한 가지 설정만 바꿨을 때 문제의 원인이 완전히 해결되지 않을 수 있어요.

2. 주요 설정 항목 정리 (요약)
- client_body_buffer_size: 요청 바디를 메모리에 버퍼링할 최대 크기(예: 16k, 128k, 8m)
- client_max_body_size: 허용 최대 업로드 크기
- client_body_temp_path: Nginx가 임시 파일을 쓸 경로
- proxy_request_buffering: 업스트림에 요청 바디를 버퍼링할지 여부 (on/off)
- proxy_buffering: 업스트림에서 응답을 버퍼링할지 여부
- proxy_max_temp_file_size: 임시 파일 허용 크기
- sendfile, tcp_nopush, tcp_nodelay, directio: 파일 전송 관련 최적화(주로 응답 전송 측면)
- aio: 비동기 I/O 사용 가능 여부

간단 비교표(버퍼 전략별 장단점):

| 전략 | 메모리 사용 | 디스크 사용 | 업스트림 부하 | 추천 상황 |
|---:|:---:|:---:|:---:|:---|
| proxy_request_buffering on (기본) | 중간~높음 | 적음(메모리 우선) | 업스트림은 전체 바디 수신 후 처리 | 업스트림이 빠르게 수신 가능할 때 |
| proxy_request_buffering off | 낮음 | 낮음(스트리밍) | 업스트림에 스트리밍 부담 발생 | 업스트림이 스트리밍 처리 가능할 때 |
| 직접 S3 업로드 | 낮음 | 없음(서버 통과 없음) | 없음(서버 부담 줄음) | 클라이언트→S3 가능한 경우 |

**표 설명**: 각 열은 간단 비교 목적으로 작성했습니다. 실제 환경에서는 메모리 크기, 디스크 속도, 백엔드 구현에 따라 달라집니다.

3. 실무에서 제가 시도해본 설정 예시
제가 실험한 테스트용 nginx 설정(요약)입니다. 실제로 적용할 때는 환경에 맞게 조정하세요.

nginx.conf 예시 (업스트림이 스트리밍 처리 가능할 때, proxy_request_buffering off)
```nginx
http {
  client_max_body_size 10G;
  client_body_buffer_size 128k;
  client_body_temp_path /var/nginx/body_temp 1 2;
  proxy_buffering off;              # 응답 버퍼링 여부 (응답 관련)
  proxy_request_buffering off;      # 요청 바디를 업스트림으로 스트리밍
  proxy_connect_timeout 60s;
  proxy_send_timeout 300s;
  proxy_read_timeout 300s;

  server {
    listen 80;
    location /upload {
      proxy_pass http://backend_upload;
      proxy_set_header Connection "";
      proxy_set_header Host $host;
    }
  }
}
```

추가로 임시 디렉터리 권한/마운트도 확인했고, 임시파일 성능이 문제라면 tmpfs(메모리 기반)로 올릴지, 별도의 고성능 NVMe에 할당할지 고민이 필요합니다.

4. 점검 절차(실무에서 이렇게 확인하면 좋겠다)
제가 실제로 문제를 디버그할 때 사용한 순서입니다.

1) 현상 파악
- 어떤 요청이 오래 걸리는지 access_log(업로드 시간 확인), error_log(499, 413 등) 확인
- Nginx 상태: stub_status 또는 nginx -s status (설정에 따라 모듈 필요)
2) 연결/소켓 확인
- ss -tnp | grep nginx  (많은 ESTABLISHED/FIN_WAIT 등 확인)
- lsof -p <nginx_pid> | grep body_temp (임시파일 사용 여부)
3) 디스크/IO 확인
- du -sh /var/nginx/body_temp/*
- iostat -x 1 5, vmstat 1 5, iotop (디스크 병목 확인)
4) 로그 패턴
- access_log에서 업로드 요청의 처리 시간 필드(예: $request_time) 확인
- error_log에서 upstream 관련 에러 또는 timeout
5) 간단 재현 테스트
- 로컬에서 큰 파일 생성: dd if=/dev/zero of=big.bin bs=1M count=512
- curl로 업로드 시나리오: curl -X POST -F "file=@big.bin" http://server/upload --trace-time
- curl에 --limit-rate 옵션을 붙여서 '느린 클라이언트'를 시뮬레이션
6) 설정 토글 실험
- proxy_request_buffering on/off 전환 후 영향 관찰
- client_body_buffer_size를 늘려서 메모리 버퍼링이 가능한지 확인(메모리 부담 고려)
7) 모니터링
- Prometheus + nginx exporter로 연결 수, request 시간, temp dir 사용량을 모니터링하면 장기 추세 확인에 유용

실무에서 특히 체크할 포인트:
- **임시 디스크 사용량과 IO 대기시간(iowait)**: 디스크가 느리면 임시파일 쓰는 것만으로도 전체 처리 지연
- **499 응답 증가**: 클라이언트가 연결을 끊는 경우(업로드 중단) → 임시파일 잔류, 리소스 누수 확인
- **업스트림 로그**: 업스트림에서 스트리밍 처리를 제대로 하고 있는지(예: 서버가 Body를 즉시 소비하는지)

![Nginx 버퍼와 디스크 사용 개념도](/assets/img/posts/blog/nginx-large-file-upload-buffering-fixes/image-2.webp)
이미지 출처: AI 생성 이미지

5. 위험한 주의 사항(꼭 기억)
- **proxy_request_buffering을 무작정 off로 하면 업스트림 서버에 큰 스트리밍 부담이 간다**. 업스트림이 이를 못 버티면 오히려 문제 악화.
- client_body_buffer_size를 지나치게 크게 하면 Nginx 프로세스의 메모리 사용량이 급증할 수 있음.
- 임시 파일 경로는 충분한 디스크 공간이 있어야 하고, 권한/SELinux 설정이 맞아야 함.

6. 실무에서 고려할 대안
- 클라이언트 → S3(또는 오브젝트 스토리지) 직접 업로드: 서버를 통과하지 않아 서버 부담 감소
- 업로드 전처리(프론트엔드에서 다중 청크 업로드 구현): 청크 단위로 업로드하고 서버에서 병합
- 전용 업로드 전송 서비스(예: resumable upload 서버) 도입

7. 간단한 문제 사례와 해결 예
- 사례: 업로드 시 Nginx가 임시 디스크의 파일을 계속 생성하고 iowait이 높음
  - 원인 추정: client_body_buffer_size 작아서 디스크로 많이 쓰임 + 디스크 성능 낮음
  - 시도: client_body_buffer_size를 늘리고 client_body_temp_path를 빠른 디스크로 옮김
- 사례: 업로드 요청이 오래 대기하고 업스트림 연결이 고정됨
  - 원인 추정: proxy_request_buffering on 상태에서 업스트림이 바디를 받지 못함
  - 시도: proxy_request_buffering off로 설정 후 업스트림 로그/메모리 모니터링

8. 코드/명령 예제 모음(복습용)
- 큰 파일 생성 및 느린 업로드 재현
```bash
# 500MB 파일 생성
dd if=/dev/zero of=big.bin bs=1M count=500

# 느린 업로드(업로드 속도 제한)
curl -X POST -F "file=@big.bin" http://example.com/upload --limit-rate 100k
```

- Nginx 임시 디렉터리 용량 확인
```bash
du -sh /var/nginx/body_temp
ls -lh /var/nginx/body_temp | wc -l
```

- 활성 연결 확인
```bash
ss -tnp | grep nginx
ps aux | grep nginx
```

9. 공부하면서 알게 된 점 (요약)
- **버퍼링은 메모리와 디스크 사용의 균형 문제**다. 메모리로 모두 처리하면 디스크 부담은 줄지만 메모리 리스크가 있다.
- 업스트림이 스트리밍을 지원하면 proxy_request_buffering을 꺼서 Nginx가 '중계'만 하게 하는 게 효과적일 수 있다.
- 그러나 업스트림이 스트리밍을 못 받는다면 buffering off가 오히려 더 큰 문제를 만들 수 있다.
- 직접 S3 업로드 같은 아키텍처 변화는 근본적이고 실무에서 가장 효과적인 방법일 수 있다.

## 자주 묻는 질문
Q1. proxy_request_buffering을 무조건 off로 해도 될까요?
- 보통은 권장하지 않습니다. 업스트림이 스트리밍 요청을 처리할 수 있어야 안전합니다. 업스트림이 바로 바디를 소비(예: 스트리밍 처리)하지 못하면 연결 고정 문제나 메모리/CPU 과다 사용을 초래할 수 있어요.

Q2. client_body_buffer_size를 늘리면 모든 문제가 해결되나요?
- 아닐 수 있습니다. 메모리 여유가 충분하면 디스크 쓰기를 줄일 수 있지만, 메모리 사용량 증가로 다른 문제(OOM 등)가 발생할 수 있습니다. 또한 클라이언트가 극도로 느리면 메모리에 오래 유지되는 것도 부담입니다.

Q3. 임시 파일이 계속 남아있어요. 어떻게 하나요?
- 보통 Nginx는 업로드 완료 후 임시파일을 삭제합니다. 하지만 프로세스가 비정상 종료되거나 권한 문제, SELinux로 인해 삭제가 안될 수 있습니다. error_log와 시스템 로그, 그리고 파일 소유권/권한을 확인하세요.

Q4. 대용량 업로드에 가장 안전한 아키텍처는 뭔가요?
- 상황에 따라 다르지만, 클라이언트가 직접 오브젝트 스토리지(S3)로 업로드하는 방식이 서버 부담을 줄이는 데 가장 효과적입니다. 또는 업로드 전용 서비스/서버를 분리하는 것도 좋은 선택입니다.

Q5. chunked transfer와 관련된 문제는 없나요?
- 업로드 클라이언트와 서버가 chunked 요청을 지원하면 전송 시 메모리 사용 패턴이 달라질 수 있습니다. 일부 업스트림은 chunked 요청을 바로 처리하지 못할 수 있으니 호환성을 확인하세요.

실무 체크리스트
- [ ] access_log의 $request_time, $body_bytes_sent 검사
- [ ] error_log에 499/413/504 등 관련 에러 확인
- [ ] /var/nginx/body_temp(또는 설정한 temp path) 사용량 및 파일 존재 여부 확인
- [ ] iostat/iotop로 디스크 IO 병목 확인
- [ ] ss/ netstat로 연결 수와 상태 확인(ESTABLISHED, CLOSE_WAIT 등)
- [ ] proxy_request_buffering 설정 상태 확인 및 업스트림 호환성 점검
- [ ] client_body_buffer_size와 client_max_body_size 값 확인
- [ ] 업로드 대안(직접 S3 업로드, chunked/ resumable upload) 검토
- [ ] 배포 전 테스트 환경에서 느린 클라이언트 시나리오(--limit-rate)로 재현 테스트

마무리하면서, 저는 이 주제를 공부하며 "설정 한 줄"이 정답을 주는 경우는 드물다는 걸 배웠습니다. 환경(디스크, 네트워크, 업스트림 구현)에 따라 균형점을 찾아야 해서요. 혹시 여러분이 겪은 사례(로그, 설정 일부)를 공유해주시면 함께 원인 분석을 더 해볼 수 있을 것 같아요.