---
"@mandujs/core": minor
---

Agent DevTools P2 cycle (plan 18): Diagnose panel + Bundle inspector — two read-only Kitchen surfaces that turn data already on disk into one-screen answers.

- **Diagnose** — new `/__kitchen/api/diagnose` endpoint runs `runExtendedDiagnose` on demand and the new "Diagnose" tab renders every rule (manifest_freshness, prerender_pollution, cloneelement_warnings, dev_artifacts_in_prod, package_export_gaps, nested_internal_core, a11y_hints) sorted by severity. Each row expands to show suggestion + raw details JSON.
- **Bundle inspector** — new `/__kitchen/api/bundle` endpoint reads `.mandu/manifest.json` and stat's every emitted file (`shared.runtime`, `shared.vendor`, optional `shared.router`, per-route bundles, per-island bundles) to attach on-disk byte sizes. The new "Bundle" tab shows totals, the shared chunk cards, and an islands/routes table sorted biggest-first with proportional bars. `mandu build` produces it; missing files show up as 0 bytes without crashing.
