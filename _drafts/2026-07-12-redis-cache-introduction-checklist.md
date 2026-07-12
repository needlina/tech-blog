---
title: "Redis 캐시 도입 전 체크리스트: 성능·운영·안정성 관점에서 확인할 것"
slug: "redis-cache-introduction-checklist"
date: 2026-07-12 10:00:00 +0900
categories: [Database, DevOps]
tags: [redis, caching, cache-invalidation, performance, docker, monitoring]
image:
  path: /assets/img/posts/blog/redis-cache-introduction-checklist/image-1.webp
  alt: "단순한 캐시 레이어 개념 다이어그램"
---

오늘의 주제

Redis 캐시를 도입하기 전에 먼저 확인해야 할 것들

도입부 — 왜 이 글을 쓰게 되었나
제가 최근에 Redis를 실제 서비스에 적용해 보면서, 문서와 실제 운영 사이에 차이가 있다는 걸 많이 느꼈습니다. Redis는 빠른 인메모리 스토어라서 많은 장점이 있지만, 환경과 사용 패턴에 따라 오히려 문제를 만들 수도 있어서요. 그래서 초보 개발자 관점에서 "도입 전에 미리 확인하면 좋겠다" 싶은 포인트들을 정리해 보려고 합니다. 저는 아직 배우는 중이라 틀린 부분이 있을 수 있으니, 실무에 적용하기 전에는 팀 내 전문가나 공식 문서를 다시 확인해 주시길 권합니다.

