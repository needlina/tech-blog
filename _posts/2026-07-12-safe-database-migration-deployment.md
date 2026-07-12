---
title: "안전한 데이터베이스 마이그레이션 배포 가이드: 실무 중심 체크포인트"
slug: "safe-database-migration-deployment"
date: 2026-07-12 10:00:00 +0900
categories: [Database, DevOps]
tags: [database-migration, postgresql, devops, backup, zero-downtime]
image:
  path: /assets/img/posts/blog/safe-database-migration-deployment/image-1.webp
  alt: "마이그레이션 점검 항목이 적힌 체크리스트 일러스트"
---

오늘은 데이터베이스 마이그레이션을 "가능한 한 안전하게" 배포하는 방법을 정리해봤습니다. 초보 개발자로서 여러 자료를 찾아가며 실무에서 확인해볼 포인트들을 중심으로 정리한 내용이라, 완전한 정답이라기보다 제가 공부하면서 정리한 체크리스트와 예시라고 보시면 좋겠습니다.

공부하면서 알게 된 점, 처음에는 헷갈렸던 부분, 그리고 실무에서 확인하면 좋을 포인트들을 중심으로 적어두었습니다. 코드나 명령어 예시도 포함했으니 환경에 맞게 응용해 보세요.

![마이그레이션 점검 항목이 적힌 체크리스트 일러스트](/assets/img/posts/blog/safe-database-migration-deployment/image-1.webp)
이미지 출처: AI 생성 이미지

목차
- 왜 안전한 마이그레이션이 중요한가
- 일반적인 위험 패턴과 회피 방법
- PostgreSQL에서 자주 쓰이는 안전한 절차와 예시 명령어
- CI/CD에서 마이그레이션을 실행할 때의 실무 팁 (Docker 포함)
- 모니터링/롤백/백업 체크포인트
- 처음에 헷갈렸던 부분 (제가 겪은 혼란들)
- 실무 체크리스트

왜 안전한 마이그레이션이 중요한가
데이터베이스 스키마 변경은 애플리케이션 가용성과 데이터 무결성에 직접 영향을 미칩니다. 작은 ALTER만으로도 테이블 락이나 전체 테이블 재작성(table rewrite)이 발생하여 서비스 지연이 생길 수 있고, 잘못된 롤백 계획은 더 큰 문제를 만들 수 있습니다. 그래서 저는 "예방(백업+검증)+모니터링+점진적 적용"을 우선순위로 두고 접근하려고 합니다.

일반적인 위험 패턴과 회피 방법 (요약)
- ALTER TABLE ... ADD COLUMN ... DEFAULT <value> 같은 문장은 Postgres 버전에 따라 테이블을 재작성할 수 있음 → 안전하게는 NULL 허용 칼럼으로 추가하고, 배경 작업으로 값 채우기 후 NOT NULL/DEFAULT 적용
- 대용량 UPDATE/DELETE는 전체 테이블 쓰기를 유발하여 I/O와 WAL을 폭주시킬 가능성 → 배치로 나누어 실행
- 인덱스 생성 시 전체 테이블 스캔 및 락 → CONCURRENTLY 옵션 사용 (Postgres)
- 마이그레이션 스크립트가 애플리케이션 코드와 불일치 → 먼저 호환성 있는 변화(읽기/쓰기 호환)를 적용하고, 이후 코드 배포 순서 고려

PostgreSQL에서 자주 쓰이는 안전한 절차과 예시 명령어
아래 예시는 제가 공부하면서 실제로 따라해볼 수 있게 정리한 절차와 명령어들입니다. 환경에 따라 조정이 필요합니다.

1) 사전 백업(최소한 스키마/데이터 스냅샷)
- pg_dump 또는 파일시스템 레벨 백업을 준비합니다.
예:
```
# 논리 백업 (압축)
pg_dump -Fc -h db.example -U deploy mydb > /backups/mydb-$(date +%F).dump

# 복원 테스트 (다른 DB에 복원)
pg_restore -d mydb_restore /backups/mydb-YYYY-MM-DD.dump
```
pg_basebackup이나 PITR(아카이브 로그 + base backup)도 고려하면 더 안전합니다.

