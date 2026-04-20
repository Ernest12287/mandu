---
title: "ATE Phase B — Boundary Probe + Memory + Impact 실행 스펙"
status: ready-for-implementation
audience: Mandu core team + implementer agent
created: 2026-04-21
supersedes: "roadmap-v2-agent-native.md §7 Phase B (3 bullets)"
prerequisite: "Phase A.1 / A.2 / A.3 완료"
---

# Phase B — 실행 스펙 (Boundary + Memory + Impact)

> Phase A 가 "agent 가 Mandu-idiomatic spec 을 짤 수 있게 한다" 였다면, Phase B 는 **"agent 가 의미 있는 adversarial + history-aware spec 을 짤 수 있게 한다"**.
>
> 2 주. 3 산출: `mandu_ate_boundary_probe`, `mandu_ate_memory`, `mandu_ate_impact` (v2).

---

## B.1 Boundary Probe — Zod Contract → Deterministic Boundary Set

### 목적
Contract 가 선언한 제약 (min/max/email/enum 등) 의 **경계값** 을 자동 생성. LLM 없이 결정론적. Agent 는 이 boundary set 을 `mandu_ate_prompt({kind: "property_based"})` 컨텍스트로 받아 spec 생성.

### MCP Tool

```ts
mandu_ate_boundary_probe({
  contractName: string,
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",  // default: 모든 method
  depth?: number,  // nested object 까지 파고들 depth. default 1, max 3
})
→ {
  contractName: string,
  graphVersion: string,
  probes: Array<{
    field: string,           // "email", "user.age", "items[].price"
    category: "valid" | "invalid_format" | "boundary_min" | "boundary_max" |
              "empty" | "null" | "type_mismatch" | "enum_reject" | "missing_required",
    value: unknown,
    expectedStatus?: number, // contract response 에서 derived (400 for invalid, 200 for valid)
    reason: string           // "email regex fail: 'not-an-email'"
  }>
}
```

### Zod Type → Boundary 매핑 (v1)

| Zod 타입 | 생성되는 probes |
|---|---|
| `z.string()` | `""` (empty), `" "` (whitespace-only), `"a".repeat(10001)` (obvious overflow) |
| `z.string().min(N)` | `"a".repeat(N-1)` (under), `"a".repeat(N)` (exact), `""` (empty) |
| `z.string().max(N)` | `"a".repeat(N)` (exact), `"a".repeat(N+1)` (over) |
| `z.string().email()` | `"not-an-email"`, `"@b.com"`, `"a@"`, `"a@b"`, `"valid@example.com"` (pass) |
| `z.string().uuid()` | `"not-a-uuid"`, 1 real v4 uuid, 1 real v7 uuid, `""`, `"00000000-..."` (all zero) |
| `z.string().regex(re)` | regex 분석 — 간단한 character class 는 violating 값 생성. 복잡하면 `"__invalid__"` |
| `z.number()` | `0`, `-1`, `Number.MAX_SAFE_INTEGER + 1`, `NaN`, `Infinity`, `"42"` (string type mismatch) |
| `z.number().int()` | `1.5`, `0.0001` (non-int violations) + number 케이스 |
| `z.number().min(N)` | `N-1`, `N`, `N+1` |
| `z.number().max(N)` | `N-1`, `N`, `N+1` |
| `z.boolean()` | `true`, `false`, `"true"` (type mismatch), `1` (type mismatch) |
| `z.enum([...])` | 각 valid 값 1 개씩 + `"__not_in_enum__"`, `null` |
| `z.array(T)` | `[]`, `[valid(T)]`, `[invalid(T)]`, `null` |
| `z.array(T).min(N)` | `[].slice(0, N-1)` (under) 추가 |
| `z.object({...})` | required 필드 1 개씩 빼기, extra 필드 (strict 모드면 fail, passthrough 면 pass) |
| `z.optional(T)` | `undefined` (valid), 내부 T 의 invalid 케이스들 |
| `z.nullable(T)` | `null` (valid), 내부 T 의 invalid 케이스들 |
| `z.union([A, B])` | A 의 valid, B 의 valid, 양쪽 reject 되는 값 (예: both string|number 인데 `true`) |
| `z.literal(v)` | `v` (pass), `v + "_"` / `v + 1` (fail) |

