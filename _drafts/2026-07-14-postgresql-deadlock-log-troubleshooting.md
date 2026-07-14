---
title: "PostgreSQL 데드락 발생 시 로그로 원인 좁히는 방법 정리"
slug: "postgresql-deadlock-log-troubleshooting"
date: 2026-07-14 10:00:00 +0900
categories: [Database, PostgreSQL]
tags: [postgresql, database, deadlock, troubleshooting, logging]
image:
  path: /assets/img/posts/blog/postgresql-deadlock-log-troubleshooting/preview.png
  alt: "PostgreSQL 데드락 분석 썸네일"
---

오늘의 주제

PostgreSQL 데드락이 발생했을 때 로그로 원인을 좁히는 방법

소개
- 저는 초보 개발자 입장에서 PostgreSQL에서 데드락(deadlock)이 난 상황을 로그와 실무용 도구로 추적해본 내용을 정리하려 합니다. 실무에서 처음 겪을 때 당황하지 않도록, 로그 설정부터 로그 해석, 관련 SQL/명령어 점검 절차까지 차근히 적어보려고 해요. 내용 중 일부는 환경이나 버전에 따라 다를 수 있으니 절대적인 해법으로 받아들이기보다는 "이렇게 시도해보면 좁힐 수 있다"는 관점으로 읽어주시면 좋겠습니다.

왜 로그가 중요한가
- 데드락은 서로 다른 트랜잭션이 서로의 자원을 기다리며 발생하는 교착 상태인데, 프로세스 내부에서 자동으로 감지되어 한 쪽 트랜잭션을 롤백합니다. 이때 PostgreSQL은 로그에 "deadlock detected"와 함께 관련 정보를 남기는데, 이 로그가 원인 규명에 핵심적입니다.
- 하지만 로그만으로 모든 원인을 전부 알 수 있는 건 아니고, 로그 + 실시간 상태 조회(pg_stat_activity, pg_locks 등) + 애플리케이션 쪽 트랜잭션 패턴을 함께 봐야 더 정확히 좁힐 수 있습니다.

공부하면서 알게 된 점
- PostgreSQL 로그의 deadlock 메시지에는 보통 "Process <pid> waits for ..." 형태로 대략 어떤 락을 어떤 프로세스가 기다리는지, 그리고 컨텍스트(문장) 정보가 함께 나온다는 점을 알게 됐습니다.
- log_line_prefix를 pid(%p), user(%u), database(%d), timestamp(%t) 등을 포함하도록 설정하면 로그에 적힌 pid로 실제 쿼리를 찾기가 훨씬 수월하다는 것도 배웠습니다.
- log_lock_waits, deadlock_timeout 같은 서버 파라미터를 적절히 켜두면 잠긴(락 대기) 상황을 더 잘 포착할 수 있습니다.

처음에는 헷갈렸던 부분
- 로그에 나오는 "Process 12345"의 숫자가 항상 운영체제 PID인지, PostgreSQL 내부 세션 식별자인지 헷갈렸습니다. 보통 로그의 PID는 PostgreSQL 백엔드 프로세스의 OS PID이고, log_line_prefix로 기록 형식을 맞춰두면 PID로 pg_stat_activity에서 찾을 수 있습니다.
- 또 deadlock 로그에 'waiting for ShareLock on transaction' 같은 표현이 나오는데, 어떤 테이블의 어떤 행 때문에 걸렸는지 바로 안 보여 당황할 수 있습니다. 이때는 DETAIL과 CONTEXT 줄, 그리고 로그의 timestamp와 PID를 이용해 관련 쿼리를 매핑해야 합니다.

실무에서는 이렇게 확인하면 좋겠다 (절차 중심)
아래는 데드락이 발생했을 때 차근히 원인을 좁히는 단계입니다. 운영 환경에서 바로 시도 가능한 체크 절차 위주로 정리했습니다.

1) 로그 설정 확인 / 필요시 활성화 (postgresql.conf 또는 ALTER SYSTEM)
- 권장 설정 (예시):
  - log_line_prefix = '%m [%p] %u@%d '  # timestamp, pid, user@db
  - log_lock_waits = on
  - deadlock_timeout = 1s  # 기본값은 보통 1s, 과도한 줄릴 경우 더 늘릴 수도 있음
  - log_min_error_statement = error  # 데드락은 error로 남음
- 설정 변경 예시 (psql):
  - ALTER SYSTEM SET log_lock_waits = 'on';
  - ALTER SYSTEM SET log_line_prefix = '%m [%p] %u@%d ';
  - SELECT pg_reload_conf();

2) 로그 위치 및 실시간 확인
- Linux(패키지 설치 기준):
  - tail -n 200 /var/log/postgresql/postgresql-*.log
  - 또는 systemd 환경: journalctl -u postgresql -f
- Docker 컨테이너:
  - docker logs -f <container-name-or-id>
  - 또는 컨테이너 내부에서 로그 설정 확인: docker exec -it <container> psql -U postgres -c "SHOW log_directory; SHOW log_filename;"

