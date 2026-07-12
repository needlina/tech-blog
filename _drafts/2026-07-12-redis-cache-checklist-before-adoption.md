---
title: "Redis 캐시 도입 전 체크리스트: 성능·일관성·운영 관점에서 확인할 것들"
slug: "redis-cache-checklist-before-adoption"
date: 2026-07-12 09:00:00 +0900
categories: [Database, DevOps]
tags: [redis, cache, performance, observability, devops]
image:
  path: /assets/img/posts/blog/redis-cache-checklist-before-adoption/image-1.webp
  alt: "단순한 Redis 캐시 개념을 나타내는 일러스트"
---

오늘의 주제

Redis 캐시를 도입하기 전에 먼저 확인해야 할 것들

서두

최근 프로젝트에서 Redis를 캐시 레이어로 고려하면서 공부한 내용을 정리해봅니다. 저는 아직 초보 개발자여서 실무 적용 전 여러 모로 확인해야 할 점들이 많다고 느꼈습니다. 이 글에서는 성능, 일관성, 운영(운영 중 점검 절차 포함) 관점에서 "도입 전에 확인하면 좋을 것들"을 중심으로 정리합니다. 공부하면서 알게 된 점과 처음엔 헷갈렸던 부분, 그리고 실무에서 바로 확인해볼 수 있는 명령어나 설정 예시도 포함했습니다. 모든 내용은 제 이해를 바탕으로 조심스럽게 정리한 것이고, 환경에 따라 다르게 적용될 수 있습니다.

![단순한 Redis 캐시 개념을 나타내는 일러스트](/assets/img/posts/blog/redis-cache-checklist-before-adoption/image-1.webp)
이미지 출처: AI 생성 이미지

공부하면서 알게 된 점 (요약)

- Redis는 메모리 기반 K-V 스토어라 매우 빠르지만, 메모리 크기와 eviction 정책, 데이터 모델(값 크기)이 성능에 큰 영향을 줌.
- 캐시 전략(캐시-어사이드, write-through, write-behind 등)을 사전에 결정해야 하고, 데이터 일관성 요구사항에 따라 적절한 방식을 골라야 함.
- 운영 측면에서는 모니터링(메모리, hit/miss, latency), 백업(RDB/AOF), 복제/HA(Sentinel/Cluster) 구성이 중요함.
- 간단한 테스트(열람·갱신 빈도, TTL 설계, 스팸 키 방지 등)를 통해 예상 메모리 사용량과 비용을 예측해두는 것이 실무에서 도움이 됨.

처음에는 헷갈렸던 부분

- Eviction과 OOM: Redis는 메모리 한계에 도달하면 설정된 eviction 정책에 따라 키를 제거합니다(volatile-lru 등). 그런데 persistence(AOF/RDB)와 함께 운영하면 OOM 또는 데이터 손실 시나리오가 복잡해져 헷갈렸습니다. 실무에서는 메모리 한계를 정확히 계산하고 eviction 정책을 팀 내에서 합의해두는 것이 필요하다고 느꼈습니다.
- 캐시 전략의 선택: 캐시-어사이드는 구현이 간단하지만, 캐시 미스 시 DB에 부담을 줄 수 있습니다(동시성 특이 케이스). 반대로 write-through는 항상 캐시에 쓰므로 일관성은 좋지만 쓰기 비용이 커집니다. 어느 것을 선택할지는 트래픽 패턴에 따라 달라질 것 같습니다.
- Redis Cluster와 단일 인스턴스의 트레이드오프: 샤딩과 HA를 제공하지만 운영 복잡성이 늘어남. 작은 서비스는 먼저 단일 인스턴스 + Sentinel로 시작해도 될 것 같습니다.

실무에서는 이렇게 확인하면 좋겠다 (점검 절차과 명령어 중심)

1) 버전, 구성, 메모리 설정 확인
- Redis 버전 호환성 확인: redis-cli INFO SERVER 또는 redis-server --version
- 메모리 제한 확인: CONFIG GET maxmemory  
  예:
  ```bash
  redis-cli CONFIG GET maxmemory
  ```