**규칙**:
- `Category: valid` 는 1 개 (minimum) 생성. Happy path.
- 나머지는 category 별 대표 1 개씩.
- `expectedStatus` 는 contract response 정의 스캔 후 derive. 없으면 `null`.

### 구현 위치
- `packages/ate/src/boundary/rules.ts` — 타입별 probe generator. 순수 함수.
- `packages/ate/src/boundary/index.ts` — `generateProbes(contract, method, depth)`.
- `packages/mcp/src/tools/ate-boundary-probe.ts` — MCP tool 등록.
- Tests: `packages/ate/tests/boundary-rules.test.ts` (각 Zod 타입당 1~2 tests), `packages/ate/tests/boundary-integration.test.ts` (실제 contract E2E).

### 사용 흐름 (agent 관점)

```
[사용자] "signup 엣지케이스 테스트 짜줘"
[agent → MCP]
  boundaries = mandu_ate_boundary_probe({ contractName: "SignupContract", method: "POST" })
  context = mandu_ate_context({ scope: "route", route: "/api/signup" })
  prompt = mandu_ate_prompt({ kind: "property_based", context: { ...context, boundaries } })
[agent → LLM]
  {prompt 포함 boundaries 13 probes} → spec 생성
[결과] 13 개 case 를 덮는 테스트 1 개. 각 case 는 probe.value 로 POST, probe.expectedStatus 로 assert.
```

### 비목표
- 무작위 fuzzing (fast-check 는 `kind: "property_based"` 프롬프트가 유도, probe 는 deterministic).
- 보안 payload (SQL injection / XSS) — Phase C 또는 별도 security-probe 도구.
- Depth > 3 nested object — 성능 + 무한 순환 위험.

---

## B.2 Memory — Agent Round-trip 이력 영속화

