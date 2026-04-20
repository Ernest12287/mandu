---
title: "ATE Phase C — Semantic Primitives + Mutation + RPC Parity 실행 스펙"
status: ready-for-implementation
audience: Mandu core team + implementer agent
created: 2026-04-21
supersedes: "roadmap-v2-agent-native.md §7 Phase C (4 bullets)"
prerequisite: "Phase A.1–A.3 + Phase B 완료"
---

# Phase C — 실행 스펙 (Semantic Primitives + Mutation + RPC Parity)

> Phase A/B 가 "agent 가 좋은 spec 을 쓸 수 있게" 였다면, Phase C 는 **"spec 이 쓸 수 있는 테스트 언어 자체를 Mandu 수준으로 풍부하게"**.
>
> 2 주. 4 영역: Semantic Primitives / Mutation Testing / RPC Parity / Oracle Queue.

---

## C.0 TL;DR

1. **Primitives**: `expectContract`, `expectNavigation`, `waitForIsland`, `assertStreamBoundary`, `expectSemantic`. Mandu 전용 assertion — generic library 대체 불가.
2. **Mutation**: Zod contract 기반 semantic mutation (required 제거 / type narrow / enum 축소 등). 일반 mutation testing 보다 20배 정확.
3. **RPC parity**: 현재 REST route 중심. `contract/rpc.ts` 기반 RPC 도 동등 지원.
4. **Oracle queue**: `expectSemantic` 결과를 agent 가 나중에 판정할 수 있게 큐에 쌓음. CI 는 `deterministic_only: true` 로 skip.

---

## C.1 Semantic Primitives

### C.1.1 `expectContract(actual, schema, options?)`

**목적**: Response body / 반환값이 Zod contract schema 에 부합하는지 검증. `JSON.stringify` 전체 비교 대체.

```ts
// 시그니처
expectContract<T>(actual: unknown, schema: z.ZodType<T>, options?: {
  mode?: "strict" | "loose" | "drift-tolerant",
  ignorePaths?: string[]  // ["createdAt", "id"] — timestamp / uuid 무시
}): asserts actual is T

// 구현 결과물
{
  status: "pass" | "fail",
  violations: Array<{
    path: string,       // ".user.email"
    expected: string,   // "email format"
    actual: string,     // "'not-an-email'"
    severity: "critical" | "warning"
  }>
}
```

**Mode 규칙**:
- `strict` (default): schema 와 100% 일치 (extra field = fail).
- `loose`: extra field 허용, missing required 만 fail.
- `drift-tolerant`: 모든 위반을 warning 으로 수집 (CI 실패 아님) + `mandu_ate_remember` 에 `contract_drift` event 자동 기록. 마이그레이션 기간용.

**위치**: `packages/core/src/testing/assertions.ts` — 기존 testing 배럴에 추가. `@mandujs/core/testing` subpath 로 export.

**테스트 10+**.

### C.1.2 `expectNavigation(page, expectation)`

**목적**: Playwright redirect chain / final URL 검증. `page.waitForURL` 단순 wrapping 아님 — **chain 전체 기록**.

```ts
expectNavigation(page, {
  from: "/",
  to: /\/kr(\/|$)/,
  redirectCount?: 1,        // exact
  maxRedirects?: 3,          // OR ≤
  timeoutMs?: number         // default 5000
})
```

**구현**: Playwright `page.on('framenavigated')` 훅 설치 → redirect chain 수집 → 최종 URL 비교 + chain 길이 검증.

**실패 시 failure.v1 JSON**: `kind: "redirect_unexpected"` + `chain: string[]`.

**테스트 8+**.

### C.1.3 `waitForIsland(page, name, options?)`

**목적**: Island 가 hydration 완료될 때까지 대기. `data-island="<name>"` + `data-hydrated="true"` 를 감시.

```ts
waitForIsland(page, "CartCounter", {
  timeoutMs?: 3000,
  state?: "hydrated" | "visible"  // default hydrated
})
```

**구현**: Mandu SSR 이 `data-island-state="pending"` 으로 emit, client/hydrate.ts 가 완료 시 `"hydrated"` 로 토글 (현재 이미 동작). Primitive 는 이 attribute 를 polling.

**Corner case**: `hydration:none` strategy 인 island 는 즉시 `hydrated` 로 간주.

**테스트 6+**.

### C.1.4 `assertStreamBoundary(response, expectations)`

**목적**: Streaming SSR 의 chunk boundary 검증. Suspense fallback → actual content 전환 시점 / 개수 검증.

