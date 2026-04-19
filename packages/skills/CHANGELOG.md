# @mandujs/skills

## 4.0.0

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

- Updated dependencies []:
  - @mandujs/core@0.24.0
