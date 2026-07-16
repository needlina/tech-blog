---
title: "쿠버네티스 API 폐기 주기 점검과 실제 마이그레이션 전략 정리"
slug: "kubernetes-api-deprecation-migration-strategy"
date: 2026-07-16 12:00:00 +0900
categories: ["DevOps", "Cloud"]
tags: ["kubernetes", "api-deprecation", "migration", "news", "trend"]
image:
  path: /assets/img/posts/blog/kubernetes-api-deprecation-migration-strategy/preview.png
  alt: "Kubernetes 마이그레이션 썸네일"
---

오늘은 쿠버네티스에서 API(및 기능)의 폐기(deprecation) 주기를 점검하고, 실무에서 마이그레이션을 어떻게 접근하면 좋을지 정리해 보려고 합니다. 저는 아직 초보 개발자 입장에서 하나씩 확인하면서 정리하는 방식으로 글을 쓰고 있어요. 읽는 분과 함께 "공부하면서 알게 된 점", "처음에는 헷갈렸던 부분", 그리고 "실무에서는 이렇게 확인하면 좋겠다"를 단계적으로 적어 보겠습니다. 전문가처럼 단정적으로 말하기보다는, 제 경험과 공부한 내용을 바탕으로 조심스럽게 정리합니다. 틀릴 가능성이 있는 부분은 확정적으로 쓰지 않겠습니다.

이 글의 목적은
- 클러스터와 매니페스트에 남아있는 오래된(Deprecated) API를 찾아내는 방법
- 마이그레이션 우선순위를 정하는 방법
- 실무에서 점검해야 할 포인트(명령어, 설정 예시, 점검 절차)
를 정리하는 것입니다.

공부하면서 알게 된 점
- 쿠버네티스는 API 그룹/버전 변경이 종종 일어나고, deprecated로 표시된 API는 이후 릴리스에서 제거될 수 있습니다. 따라서 클러스터 운영자는 릴리스 노트와 deprecation 관련 경고를 주기적으로 확인할 필요가 있습니다.
- 매니페스트의 apiVersion을 바꾸는 것만으로 충분하지 않은 경우가 있습니다(예: Deployment apps/v1로 옮기면서 selector가 필요해진 경우).
- 클러스터에서 어느 리소스가 어떤 apiVersion으로 동작하는지(특히 서드파티 CRD)는 점검이 조금 더 복잡합니다.

처음에는 헷갈렸던 부분
- "어떤 기간 후에 deprecated가 제거되는가"에 대해 명확한 규칙을 찾기 어려웠습니다. 실제로는 쿠버네티스 릴리스 정책과 개별 API의 릴리스 노트를 확인하는 게 가장 확실합니다.
- 매니페스트와 클러스터 내 리소스(실제 객체)의 apiVersion을 혼동하기 쉽습니다. 매니페스트는 배포 시점의 문서이고, 클러스터에 이미 존재하는 오브젝트의 .apiVersion 필드도 확인해야 합니다.
- 관리형 클러스터(AKS/EKS/GKE)에서는 컨트롤플레인 로그 접근이 제한되는 경우가 있어, apiserver 로그로 deprecated 경고를 직접 확인하기 어려울 수 있다는 점을 최근에 알게 됐습니다.

기본 개념(간단히)
- apiVersion: 그룹과 버전을 의미. 예: apps/v1, extensions/v1beta1
- Deprecated(권장 중단): 문서상으로는 "곧 제거될 예정"으로 표기되지만 구체적인 제거 시점은 릴리스 노트 등을 확인해야 함
- 제거(Removed): 더 이상 클러스터에서 지원되지 않아 관련 요청이 거부됨

실무에서는 이렇게 확인하면 좋겠다 — 점검 절차 및 명령어 예시
아래는 실무에서 제가 자주 쓰려고 정리한 순서입니다. 환경에 따라 접근 권한(관리자 권한, 컨트롤플레인 접근 여부)이 달라질 수 있으니 상황에 맞게 조정하세요.

1) 클러스터에서 현재 지원하는 API 버전 목록 확인
- 간단하게 사용 가능한 API 버전/그룹을 확인할 수 있습니다.
```
kubectl api-versions
```
- 혹은 전체 API 트리를 보고 싶을 때:
```
kubectl get --raw /apis | jq '.'
```
(jq가 없으면 단순 조회만 해도 됩니다. Managed cluster에서는 이 엔드포인트 접근이 제한될 수 있습니다.)

