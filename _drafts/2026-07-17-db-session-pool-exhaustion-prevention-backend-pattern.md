---
title: "대량 동시 요청에서 DB 세션 풀 고갈 방지 패턴과 실무 점검"
description: "대량 동시 요청 환경에서 DB 세션 풀 고갈 원인 분석, 풀 설정·연결 누수 점검, 큐잉·프록시·캐싱 대안 비교, 점검 명령과 모니터링 포인트 정리"
slug: "db-session-pool-exhaustion-prevention-backend-pattern"
date: 2026-07-17 10:00:00 +0900
categories: ["Backend", "Database"]
tags: ["postgresql", "connection-pooling", "connection-pool", "성능튜닝", "연결관리"]
image:
  path: /assets/img/posts/blog/db-session-pool-exhaustion-prevention-backend-pattern/preview.png
  alt: "DB 세션 풀 고갈 방지 썸네일"
---

대량 동시 요청에서 DB 세션 풀 고갈을 막으려면 **애플리케이션 풀 크기와 DB 최대 연결(max_connections) 한계**, 그리고 요청 급증 시의 **큐잉 또는 백프레셔(요청 제한)**을 같이 설계해야 한다. 실무에서는 풀 사용 통계, DB의 현재 연결 수, OS 파일 디스크립터 한계, 그리고 애플리케이션의 예외 로그(타임아웃/커넥션 누수 지표)를 우선적으로 확인하면 문제 원인 파악이 빠릅니다.

제가 최근에 이 주제를 공부하면서 정리한 내용을 차근차근 풀어볼게요. 혼자 실험해본 예시와 실무에서 바로 확인할 수 있는 커맨드/설정도 포함했습니다.

왜 이런 문제가 생기나
- 애플리케이션마다 설정한 커넥션 풀 크기(예: 50) × 인스턴스 수(예: 10) = 동시 연결 가능 수가 DB의 max_connections(예: 1000)를 초과할 수 있습니다.  
- 트랜잭션이 길어지거나, 커넥션 반환 코드가 빠져서 커넥션 누수(connection leak)가 발생하면 풀의 사용 가능한 연결이 줄어듭니다.  
- 갑작스러운 트래픽 스파이크가 오면 애플리케이션이 DB로 동시 요청을 폭주시키며 대기열 없이 연결을 시도해 실패(타임아웃, 커넥션 거부)가 발생합니다.

공부하면서 알게 된 점
- **풀 크기만 키우는 건 임시방편**일 때가 많았습니다. DB 자체의 처리 한계나 OS 리소스(파일 디스크립터, 네트워크 소켓) 때문에 더 큰 풀도 소용없을 수 있습니다.
- HikariCP 같은 풀은 **leak detection** 같은 기능을 제공해서 누수 징후를 빨리 잡아낼 수 있었습니다. 측정 가능한 지표가 없으면 문제 원인 찾기가 매우 어렵습니다.
- 애플리케이션 레이어에서 백프레셔(요청 수 제한)나 큐잉을 넣으면, DB 장애 시 전체 시스템이 치명적으로 무너지는 걸 어느 정도 막을 수 있었습니다.

처음에는 헷갈렸던 부분
- "풀 크기는 어떻게 정하나?"가 가장 막막했는데, 보통은 DB의 max_connections에서 운영중인 다른 클라이언트(관리 툴, 백업, 리플리케이션 등)를 빼고 남은 수를 기준으로 애플리케이션 인스턴스 수로 나누는 방식이었습니다.
- 또, 애플리케이션 단의 pool max와 DB max 간의 관계에서 네트워크 지연/쿼리 지연을 고려하지 않아 실제로는 더 작은 값이 유리하다는 것을 깨달았습니다.

실무에서는 이렇게 확인하면 좋겠다 (빠른 체크리스트)
1. DB 현재 연결 확인 (PostgreSQL 예시)
```sql
-- 총 연결 수 확인
SELECT count(*) FROM pg_stat_activity;

-- 데이터베이스별 연결 수
SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname;

-- 비정상(active가 아닌데 오래 차지하는) 세션 확인
SELECT pid, usename, state, query_start, state_change, query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY query_start DESC;
```
2. DB의 `max_connections` 확인
```sql
SHOW max_connections;
```
3. 애플리케이션 풀 지표 확인 (예: HikariCP 로그/metrics)
- activeConnections, idleConnections, totalConnections, threadsAwaitingConnection
- leak-detection 로그 존재 여부