- 현재 메모리 사용량: INFO memory
  ```bash
  redis-cli INFO memory
  # 주요 항목: used_memory, used_memory_rss, maxmemory, mem_fragmentation_ratio
  ```

2) hit/miss, 요청 패턴 파악
- 통계 확인: INFO stats
  ```bash
  redis-cli INFO stats
  # keyspace_hits, keyspace_misses, total_commands_processed 등 확인
  ```
- 실시간 간단 모니터링: redis-cli --stat 1 10

3) 키 스캔과 큰 키 탐지
- KEYS는 사용하지 않는 것이 좋음(블로킹). 대신 SCAN 사용:
  ```bash
  redis-cli SCAN 0 MATCH user:* COUNT 1000
  ```
- 키별 메모리 사용량 검사:
  ```bash
  redis-cli MEMORY USAGE my:key
  ```
  많은 큰 값(예: 큰 JSON, 바이너리)이 있는지 확인해 작은 객체로 분해할지 검토.

4) eviction 정책과 TTL 설계
- eviction policy 확인:
  ```bash
  redis-cli CONFIG GET maxmemory-policy
  ```
- TTL 있는 키 비율 확인: 샘플러를 만들어 TTL 분포를 체크. TTL이 너무 짧거나 길면 의도대로 동작하는지 검토.

5) 데이터 지속성과 백업
- persistence 설정 확인:
  ```bash
  redis-cli CONFIG GET save
  redis-cli CONFIG GET appendonly
  ```
- RDB/AOF 설정과 주기, 복구 절차(수동 복원 테스트) 문서화 필요.

6) HA/복제/클러스터
- 복제 상태 확인:
  ```bash
  redis-cli INFO replication
  ```
- Sentinel 구성 시 sentinel 모니터링 및 자동 페일오버 절차를 테스트(스텁 장애 상황에서 선행 연습 권장).
- Cluster 모드의 경우 슬롯 분배와 resharding, 재시작 시 노드 재연결 절차를 미리 숙지.

7) 보안과 네트워크
- bind, protected-mode, requirepass 여부 확인:
  ```bash
  redis-cli CONFIG GET bind
  redis-cli CONFIG GET protected-mode
  redis-cli CONFIG GET requirepass
  ```
- Redis는 기본적으로 평문 TCP. 보통 VPC 내부 통신, TLS(6.x 이상에서 지원) 또는 stunnel/ssh tunnel 사용 권장.
- 클라우드 매니지드 Redis를 쓰면 네트워크·보안 관리 부담이 줄 수 있음.

간단한 Docker 예시 (개발/테스트용)
- docker-compose 예시:
```yaml
version: '3.8'
services:
  redis:
    image: redis:7
    command: ["redis-server", "--save", "900", "1", "--appendonly", "yes"]
    ports:
      - "6379:6379"
    volumes:
      - ./data:/data
    restart: unless-stopped
```
- 컨테이너에서 설정 확인:
```bash
docker exec -it <container_id> redis-cli INFO memory
docker exec -it <container_id> redis-cli CONFIG GET maxmemory
```

성능 확인 팁

- p99 latency는 실무에서 중요: monitor latency with redis-cli --latency or Redis latency command
  ```bash
  redis-cli --latency
  redis-cli LATENCY LATEST
  ```
- 대량 쓰기/읽기 시 파이프라이닝과 배치 사용을 권장. 예:
  ```python
  # redis-py 예시: pipeline
  pipe = redis.pipeline()
  for k,v in data.items():
      pipe.set(k, v)
  pipe.execute()
  ```
- 큰 value(예: 1MB 이상의 JSON)을 쓰지 않는 것이 보통 유리. MEMORY USAGE로 평균값을 측정해 용량 산정.

관측 가능성(Observability) 구성 제안

- 메트릭: Redis Exporter(별도 프로세스) + Prometheus + Grafana로 keyspace_hits, misses, used_memory, evicted_keys, instantaneous_ops_per_sec, blocked_clients, replication lag 등을 수집.
- 로그: redis 로그 레벨, RDB/AOF 에러, OOM 로그를 중앙 로그 수집(예: ELK 또는 Loki)로 보관.
- 알림: evicted_keys 급증, used_memory_close_to_maxmemory, keyspace_misses 비율 상승, replication lag 증가 등은 알람 대상.

