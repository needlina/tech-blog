---
title: "Canary DB 쓰기(dual-write) 패턴: 점진 검증과 안전한 롤백 템플릿"
description: "대규모 서비스에서 DB 스키마·데이터 변경시 dual-write(카나리 쓰기) 적용 전제조건, 아키텍처, 구현 예시(코드·명령어), 실패 증상별 원인·조치, 검증·롤백용 명령과 확인 경로 정리"
slug: "canary-database-dualwrite-verification-rollback"
date: 2026-08-03 10:00:00 +0900
categories: ["Database", "DevOps"]
tags: ["dual-write", "canary-deployment", "database", "장애대응", "배포자동화"]
image:
  path: /assets/img/posts/blog/canary-database-dualwrite-verification-rollback/preview.png
  alt: "Canary DB 쓰기 썸네일"
---

Canary DB 쓰기(dual-write)는 일부 트래픽에만 새 DB 스키마 또는 새 테이블로 동시에 쓰기를 보내고, **일관성·성능·롤백 경로**를 검증한 뒤 전체 롤아웃하거나 빠르게 되돌리는 패턴입니다. 맑은 날씨에 약간의 피곤함이 섞인 기분으로 핵심 포인트와 실무 확인 경로를 정리합니다.

## 어떤 상황에서 고려하나 — 실무적 문제 정의
로컬이나 스테이징에서는 문제가 없는데 실제 트래픽에서만 새 스키마 관련 에러(예: FK 제약 위반, 인덱스 부하, 타임아웃)가 발생할 때가 있습니다. 또는 데이터 마이그레이션 중 일괄 변경을 하기가 위험할 때가 있고, 그럴 때 **일부 트래픽에만 새 흐름을 적용해 검증**하는 것이 유용합니다.

주요 리스크:
- 쓰기 불일치(dual-write 실패 → 데이터 손실/중복)
- 성능 저하(새 인덱스·쿼리로 인해 p99 지연 상승)
- 롤백 복잡도(부분 적용 상태에서의 복구)

다음에서는 아키텍처, 구현 예시, 실패 증상별 원인·조치, 검증/롤백 명령을 구체적으로 제시합니다.

## 아키텍처 개요(간단)
- 트래픽 라우팅: 1~5%의 요청을 canary 서비스로 라우팅(로드밸런서/서비스 메시에서 제어)
- Dual-write 방식: 기존 DB(Primary)와 새로운 대상(DB 또는 새 테이블)에 동시에 쓰기
- 판별자(idempotency key, request id)를 통해 동기/비동기 일치 확인
- 관측: 쓰기 성공/실패 카운트, 레이턴시, 최종 데이터 일치성(조사용 비교 쿼리)

이미지:  
![간단한 카나리 쓰기 아키텍처 다이어그램](/assets/img/posts/blog/canary-database-dualwrite-verification-rollback/image-1.webp)
이미지 출처: AI 생성 이미지

## 구현 패턴과 예시 코드
패턴별로 장단점은 아래 표로 간략 비교합니다.

| 패턴 | 장점 | 주의점 |
|---:|---|---|
| 동기 dual-write | 즉시 실패 인지 가능 | 한쪽 실패 시 전체 요청 실패 처리 필요 |
| 비동기 dual-write (큐) | 사용자 지연 최소화 | 큐 누락/중복 처리·모니터링 필요 |
| shadow write (비저장 리드) | 안전성 높음(읽기만 비교) | 쓰기 검증 불가 |

다음은 간단한 실패 예시와 수정 예시(Node.js 의사 코드). 실패 예시는 에러 핸들링이 약해 한쪽 DB 실패를 무시하는 경우입니다.

- 실패 예시 (비추천: 한쪽 실패 무시)
```javascript
// 실패 예시: 한쪽 실패를 로그만 남기고 끝냄
await primaryDb.insert(item);
secondaryDb.insert(item).catch(err => console.error('canary write failed', err));
return { status: 200 };
```

