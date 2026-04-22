---
"@mandujs/core": patch
---

fix(core/runtime): #232 dev server bypasses prerendered HTML cache

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
