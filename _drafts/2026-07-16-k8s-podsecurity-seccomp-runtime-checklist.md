---
title: "Kubernetes 보안 진입점 변경 대응: PodSecurity와 seccomp 점검 가이드"
slug: "k8s-podsecurity-seccomp-runtime-checklist"
date: 2026-07-16 12:00:00 +0900
categories: ["DevOps", "Security"]
tags: ["kubernetes", "podsecurity", "seccomp", "container-runtime", "news", "trend"]
image:
  path: /assets/img/posts/blog/k8s-podsecurity-seccomp-runtime-checklist/preview.png
  alt: "Kubernetes 보안 변경 썸네일"
---

오늘은 Kubernetes에서 보안 관련 정책이나 런타임 보안 설정(특히 PodSecurity 및 seccomp)으로 인해 애플리케이션이 동작하지 않거나 문제가 발생했을 때 어떤 점들을 확인하면 좋을지, 제가 공부하면서 정리한 내용을 공유하려고 합니다. 저는 초보 개발자의 시선으로 하나씩 배우며 정리하고 있어서, 완벽한 정답을 제시하는 목적이 아니라 실무에서 점검할 수 있는 체크 포인트와 예시들을 함께 나누려 합니다.

공부하면서 알게 된 점
- Kubernetes는 여러 계층에서 보안을 다룹니다. 네임스페이스 단위의 PodSecurity 정책(Admission), Pod/컨테이너의 securityContext, 그리고 컨테이너 런타임의 보안 구성(seccomp, AppArmor 등)이 서로 겹치면서 동작합니다.
- seccomp는 커널 수준에서 특정 시스템 콜을 필터링하는 기능이고, Kubernetes는 이것을 Pod/컨테이너 단위로 적용할 수 있게 합니다. 다만 적용 방식(어노테이션, securityContext.seccompProfile 등)은 클러스터 버전이나 설정에 따라 다를 수 있습니다.
- 최근 PodSecurity Admission(네임스페이스 라벨로 enforce/best-effort 등 지정)은 PodSecurityPolicy(PodSecurityPolicy는 deprecated)보다 간단하지만, 정책 수준에 따라 기존에 허용되던 Pod가 차단될 수 있습니다.
- 런타임(예: containerd, cri-o, Docker)의 기본 seccomp 동작과 클러스터의 정책(예: RuntimeDefault vs Localhost)은 서로 연관되어 있어서, 한쪽만 변경해도 예상치 못한 영향이 날 수 있습니다.

처음에는 헷갈렸던 부분
- "seccomp를 어디에 설정해야 하는가?"가 헷갈렸습니다. Pod 레벨 어노테이션, container 어노테이션, securityContext.seccompProfile 등 여러 방법을 봤고, 어떤 것이 현재 클러스터에서 실제로 적용되는지는 클러스터 버전과 admission controller에 따라 달라서 혼란스러웠습니다.
- PodSecurity Admission의 라벨 네이밍과 버전(enforce, audit, warn 및 enforce-version 등)이 여러 형태로 존재해서 네임스페이스에 어떤 규칙이 적용되는지 바로 파악하기 쉽지 않았습니다.
- 런타임별로 seccomp 지원과 기본 프로필 경로가 달라서, "이 설정은 containerd에서 동작하지만 Docker에서는 다르다" 같은 상황을 종종 마주했습니다.

실무에서는 이렇게 확인하면 좋겠다 (핵심 점검 절차)
아래 절차는 제가 실무에서 점검할 때 유용하다고 느낀 순서입니다. 환경에 따라 일부 단계는 건너뛸 수 있습니다.

1) 문제 재현 및 로그 확인
- 문제가 발생한 Pod의 이벤트/로그를 먼저 확인합니다.
  - kubectl describe pod <pod-name> -n <ns>
  - kubectl logs <pod-name> -n <ns> --all-containers
- 이벤트에 "FailedCreatePod", "CreateContainerError", "permission denied", "seccomp" 같은 키워드가 있는지 확인합니다.

2) 네임스페이스의 PodSecurity 라벨 확인
- PodSecurity Admission(네임스페이스 레벨)이 적용 중인지 확인:
  - kubectl get ns <ns> --show-labels
- 네임스페이스에 다음 라벨들이 있는지 확인해 봅니다:
  - pod-security.kubernetes.io/enforce
  - pod-security.kubernetes.io/audit
  - pod-security.kubernetes.io/warn
  - pod-security.kubernetes.io/enforce-version
- 예시:
  - kubectl label --overwrite ns my-namespace pod-security.kubernetes.io/enforce=restricted
  - kubectl label --overwrite ns my-namespace pod-security.kubernetes.io/enforce-version=latest
