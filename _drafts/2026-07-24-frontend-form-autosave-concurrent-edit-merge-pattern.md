---
title: "프론트엔드 폼 자동저장 동시편집: 클라이언트-서버 병합 패턴 정리"
description: "자동저장 폼에서 발생하는 동시편집 충돌을 클라이언트-서버 병합으로 줄이는 설계 요약, API/DB 검증 명령, 패치 형식 비교, 충돌 식별·해결 절차와 실무 체크포인트"
slug: "frontend-form-autosave-concurrent-edit-merge-pattern"
date: 2026-07-24 12:00:00 +0900
categories: ["Frontend", "Backend"]
tags: ["javascript", "optimistic-concurrency", "conflict-resolution", "동시편집", "폼자동저장"]
image:
  path: /assets/img/posts/blog/frontend-form-autosave-concurrent-edit-merge-pattern/preview.png
  alt: "폼 자동저장 병합 썸네일"
---

로컬에서는 자동저장이 잘 되는데 여러 사용자가 거의 동시에 같은 폼을 변경하면 한쪽 데이터가 덮어써지는 일이 생깁니다. 이 문제에 대응하는 한 가지 실무 패턴은 클라이언트가 변경의 '기준 버전(baseVersion)'과 델타(패치)를 서버로 보내고, 서버가 이를 현재 상태와 병합하거나 충돌을 알려주는 방식입니다; 핵심 확인 포인트는 버전 관리, 패치 형식(필드 단위 또는 JSON Patch), 서버 병합 규칙, 그리고 사용자에게 보여줄 최소한의 충돌 피드백입니다.

왜 이 문제가 자주 헷갈렸는지, 그리고 제가 공부하면서 정리한 실무적 포인트들을 차근차근 적어볼게요.

문제 상황 예시: 두 사용자가 같은 글을 편집 중이고 클라이언트가 5초마다 자동저장하는 구조라면, A가 내용을 바꾸고 자동저장하고 난 직후 B가 바꾸면 B의 자동저장이 A의 최신 변경을 덮어쓸 수 있어요. 로컬 테스트로는 재현이 어려운 타이밍 이슈입니다.

핵심 개념 요약
- 클라이언트는 편집을 시작할 때 서버 상태의 식별자(예: version, etag, revision)를 가져옵니다.
- 자동저장 요청은 "baseVersion + patch" 형태로 보냅니다.
- 서버는 baseVersion과 현재 버전(currentVersion)을 비교해 단순 적용, 자동 병합(예: 필드 병합), 혹은 충돌 응답(merge needed)을 결정합니다.
- 클라이언트는 서버 응답에 따라 UI에서 최소한의 사용자 확인(충돌 알림 또는 부분 병합 반영)을 합니다.

자동저장(autosave) 동작 흐름 (간단)
1. 클라이언트 로드: GET /forms/:id -> { data, version }
2. 편집 중: 변경은 로컬 상태만 변경, debounce로 묶음
3. 자동저장: PATCH /forms/:id { baseVersion, patch }
4. 서버: 적용 가능 시 version++ 후 200 { version, data }; 충돌 시 409 { currentVersion, currentData, diff } 반환
5. 클라이언트: 200이면 로컬 버전 갱신, 409이면 병합 UI 또는 부분 적용

이미지로 개념을 한 번 더 보여줄게요.

![클라이언트와 서버가 baseVersion으로 교차 확인하는 구조 다이어그램](/assets/img/posts/blog/frontend-form-autosave-concurrent-edit-merge-pattern/image-1.webp)
이미지 출처: AI 생성 이미지

패치 형식 비교 (실무 선택 기준 표)
- 아래 표는 선택 기준·맞는 상황·피해야 할 상황·확인 방법 형태로 정리했어요.

