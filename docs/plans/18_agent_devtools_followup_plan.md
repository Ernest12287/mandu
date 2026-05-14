# Agent DevTools Follow-up Plan — P0 Signals & MCP Surface

작성일: 2026-05-12
상태: Implementation plan (follow-up to `docs/devtools/AGENT_DEVTOOLS_PLAN.md`)
관련 코드:
- `packages/core/src/kitchen/api/agent-devtools-api.ts`
- `packages/core/src/kitchen/kitchen-handler.ts`
- `packages/core/src/kitchen/kitchen-ui.ts`
- `packages/mcp/src/tools/kitchen.ts`
- `packages/core/src/observability/event-bus.ts`
- `packages/core/src/diagnose/*`
- `packages/core/src/bundler/types.ts`

---

## 0. 결정

> Kitchen 표면은 이미 충분히 넓다 (HTTP endpoint 27 / panel 10 / MCP tool 131).
> 부족한 것은 **두 청자(개발하는 에이전트와 사람 사용자)에게 의미 있는 정보**다.

`AGENT_DEVTOOLS_PLAN.md` 의 M0–M6 가 데이터 모델 / UI / HTTP endpoint 를 깔았다면, 이 plan 은 그 위에서 **두 청자 모두가 self-orient 할 수 있게 만드는 P0 작업**을 정리한다.

---

## 1. 배경 — 무엇이 남았나

`AGENT_DEVTOOLS_PLAN.md` 의 P0 (2026-05-01 시작) 가 마무리한 것:

- `AgentContextPack` 타입 / builder / handler 작성 (`agent-devtools-api.ts`)
- `/__kitchen/api/agent-context` HTTP endpoint wire (`kitchen-handler.ts:371-383`)
- Kitchen UI 에 Agent Supervisor 패널 추가 (`kitchen-ui.ts`)

해결되지 않은 두 가지 구조적 문제:

1. **에이전트는 Kitchen 패널을 못 본다.** 같은 `AgentContextPack` 데이터를 MCP 도구로 노출하는 경로가 0개. 가장 큰 사용자(코딩 에이전트)가 supervisor surface 에 닿지 못한다.
2. **Builder 의 입력 시그널이 좁다.** 현재 errors / http / guard / mcp 이벤트만 본다. 빌드 깨짐 / contract drift / nested core / dead route 같은 boot-breaking 신호가 `situation` 분류에 안 들어간다. 정작 사람이 알고 싶은 순간을 놓친다.

---

## 2. 두 청자 기준

이 plan 의 모든 task 는 다음 두 질문으로 평가한다.

### 2.1 에이전트에게 의미 있는가

> 이 정보 한 덩어리로 에이전트가 self-orient 할 수 있는가?

기준:
- raw `mcpEvent[]` 가 아니라 "지금 contract drift 가 났고, `mandu.contract.validate` 부터" 수준
- situation + 어떤 skill/tool 을 쓸지 + next safe action 이 한 응답에 포함

### 2.2 사용자에게 의미 있는가

> 1-page 에서 "지금 뭘 봐야 하고, 에이전트에게 무엇을 시켜야 하는지" 결정 가능한가?

기준:
- raw event timeline 보다 "이 페이지는 SSR-only, island 0개, hydration 걱정 없음" 같은 한 줄 해석
- 빌드 깨짐 / 새 에러 / contract drift 가 panel 10개 중 어디 묻혀 있지 않고 supervisor 한 곳에서 surface

---

## 3. 인벤토리 — 이미 코드는 있고 노출만 안 된 것

| 시그널 | 코드 위치 | 현재 상태 |
|---|---|---|
| eventBus 카테고리 `build` / `cache` / `ws` / `ate` | `observability/event-bus.ts:3-18` | bus 발행 ○ / kitchen-handler 읽기 × |
| `BundleManifest` (island sizes, dep graph, priority) | `bundler/types.ts:37-115`, `.mandu/manifest.json` | 파일 존재 ○ / kitchen API × / builder 입력 × |
| `runExtendedDiagnose` 7-check 결과 | `diagnose/run.ts:28-66` | 실행 ○ / kitchen API × / builder 입력 × |
| HMR perf 마커 50+ | `perf/hmr-markers.ts:31-200` | `MANDU_PERF=1` 수집 ○ / kitchen 미노출 |
| Stored errors ring buffer | `kitchen-handler.ts:54-64` | 저장 ○ / dedicated panel × (Activity 에 섞임) |
| ATE 결과 / coverage / heal | `packages/ate/`, `.mandu/ate/` | 디스크 ○ / kitchen 미노출 |