3) deadlock 로그 예시(실제와 유사한 포맷)
- PostgreSQL 로그에 흔히 나오는 메시지 예시(간단화):
  - 2026-07-14 09:12:34.567 [12345] myuser@mydb ERROR: deadlock detected
    DETAIL: Process 12345 waits for ShareLock on transaction 6789; blocked by process 12346.
    Process 12346 waits for ExclusiveLock on relation 54321 of database 16384; blocked by process 12345.
    CONTEXT: SQL statement "UPDATE orders SET status = 'paid' WHERE id = 42"
- 이 로그에서 PID(12345, 12346), 쿼리 컨텍스트(UPDATE ...), 그리고 관계 OID(54321) 또는 transaction id 정보가 나옵니다. OID는 pg_class에서 매핑할 수 있습니다.

4) 로그의 PID를 실제 세션/쿼리와 매핑 (pg_stat_activity)
- 문제 발생 직후(가능하면 로그 타임스탬프 근처) 아래 쿼리로 관련 세션/쿼리 상태를 확인합니다.
- 실무에서 자주 사용하는 쿼리 예:
  - -- 해당 PID의 활동 확인
    SELECT pid, usename, datname, application_name, client_addr, state, query_start, query
    FROM pg_stat_activity WHERE pid IN (12345,12346);
  - -- 블로킹 관계를 한 번에 보는 쿼리
    SELECT blocked.pid AS blocked_pid, blocked.query AS blocked_query,
           blocking.pid AS blocking_pid, blocking.query AS blocking_query
    FROM pg_stat_activity blocked
    JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocked_by(pid) ON true
    JOIN pg_stat_activity blocking ON blocking.pid = blocked_by.pid
    WHERE blocked.pid <> blocking.pid;

5) 락 상세 확인 (pg_locks + pg_class)
- 어떤 타입의 락인지(ROW SHARE, ROW EXCLUSIVE, SHARE, EXCLUSIVE 등)와 어떤 relation(테이블)인지 확인:
  - SELECT l.locktype, l.database, l.relation, c.relname, l.page, l.tuple, l.virtualtransaction,
           l.pid, l.mode, l.granted
    FROM pg_locks l LEFT JOIN pg_class c ON l.relation = c.oid
    WHERE l.pid IN (12345,12346) OR l.locktype <> 'transaction' AND c.relname IS NOT NULL;

6) 쿼리 재현을 위한 간단한 예제 (학습/테스트 용)
- 아래 SQL은 로컬 테스트에서 데드락을 재현하는 간단한 예제입니다. 절대 운영에서 그대로 실행하지 마세요.
  - -- 세션 A:
    BEGIN;
    UPDATE items SET qty = qty - 1 WHERE id = 1;
    -- 대기
  - -- 세션 B:
    BEGIN;
    UPDATE items SET qty = qty - 1 WHERE id = 2;
    -- 대기
  - -- 세션 A:
    UPDATE items SET qty = qty - 1 WHERE id = 2;  -- 이 시점에 데드락 가능성
  - -- 세션 B:
    UPDATE items SET qty = qty - 1 WHERE id = 1;  -- 서로 대기하면 deadlock 발생
- 이렇게 재현해보면 로그와 pg_stat_activity를 동시에 보며 어떤 쿼리가 어떤 락을 얻으려 했는지 확인하기 좋았습니다.

Docker / Linux 관점에서 추가 팁
- 컨테이너화된 PostgreSQL에서는 로그가 표준출력으로 나오는 경우가 많아 docker logs로 바로 확인 가능하고, 볼륨으로 로그를 호스트에 남기면 운영체제 로그 관리와 통합하기 편합니다.
- systemctl로 관리하는 경우 journalctl -u postgresql -S "2026-07-14 09:00:00" --no-pager 같은 필터를 통해 시간대별로 로그를 좁혀보면 좋습니다.

튜닝과 예방(조심스럽게)
- deadlock 자체는 애플리케이션의 트랜잭션 설계(락 순서, 트랜잭션 길이)가 원인인 경우가 많습니다. 가능한 한 트랜잭션을 짧게 유지하고, 락을 거는 순서를 일관되게 유지하는 것이 도움이 됩니다.
- DB 측면에서는 인덱스가 없어서 쿼리가 테이블 스캔하며 더 많은 락을 잡는 상황이 원인일 수 있으므로, 쿼리/인덱스 개선을 고려해볼 수 있습니다.
- PostgreSQL 파라미터로 deadlock_timeout을 너무 짧게 잡으면 오탐이 늘고, 너무 길게 잡으면 감지 지연이 생길 수 있어 트레이드오프가 있습니다. 운영에서 변경 전에는 테스트 환경에서 검증해보는 편이 안전합니다.

