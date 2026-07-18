---
title: "PostgreSQL 연결 풀링: PgBouncer와 Pgpool-II 비교 및 실무 확인 포인트"
description: "PostgreSQL에서 연결 부족 문제 해결을 위해 PgBouncer와 Pgpool-II 기능·장단점, 설정 예시, 점검 명령과 트러블슈팅 절차, 확인 포인트를 단계별로 정리"
slug: "pgbouncer-vs-pgpool-connection-pooling"
date: 2026-07-18 10:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "pgbouncer", "connection-pooling", "성능튜닝", "장애대응"]
image:
  path: /assets/img/posts/blog/pgbouncer-vs-pgpool-connection-pooling/preview.png
  alt: "ChatGPT, Codex로 가능한 아이디어 Top 10 썸네일"
---

ChatGPT/Codex로 가능한 아이디어 Top 10: 
- 빠른 용어 정리: PgBouncer, Pgpool-II, pooling 모드(session/transaction/statement)를 한눈에 요약해줌 — 실무에서 어떤 모드를 먼저 의심해야 하는지 알려줌.  
- 설정 템플릿 생성: /etc/pgbouncer/pgbouncer.ini, pg_hba.conf 예시를 사용 사례에 맞춰 제안 — 바로 붙여넣을 수 있는 초기값 포함.  
- Docker 예제 생성: PostgreSQL + PgBouncer docker-compose 구성과 healthcheck 스크립트 제공 — 로컬 재현용.  
- 모니터링 쿼리 제공: pg_stat_activity, pgbouncer SHOW 명령 등 점검용 SQL/명령을 만들어줌 — 빠른 원인 파악에 쓰임.  
- 부하 재현 스크립트: pgbench 기반 부하 테스트 명령과 해석 포인트를 안내 — pooling 효과 측정 가능.  
- 트러블슈팅 절차: 연결 초과, 인증 실패, 커넥션 스톨(hold) 증상별 체크리스트 제안 — 우선순위별로 확인할 항목 제시.  
- 마이그레이션 가이드: 기존 애플리케이션에서 pooling 적용 시 변경해야 할 커넥션 설정 목록 작성 — 커넥션 스트링, 드라이버 타임아웃 등.  
- 관측 지표 추천: pgbouncer SHOW POOLS, SHOW STATS와 PostgreSQL의 active/idle 비율을 동시에 보는 대시보드 항목 제안.  
- 알림 템플릿: 연결 이상 징후(대기 증가, serv_wait 증가) 알림 조건과 예시 Alertmanager 규칙 초안 생성.  
- 코드/스크립트 리뷰: 애플리케이션 쪽 커넥션 누수 가능 코드 패턴을 찾아 수정 제안 — close 누락, 커넥션 풀 이중화 등.

로컬에서는 잘 돌아가는데 운영에서 갑자기 "too many connections"가 뜰 때가 제일 헷갈렸어요. 제 경우엔 애플리케이션에서 max pool을 너무 크게 잡아두고, DB 자체 max_connections가 낮아서 생긴 경우가 많았습니다. 이 글은 그런 상황을 만나서 PgBouncer 혹은 Pgpool-II 도입을 고민하거나, 이미 쓰는 환경에서 무엇을 먼저 점검해야 할지 모르는 초보 개발자 분들을 위해 제가 공부하면서 정리한 실무 중심 체크리스트와 예시를 모아둔 것입니다.

왜 풀링이 필요할까? 간단히 말하면 PostgreSQL은 프로세스당 한 커넥션을 처리하므로 커넥션이 과다하면 메모리·파일 디스크립터가 부족해집니다. PgBouncer나 Pgpool-II 같은 외부 풀러를 두면 애플리케이션 커넥션 수와 DB backend 프로세스 수를 분리해 관리할 수 있습니다. 하지만 두 솔루션은 목적과 동작 방식이 달라서 **설치 전 확인 포인트**를 먼저 정해두는 것이 좋습니다.

핵심 개념 요약 (초보용)
- pooling mode: session(세션 단위), transaction(트랜잭션 단위), statement(문장 단위). **성능/호환성 트레이드오프**가 있음.
- PgBouncer: 경량 커넥션 풀러, 대부분 transaction 모드 추천. 인증·라우팅 단순, 리소스 적음.
- Pgpool-II: 로드밸런싱, 복제, 장애조치(failover) 기능 포함. 더 무겁고 구성 복잡.
- 점검 포인트: DB의 max_connections, pgbouncer의 pool_size, 애플리케이션 커넥션 풀 설정, pg_stat_activity, pgbouncer SHOW POOLS/SHOW STATS.

