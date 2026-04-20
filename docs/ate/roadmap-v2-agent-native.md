---
title: "ATE Agent-Native Evolution Plan"
status: proposal
audience: Mandu core team
created: 2026-04-21
bun_version: "1.3.12"
mandu_versions: "core@0.37.0 / cli@0.28.5 / ate@0.19.2"
supersedes: "ATE-ROADMAP-v1.md 의 auto-extract-우선 모델"
---

# ATE Agent-Native Evolution Plan (v2)

> 2026-04-20 이슈 #226~#229 4연타 + 사용자 피드백 ("사용자는 어차피 에이전트 쓰니까 우리가 필수 정보 제공하고 사용자 LLM이 짜게") 에서 촉발.
> ATE 를 **auto-extract-우선 생성기** 에서 **context-provider 중심의 agent-native 프로토콜** 로 전환.

---

## 0. TL;DR

1. **ATE 는 LLM 을 소유하지 않는다.** 사용자는 이미 Cursor / Claude Code / Codex 를 쓴다. 우리가 LLM API 키를 들고 있을 이유가 없다.
2. **ATE 는 agent 가 소비하는 context + prompt + diagnostics 를 제공한다.** MCP 위에서.
3. **프레임워크 고유 지식 (contract / filling / slot / island / guard preset / fixture) 을 큐레이트된 프롬프트로 공급** 한다. 이게 Next.js·Astro·SvelteKit 이 절대 따라 할 수 없는 차별화.
4. **기존 route-auto-extract 는 fallback** 으로 남기되, 기본 흐름은 "agent 가 context 읽고 프롬프트 받고 테스트 짜고 ATE 로 실행" 으로 이동.
5. **로드맵**: Phase A (MCP context + structured diagnostics + prompt catalog v1 / 3 주) → Phase B (boundary probe + memory / 2 주) → Phase C (semantic primitives / 2 주) → Phase D optional (live oracle).

---

## 1. 문제 인식

### 1.1 관찰된 증거 (GitHub 이슈)

| 이슈 | 증상 | 구조적 원인 |
|---|---|---|
| #226 | SSR-verify template 이 너무 얕음 — 빈 `<body>` 도 통과 | ATE 가 route 단에서 추론만 함. 실제 contract / slot 출력 shape 모름 |
| #227 | Dynamic / catch-all route → 단일 generic spec, 값 별 parameterization 없음 | `generateStaticParams` / contract 샘플 값 을 통합 소비 안 함 |
| #228 | Interaction graph 가 route 만 포착 — modal / action / form 은 문서에만 있음 | extractor 가 `<Route>` 중심, ts-morph AST 스캔 범위 좁음 |
| #229 | `ate heal` 이 명백한 실패에도 빈 suggestions | 실패가 비구조화 stack trace 로만 들어옴. LLM 이 원샷 판단할 재료 없음 |

### 1.2 공통 근본 원인

1. **Signal quality 낮음**: route 존재만으로 spec 생성 → 의미 있는 assertion 없음.
2. **Combinatorial 유지보수세**: redirect / auth-gated / i18n / streaming / error-page 패턴마다 template 단 예외 처리 누적.
3. **Coverage illusion**: "100% routes have spec" ≠ "behavior tested".
4. **AI round-trip 불가**: heal 이 LLM 에 넘길 구조화 입력이 없음.

### 1.3 왜 이 방향이 옳은가

- Next.js·Astro·SvelteKit 이 ATE 를 못 만드는 이유: **contract / slot / filling 같은 규약이 없음**. 구조가 없으니 의미 있는 자동화가 불가.
- Mandu 는 구조가 있음. 이 구조를 **agent 가 1급 입력으로 먹을 수 있게** 하면 경쟁자 없는 영역.
- 사용자는 이미 LLM 을 쓰고 있음. 우리가 또 껴서 API 키 관리 / 비용 / 모델 선택 ownership 을 짊어질 필요가 없음.

---

## 2. 철학 전환: Context Provider, Not LLM Host

### 2.1 분업 재정의

| 역할 | ATE 가 소유 | 사용자 agent 가 소유 |
|---|---|---|
| LLM API 키 / 토큰 비용 | ❌ | ✅ |
| 프롬프트 엔지니어링 (meta-prompt) | ❌ | ✅ |
| 모델 선택 | ❌ | ✅ |
| **Mandu-specific context 추출** | ✅ | 불가능 |
| **Mandu-specific prompt catalog** | ✅ | 불가능 |
| **Structured failure diagnostics** | ✅ | 불가능 |
| **Test primitives (`testFilling`, `createTestServer`, `expectContract`)** | ✅ | — |
| **Execution + replay** | ✅ | — |
| **Memory (과거 intent / rejection)** | ✅ | — |
| 실행 시 Spec 코드 자체 | ❌ (agent 가 생성) | ✅ |
| UI 판단 (semantic oracle) | ❌ (primitive 만 제공) | ✅ (agent 가 호출) |