4. OS 한계 확인
```bash
# 현재 프로세스의 열린 파일 수 제한
ulimit -n

# 시스템 전체 파일 디스크립터 한계
sysctl fs.file-max
```

코드 예시 — Spring Boot + HikariCP 설정
```properties
spring.datasource.hikari.maximum-pool-size=50
spring.datasource.hikari.minimum-idle=5
spring.datasource.hikari.connection-timeout=30000
spring.datasource.hikari.idle-timeout=600000
spring.datasource.hikari.leak-detection-threshold=2000
```

코드 예시 — Node.js (pg) 간단한 풀 사용
```js
const { Pool } = require('pg');
const pool = new Pool({
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}
```

이미지 삽입 (구성 이해를 돕기 위한 일러스트)
![커넥션 풀 구조 일러스트](/assets/img/posts/blog/db-session-pool-exhaustion-prevention-backend-pattern/image-1.webp)
이미지 출처: AI 생성 이미지

이미지 출처: AI 생성 이미지

대안 패턴 비교
아래 표는 제가 공부하면서 비교해본 여러 접근 방식입니다. 각 패턴의 핵심 장단점과 **권장 시점**을 간단히 적었습니다.

| 패턴 | 장점 | 단점 | 권장 시점 |
|---|---:|---|---|
| 애플리케이션 풀 | 간단, 앱 내에서 제어 | 인스턴스 곱으로 커넥션 폭증 가능 | 소규모 또는 단일 인스턴스 |
| pgbouncer (pooler) | DB 앞에서 연결 재사용, 경량 | 트랜잭션 패턴 제약 가능 | 다수 인스턴스 + 짧은 트랜잭션 |
| 요청 큐잉 / 백프레셔 | DB 부담 제어, 안정성 | 대기 지연 증가 | 트래픽 급증 대비 |
| 캐싱 (Redis) | 읽기 부하 감소 | 캐시 일관성 문제 | 읽기 중심 트래픽 |
| 읽기 전용 리플리카 | 읽기 확장 | 복제 지연, 쓰기 불가 | 읽기 비중이 큰 서비스 |

주의: 표는 일반적 비교이며 **환경(쿼리 특성, 트래픽 패턴)에 따라 달라질 수 있습니다.**

이미지 삽입 (요청 흐름 예시)
![요청 큐와 DB 연결 흐름 일러스트](/assets/img/posts/blog/db-session-pool-exhaustion-prevention-backend-pattern/image-2.webp)
이미지 출처: AI 생성 이미지

이미지 출처: AI 생성 이미지

실무에서 자주 놓치는 포인트
- 애플리케이션 로그에서 ConnectionTimeoutException 또는 "could not connect" 계열 메시지를 빠르게 필터링해서 원인(풀 고갈 vs 네트워크 문제)을 분리하세요.
- 커넥션 누수는 보통 예외 처리 경로에서 client.release() 같은 반환 코드가 빠지면서 발생합니다. **try-finally** 패턴을 기본으로 강제하세요.
- 모니터링에 **풀 대기 스레드 수(threadsAwaitingConnection)** 지표가 있으면 스파이크 시 병목을 더 빨리 잡을 수 있습니다.
- DB의 `max_connections`를 무작정 높이면 OS 레벨의 파일 디스크립터, 메모리(프로세스당 세션 구조체) 문제를 야기할 수 있습니다. **모든 계층을 함께 고려**하세요.

점검/대응 절차 예시 (장애 발생 시)
1. 애플리케이션 로그에서 커넥션 관련 예외 확인
2. pg_stat_activity로 활발한 쿼리, 오래 걸리는 쿼리 파악
3. 풀 메트릭(활성/대기) 확인
4. 필요시 트래픽을 임시 차단하거나 인그레스 레이트 제한(예: API Gateway rate limit)
5. 애플리케이션 풀 크기·DB max 설정 검토 및 재배치
6. 재발 방지를 위해 큐잉/백프레셔를 고려하거나 pgbouncer 도입 검토

