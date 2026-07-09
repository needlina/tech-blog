---
title: "백엔드 API에서 데이터베이스 트랜잭션 안전하게 다루기"
slug: "safe-database-transactions-backend-api"
date: 2026-07-09 09:00:00 +0900
categories: [Backend, Database]
tags: [database-transactions, postgresql, backend, psql, transactional-operations]
---

요즘 백엔드 API를 다루며 데이터 무결성과 동시성 문제를 안전하게 처리하려고 트랜잭션을 더 자세히 공부했습니다. 아직 초보라서 완전히 정답을 말하긴 어렵지만, 공부하면서 정리한 내용을 제 관점에서 정리해봅니다. 실무에서 직접 확인해볼 수 있는 명령어, 설정 예시, 코드 샘플도 포함했습니다. 필요하면 내용을 더 검증해서 쓰면 좋겠다고 생각합니다.

목차
- 트랜잭션을 왜 신경 써야 하나
- 공부하면서 알게 된 점
- 처음에는 헷갈렸던 부분
- 기본적인 트랜잭션 패턴 (코드 예제)
- PostgreSQL에서 점검·디버깅할 때 도움이 되는 명령어/절차
- 실무에서 지켜야 할 점과 권장 패턴
- 실무 체크리스트

트랜잭션을 왜 신경 써야 하나
트랜잭션은 여러 데이터 조작을 하나의 단위로 묶어, 모두 성공하거나 모두 실패하게 하는 기능입니다. 특히 결제, 송금, 재고 감소 같은 '원자적'으로 처리되어야 하는 작업에서 중요합니다. 하지만 트랜잭션 자체는 비용이 있고, 잘못 사용하면 성능 저하, 락 경합, 데이터베이스 bloat(특히 PostgreSQL) 같은 부작용이 생길 수 있습니다. 그래서 안전하게, 그리고 짧게 유지하는 습관이 필요하다고 느꼈습니다.

공부하면서 알게 된 점
- 트랜잭션은 길면 안 좋다: 사용자가 기다리는 네트워크 I/O나 외부 API 호출을 트랜잭션 안에서 하면 락을 오래 유지하게 되어 다른 세션에 영향을 줍니다.
- 격리 수준(Isolation level)은 트레이드오프: Read Committed, Repeatable Read, Serializable이 있고, 높은 격리 수준일수록 논리적 이상 현상(예: non-repeatable read, phantom read)을 줄여주지만 충돌로 인한 롤백(특히 Serializable에서의 serialization failure)을 더 자주 유발할 수 있습니다.
- SELECT ... FOR UPDATE 같은 명시적 락은 편리하지만 남용하면 데드락 가능성이 커집니다. 락 순서를 일관되게 유지하면 데드락을 줄일 수 있습니다.
- PostgreSQL에서는 장기간 열린 트랜잭션이 VACUUM 동작을 방해해 테이블 크기가 불필요하게 커질 수 있습니다. 따라서 트랜잭션을 길게 유지하면 성능에 장기적으로 악영향을 줄 수 있습니다.

처음에는 헷갈렸던 부분
- "트랜잭션을 열면 바로 MVCC 효과로 이전 버전이 유지되는가?" — PostgreSQL은 MVCC 기반이라 트랜잭션이 시작된 시점의 스냅샷을 사용합니다. 하지만 "언제 VACUUM이 이전 튜플을 제거할 수 없게 되는가"는 xact 상태에 따라 달라져서 헷갈렸습니다. 실무에서 장시간 열린 트랜잭션이 오래된 xmin을 보유하면 불필요한 튜플이 남아 테이블이 비대해질 수 있다는 점은 유념해야겠습니다.
- "격리 수준과 일관성 문제의 실제 차이" — 이론 문장은 이해했지만, 서비스에서 어떤 현상이 발생할지 직접 체험해보니 감이 더 잡혔습니다. 예컨대 Read Committed에서 같은 트랜잭션 내 여러 쿼리는 서로 다른 결과를 볼 수 있다는 점(비결정적 읽기)이 실무에서 문제될 수 있었습니다.