```ts
const res = await fetch("/page", { /* 스트리밍 */ });
await assertStreamBoundary(res, {
  shellChunkContains: ["<!DOCTYPE", "<html"],
  boundaryCount: 2,                       // Suspense boundary 2 개
  firstChunkMaxSizeBytes?: 20_000,        // shell 크기 budget
  tailChunkContainsAnyOf?: ["<script", "islands"]
})
```

**구현**: `response.body` reader 로 chunk 단위 read, 각 chunk 를 accumulator 에 + boundary marker (`<!--$-->`, `<!--/$-->`) 카운트.

**실패 시 failure.v1**: `kind: "stream_boundary_mismatch"` (신규 kind, failure.v2 schema 도입).

**테스트 6+**.

### C.1.5 `expectSemantic(page, claim, options?)` — Agent 위임형

**목적**: "사용자가 로그인 성공을 명확히 인지한다" 같은 perceptual 판정. 런타임 LLM 호출 하지 않음.

```ts
expectSemantic(page, "사용자가 에러 메시지를 필드 옆에서 확인할 수 있다", {
  capture?: "screenshot" | "dom" | "both",  // default both
  deferToAgent?: boolean                     // default true
})
```

**동작**:
- `capture` 아티팩트 저장 (`.mandu/ate-oracle-queue/<runId>/<assertionId>/`).
- Queue 에 항목 추가: `{ assertionId, specPath, claim, artifactPath, status: "pending" }`.
- **Deterministic phase**: 항상 `pass` 반환 (runtime 실패 없음). CI 통과.
- **Agent phase (local dev session)**: `mandu_ate_oracle_pending()` 호출 → queue 항목 list → agent 가 screenshot + claim 을 LLM 에 넣어 판정 → `mandu_ate_oracle_verdict({ assertionId, verdict: "pass"|"fail", reason })`.
- `verdict: "fail"` 이면 memory 에 `semantic_regression` event 자동 기록 + 다음 run 에서 deterministic 실패로 promote 가능 (`promoteVerdicts: true` flag).

**CI 모드**: `MANDU_ATE_DETERMINISTIC_ONLY=1` → queue 적재만 하고 결과 기다리지 않음. Failure 조건 아님.

**이유**: `expectSemantic` 이 flaky 하면 배포 blocker 가 된다 → 기본 비-차단. Agent 가 오프라인에서 판정 → human-in-the-loop.

**테스트 8+**.

### C.1.6 사용 결정 트리 (프롬프트에 박을 내용)

```
Response body 구조 검증?
  ├─ yes → expectContract(res, schema)
Navigation / redirect?
  ├─ yes → expectNavigation(page, { from, to })
Island 타이밍?
  ├─ yes → waitForIsland(page, name)
SSR stream chunks?
  ├─ yes → assertStreamBoundary(res, { shellChunkContains, boundaryCount })
UI semantic claim ("사용자가 X 를 인지")?
  ├─ yes → expectSemantic(page, claim)  ← CI 에선 skip, local 에서 agent 판정
일반 DOM assertion?
  └─ Playwright 기본 (getByRole, getByLabel 등)
```

---

## C.2 Mutation Testing — Contract-Semantic Mutations

### C.2.1 왜 일반 mutation testing 으론 부족한가

**기존 tools** (Stryker, Mutode, Pit): 구문 단위 변환 (`a+b → a-b`, `> → >=`). Business logic 에 대한 "의미 있는 변형" 이 아님 → noise 가 많고 분석 낭비.

**Mandu 는 contract 가 있음**. Contract 에 선언된 semantic 을 깨뜨리는 mutation 만 주입하면 signal/noise 비가 압도적으로 좋음.

### C.2.2 Mandu-Contract Mutation Catalog

Operator 표 (v1):

| Mutation | 의미 | 탐지 가치 |
|---|---|---|
| `remove_required_field` | Response 에서 required 필드 삭제 | Contract 준수 spec 이 감지해야 함 |
| `narrow_type` | `z.string()` → `z.literal("x")` 만 리턴 | Contract 전체 허용 범위 검증 여부 |
| `widen_enum` | `z.enum(["a","b"])` → `"a" \| "b" \| "admin"` | Unknown enum 처리 spec |
| `flip_nullable` | non-null → `null` 반환 | Nullable 검증 누락 탐지 |
| `rename_field` | `userId` → `user_id` | snake/camel drift 탐지 |
| `swap_sibling_type` | `age: number` → `age: string` | 타입 엄격성 검증 |
| `skip_middleware` | csrf / rate-limit 일시 우회 | Security middleware test 커버 |
| `early_return` | Handler 첫 줄 `return Response.json({})` | Happy path exhaustive 검증 |
| `bypass_validation` | `contract.parse()` 생략 | Zod guard 검증 |

