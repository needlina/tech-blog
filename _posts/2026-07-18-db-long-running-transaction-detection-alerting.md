---
title: "PostgreSQL에서 장기 실행 트랜잭션 자동 감지와 알람·응답 루틴 구축 가이드"
description: "운영 PostgreSQL에서 특정 시간 이상 실행 중인 트랜잭션을 자동으로 탐지하고, 알람 전송·자동 취소·로그 수집까지 연결하는 절차와 확인 포인트, SQL·스크립트·Prometheus 알람 예시 제공"
slug: "db-long-running-transaction-detection-alerting"
date: 2026-07-18 10:00:00 +0900
categories: ["Database", "PostgreSQL"]
tags: ["postgresql", "monitoring", "observability", "장애대응", "로그분석"]
image:
  path: /assets/img/posts/blog/db-long-running-transaction-detection-alerting/preview.png
  alt: "장기 트랜잭션 자동 감지와 알람 썸네일"
---

운영 DB에서 트랜잭션이 오래 걸려 전체 성능에 영향을 줄 때, **특정 기준(예: 5분)**으로 자동 감지해 알림을 보내고 필요하면 자동 취소나 로그를 수집하는 루틴을 구성하면 장애 대응 시간이 크게 줄어듭니다. 이 글은 탐지 기준, 실무에서 자주 확인할 항목, 간단한 SQL·스크립트·Prometheus 알람 예시를 중심으로 단계별로 정리합니다.

문제 상황부터 시작할게요. 로컬에서는 빠르게 끝나는데 운영 환경에서만 트랜잭션이 10분 이상 머무르거나, 특정 배치가 매일 같은 시간에 쌓여 DB 커넥션을 소진하는 식의 문제가 종종 발생했습니다. 그런 경험을 바탕으로 "어떻게 자동으로 캐치하고, 어떤 정보를 모아서 대응하면 좋을까"를 하나씩 실험해봤습니다.

공부하면서 알게 된 점

- 운영 환경에서는 "트랜잭션이 오래 걸린다"는 신호가 여러 가지(긴 쿼리, 잠금, 네트워크 지연, IO 문제)로 나타납니다. 그래서 **탐지는 단일 지표가 아니라 복합적인 신호(쿼리 시간, 상태, 잠금 여부)**로 판단하는 게 더 신뢰도가 높습니다.
- 단순히 query_start 기준만 보면, 이미 종료 대기 중인 idle in transaction도 잡힐 수 있어 **상태(state) 필터**가 필요했습니다.
- 자동 대응(예: cancel) 자체는 위험할 수 있어서, **로그/스택트레이스 수집→사전 알림(수동 확인)→자동 취소(옵션)** 식의 단계화가 안전했습니다.

처음에는 헷갈렸던 부분

- pg_stat_activity의 age(now(), query_start)와 트랜잭션의 시작 시점이 항상 일치하지 않는다는 점(특히 idle in transaction).
- "long-running transaction" 기준을 고정값(예: 5분)으로만 둘지, CPU/IO 상태를 고려해 가변적으로 할지 결정하기 어려웠습니다.
- Prometheus로 모니터링할 때 exporter(예: postgres_exporter) 메트릭과 DB 내부 SQL 결과가 시차가 생기는 경우가 있어 경보 조건을 조심해야 했습니다.

실무에서는 이렇게 확인하면 좋겠다(핵심 포인트)

- 우선 탐지 기준: **트랜잭션 지속 시간(예: >5분), state IN ('active','idle in transaction'), blocking 여부, client/host 정보**를 함께 수집
- 경보 전송 시 포함할 정보: pid, usename, application_name, query_start, age, wait_event_type, wait_event, query(최대 길이 제한), blocking pid 리스트
- 조치 정책 예시: 1) 알람(운영팀) 2) 자동 로그 수집(pg_stat_activity + pg_locks + EXPLAIN(ANALYZE) 샘플) 3) (조건부) cancel backend -> terminate backend 순
- 영향 범위 확인: 해당 트랜잭션이 다른 세션을 블로킹하는지 반드시 확인

![장기 트랜잭션 탐지 흐름도](/assets/img/posts/blog/db-long-running-transaction-detection-alerting/image-1.webp)
이미지 출처: AI 생성 이미지

비교: 탐지 방식별 장단점과 실무 확인 포인트

