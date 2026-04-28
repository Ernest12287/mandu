# @mandujs/mcp

## 0.32.1

### Patch Changes

- Updated dependencies [[`b3f3899`](https://github.com/konamgil/mandu/commit/b3f389979d236c3b8977f4a95dc11796ef14a112)]:
  - @mandujs/core@0.44.0

## 0.32.0

### Minor Changes

- [`fe765d1`](https://github.com/konamgil/mandu/commit/fe765d1c5c0d054ea890f5c38a1c6f3751226dba) Thanks [@konamgil](https://github.com/konamgil)! - feat: lint as default guardrail across CLI, MCP, and skills

  Positions oxlint as the third guardrail axis alongside `mandu guard`
  (architecture) and `tsgo` (types). Every Mandu surface now treats
  lint as a first-class default:

  - **`mandu check`** — runs oxlint when available, adds the result to
    the health score. Errors flip exit; warnings are reported.
  - **`mandu build`** — pre-build lint gate. Errors block the build;
    `--no-lint` opts out for emergency deploys.
  - **`mandu init` templates** — `default` / `auth-starter` /
    `realtime-chat` ship `lefthook.yml` (pre-push: typecheck + lint
    in parallel), `lefthook` devDep, and `prepare: "lefthook install"`.
  - **MCP tools** — new `mandu.lint` (read-only runner) and
    `mandu.lint.setup` (destructive installer wrapping the CLI
    command). `dryRun: true` previews.
  - **Skills** — new `mandu-lint` SKILL.md covering guardrail
    positioning, setup, type-aware, safe-autofix pattern, and
    anti-patterns. `mandu-guard-guide` gains a 3-axis header.
    `mandu-mcp-verify` fast path becomes 4-parallel (lint joins
    ate/guard/doctor) with a new lint drill-down branch.
    `mandu-mcp-safe-change` Step 4 explicitly includes lint.

### Patch Changes

- Updated dependencies [[`fe765d1`](https://github.com/konamgil/mandu/commit/fe765d1c5c0d054ea890f5c38a1c6f3751226dba)]:
  - @mandujs/skills@0.19.0

## 0.31.0

### Minor Changes

- [`ad21b50`](https://github.com/konamgil/mandu/commit/ad21b50a5740754031a39f36d484f30ecb93013c) Thanks [@konamgil](https://github.com/konamgil)! - feat: #240 React Compiler + #241 island UX + #242 content watch + #243 docs MCP

  **#240 — React Compiler opt-in** (@mandujs/core, @mandujs/cli)

  - New `@mandujs/core/bundler/plugins/react-compiler` — inline-ported
    Bun plugin that runs `babel-plugin-react-compiler` over the
    client-bundle path (islands / `"use client"` / partial). SSR paths
    are deliberately skipped — re-render memoization has zero value on
    a one-shot HTML render.
  - `ManduConfig.experimental.reactCompiler.{enabled,compilerConfig,strict}`
    — opt-in flag + passthrough config + Phase-2 CI-strict switch.
  - `@babel/core` + `babel-plugin-react-compiler` declared as optional
    peer deps; missing install degrades to a logged warning.
  - React peer pinned to `^19.2.0` across root + core + all three user
    templates (react-compiler runtime needs ≥19.1).
  - Dev bundler forwards the flag through every `buildClientBundles()`
    rebuild path; CLI `mandu dev` reads `config.experimental.reactCompiler`.
  - **Phase 2** — `mandu check` runs `eslint-plugin-react-compiler`
    over the exact files the bundler would compile and surfaces
    bailouts. `strict: true` makes any bailout a non-zero exit. ESLint
    - plugin are optional peers; missing install skips diagnostics with
      a warning.
  - New `docs/architect/react-compiler.md` — activation, scope, peer
    deps, bailout behaviour, dev/prod trade-offs, CI-strict mode.

  **#241 — island authoring UX fixes** (@mandujs/core)

  - Export `Mandu` alias of `ManduClient` so the README's documented
    `Mandu.island/filling` shape resolves at runtime.
  - `scanIslandFiles()` now also descends into `_components/` +
    `_islands/` sibling folders (one level) — previously only the
    page's own directory was scanned, silently dropping co-located
    islands.
  - `CompiledIsland` is now a callable React component whose body
    throws a clear `[Mandu Island] Islands are page-level client
bundles …` message pointing at `partial()` — replaces React's
    opaque "Element type is invalid... got: object" error.

  **#242 — content collection dev server watcher** (@mandujs/core, @mandujs/cli)

  - `Collection` constructor registers into a module-scoped Set;
    `getRegisteredCollections()` + `invalidateAllCollections()` exposed
    from `@mandujs/core/content`.
  - Dev bundler watches `content/` by default, classifier routes
    `*.{mdx,md,yaml,yml,json}` under that directory to a new
    `content-change` batch kind, and `handleContentChange` invalidates
    every registered collection + fires optional `onContentChange`
    callback.
  - CLI `mandu dev` wires the callback to a `full-reload` HMR
    broadcast so sidebars / route trees refresh without a manual
    restart.

  **#243 — docs MCP tools** (@mandujs/mcp)

  - `mandu.docs.search({ query, scope?, limit?, includeBody? })` —
    offline keyword search over the project's `docs/` markdown tree.
    Scored by title / body hits, bounded (5 000 files max, 280-char
    excerpts), traversal-safe.
  - `mandu.docs.get({ slug })` — fetch a single markdown page by
    relative slug. Pairs with `search` for ground-truth answers.

  Both tools are read-only, offline, and add zero new dependencies.

### Patch Changes

- [`f92151b`](https://github.com/konamgil/mandu/commit/f92151b2ef129b1dff068024fb527b443874d50e) Thanks [@konamgil](https://github.com/konamgil)! - feat(guard): #follow-up-E `mandu guard --type-aware` bridge

  Wires `oxlint --type-aware` (tsgolint) into Mandu Guard as an opt-in
  type-aware lint layer that runs after the architecture / layer check.

  - **`@mandujs/core/guard/tsgolint-bridge`** — new module. Spawns
    `oxlint --type-aware --format=json` with `Bun.spawn`, translates each
    diagnostic into the existing `Violation` contract, and returns a
    `{ violations, summary, skipped? }` envelope. Graceful skip when the
    binary is absent (`node_modules/.bin/oxlint[.exe]` missing →
    `{ skipped: "oxlint-not-installed" }`). 60s wall-clock timeout
    (`MANDU_TSGOLINT_TIMEOUT_MS` env override for slow agents).

  - **`ManduConfig.guard.typeAware`** — new optional config block.
    Fields: `rules?: string[]` (allowlist), `severity?: "off"|"warn"|"error"`,
    `configPath?: string`. Declaring the block flips the default to "on"
    for `mandu guard`; the CLI's `--no-type-aware` flag always wins.

  - **`mandu guard --type-aware` / `--no-type-aware`** — CLI flags on
    `guard-arch`. Type-aware errors flip the exit code; warnings alone
    stay green (CI flag escalates warnings, matching the architecture
    pass). JSON output mode emits a secondary `{ typeAware }` JSON document.

  - **`mandu_guard_check` MCP tool** — gains a `typeAware?: boolean`
    input field; response JSON mirrors the CLI shape via a new
    `typeAware` field (skip reason, summary, violations).

  No new runtime dependencies — `oxlint` stays a user-side dev dep.
  Existing architecture-layer Guard tests unchanged (272 pass). Adds
  21 new tests (15 bridge + 6 CLI) covering rule-id normalization,
  severity mapping, diagnostic translation, binary resolution,
  graceful skip, severity=off short-circuit, filter allowlist, and
  CLI exit-code gating.

- Updated dependencies [[`f92151b`](https://github.com/konamgil/mandu/commit/f92151b2ef129b1dff068024fb527b443874d50e), [`ad21b50`](https://github.com/konamgil/mandu/commit/ad21b50a5740754031a39f36d484f30ecb93013c)]:
  - @mandujs/core@0.43.0

## 0.30.0

### Minor Changes

- [`cb32140`](https://github.com/konamgil/mandu/commit/cb32140b58aef9cc8d78a5d4975329cc8d81b2a7) Thanks [@konamgil](https://github.com/konamgil)! - #237 — mandu.ate.run / mandu_ate_run scope filters (onlyFiles, onlyRoutes, grep),
  mandu.dev.start TCP port polling against server.port from mandu.config.ts (fallback 3333),
  and mandu.brain.status suggestions[] pointing at the current tier's LLM invocation paths.
  Tool descriptions for mandu.ate.heal and mandu.brain.doctor clarify their LLM-call
  behaviour. No new runtime dependencies; TCP probe uses node:net.

### Patch Changes

- Updated dependencies [[`cb32140`](https://github.com/konamgil/mandu/commit/cb32140b58aef9cc8d78a5d4975329cc8d81b2a7)]:
  - @mandujs/ate@0.25.1

## 0.29.0

### Minor Changes

- [`e56697e`](https://github.com/konamgil/mandu/commit/e56697eaabef2d615f9d637f8b10d152006a0975) Thanks [@konamgil](https://github.com/konamgil)! - feat(ate,mcp): stream run events to eventBus — activity monitor sees ATE flow

  ATE runner now emits six structured events per `mandu.ate.run`
  invocation (`run_start`, `spec_progress`, `spec_done`,
  `failure_captured`, `artifact_saved`, `run_end`) on the
  `@mandujs/core/observability` singleton eventBus. Activity monitor
  subscribes to `type: "ate"` and renders per-spec pass/fail lines,
  `failure.v1` kind summaries, and artifact directory paths in pretty
  mode; JSON mode streams each event verbatim to
  `.mandu/mcp-activity.jsonl` for agent consumption.

  Eliminates the black-box problem where `mandu.ate.run` looked like a
  single opaque tool call in the monitor — agents and humans can now see
  which spec is running, which failed, what kind of failure (selector
  drift / contract mismatch / hydration timeout / ...), and where the
  `trace.zip` landed.

  Also resolves #238 end-to-end:

  - `mandu.ate.run` / `mandu_ate_run` MCP handlers pipe `spec_done`
    events through `notifications/progress` so long runs no longer look
    hung. Accepts an optional `progressToken` from the client;
    gracefully falls back to the ATE `runId` when unset.
  - Timeout / cancel paths now persist a partial `results.json` under
    `.mandu/reports/run-<runId>/` (completed specs + captured failures +
    runId) so `mandu.ate.heal` stays reachable even when Playwright hit
    the 10-min watchdog.

  Core changes:

  - `EventType` union gains `"ate"` as a first-class category so
    observability consumers (SQLite store, Prometheus exporters) can
    scope queries.

  ATE changes:

  - `runSpec()` emits the canonical six-event lifecycle.
  - `artifact-store`'s `writeTextArtifact` / `stageArtifact` emit
    `artifact_saved` on each write.
  - New `AteMonitorEvent` discriminated union exported from
    `@mandujs/ate`.
  - New `emitAteEvent` + typed wrappers (`emitRunStart`, ...) exported
    for downstream emitters.

  MCP changes:

  - `ActivityMonitor` subscribes to `eventBus.on("ate")`, renders pretty
    rows (start / per-spec pass-fail / end + inlined failure kind) and
    emits verbatim JSON lines to `activity.jsonl`.
  - New `ATE-RUN` / `ATE-PASS` / `ATE-FAIL` display tokens in
    `TOOL_ICONS`.
  - `ateRunTools` / `ateTools` accept an optional `Server` instance so
    `notifications/progress` flow through the MCP transport; tests that
    boot without a server gracefully no-op.
  - New `createAteProgressTracker` + `writePartialResults` exports for
    downstream reuse and testing.

  No new runtime dependencies. Typecheck clean across all 7 packages.
  18 new tests (ate: 5, mcp activity-monitor: 3, mcp progress: 5, plus
  existing regression coverage).

### Patch Changes

- Updated dependencies [[`e56697e`](https://github.com/konamgil/mandu/commit/e56697eaabef2d615f9d637f8b10d152006a0975)]:
  - @mandujs/core@0.42.0
  - @mandujs/ate@0.25.0

## 0.28.2

### Patch Changes

- [`02d5ef2`](https://github.com/konamgil/mandu/commit/02d5ef22f186577f42a13e1081f57754cc4fb617) Thanks [@konamgil](https://github.com/konamgil)! - fix(mcp): #236 clear error when a stale nested @mandujs/core resolves

  When Bun's installer placed `node_modules/@mandujs/mcp/node_modules/@mandujs/core@0.39.0`
  alongside the hoisted top-level `@mandujs/core@0.41.1`, the MCP brain
  handlers crashed with `getCredentialStore is not a function` /
  `undefined is not a constructor` — no hint about where the stale copy
  came from.

  - `@mandujs/core` now exports `__MANDU_CORE_VERSION__`, read at module
    load time directly from the package's own `package.json` so the
    value can never drift from the published version.
  - `@mandujs/mcp` asserts the brain-auth surface (`getCredentialStore`,
    `resolveBrainAdapter`, `ChatGPTAuth`, `AnthropicOAuthAdapter`,
    `revokeConsent`) on every brain MCP call. Missing exports throw with
    the actual version that resolved, an explanation of why it happened
    (Bun nested-install quirk), and the one-line fix
    (`rm -rf node_modules bun.lock && bun install`).

  The underlying Bun install behavior is not fixed here — that's an
  upstream bug / hoisted-linker interaction — but the failure is now
  diagnosable in one error line instead of a cryptic undefined call.

- Updated dependencies [[`02d5ef2`](https://github.com/konamgil/mandu/commit/02d5ef22f186577f42a13e1081f57754cc4fb617)]:
  - @mandujs/core@0.41.2

## 0.28.1

### Patch Changes

- [`e73b68d`](https://github.com/konamgil/mandu/commit/e73b68df10bb006a675794a1b4eaec6442fe015e) Thanks [@konamgil](https://github.com/konamgil)! - fix(brain): resolver + status now see ChatGPT session token; MCP login spawns codex directly

  Two bugs landed together:

  1. After `mandu brain login --provider=openai` succeeded the resolver
     still reported `Active tier: ollama`. `resolveBrainAdapter` only
     probed the keychain and ignored `~/.codex/auth.json`. Added
     `probeChatGPTAuth()` hook (checks via `ChatGPTAuth.isAuthenticated`)
     to both the explicit-openai path and the auto-resolve path. CLI
     `brain status` now shows `openai : logged in (ChatGPT session at
...auth.json, managed by @openai/codex)`.

  2. MCP `mandu.brain.login` previously bailed with `{ ok: false,
reason: "not_a_tty" }` because an MCP server has no terminal. But
     Codex CLI itself opens the user's default browser via OS handlers
     (`start` / `open` / `xdg-open`) — a TTY isn't required. Rewrote
     the MCP handler to `spawn('npx @openai/codex login')` as a child
     process, capture stdout for the OAuth URL, and poll for
     `~/.codex/auth.json` up to `waitMs` (default 3 min). Works from
     any MCP client without requiring a `pty` MCP.

  Resolver gets a new `probeChatGPTAuth` option on
  `BrainAdapterConfig` (tests inject a stub returning `{ authenticated:
false, path: null }` so the developer's real auth.json doesn't leak
  into unit-test expectations).

- Updated dependencies [[`e73b68d`](https://github.com/konamgil/mandu/commit/e73b68df10bb006a675794a1b4eaec6442fe015e)]:
  - @mandujs/core@0.41.1

## 0.28.0

### Minor Changes

- [`a76eb21`](https://github.com/konamgil/mandu/commit/a76eb21625d9b1fa6bba074c8efe347662f316c6) Thanks [@konamgil](https://github.com/konamgil)! - feat(mcp/brain): expose login / logout / status as MCP tools

  Three new MCP tools make the brain auth surface usable from agents
  (Cursor / Claude Code / Codex) without dropping to the CLI:

  - `mandu.brain.status` — read-only. Returns the active adapter tier,
    reason, backend, and a per-provider status block (keychain token vs.
    ChatGPT-session `auth.json` vs. not logged in). Safe to poll.
  - `mandu.brain.login` — `{ provider?: "openai" | "anthropic" }`.
    OpenAI delegates to `npx @openai/codex login` (OpenAI-official
    OAuth). Anthropic runs the Mandu-managed loopback flow. Returns
    `{ ok, exit_code?, auth_file?, note }`. Detects non-TTY environments
    and returns an instruction string instead of hanging.
  - `mandu.brain.logout` — `{ provider?: "openai" | "anthropic" | "all" }`.
    Deletes keychain tokens + per-project consent. Intentionally does
    NOT touch `~/.codex/auth.json` (Codex owns that file); the response
    includes the command to run for full revocation.

  All three tools are thin wrappers over the existing `@mandujs/core`
  APIs (`ChatGPTAuth`, `getCredentialStore`, `resolveBrainAdapter`,
  `AnthropicOAuthAdapter`, `revokeConsent`).

## 0.27.2

### Patch Changes

- Updated dependencies [[`eea2ff9`](https://github.com/konamgil/mandu/commit/eea2ff982cf210d6d5d6a7eaf06a3667de92ca3d)]:
  - @mandujs/core@0.41.0

## 0.27.1

### Patch Changes

- Updated dependencies [[`6ded2af`](https://github.com/konamgil/mandu/commit/6ded2af0bed3eaec90aafa0e0d7b077099d07ecc), [`6ded2af`](https://github.com/konamgil/mandu/commit/6ded2af0bed3eaec90aafa0e0d7b077099d07ecc)]:
  - @mandujs/core@0.40.0
  - @mandujs/skills@0.18.0

## 0.27.0

### Minor Changes

- [`e77b035`](https://github.com/konamgil/mandu/commit/e77b035dd28cc256a596fe5221f781c5609645e9) Thanks [@konamgil](https://github.com/konamgil)! - feat(core,ate,mcp,cli): Phase C — primitives + mutation + RPC + oracle

  Ships ATE v2 Phase C (docs/ate/phase-c-spec.md, 364-line spec):

  - 5 Mandu-specific assertion primitives in @mandujs/core/testing:
    expectContract(strict/loose/drift-tolerant), expectNavigation,
    waitForIsland (data-hydrated polling), assertStreamBoundary
    (<!--$--> marker count + shell budget), expectSemantic
    (agent-delegated, CI non-blocking).
  - 9 contract-semantic mutation operators (remove_required_field,
    narrow_type, widen_enum, flip_nullable, rename_field,
    swap_sibling_type, skip_middleware, early_return,
    bypass_validation). runner writes tmpdir, kills/survives/timeout
    classification. mutationScore + severity report via
    mandu_ate_mutate + mandu_ate_mutation_report.
  - RPC parity: defineRpc extractor emits rpc_procedure nodes,
    context scope "rpc" with dot-notation id, boundary probe works
    automatically on input schemas.
  - Oracle queue: .mandu/ate-oracle-queue.jsonl, mandu_ate_oracle_pending /
    verdict / replay. Semantic judgments deferred to agent session,
    deterministic CI never blocked. promoteVerdicts regresses past
    fails on next run.
  - Prompt catalog +3: island_hydration, streaming_ssr, rpc_procedure.

  Test counts: ate 575 / mcp 220. Typecheck clean across 7 packages.
  ATE v2 core surface complete.

### Patch Changes

- Updated dependencies [[`e77b035`](https://github.com/konamgil/mandu/commit/e77b035dd28cc256a596fe5221f781c5609645e9)]:
  - @mandujs/core@0.39.0
  - @mandujs/ate@0.24.0
  - @mandujs/skills@17.0.0

## 0.25.0

### Minor Changes

- [`0aa24be`](https://github.com/konamgil/mandu/commit/0aa24be35be5db3774881da319fa04bf6dc72bcd) Thanks [@konamgil](https://github.com/konamgil)! - Phase B — boundary probe + memory + impact v2 + coverage

  Ships ATE v2 Phase B (docs/ate/phase-b-spec.md):

  - `mandu_ate_boundary_probe`: Zod contract → deterministic boundary set.
    18 type mappings (string/number/boolean/array/object/enum/union/literal
    plus min/max/email/uuid/regex/int/optional/nullable/nullish) —
    `expectedStatus` derived from contract response schema (400/422 for
    invalid, 200/201 for valid), depth-1 default with max 3,
    category+value dedup.
  - `mandu_ate_recall` + `mandu_ate_remember`: append-only
    `.mandu/ate-memory.jsonl`. 7 event kinds: intent_history,
    rejected_spec, accepted_healing, rejected_healing,
    prompt_version_drift, boundary_gap_filled, coverage_snapshot.
    Substring + token-overlap scoring; auto-rotate at 10 MB to
    `.mandu/ate-memory.<ts>.jsonl.bak`. Auto-record hooks on
    `mandu_ate_save` (intent_history), `applyAutoHeal`
    (accepted_healing), and first-of-day `mandu_ate_context`
    (coverage_snapshot).
  - `mandu_ate_impact` v2: git diff classification (additive / breaking /
    renaming via Levenshtein ≥ 0.8), affected spec/contract resolution,
    suggestion list keyed to re_run / heal / regenerate /
    add_boundary_test. Supports `since: "HEAD~1" | "staged" | "working"`.
    v1 output fields preserved for backwards compatibility.
    `mandu ate watch` CLI (fs.watch + 1 s debounce) streams impact v2 on
    working-tree changes.
  - `mandu_ate_coverage`: route × contract × invariant matrix.
    `withBoundaryCoverage` / `withPartialBoundary` / `withNoBoundary`
    derived from boundary-probe presence in covering specs; invariant
    detection for csrf / rate_limit / session / auth / i18n;
    severity-ranked `topGaps` (high / medium / low).
  - Prompt catalog +3: `property_based.v1`, `contract_shape.v1`,
    `guard_security.v1`. 12+ new `@ate-exemplar:` tags across
    `packages/core/tests/**` and `packages/ate/tests/exemplar-sources/`.
  - `mandu ate memory clear` / `mandu ate memory stats` CLI subcommands.

  Tests: +94 ate (429 → 523) + +10 mcp (194 → 204) + +3 cli.
  `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` clean across
  all 7 packages.

### Patch Changes

- Updated dependencies [[`0aa24be`](https://github.com/konamgil/mandu/commit/0aa24be35be5db3774881da319fa04bf6dc72bcd)]:
  - @mandujs/ate@0.22.0

## 0.24.0

### Minor Changes

- [`2013674`](https://github.com/konamgil/mandu/commit/20136745bcc3d5758d7221608e15e24cafb31239) Thanks [@konamgil](https://github.com/konamgil)! - feat(ate,mcp): Phase A.2 — structured diagnostics, flake detection, artifacts, graph freshness

  Ships ATE v2 Phase A.2 per `docs/ate/roadmap-v2-agent-native.md` §7 and the 2026-04-21 senior-grade extension block:

  - `failure.v1` Zod schema + TypeScript type (`FailureV1`) with 8 discriminated kinds: `selector_drift`, `contract_mismatch`, `redirect_unexpected`, `hydration_timeout`, `rate_limit_exceeded`, `csrf_invalid`, `fixture_missing`, `semantic_divergence`. Every failure carries `flakeScore`, `lastPassedAt`, `graphVersion`, and `trace: { path?, screenshot?, dom? }`.
  - `runSpec()` — unified spec runner that auto-detects Playwright vs bun:test from the path, forwards `shard: { current, total }` (Playwright `--shard=c/t`, bun hash partition), captures trace/screenshot/dom artifacts into `.mandu/ate-artifacts/<runId>/` before they can be garbage-collected, and translates raw runner output into deterministic `failure.v1` JSON (Playwright error objects are translated, not pass-through).
  - Deterministic selector-drift auto-heal (`autoHeal`) — similarity = 0.5·text + 0.3·role + 0.2·DOM-proximity. Threshold precedence: explicit arg → `.mandu/config.json` → `MANDU_ATE_AUTO_HEAL_THRESHOLD` env → 0.75 default. Dry-run only; `applyAutoHeal()` is a separate, opt-in call.
  - Flake detector — `.mandu/ate-run-history.jsonl` append-only log, rolling pass/fail transition score over the last `windowSize` runs. Alternating PFPF scores 1.0; pure PPPPP and pure FFFFF both score 0 (broken ≠ flaky). Auto-prune amortized at 10k entries.
  - Artifact store — `.mandu/ate-artifacts/<runId>/`, keep-last-N policy (default 10, override via `MANDU_ATE_ARTIFACT_KEEP`).
  - `graphVersion` freshness signal — `sha256(sorted routeIds + sorted contractIds + extractor version)` stamped on every context response and every failure payload. Agent cache invalidation key.
  - `mandu_ate_run` MCP tool — `{ repoRoot, spec, headed?, trace?, shard? }` → `RunResult` (validated against `failureV1Schema` at the MCP boundary).
  - `mandu_ate_flakes` MCP tool — `{ repoRoot, windowSize?, minScore? }` → `{ flakyTests: Array<{ specPath, flakeScore, lastRuns, lastPassedAt }> }`.

  Resolves #229 (heal step returned empty suggestions — selector-drift now produces ranked deterministic candidates with confidence scores). 28 new tests across ate + mcp, zero runtime dependencies added.

- [`2013674`](https://github.com/konamgil/mandu/commit/20136745bcc3d5758d7221608e15e24cafb31239) Thanks [@konamgil](https://github.com/konamgil)! - feat(ate,mcp,cli): Phase A.3 — prompt catalog v1 + exemplar system

  Ships ATE v2 Phase A.3 per `docs/ate/roadmap-v2-agent-native.md` §7 and the 2026-04-21 extension block.

  - **Prompt catalog** — 3 Markdown prompts in `packages/ate/prompts/`: `filling_unit.v1.md`, `filling_integration.v1.md`, `e2e_playwright.v1.md`. Each under 2000 tokens, English body, Korean intent comments allowed. YAML frontmatter carries `kind`, `version`, `base`, `audience`, `mandu_min`. Every prompt documents MUST-USE primitives, NEVER-DO anti-patterns, the Mandu `data-route-id` / `data-island` / `data-slot` / `data-action` selector convention, 127.0.0.1-over-localhost rule, and a `<!-- EXEMPLAR_SLOT -->` injection point.
  - **`prompt-loader`** — reads `.vN.md` files, parses frontmatter, returns `{frontmatter, body, sha256}` with a stable sha256 cache key. Also accepts un-versioned alias files.
  - **`exemplar-scanner`** — walks `.ts`/`.tsx` with ts-morph, captures the full source of the `test()`/`it()`/`describe()` call following every `@ate-exemplar:` or `@ate-exemplar-anti:` marker. Distinguishes real comment markers from string-literal fixtures + JSDoc examples. Manually curated per §11 decision #2 (no auto-heuristic).
  - **`prompt-composer`** — end-to-end helper that loads a template, selects 2-3 matching positive exemplars + (up to) 1 anti-exemplar, replaces `<!-- EXEMPLAR_SLOT -->` with a formatted Examples / Anti-examples section, and appends a JSON-serialized context block. Returns ready-to-send-to-LLM string + `tokenEstimate`.
  - **`spec-linter`** (ate barrel) — shared lint pass for agent-generated test content: ts-morph syntax parse, banned import typos (e.g. `@mandu/core` → `@mandujs/core`), unknown `@mandujs/*` barrels, unused/unresolved imports, bare `localhost` URLs (blocks — prefer 127.0.0.1 per roadmap §9.2), hand-rolled CSRF cookies when `createTestSession` is available, DB mocks when `createTestDb` is available.
  - **3 new MCP tools** (snake_case per §11 #4):
    - `mandu_ate_prompt` — when `context` is passed, returns the fully composed prompt (template + matched exemplars + serialized context); otherwise returns the raw template + sha256 + an exemplar peek so the agent composes.
    - `mandu_ate_exemplar` — returns the `@ate-exemplar:` tagged tests for a kind, with code + metadata; `includeAnti:true` opt-in for negative examples.
    - `mandu_ate_save` — lint-before-write persister. Runs `spec-linter`; any blocking diagnostic aborts the write with a structured list the agent can address and retry against.
  - **CLI** — new `mandu ate lint-exemplars` subcommand. Scans the repo, flags orphan markers (no following test block), anti-markers missing `reason=`, and unknown kinds. Exits 1 on any problem (CI-friendly). `--json` for machine output.
  - **Prompt goldens** — `packages/ate/tests/prompts/<kind>.golden.md` captures the canonical composer output per kind; re-generate with `UPDATE_GOLDEN=1 bun test`.
  - **Exemplar tagging sprint** — 18 positive + 2 anti-exemplars tagged across core filling tests, core server integration tests, and the demo auth-starter E2E suite.

  35 new tests across `@mandujs/ate`, `@mandujs/mcp`, and `@mandujs/cli`. Typecheck clean across all 7 packages. No new runtime dependencies (ts-morph + zod already present).

### Patch Changes

- Updated dependencies [[`2013674`](https://github.com/konamgil/mandu/commit/20136745bcc3d5758d7221608e15e24cafb31239), [`2013674`](https://github.com/konamgil/mandu/commit/20136745bcc3d5758d7221608e15e24cafb31239)]:
  - @mandujs/ate@0.21.0

## 0.23.0

### Minor Changes

- [`81b4ff7`](https://github.com/konamgil/mandu/commit/81b4ff7adfbba4daeb070fdc6ff41a2e851c53fd) Thanks [@konamgil](https://github.com/konamgil)! - feat(ate,mcp): Phase A.1 — `mandu_ate_context` + 5-kind extractor expansion

  First deliverable of the agent-native ATE v2 roadmap
  (`docs/ate/roadmap-v2-agent-native.md` §7 Phase A.1).

  **ATE extractor** now scans seven node kinds (was route-only): `route`,
  `filling`, `slot`, `island`, `action`, `form`, `modal`. `InteractionNode`
  stays backwards compatible — existing route-only consumers keep working.
  Also ingests `generateStaticParams` array literals statically (for the
  Phase B boundary probe) and surfaces contract `examples` from
  `.contract.ts` files.

  **New `mandu_ate_context` MCP tool** (`scope: project | route | filling
| contract`, optional `id` / `route` arg). Returns a single JSON blob
  containing route metadata + contract + middleware chain + guard preset

  - suggested `[data-route-id]` selectors + fixture recommendations +
    existing specs + related routes. This is the context an agent reads
    _before_ writing a test. Snake_case name per roadmap §11 decision 4.

  **Existing-spec indexer** (`spec-indexer.ts`) fast-globs
  `tests/**/*.spec.ts` + `packages/**/tests/**/*.test.ts`, classifies each
  file as `user-written` vs `ate-generated`, resolves coverage targets via
  `@ate-covers` comments OR static import resolution, and attaches
  last-run status from `.mandu/ate-last-run.json` when present.

  Acceptance: integration test loads `demo/auth-starter/` and asserts the
  returned context contains the signup route, csrf + session middleware,
  recommended `createTestSession` + `createTestDb` + `testFilling`
  fixtures, `[data-route-id=api-signup]` selector, and the UI entry-point
  sibling.

### Patch Changes

- Updated dependencies [[`81b4ff7`](https://github.com/konamgil/mandu/commit/81b4ff7adfbba4daeb070fdc6ff41a2e851c53fd)]:
  - @mandujs/ate@0.20.0

## 0.22.4

### Patch Changes

- Updated dependencies [[`927544c`](https://github.com/konamgil/mandu/commit/927544c265a0eceff9143e5e5991d5365208ea85), [`8e53ca0`](https://github.com/konamgil/mandu/commit/8e53ca007cd588ce3cba0866222f5eb1982d01bd)]:
  - @mandujs/ate@0.19.2
  - @mandujs/core@0.37.0
  - @mandujs/skills@16.0.0

## 0.22.3

### Patch Changes

- Updated dependencies [[`88d597a`](https://github.com/konamgil/mandu/commit/88d597ad50d5ac219e68f458e746f4f649de2c50)]:
  - @mandujs/core@0.36.0
  - @mandujs/skills@15.0.0

## 0.22.2

### Patch Changes

- Updated dependencies [[`5c9bac1`](https://github.com/konamgil/mandu/commit/5c9bac1afd3d769ec5889ec5ac65b6d587ff9f51)]:
  - @mandujs/core@0.35.0
  - @mandujs/skills@14.0.0

## 0.22.1

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.34.0
  - @mandujs/skills@13.0.0

## 0.22.0

### Minor Changes

- Phase 18 Wave E6 + #214/#215.

  **π Guard dependency graph** — `mandu guard --graph` → `.mandu/guard/graph.html` (self-contained SVG, dark theme, click-to-drill, XSS-safe).

  **σ Test convergence** — `@mandujs/core/testing/reporter` (human/JSON/JUnit/lcov formats), `--reporter` CLI flag, per-metric coverage thresholds enforcement, unified watch-mode UX.

  **τ Plugin API 강화** — 7 new hook types (`onRouteRegistered`, `onManifestBuilt`, `definePrerenderHook`, `defineBundlerPlugin`, `defineMiddlewareChain`, `defineTestTransform`, `onBundleComplete`) + `definePlugin()` helper + 3 example plugins.

  **#214 dynamicParams route guard** — `export const dynamicParams = false` forces 404 on params outside `generateStaticParams` result (Next.js parity).

  **#215 diagnose 보강** — 5 new checks (`manifest_freshness`, `prerender_pollution`, `cloneelement_warnings`, `dev_artifacts_in_prod`, `package_export_gaps`) + new `mandu diagnose` CLI + MCP unified shape.

  Quality: 7 packages typecheck clean, +195 regression tests, zero new deps.

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.33.0
  - @mandujs/skills@12.0.0

## 0.21.1

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.32.0
  - @mandujs/skills@11.0.0

## 0.21.0

### Minor Changes

- Phase 18 Wave E3+E4 — Mandu 차별화 레이어 완성.

  **ι AI refactor MCP tools** (`@mandujs/mcp`):

  - `mandu.refactor.rewrite_generated_barrel` — `__generated__/*` → `getGenerated()` + `GeneratedRegistry` augmentation
  - `mandu.refactor.migrate_route_conventions` — 인라인 Suspense/ErrorBoundary/NotFound → per-route convention files
  - `mandu.refactor.extract_contract` — 인라인 Zod 스키마 → `contract/<group>.contract.ts`

  **κ Typed RPC** (`@mandujs/core`):

  - `defineRpc({ method: { input, output, handler } })` + `createRpcClient<typeof rpc>()` Proxy 기반 end-to-end type inference. Zod 검증. tRPC 의존 없음.

  **λ Bun.cron scheduler** (`@mandujs/core` + `@mandujs/cli`):

  - `defineCron({ name, schedule, timezone, runOn, handler })` Bun.cron 기반
  - `mandu build --target=workers` 시 `[triggers] crons = [...]` 자동 emission
  - Cron 표현식 + timezone Intl 검증

  Quality: 7 packages typecheck clean, +132 regression tests, zero new
  runtime deps.

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.31.0
  - @mandujs/skills@10.0.0

## 0.20.7

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.30.0
  - @mandujs/skills@9.0.0

## 0.20.3

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.29.0
  - @mandujs/skills@6.0.0

## 0.20.2

### Patch Changes

- Wave D — 8 GitHub issues + Phase 17 memory/observability:

  - **#193 (BREAKING)** — SPA navigation is opt-out by default. Plain
    `<a href="/about">` now triggers client-side nav with View
    Transitions. Opt-out per link: `data-no-spa`. Opt-out global:
    `mandu.config.ts` `spa: false`. Legacy `data-mandu-link` still works.

  - **#194** — `@mandujs/core` exports map exposes `./kitchen` so
    `@mandujs/mcp` can import `computeAgentStats`.

  - **#195** — `mandu dev` prints a synchronous boot banner before any
    `await`, so a hang is always observable. `MANDU_DEBUG_BOOT=1` emits
    a phase trace.

  - **#196** — `mandu dev` auto-discovers and runs `scripts/prebuild-*.
{ts,tsx,js,mjs}` before serving. In watch mode, `content/` changes
    re-execute prebuild (500ms debounced) and broadcast HMR reload.
    Opt-out: `dev.autoPrebuild: false`.

  - **#197** — `@mandujs/skills` now writes every skill as
    `.claude/skills/<name>/SKILL.md` (Claude Code spec). All three
    installer paths (dev, CLI binary mode, per-project generator)
    corrected.

  - **#198** — SSR resolves `async function` components. `export default
async function Page()` / async layouts / async generateMetadata work.
    4 callsites pre-resolve via `resolveAsyncElement()`.

  - **#199 (MVP)** — `@mandujs/core/content`: `defineCollection`,
    frontmatter parser (no new runtime deps), `slugFromPath`,
    `generateSidebar`, `generateLLMSTxt`, content-types.d.ts emitter.
    Legacy `defineCollection({ loader })` preserved.

  - **#200** — runtime registry: `getGenerated`, `getManifest`,
    `registerManifest` at `@mandujs/core/runtime`. Guard
    `INVALID_GENERATED_IMPORT` message now points at
    `mandujs.com/docs/architect/generated-access`.

  - **Phase 17** — bounded LRU (patternCache/fetchCache/perFileTimers),
    `/_mandu/heap` + `/_mandu/metrics` endpoints (dev auto-on, prod
    gated), MCP heap heartbeat, long-run smoke harness.

  Quality: 6 packages typecheck clean, 200+ new regression tests, zero
  new runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.25.0
  - @mandujs/skills@5.0.0

## 0.20.1

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.24.0
  - @mandujs/ate@0.19.1
  - @mandujs/skills@4.0.0

## 0.14.0

### Minor Changes

- ATE Production Release v0.16.0

  ## 🎉 Major Features

  ### New Package: @mandujs/ate

  - **Automation Test Engine** - Complete E2E testing automation pipeline
  - Extract → Generate → Run → Report → Heal workflow
  - 195 tests, 100% pass rate

  ### ATE Core Features

  - **Trace Parser & Auto-Healing**: Playwright trace 분석 및 자동 복구
  - **Import Dependency Graph**: TypeScript 의존성 분석 (ts-morph 기반)
  - **Domain-Aware Assertions**: 5가지 도메인 자동 감지 (ecommerce, blog, dashboard, auth, generic)
  - **Selector Fallback System**: 4단계 fallback chain (mandu-id → text → class → role → xpath)
  - **Impact Analysis**: Git diff 기반 subset 테스트 자동 선택

  ### Performance Optimizations

  - **ts-morph Lazy Loading**: Dynamic import로 초기 로드 70% 감소
  - **Tree-shaking**: sideEffects: false 설정
  - **Bundle Size**: 최적화 완료

  ### Documentation

  - 2,243 lines 완전한 문서화
  - README.md (1,034 lines)
  - architecture.md (778 lines)
  - 8개 사용 예제

  ### Testing

  - 195 tests / 503 assertions
  - 13개 테스트 파일
  - 단위/통합 테스트 완비

  ### Error Handling

  - ATEFileError 커스텀 에러 클래스
  - 모든 file I/O에 try-catch
  - Graceful degradation
  - 한국어 에러 메시지

  ## 🔧 MCP Integration

  - 6개 ATE 도구 추가 (mandu.ate.\*)
  - extract, generate, run, report, heal, impact

  ## 📦 Breaking Changes

  None - 모든 기존 API 유지

  ## 🙏 Credits

  Developed by ate-production-team:

  - heal-expert: Trace parser, Error handling
  - impact-expert: Dependency graph
  - oracle-expert: Oracle L1 assertions
  - selector-expert: Selector fallback map
  - doc-expert: Documentation, Testing
  - bundle-optimizer: Performance optimization

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.14.0
  - @mandujs/ate@0.2.0

## 0.13.0

### Minor Changes

- feat: manifest를 generated artifact로 전환 (Option D)

  - `spec/routes.manifest.json` → `.mandu/routes.manifest.json` (generated artifact)
  - `spec/spec.lock.json` → `.mandu/spec.lock.json`
  - `app/` (FS Routes)가 유일한 라우트 소스
  - legacy merge 로직 제거, auto-linking 추가
  - MCP tools FS Routes 기반으로 재작성

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.13.0

## 0.12.3

### Patch Changes

- docs: mention `.claude.json` as a valid MCP configuration location

## 0.12.2

### Patch Changes

- fix: publish 스크립트를 bun publish로 변경하여 workspace:\* 의존성 자동 변환

- Updated dependencies []:
  - @mandujs/core@0.12.2

## 0.12.1

### Patch Changes

- chore: change license from MIT to MPL-2.0 and fix workspace dependency

- Updated dependencies []:
  - @mandujs/core@0.12.1
