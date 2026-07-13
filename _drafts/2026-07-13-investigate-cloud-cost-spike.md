---
title: "클라우드 비용 급증 원인 분석 가이드: 초보자가 먼저 확인할 포인트"
slug: "investigate-cloud-cost-spike"
date: 2026-07-13 10:00:00 +0900
categories: [Cloud, DevOps]
tags: [cloud-costs, cost-management, billing, monitoring, infra]
image:
  path: /assets/img/posts/blog/investigate-cloud-cost-spike/image-1.webp
  alt: "클라우드 비용 증감 원인을 검토하는 흐름도 일러스트"
---

오늘의 주제

클라우드 비용이 갑자기 늘었을 때 먼저 확인할 항목들

도입부 — 왜 이 글을 썼나
제가 클라우드 비용 관련해서 갑작스런 청구서 폭등을 몇 번 겪으면서, 초기에 어떤 순서로 무엇을 확인해야 하는지 정리해두면 도움이 되겠다 싶어 글로 남깁니다. 처음엔 어디서부터 손을 대야 할지 막막했는데, 여러 자료와 실무 경험을 통해 비교적 빠르게 원인을 좁히는 흐름을 만들 수 있었습니다. 아래 내용은 제 학습과 실전에서 배운 점을 바탕으로 한 체크리스트와 절차입니다. 환경마다 상황이 다를 수 있으니 절대적인 정답으로 보지 말고, '먼저 이걸 확인해보면 도움이 될 것 같다'는 관점으로 읽어주시면 좋겠습니다.

![클라우드 비용 증감 원인을 검토하는 흐름도 일러스트](/assets/img/posts/blog/investigate-cloud-cost-spike/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점
- 비용 급증은 보통 '사용량 증가', '설정 변경', '비용 정책(요금제/리전/인터넷 egress 등) 변화', '비정상/실수(무한 루프, 백업 남발 등)' 중 하나 또는 복합 원인인 경우가 많았습니다.
- 각 클라우드(AWS/GCP/Azure)는 비용을 보여주는 콘솔은 제공하지만, 실제 원인 파악을 위해선 리소스 태깅, 모니터링(metric), 로그, 그리고 비용 내역(usage/billing)을 함께 보는 것이 필요하다는 점도 체감했습니다.
- 비용은 즉시 반영되지 않는 항목이 있어(예: 예약 인스턴스 정산, 청구 주기 등) '지금의 비용'과 '바로 떨어지는 사용량 차이'를 구분해야 한다는 것도 배웠습니다.

처음에는 헷갈렸던 부분
- 태그와 라벨이 제대로 되어 있지 않으면 비용을 프로젝트/서비스별로 할당하기 어렵습니다. 초기엔 태그로 비용이 보인다고 생각했는데, 콘솔마다 필터 동작이 조금씩 달라서 헷갈렸습니다.
- 어느 리소스가 네트워크 egress를 만들어내는지 찾는 게 생각보다 까다로웠습니다. 예를 들어 S3 → 인터넷 전송, 데이터베이스 백업 복사본 전송 등은 한눈에 보이지 않을 때가 있었습니다.
- 가끔 예측 가능한 요금(예: 스팟인스턴스 종료로 인한 자동 재시작 반복)이 아닌, 한 번의 실수(스크립트 무한 루프)가 큰 비용으로 이어지는 경우가 있어 '경보'와 '자동차단' 전략의 필요성을 느꼈습니다.

먼저 빠르게 원인 범위를 좁히는 흐름 (초기 30~60분)
1) 청구서/콘솔의 기간 기준과 실제 발생 시간 확인
- 콘솔에서 비용이 늘어난 기간(예: 지난 24시간 / 이번달 / 특정 날짜 범위)을 정확히 설정
2) 어느 카테고리에서 늘었는지 확인 (Compute, Storage, Network, Database, Marketplace 등)
3) 계정/프로젝트/구독 단위로 범위 좁히기 (계정 분리된 멀티계정이면 어느 계정인지)
4) 태그/라벨로 서비스 단위 필터링 (태그가 없다면 리소스 타입과 리전으로 우선 필터)
5) 해당 기간에 배포/자동화 스크립트 변경, 백업 작업, 데이터 전송 작업이 있었는지 확인

콘솔/CLI로 빠르게 확인하는 명령 예시
- AWS(예시)
  - 비용 요약(기간 설정): aws ce get-cost-and-usage --time-period Start=2026-07-01,End=2026-07-13 --granularity DAILY --metrics "UnblendedCost"
  - 특정 서비스 비용 필터 예시(filter.json는 로컬 파일):
    ```
    aws ce get-cost-and-usage \
      --time-period Start=2026-07-01,End=2026-07-13 \
      --granularity DAILY \
      --filter file://filter.json \
      --metrics "UsageQuantity" "UnblendedCost"
    ```
    filter.json 예시:
    ```
    {
      "Dimensions": {
        "Key": "SERVICE",
        "Values": ["Amazon S3"]
      }
    }
    ```
