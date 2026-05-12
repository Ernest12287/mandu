---
"@mandujs/core": patch
"@mandujs/cli": patch
"@mandujs/skills": patch
"@mandujs/ate": patch
---

Fix MCP boot regressions and DevTools dev-mode UX.

- `mandu diagnose` adds a `nested_internal_core` check that flags stale `@mandujs/core` installs nested under sibling `@mandujs/*` packages, the root cause behind `Cannot find module @mandujs/core/...` boot failures (#261). Emits a copy-pastable `rm -rf` fix.
- Dev-mode SSR now injects `_devtools.js` even on SSR-only pages so Kitchen panels work on island-free landing/marketing routes; production builds remain 0 bytes (#259). Explicit `dev.devtools: false` still opts out.
- `@mandujs/skills` `peerDependencies.@mandujs/core` narrowed from the effectively-wildcard `">=0.1.0"` to `^0.53.0`, and `@mandujs/ate` now declares the same peer (it imports `@mandujs/core/observability` at runtime) — both contributed to package-manager resolver decisions that kept stale cores around (#262).
- `mandu` project templates make the `prepare` script git-tolerant so `bun install` no longer fails on machines without git in PATH (e.g. GitHub Desktop users on Windows) (#258).
