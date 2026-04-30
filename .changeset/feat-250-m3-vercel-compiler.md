---
"@mandujs/core": minor
"@mandujs/cli": minor
---

feat(#250 M3): Vercel adapter is a DeployIntent compiler

The Vercel adapter no longer scaffolds a hand-writable `vercel.json`
from a fixed template. It now reads `.mandu/deploy.intent.json`
(produced by `mandu deploy:plan`) plus the routes manifest and
**compiles** the intents into the actual `vercel.json` shape:

- `functions` block per non-static route, with `runtime` mapped from
  the intent (`edge` → `"edge"`, `bun` → `"@vercel/bun@1.0.0"`,
  `node` → built-in)
- per-route `Cache-Control` headers from `intent.cache`
- `regions` and `maxDuration` from `intent.regions` / `intent.timeout`
- `intent.overrides.vercel` shallow-merges onto the function entry
  (memory, custom fields)

The compile primitive lives in `@mandujs/core/deploy` as
`compileVercelJson(manifest, cache, options)` so kitchen / MCP /
future CI surfaces can reuse it. Hard-error class:
`VercelCompileError` lists every route the cache cannot represent
(missing intent, invalid `runtime: "static"` on dynamic-no-params).

**Backward compat**: when `.mandu/deploy.intent.json` is absent the
adapter falls back to the legacy static-only template and points the
user at `mandu deploy:plan`.

**Issue #248 gap**: the compiler emits `@vercel/bun@1.0.0` and surfaces
a warning even though the package isn't published yet — once it ships,
no compile change is required.

Real-world end-to-end: `bun run mandu deploy --target=vercel --dry-run`
on mandujs.com now compiles 5 routes (3 static + 2 edge functions)
into a 6-header `vercel.json` with per-route Cache-Control directives.