![Redis 모니터링을 나타내는 단순한 그래프와 아이콘 일러스트](/assets/img/posts/blog/redis-cache-checklist-before-adoption/image-2.webp)
이미지 출처: AI 생성 이미지

캐시 일관성에 관한 고민들

- 캐시 무효화 전략: TTL 기반, 이벤트 기반(데이터 변경 시 캐시 삭제), versioning(key version) 중 선택. 각각 장단점이 있어 트레이드오프가 필요합니다.
- 캐시 스탬피드(동시성 캐시 미스 폭주) 방지: mutex(분산 락), request coalescing, probabilistic early expiration(일부 키를 미리 만료) 같은 기법을 고려하면 좋습니다.
- 데이터 모델과 직렬화: JSON, MessagePack, ProtoBuf 등 직렬화 형식은 네트워크 전송량과 CPU 비용에 영향을 줍니다. 실무에서는 샘플 직렬화 성능을 측정해 선택하는 것이 좋습니다.

실무에서 바로 해볼 점검 절차 예시(간단 체크리스트적 순서)

1. Redis 버전과 configuration dump 확보
2. INFO memory, INFO stats 스냅샷 수집
3. 빈번하게 접근되는 키 네임스페이스 식별 (SCAN 샘플)
4. MEMORY USAGE 평균/최대값 계산
5. eviction 정책, maxmemory 설정 검토
6. persistence(AOF/RDB) 설정과 복구 테스트
7. 복제 및 HA 시나리오(페일오버) 시뮬레이션
8. 메트릭 수집/대시보드와 알람 설정
9. TTL과 무효화 정책 문서화
10. 부하 테스트를 통한 p95/p99 latency 측정 및 병목 확인

공부하며 알게 된 작은 팁들

- SCAN을 쓸 때 COUNT 값을 조절해 운영 중 영향 최소화.
- MEMORY USAGE로 개별 키 크기를 조사하면 예상 메모리 소모 추정에 큰 도움이 됨.
- 복제본(replica)은 읽기 전용으로 활용하면 캐시 레이어의 확장성이 좋아짐(단, 쓰기 일관성은 주의).
- 운영에서 Redis 장애 시 빠르게 서비스 복구하는 절차(예: snapshot을 이용한 복원, read-only 모드 확인)를 문서화해두면 당황을 줄일 수 있음.

마무리하며 — 조심스럽게 권하는 순서

1. 작은 규모(단일 인스턴스 + AOF/RDB + 모니터링)로 먼저 도입해 보세요.
2. 실제 트래픽 패턴(읽기/쓰기 비율, 객체 크기, key 분포)을 충분히 측정하세요.
3. 복제/HA 또는 Cluster 전환은 요구되는 가용성과 트래픽을 기준으로 단계적으로 진행하세요.

실무 체크리스트

- [ ] redis 버전 및 패치 레벨 확인
- [ ] maxmemory 설정과 실제 used_memory 비교
- [ ] eviction policy 확인 및 팀 합의
- [ ] KEY 네임스페이스별 접근 빈도와 평균 크기 측정(MEMORY USAGE)
- [ ] TTL 정책 문서화 및 샘플 분포 확인
- [ ] persistence(RDB/AOF) 설정 및 복구 테스트 수행
- [ ] 복제/HA(Sentinel/Cluster) 구성과 페일오버 테스트
- [ ] 모니터링: Redis Exporter → Prometheus → Grafana 대시보드 구성
- [ ] 알림(알람): evicted_keys, used_memory 고위험 임계치, replication lag
- [ ] 보안: 네트워크 접근 제어, TLS(필요 시), 인증(requirepass) 검토
- [ ] 성능 테스트: p95/p99 latency, throughput, 파이프라인/배치 적용 테스트

참고로 이 글은 제가 공부하면서 정리한 내용입니다. 환경과 요구사항에 따라 다른 선택이 필요할 수 있으니, 실제 도입 전에는 팀 내 리뷰와 작은 파일럿 적용을 권장합니다. 질문이나 함께 실험해보고 싶은 시나리오가 있으면 편하게 이야기해 주세요.