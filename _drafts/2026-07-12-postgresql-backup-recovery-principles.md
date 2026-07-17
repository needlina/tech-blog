---
title: "PostgreSQL 백업과 복구 전략의 기본 원칙 정리"
description: "오늘은 PostgreSQL 백업과 복구 전략을 공부하면서 정리한 내용을 기록하려고 합니다. 저는 아직 초보 개발자라서 이 주제를 하나씩 배우며 이해한 점들을 차근차근 정리하려고 해요"
slug: "postgresql-backup-recovery-principles"
date: 2026-07-12 09:00:00 +0900
categories: [Database, PostgreSQL]
tags: [postgresql, backup, recovery, disaster-recovery, database-operations]
image:
  path: /assets/img/posts/blog/postgresql-backup-recovery-principles/image-1.webp
  alt: "PostgreSQL 백업과 복구의 흐름을 단순한 아이콘으로 표현한 일러스트"
---

오늘은 PostgreSQL 백업과 복구 전략을 공부하면서 정리한 내용을 기록하려고 합니다. 저는 아직 초보 개발자라서 이 주제를 하나씩 배우며 이해한 점들을 차근차근 정리하려고 해요. 이 글에서는 기본 원칙, 실무에서 확인해야 할 포인트, 명령어·설정 예시와 점검 절차를 중심으로 정리합니다. 틀릴 가능성은 늘 염두에 두고, 확실하지 않은 부분은 개인적으로 느낀 점이나 참고 자료에 기반한 권장사항으로 적겠습니다.

짧은 요약: PostgreSQL 백업은 정기적인 전체/증분(또는 WAL 기반) 백업, WAL(Write-Ahead Log) 보관, 백업 검증(복구 테스트)을 포함해야 하고, 운영환경에서는 권한·암호화·스토리지·복구 시간(이복구 시나리오)에 따라 구현 방식을 조정하면 좋습니다.

![PostgreSQL 백업과 복구의 흐름을 단순한 아이콘으로 표현한 일러스트](/assets/img/posts/blog/postgresql-backup-recovery-principles/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점
- 백업 전략은 단순히 데이터 파일을 복사하는 것이 아니라 "목표 복구 시점(RPO, RTO)"에 맞춘 의사결정이라는 점을 다시 알게 됐습니다. 서비스 요구에 따라 보존 기간, 빈도, 복구 지점(완전 복구 vs 시점복구)을 달리해야 하더군요.
- PostgreSQL에서는 pg_dump(논리 백업)와 pg_basebackup/파일시스템 스냅샷(물리 백업), 그리고 WAL 아카이브를 조합하는 패턴이 흔하다는 것을 확인했습니다. 각각 장단점이 있어 목적에 맞게 선택하는 게 중요해 보입니다.
- 실무에서는 백업이 실제로 복구되는지 주기적으로 검증하는 과정이 가장 간과되기 쉽지만, 가장 중요한 포인트 중 하나라는 걸 느꼈습니다.

처음에는 헷갈렸던 부분
- pg_dump와 물리 백업(예: pg_basebackup, 스냅샷)의 차이: pg_dump는 논리적 덤프로 테이블 단위 복원이 유리하지만 대용량 데이터 복원 속도가 느릴 수 있고, 물리 백업은 클러스터 전체를 복원해야 하는 대신 복원 시간이 짧은 편입니다.
- WAL 기반 복구(WAL archiving + PITR)는 설정이 조금 복잡해서 처음에는 어떻게 WAL을 보관하고 복구 시점(target)을 지정하는지 헷갈렸습니다. PostgreSQL의 버전(예: recovery.conf 위치 변경 등)에 따라 설정 방법이 달라서 공식 문서를 함께 보는 것이 좋았습니다.

핵심 개념 및 실무 체크 포인트
1) 백업 방식 선택
- 논리 백업: pg_dump, pg_restore
  - 장점: 테이블 단위, 버전 간 이동 편리
  - 단점: 대용량 복원 느림, 전체 복구 용도에는 비효율적
- 물리 백업: pg_basebackup, LVM/ZFS 스냅샷, 파일 복사
  - 장점: 빠른 전체 복원, 바이너리 호환 범위 내에서 완전 복제
  - 단점: 같은 PostgreSQL 버전/구성이 필요
- WAL 아카이브 + PITR: 연속적인 WAL 보관으로 시점 복구 가능

