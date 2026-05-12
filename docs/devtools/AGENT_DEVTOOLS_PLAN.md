# Mandu Agent DevTools Plan

작성일: 2026-05-01  
상태: Product and architecture plan  
관련 코드: `packages/core/src/devtools/ai`, `packages/core/src/brain`, `packages/mcp/src/tools/brain.ts`, `packages/core/src/kitchen`

---

## 0. 결정

Mandu Kitchen DevTools는 단순 디버깅 UI에서 **Agent DevTools / Supervisor Console**로 진화해야 한다.

목표:

> DevTools should tell the developer and the agent what is happening, why it matters, which Mandu tool or skill should be used, and what the next safe action is.

한국어 목표:

> DevTools는 현재 상황을 읽고, 관련 엔지니어링 지식과 프롬프트를 전달하며, 지금 해야 할 안전한 다음 액션을 제안하는 에이전트 감독 콘솔이 되어야 한다.

---

## 1. 왜 중요한가

Mandu의 agent-native 가치는 MCP와 skills가 설치되어 있다는 사실만으로 완성되지 않는다. 실제 개발 순간에는 다음 문제가 생긴다.

1. 에이전트가 어떤 skill을 써야 하는지 모른다.
2. MCP tool이 있는데도 직접 파일을 고친다.
3. 에러, route, island, contract, guard 결과가 서로 연결되지 않는다.
4. 사용자는 지금 에이전트에게 어떤 프롬프트를 줘야 하는지 모른다.
5. OAuth로 LLM brain이 연결되어도 UI가 그 능력을 제품 경험으로 드러내지 못한다.

Agent DevTools는 이 문제를 해결하는 제품 표면이다.

---

## 2. 현재 자산

이미 repo 안에 기반이 있다.

| 영역 | 현재 자산 | 의미 |
|---|---|---|
| DevTools context | `packages/core/src/devtools/ai/context-builder.ts` | 에러, 사용자 액션, island, source context를 AI payload로 묶는 기반 |
| MCP bridge | `packages/core/src/devtools/ai/mcp-connector.ts` | DevTools에서 MCP 쪽으로 context 전달을 시도하는 기반 |
| OAuth brain | `packages/core/src/brain/adapters/*oauth*` | OpenAI/Anthropic 계정 연결과 token lifecycle 기반 |
| MCP brain tools | `packages/mcp/src/tools/brain.ts` | `mandu.brain.status`, `mandu.brain.login`, `mandu.brain.logout`, doctor/heal suggestion |
| Kitchen APIs | `packages/core/src/kitchen` | errors, routes, guard, diff, activity SSE를 읽는 supervisor surface |
| Agent workflow docs | `docs/guides/07_agent_workflow.md` | 에이전트가 skill/MCP를 선택해야 하는 공식 프로토콜 |

결론: 새 기능을 처음부터 만드는 것이 아니라, 기존 자산을 **상황 인식 -> 지식 전달 -> 프롬프트 전달 -> 액션 추천** 흐름으로 연결해야 한다.

---

## 3. Product Model

Agent DevTools는 4개의 레이어로 구성한다.

### 3.1 Situation

현재 상태를 수집한다.

입력:

- current route
- recent runtime errors
- network/API failures
- island hydration status
- guard violations
- contract validation results
- file diff
- active MCP/brain auth status
- recent user actions
- perf/smoke status when available

출력:

- "What is happening"
- "Affected files"
- "Likely category"
- "Risk level"

### 3.2 Knowledge

상황별 엔지니어링 지식을 전달한다.

예:

- Hydration error: island boundary, client-only imports, `data-mandu-error`, bundle path checks
- Guard violation: correct layer, allowed import path, matching skill
- Contract mismatch: schema, handler, client caller, OpenAPI sync
- Runtime 404/500: route match, static asset policy, handler availability
- Perf regression: TTFB, hydration, bundle size, route scan

출력:

- short explanation
- related Mandu doc link
- related skill
- related MCP tool

### 3.3 Prompt

상황에 맞는 프롬프트를 만든다.

프롬프트 유형:

- Diagnose prompt: "Investigate this exact failure"
- Fix prompt: "Patch the smallest root cause"
- Test prompt: "Add regression coverage"
- Refactor prompt: "Move code to correct architecture layer"
- Release prompt: "Run release confidence checklist"

