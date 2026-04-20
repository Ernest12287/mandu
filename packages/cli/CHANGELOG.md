# @mandujs/cli

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