2) 중요 설정(예시)
- postgresql.conf (핵심 부분)
  ```
  wal_level = replica          # minimal이나 replica 이상(아카이브나 복제 사용 시)
  archive_mode = on
  archive_command = 'test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'
  max_wal_senders = 3
  wal_keep_size = 1024         # 예시 값(MB)
  ```
  - 주의: archive_command는 실패 시 WAL이 사라지지 않도록 신중히 테스트해야 합니다.

- pg_basebackup 예시 (전체 물리 백업)
  ```
  pg_basebackup -h db_host -D /backups/base -U backup_user -Fp -Xs -P -v
  ```
  - -X s는 WAL을 포함한 스냅샷을 만듭니다.

3) 백업 저장소와 보안
- 백업 파일의 권한과 접근 제어(예: 백업 전용 계정, 최소 권한)
- 암호화: 전송 시 TLS, 저장 시 암호화 권장(예: GPG, s3 서버측 암호화)
- 중복 저장소 전략: 로컬 스토리지 + 오프사이트(클라우드) 복사

실무에서 확인하면 좋겠다 (점검 절차 구체적 예시)
- 백업 생성 확인
  ```
  # 백업 파일 최신 목록
  ls -lh /backups/base

  # pg_basebackup 로그 확인
  tail -n 100 /var/log/postgresql/backup.log
  ```
- WAL 아카이브 상태 확인
  ```
  # 아카이브 디렉터리에서 최신 WAL 파일 확인
  ls -ltr /var/lib/postgresql/wal_archive | tail -n 10

  # postgresql 로그에서 archive_command 오류 검색
  grep -i archive /var/log/postgresql/postgresql-*.log
  ```
- 복구 테스트(중요): 실제로 백업을 복원해보는 절차
  1. 테스트용 서버에 PostgreSQL 설치(버전 일치 권장).
  2. base backup을 복원하고, 필요한 경우 recovery 설정을 추가.
  3. WAL 아카이브로 시점 복구(PITR)나 특정 트랜잭션까지 복구 시도.
  4. 애플리케이션 연결과 간단한 쿼리로 데이터 무결성 확인.

복구 예시(물리 복구 + PITR 개념)
- 대략적인 복구 절차(버전별 차이 있음, 아래는 개요)
  1. PostgreSQL 중지
     ```
     sudo systemctl stop postgresql
     ```
  2. 데이터 디렉터리 비우기(주의: 실제 운영에서는 조심)
     ```
     rm -rf /var/lib/postgresql/data/*
     ```
  3. base backup 복원(예: tar 복원 또는 rsync)
     ```
     tar -xzf /backups/base/base.tar.gz -C /var/lib/postgresql/data
     chown -R postgres:postgres /var/lib/postgresql/data
     ```
  4. recovery 설정(최근 버전은 standby.signal 파일과 recovery_target_time을 postgresql.conf에 지정)
     ```
     # postgresql.conf에 추가
     restore_command = 'cp /var/lib/postgresql/wal_archive/%f %p'
     recovery_target_time = '2026-07-12 08:00:00'
     ```
     또는 recovery.signal/standby.signal을 사용해야 하는 경우가 있으니 버전 문서를 확인하세요.
  5. PostgreSQL 시작
     ```
     sudo systemctl start postgresql
     ```
  6. 복구 로그 확인 및 데이터 검증

Docker 환경에서의 백업(간단 예시)
- 컨테이너 내부에서 pg_dump
  ```
  docker exec -t pg_container pg_dump -U app_user dbname > dbname_$(date +%F).sql
  ```
- 컨테이너 볼륨(데이터 디렉토리)을 스냅샷하거나 호스트로 복사
  ```
  docker run --rm --volumes-from pg_container -v $(pwd):/backup ubuntu \
    bash -c "tar czf /backup/pgdata_$(date +%F).tar.gz /var/lib/postgresql/data"
  ```

모니터링 & 관측 포인트(운영에서 자주 확인하면 좋은 것)
- 백업 성공/실패 알림(메일/슬랙/모니터링 툴 연동)
- 아카이브 디스크 사용량(예: WAL이 쌓여 디스크 부족이 되지 않도록)
- 백업 보존 정책(자동 삭제, 수동 검토)
- 백업 파일 무결성(체크섬, GPG 서명 등)
- 복구 시간 측정: 실제 복구 시뮬레이션으로 RTO 확인

