---
title: "동시 대량 업로드로 인한 임시 파일·디스크 급증 대응 가이드"
description: "백엔드에서 동시 대량 업로드로 임시 파일·디스크 사용량이 급증할 때 빠르게 증상 확인하고 임시 완화(tmpfs, 삭제, 서비스 재시작) 후 스트리밍·직접 업로드로 장기 해결하는 절차와 점검 명령"
slug: "backend-concurrent-uploads-temp-disk-control"
date: 2026-07-18 12:00:00 +0900
categories: ["Backend", "DevOps"]
tags: ["docker", "linux", "disk-usage", "장애대응", "임시파일"]
image:
  path: /assets/img/posts/blog/backend-concurrent-uploads-temp-disk-control/preview.png
  alt: "대량 동시 업로드 디스크 폭주 대응 썸네일"
---

동시 다중 업로드가 몰리면 서비스 로그에 "ENOSPC" 같은 오류와 함께 /tmp나 컨테이너 루트의 디스크가 빠르게 채워질 수 있는데, 우선은 **디스크 사용량 확인(df/du), 열린 파일 확인(lsof), 임시파일 위치(/tmp, /var/lib/docker) 제거**로 단기 완화를 하고, 근본적으로는 **스트리밍 업로드 혹은 클라이언트→S3(사전 서명) 직접 업로드** 같은 설계 변경을 고려해야 합니다.

시작 상황: 로컬/소규모 테스트에선 괜찮았는데, 프로덕션에서 50~200 동시 업로드가 들어오자 몇 분 만에 /tmp가 채워지고 서비스가 ENOSPC를 반환한 케이스를 마주했습니다. 아래는 제가 공부하면서 정리한 점과 실무에서 바로 쓸 수 있는 점검·대응 절차입니다.

실무 핵심 요약
- 증상: 500 응답 + 로그 "ENOSPC", 디스크 사용 100% 또는 inode 고갈
- 즉시 점검: df -h, df -i, du -sh /tmp, lsof +L1, ss/tcp 연결수, 컨테이너 디스크 사용(/var/lib/docker/overlay2)
- 임시 완화: 오래된 임시파일 삭제(find /tmp -type f -mtime +1 -delete), tmpfs 마운트, 서비스 재시작(필요 시)
- 근본 대책: 스트리밍 처리·버퍼 최소화, direct-to-cloud(Pre-signed upload), 업로드 제한/요율제어(rate limit)

공부하면서 알게 된 점
- 디스크가 차는 원인은 단순히 파일 크기뿐만 아니라 업로드 처리 방식(메모리 vs 디스크 버퍼, 멀티파트 처리 라이브러리)이 큽니다. 예를 들어 Node.js + multer의 diskStorage를 그대로 쓰면 동시 업로드 수 × 파일 크기만큼 /tmp에 쌓입니다.
- Docker 컨테이너 환경에서는 컨테이너의 루트 파일시스템(/)이 호스트의 /var/lib/docker/overlay2에 쌓이므로 컨테이너 내부 df만 보면 안 되고 호스트 df를 함께 봐야 했습니다.
- tmpfs(메모리 기반 임시 파일시스템)는 임시 완화로 유용하지만 메모리 부족을 유발하므로 크기 한도를 정해둬야 합니다.

처음에는 헷갈렸던 부분
- "inode 고갈 vs 용량 고갈"이 구별되지 않아 잘못된 조치를 했습니다. inode 고갈인 경우 많은 작은 파일이 문제라서 du로는 잘 안 보이고 df -i로 확인해야 합니다.
- 컨테이너 내부에서 /tmp를 비워도 호스트 측 Docker 레이어에 남아있는 경우가 있어서, docker system df와 /var/lib/docker 경로를 확인해야 한다는 점을 나중에 알아챘습니다.

실무에서는 이렇게 확인하면 좋겠다 (즉시 명령 모음)
- 디스크/인오드 확인
  - df -h
  - df -i
- 특정 경로 사용량 세부 확인
  - du -sh /tmp
  - du -sh /var/lib/docker/overlay2
  - dc: sudo du -x --max-depth=1 / | sort -h
- 열린(삭제된) 파일 확인: (파일이 삭제됐지만 프로세스가 잡고 있어 공간이 해제되지 않는 경우)
  - sudo lsof +L1
  - 예: "bash-4.4# lsof +L1" 출력에 프로세스 PID와 삭제된 파일이 보이면 프로세스 재시작 필요
- 컨테이너 관련
  - docker ps -q | xargs -r docker inspect --format '{{.Id}} {{.GraphDriver.Name}}'  (참고: inspect 포맷은 환경에 따라 다름)
  - docker system df
- 네트워크/동시 연결 체크
  - ss -s
  - ss -tan | grep :80 | wc -l

실제 오류 메시지 예시 (프로덕션 로그)
- write /tmp/upload-123.tmp: no space left on device
- ENOSPC: no space left on device, errno: 28
- multipart: nextPart: EOF (업로드 중 연결 끊김 증상)

