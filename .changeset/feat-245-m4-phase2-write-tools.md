---
"@mandujs/core": minor
"@mandujs/mcp": minor
---

feat(#245 M4 Phase 2): DESIGN.md write tools — extract / patch / propose / diff_upstream

Closes the gap between the M4 read tools and the §3.5 incremental
design loop. Agents and humans can now go from "scan the project"
to "patch DESIGN.md" without leaving MCP / CLI.

**New core helpers** (`@mandujs/core/design`)
- `extractDesignTokens(rootDir, options)` — walks `src/**` + `app/**`,
  collects color literals, font-family declarations, and recurring
  className combos. Returns proposals with occurrence count + 0..1
  confidence. Filters out tokens already represented in the existing
  DesignSpec.
- `patchDesignMd(source, op)` / `patchDesignMdBatch(source, ops)` —
  section-safe add / update / remove that touches only one row in one
  H2 section. Free-form prose between rows is preserved. Pure — no
  filesystem.
- `diffDesignSpecs(local, upstream)` — per-section added / changed /
  removed tokens (color / typography / layout / shadow) plus
  `sectionPresenceChanged`. Pure.

**New MCP tools**
- `mandu.design.extract` — read-only proposal generator.
- `mandu.design.patch` — apply add/update/remove (single op or batch).
  Defaults to dry-run; pass `dry_run: false` to actually rewrite.
- `mandu.design.propose` — extract + dry-run patch in one call. The
  workflow agents reach for in the §3.5 inner loop ("look at what
  surfaced, show the user, ask to apply").
- `mandu.design.diff_upstream` — fetch an awesome-design-md slug and
  diff against the local DESIGN.md per section.

17 core tests (extract / patch / batch / diff) + 4 MCP tests cover
dry-run safety, partial-batch success, slug-insensitive key matching,
section-presence detection, and "no operations" / missing-DESIGN.md
error surfaces.

Closes M4 Phase 2 — only M5 (Agent Loop & DX) remains in #245.
