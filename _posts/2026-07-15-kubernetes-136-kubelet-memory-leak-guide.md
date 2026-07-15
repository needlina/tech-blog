---
title: "Kubernetes 1.36 업데이트 후 Kubelet 메모리 누수 의심 증상 해결 가이드"
slug: "kubernetes-136-kubelet-memory-leak-guide"
date: 2026-07-15 11:00:00 +0900
categories: [DevOps, Kubernetes]
tags: [kubernetes, kubelet, memory-leak, cgroup, devops]
image:
  path: /assets/img/posts/blog/kubernetes-136-kubelet-memory-leak-guide/preview.png
  alt: "Kubernetes 1.36 업데이트 후 Kubelet 메모리 누수 의심 증상 해결 가이드 썸네일"
---

## 오늘의 주제

Kubernetes 1.36 환경에서 kubelet 메모리 사용량이 계속 증가하거나 `failed to release memory charge` 같은 cgroup 관련 메시지가 보일 때 확인하는 순서

Kubernetes 클러스터를 운영하다 보면 애플리케이션 Pod의 OOMKilled보다 더 헷갈리는 상황이 있습니다. Pod는 눈에 띄게 죽지 않았는데 노드 메모리가 계속 올라가고, kubelet 프로세스의 RSS가 점점 커지거나, 시스템 로그에 cgroup 메모리 관련 메시지가 남는 경우입니다.

이번 글은 Kubernetes 1.36 업데이트 이후 `kubelet cgroup memory leak: failed to release memory charge` 또는 `Kubelet memory usage keeps increasing without OOM` 같은 키워드로 원인을 찾는 상황을 기준으로 정리했습니다. 다만 이 문구 하나만으로 "Kubernetes 1.36의 확정 버그다"라고 단정하기는 조심스럽습니다. 실제 운영에서는 kubelet, container runtime, Linux kernel, cgroup v1/v2, CSI/CNI, 노드의 systemd 설정이 함께 영향을 줄 수 있기 때문입니다.

공식 릴리스 페이지 기준으로 2026년 7월 현재 Kubernetes 1.36은 지원 중인 최신 minor 브랜치이고, 최신 패치 릴리스는 1.36.2입니다. 따라서 먼저 현재 클러스터가 정확히 어떤 패치 버전인지 확인하는 것부터 시작하는 편이 좋겠습니다.

## 증상 정리

제가 이런 유형의 문제를 본다면 먼저 아래처럼 증상을 나눠서 볼 것 같습니다.

- kubelet 프로세스 메모리 사용량이 시간이 지날수록 계속 증가한다.
- 노드의 `MemAvailable`이 줄어들지만 특정 Pod 하나가 OOMKilled로 잡히지는 않는다.
- kubelet 로그 또는 커널 로그에 cgroup, memory charge, failed to release 같은 표현이 보인다.
- Pod 생성/삭제가 잦은 노드에서 증상이 더 빨리 나타난다.
- containerd 또는 CRI-O 같은 runtime 프로세스도 함께 메모리가 증가한다.
- 노드 재부팅이나 kubelet 재시작 후에는 일시적으로 정상화된다.

처음에는 "kubelet 메모리 누수"라고만 생각하기 쉬운데, 실제로는 kubelet이 직접 잡고 있는 메모리인지, 커널 cgroup 메타데이터가 정리되지 않는 것인지, runtime이나 CSI 프로세스가 잡고 있는 것인지 구분해야 합니다.

## 공부하면서 알게 된 점

Kubernetes 노드에서 kubelet은 단순히 Pod를 실행하는 프로세스가 아니라 노드 상태 보고, Pod 상태 동기화, 볼륨 마운트, 컨테이너 runtime 호출, cgroup 관리, eviction 판단까지 여러 일을 합니다. 그래서 kubelet 메모리가 늘어났다고 해서 원인이 항상 kubelet 코드 한 군데에 있는 것은 아닌 것 같습니다.