재현 및 부하 테스트(로컬)
- 테스트 파일 만들기
  - dd if=/dev/zero of=10MB.bin bs=1M count=10
- 동시 업로드 시뮬레이션 (10MB 파일 100개를 10병렬로)
  - seq 1 100 | xargs -n1 -P10 -I{} curl -s -o /dev/null -w "%{http_code}\n" -F "file=@./10MB.bin" http://localhost:3000/upload
- 결과: 100 * 10MB = 1GB가 동시에 만들어질 수 있음을 계산해 두기

실패 코드 예시 (나쁜 패턴)
- Express + multer diskStorage를 그대로 사용해 업로드 파일을 임시로 /tmp에 저장하고, 처리 후 S3로 업로드하는 동작
```js
// bad-upload.js
const express = require('express');
const multer = require('multer');
const upload = multer({ dest: '/tmp' }); // 임시 파일을 바로 디스크로
const app = express();

app.post('/upload', upload.single('file'), async (req, res) => {
  // 여기서 파일을 S3에 업로드하지만, 동시성이 높으면 /tmp가 금방 찬다
  await uploadToS3(req.file.path);
  res.sendStatus(200);
});
```
문제: 업로드가 끝난 시점까지 디스크에 파일이 남고, 동시 업로드가 많으면 디스크가 금방 가득 참.

수정(개선) 예시 — 스트리밍 처리 또는 direct-to-S3
- 방법 A: 클라이언트가 Pre-signed URL로 직접 S3에 업로드
  - 서버는 사전 서명만 발급, 서버 디스크 사용 제로
- 방법 B: 서버에서 스트리밍으로 S3에 업로드 (메모리/디스크에 저장 안 함)
```js
// good-upload-stream.js (간단화)
const express = require('express');
const busboy = require('busboy');
const AWS = require('aws-sdk');
const s3 = new AWS.S3({ region: 'ap-northeast-2' });
const app = express();

app.post('/upload', (req, res) => {
  const bb = busboy({ headers: req.headers });
  bb.on('file', (fieldname, file, filename, encoding, mimetype) => {
    const pass = new require('stream').PassThrough();
    s3.upload({ Bucket: 'my-bucket', Key: filename, Body: pass })
      .promise()
      .then(() => res.end('ok'))
      .catch(err => { console.error(err); res.status(500).end(); });
    file.pipe(pass); // 디스크를 거치지 않고 스트리밍
  });
  req.pipe(bb);
});
```
장점: 서버 디스크 사용 최소화. 단점: 네트워크 대역폭/메모리 영향은 고려해야 함.

설계/운영 선택 기준 비교
| 방법 | 디스크 사용 | 네트워크 비용 | 구현 난이도 | 적합 상황 |
|---|---:|---:|---:|---|
| 서버 임시 저장→처리 | 높음 | 중 | 쉬움 | 소파일·낮은 동시성 |
| 스트리밍 서버 처리 | 낮음 | 높음(서버→S3) | 중 | 중간 동시성 |
| 클라이언트→S3 직접(Pre-signed) | 거의 없음 | 높음(클라이언트→S3) | 쉬움 | 높은 동시성, 대형 파일 |
| tmpfs(임시 완화) | 메모리 사용 | - | 쉬움 | 긴급 완화, 작은 트래픽 |

(표는 선택 기준별 참고용이고, 실제 환경 메모리/네트워크 제약을 꼭 확인해야 합니다.)

운영에서 시급 대응 단계 (우선순위)
1. 서비스 로그에서 ENOSPC/IO 관련 메시지 확인
2. df -h / df -i로 전체 상태 확인
3. sudo lsof +L1 로 삭제됐지만 여전히 열린 파일 확인 → 프로세스 재시작으로 공간 해제
4. 오래된 임시파일 삭제: sudo find /tmp -type f -mtime +1 -delete (주의: 영향 범위 확인)
5. 임시 완화: mount -t tmpfs -o size=2G tmpfs /tmp (임시, 메모리 사용 주의)
6. 트래픽 제어: 일시적 rate limit 또는 최대 업로드 동시수 제한
7. 장기: 스트리밍/직접 업로드 설계 적용

로그/오류 분석에서 볼 포인트
- 오류 문자열: ENOSPC, no space left on device, write: no space
- lsof 출력의 Deleted 파일 라인: 파일이 삭제됐지만 프로세스가 열고 있으면 공간 안 풀림
- inode 부족: df -i 결과에서 100% 근접
- Docker 레이어 누수: docker system df, /var/lib/docker/overlay2 디렉터리 크기 확인

공부하면서 적용한 체크 명령(예시)
- df -h
- df -i
- sudo du -sh /var/lib/docker/overlay2
- sudo lsof +L1
- ps aux --sort=-rss | head -n 5
- seq 1 100 | xargs -n1 -P10 -I{} curl -F "file=@10MB.bin" http://localhost:3000/upload

