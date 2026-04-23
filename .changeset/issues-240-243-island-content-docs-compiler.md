---
"@mandujs/core": minor
"@mandujs/cli": minor
"@mandujs/mcp": minor
---

feat: #240 React Compiler + #241 island UX + #242 content watch + #243 docs MCP

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
  + plugin are optional peers; missing install skips diagnostics with
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