특히 cgroup 관련 문제는 Linux 커널과 container runtime의 영향을 같이 받습니다. cgroup은 컨테이너별 리소스 사용량을 제한하고 추적하는 리눅스 기능인데, Pod가 생성되고 삭제될 때 이 리소스 계층도 함께 만들어지고 정리됩니다. 삭제된 Pod의 cgroup 흔적이 남거나 메모리 charge가 기대처럼 해제되지 않으면 노드 메모리 관점에서 이상하게 보일 수 있습니다.

또 하나 헷갈렸던 부분은 "OOM이 없는데 왜 메모리 문제인가"였습니다. OOMKilled는 컨테이너 또는 노드가 명확한 한계에 도달했을 때 나타나는 결과입니다. 그 전 단계에서는 kubelet RSS 증가, slab/cache 증가, cgroup 계층 잔류, systemd slice 누적 같은 형태로 먼저 보일 수 있습니다.

![kubelet, container runtime, cgroup, Pod 사이의 관계를 단순한 계층 구조로 보여주는 기술 일러스트](/assets/img/posts/blog/kubernetes-136-kubelet-memory-leak-guide/image-1.webp)
이미지 출처: AI 생성 이미지

## 1단계: 버전과 노드 범위 확인

먼저 문제가 모든 노드에서 생기는지, 특정 노드 풀에서만 생기는지 확인합니다.

```bash
kubectl version
kubectl get nodes -o wide
kubectl describe node <node-name>
```

노드에 직접 접근할 수 있다면 kubelet과 runtime 버전도 봅니다.

```bash
kubelet --version
containerd --version
crictl version
uname -a
systemctl status kubelet --no-pager
```

확인할 포인트는 다음과 같습니다.

- Kubernetes가 정말 1.36 계열인지
- 1.36.0, 1.36.1, 1.36.2 중 어떤 패치인지
- containerd 또는 CRI-O 버전이 무엇인지
- Linux kernel 버전과 cgroup v1/v2 사용 여부
- 증상이 특정 OS 이미지나 특정 노드 그룹에서만 나타나는지

관리형 Kubernetes라면 노드 이미지 버전도 중요합니다. 같은 Kubernetes 버전이어도 노드 OS 이미지와 runtime 버전에 따라 증상이 달라질 수 있기 때문입니다.

## 2단계: kubelet 메모리 증가가 맞는지 보기

노드에서 kubelet 프로세스의 RSS와 CPU 사용량을 시간 순서로 확인합니다.

```bash
ps -o pid,ppid,rss,vsz,cmd -C kubelet
top -p $(pidof kubelet)
```

systemd 환경에서는 아래처럼 확인할 수도 있습니다.

```bash
systemctl status kubelet --no-pager
systemd-cgtop
```

Prometheus를 쓰고 있다면 노드 단위로 아래 지표를 같이 봅니다.

```promql
process_resident_memory_bytes{job=~"kubelet|node-exporter"}
node_memory_MemAvailable_bytes
node_memory_Slab_bytes
container_memory_working_set_bytes
```

여기서 중요한 것은 "한 번 높아졌다"가 아니라 "계속 증가하고 내려오지 않는다"는 패턴입니다. 배포 직후나 Pod 대량 생성 직후에는 kubelet 메모리가 일시적으로 증가할 수 있습니다. 그래서 최소 몇 시간 단위의 그래프를 보는 편이 좋습니다.

## 3단계: kubelet 로그에서 단서 찾기

노드 로그에서 kubelet 관련 메시지를 봅니다.

```bash
journalctl -u kubelet --since "2 hours ago" --no-pager
journalctl -u kubelet --since "2 hours ago" --no-pager | grep -i "cgroup\|memory\|evict\|oom"
```

커널 로그도 함께 확인합니다.

```bash
journalctl -k --since "2 hours ago" --no-pager | grep -i "cgroup\|memory\|oom\|killed"
dmesg -T | grep -i "cgroup\|memory\|oom\|killed"
```

실제 에러가 아래처럼 보일 수 있습니다.

```text
kubelet cgroup memory leak: failed to release memory charge
```

또는 명확한 에러 없이 운영자가 관찰한 증상만 남을 수도 있습니다.