### 2.2 MCP 철학과의 정렬

MCP 는 정확히 이 분업을 위해 만들어진 프로토콜. ATE 를 MCP 서버로 노출하면:

- Cursor, Claude Code, Codex, ChatGPT Desktop 전부 제로-통합 비용으로 사용.
- ATE 업그레이드 → 모든 agent 가 자동 혜택.
- Mandu 가 LLM 벤더 lock-in 없음.

### 2.3 비목표 (Non-goals)

- Mandu 가 LLM API 키 소유 / 과금 / 비용 관리.
- Mandu 내부 에 OpenAI / Anthropic / Google SDK 의존성 추가.
- "AI 로 테스트 자동 생성" 을 기본 CLI 흐름으로 만들기 (opt-in fallback 으로만).
- UI 자동 생성 / codegen — framework 본연 아님 (user 피드백 2026-04-20).
- 1.0.0 마일스톤 논의 — 별도 결정 사항 (user 피드백 2026-04-19).

---

## 3. 아키텍처: 4-Layer Stack

```
┌────────────────────────────────────────────────────────────────┐
│  사용자 agent (Cursor / Claude Code / Codex / Copilot)         │
│  - prompt 받기                                                  │
│  - context 읽기                                                 │
│  - LLM 호출 (사용자 키로)                                       │
│  - spec 생성 / heal                                             │
└─────────────────────┬──────────────────────────────────────────┘
                      │ MCP
                      ▼
┌────────────────────────────────────────────────────────────────┐
│  Layer 4 — Agent Primitives                                    │
│  expectContract / expectNavigation / expectSemantic /          │
│  waitForIsland / assertStreamBoundary                          │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│  Layer 3 — Prompt Catalog                                      │
│  filling_unit / filling_integration / e2e_playwright /         │
│  property_based / contract_shape / guard_security /            │
│  island_hydration / streaming_ssr                              │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│  Layer 2 — Structured Diagnostics                              │
│  failure JSON ({kind, candidates, diff, healing hints})        │
│  coverage report / impact graph                                │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│  Layer 1 — Context Extraction                                  │
│  route graph + contract shape + slot / island / action nodes + │
│  middleware chain + guard preset + fixture inventory +         │
│  exemplar 태깅된 기존 테스트                                    │
└────────────────────────────────────────────────────────────────┘
```

**규약**: 각 레이어는 아래 레이어만 의존. 상위 → 하위 호출 금지 (의존 역전 방지).

---

## 4. MCP Tool Surface

모든 tool 은 `mandu_ate.*` namespace.

### 4.1 `mandu_ate.context`

프로젝트 / 특정 route / 특정 filling 의 **완전한 semantic context** 를 JSON 으로 반환.

**Input**:
```ts
{
  scope: "project" | "route" | "filling" | "contract",
  id?: string,   // route id, contract name, filling path
  route?: string // pattern 매칭 ("/api/signup")
}
```

**Output** (route scope 예):
```json
{
  "route": {
    "id": "api-signup",
    "pattern": "/api/signup",
    "kind": "api",
    "file": "app/api/signup/route.ts",
    "isRedirect": false
  },
  "contract": {
    "file": "spec/contracts/signup.contract.ts",
    "name": "SignupContract",
    "methods": {
      "POST": {
        "body": { "type": "object", "required": ["email", "password"], "properties": {...} },
        "response": {
          "201": { "type": "object", "properties": { "userId": {"type": "string", "format": "uuid"} } },
          "409": { "type": "object", "properties": { "error": {"type": "string", "enum": ["EMAIL_TAKEN"]} } }
        },
        "examples": { "valid": {...}, "duplicate_email": {...} }
      }
    }
  },
  "middleware": [
    { "name": "rate-limit", "options": { "window": "1m", "max": 5 }, "file": "middleware/rate-limit/index.ts" },
    { "name": "csrf", "options": { "strict": true } }
  ],
  "guard": { "preset": "mandu", "tags": ["api", "public"], "suggestedSelectors": ["[data-route-id=api-signup]"] },
  "fixtures": {
    "session": "createTestSession",
    "db": "createTestDb",
    "mail": "mockMail",
    "exemplarsPath": "packages/core/src/filling/__tests__/action.test.ts"
  },
  "existingSpecs": [
    { "path": "tests/e2e/signup.spec.ts", "kind": "user-written", "lastRun": "2026-04-20T10:32:00Z", "status": "pass" },
    { "path": "tests/e2e/auto/api__signup.spec.ts", "kind": "ate-generated", "outdated": false }
  ],
  "relatedRoutes": [
    { "id": "api-login", "relationship": "sibling-auth-flow" },
    { "id": "page-signup", "relationship": "ui-entry-point" }
  ]
}
```

