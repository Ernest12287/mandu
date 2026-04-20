---
title: Bundle Analyzer
description: Post-build HTML treemap + JSON summary for island sizes, shared chunks, and heavy dependencies.
phase: 18.eta
status: stable
since: "0.30.0"
---

# Bundle Analyzer

Phase 18.η introduces an opt-in post-build analyzer that answers three
questions every time you ship:

1. **Which islands are biggest?** (raw + gzip bytes)
2. **What are they shipping?** (top-20 heaviest modules per island)
3. **How much are shared chunks saving us?** (dedupe savings across islands)

The report is rendered two ways: a self-contained HTML file you can open
in any browser, and a JSON file you can diff in CI.

## Usage

### CLI flag (recommended for ad-hoc inspection)

```bash
mandu build --analyze            # HTML + JSON
mandu build --analyze=json       # JSON only (skip HTML render)
```

The flag wins over `ManduConfig.build.analyze` at runtime.

### Config (always-on for a project)

```ts
// mandu.config.ts
export default {
  build: {
    analyze: true,  // emits .mandu/analyze/ on every `mandu build`
  },
};
```

### Sourcemap-powered drill-down

Per-module breakdown requires sourcemaps. Run:

```bash
mandu build --sourcemap --analyze
```

Without `--sourcemap` the report still renders the island-level treemap;
each island simply shows _"No sourcemap available"_ when you drill into it.

## Output

Written to `.mandu/analyze/`:

- `report.html` — single-file HTML. Dark theme, monospace, inline SVG
  treemap, zero external CDN/JS. Drag-and-drop into a browser.
- `report.json` — machine-readable. Shape spec below; schema versioned
  via `summary.version`.

### JSON shape

```ts
interface AnalyzeReport {
  islands: Array<{
    name: string;                     // route id / island name
    js: string;                       // /.mandu/client/<file>.js
    totalRaw: number;                 // raw bytes
    totalGz: number;                  // real gzip (level 9)
    priority: "immediate" | "visible" | "idle" | "interaction";
    shared: string[];                 // chunk ids referenced
    modules: Array<{
      path: string;                   // e.g. "react-dom/index.js"
      size: number;                   // raw bytes attributed to this source
      gz: number;                     // ~proportional gz estimate
    }>;                               // top-20, empty when no sourcemap
  }>;
  shared: Array<{
    id: string;                       // "runtime" | "vendor" | "router" | ...
    js: string;                       // /.mandu/client/<file>.js
    size: number;
    gz: number;
    usedBy: string[];                 // island names
  }>;
  summary: {
    totalRaw: number;
    totalGz: number;
    largestIsland: { name: string; totalRaw: number } | null;
    heaviestDep: { path: string; size: number } | null;
    islandCount: number;
    sharedCount: number;
    dedupeSavings: number;            // bytes saved by reusing shared chunks
    version: 1;                       // bump on breaking schema changes
    generatedAt: string;              // ISO 8601
  };
}
```

## Reading the HTML report

- **Island treemap** — rectangle area ∝ raw bytes. Click to drill into
  the per-module table for that island. Press `ESC` or click another
  tile to navigate.
- **Shared chunks table** — every chunk with its `usedBy` list. A chunk
  referenced by `N > 1` islands saves `(N-1) * size` bytes of wire
  duplication; the `Dedupe savings` summary card sums these.
- **Modules table (drill view)** — top-20 heaviest source files per
  island, with a per-row percentage bar. The `~gz` column is a
  proportional estimate (gzip is non-additive); the island-total gz
  shown in the header is real.

## Common optimisation patterns

| Signal in report                                  | Likely cause                                              | Fix                                                  |
|---------------------------------------------------|-----------------------------------------------------------|------------------------------------------------------|
| One island >> the rest                            | A large third-party dep landed in a single island         | Split the island with `island(..., { lazy: true })`  |
| `heaviestDep` shows `node_modules/moment/...`     | Importing a kitchen-sink date library                     | Swap for `date-fns` / native `Intl.DateTimeFormat`   |
| `heaviestDep` shows `.tsx` from your app          | A page-level component is pulled into an island           | Gate imports behind `.client.tsx` boundary           |
| `dedupeSavings` close to zero                     | Islands are ship disjoint deps — shared chunk is thin     | Audit for duplicate imports across islands           |
| Shared `vendor` chunk >> 100 KB                   | React dev-mode runtime escaped into prod                  | Check `env: "production"` + `--minify` (default on)  |
| Missing sourcemap warning on drill-in             | Ran without `--sourcemap`                                 | `mandu build --sourcemap --analyze`                  |

## Design notes

- **No runtime deps.** The HTML ships a hand-rolled squarify treemap
  (~60 LOC) inline. No d3, no webpack-bundle-analyzer fork, no CDN. The
  report file opens from a `file://` URL, email attachment, or private
  static host unchanged.
- **No network.** Analyzer is pure-filesystem post-processing of the
  files `buildClientBundles()` already wrote. Safe to run in air-gapped
  CI.
- **Non-fatal.** If the analyzer throws (e.g. permission error on
  `.mandu/analyze/`) the build still succeeds — the error is logged
  with `⚠️` and the `onAfterBuild` hook fires with `success: true`. A
  broken analyzer must never block a ship.
- **Deterministic ordering.** Islands sorted by `totalRaw DESC`, shared
  chunks by `size DESC`, modules within an island by `size DESC`. CI
  snapshots won't churn on Map iteration order.
- **XSS-safe HTML.** Island names come from route ids, which can contain
  user-authored segments. The template escapes every interpolation
  (`escText` for text content, `escAttr` for attributes) and never
  embeds user content in a JS string-literal context — drill-down uses
  `data-drill` attributes + a delegated listener that reads via
  `dataset`, not `eval`/`Function`/template concatenation.

## Related

- [`docs/architect/static-generation.md`](./static-generation.md) — prerender, a sibling
  post-build artefact.
- [`@mandujs/core/bundler/analyzer`](../../packages/core/src/bundler/analyzer.ts) —
  programmatic API for custom dashboards.