- GCP(예시)
  - BigQuery 기반 비용 리포트나 Billing export된 데이터 탐색을 권합니다. gcloud 명령이나 BigQuery 쿼리로 확인.
- Azure(예시)
  - az consumption usage list --start-date 2026-07-01 --end-date 2026-07-13

공부하면서 사용해본 체크 명령들 (인프라 점검)
- Kubernetes: 노드/파드/오토스케일 상태 확인
  ```
  kubectl get nodes
  kubectl top nodes
  kubectl get hpa -A
  kubectl describe hpa <name>
  ```
- Docker / Host 프로세스 확인
  ```
  docker ps --format '{{.Names}} {{.Size}}'
  docker system df
  sudo du -sh /var/lib/docker
  ```
- 스토리지/스냅샷 확인 (AWS 예시)
  ```
  aws ec2 describe-snapshots --owner-ids self --query 'Snapshots[?StartTime>=`2026-07-01`]'
  aws s3api list-objects-v2 --bucket my-bucket --prefix backup/
  ```
- 네트워크 egress 추적: Cloud provider 콘솔의 네트워크 전송량(혹은 VPC Flow Logs)을 확인

중간 설명 — 흔한 원인별로 무엇을 볼지 (섹션별)
1) 컴퓨트(CPU/인스턴스) 비용 증가
- 확인 포인트
  - Auto Scaling/Cluster Autoscaler의 최근 활동 여부
  - 스팟 인스턴스 반복 재시작(재시작될 때 요금이 따로 나가는 경우 확인)
  - 예약 인스턴스/세이빙플랜 적용 여부(청구가 지연되거나 정산 차이가 있을 수 있음)
- 실무 팁
  - kubectl top, cloud provider의 인스턴스 활동 로그, CloudWatch/Stackdriver 지표를 함께 보세요.

2) 스토리지/스냅샷/백업
- 확인 포인트
  - 스냅샷 생성 빈도와 보존 정책
  - Glacier/Archive 이동 실패로 인한 표준 스토리지 사용량
  - S3/Lifecycle 정책 유무
- 예시 명령 (EBS 스냅샷)
  ```
  aws ec2 describe-snapshots --owner-ids self --query 'Snapshots[].[SnapshotId,StartTime,VolumeSize]'
  ```
- 실무 팁
  - 스냅샷은 사이즈가 생각보다 클 수 있으니 생성 주기·보존 정책을 먼저 확인하면 빠르게 원인을 좁힙니다.

3) 네트워크 데이터 전송(egress)
- 확인 포인트
  - 리전 간 복제, 외부로 나가는 대량 로그/미디어 전송, CDN 잘못된 캐시 설정
  - Kubernetes에서 대량 파일 전송 작업 또는 외부 API 호출 루프
- 실무 확인 절차
  - VPC Flow Logs, S3 Transfer Acceleration 사용 여부, Cloud CDN/CloudFront 로그 확인
  - 예: S3에서 대량 다운로드가 있었는지 확인 -> aws s3api list-objects-v2 / CloudFront 로그

4) 서비스/서드파티(마켓플레이스) 비용
- 확인 포인트
  - 마켓플레이스 솔루션이나 SaaS 연동으로 발생한 비용인지
  - 신규 결제 항목(예: 콘솔에서 결제 동의한 서비스) 여부
- 실무 팁
  - 청구서의 line-item을 자세히 보시면 어떤 항목인지 나옵니다. 초보자라면 line-item 검색부터 추천합니다.

관찰 가능성(Observability)과 비용 연관
- 비용 조사를 쉽게 하려면 미리 준비해두는 것이 좋습니다.
  - 비용용 태그/라벨 표준화 (env, team, project, owner 등)
  - Billing export: 빌링 정보를 BigQuery/S3로 내보내서 쿼리 가능하도록 설정
  - 비용 관련 메트릭을 Prometheus/Grafana로 수집(예: 인스턴스 수, 스토리지 사용량, 네트워크 전송량)
- 실무에서는 이렇게 확인하면 좋겠다
  - 비용 알림(budgets)과 함께 사용량 기반 경보를 설정해두면 빠르게 이상 징후를 잡을 수 있습니다.
  - 비용 익스플로러와 모니터링 대시보드를 연결해 두면 원인 탐색이 수월합니다.