### 4.2 `mandu_ate.prompt`

테스트 kind 별 **시스템 프롬프트** 반환. Mandu-specific primitive / anti-pattern / selector convention 담김.

**Input**:
```ts
{
  kind: "filling_unit" | "filling_integration" | "e2e_playwright" | ...,
  base?: "mandu_core",  // 기본값. 미래에 다른 base (faster / stricter / ...) 허용
  version?: number      // 기본값 = latest
}
```

**Output**:
```ts
{
  kind: "filling_unit",
  version: 1,
  base: "mandu_core",
  prompt: "<Markdown 시스템 프롬프트 원문>",
  sha256: "...",       // 캐시 키
  exemplars: [
    { path: "packages/core/src/filling/__tests__/action.test.ts", lines: "42-85", reason: "basic_post" }
  ]
}
```

### 4.3 `mandu_ate.exemplar`

기존 repo 테스트에서 **kind 매칭된 실제 예제** 를 코드 단위로 반환. Agent 가 few-shot 용도로 사용.

**Input**:
```ts
{ kind: string, limit?: number }  // default limit = 2
```

**Output**:
```ts
{
  exemplars: [
    {
      kind: "filling_unit",
      path: "packages/core/src/filling/__tests__/action.test.ts",
      lines: "42-85",
      code: "test('posts new todo', async () => { ... })",
      tags: ["basic", "post", "formdata"]
    },
    { ... }
  ]
}
```

### 4.4 `mandu_ate.run`

Spec 실행. **실패 시 LLM-readable 구조화 JSON** 반환.

**Input**:
```ts
{ spec: string | { path: string }, headed?: boolean, trace?: boolean }
```

**Output** (성공):
```json
{ "status": "pass", "durationMs": 2340, "assertions": 7 }
```

**Output** (실패 — selector drift):
```json
{
  "status": "fail",
  "kind": "selector_drift",
  "detail": {
    "old": "[data-testid=submit]",
    "expectedAt": { "file": "tests/e2e/signup.spec.ts", "line": 23 },
    "domCandidates": [
      { "selector": "button.btn-primary", "similarity": 0.82, "text": "제출", "reason": "text match + role=button" },
      { "selector": "button[type=submit]", "similarity": 0.68, "reason": "role match only" }
    ],
    "contextDiff": { "added": ["aria-busy=true"], "removed": [] }
  },
  "healing": {
    "auto": [
      { "change": "selector_replace", "old": "[data-testid=submit]", "new": "button.btn-primary", "confidence": 0.82 }
    ],
    "requires_llm": false
  }
}
```

**Output** (실패 — contract mismatch):
```json
{
  "status": "fail",
  "kind": "contract_mismatch",
  "detail": {
    "route": "/api/signup",
    "expectedSchema": { "...": "..." },
    "actualResponse": { "userId": 42, "...": "..." },
    "violations": [
      { "path": ".userId", "expected": "string (uuid)", "actual": "number" }
    ]
  },
  "healing": { "requires_llm": true, "hint": "contract.response.201.userId type changed; pick spec update OR contract update" }
}
```

**Failure kinds** (초안, Phase B 에 확정):

| kind | 의미 | requires_llm? |
|---|---|---|
| `selector_drift` | CSS selector 가 DOM 에서 사라짐 | often false (auto heal) |
| `contract_mismatch` | Response shape 가 contract 와 불일치 | true |
| `redirect_unexpected` | 예상한 URL 이 redirect 됨 | false |
| `hydration_timeout` | Island 가 시한 내 hydrated 안 됨 | false (timeout 조정) |
| `rate_limit_exceeded` | 429 반환 | false (fixture 에 rate limit reset 추가) |
| `csrf_invalid` | 403 CSRF 실패 | false (`createTestSession` 호출 누락) |
| `fixture_missing` | 필요한 fixture 없음 | false |
| `semantic_divergence` | expectSemantic 이 LLM 판정 실패 | true |

### 4.5 `mandu_ate.boundary_probe`

**Contract 기반 boundary value set 생성** (deterministic, no LLM).

**Input**:
```ts
{ contractName: string, method: string }
```

