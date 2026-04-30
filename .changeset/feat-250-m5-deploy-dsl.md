---
"@mandujs/core": minor
"@mandujs/cli": patch
---

feat(#250 M5): `.deploy()` DSL on Mandu.filling() — explicit override path

The Filling builder gains a chainable `.deploy(intent)` method that
pins the DeployIntent for a route. The build-time extractor flows
captured intents into `.mandu/deploy.intent.json` as
`source: "explicit"`, which the M1 planner protects from inference.
Result: the user's `.deploy()` always wins over heuristic + brain.

```ts
// app/api/embed/route.ts
export default Mandu.filling()
  .deploy({ runtime: "bun", regions: ["icn1"] })
  .post(async (ctx) => Response.json({ ok: true }));
```

**New API**
- `ManduFilling.deploy(intent)` — chainable, validates immediately
  (a typo like `runtime: "lambdda"` fails at module load).
- `ManduFilling.getDeployIntent()` — read accessor used by the
  extractor and tests.

**New core exports** (`@mandujs/core/deploy`)
- `extractExplicitIntents(rootDir, manifest, options?)` — dynamic-
  imports each route, captures `getDeployIntent()` returns.
  Errors are non-fatal and surfaced per-route.
- `mergeExplicitIntents(cache, entries, rootDir, manifest)` — folds
  captured intents into a cache as `source: "explicit"` with the
  current file hash so drift detection still works.

**CLI integration**
- `mandu deploy:plan` runs the extractor BEFORE `planDeploy`. The
  user's `.deploy()` overrides land as explicit cache rows ahead of
  inference, so the heuristic/brain only sees the routes the user
  hasn't pinned. Errors surface as `(filling.deploy) <route>: ...`
  in the plan output.

10 new unit tests cover the chainable method, immediate validation,
the extractor's import-failure / non-filling-default / missing-file
paths, and the merge step's source-hash recomputation.

Closes the #250 RFC Phase 1 milestone set: M1 (schema + cache +
heuristic) → M2 (deploy:plan CLI) → M3 (Vercel compiler) → M4
(brain inference) → M5 (Filling DSL).
