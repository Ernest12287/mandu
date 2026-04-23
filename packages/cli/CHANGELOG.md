# @mandujs/cli

## 0.32.0

### Minor Changes

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

- Updated dependencies [[`f92151b`](https://github.com/konamgil/mandu/commit/f92151b2ef129b1dff068024fb527b443874d50e), [`ad21b50`](https://github.com/konamgil/mandu/commit/ad21b50a5740754031a39f36d484f30ecb93013c)]:
  - @mandujs/core@0.43.0
  - @mandujs/mcp@0.31.0
  - @mandujs/edge@0.4.31

## 0.31.0

### Minor Changes

- [`b55ff48`](https://github.com/konamgil/mandu/commit/b55ff489517d48777d8367b007ffc2a7fb334003) Thanks [@konamgil](https://github.com/konamgil)! - feat(cli/deploy): render.com adapter

  Seventh deploy adapter. Generates a render.yaml Blueprint matching
  the layout in mcp/resources/skills/mandu-deployment/rules/
  deploy-platform-render.md — curl-installs Bun inside Render's node
  runtime, pipes PORT via fromService, surfaces user env vars as
  sync:false entries for dashboard config.

  Scope — web service + optional Postgres database block. Redis and
  worker services deferred. No API-key workflow yet; users push to Git
  and Render picks up the Blueprint.

  `mandu deploy --target=render` wires through the same adapter
  registry as fly/railway/vercel. 17 new tests.

## 0.30.4

### Patch Changes

- Updated dependencies [[`cb32140`](https://github.com/konamgil/mandu/commit/cb32140b58aef9cc8d78a5d4975329cc8d81b2a7)]:
  - @mandujs/ate@0.25.1
  - @mandujs/mcp@0.30.0

## 0.30.3

### Patch Changes

- Updated dependencies [[`e56697e`](https://github.com/konamgil/mandu/commit/e56697eaabef2d615f9d637f8b10d152006a0975)]:
  - @mandujs/core@0.42.0
  - @mandujs/ate@0.25.0
  - @mandujs/mcp@0.29.0
  - @mandujs/edge@0.4.30

## 0.30.2

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
  - @mandujs/mcp@0.28.1
  - @mandujs/edge@0.4.28

## 0.30.1

### Patch Changes

- Updated dependencies [[`a76eb21`](https://github.com/konamgil/mandu/commit/a76eb21625d9b1fa6bba074c8efe347662f316c6)]:
  - @mandujs/mcp@0.28.0

## 0.30.0

### Minor Changes

- [`eea2ff9`](https://github.com/konamgil/mandu/commit/eea2ff982cf210d6d5d6a7eaf06a3667de92ca3d) Thanks [@konamgil](https://github.com/konamgil)! - feat(brain): delegate OpenAI login to `@openai/codex` — real OAuth flow works today

  Earlier the OpenAI adapter shipped with placeholder OAuth endpoints
  (`https://platform.openai.com/oauth/authorize` + a `mandu-brain-cli`
  client id) that were never registered with OpenAI. Nobody could
  actually sign in.

  Fix — piggy-back on the OpenAI-official Codex CLI:

  - `mandu brain login --provider=openai` now shells out to
    `npx @openai/codex login`. OpenAI handles the browser OAuth flow with
    its real app (`app_EMoamEEZ73f0CkXaXp7hrann`) and writes the token
    into `~/.codex/auth.json`. Mandu never has its own OAuth app.
  - New `ChatGPTAuth` helper at `@mandujs/core` reads whatever auth.json
    `codex login` produced (`CHATGPT_LOCAL_HOME` / `CODEX_HOME` /
    `~/.chatgpt-local/auth.json` / `~/.codex/auth.json`, in order), auto-
    refreshes the access token against `auth.openai.com/oauth/token`
    5 minutes before JWT `exp`, and rewrites auth.json atomically with
    mode 0600.
  - `OpenAIOAuthAdapter` now calls `ChatGPTAuth` first; the legacy
    keychain path is preserved as a fallback for enterprise OpenAI
    proxies that wire their own OAuth app.
  - 401 from the Chat Completions endpoint triggers one `ChatGPTAuth
.getAuth()` re-read (which refreshes if needed); persistent 401 on
    the ChatGPT path intentionally does NOT scrub auth.json (we must
    not race the user's codex session). The keychain fallback keeps its
    scrub-on-persistent-401 behavior.

  Ported from the same pattern kakao-bot-sdk uses in
  `src/auth/chatgpt.ts` — the approach is proven in production there.

  8 new tests covering JWT parsing, expiry-driven refresh, missing-token
  error shapes, and disk persistence.

### Patch Changes

- Updated dependencies [[`eea2ff9`](https://github.com/konamgil/mandu/commit/eea2ff982cf210d6d5d6a7eaf06a3667de92ca3d)]:
  - @mandujs/core@0.41.0
  - @mandujs/edge@0.4.27
  - @mandujs/mcp@0.27.2

## 0.29.0

### Minor Changes

- [`6ded2af`](https://github.com/konamgil/mandu/commit/6ded2af0bed3eaec90aafa0e0d7b077099d07ecc) Thanks [@konamgil](https://github.com/konamgil)! - #235 brain OAuth adapters (OpenAI + Anthropic)

  Adds two new LLM adapters to `@mandujs/core/brain` that use the user's
  own OAuth credentials — Mandu stays a connector, never owns API keys or
  billing.

  - OpenAI OAuth adapter (default model `gpt-4o-mini`)
  - Anthropic OAuth adapter (default model `claude-haiku-4-5-20251001`)
  - Auto-detect resolver order: openai → anthropic → ollama → template
  - OS keychain storage (`security` on macOS / `secret-tool` on Linux /
    `0600` filesystem fallback on Windows + everywhere else). No `keytar`
    dependency.
  - `mandu brain login` / `logout` / `status` CLI subcommands
  - `ManduConfig.brain = { adapter, openai, anthropic, ollama, telemetryOptOut }`
  - Privacy: first-use consent prompt (cached per-provider / per-project
    at `~/.mandu/brain-consent.json`), per-request secret redactor (API
    keys, Bearer tokens, `.env` refs, JWTs), audit log at
    `.mandu/brain-redactions.jsonl`

  `telemetryOptOut: true` keeps everything local (resolver falls to
  ollama / template regardless of stored tokens).

  No breaking change: existing configs without a `brain` block behave as
  `adapter: 'auto'`. Existing `mandu brain setup` / `mandu brain status`
  paths remain available.

### Patch Changes

- Updated dependencies [[`6ded2af`](https://github.com/konamgil/mandu/commit/6ded2af0bed3eaec90aafa0e0d7b077099d07ecc), [`6ded2af`](https://github.com/konamgil/mandu/commit/6ded2af0bed3eaec90aafa0e0d7b077099d07ecc)]:
  - @mandujs/core@0.40.0
  - @mandujs/skills@0.18.0
  - @mandujs/edge@0.4.25
  - @mandujs/mcp@0.27.1

## 0.28.11

### Patch Changes

- [`49353c7`](https://github.com/konamgil/mandu/commit/49353c70415c31fec1501bb39c16652dce47f80a) Thanks [@konamgil](https://github.com/konamgil)! - fix(core,cli): #232 follow-up — eager page-component registration

  The initial #232 fix (dev server bypasses the prerender cache) unmasked
  a latent lazy-registration race: `registerPageHandler` /
  `registerPageLoader` only install thunks at HMR reload time; the actual
  page component is registered inside `routeComponents` when the first
  request triggers `loadPageData`. If the HMR-broadcast reload hits any
  code path that reaches `createDefaultAppFactory` before the lazy
  import completes, the fallback "404 - Route Not Found" renders even
  for perfectly valid routes (e.g. `[lang]/page.tsx` with a slot module).

  Previously, the prerender cache short-circuit masked this path — users
  never saw the 404 because the prerendered HTML was served instead.

  Fix: a new `prewarmPageRoutes(registry?)` public helper iterates every
  registered pageHandler / pageLoader and drives it through the same
  import + `registerRouteComponent` that the first request would. The
  CLI dev command invokes it at every registration site:

  - initial boot (`mandu dev`)
  - SSR change rebuild
  - API change re-register
  - route manifest watcher
  - full `restartDevServer`

  Prewarm failures log a per-route warning but do not block the reload —
  a single broken file stays broken while healthy routes keep serving.
  Production `mandu start` is unaffected (no HMR, no reload race).

- Updated dependencies [[`49353c7`](https://github.com/konamgil/mandu/commit/49353c70415c31fec1501bb39c16652dce47f80a)]:
  - @mandujs/core@0.39.2
  - @mandujs/edge@0.4.23

## 0.28.10

### Patch Changes

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

- Updated dependencies [[`e77b035`](https://github.com/konamgil/mandu/commit/e77b035dd28cc256a596fe5221f781c5609645e9)]:
  - @mandujs/core@0.39.0
  - @mandujs/ate@0.24.0
  - @mandujs/mcp@0.27.0
  - @mandujs/edge@0.4.21
  - @mandujs/skills@17.0.0

## 0.28.9

### Patch Changes

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

- Updated dependencies [[`0aa24be`](https://github.com/konamgil/mandu/commit/0aa24be35be5db3774881da319fa04bf6dc72bcd)]:
  - @mandujs/ate@0.22.0
  - @mandujs/mcp@0.25.0

## 0.28.8

### Patch Changes

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

- Updated dependencies [[`2013674`](https://github.com/konamgil/mandu/commit/20136745bcc3d5758d7221608e15e24cafb31239), [`2013674`](https://github.com/konamgil/mandu/commit/20136745bcc3d5758d7221608e15e24cafb31239)]:
  - @mandujs/ate@0.21.0
  - @mandujs/mcp@0.24.0

## 0.28.7

### Patch Changes

- Updated dependencies [[`81b4ff7`](https://github.com/konamgil/mandu/commit/81b4ff7adfbba4daeb070fdc6ff41a2e851c53fd)]:
  - @mandujs/ate@0.20.0
  - @mandujs/mcp@0.23.0

## 0.28.6

### Patch Changes

- [`8e53ca0`](https://github.com/konamgil/mandu/commit/8e53ca007cd588ce3cba0866222f5eb1982d01bd) Thanks [@konamgil](https://github.com/konamgil)! - fix(core,cli): #223 dual-stack default + #225 truthful startup banner

  **#223 — Default `server.hostname` is now `"::"` (IPv6 wildcard,
  dual-stack) instead of `"0.0.0.0"` (IPv4-only).** Bun leaves
  `IPV6_V6ONLY` off, so a single socket accepts both IPv4 (as
  IPv4-mapped IPv6) and IPv6 clients — effectively covering what users
  expected `"0.0.0.0"` to do. This silently fixes the Windows trap where
  Node 17+ `fetch("http://localhost:PORT")` resolves `localhost` to
  `::1` first and hit `ECONNREFUSED ::1:PORT` against an IPv4-only
  bind. `curl` and browsers silently fell back to IPv4, hiding the bug
  until a Node client (Playwright test runner, ATE-generated specs)
  tried to reach the server.

  Explicit `"0.0.0.0"` is still honored — users who need IPv4-only
  binds for container/firewall reasons keep that option. On Windows
  only, Mandu emits a one-line warning so the IPv6-localhost trap is
  discoverable:

  ```
  ⚠️  hostname="0.0.0.0" binds IPv4 only; Node fetch('localhost:PORT')
     may fail on Windows (prefers ::1). Consider hostname="::" for
     dual-stack.
  ```

  **#225 — The startup banner no longer lies about reachability.** The
  old code unconditionally printed

  ```
  🥟 Mandu server listening at http://localhost:3333
     (also reachable at http://127.0.0.1:3333, http://[::1]:3333)
  ```

  regardless of the actual bind address. When bound to `"0.0.0.0"` the
  `[::1]` URL never answered. The new `reachableHosts(hostname)` helper
  (exported from `@mandujs/core`) derives the URL list deterministically
  from the bind address:

  - `"0.0.0.0"` → `["127.0.0.1"]` only.
  - `"::"` / `"::0"` / `"[::]"` / `"0:0:0:0:0:0:0:0"` →
    `["127.0.0.1", "[::1]"]`.
  - `"::1"` / `"127.0.0.1"` / a specific IP → just that address.
  - DNS name → just that name.

  `formatServerAddresses()` consumes `reachableHosts()` so both the
  `startServer` banner and the `mandu start` / `mandu dev` CLI banners
  only promise addresses that actually answer.

  No new dependencies. Docker setups that pin `hostname: "0.0.0.0"`
  (explicit) are not silently upgraded.

- Updated dependencies [[`927544c`](https://github.com/konamgil/mandu/commit/927544c265a0eceff9143e5e5991d5365208ea85), [`8e53ca0`](https://github.com/konamgil/mandu/commit/8e53ca007cd588ce3cba0866222f5eb1982d01bd)]:
  - @mandujs/ate@0.19.2
  - @mandujs/core@0.37.0
  - @mandujs/edge@0.4.20
  - @mandujs/mcp@0.22.4
  - @mandujs/skills@16.0.0

## 0.28.5

### Patch Changes

- Updated dependencies [[`88d597a`](https://github.com/konamgil/mandu/commit/88d597ad50d5ac219e68f458e746f4f649de2c50)]:
  - @mandujs/core@0.36.0
  - @mandujs/edge@0.4.19
  - @mandujs/mcp@0.22.3
  - @mandujs/skills@15.0.0

## 0.28.4

### Patch Changes

- [`5c9bac1`](https://github.com/konamgil/mandu/commit/5c9bac1afd3d769ec5889ec5ac65b6d587ff9f51) Thanks [@konamgil](https://github.com/konamgil)! - feat(core,cli): production-grade OpenAPI endpoint (opt-in, ETag'd)

  - `mandu build` now emits `.mandu/openapi.json` + `.mandu/openapi.yaml`
    whenever any route carries a `contractModule`.
  - New `ManduConfig.openapi: { enabled?, path? }` block exposes the spec
    at `/__mandu/openapi.json` / `.yaml` (default-off). Opt-in via config
    or `MANDU_OPENAPI_ENABLED=1`.
  - Response carries `Cache-Control: public, max-age=0, must-revalidate`
    - a SHA-256 ETag; `If-None-Match` short-circuits with 304.
  - Replaced the naive regex YAML converter with a conservative YAML 1.2
    subset emitter (stable round-trip through Swagger UI / yq / codegen).
  - Kitchen's dev endpoint (`/__kitchen/api/contracts/openapi*`) and the
    new prod endpoint share the same generator module.
  - Docs: `docs/runtime/openapi.md`.

- Updated dependencies [[`5c9bac1`](https://github.com/konamgil/mandu/commit/5c9bac1afd3d769ec5889ec5ac65b6d587ff9f51)]:
  - @mandujs/core@0.35.0
  - @mandujs/edge@0.4.17
  - @mandujs/mcp@0.22.2
  - @mandujs/skills@14.0.0

## 0.28.3

### Patch Changes

- [`fce3797`](https://github.com/konamgil/mandu/commit/fce37970baf884a7f864642333b17070777fa57c) Thanks [@konamgil](https://github.com/konamgil)! - feat(cli): ship `mandu info` — agent-friendly env + config + health dump

  Replace the 87-line stub with a full 8-section snapshot command covering mandu
  versions, runtime, project, config summary, routes, middleware, plugins, and
  diagnose. Supports `--json` for issue reports and `--include <sections>` for
  scoped output. Missing config is a non-crash path — the command is an inspector,
  not a gate.

## 0.28.2

### Patch Changes

- Phase 18 Wave E7 — 본연 주변 primitives 완결.

  **φ Bundle size budget** — `ManduConfig.build.budget` per-island + total raw/gz caps, mode `'error'|'warning'`, `mandu build --no-budget` bypass, analyzer HTML에 budget bar inline.

  **χ Accessibility audit** (`@mandujs/core/a11y`) — `mandu build --audit` axe-core 실행, optional peerDep (axe-core/jsdom/happy-dom 없으면 graceful skip), 25+ rule fix-hints, `--audit-fail-on=<impact>` 게이트.

  **ψ Perf marks dev API** — `time()` / `timeAsync()` / `createPerf()` zero-overhead disabled path + OTel span 자동 생성 + `/_mandu/heap` histogram (p50/p95/p99, LRU 1000).

  +61 regression tests, 7 packages typecheck clean, zero new runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.34.0
  - @mandujs/edge@0.4.14
  - @mandujs/mcp@0.22.1
  - @mandujs/skills@13.0.0

## 0.28.1

### Patch Changes

- fix: #213/#216 prerender + #217 silent + #218 Cache-Control + #219
  asset crawl + #220 SPA-nav swap.

  - **#213** crawler strips code regions (pre/code/fenced/inline/comment)
    - DEFAULT_CRAWL_DENYLIST (`/path`, `/example`, `/your-*`)
  - **#216** PrerenderError distinguishes missing export vs user throw;
    `--prerender-skip-errors` flag
  - **#217** `ServerOptions.silent` suppresses transient prerender banner
    during `mandu build`
  - **#218** Hash-aware Cache-Control + strong ETag for
    `/.mandu/client/*` (stable URL → `must-revalidate`, hashed URL →
    `immutable`)
  - **#219** `DEFAULT_ASSET_EXTENSIONS` (25 img/font/doc/media/text)
    filters `/hero.webp`/`/doc.pdf` from crawler + `build.crawl.
assetExtensions` override
  - **#220** SPA-nav body swap: logs every failure path with
    `[mandu-spa-nav]` prefix, selector cascade `main → #root → body`,
    script re-execution via `document.createElement`,
    `__MANDU_SPA_NAV__` CustomEvent, hard-nav fallback on all failures

  Quality: 7 packages typecheck clean, +100 regression tests, zero new
  runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.33.1
  - @mandujs/edge@0.4.13

## 0.28.0

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
  - @mandujs/mcp@0.22.0
  - @mandujs/edge@0.4.12
  - @mandujs/skills@12.0.0

## 0.27.8

### Patch Changes

- Phase 18 Wave E5 + #211/#212 hotfixes.

  **μ i18n framework-level** (`@mandujs/core/i18n`) — `defineI18n({ locales, defaultLocale, strategy })` 4 strategies (path-prefix/domain/header/cookie), 자동 route synthesis, `ctx.locale`/`ctx.t` 타입드 헬퍼, Vary/Content-Language 헤더, 307 redirect.

  **ν defineGuardRule API** (`@mandujs/core/guard/define-rule` + `rule-presets`) — consumer custom guard rule + 3 presets (`forbidImport`, `requireNamedExport`, `requirePrefixForExports`).

  **ξ Streaming SSR + React.use()** — `resolveAsyncElement` streaming 경로 serialize 버그 fix: TTFB 250ms → 10ms (25×). `loading.tsx` Suspense streams 검증. React 19 `use(promise)` 지원.

  **#212** — `cloneElement` array 전달로 인한 spurious "missing key" 경고 fix (spread 로 variadic).

  **#211** — `mandu start` stale/dev/empty manifest silent accept fix.

  Quality: 7 packages typecheck clean, +208 new regression tests, zero
  new runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.32.0
  - @mandujs/edge@0.4.11
  - @mandujs/mcp@0.21.1
  - @mandujs/skills@11.0.0

## 0.27.7

### Patch Changes

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

- Updated dependencies []:
  - @mandujs/core@0.31.0
  - @mandujs/mcp@0.21.0
  - @mandujs/edge@0.4.10
  - @mandujs/skills@10.0.0

## 0.27.6

### Patch Changes

- Phase 18 Wave E2 — runtime depth (ISR + bundle analyzer + OTel tracing).

  **ζ ISR + cache tags** — filling loader가 `{ _cache: { tags, maxAge, staleWhileRevalidate } }` 반환 or `ctx.cache.tag('x').maxAge(10).swr(3600)` fluent API. `revalidate(tag)` tag-based invalidation. `Cache-Control` + `X-Mandu-Cache` 헤더 자동. Next.js ISR parity.

  **η Bundle analyzer** — `mandu build --analyze` → `.mandu/analyze/report.html` (self-contained SVG treemap, dark theme, click-to-drill) + `report.json`. Per-island raw+gz, shared chunk dedupe detection, top-20 heaviest modules. 외부 dep 없음.

  **θ Request tracing** — W3C Trace Context + AsyncLocalStorage propagation, Console + OTLP HTTP exporters. `ctx.span` + `ctx.startSpan(name, fn)` filling integration. Hand-rolled OTLP JSON encoding (opentelemetry-js dep 없음). Honeycomb / Jaeger / Tempo 호환.

  Quality: 7 packages typecheck clean, +84 regression tests, zero new
  runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.30.0
  - @mandujs/edge@0.4.9
  - @mandujs/mcp@0.20.7
  - @mandujs/skills@9.0.0

## 0.27.5

### Patch Changes

- Phase 18 Wave E1 — convention parity with Next.js / Astro / SvelteKit
  (5 orthogonal capabilities, 210+ regression tests).

  **α Dev Error Overlay** — 풀스크린 dev 에러 UI (`@mandujs/core/dev-error-overlay`). SSR + client 에러 양쪽, 4.4 KB gz client IIFE, 500-response에도 payload 임베드. Config `dev.errorOverlay` (default `true`, prod 3중 gate).

  **β Route conventions** — `app/<route>/{loading,error,not-found}.tsx` per-route + `(group)/` route groups + `[[...slug]]` optional catch-all. 런타임이 page를 `Suspense(loading)` + `ErrorBoundary(error)` 로 자동 감싸고, 404는 nearest-ancestor `not-found.tsx` 우선.

  **γ generateStaticParams** — Next.js-style build-time SSG. `.mandu/prerendered/` + `_manifest.json`, path-traversal-safe, 런타임 첫 dispatch check에서 `Cache-Control: immutable`로 serve. Nested dynamic / catch-all / optional catch-all 전부 지원.

  **δ Hydration strategy per-island** — `data-hydrate="load|idle|visible|interaction|media(<query>)"` 선언 spec. 1.07 KB gz runtime, public disposer contract, Astro parity + `interaction` 은 Mandu 고유.

  **ε Middleware composition API** — `defineMiddleware({ name, match?, handler })` + `compose(...)`. Onion model, short-circuit, error propagation, `ManduConfig.middleware[]` config. 기존 csrf/session/secure/rate-limit bridge adapter로 backward compat.

  Quality: 7 packages typecheck clean, 3211 core pass / 0 fail, 210+ new
  tests, zero new runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.29.0
  - @mandujs/edge@0.4.1
  - @mandujs/skills@6.0.0
  - @mandujs/mcp@0.20.3

## 0.27.4

### Patch Changes

- feat(core,cli): hard-fail `__generated__/` imports at bundler level.

  `mandu dev` / `mandu build` / `mandu start` 는 이제 bundler plugin
  레이어에서 직접 `__generated__/` import를 감지하면 번들링 자체를
  실패시킵니다. Guard rule만으로 부족했던 agent bypass 패턴의 원천 차단.

  에러 메시지는 importer 파일 경로 + `getGenerated()` 사용 예시 +
  docs URL을 포함합니다. `@mandujs/core/runtime` 내부 `__generated__`
  접근은 기본 allowlist로 제외됩니다.

  - `packages/core/src/bundler/plugins/block-generated-imports.ts` 신규
  - `defaultBundlerPlugins(config)` 헬퍼 — 단일 설치 포인트
  - `safeBuild` 6개 callsite + CLI SSR bundler 경로 자동 장착
  - `ManduConfig.guard.blockGeneratedImport` (Zod, default `true`) opt-out
  - `MANDU_DISABLE_BUNDLER_PLUGINS=1` 비상 탈출구
  - `mandu init` 3개 템플릿 `tsconfig.json` paths 봉쇄 (IDE defense)
  - 마이그레이션 가이드 `docs/migration/0.28-generated-block.md`
  - `docs/architect/generated-access.md` Enforcement 섹션 추가

  18 regression tests (15 unit + 3 integration). No new runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.28.0
  - @mandujs/edge@0.4.6
  - @mandujs/mcp@0.20.5
  - @mandujs/skills@8.0.0

## 0.27.3

### Patch Changes

- fix: #207 view-transition injection hardening + #208 inline SPA-nav
  helper for `hydration: "none"` projects.

  - **#207**: No code defect; `@view-transition` CSS was already injected
    across all SSR paths. Locked it down with 12-case regression suite
    covering streaming SSR / prerender / 404 / error / opt-out.
  - **#208**: Genuine defect. `ssr.spa: true` was documented default but
    intercept lived in client bundle that `hydration: "none"` projects
    never ship. New `client/spa-nav-helper.ts` inline IIFE (~2.7 KB)
    injected into `<head>` alongside the prefetch helper. Full 10-case
    exclusion parity with `handleLinkClick`. pushState + fetch +
    View-Transitions DOM-swap. Early-exits when full router present so
    hydrated pages unaffected.

  Wired through `ServerOptions.spa` to all 5 renderSSR/
  renderStreamingResponse call-sites. CLI dev + start pass `config.spa`.

  +66 regression tests (12 #207 + 54 #208). No new runtime deps.

- Updated dependencies []:
  - @mandujs/core@0.27.0
  - @mandujs/edge@0.4.5
  - @mandujs/mcp@0.20.4
  - @mandujs/skills@7.0.0

## 0.27.2

### Patch Changes

- content + routes follow-ups (Closes #204, #205, #206):

  - **#204** — `Collection.all()/get()/getCompiled()` guaranteed
    watcher-free. Script chains exit cleanly. Watching via
    `collection.watch(cb)` opt-in. `dispose()` + `Symbol.asyncDispose`.
  - **#205** — `generateSidebar` reads `_meta.json` (title/icon/order/
    pages[]). New `generateCategoryTree`. `generateLLMSTxt` baseUrl +
    groupByCategory. `getCompiled` accepts `CompileOptions` (remark/
    rehype plugins + silent).
  - **#206** — Metadata Routes auto-discovery: `app/sitemap.ts`,
    `app/robots.ts`, `app/llms.txt.ts`, `app/manifest.ts` →
    `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/manifest.webmanifest`.
    New `@mandujs/core/routes` export with typed contracts + dispatcher.
    Default `Cache-Control: public, max-age=3600`.

  No new runtime deps. Existing `renderSitemap`/`renderRobots` helpers
  and `public/*.xml` workflow remain untouched (auto-discovery is
  additive). `app/` > `public/` precedence with warning.

  +74 regression tests. 7 packages typecheck clean.

- Updated dependencies []:
  - @mandujs/core@0.26.0
  - @mandujs/edge@0.4.4
  - @mandujs/mcp@0.20.3
  - @mandujs/skills@6.0.0

## 0.27.1

### Patch Changes

- fix: resolve #203 — configurable prebuild timeout + preserve inner errors.

  - `mandu.config.ts` `dev.prebuildTimeoutMs` (default 120_000 ms) +
    `MANDU_PREBUILD_TIMEOUT_MS` env override.
  - New `PrebuildTimeoutError` (subclass of `PrebuildError`) names the
    failing script + limit + both override paths.
  - Inner error message + stack preserved via `.cause`. No more opaque
    "non-Error thrown" surface.
  - stdout/stderr tail (last 10 lines each) appended to
    `PrebuildError.message` on non-zero exit.
  - CLI `mandu dev` prints `err.message` + `cause.stack` on abort.

- Updated dependencies []:
  - @mandujs/core@0.25.3
  - @mandujs/edge@0.4.3

## 0.27.0

### Minor Changes

- Phase 15.2 — Edge adapter expansion:

  - **`@mandujs/edge/deno`** — `createDenoHandler()` + `deno.json`
    generator for Deno Deploy.
  - **`@mandujs/edge/vercel`** — `createVercelEdgeHandler()` +
    `vercel.json` generator with `runtime: "edge"` and catch-all
    rewrite to `/api/_mandu`.
  - **`@mandujs/edge/netlify`** — `createNetlifyEdgeHandler()` +
    `netlify.toml` generator with `edge_functions` block.
  - **CLI** — `mandu build --target=<deno|vercel-edge|netlify-edge>`
    produces platform entry + config artifact.

  All three adapters inherit Phase 15.1 R0 contract: per-request
  AsyncLocalStorage isolation, production error-body scrubbing,
  throwing Bun-only API shim with platform-specific signals.

  77 new tests (fetch + config + emitter smoke). Edge suite total
  107/0 pass. Zero new runtime deps; Phase 15.1 Workers bundle
  unchanged (1609.3 KB). Hono territory non-infringement preserved —
  adapters are polyfill + config only, never routing.

### Patch Changes

- Updated dependencies []:
  - @mandujs/edge@0.4.0

## 0.26.0

### Minor Changes

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

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.25.0
  - @mandujs/mcp@0.20.2
  - @mandujs/skills@5.0.0
  - @mandujs/edge@0.3.1

## 0.25.0

### Minor Changes

- Wave C — GitHub issue closures + R3 Low hardening + flake fixes:

  - **Issue #190** — `mandu dev/start` default hostname `0.0.0.0` (IPv4
    dual-stack). Fixes Windows `localhost` IPv4-resolve dead-page. Log
    now prints `http://localhost:PORT (also reachable at 127.0.0.1, [::1])`.

  - **Issue #191** — `_devtools.js` injected only when
    `bundleManifest.hasIslands === true`. Opt-in/out via
    `ManduConfig.dev.devtools`. URL gets `?v=<buildTime>` cache-bust +
    dev static `Cache-Control: no-cache, no-store, must-revalidate` so
    stale-bundle after HMR is impossible.

  - **Issue #192** — Zero-config smooth navigation: `@view-transition`
    CSS + ~500B hover prefetch IIFE auto-injected. Opt-out via
    `ManduConfig.transitions`/`prefetch` (default `true`) or per-link
    `data-no-prefetch`. Follow-up #193 tracks opt-in→opt-out SPA nav
    reversal (breaking change, deferred).

  - **Issue #189** — Transitive ESM cache: reverse-import-graph
    invalidation. Change a deep file → HMR now invalidates every
    transitive importer (barrel + static-map, deep re-export chain,
    singleton). Depth-capped BFS + HMR log shows invalidated count.

  - **R3 Low hardening** — AI chat `/save|/load|/system` containment
    under `./.mandu/ai-chat/`; skills generator `--out-dir` project-root
    guard; Workers `ctx` AsyncLocalStorage; Edge 500 body scrub in prod;
    `@mandujs/skills/loop-closure` subpath exports.

  - **DX** — Per-subcommand `--help` routing (8 commands); changeset
    CHANGELOG auto-update wired.

  - **Flake fixes** — dbPlan/dbApply path resolution; precommitCheck
    ts-morph pre-warm + 15s Windows ceiling; safe-build handoff-race.

  Quality: 6 packages typecheck clean, 97+ new tests, no new runtime
  deps, no production-code regressions.

### Patch Changes

- Updated dependencies []:
  - @mandujs/core@0.24.0
  - @mandujs/ate@0.19.1
  - @mandujs/skills@4.0.0
  - @mandujs/edge@0.3.0
  - @mandujs/mcp@0.20.1

## 0.16.0

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

## 0.15.4

### Patch Changes

- Centralize lockfile guidance text for better maintainability and testability

## 0.15.3

### Patch Changes

- SSE reconnect improvements and critical bug fixes

  ## @mandujs/core

  - **Feature**: SSE reconnect with exponential backoff and jitter
  - **Feature**: Connection state tracking (connecting, connected, reconnecting, failed, closed)
  - **Fix**: Critical race condition in SSE snapshot/fetchChatHistory

  ## @mandujs/cli

  - **Template**: Add SSE reconnect logic to realtime-chat template
  - **Template**: Fix race condition in chat initialization
  - **Template**: Improve type clarity with ReconnectOptions alias
  - **Docs**: Add demo-first validation loop guide
  - **Docs**: Update CLI command examples

- Updated dependencies []:
  - @mandujs/core@0.13.2

## 0.15.2

### Patch Changes

- Security and stability improvements

  ## @mandujs/core

  - **Security**: Fix rate limiting DoS vulnerability - prevent single user from blocking all users
  - **Fix**: Prevent SSE event ordering race condition in subscribeWithSnapshot
  - **Test**: Add comprehensive SSE stream integration tests

  ## @mandujs/cli

  - **Refactor**: Deduplicate lockfile validation flow in dev/start commands
  - **Fix**: Remove magic numbers in backup suffix retry logic
  - **Template**: Add SSE reconnect strategy with exponential backoff
  - **Template**: Add ARIA labels for accessibility (WCAG 2.1 AA)
  - **Template**: Improve error feedback in realtime-chat and ai-chat
  - **Template**: Optimize Date object creation in message rendering

- Updated dependencies []:
  - @mandujs/core@0.13.1

## 0.15.1

### Patch Changes

- fix: resolve workspace:\* to correct core version (0.12.2 → 0.13.0)

## 0.15.0

### Minor Changes

- feat: auto-resolve template dependency versions at init time

  Template package.json now uses dynamic placeholders ({{CORE_VERSION}}, {{CLI_VERSION}}) instead of hardcoded versions. The actual installed versions are injected when running `mandu init`.

## 0.14.1

### Patch Changes

- fix: update template dependency versions to latest (core ^0.13.0, cli ^0.14.0) and remove legacy spec/ directory

## 0.14.0

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

## 0.13.2

### Patch Changes

- fix: create `.claude.json` alongside `.mcp.json` and use relative `cwd` for MCP setup

## 0.13.1

### Patch Changes

- fix: add process.exit(0) after successful command execution to prevent CLI from hanging

## 0.13.0

### Minor Changes

- 터미널 종료 관련 업데이트

### Patch Changes

- fix: add process.exit(0) after successful command execution to prevent CLI from hanging

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
