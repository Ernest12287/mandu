---
"@mandujs/core": minor
"@mandujs/mcp": minor
---

feat(#245 M4): MCP design discovery — 4 read tools

AI agents can now query the project's design system through MCP
without grepping the codebase or guessing at component names.

**New MCP tools** (all read-only)

- **`mandu.design.get`** — DESIGN.md by section. Pass `section: 'color-palette'`
  (or any of the 9 ids) for one slice; default `'all'` returns the
  full parsed spec. `include_raw: true` includes original markdown
  bodies alongside structured tokens.
- **`mandu.design.prompt`** — DESIGN.md §9 Agent Prompts. Pre-warm
  payload an agent loads before starting UI work. Empty array + hint
  when the section is unpopulated.
- **`mandu.design.check`** — Run `DESIGN_INLINE_CLASS` Guard rule on
  a single file. Same engine the project-wide `mandu guard check`
  uses (M2), but scoped so an agent can preview violations on a file
  it's about to edit.
- **`mandu.component.list`** — Walks `src/client/shared/ui/` and
  `src/client/widgets/` for exported React components, picks up
  JSDoc descriptions, and captures `<Name>Props` interface fields
  via AST-light extraction. `count_usage: true` adds usage counts
  across `src/**` / `app/**`.

**New core export**: `checkFileForDesignInlineClasses(rootDir, file, config)`
in `@mandujs/core/guard/design-inline-class` — single-file scan
sharing the same scanner the project-wide check uses.

12 new MCP tests cover happy paths, missing-DESIGN.md / unknown-
section error surfaces, the §7-derived auto-forbid behaviour on a
single-file check, and component category filtering / usage counts.

Phase 1 of M4 — Phase 2 (write tools: `mandu.design.extract`,
`.patch`, `.propose`, `.diff_upstream`) is deferred to a follow-up
PR per the v2 plan §4.3.