PgBouncer vs Pgpool-II 비교 표
| 비교 기준 | PgBouncer | Pgpool-II |
|---|---:|---:|
| 주 목적 | 경량 커넥션 풀링 | 풀링 + 로드밸런싱, 복제, 페일오버 |
| 리소스 | 낮음 | 높음 |
| pooling 모드 | session/transaction/statement | session/transaction |
| 장애조치 | 없음(일부 스크립트로 가능) | 내장(failover) |
| 설정 난이도 | 쉬움 | 보통~어려움 |
| 권장 사용처 | 다중 동시 커넥션 완화 | 복제·로드밸런싱·쿼리 라우팅 필요 시 |

처음에는 헷갈렸던 부분: transaction 모드에서 세션 레벨 세션 변수를 사용하는 애플리케이션이 어떻게 동작할지였습니다. 실무에서는 **애플리케이션이 세션 상태(session-local variables, temp tables 등)에 의존하는지** 먼저 확인해야 합니다. 만약 세션 상태에 의존한다면 PgBouncer의 transaction 혹은 statement 모드는 문제를 일으킬 수 있고, 세션 모드를 선택해야 합니다(그러나 세션 모드는 DB backend 수가 늘어나므로 자원 부담이 커집니다).

설정 예시 및 명령(실행 가능한 예시 포함)
- PostgreSQL에서 현재 연결 수와 최대값 확인:
```
psql -U postgres -d mydb -c "SELECT COUNT(*) AS total, SUM(CASE WHEN state='active' THEN 1 ELSE 0 END) AS active FROM pg_stat_activity;"
psql -U postgres -d mydb -c "SHOW max_connections;"
```
(예시 숫자: max_connections = 500, superuser_reserved_connections = 3)

- PgBouncer 기본 위치와 서비스 제어 (Linux 예시):
```
# 패키지 설치 후
sudo systemctl enable --now pgbouncer
sudo systemctl status pgbouncer
# 설정 파일
/etc/pgbouncer/pgbouncer.ini
/etc/pgbouncer/userlist.txt
```

- PgBouncer 최소 설정 예시 (/etc/pgbouncer/pgbouncer.ini)
```
[databases]
mydb = host=127.0.0.1 port=5432 dbname=mydb

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 20
reserve_pool_size = 5
reserve_pool_timeout = 5
```

- PgBouncer 상태 확인 (관리 DB에 접속)
```
psql -h 127.0.0.1 -p 6432 -U pgbouncer pgbouncer -c "SHOW POOLS;"
psql -h 127.0.0.1 -p 6432 -U pgbouncer pgbouncer -c "SHOW STATS;"
psql -h 127.0.0.1 -p 6432 -U pgbouncer pgbouncer -c "SHOW CLIENTS;"
```

- Docker Compose 예시 (로컬 재현용)
```
version: '3.8'
services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_PASSWORD: example
    volumes:
      - pgdata:/var/lib/postgresql/data
  pgbouncer:
    image: edoburu/pgbouncer:1.15
    ports:
      - "6432:6432"
    volumes:
      - ./pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini
      - ./userlist.txt:/etc/pgbouncer/userlist.txt
    depends_on:
      - postgres

volumes:
  pgdata:
```

성공/실패 예시 (문제 발견 → 수정)
- 실패 증상: 애플리케이션 로그에 "too many connections" 또는 연결 대기 증가
  - 점검1: psql에서 SHOW max_connections; 결과가 100, 애플리케이션 풀 max=200 → 원인 가능성 높음
  - 조치: 애플리케이션 풀 크기 조정 또는 PgBouncer 도입
- 실패 증상: PgBouncer 접속 시 인증 실패
  - 오류 예시: authentication failed for user "appuser"
  - 점검2: /etc/pgbouncer/userlist.txt의 사용자가 올바르게 등록되었는지, auth_type이 md5인지 확인
  - 조치: userlist 파일에 md5 해시 추가하거나 auth_type 변경 후 pgbouncer 재시작

부하 재현과 측정 (숫자 기반)
- pgbench로 트랜잭션당 1000명의 가상 클라이언트 실행(로컬 재현):
```
pgbench -h 127.0.0.1 -p 6432 -U appuser -c 100 -T 60 -j 4 mydb
```
- 측정 포인트: tps(초당 트랜잭션), 평균 지연(ms), pgbouncer SHOW STATS의 avg_wait, srv_used
- 예시 기대값: pgbouncer 적용 전 tps=120, 적용 후 tps=300(환경에 따라 다름)