**Output**:
```ts
{
  boundaries: [
    { field: "email", case: "invalid_format", value: "not-an-email" },
    { field: "email", case: "empty", value: "" },
    { field: "email", case: "max_length_plus_one", value: "a".repeat(256) + "@ex.com" },
    { field: "password", case: "below_min_length", value: "ab" },
    { field: "age", case: "negative", value: -1 },
    { field: "role", case: "not_in_enum", value: "superadmin" }
  ]
}
```

Agent 가 이 boundary set 으로 spec 을 생성 — contract 가 정확히 이 값들에서 어떻게 반응해야 하는지는 contract 자체에 선언돼 있으므로 round-trip 가능.

### 4.6 `mandu_ate.recall`

**Memory 조회**. 과거 intent / rejected spec / accepted healing 을 agent 프롬프트 컨텍스트로 주입.

**Input**:
```ts
{ intent?: string, route?: string, kind?: string, limit?: number }
```

**Output**:
```ts
{
  relevantMemories: [
    { kind: "rejected_spec", route: "/api/signup", reason: "테스트가 구현 세부 검사함", timestamp: "..." },
    { kind: "accepted_healing", route: "/api/signup", change: "selector_replace", timestamp: "..." }
  ]
}
```

### 4.7 `mandu_ate.save`

Agent 가 생성한 spec 을 저장 + 인덱싱 + ATE 메모리 업데이트.

**Input**:
```ts
{ path: string, content: string, intent?: string, kind?: string, sourcePrompt?: { kind, version } }
```

**Output**:
```ts
{ saved: true, lintDiagnostics: [...], previewRun?: {...} }
```

---

## 5. Prompt Catalog 설계

### 5.1 카탈로그 (Phase A v1 은 처음 3 kind)

| kind | 용도 | Phase |
|---|---|---|
| `filling_unit` | Filling handler 단위 테스트 (`testFilling`) | A |
| `filling_integration` | 서버 + session + DB 통합 (`createTestServer` 등) | A |
| `e2e_playwright` | Playwright E2E (Mandu selector + redirect + island) | A |
| `contract_shape` | `expectContract` 로 response shape 검증 | B |
| `property_based` | Zod → fast-check property | B |
| `guard_security` | CSRF / rate-limit / session 플로우 | B |
| `island_hydration` | Island hydration timing | C |
| `streaming_ssr` | Suspense / defer / stream boundary | C |
| `ate_spec_scaffold` | ATE 가 생성한 spec 의 표준 shape | C |

### 5.2 프롬프트 파일 포맷

경로: `packages/ate/prompts/<kind>.v<N>.md`

```markdown
---
kind: filling_unit
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role
You are generating a Bun test for a Mandu Filling handler.

# MUST-USE primitives (from @mandujs/core/testing)

- `testFilling(handler, { method, body, action, params, query })` — 서버 띄우지 않고
  Request 를 합성해 handler 직접 호출. `_action` 규약과 `X-Requested-With: ManduAction`
  헤더는 `action` 옵션이 자동 처리.
- `createTestContext(path, { params, body })` — handler 내부 로직 단위 테스트 용.

# NEVER do

- Hand-roll `new Request(url, init)` when `testFilling` covers it. 이유: CSRF / normalize
  / `_action` 주입이 자동으로 빠진다.
- Mock the DB. 대신 `createTestDb()` 가 bun:sqlite in-memory 인스턴스를 돌려준다.
- Assert on `JSON.stringify(res.body)` 전체. contract-aware helper (`expectContract`)
  가 더 정확하고 회귀에 강하다.

# Selector convention (Mandu 규약)

Mandu 는 SSR 시 다음 data-* 앵커를 자동 발행:
- `[data-route-id="<id>"]` — 최외곽 래퍼
- `[data-island="<name>"]` — island 컴포넌트
- `[data-slot="<name>"]` — slot boundary
- `[data-action="<name>"]` — form action target

Playwright / DOM 쿼리는 이 anchor 를 최우선으로. `data-testid` 는 사용자가 직접 단
경우에만 fall-through.

# Output format

단일 test 파일. `import { test, expect } from "bun:test"` 및 `import { testFilling } from "@mandujs/core/testing"` 만 사용. 외부 fixture 경로는 주어진 context 의 `fixtures.exemplarsPath` 참조.

# Exemplars

다음 예제 2 개를 스타일 레퍼런스로 삼을 것:

<!-- EXEMPLAR_SLOT -->
```

(Runtime: `mandu_ate.prompt` 가 `<!-- EXEMPLAR_SLOT -->` 에 실제 예제를 삽입 후 반환.)

### 5.3 Exemplar 태깅 시스템

기존 repo 의 테스트에 주석으로 태깅:

```ts
// @ate-exemplar: kind=filling_unit depth=basic tags=post,formdata
test("submits signup form", async () => { ... });
```

