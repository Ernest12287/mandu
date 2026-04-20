# @mandujs/ate

## 0.20.0

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

## 0.19.2

### Patch Changes

- [`927544c`](https://github.com/konamgil/mandu/commit/927544c265a0eceff9143e5e5991d5365208ea85) Thanks [@konamgil](https://github.com/konamgil)! - fix(ate): #224 ssr-verify spec no longer crashes on redirect routes

  The `mandu test:auto` generated `ssr-verify` Playwright spec called
  `page.content()` immediately after `page.goto(url)`. On any route that
  performs a page-level redirect (meta-refresh, `return redirect(...)`,
  `/` → `/<defaultLocale>`, etc.) this raised:

  > Error: page.content: Unable to retrieve content because the page is
  > navigating and changing the content.

  Three changes:

  1. **`waitUntil: "networkidle"`** — all page-oriented spec templates
     (`route-smoke`, `ssr-verify`, `island-hydration`) now wait for network
     idle on `goto`, so downstream inspections see the final settled page.
  2. **Redirect detection** — the extractor now flags a route as
     `isRedirect` when the page source emits
     `<meta httpEquiv="refresh" ...>` or returns `redirect(...)`. The
     `ssr-verify` spec for redirect routes skips `page.content()` and the
     `<!DOCTYPE html>` / `data-mandu-island` assertions, instead asserting
     that navigation settled to a different URL. `island-hydration` specs
     are not emitted for redirect origins (the page navigates away before
     any island could hydrate).
  3. **IPv4 baseURL fallback (#223)** — the emitted specs and the
     generated `playwright.config.ts` now default to
     `http://127.0.0.1:3333` instead of `http://localhost:3333`, avoiding
     Windows Node fetch failures when IPv6 `::1` resolves first but the
     dev server binds IPv4 only.

## 0.19.1

### Patch Changes

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

## 0.2.0

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