기본적인 트랜잭션 패턴 (코드 예제)
아래는 Node.js의 pg를 사용하는 예제입니다. 트랜잭션에서 에러가 나면 반드시 ROLLBACK을 호출하고, 클라이언트는 항상 반환해야 합니다.

- Node.js (pg) 예시

```js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function transfer(fromId, toId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 해당 행을 잠궈서 동시성 문제 방지
    const { rows } = await client.query(
      'SELECT balance FROM accounts WHERE id=$1 FOR UPDATE',
      [fromId]
    );
    if (rows.length === 0) throw new Error('from account not found');
    if (rows[0].balance < amount) throw new Error('insufficient balance');

    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id=$2', [amount, fromId]);
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id=$2', [amount, toId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- Python (psycopg2) 예시 (with 문 활용)

```py
import psycopg2
conn = psycopg2.connect(dsn)
with conn:
    with conn.cursor() as cur:
        cur.execute("BEGIN")
        cur.execute("SELECT balance FROM accounts WHERE id=%s FOR UPDATE", (from_id,))
        # ... 검증 및 업데이트
        # with 블록을 벗어나면 자동으로 COMMIT/ROLLBACK 처리
```

- SQL: SAVEPOINT 사용 예

```sql
BEGIN;
-- 큰 트랜잭션 안에서 부분 롤백 가능
SAVEPOINT sp1;
-- 일부 작업
ROLLBACK TO SAVEPOINT sp1; -- sp1 이후 작업만 취소
COMMIT;
```

PostgreSQL에서 점검·디버깅할 때 도움이 되는 명령어/절차
실무에서 트랜잭션 문제(잠김, 장기간 실행, VACUUM 문제 등)가 의심될 때 유용한 쿼리와 명령을 정리합니다.

- 현재 세션/트랜잭션 상태 보기 (psql 또는 psql 내부에서 사용)

```sql
-- 현재 활성 쿼리/트랜잭션 확인
SELECT pid, usename, application_name, state, backend_start, xact_start, query_start, wait_event_type, wait_event, query
FROM pg_stat_activity
ORDER BY query_start NULLS LAST;
```

- 잠긴 리소스 확인

```sql
-- granted 여부 확인
SELECT l.pid, a.usename, a.query, l.mode, l.granted, c.relname
FROM pg_locks l
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
LEFT JOIN pg_class c ON l.relation = c.oid
WHERE c.relname IS NOT NULL
ORDER BY a.query_start;
```

- 대기 중인 락(비허가) 요약

```sql
SELECT relation::regclass, mode, COUNT(*) 
FROM pg_locks
WHERE NOT granted
GROUP BY relation, mode;
```

- 특정 PID 강제 종료 (주의 필요)

```sql
SELECT pg_terminate_backend(<pid>);
```

- Docker 환경에서 PostgreSQL에 접속 (예시)

```bash
# 컨테이너 시작
docker run -d --name pg-test -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres:15

# 컨테이너에 들어가 psql 실행
docker exec -it pg-test psql -U postgres