2) 클러스터 내 리소스들이 어떤 apiVersion을 사용하고 있는지 확인
- 특정 리소스(예: Deployment)의 apiVersion 분포를 확인:
```
kubectl get deployments --all-namespaces -o json | jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name) \(.apiVersion)"' | sort
```
- 여러 리소스 타입을 자동으로 시도해보는 스크립트(권한 부족 오류는 무시):
```
for r in $(kubectl api-resources --verbs=list -o name); do
  echo "=== $r ==="
  kubectl get $r --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.apiVersion}{"\n"}{end}' 2>/dev/null || true
done
```
주의: 모든 리소스가 나열되지는 않을 수 있고, 일부는 네임스페이스가 아닌 리소스이므로 오류가 발생할 수 있습니다. 위 스크립트는 오류를 무시하도록 구성했습니다.

3) apiserver 로그에서 deprecated 경고 찾기 (가능한 경우)
- kube-apiserver를 Pod로 운영한다면(예: kubeadm 클러스터) 다음처럼 로그에서 Deprecated 관련 메시지를 찾을 수 있습니다.
```
kubectl -n kube-system logs <kube-apiserver-pod> | grep -i deprecated
```
- 관리형 클러스터에서는 이 로그 접근이 불가능할 수 있으므로, 대신 Controller나 Kubernetes 이벤트를 통해 확인하는 방법도 고려합니다.

4) 매니페스트 저장소(Repository)에서 deprecated API 찾기
- 간단한 grep:
```
grep -R "apiVersion: extensions/v1beta1" -n .
```
- 다양한 apiVersion 패턴을 찾아보려면:
```
grep -R "apiVersion: .*v1beta" -n .
```
- 더 좋은 방법은 전용 도구 활용(pluto, kube-no-trouble 등). 예를 들면:
  - pluto: 매니페스트와 클러스터를 스캔해 deprecated API를 알려주는 도구(환경에 따라 명령어와 옵션 확인 필요).
  - kube-no-trouble(knt): 클러스터와 매니페스트 둘 다 스캔하는 도구.
(도구 설치와 사용법은 각 프로젝트 문서를 확인하세요. 여기서는 도구 이름만 예시로 듭니다.)

5) CRD(커스텀 리소스)의 버전 점검
- CRD는 자체적으로 versions를 정의합니다. CRD의 spec 부분을 확인하세요.
```
kubectl get crd <crd-name> -o yaml
# 또는 모든 CRD의 version 목록
kubectl get crd -o json | jq -r '.items[] | .metadata.name + " : " + (.spec.versions | map(.name) | join(","))'
```
- CRD가 오래된 API를 의존하는 경우, CRD 제공자(오퍼레이터) 쪽에서 마이그레이션 가이드가 있는지 확인해야 합니다.

매니페스트 예시: Deployment 마이그레이션 (간단한 before/after)
- deprecated 예시 (과거):
```
apiVersion: extensions/v1beta1
kind: Deployment
metadata:
  name: nginx-dep
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.19
```
- 권장되는 형식 (apps/v1, selector 요구)
```
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.19
```
주의: apps/v1로 변경할 때 selector가 명시적으로 필요합니다. 과거 매니페스트에서 자동 생성되던 필드가 이제는 요구될 수 있어 변경 후에 적용 전에 검증(test cluster 등)해야 합니다.

마이그레이션 전략(우선순위 및 단계)
1) 인벤토리 작성: 매니페스트 저장소(코드), Helm 차트, 클러스터 내부 객체(CR, Deployment 등)를 모두 목록화
2) 위험도 분류: 프로덕션 영향도, 롤백 용이성, 오퍼레이터/서드파티 의존성 등을 기준으로 우선순위 지정
3) 자동화 검사 추가: CI 단계에서 deprecated API 스캔을 추가해 새 커밋이 문제를 만들지 않도록 함
4) 변환 및 테스트: 변환 스크립트(또는 수동)로 매니페스트를 업데이트하고, 스테이징/개발 클러스터에 배포해 동작 검증
5) 점진적 배포: 한 네임스페이스/서비스씩 적용하며 모니터링(로그, 이벤트, 메트릭)을 통해 이상 여부 확인
6) 문서화 & 롤백 플랜: 변경 사항을 문서화하고, 문제가 있을 경우 이전 매니페스트로 빠르게 복원하는 절차를 마련