모니터링·알림 권장 지표
- PostgreSQL: pg_stat_activity active/idle, replication lag(ms), xact_commit/sec
- PgBouncer: SHOW POOLS에서 cl_active, cl_wait, sv_active, sv_idle 비율; SHOW STATS에서 avg_wait
- 알림 임계 예시: cl_wait 비율 > 10% 지속 5분 → 알림

실무에서는 이렇게 확인하면 좋겠다 (우선순위 체크리스트)
1. 장애 징후 확인: 애플리케이션 에러(too many connections), DB 로그, pgbouncer 로그
2. 숫자 확인: SHOW max_connections; SELECT COUNT(*) FROM pg_stat_activity; pgbouncer SHOW POOLS
3. 애플리케이션 풀 설정 점검: 드라이버 버전, max pool size, 연결 재시도/타임아웃 값
4. 리소스 점검: 서버 메모리, ulimit -n, 파일 디스크립터 사용량, postgres 프로세스 메모리
5. 재현 테스트: pgbench로 대표 워크로드 시뮬레이션
6. 선택: 단순 커넥션 부담이면 PgBouncer, 로드밸런싱/복제/페일오버 필요하면 Pgpool-II

자주 묻는 질문
Q: 언제 PgBouncer의 session 모드를 써야 할까?
A: 애플리케이션이 세션별 상태(세션 변수, temp table 등)에 의존하면 session 모드가 필요할 수 있습니다. 대신 backend 프로세스 수가 늘어나므로 메모리·max_connections 값을 확인하세요.

Q: PgBouncer를 도입하면 max_connections를 얼마로 설정해야 할까?
A: 일반적으로 backend 프로세스(실제 PostgreSQL 연결)를 줄이기 위해 max_connections을 애플리케이션 동시 트랜잭션 수에 맞춰 적게 잡습니다. 예: 애플리케이션 동시 트랜잭션 합계가 200이면 max_connections 250(여유 50)과 pgbouncer default_pool_size를 사용자별로 20 등으로 조정해봅니다. 테스트로 tps·평균 지연을 측정하세요.

Q: Pgpool-II 도입 시 주의할 점은?
A: 복제·페일오버 기능이 있지만 설정·운영 복잡도가 큽니다. 장애 시 자동 페일오버로 데이터 일관성 이슈가 생길 수 있어 사전 복제 토폴로지와 재동기화 절차를 반드시 검증해야 합니다.

Q: pgbouncer SHOW POOLS 결과에서 cl_wait이 높으면 무조건 설정을 올려야 하나요?
A: cl_wait(클라이언트 대기)는 자원 부족 신호입니다. 무작정 pool_size를 늘리기보다 애플리케이션 풀 정책, 트랜잭션 길이, DB 쿼리 최적화 우선 여부를 확인하세요.

코드와 설정 예시(실패 예시와 수정 예시 병행)
- 실패: 애플리케이션이 세션 변수 사용(예: SET myvar) + pgbouncer transaction 모드 → 세션 상태가 유지되지 않음
  - 문제 재현 코드 (app pseudo):
```
conn = pool.getconn()
conn.execute("SET myvar = 'x';")
-- 이후 다른 트랜잭션에서 myvar를 기대함 → 값 없음
```
- 수정: 세션 의존 제거 또는 pgbouncer pool_mode = session로 변경(장비 여유가 있으면)
```
# pgbouncer.ini 변경
pool_mode = session
default_pool_size = 10
```

이미지 예시: PgBouncer와 애플리케이션 간 간단한 아키텍처 다이어그램
![애플리케이션-프록시-DB 간 단순 연결 구조 이미지](/assets/img/posts/blog/pgbouncer-vs-pgpool-connection-pooling/image-1.webp)
이미지 출처: AI 생성 이미지