- `packages/ate/src/exemplar-scanner.ts` — 빌드 / 요청 시 AST 스캔, 메타데이터 수집.
- 수동 태깅 (자동 추론보다 정밀), 새 테스트 작성 시 의도적으로 붙임.
- `mandu_ate.exemplar({ kind })` 호출 시 이 인덱스 조회.

### 5.4 버전 관리

- 프롬프트 breaking change → 파일명 `.v2.md` 생성. `.v1.md` 유지 (기존 memory 가 레퍼런스).
- Memory 에 `sourcePrompt: { kind, version }` 기록.
- Mandu minor bump 시 catalog changelog 필수.

---

## 6. Structured Diagnostics Schema

### 6.1 원칙

- **모든 실패는 JSON 직렬화 가능**. Stack trace 는 참고 필드에만.
- **`requires_llm: false` 인 실패는 agent 없이 auto-heal 가능**. CI 에서도 쓸 수 있어야 함.
- **Healing hint 는 scope 제한적**. Diff 이상의 제안 (아키텍처 변경 등) 은 agent 위임.

### 6.2 Schema 파일

`packages/ate/schemas/failure.v1.ts` — Zod schema + TypeScript type export. Agent 가 이 schema 자체를 `mandu_ate.schema()` 로 가져갈 수 있음 (자기 검증용).

### 6.3 Coverage report (부가)

`mandu_ate.coverage()` → 다음 축으로 report:

```json
{
  "routes": { "total": 42, "withSpec": 28, "autoGenOnly": 8, "handWritten": 20 },
  "contracts": { "total": 15, "withPropertyTest": 3, "withBoundaryTest": 0 },
  "invariants": { "csrf": "covered", "rate_limit": "partial", "session": "covered" },
  "gaps": [
    { "kind": "redirect_route_without_spec", "routes": ["/", "/kr"] },
    { "kind": "contract_without_property_test", "contracts": ["SignupContract"] }
  ]
}
```

Agent 가 이 gap 리스트 읽고 "이 중 3개만 채워줘" 대화.

---

## 7. Phase 로드맵

### 2026-04-21 보강 (CTO / QE / TestEng / AgentDev 관점)

**A.2 확장** (structured diagnostics 기본 + 아래 4 항 추가):
- **Flake detection** — `.mandu/ate-run-history.jsonl` 기반 rolling 통계. `mandu_ate_flakes()` MCP tool. 실패 JSON 에 `flakeScore`, `lastPassedAt` 필드.
- **Artifact store** — Playwright trace zip / screenshot / DOM snapshot 을 `.mandu/ate-artifacts/<runId>/` 에 저장. 실패 JSON 에 경로 포함. 최근 10 run 만 유지.
- **CI 샤딩** — `mandu_ate_run({ shard: "2/4" })` 지원. Playwright 의 shard 옵션 투명 래핑.
- **Freshness signal** — 모든 context / failure 응답에 `graphVersion: sha256(routeIds + contractIds + extractorVersion)` 포함. Agent 캐시 무효화 기준.

**A.3 확장** (prompt catalog 기본 + 아래 4 항 추가):
- **Prompt tests** — 각 프롬프트에 "canonical context + expected spec shape" 골든. LLM 없이 drift 감지.
- **Pre-composed prompts** — `mandu_ate_prompt({ kind, context })` 는 placeholder 치환 완료된 최종 문자열 반환. Agent 추가 작업 불필요.
- **Anti-exemplars** — `@ate-exemplar-anti: kind=filling_unit reason="mocks DB"` 주석 — "이렇게 하지 마세요" 레퍼런스.
- **`mandu_ate_save` lint-before-write** — syntax / import / unused 기본 검사 후 write. 명백한 LLM 실수 차단.

**Phase B 선행 설계 (§7 확장)**:
- Boundary probe 에 **changed-file impact** 통합 — `git diff` 읽고 영향 받은 route 만 re-probe.
- Memory 에 **usage metrics** 필드 — 어느 kind 가 자주 쓰이는지 추적 → prompt 개선 우선순위.
- Contract **RPC parity** — 현재 REST route 중심, `contract/rpc.ts` 기반 RPC 도 동등 지원.

### Phase A — Context + Diagnostics + Prompt v1 (3 주)

**목표**: agent 가 "테스트 짜줘" 라고 했을 때 Mandu-idiomatic spec 이 나오게.

#### A.1 MCP context tool (1 주)

