---
"@mandujs/core": minor
"@mandujs/cli": minor
---

feat(#245 M5): Agent Loop & DX — `init --design`, `design link`, `design lint`

Closes the design-system mechanism initiative. New surfaces wire
DESIGN.md into the project bootstrap and agent guides so coding
agents pre-warm with the design context every session.

**`mandu init --design[=<slug>]`**
- Bare flag → empty 9-section DESIGN.md skeleton.
- With slug → import an awesome-design-md brand spec (e.g.
  `--design=stripe`).
- Always wires AGENTS.md (creating it when missing) so agents see
  the design block immediately. CLAUDE.md is updated when present.

**`mandu design link [--create]`**
- Idempotently inserts a markered `## Design System` block into
  AGENTS.md / CLAUDE.md. The block lists all 8 MCP design tools
  with one-line descriptions and spells out the §3.5 5-step
  workflow as a prompt agents follow verbatim.
- Re-runs replace the markered region only — hand-written prose
  outside the markers is preserved.

**`mandu design lint`**
- DESIGN.md self-consistency check: malformed hex, missing values,
  slug collisions in palette/typography/layout/shadows, duplicate
  component H3 names. Three severities (error / warning / info);
  errors fail the command.

**New core exports** (`@mandujs/core/design`)
- `linkAgentsToDesignMd({ rootDir, createIfMissing? })` — pure
  helper backing the CLI command. Markered, idempotent.
- `buildAgentsDesignBlock(filename?)` — generates the markered
  block payload (used by tests and external tooling).
- `lintDesignSpec(spec)` — pure lint engine.
- `DESIGN_LINK_MARKER_START` / `DESIGN_LINK_MARKER_END` constants.

23 new core tests (linker insert/replace/idempotent/create-if-
missing + lint rules across all 4 token sections + clean spec
sanity). End-to-end smoke on a tmp project verified `lint` reports
both warning categories and `link` inserts the block under an
existing AGENTS.md.

Closes #245 — Phase 1 milestone set complete: M1 (parser/scaffold)
→ M2 (Guard) → M3 (Tailwind theme) → M4 (8 MCP tools) → M5 (agent
loop / lint / link).
