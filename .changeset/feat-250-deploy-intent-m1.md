---
"@mandujs/core": minor
---

feat(#250 M1): DeployIntent primitive + heuristic inferer (`@mandujs/core/deploy`)

First milestone of the deploy-intent RFC (#250). Adds a typed
`DeployIntent` schema, a committable `.mandu/deploy.intent.json`
cache, an offline (brain-free) heuristic inferer, and the pure
`planDeploy()` function the CLI / MCP / kitchen will wrap.

New module: **`@mandujs/core/deploy`**

- `DeployIntent` (Zod) — `runtime` (static/edge/node/bun), `cache`,
  `regions`, `minInstances`/`maxInstances`, `timeout`, `visibility`,
  `target`, `overrides`. Plus `DeployIntentInput` partial form for
  the upcoming `.deploy()` builder method.
- `DeployIntentCache` — versioned, atomic-writing JSON cache keyed by
  route id. Tracks `source` (`explicit` vs `inferred`), `rationale`,
  `sourceHash`, `inferredAt`. Stable key order so diffs stay clean.
- `inferDeployIntentHeuristic()` — rule tree mapping `{ kind,
  isDynamic, hasGenerateStaticParams, dependencyClasses }` → a
  conservative `DeployIntent`. Static-by-default for prerenderable
  pages, edge for stateless APIs, server runtime when the route
  imports DB drivers / `bun:*` / Node-only modules / AI SDKs.
- `planDeploy()` — pure function: takes a manifest + previous cache,
  returns the next cache + a per-route diff. Caches by source hash
  (no re-inference on unchanged code), respects `source: "explicit"`
  as immutable.
- `isStaticIntentValidFor()` — adapter-side validator that catches
  `runtime: "static"` declared on dynamic routes without
  `generateStaticParams`.

The brain-validated inferer (M4) plugs into `planDeploy({ infer })`
without changing the plan flow. Vercel / Fly compilers (M3 / phase 2)
consume the cache directly.

61 new tests (5 files): schema round-trips, cache I/O, classifier
edge cases, every heuristic branch, override-hierarchy semantics.