- `mandu_ate.context(scope, id)` — 위 §4.1 스펙 전체.
- Extractor 범위 확장:
  - Route-level 만 보던 것을 filling / slot / island / action 노드까지 스캔 (**#228 해결**).
  - `generateStaticParams` 값 수집 (**#227 부분 해결**).
  - Contract `examples` 필드 적극 활용.
  - Existing spec 인덱스 (`tests/**/*.spec.ts` 빠른 스캔 + outdated 감지).
- MCP tool 등록 + schema.

#### A.2 Structured diagnostics (1 주)

- `packages/ate/schemas/failure.v1.ts` — failure kinds 8개 (§4.4 표).
- `mandu_ate.run()` 래퍼 — Playwright / bun:test 결과를 failure JSON 으로 정규화.
- **#229 해결**: heal suggestion 이 이제 JSON diff 를 읽고 auto heal 또는 `requires_llm: true` 명시.
- Selector drift 자동 힐링 (similarity > 0.75) — deterministic.

#### A.3 Prompt catalog v1 (1 주)

- `packages/ate/prompts/filling_unit.v1.md`
- `packages/ate/prompts/filling_integration.v1.md`
- `packages/ate/prompts/e2e_playwright.v1.md`
- `mandu_ate.prompt()` tool — 파일 로드 + exemplar 삽입 + sha256.
- `mandu_ate.exemplar()` tool — `@ate-exemplar:` 주석 AST 스캔 인덱서.
- 최소 5 개 exemplar 태깅 (Mandu 자체 테스트 중 대표적인 것).

**Acceptance**: Cursor 에서 "signup filling 단위 테스트 짜줘" → Mandu-idiomatic 코드 생성. `data-route-id` 앵커 사용, `testFilling` 호출, DB mock 없음.

**Ship**: `@mandujs/ate@0.20.0` (minor, MCP surface 확장).

---

### Phase B — Boundary + Memory (2 주)

**목표**: agent 가 단순 generation 넘어 **의미 있는 adversarial coverage** 를 만들 수 있게.

#### B.1 `mandu_ate.boundary_probe` (1 주)

- Zod schema → boundary case set (deterministic).
- Recursive: nested object 는 1 depth 까지 기본, flag 로 확장.
- **#227 해결**: dynamic route 가 contract 의 param schema 로 boundary 를 받음.
- Agent 가 boundary set 을 prompt 입력으로 받아 spec 다수 생성.

#### B.2 Memory (1 주)

- `.mandu/ate-memory.jsonl` (append-only, rotating).
- Schema: `{ timestamp, kind: "rejected_spec" | "accepted_healing" | "intent_history", route?, reason?, ... }`.
- `mandu_ate.recall()` — 최근 N 개 관련 메모리 반환.
- `mandu_ate.save()` 가 자동으로 `intent_history` 기록.

#### B.3 Prompt catalog 확장

- `property_based.v1.md` (+ fast-check 가이드).
- `contract_shape.v1.md` (`expectContract` primitive 홍보).
- `guard_security.v1.md`.

**Acceptance**: `mandu_ate.coverage()` 가 "contract X 는 boundary test 0 개" → agent 가 `boundary_probe` 받고 3 개 spec 제안 → 2 개 채택, 1 개 reject → 다음 세션에서 reject 한 이유 기억하고 다시 제안 안 함.

**Ship**: `@mandujs/ate@0.21.0`.

---

### Phase C — Semantic Primitives (2 주)

**목표**: Mandu-specific assertion 을 **primitive** 로 제공. runtime LLM 없이도 일관성 높음.

#### C.1 `expectContract(res, schema)` (0.5 주)

- Response 를 contract schema 로 validate. 위반 시 structured diff.
- `@mandujs/core/testing` 또는 `@mandujs/ate/assertions` 배럴 결정 필요.

#### C.2 Navigation / Redirect / Hydration helpers (1 주)

- `expectNavigation(page, { from, to })` — redirect chain validation.
- `waitForIsland(page, name, opts)` — hydration timing + `data-hydrated` 감시.
- `assertStreamBoundary(res)` — streaming SSR 의 chunk boundary 검증.

#### C.3 `expectSemantic(page, claim)` — Agent 위임형 (0.5 주)

- 구현: primitive 는 "스크린샷 + DOM + claim" 을 structured 형태로 기록.
- 런타임 LLM 호출 **하지 않음**. 대신 `mandu_ate.oracle_pending()` 에 queue.
- Agent (CI 밖 local dev session) 가 queue 읽고 판정.
- CI 용 fallback: `deterministic_only: true` 로 expectSemantic skip.

#### C.4 Prompt catalog 확장

- `island_hydration.v1.md`
- `streaming_ssr.v1.md`
- `ate_spec_scaffold.v1.md`

**Acceptance**: Expanded assertion primitive 를 사용한 spec 이 agent 출력에 자연스럽게 나타남 (프롬프트가 유도).

**Ship**: `@mandujs/ate@0.22.0` + `@mandujs/core` 에 `expectContract` export 추가 (patch).

---

### Phase D — Optional Live Oracle (2 주, 선택)

**목표**: local Ollama 가 있는 사용자에게 offline semantic oracle 제공.

- `MANDU_AI_ORACLE=ollama:llama3:70b` env — opt-in.
- `expectSemantic` 호출 시 Ollama HTTP 호출 → claim 판정.
- 결과 캐시 (hash(screenshot + claim) → boolean + reason).
- 완전 선택적. 기본은 "agent 가 나중에 판정" 경로.

**Ship**: `@mandujs/ate@0.23.0` (optional peerDep `ollama`).

---

## 8. 이슈 매핑

| 이슈 | 해결 Phase | 해결 메커니즘 |
|---|---|---|
| #226 SSR-verify 얕음 | A.3 + C.1 | Prompt 에 `expectContract` 지시, `data-route-id` anchor 강제 |
| #227 Dynamic route parameterization | A.1 + B.1 | Context extractor 가 `generateStaticParams` 수집 + boundary probe |
| #228 Modal/action/form 추출 | A.1 | Extractor 범위 확장 (route → route+action+form+modal) |
| #229 Heal empty suggestions | A.2 | Structured failure JSON + auto-heal (selector similarity) |

---

## 9. 마이그레이션 전략

### 9.1 기존 route-auto-extract 는 deprecate, not remove

- `mandu test:auto` CLI 는 유지. 내부적으로 prompt catalog + context 사용하도록 재작성.
- 과거 flat `tests/e2e/auto/*.spec.ts` 출력 포맷은 Phase A 까지 유지. Phase B 부터 agent-driven 흐름이 default.
- `MANDU_ATE_LEGACY=1` env 로 구버전 추출 flow 강제 가능 (1~2 릴리즈 동안).

### 9.2 Breaking changes 예상 지점

1. **ATE MCP tool 이름 공간** 정비 — 기존 tool 일부 이름 변경 (deprecate → remove).
2. **Auto-generated spec 포맷** — `isRedirect` shape, `waitUntil: networkidle`, 127.0.0.1 fallback 이 이미 적용 (issue #224 수정).
3. **Failure JSON schema** — 새 schema, agent 가 읽어야 함. 기존 pretty-print 모드는 `mandu test --human` flag 로 유지.

### 9.3 Mandu 자체 테스트 영향

- `packages/core/tests/**` — 여기 테스트들을 exemplar 로 많이 사용할 것. 태깅 sprint 필요 (Phase A 중).
- 기존 ATE 통합 테스트 (`packages/ate/tests/**`) — 365 passing. Phase A 가 더하면 +20~30 tests 예상.

---

## 10. 성공 지표

### 정량
- **Agent round-trip 시간**: "테스트 짜줘" → 정상 실행 spec 까지 90 초 이내 (P50).
- **Auto-heal 성공률**: selector drift 의 70% 이상이 `requires_llm: false` 로 자동 해결.
- **False failure rate**: auto-generated spec 의 첫 실행 실패 중 "실제 버그 아님" 비율이 10% 이하 (현재 추정 60%+).
- **ATE test coverage**: 기존 365 → Phase A 끝에 ≥ 420. Phase B 끝에 ≥ 500.

### 정성
- Cursor / Claude Code 사용자가 "Mandu 전용 테스트 helper 가 있는 걸 agent 가 바로 알고 쓴다" 라는 피드백.
- GitHub 이슈 #226~#229 재발 사례 없음 (6 개월).

---

## 11. Open Questions

### 결정됨 (2026-04-21)

1. **프롬프트 언어**: ✅ **영어 only**. Test 본문 / assertion 영어, intent 주석 한국어 허용.
2. **Exemplar 수집 방법**: ✅ **수동 `@ate-exemplar:` 주석**. 자동 휴리스틱 도입 안 함.
3. **Memory 저장 위치**: ✅ **`.mandu/ate-memory.jsonl` 프로젝트 로컬**. `.gitignore` 추가. 글로벌 opt-in 은 추후 필요 시.
4. **MCP tool naming**: ✅ **snake_case 단일 네임스페이스** (`mandu_ate_context`, `mandu_ate_prompt` …). 15+ 개 넘어가면 prefix 그룹 (`mandu_ate_ctx_*`) 로 분리 검토.

### 결정 가능 (Phase B 에 미룰 수 있음)

5. **Prompt catalog 국제화**: 영어 외 다른 언어 버전 필요한가. 의견: 영어 단일 유지, agent 가 자연어 번역 담당.
6. **Oracle 모델 정책**: Phase D 에서 Ollama 외 OpenAI / Anthropic 직접 어댑터도? 의견: Ollama 만 (self-host 원칙).
7. **Boundary probe 깊이**: recursive depth 한도. 의견: 기본 1, flag 로 3까지.

---

## 12. 비목표 재확인

- Mandu 가 LLM API 키 / 모델 선택 / 토큰 비용 소유.
- Mandu 가 UI 자동 생성 / 컴포넌트 codegen. (Framework 본연 외)
- 1.0.0 마일스톤 포함 / 릴리즈 타이밍 논의.
- Auto-generated spec 의 100% 커버리지 목표 (숫자 coverage illusion 경계).

---

## 13. 다음 액션 (결정 후 실행)

1. **§11 Open Questions** 중 Phase A 전제 4 개 결정.
2. Phase A.1 kickoff — extractor 확장 + `mandu_ate.context` MCP 스펙 커밋.
3. `docs/ate/` 하위에 본 문서 + prompt catalog skeleton 추가.
4. 기존 `ATE-ROADMAP-v1.md` 상태 `superseded-by: roadmap-v2-agent-native.md` 로 마킹.

---

## Appendix A — `filling_unit.v1.md` 프롬프트 초안 (레퍼런스)

```markdown
---
kind: filling_unit
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role

You are generating a bun:test unit test for a Mandu Filling handler. The Filling
is a single request-handler module (typically `app/**/route.ts` or an API route)
with a `.handle(request, params)` signature and optional `.action(name, handler)`
registrations.

# Provided context

- `route`: route metadata (id, pattern, kind, file).
- `contract`: Zod-driven request/response schema. Use `examples` if present.
- `middleware`: active chain. Rate-limit or CSRF presence MUST be reflected in
  test setup.
- `fixtures`: available test-only helpers. NEVER import from paths outside this.
- `existingSpecs`: prior tests for this route. Avoid duplication; extend instead.

# MUST-USE primitives (from `@mandujs/core/testing`)

- `testFilling(handler, { method, body, action, params, query })` — synthesizes
  a Request and invokes `.handle(request, params)` directly. No server boot.
  Handles `_action` body injection and `X-Requested-With: ManduAction` header.
- `createTestContext(path, { params, body })` — when unit-testing code that runs
  inside the handler (dep factories, guards).
- `createTestRequest(path, init)` — when the test needs a Request object for a
  bare function (not a Filling).

# NEVER

- Construct `new Request(url, init)` when `testFilling` covers it — this bypasses
  Mandu's CSRF/normalize/action plumbing and will silently pass where the real
  handler fails.
- Mock the database. Use `createTestDb()` (in-memory bun:sqlite) from
  `@mandujs/core/testing`.
- Assert on `JSON.stringify(res.body)` full-string. Prefer `expectContract` (if
  available) or property-level assertions so that unrelated field ordering or
  timestamp jitter does not break the test.

# Selector convention (Mandu)

Mandu emits these data attributes in SSR output. Use them BEFORE falling back
to class / tag selectors:

- `[data-route-id="<id>"]` — outermost wrapper
- `[data-island="<name>"]` — island component boundary
- `[data-slot="<name>"]` — slot boundary
- `[data-action="<name>"]` — form action target

User-authored `data-testid` is allowed but not preferred (Mandu anchors are
stable across refactors).

# Output format

- Single `*.test.ts` file, importing only `bun:test` and `@mandujs/core/testing`
  (plus the handler under test and the fixture helpers named in `context.fixtures`).
- Minimum 3 cases: (1) happy path, (2) contract-violation path, (3) middleware
  effect path (rate-limit or CSRF if applicable).
- 헤더 주석 한 줄로 test 의 intent 한국어 설명 허용. 본문 코드와 assertion 은 영어.

# Example shape

\`\`\`ts
import { test, expect, describe } from "bun:test";
import { testFilling } from "@mandujs/core/testing";
import handler from "../../app/api/signup/route";

describe("POST /api/signup", () => {
  test("성공: 정상 입력이면 201 + userId 반환", async () => {
    const res = await testFilling(handler, {
      method: "POST",
      body: { email: "a@b.com", password: "valid123" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.userId).toBe("string");
  });

  test("실패: 중복 이메일이면 409 + error 코드", async () => {
    // ... seed first user via createTestDb
  });

  test("middleware: rate-limit 6회 시도시 429", async () => {
    // ... loop 6 testFilling calls
  });
});
\`\`\`

# Exemplars

<!-- EXEMPLAR_SLOT -->
```

---

*End of document.*