| 방법                                      |                               장점 | 단점                                     | 확인 포인트                                   |
| ----------------------------------------- | ---------------------------------: | ---------------------------------------- | --------------------------------------------- |
| DB 내부 쿼리(pgres pg_stat_activity)      | 실시간성 높음, 상세 정보 수집 가능 | DB 부하 주의, 쿼리 자체가 느려질 수 있음 | query 예시, 쿼리 실행 시간, 서버 버전         |
| 로그 파싱(예: log_min_duration_statement) |      오버헤드 적음, 과거 추적 쉬움 | 실시간성 낮음, 로그 포맷 의존            | 로그 회전 설정, log_min_duration_statement 값 |
| 외부 모니터링(Prometheus + exporter)      |                통합 알람, 대시보드 | 스크랩 주기 영향, 메트릭 누락 가능       | exporter 버전, scrape_interval, 레이블        |

구현 예제: 기본 탐지 SQL (실패 예시와 수정 예시)

- 실패 예시(문제: idle in transaction 포함/자기 세션 포함)

```
SELECT pid, now() - query_start AS duration, state, query
FROM pg_stat_activity
WHERE now() - query_start > interval '5 minutes';
```

- 수정 예시(개선: 상태 필터, 자기 세션 제외, 최대 query 길이 제한)

```
SELECT pid, usename, application_name,
       now() - query_start AS duration,
       state, left(query, 1000) AS query_snippet,
       wait_event_type, wait_event
FROM pg_stat_activity
WHERE now() - query_start > interval '5 minutes'
  AND state IN ('active', 'idle in transaction')
  AND pid <> pg_backend_pid();
```

실행 가능한 스크립트 예: cron으로 1분마다 실행해 webhook에 알림 전송(예: curl to PagerDuty/Slack)
/etc/monitoring/check-long-trans.sh:

```
#!/bin/bash
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=monitor
THRESHOLD='5 minutes'

psql "host=$PGHOST port=$PGPORT user=$PGUSER dbname=postgres" -At -c "\
SELECT json_build_object(
  'pid', pid, 'user', usename, 'app', application_name,
  'age', extract(epoch from now() - query_start),
  'query', left(query,1000)
) FROM pg_stat_activity
WHERE now() - query_start > interval '$THRESHOLD'
  AND state IN ('active','idle in transaction')
  AND pid <> pg_backend_pid();" | \
while read -r line; do
  # 간단히 알림 전송
  curl -X POST -H 'Content-Type: application/json' -d "$line" https://hooks.example.com/alert
done
```

주의: 실제 운영에서는 인증·TLS·페이로드 형식을 검증하세요. 스크립트는 psql 12+에서 동작 확인했습니다(테스트 환경: PostgreSQL 13.5, psql 13.5).

Prometheus AlertRule 예시 및 Alertmanager 템플릿

- 전제: postgres_exporter 메트릭(postgres_exporter 0.12.0 기준)으로 long_queries_metric을 직접 만들거나, custom exporter로 위 SQL 결과를 스크랩한다고 가정.

Prometheus rule (example):
{% raw %}

```
groups:
- name: postgres-long-tx
  rules:
  - alert: PostgresLongRunningTransaction
    expr: postgres_long_tx_duration_seconds_count{job="postgres"} > 0
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Long running tx on {{ $labels.instance }}"
      description: "There are {{ $value }} transactions > threshold on {{ $labels.instance }}"
```

{% endraw %}
(Alertmanager 템플릿은 아래처럼 실제 템플릿 문법을 포함하므로 Jekyll 처리 방지를 위해 raw로 감쌌습니다.)

{% raw %}
Alertmanager 템플릿 예시:
{{ define "long-tx" }}
Long transaction on {{ $labels.instance }}:
{{ range .Alerts }}

- pid: {{ .Labels.pid }}, user: {{ .Labels.user }}, age: {{ .Annotations.age }}
  {{ end }}
  {{ end }}
  {% endraw %}

실패 예시와 오류 메시지

- 흔히 보는 운영 로그: "canceling statement due to statement timeout" — 이 메시지는 application_statement_timeout 혹은 statement_timeout에 걸려 쿼리가 강제 종료된 경우입니다.
- 예약어/권한 문제로 스크립트가 실패할 때는 psql이 다음과 같은 오류를 반환할 수 있습니다: "psql: FATAL: role "monitor" does not exist" — 이 경우 적절한 모니터 계정을 생성하거나 인증 정보를 확인해야 합니다.
- Prometheus 스크래핑 오류: "500 Internal Server Error" — exporter에서 복잡한 쿼리를 실행할 때 타임아웃이 발생하는 경우입니다. scrape_timeout과 exporter 쿼리 시간을 조정해야 합니다.

운영에서 점검할 구체 명령(Verification)

- 현재 오래된 트랜잭션 목록 확인:

```
psql -c "SELECT pid, usename, now()-query_start AS age, state, left(query,200) FROM pg_stat_activity WHERE now()-query_start > interval '5 minutes' AND state IN ('active','idle in transaction') AND pid <> pg_backend_pid();"
```

- 블로킹 관계 확인:

```
psql -c "SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid, blocking.query AS blocking_query FROM pg_catalog.pg_locks blocked_lock JOIN pg_catalog.pg_stat_activity blocked ON blocked.pid = blocked_lock.pid JOIN pg_catalog.pg_locks blocking_lock JOIN pg_catalog.pg_stat_activity blocking ON blocking.pid = blocking_lock.pid ON (blocked_lock.locktype = blocking_lock.locktype) WHERE NOT blocked_lock.granted AND blocking_lock.granted;"
```

- 강제 취소(주의):

```
SELECT pg_cancel_backend(<pid>);
-- 또는 강제 종료
SELECT pg_terminate_backend(<pid>);
```

- 로그에서 관련 메시지 grep:

```
sudo journalctl -u postgresql -n 200 --no-pager | sed -n '1,200p' | grep -i 'canceling statement\|deadlock\|statement timeout'
```

실무 팁(버전/설정/수치)

- PostgreSQL 권장 버전 예시 확인: 12~15 계열에서 pg_stat_activity 필드는 동일하게 사용 가능(테스트 환경: 13.5)
- 권장 임계값 예시: 트랜잭션 5분(=300초) — 단, 배치/데이터 로드 시간은 별도 정책
- Prometheus: scrape_interval 15s, scrape_timeout 10s 기본. exporter 쿼리는 scrape_timeout보다 짧게 유지
- 로그 설정: log_min_duration_statement = 5000 (ms)로 설정하면 5초 이상 쿼리를 로그에 남겨 원인 추적이 쉬워집니다 (운영상 주의 필요)

자주 묻는 질문
Q: idle in transaction은 왜 위험한가요?
A: 커넥션을 점유하면서 공유 리소스(예: vacuum, btree 업데이트)를 방해하고, checkpoint/cleanup을 지연시킬 수 있습니다. 블로킹 여부와 잠금 보유 시간을 같이 확인하세요.

Q: 자동으로 pg_terminate_backend를 바로 실행해도 될까요?
A: 바로 실행하면 데이터 정합성 위험이 있습니다. 자동화는 '경보 후 1차 자동 로그수집 → 2차(조건 만족 시) 자동 cancel' 형태를 권장합니다.

Q: 모니터링에서 false positive가 자주 발생하면 어떻게 하나요?
A: 탐지 쿼리에 application_name, usename, database 필터를 추가하거나, 임계값을 서비스별로 다르게 설정해 보세요.

Q: Prometheus 대신 ELK로 탐지할 수 있나요?
A: 가능합니다. 로그 기반 탐지는 과거 추적에 유리하지만 실시간성은 떨어집니다. 둘을 조합하면 보완됩니다.

![알람과 대응 루틴 흐름](/assets/img/posts/blog/db-long-running-transaction-detection-alerting/image-2.webp)
이미지 출처: AI 생성 이미지

실무 체크리스트

- SQL 탐지 쿼리: state 필터, 자기 세션 제외, query 길이 제한 적용
- 권한: 모니터 계정의 최소 권한(SELECT on pg_stat_activity 등) 확인
- 로그: log_min_duration_statement 설정과 로그 회전 주기 확인(/var/log/postgresql/\*)
- Prometheus: exporter 버전, scrape_interval, scrape_timeout 검증
- 알림: 알림 페이로드에 pid·query_snippet·age 포함
- 자동화 정책: 자동 cancel 조건(예: age>30m AND blocking=true) 문서화
- 테스트: staging에서 threshold 2분, notify-only 모드로 1주일 이상 검증
- 롤백 플랜: 자동 취소로 인한 부작용 대응 매뉴얼 준비

이 주제에서는 먼저 "탐지 쿼리가 어떤 상태를 잡고 있는지(특히 idle in transaction 제외 여부)"를 확인하고, 그 다음에 "알림 페이로드에 필요한 정보를 무엇으로 할지(예: pid, query_snippet, age, wait_event)"를 정하세요. 자동 취소는 장점이 있지만 위험성이 있으니, **수동 확인 단계**를 두는 쪽이 대부분의 운영에서는 안전할 것 같습니다.

참고(공식 문서 경로)

- PostgreSQL pg_stat_activity: https://www.postgresql.org/docs/current/monitoring-stats.html
- Prometheus alerting: https://prometheus.io/docs/alerting/latest/alertmanager/
- postgres_exporter: https://github.com/prometheus-community/postgres_exporter