- 참고: 이 라벨로 인해 특정 필드(예: hostNetwork, privileged 등)가 차단될 수 있습니다. 어떤 필드가 차단되는지는 정책 레벨(baseline/restricted)을 확인해야 합니다.

3) Pod/컨테이너의 securityContext 및 seccomp 설정 확인
- Pod의 spec에서 securityContext, 각 컨테이너의 securityContext.seccompProfile 등을 확인합니다:
  - kubectl get pod <pod-name> -n <ns> -o yaml
- 예시(최신 권장 형태로 보이는 seccompProfile 사용 예):
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/my-seccomp.json
  또는
  securityContext:
    seccompProfile:
      type: RuntimeDefault
- 주의: 클러스터의 Kubernetes 버전이나 CRI 구현체에 따라 지원되는 타입(Localhost/RuntimeDefault/Unconfined)이 다를 수 있습니다.

4) 컨테이너 런타임 설정 확인 (노드 측)
- 각 노드에서 컨테이너 런타임(containerd, cri-o, docker 등)의 설정을 점검합니다. 예: containerd는 /etc/containerd/config.toml, cri-o는 /etc/crio/crio.conf 등.
- containerd 기본 config 예시 추출:
  - sudo containerd config dump > /tmp/containerd-config.toml
  - sudo systemctl status containerd
- Docker 예시(실행 시 seccomp 옵션 확인):
  - docker info | grep -i seccomp
  - docker inspect --format '{{json .HostConfig.SecurityOpt}}' <container-id>
- 런타임에서 기본 seccomp 프로필을 변경했는지, Localhost 프로필을 허용하는지(파일 경로 접근) 등도 확인합니다.

5) 커널/호스트 지원 확인
- seccomp는 커널 설정(예: CONFIG_SECCOMP, CONFIG_SECCOMP_FILTER) 필요성이 있으므로 호스트에서 해당 기능이 활성화되어 있는지 확인합니다.
  - uname -r
  - zgrep SECCOMP /proc/config.gz  # /proc/config.gz가 있으면
  - cat /boot/config-$(uname -r) | grep SECCOMP
- 프로세스의 /proc/<pid>/status에 Seccomp 값을 있어야 적용 여부를 확인할 수 있습니다(0: disabled, 1: strict, 2: filter).
  - 예: sudo lsns; sudo ps aux | grep <container-process> 처럼 PID를 알면
  - sudo cat /proc/<pid>/status | grep Seccomp

6) 런타임에서 seccomp가 실제로 적용되는지 간단히 테스트
- 간단한 seccomp 프로필(예: 특정 syscall 차단)을 만들어 컨테이너에서 적용해 보고, 기대한 동작(EPERM/ENOSYS 등)을 관찰합니다.
- 예시(매우 단순화한 seccomp JSON; 실제로는 더 많은 필드가 필요합니다):
  {
    "defaultAction": "SCMP_ACT_ALLOW",
    "syscalls": [
      {
        "names": ["chmod"],
        "action": "SCMP_ACT_ERRNO"
      }
    ]
  }
- 테스트(로컬 Docker에서 기본 예):
  - docker run --rm -it --security-opt seccomp=/path/to/profile.json ubuntu bash
  - 컨테이너 내에서 chmod를 실행해보고 실패하는지 확인
- Kubernetes에서는 위에서 보여준 securityContext.seccompProfile.type: Localhost와 profile 경로를 사용해야 하며, 런타임이 그 경로를 해석할 수 있어야 합니다.

7) PodSecurity admission으로 인한 거부 사유 확인
- admission에서 거부되는 경우, API 서버의 admission 로그(관리자 접근 가능 시)나 이벤트 메시지에 이유가 남는 경우가 있습니다.
- 네임스페이스 라벨을 임시로 완화해 문제를 재현하거나, 별도의 테스트 네임스페이스에서 허용 레벨을 낮춰서 원인을 좁힙니다.

간단한 예시 매니페스트
- PodSecurity가 엄격한 네임스페이스에서 seccomp를 Localhost 프로필로 적용한 Pod 예시(현장 상황에 따라 동작이 달라질 수 있으니 주의):
apiVersion: v1
kind: Pod
metadata:
  name: seccomp-test
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: "profiles/seccomp-test.json"
  containers:
  - name: busy
    image: busybox
    command: ["sh", "-c", "sleep 3600"]

주의: 위 localhostProfile 경로는 런타임(노드)이 읽을 수 있는 경로로 매핑되어야 합니다. 클러스터가 이를 지원하는지 확인해야 합니다.