### 파일: `.mandu/ate-memory.jsonl`
- **append-only**, 한 줄 = 1 event JSON.
- 프로젝트 로컬 (decision §11 #3).
- `.gitignore` 에 자동 추가 (`mandu ate init` 실행 시).

### Event schema (v1)

```ts
type MemoryEvent =
  | { kind: "intent_history", timestamp: string, intent: string, routeId?: string, agent: string, resulting: { saved: string[] } }
  | { kind: "rejected_spec", timestamp: string, specPath: string, reason: string, routeId?: string }
  | { kind: "accepted_healing", timestamp: string, specPath: string, change: HealAction, confidence: number }
  | { kind: "rejected_healing", timestamp: string, specPath: string, change: HealAction, reason: string }
  | { kind: "prompt_version_drift", timestamp: string, kind: string, oldVersion: number, newVersion: number }
  | { kind: "boundary_gap_filled", timestamp: string, contractName: string, probes: number }
  | { kind: "coverage_snapshot", timestamp: string, routes: number, withSpec: number, withProperty: number };
```

### MCP tools

**`mandu_ate_recall`** (read)
```ts
Input: { intent?: string, route?: string, kind?: MemoryEventKind, limit?: number, sinceDays?: number }
Output: { events: MemoryEvent[], totalMatching: number }
```
- `intent` 매칭은 간단한 substring + token overlap 스코어 (embedding 없음).
- 기본 limit 10, sinceDays 90.

**`mandu_ate_remember`** (write)
```ts
Input: { event: MemoryEvent }
Output: { written: true, rotation?: { oldPath: string } }
```
- 파일 크기 10 MB 초과 시 자동 rotate → `.mandu/ate-memory.<timestamp>.jsonl.bak`.

### 자동 기록 지점
- `mandu_ate_save` 호출 성공 → `intent_history` event.
- `applyHeal()` 수락 → `accepted_healing`.
- `mandu_ate_run` 실패 해결 시 agent 가 `rejected_healing` 기록.
- 매일 첫 `mandu_ate_context` 호출 → `coverage_snapshot`.

### 프라이버시
- Intent 텍스트는 **원본 저장** (요약하지 않음 — agent 검색 정확도 우선). 사용자 책임 — commit 하지 않으면 외부 노출 없음.
- PII 자동 마스킹 **하지 않음** (false sense of security). 대신 `.gitignore` 강제.
- `mandu ate memory clear` CLI 로 전체 삭제 가능.

### 구현 위치
- `packages/ate/src/memory/store.ts` — append / read / rotate.
- `packages/ate/src/memory/recall.ts` — query + scoring.
- `packages/mcp/src/tools/ate-recall.ts`, `packages/mcp/src/tools/ate-remember.ts`.
- Tests: store (3), recall (5), MCP (3).

---

## B.3 Impact (v2) — Changed-File Aware Test Selection

### 기존
`mandu_ate_impact` 은 이미 존재 (`packages/ate/src/`). Phase B 는 **확장**.

### 확장 범위

#### 1. `git diff HEAD` 통합
- `mandu_ate_impact({ since: "HEAD~1" })` — 변경된 파일 경로 → 영향 받은 route id / contract id 매핑.
- 매핑 소스: Phase A.1 의 `spec-indexer` 에서 수집한 `@ate-covers:` + import resolution.

#### 2. Contract change 감지
- Contract 파일 diff → shape 변화 분류:
  - `additive` (새 field, optional) → 기존 spec pass, 새 boundary probe 제안.
  - `breaking` (required 추가, enum 축소) → 기존 spec 재검토 필요.
  - `renaming` (field rename) → healing 대상.

#### 3. 제안 액션

```ts
mandu_ate_impact({ since: "HEAD~1" }) →
{
  changed: { files: string[], routes: RouteId[], contracts: ContractId[] },
  affected: {
    specsToReRun: string[],
    specsLikelyBroken: Array<{ spec, reason }>,
    missingCoverage: Array<{ routeId, reason }>
  },
  suggestions: Array<{
    kind: "re_run" | "heal" | "regenerate" | "add_boundary_test",
    target: string,
    reasoning: string
  }>
}
```

#### 4. Watch 모드 (opt-in)
- `mandu ate watch` CLI — chokidar + debounce 1s, 변경 감지 시 `mandu_ate_impact` 자동 실행, 결과 stdout.
- 사용자 agent 가 watch 출력 파이프 받고 실시간 제안 가능.

### 구현 위치
- `packages/ate/src/impact/v2.ts` — git diff parser + classifier.
- `packages/mcp/src/tools/ate-impact.ts` — 기존 tool 업그레이드 (v1 output 유지하되 optional fields 추가, breaking change 아님).
- `packages/cli/src/commands/ate.ts` — `watch` subcommand 추가.
- Tests: 12+ (impact 분류, watch 통합, MCP passthrough).

---

## B.4 Prompt Catalog 확장

Phase A.3 가 3 개 (`filling_unit`, `filling_integration`, `e2e_playwright`) 배포. Phase B 에 3 개 추가:

1. **`property_based.v1.md`** — fast-check 기반. `mandu_ate_boundary_probe` 의 probe 를 fast-check arb 로 감싸는 패턴.
2. **`contract_shape.v1.md`** — `expectContract(res, contract.response[status])` primitive 사용 (Phase C 에서 shipping 하지만 프롬프트는 Phase B 에 준비 — 기존 assertion 으로 fallback 가능).
3. **`guard_security.v1.md`** — CSRF / rate-limit / session 테스트. `createTestSession`, rate-limit reset, CSRF token 주입 자동화.

각 ≤ 2000 토큰, English body, `<!-- EXEMPLAR_SLOT -->` 포함.

Exemplar 태깅 추가: 12+ (4 per kind).

---

## B.5 Coverage Metrics — Quantified Gap Report

### MCP tool 확장
기존 `mandu_ate_coverage` (있으면) 또는 신규:

```ts
mandu_ate_coverage({ scope?: "project" | "route" | "contract" }) →
{
  routes: {
    total: number,
    withUnitSpec: number,        // filling_unit kind
    withIntegrationSpec: number,
    withE2ESpec: number,
    withAnyKindOfSpec: number
  },
  contracts: {
    total: number,
    withBoundaryCoverage: number,  // probes 전부 spec 에 등장
    withPartialBoundary: number,   // 일부
    withNoBoundary: number
  },
  invariants: {
    csrf: "covered" | "partial" | "missing",
    rate_limit: "covered" | "partial" | "missing",
    session: "covered" | "partial" | "missing",
    auth: "covered" | "partial" | "missing",
    i18n: "covered" | "partial" | "missing"
  },
  topGaps: Array<{
    kind: "route_without_spec" | "contract_without_boundary" | "invariant_missing",
    target: string,
    severity: "high" | "medium" | "low",
    reason: string
  }>,
  graphVersion: string
}
```

### 계산 방법
- **withBoundaryCoverage**: contract 의 모든 probe (`boundary_probe` 생성 결과) 가 존재하는 spec 중 하나에서 등장 (probe.value 매칭 또는 probe.category 태그 매칭).
- **invariant**: route 에 해당 middleware 가 있고 해당 middleware 의 기대 동작 (e.g., CSRF reject) 을 테스트하는 spec 이 있는가.
- **severity**:
  - `high`: public API route without any spec, or contract without any boundary.
  - `medium`: authenticated route with only happy-path spec.
  - `low`: internal tooling route.

### 구현
- `packages/ate/src/coverage/compute.ts` — 순수 함수 (graph + spec index 입력 → metric 출력).
- `packages/mcp/src/tools/ate-coverage.ts`.

---

## B.6 Acceptance (Phase B 끝)

각각 E2E 검증:

1. `demo/auth-starter` 에서:
   - `mandu_ate_boundary_probe({ contractName: "SignupContract", method: "POST" })` → 10+ probes (empty email, invalid email, min password, etc.).
   - `mandu_ate_coverage({ scope: "project" })` → `contracts.withBoundaryCoverage: 0` (초기), `topGaps` 에 signup contract 등장.
   - Agent 가 boundary probe 로 spec 생성, save → 다시 coverage 호출 → `withBoundaryCoverage: 1`.
2. `git checkout -b exp && echo "" >> packages/core/src/filling/action.ts && git add -A && git commit -m "exp"` → `mandu_ate_impact({ since: "HEAD~1" })` → action.ts 관련 routes 전부 surfaced.
3. `mandu ate memory clear` → `.mandu/ate-memory.jsonl` 삭제 확인. `mandu_ate_recall` 호출 → `events: []`.

## B.7 Dependencies

- **A.1 완료**: ✅ (spec-indexer, context-builder, graphVersion 가 boundary / coverage / impact 전부에 필요).
- **A.2 완료**: graphVersion 포맷 + artifact store — memory event 에서 참조.
- **A.3 완료**: prompt-loader + exemplar-scanner 재사용 (property_based, contract_shape, guard_security).

---

## B.8 Out of Scope (Phase C 로)

- `expectContract` / `expectSemantic` / `waitForIsland` primitive 실제 구현 (Phase C.1~C.3).
- Live LLM oracle (Phase D).
- RPC route 지원 (확인 필요: 현재 extractor 가 `contract/rpc.ts` 스캔하는지 — 아니면 별도 Phase C 항목).
- Mutation testing (roadmap 언급했으나 phase 배정 안 됨 — Phase C 로).

---

## B.9 Estimated Effort

| 하위 단계 | 작업 | 일 |
|---|---|---|
| B.1 | Boundary probe + rules | 4 |
| B.2 | Memory store + recall MCP | 2 |
| B.3 | Impact v2 + git diff | 2 |
| B.4 | Prompt catalog +3 | 2 |
| B.5 | Coverage metrics | 2 |
| 문서 / 통합 테스트 | | 2 |

총 **2 주** (14 일). 단일 agent 로 큰 작업은 B.1 (boundary) 과 B.3 (impact). B.2 / B.5 는 상대적으로 작음 — 병렬 dispatch 가능.

---

## B.10 Open Questions (Phase B 시작 전)

1. **Depth 한도**: nested `z.object({ user: z.object({ ... }) })` 는 기본 1 로 끊음. 사용자가 명시적 `depth: 2` 주면 허용. 3 이 최대.
2. **Probe deduplication**: `z.string().email()` 과 `z.string().min(5).email()` 이 섞이면 email 케이스 중복 위험. **대응**: category 별 dedupe (같은 category 에서 같은 value 면 하나만).
3. **git diff source**: `mandu_ate_impact` 는 `since` 를 기본 `HEAD~1` 로. `staged` / `working` 옵션도 허용할지 — **Yes**, 3 개 모드.
4. **Memory event timestamp 형식**: ISO 8601 UTC (`Date.toISOString()`). 정렬 / filtering 용이.
5. **Coverage "invariant" 판정**: middleware 존재 + 해당 케이스 spec 존재로 판정. "해당 케이스" 인식 휴리스틱 — spec 이름/테스트 이름에 "csrf" / "rate limit" / "session" 포함 여부. **불충분하면** Phase B 후반에 refine.

---

*끝. 이 문서는 Phase B 착수 직전 재검토 필요 (A.3 산출 이후 context-builder 최종 형태에 맞춰 probe 출력 shape 조정할 수 있음).*
