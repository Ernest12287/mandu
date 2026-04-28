---
"@mandujs/cli": minor
"@mandujs/core": minor
---

feat(#240): React Compiler auto-detect (Phase 2)

`experimental.reactCompiler.enabled` defaults to **auto** when unset:

- `enabled: true` — user opts in explicitly. Plugin runs; warns when peer deps are missing (unchanged).
- `enabled: false` — user opts out explicitly. Plugin never runs (unchanged).
- _unset_ (default) — `Bun.resolveSync` probes for `@babel/core` + `babel-plugin-react-compiler` in the project's `node_modules`. Both present → auto-enable. Either missing → stay disabled silently (no warning).

Net effect: `bun add -d @babel/core babel-plugin-react-compiler` is now the only step needed to turn auto-memoization on. No `mandu.config.ts` change required.

`mandu build`, `mandu dev`, and `mandu check` all flow through the new resolver (`@mandujs/core/bundler/plugins#resolveReactCompilerConfig`), so the bundler's transform plugin and the bailout-lint runner stay in sync. When auto-detect kicks in, build/dev print `🧠 React Compiler — auto-detected peer deps; auto-memoization enabled.` once per session.

Tests in `packages/core/src/bundler/plugins/__tests__/react-compiler-config.test.ts`.