- 수정 예시(권장: idempotent, 모니터링 포함, 실패 시 경고/리트라이)
```javascript
// 권장 예시: 트랜잭션과 리트라이(의사 코드)
const tx = await primaryDb.beginTransaction();
try {
  await tx.insert(item);
  await ensureCanaryWrite(item); // 재시도 로직 포함
  await tx.commit();
  return { status: 200 };
} catch (err) {
  await tx.rollback();
  await alert('dual-write-failure', { id: item.id, err: err.message });
  throw err; // 클라이언트 또는 호출자 레벨에서 처리
}
```

ensureCanaryWrite에서 re-try 3회, 지수 백오프, dead-letter 큐로 보낼지 판단하는 로직을 둡니다.

## 검증용 명령어·확인 경로(구체적)
환경 예시: PostgreSQL 13, psql 13.4 사용 가정.

- 동등성 검사(간단 카운트)
  - primary: psql -c "SELECT count(*) FROM public.orders WHERE created_at >= '2026-08-01';"
  - canary: psql -h canary-host -c "SELECT count(*) FROM new_orders WHERE created_at >= '2026-08-01';"
  - 기대치: 차이 비율 < 0.1% (서비스별 판단 필요)

- ID 별 불일치 조회(상세)
```sql
-- primary에만 있고 canary에 없는 id 찾기
SELECT p.id
FROM primary.orders p
LEFT JOIN canary.new_orders c ON p.id = c.id
WHERE c.id IS NULL
LIMIT 100;
```

- 쓰기 레이턴시 및 오류 비율 측정
  - 애플리케이션: Prometheus metric `app_write_latency_seconds`, `app_write_errors_total`
  - Grafana: canary 라벨로 p95/p99 비교(예: p95 기존 120ms, canary 180ms → 재검토)

- 재현 테스트(부하)
  - 샘플 스크립트: curl을 통해 2000 req/s를 60초간 전송(작업환경에서만)
```bash
# 간단한 부하 예시 (wrk 사용)
wrk -t12 -c100 -d60s -s post.lua http://canary-service/api/orders
```
post.lua는 POST body 생성 스크립트 필요.

공식 문서·참조:
- PostgreSQL WAL/replication: https://www.postgresql.org/docs/current/wal.html
- 트랜잭션 격리·일관성: https://www.postgresql.org/docs/current/transaction-iso.html

## 실패 증상별 원인·조치 판단표
아래 표는 실무에서 빠르게 원인 추적과 조치를 결정하는 데 도움될 짧은 체크리스트 형식입니다.

| 증상 | 가능한 원인 | 우선 조치 |
|---|---|---|
| canary 쓰기 실패 증가 | 네트워크, DB 연결 제한, 권한 | DB 연결 로그, pg_stat_activity 확인, 에러 메시지 캡처 |
| 쓰기 불일치(간헐적) | 비동기 큐 누락, idempotency 없음 | dead-letter 큐 확인, 요청 id 비교 쿼리 실행 |
| p99 레이턴시 상승 | 새 인덱스 빌드, 쿼리 플랜 변경 | EXPLAIN ANALYZE 실행, 인덱스 스캔/시퀀스 확인 |
| 롤백 후 일부만 복원됨 | 부분 적용, 청소 스크립트 부재 | 차이 레코드 추출 후 역직렬화/백필 스크립트 실행 |

## 롤백 절차(명령·검증 포함)
1. 트래픽 차단: 로드밸런서나 서비스메시에서 canary 비율을 0%로 설정
   - 예: Istio 사용 시 VirtualService 수정하여 가중치 변경
2. 큐 처리 중지 또는 dead-letter 점검: 큐(예: RabbitMQ) 소비자 일시 정지
   - rabbitmqctl list_queues name messages_ready messages_unacknowledged