운영에서 유의할 점과 권장하는 접근
- 변경 전: 변경을 적용하기 전에 테스트 네임스페이스에서 동일한 설정을 먼저 확인하세요. 운영 네임스페이스에 곧바로 엄격한 정책을 적용하면 서비스가 중단될 수 있습니다.
- 점진적 적용: PodSecurity의 enforce를 restricted로 바로 변경하기보다 먼저 audit/warn 레벨로 설정해서 어떤 Pod가 차단될지 로그로 확인하는 것이 안전합니다.
  - 예: kubectl label --overwrite ns my-namespace pod-security.kubernetes.io/audit=restricted
- 롤백 계획 수립: 정책으로 인해 배포가 실패할 경우를 대비해 네임스페이스 라벨을 되돌릴 수 있는 권한과 절차를 준비하세요.
- 문서화: 네임스페이스별로 어떤 PodSecurity 레벨을 적용하는지 문서화하면 추적이 쉬워집니다.

제가 공부하면서 느낀 한계와 주의
- Kubernetes의 seccomp 관련 API와 적용 방식은 버전마다 조금씩 달라질 수 있습니다. 여기에서 제시한 예시는 일반적으로 많이 쓰이는 방식과 점검 포인트를 모아놓은 것이지만, 실제 클러스터 버전에 맞춰 문서를 다시 확인하시는 것이 좋겠습니다.
- 런타임별 차이(containerd vs cri-o vs Docker 등)도 있어 한 줄의 체크리스트로 모든 환경을 커버하기 어렵습니다. 각 런타임 문서를 참고해 세부 설정을 확인하세요.

실무에서 유용한 추가 명령 모음(요약)
- 네임스페이스 라벨 보기:
  - kubectl get ns <ns> --show-labels
- Pod 상세 보기:
  - kubectl describe pod <pod> -n <ns>
  - kubectl get pod <pod> -n <ns> -o yaml
- 노드에서 런타임 확인:
  - sudo systemctl status containerd
  - sudo containerd config dump | head
  - docker info | grep -i seccomp
- 호스트 커널 seccomp 지원 체크:
  - uname -r
  - cat /boot/config-$(uname -r) | grep SECCOMP
- 프로세스의 seccomp 모드 확인:
  - sudo cat /proc/<pid>/status | grep Seccomp

마무리하며 — 제 개인적인 정리
제가 이번 주제에서 배운 핵심은 '보안은 여러 계층에서 겹쳐서 적용되며, 어느 한 계층에서 변경이 생기면 서비스 동작에 영향이 날 수 있다'는 점입니다. 그래서 실무에서는 "문제 발생 → Pod/네임스페이스 정책 확인 → Pod 스펙 보검 → 노드 런타임 확인 → 호스트 커널 확인"의 순서로 좁혀가면 비교적 빠르게 원인을 파악할 수 있었습니다. 다만 각 클러스터의 버전과 런타임 환경에 따라 세부 명령어나 필드 이름이 다를 수 있으니, 항상 문서와 테스트를 병행하는 것이 안전하다고 생각합니다.

## 관련 이미지 주제
1. Kubernetes 네임스페이스 레이블과 PodSecurity 플로우를 단순히 보여주는 계층 구조 다이어그램 한 장
2. seccomp가 시스템 콜 레벨에서 동작하는 개념을 아이콘과 화살표로 단순히 설명한 일러스트 한 장

## 실무 체크리스트
- [ ] 문제 Pod의 이벤트/로그(kubectl describe / kubectl logs) 확인
- [ ] 네임스페이스에 설정된 PodSecurity 라벨(enforce/audit/warn 및 version) 확인
- [ ] Pod/컨테이너의 securityContext 및 seccomp 프로필(securityContext.seccompProfile 또는 어노테이션) 검사
- [ ] 노드의 컨테이너 런타임 설정(containerd/cri-o/docker)에서 seccomp 관련 설정 확인
- [ ] 호스트 커널에서 seccomp 관련 CONFIG 옵션 활성화 여부 확인
- [ ] 샌드박스 환경에서 seccomp 프로필 적용 테스트(로컬/테스트 네임스페이스)
- [ ] 변경 적용 시 audit/warn 모드로 점진 적용 및 롤백 계획 마련
- [ ] 관련 변경 사항을 팀 문서로 기록(네임스페이스별 정책, 적용 이유, 테스트 결과)

읽어주셔서 감사합니다. 혹시 특정 클러스터 환경(예: GKE/AKS/EKS, containerd 버전 등)을 알려주시면 그 환경에 맞춘 점검 절차나 예시를 조금 더 구체적으로 정리해 보겠습니다.