이미지 예시 (개념 일러스트)
![임시 파일이 쌓여 있는 서버의 개념도](/assets/img/posts/blog/backend-concurrent-uploads-temp-disk-control/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 실무 팁
- tmpfs를 임시 완화로 쓰면 빠르게 해결되는 경우가 있지만, 메모리 여유를 항상 확인해야 합니다. tmpfs 크기 지정은 반드시 해두세요.
  - 예: sudo mount -t tmpfs -o size=2G tmpfs /tmp
- 컨테이너 환경에서는 호스트의 /var/lib/docker 사용량을 확인하세요. 컨테이너가 삭제돼도 호스트 레이어에 파일이 남는 경우가 있습니다.
- 업로드 처리 라이브러리의 기본 설정(예: multer의 dest, busboy의 높은 수치 버퍼)은 문서로 확인하고 기본값을 신뢰하지 마세요.

이미지 예시 (솔루션 비교)
![임시 파일 전략과 직접 업로드 비교 일러스트](/assets/img/posts/blog/backend-concurrent-uploads-temp-disk-control/image-2.webp)
이미지 출처: AI 생성 이미지

## 자주 묻는 질문 / Q&A

Q1. ENOSPC가 뜨는데 어떤 순서로 확인해야 하나요?
- 1) df -h, df -i로 용량/인오드 확인 2) sudo lsof +L1로 삭제됐지만 열린 파일 확인 3) du로 큰 디렉터리 확인(/tmp, /var/lib/docker) 4) 프로세스 재시작 또는 파일 삭제

Q2. tmpfs로 임시 폴더 올렸는데 메모리 부족 우려는?
- tmpfs는 물리 메모리를 사용하므로 서버 메모리(total) 대비 mount size를 작게 설정하세요. 예: size=1G. 메모리 스왑 정책과 OOM 관련 로그(journalctl -k)를 같이 확인해야 합니다.

Q3. 클라이언트→S3 직접 업로드는 어떻게 검증하나?
- 사전 서명 발급 후 curl/브라우저로 업로드 테스트를 반복, S3 콘솔에서 객체 수/크기 확인, 네트워크 대역폭 모니터링(iftop, nload).

Q4. 컨테이너에서 파일이 사라졌는데 용량이 그대로 남는 이유?
- 삭제된 파일을 프로세스가 열고 있으면 공간이 해제되지 않습니다. lsof +L1로 PID를 찾아 재시작하세요.

Q5. 어떤 경우에 스트리밍보다 Pre-signed URL이 좋은가요?
- 대형 파일(수백 MB 이상), 높은 동시성, 서버 리소스를 아끼고 싶을 때 Pre-signed가 유리합니다. 서버가 인증·메타데이터 처리만 담당하면 됩니다.

## 나의 의견 1
여기에 당신의 환경(예: OS, 커널 버전, Node/Docker 버전, S3 버킷 설정 등)과 처음 문제를 재현하던 때의 구체 숫자(동시 업로드 수, 파일 크기)를 적어 보세요.

## 나의 의견 2
여기에 문제 해결을 위해 시도한 첫 번째 명령과 그 결과(예: df -h 출력, lsof 결과 일부, 오류 로그 한 줄)를 기록해 보세요.

실무 체크리스트 (바로 따라할 수 있도록)
- [ ] df -h, df -i로 전체 상태 확인
- [ ] sudo lsof +L1로 삭제됐지만 열린 파일 확인
- [ ] sudo du -sh /tmp /var/lib/docker/overlay2 확인
- [ ] 오래된 임시파일 삭제(삭제 전 영향 범위/백업 검토)
  - sudo find /tmp -type f -mtime +1 -delete
- [ ] 임시 완화 필요 시 tmpfs 마운트(메모리 한도 설정)
  - sudo mount -t tmpfs -o size=2G tmpfs /tmp
- [ ] 업로드 처리 코드 검토: diskStorage 사용 여부, 스트리밍으로 전환 가능성 확인
- [ ] 장기 대책: Pre-signed URL, S3 Multipart, 클라이언트-side 재시도/요율제어 설계
- [ ] 재현 테스트: dd로 파일 만들기, xargs+cURL로 동시 업로드 시뮬레이션
- [ ] 관련 문서 참조
  - Linux tmpfs: https://www.kernel.org/doc/html/latest/filesystems/tmpfs.html
  - AWS S3 Multipart Upload: https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
  - Node.js Streams: https://nodejs.org/api/stream.html
  - Docker storage: https://docs.docker.com/storage/

마무리(실무에서 먼저 확인할 항목)
- 먼저 확인할 것: df/df -i → lsof +L1 → du로 큰 디렉터리 확인.
- 언제 다른 선택지가 나은가: 동시성이 낮고 파일이 작으면 서버 임시 저장이 편하지만, 동시성이 높고 대용량이면 **Pre-signed direct upload**나 **스트리밍**을 우선적으로 고려하는 편이 실무에서 더 안전할 가능성이 큽니다.

필요하면 제가 사용한 테스트 스크립트(동시 업로드용 xargs + curl), Node.js 실패/수정 예시 파일을 더 정리해서 올릴게요.