`AgentContextPack` builder 가 추천하는 MCP tool 이름은 **모두 실제로 존재**한다 — `mandu.island.list`, `mandu.build.status`, `mandu.guard.check`, `mandu.contract.validate`, `mandu.brain.doctor`, `mandu.ai.brief`, `mandu.test.smart`, `mandu.test.precommit`, `mandu.watch.status`, `mandu.brain.checkImport`. 네이밍 mismatch 0건.

빠진 통합 도구는 **AgentContextPack 자체를 반환하는 MCP tool**. `mandu.ai.brief` 는 가까운 모양이지만 git/docs 메타데이터 묶음일 뿐, situation 분류 / tool routing / next action 책임은 없음.

---

## 4. 우선순위 — P0 ~ P3

### P0 — 둘 다에게 큰 leverage

#### P0-1. `mandu.devtools.context` MCP tool 신설

- **위치**: `packages/mcp/src/tools/kitchen.ts` 에 추가 (기존 `mandu.kitchen.errors` 옆)
- **반환**: `AgentContextPack` 전체 (situation / toolRecommendations / knowledgeCards / prompt / nextSafeAction)
- **구현**: `buildAgentContextPack` 을 호출. Kitchen HTTP endpoint 거치지 않고 core API 를 직접 import. ringBuffer / eventBus / manifest 접근은 MCP 프로세스 컨텍스트에서 동일하게 가능
- **권한 모드**: `Observe` 만 자동. write 액션 (login, scaffold, apply) 은 별도 게이트
- **수용 조건**: 에이전트가 한 번의 tool 호출로 "지금 무엇을 해야 하나" 응답을 받는다
- **예상 변경**: tool 정의 + handler ~80 lines, 테스트 ~120 lines

#### P0-2. Builder 입력 시그널 3종 확장

`BuildAgentContextPackInput` (`agent-devtools-api.ts:49-59`) 에 추가:

1. `bundleManifest?: BundleManifest` — `.mandu/manifest.json` 읽기. `summary.bundles`, `summary.islandSizes` 산출. 빌드가 최신인지 / island 0개인지 분류 입력
2. `diagnoseReport?: DiagnoseReport` — `runExtendedDiagnose(rootDir)` 결과. `nested_internal_core` / `package_export_gaps` / `manifest_freshness` 같은 boot-breaking 신호를 supervisor 가 보게 함
3. `changedFiles?: string[]` — git diff against base (CLI 가 이미 가지고 있음, builder 로 전달). impact 한정 + delta-focused prompt 생성 가능

`pickSituation` 에 두 카테고리 추가:

- `build-broken`: diagnose `manifest_freshness` error 또는 bundle manifest 없음 → "빌드부터 다시" 분류
- `boot-breaking`: `nested_internal_core` / `package_export_gaps` → MCP 부팅 회귀 (#260, #261) 자동 surface

- **수용 조건**: `.mandu/manifest.json` 삭제 후 `/__kitchen/api/agent-context` 호출 → situation.category === "build-broken"
- **예상 변경**: builder ~60 lines, handler ~25 lines, 테스트 ~150 lines

P0 두 개를 같이 묶어야 한다. P0-1 만 하면 분류가 여전히 좁고, P0-2 만 하면 에이전트가 못 본다.

### P1 — 사용자에게 직접 의미

#### P1-3. eventBus `build` / `cache` / `ws` / `ate` 카테고리 노출

- **현재**: `kitchen-handler.ts` 가 `http` / `mcp` / `guard` 만 읽음
- **변경**: Activity 패널에 filter chip 4개 추가 (디폴트 OFF — 폭증 방지)
- **해석 레이어**: raw event 가 아니라 1-line 요약. 예: "rebuild 18회 / 평균 230ms / 마지막 03:42:11"
- **수용 조건**: dev 세션 중 rebuild 발생 → Activity 패널 build chip 클릭 → 시간순 + 평균 latency 보임
- **예상 변경**: handler endpoint 1개 추가, UI filter chip + summary line, ~120 lines

#### P1-4. Errors 전용 패널 + stack 그룹핑

- **현재**: errors 는 ring buffer 50 + `.mandu/errors.jsonl` 로 저장되지만 panel 없음 (Activity 에 섞임)
- **변경**: 새 panel. 같은 stack trace 묶기 (해시 키), 첫 발생 / 마지막 발생 / 빈도 / 영향 route 표시
- **수용 조건**: 같은 hydration 에러 5번 발생 시 5줄 아니라 1줄 (count=5) 로 표시
- **예상 변경**: panel 1개 + grouping util ~180 lines

### P2 — 의미 있는 정보 깊이 추가

#### P2-5. Diagnose 패널

- `runExtendedDiagnose` 7-check 결과를 한 화면. severity 별 정렬. 각 row 클릭 시 details / suggestion 펼침
- 이미 P0-2 가 supervisor 에 분류로 묶지만, dedicated panel 은 history / 비교 / 자동 갱신 책임
- **예상 변경**: ~150 lines

#### P2-6. Bundle inspector

- `.mandu/manifest.json` 파싱 → island 별 size / dependencies / priority / shared graph
- perf 진단의 핵심 입구. P3-7 과 연결됨
- **예상 변경**: ~200 lines

### P3 — perf-aware DX

#### P3-7. HMR perf 마커 패널

- `perf/hmr-markers.ts` 의 50+ 마커가 `MANDU_PERF=1` 로 buffer 에 쌓임. 현재 Kitchen 에서 접근 불가
- 변경: `collectPerfSnapshot()` API public 화 → handler endpoint → panel 에 cold start / rebuild latency / vendor cache hit / HMR broadcast time 시각화
- **수용 조건**: dev 세션 중 reload 가 느린 이유를 panel 하나로 답할 수 있다
- **예상 변경**: perf snapshot API ~50 lines + handler + panel ~250 lines

---

## 5. 권한 / 안전

`AGENT_DEVTOOLS_PLAN.md` §5 의 권한 모델을 그대로 적용한다.

| 작업 | Mode |
|---|---|
| `mandu.devtools.context` (read-only) | Observe |
| Builder 입력 확장 (read-only 시그널) | Observe |
| 새 패널들 (read-only) | Observe |
| MCP write tool 자동 실행 | 이 plan 범위 밖 (`AGENT_DEVTOOLS_PLAN.md` M6) |

추가 규칙:

1. `mandu.devtools.context` 응답에서 stack trace / file path 는 redaction 옵션을 거친다 (`packages/core/src/devtools/ai/redaction.ts` 가 이미 있음).
2. production mode (`NODE_ENV=production`) 에서는 `/__kitchen/api/agent-context` 와 MCP tool 모두 403.
3. P0-2 의 `changedFiles` 입력은 path 만 / diff 본문 미포함 (본문이 필요하면 별도 tool 호출).

---

## 6. Tradeoff & Open Questions

### Tradeoff

- **builder 입력 확장의 비용**: `runExtendedDiagnose` 는 a11y_hints 가 포함되어 dev 세션에서 매 호출 비싸다. stale-while-revalidate (예: 30s) 또는 명시적 `?fresh=1` 플래그가 필요. 캐싱 정책을 P0-2 안에서 결정.
- **MCP tool 의 응답 크기**: `AgentContextPack` 전체는 5–15 KB 추정. 에이전트 context window 영향. 응답에 `?fields=situation,nextSafeAction` 같은 partial selection 지원 검토.
- **P1-3 의 Activity 폭증**: build/cache/ws/ate 합치면 dev 세션 분당 수백 event 가능. filter chip 디폴트 OFF + summary line 으로 절충.

### Open Questions

1. `mandu.devtools.context` 는 routes manifest / errors / agentStats 를 어떤 source 에서 읽나? Kitchen HTTP endpoint 를 다시 호출하면 MCP 서버 → Kitchen 서버 round-trip. 대안: MCP 프로세스에서 core API 직접 호출 (kitchen-handler 와 같은 ringBuffer 인스턴스 공유 불가 — 별도 인스턴스가 됨).
2. `changedFiles` 입력의 base ref 는 어떻게 결정? `main` 고정 / `MANDU_DIFF_BASE` env / config option?
3. `boot-breaking` 카테고리가 `runtime` 과 어떻게 우선순위? 동시 발생 시 boot-breaking 이 더 위.
4. P1-4 errors 그룹핑 키는 stack trace hash 만? 또는 message + first stack frame 조합?

---

## 7. P0 시작 체크리스트

P0 두 개를 한 사이클로 묶어 진행할 때 순서:

1. `BundleManifest` / `DiagnoseReport` 타입을 `agent-devtools-api.ts` 입력에 추가 + nullable 처리
2. `pickSituation` 에 `build-broken` / `boot-breaking` 두 카테고리 분기 추가, 우선순위 매트릭스 업데이트
3. `kitchen-handler.ts:371-383` 의 `/api/agent-context` handler 가 새 시그널을 수집해서 builder 로 전달
4. 테스트 픽스처: `bundleManifest === undefined` / `manifest_freshness error` / `nested_internal_core` 시나리오
5. `packages/mcp/src/tools/kitchen.ts` 에 `mandu.devtools.context` tool 등록 — core API 직접 호출 또는 HTTP 호출 결정 (Open Question #1)
6. MCP tool 스키마에 `redaction` / `partial fields` 옵션 추가
7. AGENTS.md 와 `docs/guides/07_agent_workflow.md` 에 새 도구 사용 패턴 한 줄 추가

수용 기준 (둘 다 만족):

- 에이전트: `mandu.devtools.context` 한 번 호출로 situation / tools / prompt / nextAction 받는다.
- 사용자: `.mandu/manifest.json` 손상 / nested core 잔재 같은 boot-breaking 상황이 Supervisor 패널에 자동으로 떠오른다.

---

## 8. UI/UX 디자인 정렬 (mandujs.com Stitch 컨셉)

### 8.1 현재 상태와 컨셉 gap

Kitchen UI 는 현재 **dark dev tool** 무드다 (`kitchen-ui.ts:245-381` 기준).

| 항목 | Kitchen 현재 | mandujs.com Stitch |
|---|---|---|
| 배경 | `#0f1117` (블랙) | `#FFFDF5` (cream) — dark 모드: `#2D241F` 따뜻한 갈색 |
| 본문 텍스트 | `#e4e4e7` (회색) | `#4A3222` (dark brown) |
| 강조색 | `#a78bfa` (라벤더 보라) | `#FF8C66` (peach) |
| 폰트 | `-apple-system, Segoe UI` (시스템) | Pretendard + Nunito display + Consolas mono |
| Radius | `6px` / `50%` | `0.5rem ~ 2.5rem` (8–40px) — rounded & playful |
| Shadow | 거의 없음 | **hard shadow** `4px 4px 0px 0px #4A3222` (블러 0, 단색 블록) |
| 톤 | 비인격적 / DataDog 류 | warm / playful / 캐릭터 친화 (mandu 마스코트) |

DESIGN.md (`/c/.../mandujs.com/DESIGN.md`) 는 Stripe inspiration 으로 적혀 있지만 **실제 운영 중인 시스템은 Stitch** (`mandujs.com/app/globals.css:1-180`). 정합성의 기준은 **globals.css 의 Stitch**.

### 8.2 적용 원칙

Kitchen 은 marketing 사이트가 아니라 **dev tool** 이다. mandujs.com 의 무드를 그대로 가져오면 정보 밀도가 떨어진다. 우선순위:

1. **토큰 swap > 컴포넌트 재디자인**. 같은 레이아웃 / 같은 정보 밀도, 색·폰트·radius·shadow 토큰만 교체.
2. **dark 가 디폴트, light 는 toggle**. dev tool 은 dark 가 시각 피로 면에서 우위. Stitch 의 dark 모드 토큰 (`--color-dark-bg: #2D241F`, `--color-dark-surface: #3E3028`, `--color-dark-text: #FFF0E6`) 이 이미 정의돼 있다 — 이것을 Kitchen 디폴트로.
3. **hard shadow 는 surface 단위로만**. 모든 panel 카드에 `4px 4px 0px 0px <border>` 적용 시 노이즈가 된다. dropdown / 패널 헤더 / CTA 버튼에 한정.
4. **mascot / dot-pattern / sparkle 애니메이션은 별도 단계**. 캐릭터 요소는 정보 dense 한 supervisor 화면에서 거슬릴 수 있음. 빈 상태(empty state) / 성공 토스트 정도에 한정.
5. **mono 폰트는 Consolas 통일**. Kitchen 의 `"SF Mono", Monaco, "Cascadia Code"` 를 `Consolas, Monaco, "Ubuntu Mono"` 로 — 코드 블록 / correlationId / file path 표시가 mandujs.com docs 와 동일한 느낌.

### 8.3 토큰 매핑 (dev tool dark 모드 기준)

`kitchen-ui.ts` 의 inline CSS 를 다음 토큰으로 통일:

```css
:root[data-mandu-kitchen] {
  /* 배경 / surface */
  --kt-bg: #2D241F;          /* mandujs.com --color-dark-bg */
  --kt-surface: #3E3028;     /* --color-dark-surface */
  --kt-surface-2: #4A3D32;   /* surface 위 elevated */
  --kt-border: #5A4A3A;      /* --color-dark-border */

  /* 텍스트 */
  --kt-text: #FFF0E6;        /* --color-dark-text */
  --kt-text-muted: #C9B7A8;
  --kt-text-dim: #7A6B5D;    /* --color-dark-muted */

  /* 강조 / 상태 */
  --kt-primary: #FF8C66;     /* peach — interactive / active tab */
  --kt-primary-hover: #FF7A4F;
  --kt-accent-yellow: #FFD15C; /* warning */
  --kt-accent-pink: #FFB5A0;   /* secondary tag */
  --kt-success: #5DE4C7;       /* syn-string green */
  --kt-danger: #FF7EB6;        /* syn-keyword pink */

  /* radius */
  --kt-r-sm: 0.5rem;   /* 8px — badge, chip */
  --kt-r-md: 0.75rem;  /* 12px — button, input */
  --kt-r-lg: 1rem;     /* 16px — panel card */
  --kt-r-xl: 1.5rem;   /* 24px — featured / dialog */

  /* shadow — hard 한 줄 */
  --kt-shadow-hard-sm: 2px 2px 0 0 var(--kt-border);
  --kt-shadow-hard:    4px 4px 0 0 var(--kt-border);

  /* 폰트 */
  --kt-font-sans: 'Pretendard Variable', 'Pretendard', ui-sans-serif, system-ui, sans-serif;
  --kt-font-display: 'Nunito', 'Pretendard Variable', ui-sans-serif;
  --kt-font-mono: 'Consolas', 'Monaco', 'Ubuntu Mono', ui-monospace, monospace;
}
```

기존 색상 → 신규 토큰 매핑:

| 현재 (`kitchen-ui.ts`) | 변경 |
|---|---|
| `#0f1117` (page bg) | `var(--kt-bg)` |
| `#18181b` (header / tabs bg) | `var(--kt-surface)` |
| `#27272a` (button bg) | `var(--kt-surface-2)` |
| `#e4e4e7` (body text) | `var(--kt-text)` |
| `#a1a1aa`, `#71717a`, `#52525b` (muted) | `var(--kt-text-muted)` / `var(--kt-text-dim)` |
| `#a78bfa` (active tab) | `var(--kt-primary)` |
| `#22c55e` / `#ef4444` / `#eab308` (status dot) | `var(--kt-success)` / `var(--kt-danger)` / `var(--kt-accent-yellow)` |
| `border-radius: 6px` (button) | `var(--kt-r-md)` |
| `border-radius: 50%` (status dot) | 유지 (점은 원형) |
| `"SF Mono", Monaco, ...` | `var(--kt-font-mono)` |

### 8.4 작업 우선순위

#### DA-1 (P0 동행) — 토큰만 swap

`kitchen-ui.ts` 의 inline `<style>` 에 위 토큰 블록 추가, 색·폰트·radius 만 변수 참조로 변경. 레이아웃 / 정보 구조 변경 없음.

- 수용 조건: 시각적으로 mandujs.com docs 와 같은 family 임이 한눈에 인지된다 (peach 강조색, cream/brown surface, Pretendard 본문).
- 예상 변경: ~150 lines (CSS 만)
- P0 사이클에 같이 들어갈 수 있음 — 데이터 변경과 독립.

#### DA-2 (P1 동행) — hard shadow + button 통일

- 패널 헤더 / dropdown / primary CTA 에만 `--kt-shadow-hard` 적용. hover 시 shadow 0 + `translate(2px, 2px)` (`globals.css:155-168` 의 `.btn-hard` 패턴).
- "Approve violation" / "Run guard" 같은 action 버튼만 peach + hard shadow. 일상 navigation 버튼은 ghost.
- 수용 조건: 클릭할 곳이 한눈에 분리됨. read-only navigation 과 write action 의 시각 weight 가 다르다.
- 예상 변경: ~80 lines (CSS + 일부 wrapper class 추가)

#### DA-3 (P2 동행) — 마스코트·empty state·sparkle

- panel 빈 상태에 floating mandu 마스코트 (`mandujs.com/public/mandu-*.svg` 류 자산 재활용).
- 성공 토스트 (`Decision saved` 등) 에 `sparkle-twinkle` 잠깐.
- `dot-pattern` 을 페이지 배경에 매우 낮은 opacity (0.03) 로.
- 수용 조건: warm / playful 첫인상이 정보 가독성을 깨지 않는다.
- 예상 변경: SVG asset 임베드 + ~60 lines CSS

### 8.5 라이트/다크 모드

Kitchen 디폴트는 dark (위 토큰). light 모드는 phase 2 — `prefers-color-scheme` 또는 명시 toggle 시 다음으로 swap:

| 토큰 | dark | light |
|---|---|---|
| `--kt-bg` | `#2D241F` | `#FFFDF5` |
| `--kt-surface` | `#3E3028` | `#FFFFFF` |
| `--kt-border` | `#5A4A3A` | `#4A3222` |
| `--kt-text` | `#FFF0E6` | `#4A3222` |
| `--kt-primary` | `#FF8C66` | `#FF8C66` (공통) |

토큰 이름이 같으니 `[data-theme="light"]` selector 한 줄로 override.

### 8.6 안전·검증

- **정보 밀도 회귀 금지**. token swap 전후 동일 view 의 정보 줄 수가 ±5% 이내여야 한다. radius 만 키우면 줄 수 줄어들기 쉽다.
- **색 대비**. peach `#FF8C66` on dark `#2D241F` 의 WCAG AA 검증 (`kitchen-handler.ts` 의 a11y_hints diagnose 가 dev mode 에서도 실행 가능). active tab / primary button / link 3개 위주.
- **글꼴 로딩**. Pretendard / Nunito 가 사용자 프로젝트에 없을 수 있음. inline `<link>` 로 fontsource CDN 또는 `font-display: swap` fallback 보장. dev tool 이 폰트 로딩으로 깜빡이면 안 됨.
- **dev only**. production 빌드는 어차피 Kitchen 비활성화 (`AGENT_DEVTOOLS_PLAN.md` §5). 디자인 변경의 사용자 영향은 dev 세션에 한정.

---

## 9. 이 plan 이 다루지 않는 것

- `AGENT_DEVTOOLS_PLAN.md` M6 (Assisted Action) — MCP write tool 실행, OAuth login/logout UI, approval flow
- production-mode supervisor (현재 dev only)
- multi-workspace / team mode (현재 single project)
- chat / inline action UI (현재 panel based read surface)
- LLM-assisted prompt rewriting (P0 prompt 는 정적 template)

이들은 P0–P3 가 안정된 뒤 별도 plan 에서 다룬다.