작은 예: AWS Cost Explorer에서 S3 비용이 늘었다고 나올 때 해볼 것
1) 콘솔에서 S3 서비스 필터로 기간 지정
2) Bucket별 비용(태그 기반) 확인
3) S3 접근 로그/CloudTrail에서 대량 GET/PUT 이벤트 검색
4) VPC Flow Logs나 CloudFront 로그에서 외부 다운로드 흔적 확인
간단한 쿼리 예시(CloudTrail 이벤트 확인)
```
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetObject --start-time 2026-07-01 --end-time 2026-07-13
```

주의해야 할 점들 (제가 실수로 배운 것)
- 태그가 일관되지 않으면 비용 할당이 제대로 되지 않아 조사 시간이 길어집니다. 초기에 태그 정책을 세우는 게 귀찮아도 나중에 절약됩니다.
- 예약/선결제 항목은 청구서에서 비용이 갑자기 줄어들거나 늘어나는 것처럼 보일 수 있으니, 사용량과 청구의 시간차를 염두에 둬야 합니다.
- 비용 알림을 설정했더라도 알림 수신 설정(누가 받을지, Escalation)이 안 되어 있으면 놓치기 쉽습니다.

실무에서 바로 확인하면 좋은 포인트(요약)
- 기간/계정/리전/서비스로 빠르게 범위 좁히기
- 비용 라인 아이템(line-item) 확인 → 어느 서비스에서 온 비용인지 파악
- 최근 배포/자동화/백업/데이터 이동 작업 여부 점검 (CD/CI 로그, 백업 스케줄)
- 오토스케일링/노드 증설 로그 확인 (Kubernetes 이벤트, 클라우드 인스턴스 이벤트)
- 스냅샷/이미지/로그 보존 정책 확인
- 네트워크 egress 관련 로그 확인 (VPC Flow Logs, CloudFront/ELB 로그)
- 태깅/라벨 기준 점검 및 빌링 export 사용 권장

두 번째 심화 이미지 (중간 설명 섹션 이후)

![비용 조사 체크리스트와 커맨드 목록을 보여주는 단순한 일러스트](/assets/img/posts/blog/investigate-cloud-cost-spike/image-2.webp)
이미지 출처: AI 생성 이미지

마무리 — 제가 정리한 실무용 체크리스트(간단 명료)
- 비용 증가 감지 시 초판 작업(30분)
  - 기간과 계정 범위 지정
  - 비용 카테고리(Compute/Storage/Network 등) 확인
  - line-item 또는 billing export에서 상위 항목 확인
- 인프라 확인(30~90분)
  - 최근 배포/스케줄/스크립트 변경 로그 확인
  - 오토스케일/클러스터 이벤트 확인
  - 스냅샷/백업/로그 보존 정책 확인
  - 네트워크 전송량(egress) 로그 확인
- 조치 및 예방(다음 단계)
  - 일시적 차단(예: 오래된 S3 퍼블릭 액세스 차단, 예기치 않은 백업 스케줄 중지)
  - 비용 경보/예산 알림 설정 및 수신자 지정
  - 태그/라벨 정책 정비 및 빌링 export 활성화
  - 비용 최적화(리저브/스팟/세이빙 플랜, 라이프사이클 정책 적용)

실무 체크리스트
- [ ] 비용 급증 기간과 영향을 받는 계정/프로젝트/리전 확정
- [ ] 비용 카테고리(Compute/Storage/Network/Database/Marketplace) 확인
- [ ] billing line-item 또는 export 데이터에서 상위 10개 항목 파악
- [ ] 최근 배포/스크립트/백업 작업 로그 확인 (CI/CD, cron, airflow 등)
- [ ] 오토스케일/컨테이너 오케스트레이터 이벤트 확인 (kubectl describe, cloud provider events)
- [ ] 스냅샷/이미지/로그의 보존 정책 점검 및 불필요한 오래된 리소스 삭제
- [ ] 네트워크 egress 로그(VPC Flow Logs, CDN 로그)에서 대량 전송 확인
- [ ] 태그/라벨 정책 개선 및 billing export 설정
- [ ] 예산/알림(Budgets)과 자동화(예: cost anomaly detection) 설정

마지막으로
이 글은 제가 공부하면서 정리한 체크 흐름과 실무에서 유용했던 팁을 모은 초안입니다. 환경마다 세부 절차나 명령어는 달라질 수 있으니, 본문을 참고해 자신의 환경에 맞게 체크리스트를 맞춰보시면 좋겠습니다. 혹시 사용하시는 클라우드가 특정(예: AWS/GCP/Azure)이라면 그에 맞춘 더 구체적 명령어와 실사례를 정리해보겠습니다.