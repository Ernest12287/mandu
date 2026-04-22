# @mandujs/core

## 0.40.1

### Patch Changes

- [`ad15ebf`](https://github.com/konamgil/mandu/commit/ad15ebf17b88c63d4b4b57addb7ca5a847b37b5e) Thanks [@konamgil](https://github.com/konamgil)! - fix(brain/openai): default model gpt-4o-mini → gpt-5.4

  The original OpenAI adapter shipped with `gpt-4o-mini` as a
  cost/quality compromise, but the whole point of moving brain off the
  local `ministral-3:3b` adapter was to get quality-tier suggestions.
  Current-generation flagship (`gpt-5.4`) is the correct default;
  `ManduConfig.brain.openai.model` still lets users drop to a cheaper
  tier for low-stakes automated runs.

## 0.40.0

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

## 0.39.3

### Patch Changes

- [`8419ae1`](https://github.com/konamgil/mandu/commit/8419ae15a83180301383f995e36f42ed328de6ee) Thanks [@konamgil](https://github.com/konamgil)! - fix(core/spa-nav): #233 cross-layout transitions fall back to hardNav

  SPA navigation's `<main>.innerHTML` swap left the source layout chrome
  (e.g. docs `<aside>` sidebar) intact when moving between pages that
  use different layout trees — home ↔ docs, home ↔ dashboard, etc. —
  producing a visually broken page until the user pressed F5.

  Fix — the SSR shell now stamps `data-mandu-layout="<hash>"` on
  `<div id="root">`, derived from the active `layoutChain`. The SPA
  helper compares the current DOM's key against the parsed destination
  key inside `doSwap`; mismatched keys abort the soft swap and run a
  real `location.href = url` hard navigation.

  Same-layout transitions (e.g. `/blog/a` → `/blog/b`) keep the cheap
  swap. Pages without a layout chain omit the attribute entirely, which
  the helper treats as a wildcard match (no regression).

  Stamped on both the non-streaming path (`ssr.ts::renderToHTML`) and
  the streaming shell (`streaming-ssr.ts::generateHTMLShell`) so the
  heuristic works regardless of render mode.

  3 new regression guard tests in `spa-nav-body-swap.test.ts` ensure
  the `data-mandu-layout` attribute, the "cross-layout transition"
  fallback reason string, and the key-compare block all stay in the
  minified helper body.

## 0.39.2

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

## 0.39.1

### Patch Changes

- [`b13bfee`](https://github.com/konamgil/mandu/commit/b13bfeee9a2ce682cd71e99e5db89f701dfe557f) Thanks [@konamgil](https://github.com/konamgil)! - fix(core/runtime): #232 dev server bypasses prerendered HTML cache

  `mandu dev` now skips the `.mandu/prerendered/` short-circuit in
  `runtime/server.ts` entirely. Previously, a project that had run
  `mandu build` left prerendered HTML on disk; the dev server kept
  serving that stale HTML (`X-Mandu-Cache: PRERENDERED`) even after
  the user edited source files and HMR issued a "full reload" signal.
  The browser would reload, hit the cached path, and see the old page.

  In dev, freshness beats caching — SSR runs on every request. The
  prerender fast path still fires in production (`mandu start` uses
  `isDev: false`), so prod behavior is unchanged.

  Test coverage:

  - New "Issue #232 — dev mode bypasses prerendered cache" describe block.
  - Regression guard: production still serves PRERENDERED + production
    Cache-Control policy intact (all existing #221 tests pass).

## 0.39.0

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

## 0.37.0

### Minor Changes

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

## 0.36.0

### Minor Changes

- [`88d597a`](https://github.com/konamgil/mandu/commit/88d597ad50d5ac219e68f458e746f4f649de2c50) Thanks [@konamgil](https://github.com/konamgil)! - feat(openapi): hoist shared schemas into `components.schemas` with `$ref`

  The OpenAPI generator now performs a post-processing pass that detects
  structurally-identical object schemas appearing in two or more
  requestBody/response sites and hoists them into `components.schemas`,
  replacing inline usage with a `$ref` pointer. Result: smaller specs,
  deduplicated codegen output.

  Behavior:

  - Only `type: "object"` schemas with at least one property are hoisted;
    primitives, enums, and unions of primitives stay inline.
  - Parameter schemas (path/query/header) are never hoisted.
  - Names are derived from `contract.name` (falling back to the route id)
    with method/status qualification. Structurally-different schemas that
    would collide on name get deterministic `_v2` / `_v3` suffixes.
  - Hint-less schemas fall back to `Schema_<first-8-hex-of-hash>`.

  New generator options (both optional, on by default):

  - `hoistSchemas: boolean` (default `true`) — set to `false` to restore
    the previous fully-inline output.
  - `hoistThreshold: number` (default `2`, clamps to a minimum of `2`) —
    minimum occurrence count required to hoist.

  A new `hoistSharedSchemas(doc, options?)` helper is exported for
  callers who want to run the pass against a hand-built document.

  Note: projects with shared schemas will see a new `components.schemas`
  section in their spec, which changes the SHA-256 ETag served by the
  runtime OpenAPI endpoint. This is intentional.

## 0.35.1

### Patch Changes

- [`5e68c57`](https://github.com/konamgil/mandu/commit/5e68c57565b5bfb611d781e445025e05e8288d2e) Thanks [@konamgil](https://github.com/konamgil)! - fix(core/openapi): Zod optional no longer marked nullable

  `z.string().optional()` was emitting `nullable: true` in the OpenAPI
  spec, which conflated "may be absent" with "may literally be null" and
  broke Postman / codegen / Swagger UI imports of Mandu-generated specs.

  Optionality is now correctly expressed via the parent object's
  `required[]` array (or `parameter.required: false`), and `nullable` is
  reserved for `.nullable()` chains. `.nullable().optional()` still emits
  `nullable: true` on the inner schema as expected.

## 0.35.0

### Minor Changes

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

## 0.34.2

### Patch Changes

- fix(core): #222 — preserve hash anchor target after SPA body swap.
  `window.scrollTo(0, 0)` unconditional call was clobbering hash anchors
  (`<a href="/docs#section">` 가 `#section` 대신 top으로 스크롤). 이제
  `extractHash(url)` + `document.getElementById` + `[name=]` fallback +
  `CSS.escape` 기반 `scrollIntoView`. Fragment-only 같은 페이지 링크는
  fetch 없이 pushState + scroll 만. 9 regression tests, 2466 B gz
  (budget 3072).

## 0.34.1

### Patch Changes

- fix(core): resolve #221 — prerendered HTML Cache-Control + ETag
  revalidation. 같은 패턴 재발 (#218 `/.mandu/client/*` fix 이후 prerender
  HTML 경로는 그대로 `immutable`). `tryServePrerendered()` 가 #218 helper
  (`computeStaticCacheControl` / `computeStrongEtag` / `matchesEtag`) 재사용,
  기본 policy `public, max-age=0, must-revalidate` + strong ETag +
  `If-None-Match` 304. 사용자 `PrerenderSettings.cacheControl` override
  우선. 13 regression tests.

## 0.34.0

### Minor Changes

- Phase 18 Wave E7 — 본연 주변 primitives 완결.

  **φ Bundle size budget** — `ManduConfig.build.budget` per-island + total raw/gz caps, mode `'error'|'warning'`, `mandu build --no-budget` bypass, analyzer HTML에 budget bar inline.

  **χ Accessibility audit** (`@mandujs/core/a11y`) — `mandu build --audit` axe-core 실행, optional peerDep (axe-core/jsdom/happy-dom 없으면 graceful skip), 25+ rule fix-hints, `--audit-fail-on=<impact>` 게이트.

  **ψ Perf marks dev API** — `time()` / `timeAsync()` / `createPerf()` zero-overhead disabled path + OTel span 자동 생성 + `/_mandu/heap` histogram (p50/p95/p99, LRU 1000).

  +61 regression tests, 7 packages typecheck clean, zero new runtime deps.

## 0.33.1

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

## 0.33.0

### Minor Changes

- Phase 18 Wave E6 + #214/#215.

  **π Guard dependency graph** — `mandu guard --graph` → `.mandu/guard/graph.html` (self-contained SVG, dark theme, click-to-drill, XSS-safe).

  **σ Test convergence** — `@mandujs/core/testing/reporter` (human/JSON/JUnit/lcov formats), `--reporter` CLI flag, per-metric coverage thresholds enforcement, unified watch-mode UX.

  **τ Plugin API 강화** — 7 new hook types (`onRouteRegistered`, `onManifestBuilt`, `definePrerenderHook`, `defineBundlerPlugin`, `defineMiddlewareChain`, `defineTestTransform`, `onBundleComplete`) + `definePlugin()` helper + 3 example plugins.

  **#214 dynamicParams route guard** — `export const dynamicParams = false` forces 404 on params outside `generateStaticParams` result (Next.js parity).

  **#215 diagnose 보강** — 5 new checks (`manifest_freshness`, `prerender_pollution`, `cloneelement_warnings`, `dev_artifacts_in_prod`, `package_export_gaps`) + new `mandu diagnose` CLI + MCP unified shape.

  Quality: 7 packages typecheck clean, +195 regression tests, zero new deps.

## 0.32.0

### Minor Changes

- Phase 18 Wave E5 + #211/#212 hotfixes.

  **μ i18n framework-level** (`@mandujs/core/i18n`) — `defineI18n({ locales, defaultLocale, strategy })` 4 strategies (path-prefix/domain/header/cookie), 자동 route synthesis, `ctx.locale`/`ctx.t` 타입드 헬퍼, Vary/Content-Language 헤더, 307 redirect.

  **ν defineGuardRule API** (`@mandujs/core/guard/define-rule` + `rule-presets`) — consumer custom guard rule + 3 presets (`forbidImport`, `requireNamedExport`, `requirePrefixForExports`).

  **ξ Streaming SSR + React.use()** — `resolveAsyncElement` streaming 경로 serialize 버그 fix: TTFB 250ms → 10ms (25×). `loading.tsx` Suspense streams 검증. React 19 `use(promise)` 지원.

  **#212** — `cloneElement` array 전달로 인한 spurious "missing key" 경고 fix (spread 로 variadic).

  **#211** — `mandu start` stale/dev/empty manifest silent accept fix.

  Quality: 7 packages typecheck clean, +208 new regression tests, zero
  new runtime deps.

## 0.31.0

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

## 0.30.0

### Minor Changes

- Phase 18 Wave E2 — runtime depth (ISR + bundle analyzer + OTel tracing).

  **ζ ISR + cache tags** — filling loader가 `{ _cache: { tags, maxAge, staleWhileRevalidate } }` 반환 or `ctx.cache.tag('x').maxAge(10).swr(3600)` fluent API. `revalidate(tag)` tag-based invalidation. `Cache-Control` + `X-Mandu-Cache` 헤더 자동. Next.js ISR parity.

  **η Bundle analyzer** — `mandu build --analyze` → `.mandu/analyze/report.html` (self-contained SVG treemap, dark theme, click-to-drill) + `report.json`. Per-island raw+gz, shared chunk dedupe detection, top-20 heaviest modules. 외부 dep 없음.

  **θ Request tracing** — W3C Trace Context + AsyncLocalStorage propagation, Console + OTLP HTTP exporters. `ctx.span` + `ctx.startSpan(name, fn)` filling integration. Hand-rolled OTLP JSON encoding (opentelemetry-js dep 없음). Honeycomb / Jaeger / Tempo 호환.

  Quality: 7 packages typecheck clean, +84 regression tests, zero new
  runtime deps.

## 0.29.1

### Patch Changes

- fix: resolve #210 — `./bundler/plugins` + 6 sibling subpath exports for
  Wave E1 new modules (bundler/generate-static-params, dev-error-overlay,
  middleware/compose|define|bridge, client/hydrate). 같은 패턴 3회차
  (#194 kitchen / #202 content/prebuild 에 이어).

## 0.29.0

### Minor Changes

- Phase 18 Wave E1 — convention parity with Next.js / Astro / SvelteKit
  (5 orthogonal capabilities, 210+ regression tests).

  **α Dev Error Overlay** — 풀스크린 dev 에러 UI (`@mandujs/core/dev-error-overlay`). SSR + client 에러 양쪽, 4.4 KB gz client IIFE, 500-response에도 payload 임베드. Config `dev.errorOverlay` (default `true`, prod 3중 gate).

  **β Route conventions** — `app/<route>/{loading,error,not-found}.tsx` per-route + `(group)/` route groups + `[[...slug]]` optional catch-all. 런타임이 page를 `Suspense(loading)` + `ErrorBoundary(error)` 로 자동 감싸고, 404는 nearest-ancestor `not-found.tsx` 우선.

  **γ generateStaticParams** — Next.js-style build-time SSG. `.mandu/prerendered/` + `_manifest.json`, path-traversal-safe, 런타임 첫 dispatch check에서 `Cache-Control: immutable`로 serve. Nested dynamic / catch-all / optional catch-all 전부 지원.

  **δ Hydration strategy per-island** — `data-hydrate="load|idle|visible|interaction|media(<query>)"` 선언 spec. 1.07 KB gz runtime, public disposer contract, Astro parity + `interaction` 은 Mandu 고유.

  **ε Middleware composition API** — `defineMiddleware({ name, match?, handler })` + `compose(...)`. Onion model, short-circuit, error propagation, `ManduConfig.middleware[]` config. 기존 csrf/session/secure/rate-limit bridge adapter로 backward compat.

  Quality: 7 packages typecheck clean, 3211 core pass / 0 fail, 210+ new
  tests, zero new runtime deps.

## 0.28.0

### Minor Changes

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

## 0.27.0

### Minor Changes

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

## 0.26.0

### Minor Changes

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

## 0.25.3

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

## 0.25.2

### Patch Changes

- fix: resolve #202 — add `./content/prebuild` + sibling subpath exports
  (collection / sidebar / slug / llms-txt / schema). Same pattern as #194
  kitchen export. `mandu dev` no longer fails with "Cannot find module
  '@mandujs/core/content/prebuild'".

## 0.25.1

### Patch Changes

- fix(runtime): DX-1 — loud 5xx for malformed page default exports.
  `export default function Page()` now works (bare function auto-wrapped).
  Missing / primitive / non-function default surfaces a clear error with
  route id + pattern instead of a silent 404.

## 0.25.0

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

## 0.24.0

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

## 0.13.2

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

## 0.13.1

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

## 0.13.0

### Minor Changes

- feat: manifest를 generated artifact로 전환 (Option D)

  - `spec/routes.manifest.json` → `.mandu/routes.manifest.json` (generated artifact)
  - `spec/spec.lock.json` → `.mandu/spec.lock.json`
  - `app/` (FS Routes)가 유일한 라우트 소스
  - legacy merge 로직 제거, auto-linking 추가
  - MCP tools FS Routes 기반으로 재작성

## 0.12.2

### Patch Changes

- fix: publish 스크립트를 bun publish로 변경하여 workspace:\* 의존성 자동 변환

## 0.12.1

### Patch Changes

- chore: change license from MIT to MPL-2.0 and fix workspace dependency