처음에는 헷갈렸던 복구 구성 파일 위치 문제
- PostgreSQL 12 이전은 recovery.conf 파일을 직접 사용하는 경우가 있었고, 이후 버전은 recovery.conf 대신 postgresql.conf와 signal 파일을 사용합니다. 운영 중인 버전에 따라 설정 방법이 다르니, 복구 설정을 자동화하기 전에는 버전 문서를 꼭 확인해 실수로 복구가 되지 않는 상황을 만들지 않도록 조심했습니다.

추가로 제가 공부하며 참고한 실무적 도구들(선택 사항)
- pgBackRest: 물리 백업과 WAL 관리 자동화에 많이 쓰이는 도구
- WAL-G: S3 기반 아카이브와 통합된 도구
- Patroni, repmgr: 고가용성(HA)을 위한 도구(백업 전략과는 별도로 HA 고려)

중요한 주의사항(제가 조심스럽게 느낀 점)
- archive_command가 실패해도 PostgreSQL은 계속 WAL을 생성할 수 있지만, 아카이브 실패는 PITR을 불가능하게 만들 수 있습니다. 따라서 archive_command 테스트를 반복해야 합니다.
- 백업 권한을 지나치게 완화하면 보안 위험이 있습니다. 백업 계정의 권한을 최소 권한으로 설정하고, 백업 파일은 암호화하거나 접근을 제한하세요.
- 복구는 복잡한 작업이므로 운영환경에서 시도할 때는 절대 섣불리 하지 말고, 차라리 테스트 환경에서 충분히 검증한 뒤 자동화 스크립트를 사용하는 편이 안전합니다.

공부하면서 알게 된 점(요약)
- 백업은 "정기성 + 보관 + 검증"의 세 요소가 중요하다는 점을 체감했습니다.
- 도구 선택은 요구사항(RTO/RPO, 비용, 운영 편의성)에 따라 달라지고, 하나의 도구에 의존하기보다는 복수의 레이어(논리/물리/WAL)를 조합하는 게 현실적이라는 생각이 들었습니다.

실무에서는 이렇게 확인하면 좋겠다 (간단한 체크 절차)
- 매일: 백업 생성 로그와 아카이브 상태 확인
- 주간: 백업 복원 테스트(테스트 DB에 실제 복원 및 간단 쿼리 검증)
- 월간: 전체 복구 시나리오(실제 복구 시간 측정)
- 분기: 보존 정책과 스토리지 비용 검토

![백업 점검 목록과 복구 흐름을 단순한 도식으로 나타낸 일러스트](/assets/img/posts/blog/postgresql-backup-recovery-principles/image-2.webp)
이미지 출처: AI 생성 이미지

마무리하면서
- 아직 배우는 입장에서 모든 케이스를 다 알 수는 없지만, 위에 정리한 체크리스트와 절차는 실무에서 바로 적용해볼 만하다고 느꼈습니다. 특히 "복구 테스트"를 주기적으로 해보는 것이 가장 중요하다는 점은 계속 강조하고 싶어요. 다른 방법(예: 상용 백업 솔루션)을 도입할 수도 있지만, 기본 원칙은 변하지 않는다고 생각합니다.

실무 체크리스트
- [ ] 백업 정책 문서화: 빈도, 보존 기간, 책임자, 저장 위치
- [ ] 자동화된 백업 스크립트 동작 확인(로그/알림)
- [ ] WAL 아카이브 설정 및 archive_command 테스트
- [ ] 백업 파일 권한과 암호화 적용 여부 확인
- [ ] 정기 복구 테스트(주/월 단위) 및 복구 시간(RTO) 측정
- [ ] 보관 스토리지 모니터링(디스크 사용량, 비용)
- [ ] 백업 계정 최소 권한 적용 및 접근 로그 확인

참고로 저는 이 글을 쓰면서 여러 문서와 가이드를 함께 보았고, 실제 운영에 도입할 때는 팀 내부 정책과 상용 솔루션, 그리고 PostgreSQL 버전에 맞는 공식 문서를 꼭 확인할 것을 권합니다. 혹시 이 글에서 더 알고 싶은 예시(예: pgBackRest 설정 예제나 WAL-G S3 연동 방법 등)가 있으면 알려주시면 다음 글에서 실습 예제 중심으로 정리해보겠습니다.