| 선택 기준 | 맞는 상황 | 피해야 할 상황 | 확인 방법 |
|---|---:|---|---|
| JSON Patch (RFC6902) | 복잡한 중첩 객체 변경을 세부적으로 적용해야 할 때 | 간단 필드 편집만 있는 경우 (오버헤드) | 서버에서 jsonpatch 라이브러리로 적용 테스트 |
| 필드 레벨 델타 | 폼이 필드 중심(제목/본문/태그)일 때 | 필드가 많고 중첩 구조가 심할 때 | patch에 변경된 필드 목록 로그 확인 |
| 전체 덮어쓰기(LWW) | 동시 편집이 거의 없고 성능 우선일 때 | 데이터 손실이 치명적일 때 | 자동저장 빈도·충돌 건수 모니터링 |
| 서버측 커스텀 병합 | 도메인 규칙(예: 태그 합침)이 필요한 경우 | 구현 복잡도가 부담될 때 | 병합 결과 샘플 10건 비교 검증 |

설계 결정(간단 비교)
| 방식 | 장점 | 단점 |
|---|---|---|
| LWW (Last Writer Wins) | 구현 간단, 성능 좋음 | 데이터 손실 위험 |
| Optimistic concurrency + version check | 데이터 무결성 보장 가능 | 충돌 시 사용자 개입 필요 |
| Server-side merge (field-level) | 사용자 개입 최소화 | 구현 복잡, 도메인 로직 요구 |
| CRDT/OT | 자동 병합 강력 | 구현·운영 비용 큼 |

실패 증상 / 원인 / 확인 명령 / 조치 (실무용 표)
| 실패 증상 | 원인(가설) | 확인 명령 | 조치 |
|---|---|---|---|
| 덮어씀 발생 | 클라이언트가 baseVersion 없이 전체 덮어쓰기 | curl -v PATCH /forms/:id 로 요청 로그 확인 | baseVersion 추가, 서버에서 version 비교 적용 |
| 충돌 다수 발생 | 자동저장 주기가 짧음 | 서버 access log에서 PATCH 빈도 체크 | debounce 늘리기, 사용자 편집 중 자동저장 중지 옵션 |
| 서버 병합 실패(예외) | 병합 라이브러리 예외 | 서버 로그 grep 'merge' 또는 stacktrace 확인 | 병합 로직 예외 처리 추가, 재시도 전략 |

간단한 API/DB 예시 (실행 가능한 형태로)
- DB: PostgreSQL에서 버전 컬럼을 두고 낙관적 락을 적용하는 예

SQL: 버전 칼럼 추가
```
ALTER TABLE forms ADD COLUMN version bigint NOT NULL DEFAULT 0;
```

업데이트 쿼리 (낙관적 락)
```
-- 파라미터: $1 = new_jsonb, $2 = id, $3 = base_version
UPDATE forms
SET data = $1, version = version + 1
WHERE id = $2 AND version = $3;
-- 영향을 받은 행수(rowcount)로 성공 여부 판단
```