### C.2.3 실행 파이프라인

```
1. mandu_ate_mutate({ target: "packages/app/.../route.ts" })
   → 변형된 파일 1 개씩 임시 디렉토리에 쓰기 (원본 건드리지 않음)
   → 각 변형에 mutation id 부여

2. 각 변형에 대해:
   - mandu_ate_run({ spec: "tests/..." }) 로 테스트 실행
   - 결과: "killed" (테스트 실패 = mutation 탐지됨, 좋음) or "survived" (탐지 못함, 나쁨)

3. Report
   - mandu_ate_mutation_report()
   → {
       totalMutations: 47,
       killed: 39, survived: 6, timeout: 2,
       mutationScore: 0.87,
       survivorsBySeverity: [
         { id: "m-23", operator: "skip_middleware",
           targetFile: "...", reason: "no spec exercises csrf path" }
       ]
     }
```

**mutationScore ≥ 0.8** 가 health target. 3rd party 팀은 0.6 도 의미 있음.

### C.2.4 성능

- 파일 단위 병렬화. Playwright 없는 mutation 은 bun:test 단일 프로세스 안에서 수백 번 실행 가능 → 빠름.
- Playwright mutation 은 shard 로 분산 (Phase A.2 의 `shard` 옵션 재활용).
- 기본 타임아웃 2 분 / mutation — infinite loop 감지.

### C.2.5 구현 위치
- `packages/ate/src/mutation/operators.ts` — 각 operator pure function (AST in, AST out).
- `packages/ate/src/mutation/runner.ts` — 임시 디렉토리 + test 실행 + kill/survive 분류.
- `packages/mcp/src/tools/ate-mutate.ts`, `ate-mutation-report.ts`.
- Tests: operators (9, 각 operator 1), runner (5), MCP (4).

---

## C.3 RPC Parity

### C.3.1 현재 격차
- Phase A.1 extractor 는 `app/**/route.ts` (HTTP) 중심.
- `@mandujs/core/contract/rpc.ts` 로 선언한 **typed RPC** 는 graph 에 반영 안 됨.
- Boundary probe, coverage, context 전부 "REST 만" 지원.

### C.3.2 확장

- **Extractor**: `defineRpc({ procedures: { ... } })` 스캔. 각 procedure 를 `kind: "rpc_procedure"` node 로 graph 에 추가.
  - `route` node 에 상응 (HTTP POST `/rpc/<procedure>` 엔드포인트로 mount).
  - Contract (input/output Zod) 수집.
  - Middleware 체인 (RPC 자체 middleware + HTTP 계층 middleware) 공통화.

- **Context output**: `scope: "rpc"` 추가. `mandu_ate_context({ scope: "rpc", id: "users.signup" })` → 해당 procedure 의 input/output schema + middleware.

- **Boundary probe**: RPC procedure 의 input schema 를 동일 방식으로 probe. RPC/HTTP 구분 없음 (Zod 가 공통).

- **Prompt**: 신규 `rpc_procedure.v1.md` prompt — `createRpcClient<typeof router>()` 사용 패턴 + RPC-specific error handling.

### C.3.3 Exemplar
- RPC 테스트 스타일 exemplar 3+ 태깅 (Mandu 자체 RPC 테스트 찾아서).

### C.3.4 Tests
- `packages/ate/tests/rpc-extraction.test.ts` — 5 tests.
- `packages/ate/tests/rpc-boundary.test.ts` — 4 tests.
- `packages/mcp/tests/tools/ate-context-rpc.test.ts` — 3 tests.

---

## C.4 Oracle Queue — Agent-Delegated Semantic Judgment

### C.4.1 파일: `.mandu/ate-oracle-queue.jsonl`

Append-only, memory 와 별도 (oracle queue 는 work queue 성격, memory 는 history 성격).

```ts
type OracleEntry = {
  assertionId: string,
  specPath: string,
  runId: string,
  claim: string,
  artifactPath: string,
  status: "pending" | "passed" | "failed",
  verdict?: {
    judgedBy: "agent" | "human",
    reason: string,
    timestamp: string
  }
}
```

### C.4.2 MCP tools

- `mandu_ate_oracle_pending({ limit?: number })` — status=pending list.
- `mandu_ate_oracle_verdict({ assertionId, verdict, reason })` — agent 가 판정 후 기록.
- `mandu_ate_oracle_replay({ specPath })` — 해당 spec 의 과거 semantic verdict 전부 보기.