3. 데이터 정합성 확인: 위의 ID 불일치 쿼리로 남은 레코드 확인(샘플 100건)
4. 복구 스크립트 적용(예시)
```bash
# 차이 id 파일로 백필
psql -h primary -At -c "COPY (SELECT id FROM primary.orders EXCEPT SELECT id FROM canary.new_orders) TO STDOUT" > missing_ids.txt
# 백필 루프(간단)
while read id; do
  node backfill.js $id || echo "$id" >> failed_ids.txt
done < missing_ids.txt
```
5. 검증: count 비교, 샘플 레코드 대조, 모니터링 지표 정상화(오류 감소·레이턴시 회복)

## 모니터링·알림 항목(구체적 메트릭)
- 쓰기 성공률: app_write_success_total / app_write_total → canary 태그 별로 분리
- 최종 일관성 비율: (matched_rows / expected_rows) * 100
- 큐 길이 및 DLQ 증가율
- DB connection errors: postgres.errors_total
- EXPLAIN 계획 변경 감지(정기 스냅샷 비교)

이미지:  
![검증용 쿼리 실행과 모니터링 점검 흐름](/assets/img/posts/blog/canary-database-dualwrite-verification-rollback/image-2.webp)
이미지 출처: AI 생성 이미지

## 실패 예시를 통한 디버깅 흐름(실무 체크 포인트)
- 에러 로그 수집: app 로그, DB 로그(postgres log), 큐 로그를 타임스탬프 기준으로 대조
- 재현 테스트: 동일 트래픽 볼륨을 staging에서 반복(버전: pg13, app node 16, 테스트 툴 wrk)
- 원인 분리: 네트워크/DB/앱 중 어느 계층인지 좁히기(예: psql로 직접 쓰기 시 문제 발생하면 DB쪽)
- 임시 완화: canary 트래픽 비중 축소 → 메트릭 회복 시 점진적으로 재시도

## 언제 다른 전략이 나을까
- 데이터 모델 변경이 간단하고 전체 롤아웃 위험이 작다면 전통적 blue-green이나 online migration(비파괴적 스키마 변경)을 택하는 편이 관리가 쉽습니다.
- 높은 일관성이 필수(금융 등)라면 dual-write는 **추가 검증과 감사 로그** 없이는 위험할 수 있습니다.

마무리로, 이 주제에서 먼저 확인해야 할 것은 **(1) idempotency/식별자 설계 여부, (2) 관측 가능한 메트릭과 즉시 알림 경로, (3) 롤백용 데이터 백필·스크립트 준비** 세 가지입니다. 그리고 dual-write가 아닌 대안(online migration, shadow write, feature-flagged schema change)이 더 적합한 시점은 데이터 일관성 요구 수준과 운영·모니터링 준비 상태를 비교해 결정하면 됩니다.

참고로 실제 적용 전에는 반드시 스테이징에서 쓰기 실패 시의 에러 메시지(예: "duplicate key value violates unique constraint", "could not connect to server: Connection timed out")를 재현하고, psql 명령으로 count 비교와 ID 불일치를 검증해 보시길 권합니다.

## 나의 의견 1

> 여기에 이 주제와 관련된 실제 경험, 확인 과정, 시행착오를 직접 적어주세요.

## 나의 의견 2

> 여기에 추가로 느낀 점, 선택 이유, 주의할 점을 직접 적어주세요.

## 함께 보면 좋은 글

- [Event-driven 아키텍처에서 스키마 변경을 무중단 적용하는 전략 Top 6](/posts/event-driven-schema-change-zero-downtime-top6/)
- [도커를 휴대용 실행 환경으로 쓰는 법: Dockerfile, Compose, Volume을 한 세트로 보기](/posts/docker-portable-runtime-dockerfile-compose-volume/)
- [폐쇄망 GitLab CI/CD에서 Node.js 빌드하기: npm install 없이 Docker 이미지로 해결한 방법](/posts/gitlab-cicd-closed-network-node-docker-npm-cache/)