자주 묻는 질문
Q: 풀 크기를 어떻게 정해야 하나요?  
A: **DB의 max_connections ➜ 다른 클라이언트(관리/백업 등) 제외 ➜ 인스턴스 수로 나눠서 애플리케이션당 허용 가능한 범위를 정**하는 것이 일반적입니다. 여기서 쿼리 지연 시간(평균/99퍼센타일)을 고려해 응답 지연이 심하면 풀을 더 작게 잡고 큐잉을 추가하는 편이 안전할 수 있습니다.

Q: pgbouncer를 바로 도입해야 할까?  
A: pgbouncer는 접속 재사용 면에서 유리하지만, 트랜잭션 패턴(특히 세션 기반 기능이나 임시 테이블 사용)에 제약을 줄 수 있습니다. 먼저 애플리케이션 풀과 쿼리 패턴을 점검한 뒤 도입하는 게 좋습니다.

Q: 커넥션 누수를 어떻게 감지하나?  
A: HikariCP 같은 풀에서 제공하는 leak-detection 기능을 켜고, 장시간 반환되지 않는 커넥션을 로그로 남기게 하세요. 또한 `pg_stat_activity`에서 오래된 트랜잭션을 정기적으로 체크하면 의심 후보를 찾을 수 있습니다.

Q: 트래픽 스파이크를 막는 간단한 대책은?  
A: API 레이트 리미트, 리트라이(backoff) 로직, 요청 큐(예: 토큰 버킷) 적용, 그리고 응답 실패 시 빠른 실패(fail-fast) 정책을 고려하세요.

Q: max_connections을 안전하게 늘리려면?  
A: DB 서버의 메모리/파일 디스크립터 한계를 먼저 확인하고, 늘렸을 때 프로세스 메모리 영향도 추정해야 합니다. 가능하면 스테이징에서 부하 테스트로 확인하세요.

실무에서 바로 쓸 수 있는 점검 명령 모음 (요약)
```bash
# PostgreSQL 연결 현황
psql -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname;"

# max_connections 확인
psql -c "SHOW max_connections;"

# OS limits
ulimit -n
sysctl fs.file-max
```

## 나의 의견 1
여기에 본인이 실제로 적용해본 풀 크기 결정 방법, 도입한 툴(pgbouncer, HikariCP 등), 또는 실패 사례를 간단히 적어보세요.

## 나의 의견 2
여기에 실제 점검에서 유용했던 커맨드, 알림 임계값(예: 활성 연결 > 80%일 때), 또는 팀 협업 프로세스를 적어보세요.

마무리(조심스러운 정리)
- **풀 고갈은 여러 계층의 조합 문제**입니다. 하나의 값만 바꿔서는 재발 가능성이 남아있습니다.  
- 지표(애플리케이션 풀 메트릭, pg_stat_activity, OS limits)를 먼저 확보하고, **작은 실험(스테이징)**으로 설정을 검증하는 것을 권합니다.  
- 트래픽 급증에 대비한 백프레셔/큐잉과, 장기적으로는 쿼리 최적화·캐싱·리플리카 구조 검토가 필요할 것 같습니다.

실무 체크리스트
- [ ] pg_stat_activity로 현재 연결 분포 확인
- [ ] DB의 max_connections와 OS file-max 확인
- [ ] 애플리케이션 풀의 active/idle/awaiting 지표 수집 설정
- [ ] 커넥션 누수 감지(leak detection) 설정 적용
- [ ] 트래픽 스파이크 대응(레이트리밋/큐잉) 적용 여부 검토
- [ ] pgbouncer 또는 프록시 도입 적합성 검토
- [ ] 재현 가능한 부하 테스트로 설정 검증

참고로, 제가 정리한 내용은 환경과 쿼리 특성에 따라 다르게 적용될 수 있으니, 팀 환경에 맞춰서 작은 범위부터 적용해보시길 권합니다. 궁금한 부분이나 특정 사례(예: PostgreSQL, MySQL, HikariCP, pgbouncer 등)를 더 깊게 보고 싶으면 알려주세요.