2) 변경 전 영향도 파악
- 예상 바쁜 시간에 실행하지 않도록 시간대를 선택
- 예상 테이블 크기, 행 수, 인덱스 크기 확인
```
# 테이블 크기
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20;

# 활성 세션/긴 쿼리 확인
SELECT pid, now()-query_start AS age, state, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC LIMIT 10;
```

3) 안전한 칼럼 추가 패턴 (Postgres 권장)
- 잘못하면 테이블 리라이트가 발생하니 다음 순서를 권합니다:
  1. NULL 허용 칼럼으로 먼저 추가 (DEFAULT 없음)
  2. 백그라운드에서 배치로 값 채우기
  3. DEFAULT와 NOT NULL을 시간차로 설정
예:
```
ALTER TABLE users ADD COLUMN new_flag boolean; -- 빠름

-- 배치 업데이트 예시 (id 범위 단위로)
DO $$
DECLARE
  min_id bigint := (SELECT min(id) FROM users);
  max_id bigint := (SELECT max(id) FROM users);
  chunk int := 10000;
  i bigint;
BEGIN
  i := min_id;
  WHILE i <= max_id LOOP
    UPDATE users SET new_flag = (some_expr) WHERE id >= i AND id < i + chunk;
    PERFORM pg_sleep(0.1); -- DB에 부담을 줄이기 위해 잠시 쉼
    i := i + chunk;
  END LOOP;
END$$;
```
배치 업데이트는 애플리케이션에서 변경될 수 있는 데이터 충돌 가능성을 고려해야 합니다.

4) 인덱스는 CONCURRENTLY로 생성(가능하면)
```
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_on_email ON users (email);
```
CONCURRENTLY는 잠금을 최소화하지만, 실패할 경우 재시도 로직을 준비해야 합니다.

CI/CD에서 마이그레이션을 실행할 때의 실무 팁 (Docker 포함)
제가 공부하며 정리한 실행 흐름 예시입니다. 한 단계씩 안전하게 적용하려는 의도로 작성했습니다.

- 마이그레이션을 애플리케이션 컨테이너가 시작될 때 자동으로 실행하게 하는 방식은 편리하지만, 멱등성(idempotency)과 장애 시 롤백이 쉽지 않을 수 있습니다. 그래서 보통 마이그레이션은 다음 옵션 중 하나로 분리합니다:
  - 별도의 마이그레이션 컨테이너를 CI/CD 파이프라인에서 실행
  - k8s initContainer 또는 Job으로 실행

Docker Compose 예 (마이그레이션 전용 서비스):
```
version: '3.8'
services:
  db:
    image: postgres:13
    env_file: .env
  web:
    build: .
    depends_on: [db]
  migrate:
    build: .
    command: ["./scripts/run-migrations.sh"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
```
run-migrations.sh 예:
```
#!/bin/bash
set -euo pipefail
# 간단한 예: Alembic 사용
alembic upgrade head
```

GitHub Actions 예 (간단 흐름):
```
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run migrations
        env:
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
        run: |
          docker run --rm -e DATABASE_URL=${DATABASE_URL} myapp:latest ./scripts/run-migrations.sh
```
가장 중요한 점은 "migration이 실행되기 전에 백업이 자동으로 만들어지는가"와 "실패 시 알림 및 차단 로직이 있는가" 입니다.

롤백과 복구 전략
- 마이그레이션마다 자동 롤백 스크립트를 만들기 어렵고 위험할 때가 있습니다. 그래서 저는 항상 다음을 권합니다:
  - 사전 백업 + 복원(테이블 단위 가능) → 복원 테스트 필수
  - 작고 안전한 단계로 나누기 (한 번에 큰 ALTER 하지 않기)
  - 롤백이 아닌 "forward fix" 전략을 준비: 문제가 생기면 장애 복구용 패치(애플리케이션 레벨 우회)로 우선 대응 후 데이터 복원 검토

모니터링과 점검 명령어
- 배포 중 모니터링할 기본 지표:
  - 활성 쿼리 수 및 오래된 쿼리
  - WAL 파일 증가량, 디스크 사용량
  - DB CPU/IO 대기 시간
  - 서비스 지연(응답시간 증가)
- 쿼리 확인:
```
-- 오래 실행중인 쿼리
SELECT pid, now()-query_start AS runtime, query FROM pg_stat_activity WHERE state = 'active' ORDER BY runtime DESC LIMIT 20;

-- 잠금 확인
SELECT locktype, relation::regclass, mode, granted FROM pg_locks l LEFT JOIN pg_class c ON l.relation = c.oid WHERE relation IS NOT NULL;
```

