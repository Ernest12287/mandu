---
title: Bundle Size Budget
description: Declarative size ceilings for client bundles. mandu build fails (or warns) when island or project totals exceed the budget.
phase: 18.phi
status: stable
since: "0.34.0"
---

# Bundle Size Budget

Phase 18.φ adds a framework-level performance guardrail: declare maximum
byte counts for your client bundles and have `mandu build` enforce them
on every build. No more "the home island quietly ballooned by 80 KB over
three PRs". When a limit is crossed, the build either prints a warning
or exits non-zero — your choice.

Budgets compose cleanly with [`--analyze`](/docs/architect/bundle-analyzer):
the analyzer measures, the budget verdict is stamped onto the HTML and
JSON reports, and the analyzer's JSON artefact becomes a first-class CI
input for regression gates.

## At a glance

```ts
// mandu.config.ts
export default {
  build: {
    budget: {
      maxGzBytes: 60_000,          // per-island gzip cap
      maxTotalGzBytes: 250_000,    // project-wide gzip cap
      mode: "error",               // 'warning' (default) or 'error'
      perIsland: {
        // Tighten one island without relaxing the rest.
        checkout: { gz: 30_000 },
      },
    },
  },
};
```

Run:

```bash
mandu build
```

and the build logs:

```
📏 Budget check: 3/4 islands within limits (1.2 MB total raw, 210 KB gz)
┌───────────┬──────────┬──────────┬─────────┬─────────┬─────────────┐
│ island    │ raw      │ gz       │ raw lim │ gz lim  │ status      │
├───────────┼──────────┼──────────┼─────────┼─────────┼─────────────┤
│ home      │ 190 KB   │  55.2 KB │ —       │ 60.0 KB │ APPROACHING │
│ checkout* │ 420 KB   │ 120.0 KB │ —       │ 30.0 KB │ EXCEEDED    │
│ about     │  45 KB   │  14.1 KB │ —       │ 60.0 KB │ OK          │
│ <total>   │ 1.2 MB   │ 210.0 KB │ —       │ 250.0 KB│ OK          │
└───────────┴──────────┴──────────┴─────────┴─────────┴─────────────┘

❌ Bundle-size budget exceeded (1 island(s) over limit). Build aborted.
   Investigate with `mandu build --analyze` or bypass once with `mandu build --no-budget`.
```

The `*` next to `checkout` signals the per-island override is in effect.
`APPROACHING` means the island is ≥ 90% of its budget but still under —
a heads-up before you trip the ceiling.

## Configuration

```ts
build: {
  budget?: {
    maxRawBytes?: number;       // per-island raw cap
    maxGzBytes?: number;        // per-island gzip cap
    maxTotalRawBytes?: number;  // project-wide raw cap
    maxTotalGzBytes?: number;   // project-wide gzip cap
    perIsland?: Record<string, { raw?: number; gz?: number }>;
    mode?: "error" | "warning"; // default: "warning"
  };
}
```

All fields are optional integers (bytes). Zero is a valid value — it
asserts "this island should never emit code", handy for a deprecated
route you want to catch immediately if it regrows client JS.

**Per-island overrides are additive per axis.** `perIsland: { home: { gz: 30_000 } }`
tightens `home`'s gzip cap but keeps its raw cap at the global
`maxRawBytes`. You never lose a limit by adding an override.

## Opt-in semantics

| `build.budget` value       | Effect                                              |
| -------------------------- | --------------------------------------------------- |
| omitted entirely           | no enforcement, zero overhead                       |
| `{}`                       | auto-applies **250 KB per-island gzip** in `"warning"` mode |
| any explicit field         | only your declared ceilings are enforced            |

The `{}` default roughly matches Next.js's `largePageDataBytes`
soft-warning and Astro's "ship under 200 KB of JS per page" rule of
thumb — app-shell + React + a handful of libraries fit comfortably.

## Modes