이미지 예시: PgBouncer SHOW POOLS와 pg_stat_activity를 동시에 모니터링하는 개념도
![PgBouncer와 PostgreSQL 모니터링 개념 일러스트](/assets/img/posts/blog/pgbouncer-vs-pgpool-connection-pooling/image-2.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점
- 애플리케이션 레이어에서 커넥션을 무작정 늘리는 것이 가장 흔한 실수라는 점. 드라이버의 커넥션 풀 기본값과 애플리케이션 환경(스레드 수, 워커 수)을 맞추는 일이 생각보다 중요했습니다.
- PgBouncer는 가볍고 도입 비용이 낮지만, **애플리케이션의 세션 의존성**을 먼저 파악해야 합니다.
- Pgpool-II는 기능이 많아 매력적이지만, 운영에서 발생할 수 있는 복제·페일오버 시나리오를 미리 시뮬레이션해 두지 않으면 위험할 수 있습니다.

실무 확인 포인트(빠른 체크 리스트)
- psql로 SHOW max_connections; 와 SELECT COUNT(*) FROM pg_stat_activity;
- pgbouncer: psql -p 6432 -U pgbouncer pgbouncer -c "SHOW POOLS;"
- 애플리케이션: 커넥션 풀 최대값, idle timeout, connection lifetime 확인
- 서버: free -m, vmstat, ulimit -n, netstat -anp | grep 5432
- 부하 테스트: pgbench -c N -T 60, 측정값 기록(tps, latency)

공식 문서 경로(검증용)
- PostgreSQL: https://www.postgresql.org/docs/
- PgBouncer: https://www.pgbouncer.org/
- Pgpool-II: https://www.pgpool.net/

## Q&A
- Q: PgBouncer가 모든 문제를 해결해주나요?
  - A: 아닙니다. 쿼리 최적화, 인덱스, 장기 트랜잭션 같은 근본 원인을 해결해야 할 때가 많습니다. PgBouncer는 주로 커넥션 과다 문제를 완화하는 도구입니다.
- Q: 로컬 개발 환경에도 PgBouncer를 설치해야 하나요?
  - A: 개발 환경에서 세션 동작을 재현하려면 설치가 도움이 됩니다. 다만 로컬과 운영의 리소스 차이를 고려해야 합니다.
- Q: 마이그레이션 시 점검 항목은?
  - A: 애플리케이션 드라이버 버전, 세션 의존성 여부, 테스트 환경에서의 부하 테스트 결과, 모니터링 설정, 장애 시 롤백 계획 등을 준비하세요.

## 나의 의견 1
여기에 당신 환경의 구체 정보를 적어보세요: 예) PostgreSQL 버전, 현재 max_connections 값, 애플리케이션 풀 설정(드라이버/버전, max pool), 처음 실패한 명령/로그 메시지

## 나의 의견 2
여기에 실제로 시도해 본 수정/테스트 결과를 적어보세요: 예) pgbench 결과 전/후 tps, pgbouncer SHOW STATS의 avg_wait 변화, 재현된 오류 메시지

실무 체크리스트 (적용 전/후 확인용)
- 적용 전
  - [ ] 현재 max_connections, superuser_reserved_connections 확인
  - [ ] pg_stat_activity에서 장기 트랜잭션(>1min) 검색: SELECT pid, usename, state, now()-query_start AS duration, query FROM pg_stat_activity WHERE state='active' AND now()-query_start > interval '1 minute';
  - [ ] 애플리케이션 커넥션 풀 설정 문서화(버전 포함)
  - [ ] 로컬/스테이징에서 pgbench로 baseline 수집 (명령 기록)
- 적용 중
  - [ ] pgbouncer.ini 기본_pool_size, reserve_pool 설정 적용
  - [ ] userlist.txt와 auth_type 일치 확인
  - [ ] 서비스를 재시작 후 pgbouncer SHOW POOLS/SHOW STATS 수집
- 적용 후(24~72시간)
  - [ ] cl_wait, srv_used 추이 확인(대시보드 1h/24h)
  - [ ] 데이터베이스 지연(latency) 및 tps 비교
  - [ ] 알림 임계에 따른 경보 실험(임계값 도달 시 알림 수신 확인)
  - [ ] 장애 복구 절차 문서화 및 롤백 계획 점검

마무리(어떤 것을 먼저 확인해야 할지)
- 먼저 확인할 것: 애플리케이션의 커넥션 풀 설정과 PostgreSQL의 max_connections, 그리고 pg_stat_activity에서 실제 사용 중인 연결 수입니다.  
- 다른 선택지가 나은 경우: 애플리케이션이 세션 상태에 강하게 의존하거나 복제·로드밸런싱이 필요하면 Pgpool-II가 나을 수 있고, 단순 커넥션 감소가 목적이라면 PgBouncer가 더 가볍고 안전한 선택일 가능성이 큽니다.

읽으시다가 궁금한 점이나 환경(버전, 설정 파일 내용, 로그 일부)을 붙여주시면 같이 살펴보면서 어디를 먼저 조치하면 좋을지 더 구체적으로 도와드릴게요.