### C.4.3 CI 상호작용
- CI 에서 `MANDU_ATE_DETERMINISTIC_ONLY=1` → `expectSemantic` 은 항상 `status: "pending"` 으로 queue 만 쌓음.
- CI 파이프라인 종료 후 별도 local agent session 에서 소모.
- `promoteVerdicts: true` 옵션 — 과거 `failed` verdict 가 있으면 다음 `expectSemantic` 호출 시 deterministic 실패로 promote (회귀 방지).

### C.4.4 구현 위치
- `packages/ate/src/oracle/queue.ts`
- `packages/mcp/src/tools/ate-oracle-*.ts` (3 files)
- Tests: 10+.

---

## C.5 Prompt Catalog 확장 (Phase C)

신규 3 개:
1. **`island_hydration.v1.md`** — `waitForIsland` 활용, SSR-hydration timing 검증.
2. **`streaming_ssr.v1.md`** — `assertStreamBoundary` + Suspense/defer.
3. **`rpc_procedure.v1.md`** — RPC 전용 (C.3).

각 ≤ 2000 토큰. Exemplar 12+ (4 per kind).

---

## C.6 Acceptance (Phase C 끝)

1. `demo/auth-starter` 의 기존 signup spec 이 `expectContract(res, SignupResponse)` 을 사용하도록 lint-hint (`mandu_ate_save` lint-before-write 제안).
2. Mutation: `mandu_ate_mutate --target=app/api/signup/route.ts` → 5+ mutations, mutationScore 보고.
3. RPC: Mandu 자체 `demo/` 중 RPC 사용처에 `mandu_ate_context({ scope: "rpc", id })` → 완전한 procedure context 반환.
4. Oracle: `expectSemantic` 사용하는 spec 1 개 실행 → queue 에 pending 항목 추가 → `mandu_ate_oracle_verdict` 로 판정 → status 전환 확인.
5. Typecheck / 전체 테스트 green (전 패키지).

---

## C.7 Estimated Effort

| 하위 단계 | 작업 | 일 |
|---|---|---|
| C.1 | Primitives (5 개) | 5 |
| C.2 | Mutation operators + runner | 4 |
| C.3 | RPC parity (extractor + context + boundary) | 2 |
| C.4 | Oracle queue + 3 MCP tools | 2 |
| C.5 | Prompt catalog +3 | 1 |

총 **2 주** (14 일). C.1 과 C.2 가 일이 가장 많음 — 병렬 agent 2 개 (C.1+C.5 / C.2+C.3+C.4).

---

## C.8 Open Questions

1. **`expectContract` mode 기본값**: `strict` vs `loose`. 현재 로드맵은 `strict` — 하지만 기존 spec 에 `expectContract` 를 도입할 때 갑자기 실패 대량 발생 위험. **결정 필요**: 1~2 릴리즈 동안 `loose` 기본 → `strict` 전환 (breaking).
2. **Mutation 성능 budget**: 한 세션에 최대 몇 개 mutation 실행? 기본 50. 그 이상은 `--all` flag 필요.
3. **Oracle LLM 모델 정책**: agent 가 사용자 LLM 호출 (Phase D 의 opt-in local Ollama 와 별개). Mandu 자체는 모델 선택 안 함. 프롬프트만 제공.
4. **RPC 이름 규약**: `router.users.signup` dot notation vs `users.signup` 간결형. **결정**: dot notation full path 권장, mcp tool 은 둘 다 허용.
5. **Oracle verdict 인간 vs agent**: `judgedBy` 를 기록하되 강제 분리 안 함 (사람이 직접 에디터에서 판정도 가능).

---

## C.9 Out of Scope → Phase D

- Live local Ollama oracle (`MANDU_AI_ORACLE=ollama:...`).
- Vision model (`llava:7b`) screenshot 판정.
- Cloud-hosted oracle service.
- Regression learning (과거 verdict 학습 → 자동 판정).

Phase D 는 선택적. Phase C 완료 시 ATE v2 의 core surface 완성.

---

## C.10 Acceptance Metric Summary (Phase A+B+C 합산)

| 지표 | 목표 |
|---|---|
| Agent round-trip "테스트 짜줘" → 실행 가능 spec | P50 < 90 초 |
| Auto-heal 성공률 (selector_drift) | ≥ 70% deterministic |
| False-failure rate on auto-generated spec | ≤ 10% |
| Mutation score (Mandu 자체) | ≥ 0.80 |
| Contract boundary coverage (%contracts with full probe) | ≥ 60% |
| ATE 전체 테스트 카운트 | ≥ 550 (Phase A 시작 시 365) |

---

*끝. A.2/A.3 완료 후 C 진행 전에 `docs/ate/roadmap-v2-agent-native.md` §7 업데이트 필요 (Phase C 섹션을 본 문서로 치환).*