로그에서 자주 보는 키워드와 해석 힌트
- "deadlock detected" : 데드락 감지 및 한 트랜잭션 강제 롤백(에러)
- "Process <pid> waits for ShareLock on transaction <x>" : 해당 PID가 특정 트랜잭션 잠금을 기다리는 상황
- "blocked by process <pid>" : 어느 PID가 락을 보유하고 있는지
- "CONTEXT: SQL statement" : 어떤 SQL 문맥에서 문제가 발생했는지 단서를 줌

처음에는 헷갈렸던 부분(다시 정리)
- 로그의 OID나 트랜잭션 id는 바로 사람이 읽기 쉬운 이름이 아니라 매핑이 필요합니다. 예컨대 relation OID는 pg_class에서 relname으로 매핑하면 테이블 이름을 알 수 있습니다.
- 로그 타임스탬프와 서버의 시간대/로그 포맷이 일치하지 않을 수 있으니, 시간 동기화(NTP)와 log_line_prefix의 타임스탬프 포맷을 맞추면 추적이 수월합니다.

실무에서 확인할 포인트들 (짧게 요약)
- 로그 설정이 충분히 상세한가? (pid, timestamp, log_lock_waits)
- 데드락 로그의 PID를 pg_stat_activity로 매핑해 관련 쿼리와 상태를 캡쳐했는가?
- 관련 쿼리들이 어떤 테이블/인덱스를 건드리는가? pg_locks로 락 타입을 확인했는가?
- 애플리케이션 레벨에서 동일한 락을 다른 순서로 잡고 있지 않은가?
- 재현 가능한가? 재현이 가능하면 테스트 환경에서 원인 규명 및 수정 검증을 하자.

예시 명령어 모음 (복사해서 쓰기 편하게)
- 로그 설정 확인:
  - psql -U postgres -c "SHOW log_lock_waits; SHOW log_line_prefix; SHOW deadlock_timeout;"
- 로그 다시 불러오기:
  - psql -U postgres -c "SELECT pg_reload_conf();"
- 실시간 세션 확인:
  - psql -U postgres -c "SELECT pid, usename, datname, state, query_start, query FROM pg_stat_activity ORDER BY query_start DESC LIMIT 50;"
- 블로킹 관계:
  - psql -U postgres -c "SELECT blocked.pid AS blocked_pid, blocked.query AS blocked_query, blocking.pid AS blocking_pid, blocking.query AS blocking_query FROM pg_stat_activity blocked JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocked_by(pid) ON true JOIN pg_stat_activity blocking ON blocking.pid = blocked_by.pid WHERE blocked.pid <> blocking.pid;"

주의: 위 쿼리들은 읽기 전용이지만, 운영에서 실행 시 부하에 주의해야 합니다. 특히 pg_stat_activity를 너무 자주 호출하면 도움이 되지만 과도한 모니터링은 오버헤드를 줄 수 있습니다.

마무리 (조심스러운 조언)
- 로그는 문제의 실마리를 가장 잘 제공하는 자료입니다. 단, 로그만으로 모든 걸 단정하기보다는 pg_stat_activity/pg_locks 자료, 애플리케이션 트레이스, 테스트 재현 결과를 종합해서 판단하는 것이 안전합니다.
- 설정을 바꿀 때는 먼저 테스트 환경에서 충분히 검증하세요. 특히 deadlock_timeout이나 log_lock_waits 같은 설정은 운영에서 동작에 영향을 줄 수 있으므로 주의가 필요합니다.

## 관련 이미지 주제
1. PostgreSQL 로그 한 줄(타임스탬프와 PID가 보이는 간단한 로그 라인)에서 핵심 필드가 강조된 기술 일러스트
2. 트랜잭션 A와 B가 서로 다른 행/테이블을 잠그며 충돌하는 간단한 순서도(화살표와 락 아이콘 중심)

실무 체크리스트
- [ ] log_line_prefix에 pid(%p)와 timestamp(%m)가 포함되어 있는가?
- [ ] log_lock_waits = on 으로 설정되어 있는가(필요 시 활성화)?
- [ ] deadlock 발생 시 로그 타임스탬프와 pid로 pg_stat_activity에서 세션을 캡쳐했는가?
- [ ] pg_locks와 pg_class로 락 타입과 대상 테이블을 확인했는가?
- [ ] 애플리케이션의 트랜잭션 순서/길이 문제는 없는가(짧은 트랜잭션 유지)?
- [ ] 재현 가능한 케이스라면 테스트 환경에서 재현해보고 해결책(쿼리/인덱스/순서)을 검증했는가?
- [ ] 로그, DB 상태, 애플리케이션 쪽 트레이스(가능하면)까지 종합해서 원인을 문서화했는가?

읽어주셔서 감사합니다. 데드락은 당황스러운 문제지만 로그와 몇 가지 절차만으로 원인을 좁혀갈 수 있었습니다. 제 정리도 틀릴 가능성이 있으니, 여러분의 경험이나 수정할 점이 있으면 알려주시면 같이 보완해보고 싶습니다.