실무에서 체크할 포인트(운영자 관점)
- 릴리스 노트 확인: 쿠버네티스의 마이너 버전 릴리스 노트에서 Deprecated/Removed API 목록을 확인
- 컨트롤플레인 접근성: apiserver 로그 접근 가능 여부와 대체 감지 방법(경고 이벤트, 컨트롤러 로그 등)
- 서드파티 의존성: 오퍼레이터/컨트롤러가 deprecated API를 호출하고 있지 않은지 확인(업데이트가 필요할 수 있음)
- CI 통합: PR/MR 레벨에서 deprecated API 검사 도구를 돌려 미리 감지
- 백업 및 복원 정책: 리소스를 변경하기 전 스냅샷/백업(예: etcd 백업이나 리소스 YAML 백업)을 확보
- 모니터링/알림: 변경 후 리소스 재시작, CrashLoop, API 거부(Forbidden/NotFound) 등을 모니터링하여 빠르게 대응

간단한 CI 검사 예시 (GitHub Actions 의사 예시)
- PR이 들어왔을 때 매니페스트 디렉터리를 스캔하는 워크플로(플러그인/도구 사용 권장).
- 예: pluto 또는 kube-no-trouble를 설치해 실행하는 단계 추가

제가 공부하면서 시도해 본 도구들(비교적 초보자가 접근하기 쉬움)
- pluto: 매니페스트와 클러스터에서 deprecated API를 탐지
- kube-no-trouble(knt): 클러스터와 매니페스트를 스캔
- kubectl + jq 스크립트: 의존성이 적고 커스터마이징이 쉬움

주의 및 팁
- 변경 전에 스테이징/개발 환경에서 먼저 적용해 보세요. 운영 환경에서 바로 대규모 마이그레이션을 시도하는 것은 위험할 수 있습니다.
- managed Kubernetes(GKE/AKS/EKS)에서는 컨트롤플레인 접근이 제한되므로, 제공되는 마이그레이션 가이드나 지원 채널을 활용하세요.
- API 버전 변경은 단순 치환이 아니고, 필드 구조가 바뀌는 경우가 꽤 있습니다. spec 필드들(특히 selector, strategy 등)을 꼼꼼히 비교하세요.

공부하면서 알게 된 점(요약)
- deprecated API를 자동으로 찾아주는 도구를 CI에 넣어두면 장기적으로 수고를 덜 수 있습니다.
- 매니페스트와 클러스터 내부 오브젝트 모두 점검해야 하며, CRD는 별도로 검토가 필요합니다.
- apiserver 로그에 deprecated 경고가 남는 경우가 있어 가능한 접근 권한을 얻어두면 편합니다(불가능하면 대체 방법 마련).

처음에는 헷갈렸던 부분(요약)
- 어느 시점에 API가 제거되는지에 대한 일반 규칙이 명확하지 않아 릴리스별 확인이 필요합니다.
- 단순 apiVersion 치환으로 끝나지 않을 수 있다는 점(추가 필드 요구 등)이 헷갈렸습니다.

마지막으로 조심스러운 권장 절차(제 개인적인 정리)
1. 코드/매니페스트 저장소를 스캔해 deprecated 항목 목록화
2. 클러스터에서 실제 사용 중인 apiVersion 목록 스캔
3. CRD 및 오퍼레이터 종속성 확인
4. 우선순위(프로덕션 영향 큰 것부터) 정해 스테이징에서 변환 및 테스트
5. CI에 자동 스캔을 추가해 지속적으로 감시

## 관련 이미지 주제
1. 쿠버네티스 API 그룹과 버전 흐름을 단순화한 다이어그램 (원형으로 그룹-버전 전환 표시)
2. 마이그레이션 워크플로(인벤토리 → 변환 → 테스트 → 배포)를 단계별 아이콘으로 표현한 일러스트

실무 체크리스트
- [ ] 릴리스 노트에서 이번 릴리스의 Deprecated/Removed API 목록 확인
- [ ] 코드 저장소(Helm 포함)에서 deprecated apiVersion 검색 및 목록화
- [ ] 클러스터 내부 리소스(apiVersion 포함) 스캔 스크립트 실행
- [ ] CRD의 versions와 컨트롤러 의존성 확인
- [ ] 스테이징에서 변환된 매니페스트 적용 및 동작 검증(로그, 이벤트, 메트릭 확인)
- [ ] CI 파이프라인에 deprecated API 검사 도구 추가
- [ ] apiserver/컨트롤플레인 로그에서 deprecated 경고 감지(가능하면)
- [ ] 롤백 플랜과 etcd 또는 리소스 백업 절차 확인

참고로 이 글은 제가 학습하면서 정리한 초안입니다. 상황에 따라 추가 검증이나 더 구체적인 운영 절차(특히 관리형 클러스터의 제약 관련)가 필요할 수 있으니, 팀/업체의 운영 정책을 따르면서 진행하세요.