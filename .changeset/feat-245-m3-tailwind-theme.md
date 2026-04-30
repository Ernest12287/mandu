---
"@mandujs/core": minor
"@mandujs/cli": minor
---

feat(#245 M3): DESIGN.md → Tailwind v4 `@theme` Token Bridge

`mandu design sync` reads a parsed DESIGN.md and compiles its
structured tokens (color palette, typography, layout/spacing, depth
& elevation) into a Tailwind v4 `@theme` block, then merges that
block into `globals.css` between `@mandu-design-sync` markers — so
hand-written CSS outside the markers is preserved verbatim.

**New core surface** (`@mandujs/core/design`)
- `compileTailwindTheme(spec)` — pure compiler returning
  `{ entries, warnings, cssBody }`. Variable naming follows Tailwind
  v4 convention: `--color-<slug>`, `--font-<slug>`, `--text-<slug>`,
  `--spacing-<slug>`, `--shadow-<slug>`.
- `mergeThemeIntoCss(existingCss, compiled)` — replaces the
  markered region; falls back to inserting a fresh block when none
  exists. Surfaces conflicts when a DESIGN.md token contradicts a
  hand-written `@theme` declaration.
- `slugifyTokenName()` / `THEME_MARKER_START` / `THEME_MARKER_END`
  for tooling that needs to introspect the same naming rules.

**New CLI subcommand**: `mandu design sync`
- `--dry-run` — print compiled `@theme` without writing.
- `--css-path <path>` — override the auto-detected CSS file
  (defaults walk `app/globals.css` → `src/globals.css` → `src/app/globals.css`
  → `src/styles/globals.css`).
- Surfaces compile warnings (missing values, slug collisions) and
  merge conflicts inline.

15 new tests cover the slug normaliser, every section's emit shape,
the markered merge (insert / replace / strip), and a Stripe-like
end-to-end DESIGN.md.

Closes #245 M3 (Team E — Token Bridge).
