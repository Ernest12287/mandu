---
"@mandujs/cli": minor
"@mandujs/core": patch
---

feat(#250 M2): `mandu deploy:plan` — infer DeployIntent for every route

Wraps the M1 plan engine in an interactive CLI command. Reads `app/`,
runs the offline heuristic inferer, renders a per-route diff, and
writes `.mandu/deploy.intent.json` (with confirmation by default,
non-interactive on `--apply` / `--dry-run`).

```
$ mandu deploy:plan --dry-run
Mandu deploy:plan — inferred intents
────────────────────────────────────────────────
5 added

+ api-health                               /api/health
   runtime: edge, cache: no-store, visibility: public
   rationale: API route with only fetch-class dependencies …
+ $lang                                    /:lang
   runtime: static, cache: { sMaxAge=31536000, swr=86400 }, visibility: public
   rationale: dynamic page exports generateStaticParams — …
…
Dry run complete — cache file untouched.
```

Flags:

- `--apply`     write without prompting (CI-safe)
- `--dry-run`   render plan, do not prompt or write
- `--reinfer`   force re-inference even on unchanged sources
- `--verbose`   include unchanged rows in the diff
- `--use-brain` reserved for M4 (no-op for now)

Also fixes the M1 dynamic-pattern detector to recognise Mandu's
`:param` / `*` route patterns in addition to the bracket form. Without
this, `[lang]/page.tsx` was misclassified as non-dynamic in M1.

Adapters / brain inferer plug into the same flow without changing the
plan engine.