실패 예 (naive overwrite) — 클라이언트 코드(간단)
```js
// 실패: baseVersion 없이 전체 덮어쓰는 요청
async function autosaveNaive(formId, data) {
  await fetch(`/forms/${formId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  });
}
```

수정 예 (baseVersion 포함 + 필드 패치)
```js
// 좋은 예: baseVersion과 patch 전송
async function autosaveWithPatch(formId, baseVersion, patch) {
  const res = await fetch(`/forms/${formId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion, patch })
  });
  if (res.status === 200) {
    const body = await res.json();
    // 서버가 반환한 최신 버전으로 로컬 갱신
    return body;
  } else if (res.status === 409) {
    const conflict = await res.json();
    // 충돌 처리 UI로 전달
    throw new Error('conflict');
  } else {
    throw new Error('save failed');
  }
}
```

서버 측 병합(Pseudo Node.js + jsonpatch 적용 예)
```js
// server-side pseudo
const jsonpatch = require('fast-json-patch');

// request: { baseVersion, patch }
// forms.get(id) -> { data, version }
app.patch('/forms/:id', async (req, res) => {
  const { baseVersion, patch } = req.body;
  const row = await db.query('SELECT data, version FROM forms WHERE id=$1', [id]);
  if (!row) return res.status(404).end();

  if (baseVersion === row.version) {
    // 직접 적용
    const newData = jsonpatch.applyPatch(row.data, patch).newDocument;
    const result = await db.query(
      'UPDATE forms SET data=$1, version=version+1 WHERE id=$2 AND version=$3 RETURNING version',
      [newData, id, row.version]
    );
    if (result.rowCount === 1) return res.json({ version: result.rows[0].version, data: newData });
  } else {
    // 병합 로직: 단순 필드 병합 예
    const merged = shallowFieldMerge(row.data, jsonpatch.applyPatch(row.data, patch).newDocument);
    // 충돌 판단: merge 중 동일 필드 다른 변경이 있으면 충돌으로 표시
    const conflict = detectConflict(row.data, patch, baseVersion, row.version);
    if (conflict) {
      return res.status(409).json({ currentVersion: row.version, currentData: row.data, diff: conflict });
    }
    // 적용 후 저장
  }
});
```
(위 코드는 구조 설명용 의사 코드입니다. 실제 서비스로 사용하려면 트랜잭션/예외처리 추가가 필요합니다.)

충돌을 줄이기 위한 실무 팁 (제가 점검했던 체크포인트들)
- **자동저장 주기**는 사용자 경험과 충돌 빈도 사이의 트레이드오프 입니다. (예: typing debounce 500-1500ms, network autosave 5-20s)
- 편집 중인 필드가 명확하면 **필드 단위 패치**가 가장 실용적입니다(본문 전체보다 제목, 요약, 태그 등으로 나눔).
- 중요한 필드(예: 상태 변경, 승인)는 자동저장에서 제외하고 명시적 저장으로 처리하는 것도 고려하세요.
- 서버에서 병합 로직을 만들면 클라이언트가 덜 고려해도 되지만, **서버 병합 규칙은 문서화**하고 예외 케이스를 로깅하세요.
- 충돌 시 사용자에게 보여줄 최소한의 정보: 변경되지 않은 필드와 충돌 필드(원본/현재/로컬)를 간단하게 보여주면 좋습니다.

간단한 재현/테스트 방법 (curl로 동시성 테스트)
1. 클라이언트 A, B가 동일한 version을 가져옴
2. A 자동저장 (PATCH with baseVersion X)
3. B 자동저장 (PATCH with baseVersion X) -> 서버는 409 또는 병합 수행

예시 curl(동시저장 시뮬레이션)
```
curl -X PATCH -H "Content-Type: application/json" \
  -d '{"baseVersion":2,"patch":[{"op":"replace","path":"/title","value":"A 수정"}]}' \
  http://localhost:3000/forms/123

curl -X PATCH -H "Content-Type: application/json" \
  -d '{"baseVersion":2,"patch":[{"op":"replace","path":"/title","value":"B 수정"}]}' \
  http://localhost:3000/forms/123
```

![필드 레벨 병합과 충돌 알림을 보여주는 간단한 UI 일러스트](/assets/img/posts/blog/frontend-form-autosave-concurrent-edit-merge-pattern/image-2.webp)
이미지 출처: AI 생성 이미지

Q&A (자주 묻는 질문)
- 자동저장 주기는 얼마로 해야 하나요?
  - 답: 서비스 성격과 편집 빈도에 따라 다릅니다. 텍스트 편집이 활발하면 debounce 500~1500ms, 서버 autosave는 5~20초 범위를 실험해 보세요. 충돌 로그를 기준으로 조정합니다.
- JSON Patch 대신 간단한 필드 패치는 언제 쓰는 게 좋나요?
  - 답: 폼이 필드 중심이고 중첩 구조가 적으면 필드 패치가 구현·디버깅이 쉽습니다.
- 서버에서 자동 병합을 무조건 해도 되나요?
  - 답: 모든 경우에 안전하진 않습니다. 도메인 규칙이 명확하면 가능하지만, 모호한 변경(같은 문자열 필드 다른 변경)은 사용자 확인이 필요합니다.
- 낙관적 락에서 '버전'을 DB에서 어떻게 관리하나요?
  - 답: 정수(version) 컬럼을 두고 UPDATE WHERE version = baseVersion 후 rowcount로 성공 여부를 판단합니다. 실패하면 충돌 처리 루틴 실행합니다.
- CRDT/OT를 바로 도입해야 하나요?
  - 답: 폼 수준 단순 편집에는 과할 수 있습니다. 협업 텍스트(실시간 공동편집)가 핵심이라면 고려해볼 만합니다.
- 충돌 UI는 어떻게 설계해야 하나요?
  - 답: 가장 작은 단위로 충돌 필드만 표시하고, "서버 기준/내 수정/자동 병합 결과"를 보여주면 사용자 피로가 줄어듭니다.

검증 경로 및 로그 확인 방법(실무)
- DB: UPDATE rowcount 확인으로 낙관적 락 성공 여부 검증
- 서버 로그: PATCH 요청의 baseVersion과 처리 결과(200/409)
- 클라이언트: autosave 요청 타임스탬프, 패치 내용 로그(Debug)
- 배포 후 24-72시간 충돌 빈도(409 응답 수)를 모니터링

코드 예시에서 실패 사례와 수정 사례를 옆에 둔 이유는, 단지 좋은 예시만 보는 것보다 빠르게 문제를 찾을 때 도움이 되더라고요.

## 나의 의견 1
내 환경(프로젝트)에서 사용한 자동저장 주기와 버전 방식, 처음 실패했을 때의 구체 로그(요청/응답, rowcount)를 적어보세요.

## 나의 의견 2
현재 폼의 중요한 필드와 자동저장에서 제외해야 할 항목(또는 수동 저장으로 옮겨야 할 항목)을 목록으로 적어보세요.

실무 체크리스트
- 서버에서 version 컬럼 존재 확인: psql -c "\d forms" 또는 SELECT version FROM forms WHERE id=...; 확인
- 자동저장 시 baseVersion 포함 여부 로그 확인: 서버 access log에서 PATCH 요청 body 확인
- 낙관적 락 성공/실패 검증: UPDATE 쿼리 실행 후 rowcount 체크 (Postgres: client.rowCount)
- 동시성 재현 테스트: 위의 curl 스크립트로 2개 클라이언트 시나리오 실행(결과 200/409 기록)
- 병합 로직 예외 처리 검증: 서버 로그에서 merge 관련 예외/stacktrace 유무 확인
- 사용자 충돌 UI 동작 확인: 409 응답 시 UI가 정상적으로 충돌 필드와 선택지를 보여주는지 확인
- 롤백·복구 절차 문서화: 충돌 발생 시 이전 버전 복원 방법(예: DB 백업에서 특정 id 복구 명령) 작성
- 모니터링 알람 설정: 409 응답 비율이 특정 임계치(예: 전체 PATCH의 1% 이상)를 넘으면 알람 발생

마무리(무엇을 먼저 확인해야 하는지, 언제 다른 선택지가 나은지)
- 먼저 확인할 것: 클라이언트가 서버의 현재 버전을 받아오고 있는지, 자동저장 요청에 그 baseVersion이 포함되는지, 서버가 UPDATE 결과(rowcount)를 기반으로 낙관적 락을 처리하는지입니다.  
- 언제 다른 선택지를 고려할지: 폼이 단순하고 충돌이 경미하면 LWW를 택해도 되지만, 데이터 손실 우려가 크면 필드 패치 + 서버 병합 또는 사용자 확인 플로우가 낫습니다. 실시간 협업이 핵심이라면 CRDT/OT 도입을 고려하세요.

읽어주셔서 감사합니다. 이 흐름으로 제 프로젝트에 적용해보고, 재현 로그나 구체 명령 결과를 붙여주시면 함께 더 살펴볼게요.

## 함께 보면 좋은 글

- [React/Node.js 실행 오류 listen EADDRINUSE address already in use 3000 해결 방법](/posts/react-node-eaddrinuse-port-3000-fix/)
- [JWT on-behalf 패턴으로 OAuth2 클라이언트 시크릿 없이 백엔드 권한 위임하기](/posts/jwt-on-behalf-backend-delegation-without-client-secret/)
- [동시 대량 업로드로 인한 임시 파일·디스크 급증 대응 가이드](/posts/backend-concurrent-uploads-temp-disk-control/)