![단순한 캐시 레이어 개념 다이어그램](/assets/img/posts/blog/redis-cache-introduction-checklist/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점
- Redis 도입 목적을 명확히 하자:
  - 읽기 오버헤드가 큰 DB 쿼리를 줄이기 위한가, 세션/토큰 저장을 위한가, 혹은 작업 큐/메시지 브로커로 사용할 것인가에 따라 설정과 아키텍처가 달라집니다.
- 패턴(캐시 어사이드 vs write-through 등)을 먼저 정하면 코드 설계가 쉬워집니다.
- 메모리 제한, eviction 정책, TTL 설정이 의외로 시스템 동작에 큰 영향을 줍니다.
- 모니터링과 경보(메모리 임계치, eviction 급증, hit ratio 저하 등)가 없으면 문제를 빨리 발견하기 어렵습니다.

처음에는 헷갈렸던 부분
- TTL과 eviction: TTL로 만료되는 키와 메모리 부족으로 삭제되는 키(eviction)는 다릅니다. 둘 다 필요하지만 목적에 따라 우선순위를 고려해야 합니다.
- persistence 옵션(RDB/AOF): 캐시 용도로만 쓴다면 persistence를 끄기도 하는데, 실수로 중요한 데이터를 넣거나 운영 목적에 따라 달라집니다.
- 복제와 클러스터: 단일 인스턴스로 시작할지, Sentinel로 가용성을 확보할지, Cluster로 샤딩할지는 트래픽, 키 분포, 운영 역량에 따라 판단해야 합니다.
- 'KEYS' 명령의 위험성: 운영에서 'KEYS *' 같은 명령은 비용이 커서 위험합니다. 대신 SCAN을 사용해야 합니다.

기본적인 확인 항목 (명령어 예시 포함)
운영서버에서 Redis 상태를 확인할 때 유용한 기본 명령들입니다.

- 프로세스/서비스 상태 (systemd 기반)
```
sudo systemctl status redis.service
sudo journalctl -u redis.service --since "1 hour ago"
```

- Docker로 띄운 경우
```
docker-compose up -d
docker ps | grep redis
docker exec -it <redis-container> redis-cli INFO replication
docker stats <redis-container>
```

- Redis 내부 통계 확인
```
redis-cli INFO memory
redis-cli INFO stats
redis-cli INFO keyspace
redis-cli INFO replication
redis-cli CONFIG GET maxmemory
redis-cli CONFIG GET maxmemory-policy
```

- 실무에서 자주 볼 지표
  - used_memory, used_memory_rss
  - keyspace_hits / keyspace_misses (hit ratio)
  - evicted_keys
  - expired_keys
  - connected_clients
  - instantaneous_ops_per_sec
  - replication lag (replica에서 INFO replication)

환경 설정 예시 (docker-compose, redis.conf 관련)
아래는 간단한 docker-compose 예시와 주요 설정입니다. 실제 운영에서는 볼륨, 보안(패스워드/ACL), 네트워크 설정을 더 신경써야 합니다.

docker-compose.yml (예시)
```
version: '3.8'
services:
  redis:
    image: redis:7
    command: ["redis-server", "/usr/local/etc/redis/redis.conf"]
    volumes:
      - ./redis.conf:/usr/local/etc/redis/redis.conf:ro
      - redis-data:/data
    ports:
      - "6379:6379"
volumes:
  redis-data:
```

redis.conf에서 확인할 설정 (일부)
```
# 메모리 제한
maxmemory 512mb
# 메모리 초과 시 정책 (예: volatile-lru, allkeys-lru 등)
maxmemory-policy allkeys-lru
# RDB/AOF persistence (캐시 전용이면 off 고려)
save 900 1
appendonly no
# 포트/바인드/보안 관련
bind 0.0.0.0
requirepass your_redis_password   # 실무에서는 ACL 권장
```

운영 환경 Linux 커널 튜닝 (주의 필요)
- vm.overcommit_memory: Redis는 메모리 할당과 관련해 vm.overcommit_memory=1을 권장하는 경우가 있습니다.
```
sysctl vm.overcommit_memory
sudo sysctl -w vm.overcommit_memory=1
# 영구 적용: /etc/sysctl.conf에 vm.overcommit_memory=1 추가
```
- Transparent Huge Pages(THP)는 Redis 성능에 영향을 줄 수 있어 비활성화 권장:
```
cat /sys/kernel/mm/transparent_hugepage/enabled
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
```
(이런 설정 변경은 서버 운영 정책에 따라 신중히 적용하세요.)

코드 예제 — 캐시 어사이드 패턴 (Node.js + ioredis)
간단한 예시로 데이터베이스에서 값을 읽을 때 먼저 Redis를 확인하고, 없으면 DB에서 조회한 뒤 캐시에 넣는 패턴입니다.

```
const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 6379, password: 'your_redis_password' });

// 가짜 DB 조회 함수
async function fetchFromDb(key) {
  // 실제로는 DB 쿼리
  return { id: key, value: 'db-value-' + key };
}

async function getValue(key) {
  const cacheKey = `myapp:item:${key}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const fromDb = await fetchFromDb(key);
  // TTL 300초 예시
  await redis.set(cacheKey, JSON.stringify(fromDb), 'EX', 300);
  return fromDb;
}
```

캐시 무효화(캐시 인밸리데이션) 전략
- TTL(시간 기반) : 가장 단순하지만, 데이터가 빨리 바뀌면 캐시가 오래된 상태가 될 수 있음.
- 버전 키(versioned key) : 데이터를 변경할 때마다 키 네임스페이스에 버전 번호를 늘려 이전 캐시를 무효화.
- Pub/Sub 또는 메시지 큐 : 변경 이벤트를 퍼블리시하여 다른 인스턴스가 관련 키를 삭제하게 함.
- 직접 삭제 : 데이터 변경 시 관련 캐시 키를 찾아 DEL 하는 방식. 패턴 삭제는 SCAN + DEL 조합으로 안전하게.

프로덕션에서 쓸 때 주의할 명령
- 절대 KEYS * 사용하지 않기 (블로킹)
- 큰 패턴 삭제 시에는 SCAN을 사용:
```
# 안전한 패턴 삭제 예시
cursor=0
do {
  result = redis.scan(cursor, "MATCH", "myapp:item:*", "COUNT", 1000)
  cursor = result[0]
  keys = result[1]
  if (keys.length) {
    redis.del(...keys)
  }
} while (cursor != 0)
```

장애 대비 및 검증
- Redis가 다운되면 캐시가 사라진다는 가정으로 설계(즉, 캐시 손실에 대한 재생성 로직 필요)
- 장애 시 오히려 DB로 트래픽이 몰려 DB가 느려질 수 있으니 Circuit Breaker나 rate limiting 고려
- Sentinel/Cluster로 HA 구성 시 failover 시나리오를 스테이징에서 테스트해 볼 것
- 백업/복원 절차 검증: RDB/AOF 파일을 이용한 복구 테스트

관측(모니터링) 포인트
- Redis 자체 메트릭(위에 언급한 stats)
- hit ratio를 꾸준히 모니터링: keyspace_hits / (keyspace_hits + keyspace_misses)
- eviction 급증 여부 (evicted_keys)
- used_memory_rss와 OS 레벨 메모리 차이 (RSS)
- 연결 수와 blocking clients (blocked_clients)
- slowlog를 보고 느린 명령 추적: redis-cli SLOWLOG GET 128
- 로그에서 OOM 또는 persistence 관련 에러 검색

실무에서는 이렇게 확인하면 좋겠다
- 도입 전: 스테이징 환경에서 예상 키 분포와 TTL을 기준으로 메모리 시뮬레이션(샘플 데이터로 Redis를 미리 채워보고 eviction 발생 시점 확인)
- 장애 테스트: Redis를 강제로 재시작/네트워크 분리하여 애플리케이션의 복원력(서킷 브레이커, 재시도, 페일오버)을 점검
- 모니터링 구성: Prometheus exporter(redislabs/redis_exporter 등)로 필요한 메트릭을 수집하고, 메모리 사용률 80% 이상, evictions 증가 등으로 알람 설정
- 운영 점검 절차: 주기적으로 INFO 명령을 스크립트로 수집해 추세를 확인하고, slowlog를 주기적으로 확인

추가로 알아두면 좋은 작은 팁들
- 캐시 키 네이밍 규칙을 미리 정해두면 운영, 추적, 삭제가 편합니다. (예: myapp:resource:{id}:v{version})
- 데이터 크기가 큰 키(예: 매우 큰 JSON)를 캐시에 넣는 것은 재고해 보세요. 메모리 효율이 떨어질 수 있습니다.
- TTL 전략은 서비스 특성(실시간성, 일관성 요구)에 맞춰 조정하세요.

![캐시 무효화와 모니터링 포인트를 요약한 단순한 다이어그램](/assets/img/posts/blog/redis-cache-introduction-checklist/image-2.webp)
이미지 출처: AI 생성 이미지

마무리 — 제 관점에서의 정리
제가 지금까지 정리한 내용은 "Redis를 무턱대고 도입하지 말고, 목적과 운영 방식을 먼저 정하자"라는 실무적 권장에 가까운 요약입니다. 환경이나 요구사항에 따라 권장값이 달라질 수 있으니, 꼭 작은 스테이징 테스트를 통해 검증하시는 걸 권합니다. 또한, 팀 내에서 누가 Redis를 운영하고 모니터링할지 명확히 해두면 문제가 생겼을 때 대응이 빠릅니다.

실무 체크리스트
- [ ] Redis 도입 목적(읽기 캐시, 세션, 큐 등) 문서화
- [ ] 캐시 패턴 결정(캐시 어사이드 / write-through / write-back)
- [ ] 메모리 한도(maxmemory) 및 정책(maxmemory-policy) 설정
- [ ] TTL 전략 설계 및 샘플 데이터로 메모리 시뮬레이션 수행
- [ ] persistence(RDB/AOF) 설정 여부 결정 및 백업/복원 절차 검증
- [ ] 모니터링 지표(used_memory, evictions, hit ratio 등)와 알람 임계치 정의
- [ ] 프로덕션에서 사용하지 않을 명령(예: KEYS) 규칙화, SCAN 사용 권장
- [ ] 장애 시나리오(인스턴스 다운, 네트워크 분리, failover) 테스트
- [ ] 보안: 네트워크 접근 제어, 인증(ACL/password), 운영자 권한 최소화
- [ ] 운영 문서(시작/중지/업그레이드/로그 확인/복구 절차) 작성

카테고리: Database, DevOps
태그: redis, caching, cache-invalidation, performance, docker, monitoring

끝으로 다시 한 번: 제가 정리한 내용은 개인적인 학습 기록입니다. 환경에 따라 권장사항이 달라질 수 있으니, 적용 전에 팀과 상의하거나 공식 문서를 참고해 주세요.