처음에는 헷갈렸던 부분 (제가 겪은 혼란들)
- "DEFAULT를 바로 주면 항상 느려지나?" → Postgres 버전과 DEFAULT 값이 CONSTANT인지에 따라 달라집니다. (예: v11 이전은 테이블 전체 리라이트 가능)
- "CONCURRENTLY는 항상 무해한가?" → 대부분 락을 줄이지만, 실패 시 인덱스가 만들어지지 않고 재시도 필요하며, 트랜잭션 외부에서 실행해야 하는 제약이 있습니다.
- "배치 업데이트를 하면 일관성이 깨지진 않나?" → 쓰기 동시성(다른 트랜잭션에서 같은 행을 변경하는 경우)에 주의해야 하며, 필요시 애플리케이션 레벨에서 간단한 옵티미스틱 처리를 고려할 수 있습니다.

간단한 Alembic 마이그레이션 예시 (Python)
```
# versions/20260712_add_new_flag.py
from alembic import op
import sqlalchemy as sa

revision = '20260712_add_new_flag'
down_revision = '20260701_prev'

def upgrade():
    op.add_column('users', sa.Column('new_flag', sa.Boolean(), nullable=True))

def downgrade():
    op.drop_column('users', 'new_flag')
```
이후 배경 작업에서 값 채우기 스크립트를 따로 실행하는 식으로 분리하면 안전합니다.

![배치 업데이트와 모니터링 지표를 보여주는 단순한 다이어그램 일러스트](/assets/img/posts/blog/safe-database-migration-deployment/image-2.webp)
이미지 출처: AI 생성 이미지

실무에서는 이렇게 확인하면 좋겠다 (체크 포인트 중심)
- 배포 직전:
  - 백업 여부(자동화된 백업 스크립트로 백업 생성 확인)
  - 마이그레이션이 멱등적인지(중복 실행 시 실패하지 않는지)
  - 예상 실행 시간 및 디스크/로그 영향 추정
- 배포 중:
  - pg_stat_activity, pg_locks로 락/긴 쿼리 추적
  - 디스크 사용량, WAL 증가 모니터링
  - 애플리케이션 레이턴시 지표 확인 (SLA와 비교)
- 배포 후:
  - 데이터 무결성 샘플 체크(대표 레코드 몇 개)
  - 인덱스 상태와 통계(ANALYZE 필요 여부)
  - 롤백/복원 절차 문서화 및 팀 공유

실무 체크리스트
- [ ] 마이그레이션 실행 전 전체/증분 백업 생성 및 복원 테스트 완료
- [ ] 마이그레이션 스크립트가 멱등성 보장 또는 실패 시 안전하게 중단되는지 확인
- [ ] 대량 쓰기 작업은 배치로 분리하고 부하 완화(슬립, 트랜잭션 크기 제한) 적용
- [ ] 인덱스 생성 시 CONCURRENTLY 사용 검토 및 재시도 로직 준비
- [ ] 모니터링 대시보드/알람(오래 걸리는 쿼리, 디스크, WAL, 응답시간) 설정
- [ ] 마이그레이션 시행 시간대(트래픽 낮은 시간) 선택
- [ ] 롤백 대신 빠른 완화책(애플리케이션 차단/읽기 전용 모드 등) 준비
- [ ] 마이그레이션 결과를 검증하는 간단한 데이터 검증 스크립트 준비
- [ ] 관련 팀(운영/DBA/QA)에 사전 공지 및 긴급 연락 루트 확보

마무리하며
제가 공부하면서 정리한 것은 "무조건 이 방법이 최고다"가 아니라, 실무에서 마주칠 위험을 줄이기 위한 체크리스트와 예시입니다. 환경(데이터베이스 종류, 버전, 트래픽 패턴)에 따라 적절히 조정해야 하고, 항상 복원 테스트를 먼저 해보는 습관이 중요하다고 느꼈습니다. 혹시 여러분이 실제로 실행해본 팁이나 다른 도구(Flyway, Liquibase, pt-online-schema-change, gh-ost 등)을 써본 경험이 있으시면 공유해주시면 좋겠습니다.