출력:

- Copyable prompt
- Agent-targeted prompt block
- Tool plan embedded in the prompt

### 3.4 Action

지금 해야 할 안전한 다음 액션을 제안한다.

액션 유형:

- Read-only: inspect route, inspect error, inspect guard rule
- Local validation: run guard, typecheck, targeted test, perf scenario
- Guided edit: create route, update contract, write slot
- Supervisor approval: run MCP write tool, apply patch, start OAuth login

Action은 기본적으로 **suggest**이고, write action은 supervisor approval이 필요하다.

---

## 4. UX Panels

### 4.1 Agent Status

표시:

- MCP connection status
- active MCP profile: minimal, standard, full
- brain tier: openai, anthropic, template
- OAuth status: logged in, expired, missing, revoked
- redaction status

가능 액션:

- `mandu.brain.status`
- `mandu.brain.login`
- `mandu.brain.logout`
- switch MCP profile guide

### 4.2 Situation Brief

현재 route/error/guard/hydration/perf 상태를 한 장으로 요약한다.

형식:

```text
Current issue: Hydration failed in devtools-lab island
Likely category: hydration/client bundle
Risk: medium
Relevant skill: mandu-hydration
Relevant tools: mandu_list_islands, mandu_build_status
Next action: inspect island source and run hydration benchmark
```

### 4.3 Knowledge Cards

상황별 짧은 엔지니어링 지식 카드.

예:

- "This is a client boundary issue"
- "Do not import server-only modules into `*.island.tsx`"
- "Use `mandu_check_import` before moving this file"
- "Contract changes must update schema, handler, and tests together"

### 4.4 Prompt Builder

에이전트에게 줄 프롬프트를 생성한다.

프롬프트는 반드시 포함한다.

- task domain
- selected skill
- selected MCP tools
- relevant files
- exact symptom
- validation command
- fallback instruction

### 4.5 Next Safe Action

한 번에 하나의 다음 행동을 제안한다.

예:

```text
Next safe action:
Run mandu_guard_check and inspect rule fsd/no-cross-slice-dependency.

Why:
The current diff imports from a lower layer into a higher layer.

Approval:
Read-only action, safe to run.
```

---

## 5. Permission Model

Agent DevTools는 OAuth와 MCP write tools를 다루므로 권한 모델이 제품 신뢰의 핵심이다.

### Modes

| Mode | Allowed |
|---|---|
| Observe | read context, show status, build prompts |
| Suggest | propose tools, commands, prompts, docs |
| Assist | run read-only MCP tools and local validation |
| Act with approval | run write MCP tools, scaffold, patch, login/logout |

Default: Suggest.

### Safety requirements

1. OAuth token은 OS keychain 또는 provider-owned auth file 정책을 따른다.
2. DevTools payload는 redaction을 거친다.
3. write action은 file list, tool name, risk, rollback path를 보여준 뒤 실행한다.
4. production mode에서는 Agent DevTools가 비활성화된다.
5. full MCP profile은 명시적 supervisor approval 없이 권장하지 않는다.

---

## 6. Architecture

```text
Browser DevTools UI
  -> Kitchen API/SSE
  -> DevTools AI Context Builder
  -> Prompt Builder / Knowledge Router
  -> MCP Connector
  -> Mandu MCP tools
  -> Brain adapter (OAuth-backed when available)
  -> Guard / ATE / CLI / Runtime checks
```

Key integration points:

- `AIContextBuilder`: context pack 생성
- `MCPConnector`: tool/action bridge
- `brain.status/login/logout`: OAuth brain 상태
- `KitchenHandler`: route, diff, activity, guard API
- `ATE`: test generation and heal loop
- `Guard`: architecture and import enforcement

---

## 7. Milestones

### M0. Product Contract

작업:

- 이 문서를 기준 계약으로 둔다.
- `docs/guides/07_agent_workflow.md`와 연결한다.
- DevTools를 Supervisor Console로 표현하도록 product strategy를 갱신한다.

완료 기준:

- README/docs에서 Agent Workflow와 Agent DevTools 방향을 찾을 수 있다.

### M1. Context Pack

작업:

- current route, recent errors, island status, guard/diff/activity를 하나의 `AgentContextPack`으로 정의한다.
- redaction boundary를 명확히 한다.
- context pack을 Kitchen API에서 읽을 수 있게 한다.

완료 기준:

- DevTools UI가 "current situation" JSON을 보여줄 수 있다.

### M2. Knowledge Router

작업:

- 상황 category를 정의한다: hydration, guard, contract, runtime, perf, release, deploy.
- category -> docs/skill/MCP tool 매핑을 만든다.
- Knowledge Cards를 표시한다.

완료 기준:

- 오류나 guard violation을 클릭하면 관련 skill/tool/doc이 표시된다.

### M3. Prompt Builder

작업:

- 상황별 prompt template을 만든다.
- prompt에 selected skill, selected MCP tools, validation command를 포함한다.
- copy-to-agent UX를 만든다.

완료 기준:

- 사용자가 DevTools에서 에이전트에게 줄 프롬프트를 복사할 수 있다.

### M4. OAuth Brain Status

작업:

- DevTools Agent Status에서 `mandu.brain.status`를 보여준다.
- OAuth login/logout 진입점을 제공한다.
- template fallback일 때 "login하면 더 나은 diagnosis 가능"을 명확히 보여준다.

완료 기준:

- brain tier와 auth state가 DevTools에 표시된다.
- login action은 supervisor approval을 요구한다.

### M5. Next Safe Action

작업:

- 각 category에 next action policy를 붙인다.
- read-only action은 바로 제안하고, write action은 approval flow로 보낸다.
- validation command까지 함께 제안한다.

완료 기준:

- DevTools가 "지금 해야 할 한 가지"를 항상 보여준다.

### M6. Assisted Action

작업:

- MCP read-only tool 실행을 UI에서 지원한다.
- write tool은 approval preview를 거친다.
- 실행 결과를 activity timeline에 남긴다.

완료 기준:

- DevTools에서 guard inspect, route inspect, build status 같은 read-only tool을 실행할 수 있다.

---

## 8. P0 Scope

당장 필요한 것은 full autonomous agent가 아니다.

2026-05-01 구현 시작:

- `packages/core/src/kitchen/api/agent-devtools-api.ts`에 `AgentContextPack` builder와 `/__kitchen/api/agent-context` 응답 모델을 추가했다.
- Kitchen UI에 Agent Supervisor panel을 추가해 Situation, Tool Router, Knowledge Cards, Prompt Pack, Next Safe Action을 표시한다.
- 현재 구현은 read-only supervisor surface다. MCP tool 직접 실행, OAuth login/logout, write action은 아직 실행하지 않는다.

P0 범위:

1. Agent DevTools 방향 문서화
2. Agent Workflow와 연결
3. context category와 tool router 정의
4. prompt builder template 초안
5. brain OAuth status UI 설계

P0에서 하지 않는 것:

- 자동 파일 수정
- 자동 OAuth login
- full MCP profile 자동 활성화
- production에서 DevTools 활성화

---

## 9. Example Prompt Output

```text
You are working in a Mandu project.

Situation:
- Hydration failed for island `devtools-lab`.
- Runtime marked `[data-mandu-error]`.
- Current route: `/`.

Use:
- Skill: mandu-hydration
- MCP tools: mandu_list_islands, mandu_build_status
- Fallback: inspect `*.island.tsx` and run `bun run build`

Task:
Find the smallest root cause. Check for server-only imports, stale bundle output, and incorrect hydration strategy. Patch only the relevant files.

Validation:
Run `bun run typecheck`, `bun run test:smoke`, and the relevant hydration/perf check if bundle behavior changed.

Report:
List selected tools, changed files, validation, and any skipped checks.
```

---

## 10. Open Questions

1. DevTools가 MCP server와 직접 WebSocket으로 연결할지, Kitchen server가 MCP proxy 역할을 할지 결정해야 한다.
2. OAuth login은 DevTools UI에서 시작할지, CLI/MCP login command를 안내할지 결정해야 한다.
3. Agent Status는 local-only로 둘지, workspace team mode를 고려할지 결정해야 한다.
4. prompt templates를 `@mandujs/skills`와 공유할지 별도 devtools asset으로 둘지 결정해야 한다.
5. ATE report를 DevTools panel로 직접 렌더링할지 link-out으로 둘지 결정해야 한다.