| Mode        | Exceeded island behaviour                           |
| ----------- | --------------------------------------------------- |
| `"warning"` | Print table + warning, continue, exit 0             |
| `"error"`   | Print table + error, exit 1, skip analyzer HTML emit |

Warning mode is the sensible default: you get the signal without a
surprise red build the first time you declare a budget. Flip to `"error"`
in CI once you've calibrated your thresholds against real traffic.

## CLI escape hatch

```bash
mandu build --no-budget
```

Skips enforcement for a single run. The bypass is logged prominently
(`🚫 --no-budget flag set: bundle-size budget enforcement SKIPPED.`) so
a reviewer scanning CI output notices it. Use only when you're shipping
a hotfix that knowingly blows past the budget and you plan to
re-tighten the next day.

There is no config-level "disable globally" flag by design. To turn the
budget off for a project, remove the `build.budget` block — the code
path is zero-overhead when omitted.

## Status levels

| Status        | Meaning                                       | CLI colour | HTML bar         |
| ------------- | --------------------------------------------- | ---------- | ---------------- |
| `within`      | size < 90% of the limit                       | default    | green            |
| `within10`    | 90% ≤ size ≤ 100% — approaching the ceiling   | default    | yellow           |
| `exceeded`    | size > limit                                  | red        | red              |

`within10` is an advisory band — it never fails the build even in
`"error"` mode. Treat it as "add this to the next sprint's backlog".

## Comparisons

| Framework | Similar feature                              |
| --------- | -------------------------------------------- |
| **Next.js** | `largePageDataBytes` warning (default 128 KB); no hard gate |
| **Astro**   | No built-in; convention is "under 200 KB JS per page" |
| **Nuxt**    | `nuxt-modules/size-limit` (community plugin) |
| **Remix**   | No built-in; users wire `@sidewind/size-limit` manually |
| **Mandu**   | **Built-in `build.budget` with hard + soft gates and per-island overrides** |

Typical starting limits for a production Mandu app:

| Project kind        | `maxGzBytes` suggestion | `maxTotalGzBytes` suggestion |
| ------------------- | ----------------------- | ---------------------------- |
| Marketing / landing | 40–60 KB                | 120 KB                       |
| SaaS / SPA-ish      | 80–120 KB               | 250 KB                       |
| Dashboard / admin   | 150–200 KB              | 400 KB                       |

Start generous, watch the `APPROACHING` bar on the HTML report, tighten
over time. Most regressions are a single forgotten dep — the analyzer
shows you which one within seconds.

## Investigating an exceedance

When a build fails with "Bundle-size budget exceeded", run:

```bash
mandu build --analyze
```

Open `.mandu/analyze/report.html` — the **Bundle budget** section shows
the status bars up top, then the island treemap, then the top-20
heaviest modules per island. The JSON report (`report.json`) additionally
carries a `budget` key with the structured verdict so CI can fail
selectively:

```bash
# Fail the job only on exceeded, ignore approaching
jq -e '.budget.exceededCount == 0' .mandu/analyze/report.json
```

See [Bundle Analyzer](/docs/architect/bundle-analyzer) for the report
schema.

## Programmatic access

```ts
import { evaluateBudget } from "@mandujs/core/bundler/budget";
import { analyzeBundle } from "@mandujs/core/bundler/analyzer";

const report = await analyzeBundle(rootDir, bundleManifest);
const verdict = evaluateBudget(report, config.build?.budget);
if (verdict?.hasExceeded) {
  // custom gate logic — e.g., post to Slack, flake the PR, ...
}
```

`evaluateBudget()` is pure and in-memory. It works on any
`AnalyzeReport` so tests, CI scripts, and editor integrations can share
the same verdict shape as the CLI.

## Zero overhead when unused

When `build.budget` is absent from the config, the CLI short-circuits
before invoking the analyzer — you pay nothing for not using the
feature. The default-250-KB opt-in only fires when you declare the
empty block `budget: {}`.