```text
Kubelet memory usage keeps increasing without OOM
```

이때 로그 한 줄만 보고 바로 kubelet 재시작으로 끝내기보다는, 같은 시간대에 Pod 생성/삭제가 많았는지, 특정 DaemonSet이 배포되었는지, 노드 압박 이벤트가 있었는지 같이 봐야 합니다.

```bash
kubectl get events -A --sort-by=.lastTimestamp
kubectl get pods -A --field-selector spec.nodeName=<node-name>
```

## 4단계: cgroup 잔여 흔적 확인

cgroup v2 환경에서는 보통 `/sys/fs/cgroup` 아래에서 계층을 볼 수 있습니다.

```bash
mount | grep cgroup
find /sys/fs/cgroup -maxdepth 4 -type d | grep kubepods | head
```

cgroup v1 환경이면 memory controller 경로가 따로 있을 수 있습니다.

```bash
find /sys/fs/cgroup/memory -maxdepth 4 -type d | grep kubepods | head
```

삭제된 Pod의 cgroup 디렉터리가 계속 남는지 확인하려면 현재 Pod UID와 비교해 봅니다.

```bash
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}' | sort > /tmp/live-pod-uids.txt
```

노드에서 cgroup 경로에 남은 UID를 뽑아 비교할 수 있습니다. 운영 환경에서는 이 작업도 읽기 중심으로 조심해서 해야 합니다.

```bash
find /sys/fs/cgroup -type d | grep kubepods | grep -Eo '[0-9a-f-]{36}' | sort -u
```

여기서 현재 존재하지 않는 Pod UID가 대량으로 남아 있고, 시간이 지나도 정리되지 않는다면 cgroup 정리 문제를 의심해볼 수 있습니다. 다만 시스템이 정상적으로 정리 중인 짧은 순간일 수도 있으니 반복 관찰이 필요합니다.

## 5단계: container runtime도 같이 확인

kubelet은 컨테이너를 직접 실행하지 않고 CRI를 통해 runtime에 요청합니다. 그래서 containerd나 CRI-O 상태도 함께 봐야 합니다.

```bash
systemctl status containerd --no-pager
journalctl -u containerd --since "2 hours ago" --no-pager | grep -i "cgroup\|memory\|task\|delete"
crictl ps -a
crictl pods
```

사용이 끝난 컨테이너나 sandbox가 비정상적으로 많이 남아 있는지도 봅니다.

```bash
crictl ps -a | wc -l
crictl pods | wc -l
```

Pod churn이 많은 노드에서는 종료된 컨테이너 기록이 어느 정도 남을 수 있습니다. 하지만 평소보다 비정상적으로 많고 정리가 되지 않는다면 kubelet의 garbage collection 설정이나 runtime 쪽 문제를 같이 봐야 합니다.

## 6단계: 임시 완화 방법

운영 중인 노드에서 메모리가 계속 증가해 장애 위험이 있다면, 원인 분석과 별개로 완화 조치가 필요할 수 있습니다.

