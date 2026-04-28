---
"@mandujs/cli": minor
"@mandujs/core": minor
---

feat(#245 M1): DESIGN.md primitives — parser + scaffold + import + validate

Issue #245 M1 minimal slice. Adopts Google Stitch's 9-section DESIGN.md convention as Mandu's first-class design system spec. Mandu provides the *mechanism*, not the *content* — users either start from an empty 9-section skeleton or import any of the 69 brand specs from `VoltAgent/awesome-design-md` (MIT) by slug.

**Public surface (`@mandujs/core/design`)**:

- `parseDesignMd(source)` — never-throwing markdown walker that extracts colour palette, typography, components (with variants), layout/spacing, shadows, dos & don'ts, responsive breakpoints, and agent prompts. Unrecognised H2 headings round-trip via `extraSections`.
- `validateDesignSpec(spec)` — diagnostic for missing / empty / malformed sections (advisory, not a build gate).
- `EMPTY_DESIGN_MD` — canonical empty 9-section skeleton with HTML-comment example tokens. Designed to be filled incrementally.
- `fetchUpstreamDesignMd(slug)` — raw GitHub fetch from `awesome-design-md` (or any URL).

**CLI**:

- `mandu design init` — write empty skeleton (or `--from <slug>` to import).
- `mandu design import <slug|url>` — swap to a different brand spec.
- `mandu design validate` — report gaps without blocking.

Subsequent slices (separate PRs) add `pick` (interactive catalog), `diff` (upstream comparison), and `extract` (token proposal from source).