# 호스트에서 psql 이용
psql postgres://postgres:pass@localhost:5432/postgres
```

- 오래 열린 트랜잭션으로 인한 bloat 체크 (간단한 접근)

```sql
-- 오래된 트랜잭션이 있는지 확인
SELECT pid, now() - xact_start AS duration, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start;
```

실무에서 지켜야 할 점과 권장 패턴
- 트랜잭션을 가능한 한 짧게 유지: 네트워크 I/O, 외부 API 호출, 사용자 입력 대기 등은 트랜잭션 바깥으로 빼기.
- 명시적 락은 최소화: SELECT FOR UPDATE는 필요한 경우에만 사용하고, 여러 자원을 업데이트할 때는 락 획득 순서를 일관성 있게 설계.
- 재시도 로직 마련: Serializable 또는 transient 오류(예: deadlock, serialization failure)에 대해 안전한 재시도 정책(지수백오프 등)을 구현.
- 낙관적 락(버전 컬럼) 고려: 동시성 충돌이 드물면 optimistic locking이 성능 면에서 유리할 수 있음.
- 모니터링: pg_stat_activity, pg_locks, autovacuum 로그 등을 모니터링해서 장시간 트랜잭션이나 autovacuum 지연을 빠르게 발견.
- 인덱스와 쿼리 비용 확인: 트랜잭션 내 쿼리가 느리면 전체 트랜잭션이 길어짐. EXPLAIN ANALYZE로 확인하고 인덱스를 검토.
- 로깅과 추적: 트랜잭션 시작/종료 시점이나 오류 발생 시 충분한 로그와 트레이스 아이디를 남겨 문제 재현을 쉽게.

실무에서는 이렇게 확인하면 좋겠다
- 긴 트랜잭션이 있는지 정기 점검: cron 혹은 모니터링 툴에서 pg_stat_activity의 xact_start가 오래된 항목을 경고하도록 설정하면 도움이 됩니다.
- VACUUM 관련 모니터링: autovacuum이 제때 실행되는지, bloat가 발생하는지 체크하고 필요시 테이블별 VACUUM/ANALYZE를 실행.
- 데드락 발생 시 원인 추적: 데드락은 로그에 나타나므로 deadlock 로그를 수집해 어떤 쿼리/순서가 문제였는지 파악합니다.
- 트랜잭션 횟수/시간 지표 수집: APM이나 Prometheus로 트랜잭션 수, 평균 지속 시간, 롤백 비율 등을 수집해 경향을 살핍니다.
- 운영 중 빠른 차단/해결: 문제가 발생하면 pg_terminate_backend로 문제 세션을 종료하거나, 최악의 경우 DB 재시작을 고려합니다(재시작은 마지막 수단).

작은 팁들 (제가 실무에서 해보며 느낀 점)
- API 레이어에서 "단일 책임" 원칙을 생각하듯, 하나의 API 호출에서 시작되는 트랜잭션도 가능한 한 한 가지 역할만 하도록 설계하면 문제 영역이 좁아집니다.
- 트랜잭션 타임아웃을 DB나 미들웨어에서 설정할 수 있으면, 개발 초기에 걸어두면 장기 실행 실수를 잡는 데 도움이 됩니다.
- 테스트 환경에서 격리 수준을 의도적으로 낮추거나 높여서 어떤 문제(예: lost update, phantom)가 나타나는지 확인해 보면 이해에 도움이 됩니다.

실무 체크리스트
- [ ] 트랜잭션이 불필요하게 길게 열려 있지 않은가? (외부 호출 포함 여부 점검)
- [ ] SELECT ... FOR UPDATE 같은 락 사용이 꼭 필요한지 검토했는가?
- [ ] 재시도(특히 직렬화 실패나 데드락)에 대한 정책이 구현되어 있는가?
- [ ] pg_stat_activity, pg_locks를 주기적으로 모니터링하고 있는가?
- [ ] 오래된 xact_start 항목을 경고하는 알림이 설정되어 있는가?
- [ ] EXPLAIN ANALYZE로 트랜잭션 내 쿼리 성능을 검사했는가?
- [ ] 낙관적 락(버전 컬럼) 사용 가능성 검토: 언제 낙관적/비관적 중 선택할지 기준이 있는가?
- [ ] 개발/테스트 환경에서 다양한 격리 수준으로 시나리오 테스트를 해봤는가?
- [ ] 트랜잭션 실패 시 로깅(원인/쿼리/파라미터)을 충분히 남기는가?

마무리하며
아직은 학습하는 단계라 모든 상황을 완벽히 다루진 못합니다. 다만 트랜잭션을 '문제 발생 가능성이 높은 기능'으로 인식하고, 짧게 유지하고, 모니터링과 재시도 정책을 마련하는 것이 실무에서 문제가 되는 경우를 줄이는 데 실제로 도움이 된다는 점을 체감했습니다. 이 글도 틀릴 수 있으니, 환경(데이터베이스 종류, 버전, 워크로드)에 맞게 추가 검증을 권합니다. 도움이 되셨다면 직접 테스트해보시고 의견 나눠주세요.