가장 단순한 방법은 노드를 cordon/drain 후 kubelet 또는 노드를 재시작하는 것입니다.

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
sudo systemctl restart kubelet
kubectl uncordon <node-name>
```

노드 자체가 불안정하다면 재부팅이 더 안전할 수도 있습니다.

```bash
sudo reboot
```

다만 이 방법은 원인을 제거하는 것이 아니라 일시적으로 상태를 비우는 조치입니다. 같은 워크로드가 다시 올라가면 재발할 수 있습니다. 그래서 재시작 전에 로그, 버전, 메모리 그래프, cgroup 경로 샘플을 남겨두는 편이 좋습니다.

![노드 메모리 사용량 그래프와 점검 단계가 함께 배치된 장애 대응 흐름 일러스트](/assets/img/posts/blog/kubernetes-136-kubelet-memory-leak-guide/image-2.webp)
이미지 출처: AI 생성 이미지

## 7단계: 재발 방지를 위한 운영 점검

Kubernetes 1.36 계열에서 이런 현상을 봤다면 저는 아래 순서로 장기 대응을 잡을 것 같습니다.

1. 1.36 최신 패치로 올릴 수 있는지 확인합니다.
2. 관리형 Kubernetes라면 노드 이미지와 runtime 패치가 나왔는지 확인합니다.
3. 특정 노드 풀에서만 발생하면 새 노드 풀을 만들어 워크로드를 옮겨 비교합니다.
4. Pod 생성/삭제가 많은 Job, CronJob, CI runner, autoscaling 워크로드를 별도로 봅니다.
5. kubelet, containerd, kernel 로그를 같은 시간축으로 묶어 봅니다.
6. cgroup v1/v2, systemd driver 설정이 클러스터 권장값과 맞는지 확인합니다.

container runtime의 cgroup driver가 kubelet과 맞지 않으면 이상 증상이 생길 수 있습니다. 예를 들어 systemd 기반 노드에서는 kubelet과 runtime이 모두 systemd cgroup driver를 쓰는지 확인하는 식입니다.

```bash
ps aux | grep kubelet | grep cgroup
containerd config dump | grep -i systemd
```

환경마다 명령어와 설정 위치가 다를 수 있으니, 배포 도구(kubeadm, EKS, GKE, AKS, Rancher 등)의 권장 설정을 같이 확인해야 합니다.

## 처음에는 헷갈렸던 부분

저는 이런 이슈를 볼 때 "Pod 메모리 limit을 늘리면 해결되지 않을까"라고 생각하기 쉬웠습니다. 그런데 kubelet 자체 또는 노드 cgroup 계층 문제가 원인이라면 애플리케이션 Pod limit만 조정해도 해결되지 않을 수 있습니다.

또 "노드 메모리 cache가 늘어난 것"과 "정말 누수"를 구분하는 것도 중요했습니다. Linux는 남는 메모리를 cache로 쓰기 때문에 `free -m`에서 used가 높게 보여도 실제로는 회수 가능한 메모리일 수 있습니다. 그래서 `MemAvailable`, kubelet RSS, slab, cgroup 디렉터리 잔류, 이벤트를 같이 봐야 합니다.

## 실무 체크리스트

- [ ] Kubernetes와 kubelet 패치 버전을 확인했다.
- [ ] 증상이 전체 노드인지 특정 노드 풀인지 구분했다.
- [ ] kubelet RSS가 시간에 따라 계속 증가하는지 그래프로 확인했다.
- [ ] kubelet, containerd, kernel 로그에서 cgroup과 memory 관련 메시지를 확인했다.
- [ ] Pod 생성/삭제가 많은 워크로드가 같은 시간대에 있었는지 확인했다.
- [ ] cgroup v1/v2와 cgroup driver 설정을 확인했다.
- [ ] 임시 조치 전 로그와 메트릭을 저장했다.
- [ ] cordon/drain 후 kubelet 재시작 또는 노드 교체로 완화할 수 있는지 검토했다.
- [ ] 최신 Kubernetes 패치, 노드 이미지, container runtime 패치 여부를 확인했다.

## 참고 자료

- [Kubernetes Releases](https://kubernetes.io/releases/) - Kubernetes 1.36 지원 브랜치, 최신 패치 릴리스, EOL 확인에 참고했습니다.
- [Kubernetes: About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/) - kubelet과 container runtime이 cgroup을 통해 Pod/컨테이너 리소스를 관리한다는 배경을 확인할 때 참고했습니다.
- [Kubernetes: Configuring a cgroup driver](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/configure-cgroup-driver/) - kubelet과 container runtime의 cgroup driver 정합성을 확인하는 부분에 참고했습니다.

kubelet 메모리 증가는 단일 명령 하나로 바로 해결하기 어려운 편인 것 같습니다. 특히 Kubernetes 1.36처럼 최신 버전에서는 실제 버그, 노드 이미지 이슈, runtime 조합 문제가 섞일 수 있으니 "재시작으로 끝"이 아니라 버전, 로그, cgroup, runtime, 워크로드 패턴을 같이 남겨두는 방식이 가장 안전하다고 정리했습니다.
