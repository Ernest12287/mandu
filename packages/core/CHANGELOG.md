# @mandujs/core

## 0.53.1

### Patch Changes

- [`bd8c65c`](https://github.com/konamgil/mandu/commit/bd8c65cf8ae34d617b685d0a4e4829abd440ea73) Thanks [@konamgil](https://github.com/konamgil)! - fix(#254): emit `dist/404.html` from `app/not-found.tsx` during static build

  Static hosts (Vercel, Netlify, Cloudflare Pages, Firebase Hosting)
  auto-serve `dist/404.html` for unmatched URLs. Mandu's
  `build --static` previously left `app/not-found.tsx` invisible to
  the static export, so visitors hit the platform's plain-text
  default ("The page could not be found / NOT_FOUND") instead of the
  framework's own 404 page.

  The prerender step now:

  1. Checks for `app/not-found.{tsx,ts,jsx,js}` at the project root.
  2. Issues a multi-segment sentinel probe through the SSR pipeline so
     the registered not-found handler renders the page exactly the
     way it does at runtime.
  3. Writes the 404-status response body to `<outDir>/404.html`.
  4. Skips emit (with a clear warning) when a root-level catch-all
     route absorbs the probe — emitting the catch-all body as
     `404.html` would be wrong.

  The `static-export` step copies the file through verbatim (it
  already mirrors `.mandu/prerendered/` into `dist/`), so the
  mandujs.com workaround (`scripts/postbuild-404.ts`) can be removed.

## 0.53.0

### Minor Changes

- [`4a3379f`](https://github.com/konamgil/mandu/commit/4a3379f6fc98ad64732caab26a84a7eea32cbec1) Thanks [@konamgil](https://github.com/konamgil)! - feat(#245 M5): Agent Loop & DX — `init --design`, `design link`, `design lint`

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

## 0.52.0

### Minor Changes

- [`aeb9657`](https://github.com/konamgil/mandu/commit/aeb9657e3eaf59c012530ec5bf3577c90514e03d) Thanks [@konamgil](https://github.com/konamgil)! - feat(#245 M4 Phase 2): DESIGN.md write tools — extract / patch / propose / diff_upstream

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

## 0.51.0

### Minor Changes

- [`274e7a3`](https://github.com/konamgil/mandu/commit/274e7a3a47cdd5ad736e02f1301d7f434f4de93b) Thanks [@konamgil](https://github.com/konamgil)! - feat(#245 M4): MCP design discovery — 4 read tools

  AI agents can now query the project's design system through MCP
  without grepping the codebase or guessing at component names.

  **New MCP tools** (all read-only)

  - **`mandu.design.get`** — DESIGN.md by section. Pass `section: 'color-palette'`
    (or any of the 9 ids) for one slice; default `'all'` returns the
    full parsed spec. `include_raw: true` includes original markdown
    bodies alongside structured tokens.
  - **`mandu.design.prompt`** — DESIGN.md §9 Agent Prompts. Pre-warm
    payload an agent loads before starting UI work. Empty array + hint
    when the section is unpopulated.
  - **`mandu.design.check`** — Run `DESIGN_INLINE_CLASS` Guard rule on
    a single file. Same engine the project-wide `mandu guard check`
    uses (M2), but scoped so an agent can preview violations on a file
    it's about to edit.
  - **`mandu.component.list`** — Walks `src/client/shared/ui/` and
    `src/client/widgets/` for exported React components, picks up
    JSDoc descriptions, and captures `<Name>Props` interface fields
    via AST-light extraction. `count_usage: true` adds usage counts
    across `src/**` / `app/**`.

  **New core export**: `checkFileForDesignInlineClasses(rootDir, file, config)`
  in `@mandujs/core/guard/design-inline-class` — single-file scan
  sharing the same scanner the project-wide check uses.

  12 new MCP tests cover happy paths, missing-DESIGN.md / unknown-
  section error surfaces, the §7-derived auto-forbid behaviour on a
  single-file check, and component category filtering / usage counts.

  Phase 1 of M4 — Phase 2 (write tools: `mandu.design.extract`,
  `.patch`, `.propose`, `.diff_upstream`) is deferred to a follow-up
  PR per the v2 plan §4.3.

## 0.50.0

### Minor Changes

- [`e41e3af`](https://github.com/konamgil/mandu/commit/e41e3af8cf6f7cb5fb552ca3a402c3e9cf1a89e7) Thanks [@konamgil](https://github.com/konamgil)! - feat(#245 M3): DESIGN.md → Tailwind v4 `@theme` Token Bridge

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

## 0.49.0

### Minor Changes

- [`0eb7ce7`](https://github.com/konamgil/mandu/commit/0eb7ce723004dcc1be08232ec6e7a818d0e73cb2) Thanks [@konamgil](https://github.com/konamgil)! - feat(#250 M5): `.deploy()` DSL on Mandu.filling() — explicit override path

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

## 0.48.0

### Minor Changes

- [`fcaa77d`](https://github.com/konamgil/mandu/commit/fcaa77d7d01353fd63a1c69f0a61bde674a78d4f) Thanks [@konamgil](https://github.com/konamgil)! - feat(#250 M4): brain-validated deploy intent inference

  `mandu deploy:plan --use-brain` (and the MCP `mandu.deploy.plan`
  tool with `use_brain: true`) wraps the offline heuristic with the
  OAuth-backed brain adapter. The brain confirms or refines each
  route's intent without ever blocking the pipeline:

  **Wrap-not-replace shape**

  - Heuristic runs first (cost cap: ~80% of routes correct, $0).
  - Brain weighs in on the same context and writes its own JSON.
  - Output is parsed → Zod-validated → re-checked against route shape
    (`isStaticIntentValidFor`). Any failure falls back to heuristic
    with a rationale prefix that explains why.

  **Failure modes (all silent fall-back)**

  - LLM throws (network, auth, rate limit) — heuristic survives.
  - LLM returns empty / non-JSON — heuristic survives.
  - LLM returns JSON that fails the Zod schema — heuristic survives.
  - LLM returns `runtime: "static"` on a dynamic page without
    `generateStaticParams` — heuristic survives.

  **Surfacing the brain status**

  - CLI: `🧠 Using brain (openai) to refine heuristic intents.` plus
    a clear "Run `mandu brain login --provider=openai`" hint when
    `--use-brain` is passed without a token.
  - MCP: response carries `brain_status` (`used:openai`,
    `unavailable:needs_login`, `unavailable:opted_out`,
    `not_requested`) so agents can drive the login flow programmatically.

  **New core export**: `inferDeployIntentWithBrain({ adapter })` —
  the same wrapper kitchen / future MCP surfaces can plug in.

  9 brain inferer tests cover happy path, partial-output merging,
  fenced-JSON stripping, every fallback class, and `failOnError`
  propagation. CLI and MCP gain integration tests for the
  no-token / brain-active branches.

## 0.47.0

### Minor Changes

- [`9e9741f`](https://github.com/konamgil/mandu/commit/9e9741f46e20da586fbb1041738e6e1b8afb95f7) Thanks [@konamgil](https://github.com/konamgil)! - feat(#250 M3): Vercel adapter is a DeployIntent compiler

  The Vercel adapter no longer scaffolds a hand-writable `vercel.json`
  from a fixed template. It now reads `.mandu/deploy.intent.json`
  (produced by `mandu deploy:plan`) plus the routes manifest and
  **compiles** the intents into the actual `vercel.json` shape:

  - `functions` block per non-static route, with `runtime` mapped from
    the intent (`edge` → `"edge"`, `bun` → `"@vercel/bun@1.0.0"`,
    `node` → built-in)
  - per-route `Cache-Control` headers from `intent.cache`
  - `regions` and `maxDuration` from `intent.regions` / `intent.timeout`
  - `intent.overrides.vercel` shallow-merges onto the function entry
    (memory, custom fields)

  The compile primitive lives in `@mandujs/core/deploy` as
  `compileVercelJson(manifest, cache, options)` so kitchen / MCP /
  future CI surfaces can reuse it. Hard-error class:
  `VercelCompileError` lists every route the cache cannot represent
  (missing intent, invalid `runtime: "static"` on dynamic-no-params).

  **Backward compat**: when `.mandu/deploy.intent.json` is absent the
  adapter falls back to the legacy static-only template and points the
  user at `mandu deploy:plan`.

  **Issue #248 gap**: the compiler emits `@vercel/bun@1.0.0` and surfaces
  a warning even though the package isn't published yet — once it ships,
  no compile change is required.

  Real-world end-to-end: `bun run mandu deploy --target=vercel --dry-run`
  on mandujs.com now compiles 5 routes (3 static + 2 edge functions)
  into a 6-header `vercel.json` with per-route Cache-Control directives.

## 0.46.2

### Patch Changes

- [`2329969`](https://github.com/konamgil/mandu/commit/232996911f638e54b38047698c3c8f86f4fee927) Thanks [@konamgil](https://github.com/konamgil)! - fix(#253): SPA router no longer drops the first click after #252

  Regression on top of #252. When `document.startViewTransition()`
  aborts before its callback runs (rapid navigation, popstate races,
  the user clicks a second link before the first transition finishes),
  the browser SKIPS the callback — meaning the in-flight `applyUpdate`
  never executes and the click is silently lost. #252 quieted the
  console-side rejection but the navigation it was driving disappeared
  along with it. Symptom: "first click does nothing, second click works."

  Both `client/router.ts` and the inlined `spa-nav-helper.ts` script
  now wrap the callback with an `applied` flag and run it directly
  when any of `updateCallbackDone` / `ready` / `finished` reject before
  the callback fires. The flag prevents double-apply when the
  transition completes normally.

  Regression test added in `packages/core/tests/client/router.test.ts`
  that mocks the spec abort path and asserts the URL + router state
  update anyway.

## 0.46.1

### Patch Changes

- [`8d9ca34`](https://github.com/konamgil/mandu/commit/8d9ca34cbb61ef0d90e512ec18d2ca34dd2e5779) Thanks [@konamgil](https://github.com/konamgil)! - feat(#250 M2): `mandu deploy:plan` — infer DeployIntent for every route

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

  - `--apply` write without prompting (CI-safe)
  - `--dry-run` render plan, do not prompt or write
  - `--reinfer` force re-inference even on unchanged sources
  - `--verbose` include unchanged rows in the diff
  - `--use-brain` reserved for M4 (no-op for now)

  Also fixes the M1 dynamic-pattern detector to recognise Mandu's
  `:param` / `*` route patterns in addition to the bracket form. Without
  this, `[lang]/page.tsx` was misclassified as non-dynamic in M1.

  Adapters / brain inferer plug into the same flow without changing the
  plan engine.

## 0.46.0

### Minor Changes

- [`aad5d69`](https://github.com/konamgil/mandu/commit/aad5d695889ff9f59a6a1381969c0c70f2cfd80e) Thanks [@konamgil](https://github.com/konamgil)! - feat(#250 M1): DeployIntent primitive + heuristic inferer (`@mandujs/core/deploy`)

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

- [`aad5d69`](https://github.com/konamgil/mandu/commit/aad5d695889ff9f59a6a1381969c0c70f2cfd80e) Thanks [@konamgil](https://github.com/konamgil)! - refactor(brain): remove Ollama tier; cloud OAuth is the only non-template adapter

  The local-LLM (Ollama) tier is gone. The brain resolver now resolves
  in priority order **openai → anthropic → template**, and the
  `adapter` config union no longer accepts `"ollama"`. The `ollama` npm
  dependency is removed from `@mandujs/core`.

  `BrainAdapterResolution` gains a `needsLogin: boolean` field so
  interactive surfaces can detect "fell back to template because the
  user has no token" vs "fell back because the user opted out". The new
  `ensureBrainLogin()` helper in `@mandujs/cli` reads that signal and
  prompts to run `mandu brain login --provider=openai` when needed.

  `mandu brain status` surfaces the same hint inline. The MCP
  `mandu.brain.status` tool exposes `needs_login` + `login_hint` so AI
  agents can drive the login flow programmatically.

  **Migration**: any `ManduConfig` block that set `brain.adapter = "ollama"`
  or `brain.ollama.*` must be removed — the schema now rejects them.
  Default behavior (omitted block) is unchanged: auto-resolves to the
  best available cloud tier, falls back to template otherwise.

## 0.45.1

### Patch Changes

- [`53ca946`](https://github.com/konamgil/mandu/commit/53ca946f293ec6510992b0e31d09118bccf2c523) Thanks [@konamgil](https://github.com/konamgil)! - fix(#251): serve public/\* assets at root URL in dev (parity with `mandu build --static`)

  `mandu build --static` flattens `public/<file>` into the dist root, so
  `/images/foo.webp` resolves in production. In dev the static handler
  only mounted `/public/<file>`, leaving authors to choose between
  `/public/...` (works in dev, also OK in prod via Vercel rewrite) and
  `/...` (broken in dev, OK in prod). The mismatch surfaced as 404s on
  prop-bound `<img src>` references that strip the `/public/` prefix.

  The dev/prod static server now also serves `/<asset>.<ext>` from
  `public/<asset>.<ext>` when the path has a recognised asset extension
  (`.webp`, `.png`, `.css`, `.woff2`, …). If the file is missing, the
  handler falls through to the router so route patterns like
  `/api/foo.json` are not shadowed by the fallback.

## 0.45.0

### Minor Changes

- [`117fd08`](https://github.com/konamgil/mandu/commit/117fd08c674e2e13d60f8a66295caf23eae1db78) Thanks [@konamgil](https://github.com/konamgil)! - feat(#245 M1): DESIGN.md primitives — parser + scaffold + import + validate

  Issue #245 M1 minimal slice. Adopts Google Stitch's 9-section DESIGN.md convention as Mandu's first-class design system spec. Mandu provides the _mechanism_, not the _content_ — users either start from an empty 9-section skeleton or import any of the 69 brand specs from `VoltAgent/awesome-design-md` (MIT) by slug.

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

- [`4faa29d`](https://github.com/konamgil/mandu/commit/4faa29d2c528718f15a9f62ce16c25da0a6758d4) Thanks [@konamgil](https://github.com/konamgil)! - feat(#245 M2): Guard `DESIGN_INLINE_CLASS` rule (build gate)

  Issue #245 M2 — the actual build gate. The Guard pipeline now refuses to ship a build when a `className` literal contains a forbidden token outside the canonical component dirs. This is the regression-blocking part of #245: agents that re-inline `btn-hard` across pages now hit a hard fail with a message that names the replacement component.

  **Config (`mandu.config.ts`)**:

  ```ts
  guard: {
    design: {
      designMd: "DESIGN.md",                          // default
      forbidInlineClasses: ["btn-hard", "shadow-hard"], // explicit list
      autoFromDesignMd: true,                          // also pull from DESIGN.md §7 Don't
      requireComponent: {
        "btn-hard": "@/client/shared/ui#MButton",
      },
      exclude: ["src/client/shared/ui/**", "src/client/widgets/**"], // default
      severity: "error",                               // default
    },
  }
  ```

  **Behaviour**:

  - Scans `<rootDir>/src` and `<rootDir>/app` for `.ts`/`.tsx`/`.js`/`.jsx`.
  - Detects forbidden tokens inside any string literal (`"…"`, `'…'`, `` `…` ``). Strips Tailwind variant prefixes (`hover:btn-hard` matches `btn-hard`).
  - `autoFromDesignMd: true` extracts forbid tokens from DESIGN.md §7 Do's & Don'ts — every backticked token in a "Don't" rule (`Inline \`btn-hard\` directly`) becomes a forbid entry.
  - Default `exclude` skips `src/client/shared/ui/**` and `src/client/widgets/**` so the canonical component dirs (where the forbidden classes legitimately live) don't self-flag.
  - Violations carry the replacement component in both `message` and `suggestion` so an agent reading the diagnostic can fix the regression directly.

  **Implementation note**: detection is regex-based, not AST-based. The Guard pass runs frequently and a string-literal sweep is O(n) over file size with no parse failures. Tradeoff: forbidden tokens inside comments still flag — the regression we exist to prevent matters more than that false positive.

  Tests in `packages/core/src/guard/__tests__/design-inline-class.test.ts`.

### Patch Changes

- [`eceec68`](https://github.com/konamgil/mandu/commit/eceec68445d8674a54be4fd27020b014c5c2ed6c) Thanks [@konamgil](https://github.com/konamgil)! - fix(#252): swallow ViewTransition promise rejections in SPA router

  `document.startViewTransition()` returns an object whose `.finished`,
  `.ready`, and `.updateCallbackDone` promises reject with
  `InvalidStateError: Transition was aborted because of invalid state`
  when a newer navigation aborts the in-flight transition. The router
  called `startViewTransition` but never attached `.catch()` handlers,
  so those rejections escaped to the global error handler — visible as
  an unhandled promise rejection on every rapid SPA navigation.

  Both call sites now attach noop catches:

  - `packages/core/src/client/router.ts` — typed router `navigate()`
  - `packages/core/src/client/spa-nav-helper.ts` — inlined SSR helper

## 0.44.0

### Minor Changes

- [`b3f3899`](https://github.com/konamgil/mandu/commit/b3f389979d236c3b8977f4a95dc11796ef14a112) Thanks [@konamgil](https://github.com/konamgil)! - feat(#240): React Compiler auto-detect (Phase 2)

  `experimental.reactCompiler.enabled` defaults to **auto** when unset:

  - `enabled: true` — user opts in explicitly. Plugin runs; warns when peer deps are missing (unchanged).
  - `enabled: false` — user opts out explicitly. Plugin never runs (unchanged).
  - _unset_ (default) — `Bun.resolveSync` probes for `@babel/core` + `babel-plugin-react-compiler` in the project's `node_modules`. Both present → auto-enable. Either missing → stay disabled silently (no warning).

  Net effect: `bun add -d @babel/core babel-plugin-react-compiler` is now the only step needed to turn auto-memoization on. No `mandu.config.ts` change required.

  `mandu build`, `mandu dev`, and `mandu check` all flow through the new resolver (`@mandujs/core/bundler/plugins#resolveReactCompilerConfig`), so the bundler's transform plugin and the bailout-lint runner stay in sync. When auto-detect kicks in, build/dev print `🧠 React Compiler — auto-detected peer deps; auto-memoization enabled.` once per session.

  Tests in `packages/core/src/bundler/plugins/__tests__/react-compiler-config.test.ts`.

## 0.43.1

### Patch Changes

- [`782ed46`](https://github.com/konamgil/mandu/commit/782ed468a463a7426140d109fb359cd437d03ec4) Thanks [@konamgil](https://github.com/konamgil)! - fix(#247): Vercel adapter generates a deployable SSR artifact

  - Bug 4: rename SSR function from `api/_mandu.ts` to `api/mandu.ts` — Vercel hides leading-underscore files in `/api` (Next.js `_app`/`_document` convention) so the previous filename was silently dropped from function detection.
  - Bug 5: move `registerManifestHandlers` from `@mandujs/cli/util/handlers` to `@mandujs/core/runtime`. The CLI subpath has no `exports` map, so the generated SSR entry could not import it under strict resolution. Now exported from the public `@mandujs/core` surface — same package the entry already imports `startServer`/`generateManifest` from.

  The Netlify adapter template was changed alongside since it had the same private-import smell. JIT prewarm's deep-specifier list was updated to point at `@mandujs/core/runtime` instead of the deleted `cli/util/handlers`.

## 0.43.0

### Minor Changes

- [`f92151b`](https://github.com/konamgil/mandu/commit/f92151b2ef129b1dff068024fb527b443874d50e) Thanks [@konamgil](https://github.com/konamgil)! - feat(guard): #follow-up-E `mandu guard --type-aware` bridge

  Wires `oxlint --type-aware` (tsgolint) into Mandu Guard as an opt-in
  type-aware lint layer that runs after the architecture / layer check.

  - **`@mandujs/core/guard/tsgolint-bridge`** — new module. Spawns
    `oxlint --type-aware --format=json` with `Bun.spawn`, translates each
    diagnostic into the existing `Violation` contract, and returns a
    `{ violations, summary, skipped? }` envelope. Graceful skip when the
    binary is absent (`node_modules/.bin/oxlint[.exe]` missing →
    `{ skipped: "oxlint-not-installed" }`). 60s wall-clock timeout
    (`MANDU_TSGOLINT_TIMEOUT_MS` env override for slow agents).

  - **`ManduConfig.guard.typeAware`** — new optional config block.
    Fields: `rules?: string[]` (allowlist), `severity?: "off"|"warn"|"error"`,
    `configPath?: string`. Declaring the block flips the default to "on"
    for `mandu guard`; the CLI's `--no-type-aware` flag always wins.

  - **`mandu guard --type-aware` / `--no-type-aware`** — CLI flags on
    `guard-arch`. Type-aware errors flip the exit code; warnings alone
    stay green (CI flag escalates warnings, matching the architecture
    pass). JSON output mode emits a secondary `{ typeAware }` JSON document.

  - **`mandu_guard_check` MCP tool** — gains a `typeAware?: boolean`
    input field; response JSON mirrors the CLI shape via a new
    `typeAware` field (skip reason, summary, violations).

  No new runtime dependencies — `oxlint` stays a user-side dev dep.
  Existing architecture-layer Guard tests unchanged (272 pass). Adds
  21 new tests (15 bridge + 6 CLI) covering rule-id normalization,
  severity mapping, diagnostic translation, binary resolution,
  graceful skip, severity=off short-circuit, filter allowlist, and
  CLI exit-code gating.

- [`ad21b50`](https://github.com/konamgil/mandu/commit/ad21b50a5740754031a39f36d484f30ecb93013c) Thanks [@konamgil](https://github.com/konamgil)! - feat: #240 React Compiler + #241 island UX + #242 content watch + #243 docs MCP

  **#240 — React Compiler opt-in** (@mandujs/core, @mandujs/cli)

  - New `@mandujs/core/bundler/plugins/react-compiler` — inline-ported
    Bun plugin that runs `babel-plugin-react-compiler` over the
    client-bundle path (islands / `"use client"` / partial). SSR paths
    are deliberately skipped — re-render memoization has zero value on
    a one-shot HTML render.
  - `ManduConfig.experimental.reactCompiler.{enabled,compilerConfig,strict}`
    — opt-in flag + passthrough config + Phase-2 CI-strict switch.
  - `@babel/core` + `babel-plugin-react-compiler` declared as optional
    peer deps; missing install degrades to a logged warning.
  - React peer pinned to `^19.2.0` across root + core + all three user
    templates (react-compiler runtime needs ≥19.1).
  - Dev bundler forwards the flag through every `buildClientBundles()`
    rebuild path; CLI `mandu dev` reads `config.experimental.reactCompiler`.
  - **Phase 2** — `mandu check` runs `eslint-plugin-react-compiler`
    over the exact files the bundler would compile and surfaces
    bailouts. `strict: true` makes any bailout a non-zero exit. ESLint
    - plugin are optional peers; missing install skips diagnostics with
      a warning.
  - New `docs/architect/react-compiler.md` — activation, scope, peer
    deps, bailout behaviour, dev/prod trade-offs, CI-strict mode.

  **#241 — island authoring UX fixes** (@mandujs/core)

  - Export `Mandu` alias of `ManduClient` so the README's documented
    `Mandu.island/filling` shape resolves at runtime.
  - `scanIslandFiles()` now also descends into `_components/` +
    `_islands/` sibling folders (one level) — previously only the
    page's own directory was scanned, silently dropping co-located
    islands.
  - `CompiledIsland` is now a callable React component whose body
    throws a clear `[Mandu Island] Islands are page-level client
bundles …` message pointing at `partial()` — replaces React's
    opaque "Element type is invalid... got: object" error.

  **#242 — content collection dev server watcher** (@mandujs/core, @mandujs/cli)

  - `Collection` constructor registers into a module-scoped Set;
    `getRegisteredCollections()` + `invalidateAllCollections()` exposed
    from `@mandujs/core/content`.
  - Dev bundler watches `content/` by default, classifier routes
    `*.{mdx,md,yaml,yml,json}` under that directory to a new
    `content-change` batch kind, and `handleContentChange` invalidates
    every registered collection + fires optional `onContentChange`
    callback.
  - CLI `mandu dev` wires the callback to a `full-reload` HMR
    broadcast so sidebars / route trees refresh without a manual
    restart.

  **#243 — docs MCP tools** (@mandujs/mcp)

  - `mandu.docs.search({ query, scope?, limit?, includeBody? })` —
    offline keyword search over the project's `docs/` markdown tree.
    Scored by title / body hits, bounded (5 000 files max, 280-char
    excerpts), traversal-safe.
  - `mandu.docs.get({ slug })` — fetch a single markdown page by
    relative slug. Pairs with `search` for ground-truth answers.

  Both tools are read-only, offline, and add zero new dependencies.

## 0.42.0

### Minor Changes

- [`e56697e`](https://github.com/konamgil/mandu/commit/e56697eaabef2d615f9d637f8b10d152006a0975) Thanks [@konamgil](https://github.com/konamgil)! - feat(ate,mcp): stream run events to eventBus — activity monitor sees ATE flow

  ATE runner now emits six structured events per `mandu.ate.run`
  invocation (`run_start`, `spec_progress`, `spec_done`,
  `failure_captured`, `artifact_saved`, `run_end`) on the
  `@mandujs/core/observability` singleton eventBus. Activity monitor
  subscribes to `type: "ate"` and renders per-spec pass/fail lines,
  `failure.v1` kind summaries, and artifact directory paths in pretty
  mode; JSON mode streams each event verbatim to
  `.mandu/mcp-activity.jsonl` for agent consumption.

  Eliminates the black-box problem where `mandu.ate.run` looked like a
  single opaque tool call in the monitor — agents and humans can now see
  which spec is running, which failed, what kind of failure (selector
  drift / contract mismatch / hydration timeout / ...), and where the
  `trace.zip` landed.

  Also resolves #238 end-to-end:

  - `mandu.ate.run` / `mandu_ate_run` MCP handlers pipe `spec_done`
    events through `notifications/progress` so long runs no longer look
    hung. Accepts an optional `progressToken` from the client;
    gracefully falls back to the ATE `runId` when unset.
  - Timeout / cancel paths now persist a partial `results.json` under
    `.mandu/reports/run-<runId>/` (completed specs + captured failures +
    runId) so `mandu.ate.heal` stays reachable even when Playwright hit
    the 10-min watchdog.

  Core changes:

  - `EventType` union gains `"ate"` as a first-class category so
    observability consumers (SQLite store, Prometheus exporters) can
    scope queries.

  ATE changes:

  - `runSpec()` emits the canonical six-event lifecycle.
  - `artifact-store`'s `writeTextArtifact` / `stageArtifact` emit
    `artifact_saved` on each write.
  - New `AteMonitorEvent` discriminated union exported from
    `@mandujs/ate`.
  - New `emitAteEvent` + typed wrappers (`emitRunStart`, ...) exported
    for downstream emitters.

  MCP changes:

  - `ActivityMonitor` subscribes to `eventBus.on("ate")`, renders pretty
    rows (start / per-spec pass-fail / end + inlined failure kind) and
    emits verbatim JSON lines to `activity.jsonl`.
  - New `ATE-RUN` / `ATE-PASS` / `ATE-FAIL` display tokens in
    `TOOL_ICONS`.
  - `ateRunTools` / `ateTools` accept an optional `Server` instance so
    `notifications/progress` flow through the MCP transport; tests that
    boot without a server gracefully no-op.
  - New `createAteProgressTracker` + `writePartialResults` exports for
    downstream reuse and testing.

  No new runtime dependencies. Typecheck clean across all 7 packages.
  18 new tests (ate: 5, mcp activity-monitor: 3, mcp progress: 5, plus
  existing regression coverage).

## 0.41.2

### Patch Changes

- [`02d5ef2`](https://github.com/konamgil/mandu/commit/02d5ef22f186577f42a13e1081f57754cc4fb617) Thanks [@konamgil](https://github.com/konamgil)! - fix(mcp): #236 clear error when a stale nested @mandujs/core resolves

  When Bun's installer placed `node_modules/@mandujs/mcp/node_modules/@mandujs/core@0.39.0`
  alongside the hoisted top-level `@mandujs/core@0.41.1`, the MCP brain
  handlers crashed with `getCredentialStore is not a function` /
  `undefined is not a constructor` — no hint about where the stale copy
  came from.

  - `@mandujs/core` now exports `__MANDU_CORE_VERSION__`, read at module
    load time directly from the package's own `package.json` so the
    value can never drift from the published version.
  - `@mandujs/mcp` asserts the brain-auth surface (`getCredentialStore`,
    `resolveBrainAdapter`, `ChatGPTAuth`, `AnthropicOAuthAdapter`,
    `revokeConsent`) on every brain MCP call. Missing exports throw with
    the actual version that resolved, an explanation of why it happened
    (Bun nested-install quirk), and the one-line fix
    (`rm -rf node_modules bun.lock && bun install`).

  The underlying Bun install behavior is not fixed here — that's an
  upstream bug / hoisted-linker interaction — but the failure is now
  diagnosable in one error line instead of a cryptic undefined call.

## 0.41.1

### Patch Changes

- [`e73b68d`](https://github.com/konamgil/mandu/commit/e73b68df10bb006a675794a1b4eaec6442fe015e) Thanks [@konamgil](https://github.com/konamgil)! - fix(brain): resolver + status now see ChatGPT session token; MCP login spawns codex directly

  Two bugs landed together:

  1. After `mandu brain login --provider=openai` succeeded the resolver
     still reported `Active tier: ollama`. `resolveBrainAdapter` only
     probed the keychain and ignored `~/.codex/auth.json`. Added
     `probeChatGPTAuth()` hook (checks via `ChatGPTAuth.isAuthenticated`)
     to both the explicit-openai path and the auto-resolve path. CLI
     `brain status` now shows `openai : logged in (ChatGPT session at
...auth.json, managed by @openai/codex)`.

  2. MCP `mandu.brain.login` previously bailed with `{ ok: false,
reason: "not_a_tty" }` because an MCP server has no terminal. But
     Codex CLI itself opens the user's default browser via OS handlers
     (`start` / `open` / `xdg-open`) — a TTY isn't required. Rewrote
     the MCP handler to `spawn('npx @openai/codex login')` as a child
     process, capture stdout for the OAuth URL, and poll for
     `~/.codex/auth.json` up to `waitMs` (default 3 min). Works from
     any MCP client without requiring a `pty` MCP.

  Resolver gets a new `probeChatGPTAuth` option on
  `BrainAdapterConfig` (tests inject a stub returning `{ authenticated:
false, path: null }` so the developer's real auth.json doesn't leak
  into unit-test expectations).

## 0.41.0

### Minor Changes

- [`eea2ff9`](https://github.com/konamgil/mandu/commit/eea2ff982cf210d6d5d6a7eaf06a3667de92ca3d) Thanks [@konamgil](https://github.com/konamgil)! - feat(brain): delegate OpenAI login to `@openai/codex` — real OAuth flow works today

  Earlier the OpenAI adapter shipped with placeholder OAuth endpoints
  (`https://platform.openai.com/oauth/authorize` + a `mandu-brain-cli`
  client id) that were never registered with OpenAI. Nobody could
  actually sign in.

  Fix — piggy-back on the OpenAI-official Codex CLI:

  - `mandu brain login --provider=openai` now shells out to
    `npx @openai/codex login`. OpenAI handles the browser OAuth flow with
    its real app (`app_EMoamEEZ73f0CkXaXp7hrann`) and writes the token
    into `~/.codex/auth.json`. Mandu never has its own OAuth app.
  - New `ChatGPTAuth` helper at `@mandujs/core` reads whatever auth.json
    `codex login` produced (`CHATGPT_LOCAL_HOME` / `CODEX_HOME` /
    `~/.chatgpt-local/auth.json` / `~/.codex/auth.json`, in order), auto-
    refreshes the access token against `auth.openai.com/oauth/token`
    5 minutes before JWT `exp`, and rewrites auth.json atomically with
    mode 0600.
  - `OpenAIOAuthAdapter` now calls `ChatGPTAuth` first; the legacy
    keychain path is preserved as a fallback for enterprise OpenAI
    proxies that wire their own OAuth app.
  - 401 from the Chat Completions endpoint triggers one `ChatGPTAuth
.getAuth()` re-read (which refreshes if needed); persistent 401 on
    the ChatGPT path intentionally does NOT scrub auth.json (we must
    not race the user's codex session). The keychain fallback keeps its
    scrub-on-persistent-401 behavior.

  Ported from the same pattern kakao-bot-sdk uses in
  `src/auth/chatgpt.ts` — the approach is proven in production there.

  8 new tests covering JWT parsing, expiry-driven refresh, missing-token
  error shapes, and disk persistence.

## 0.40.1

### Patch Changes

- [`ad15ebf`](https://github.com/konamgil/mandu/commit/ad15ebf17b88c63d4b4b57addb7ca5a847b37b5e) Thanks [@konamgil](https://github.com/konamgil)! - fix(brain/openai): default model gpt-4o-mini → gpt-5.4

  The original OpenAI adapter shipped with `gpt-4o-mini` as a
  cost/quality compromise, but the whole point of moving brain off the
  local `ministral-3:3b` adapter was to get quality-tier suggestions.
  Current-generation flagship (`gpt-5.4`) is the correct default;
  `ManduConfig.brain.openai.model` still lets users drop to a cheaper
  tier for low-stakes automated runs.

## 0.40.0

### Minor Changes

- [`6ded2af`](https://github.com/konamgil/mandu/commit/6ded2af0bed3eaec90aafa0e0d7b077099d07ecc) Thanks [@konamgil](https://github.com/konamgil)! - #235 brain OAuth adapters (OpenAI + Anthropic)

  Adds two new LLM adapters to `@mandujs/core/brain` that use the user's
  own OAuth credentials — Mandu stays a connector, never owns API keys or
  billing.

  - OpenAI OAuth adapter (default model `gpt-4o-mini`)
  - Anthropic OAuth adapter (default model `claude-haiku-4-5-20251001`)
  - Auto-detect resolver order: openai → anthropic → ollama → template
  - OS keychain storage (`security` on macOS / `secret-tool` on Linux /
    `0600` filesystem fallback on Windows + everywhere else). No `keytar`
    dependency.
  - `mandu brain login` / `logout` / `status` CLI subcommands
  - `ManduConfig.brain = { adapter, openai, anthropic, ollama, telemetryOptOut }`
  - Privacy: first-use consent prompt (cached per-provider / per-project
    at `~/.mandu/brain-consent.json`), per-request secret redactor (API
    keys, Bearer tokens, `.env` refs, JWTs), audit log at
    `.mandu/brain-redactions.jsonl`

  `telemetryOptOut: true` keeps everything local (resolver falls to
  ollama / template regardless of stored tokens).

  No breaking change: existing configs without a `brain` block behave as
  `adapter: 'auto'`. Existing `mandu brain setup` / `mandu brain status`
  paths remain available.

## 0.39.3

### Patch Changes

- [`8419ae1`](https://github.com/konamgil/mandu/commit/8419ae15a83180301383f995e36f42ed328de6ee) Thanks [@konamgil](https://github.com/konamgil)! - fix(core/spa-nav): #233 cross-layout transitions fall back to hardNav

  SPA navigation's `<main>.innerHTML` swap left the source layout chrome
  (e.g. docs `<aside>` sidebar) intact when moving between pages that
  use different layout trees — home ↔ docs, home ↔ dashboard, etc. —
  producing a visually broken page until the user pressed F5.

  Fix — the SSR shell now stamps `data-mandu-layout="<hash>"` on
  `<div id="root">`, derived from the active `layoutChain`. The SPA
  helper compares the current DOM's key against the parsed destination
  key inside `doSwap`; mismatched keys abort the soft swap and run a
  real `location.href = url` hard navigation.

  Same-layout transitions (e.g. `/blog/a` → `/blog/b`) keep the cheap
  swap. Pages without a layout chain omit the attribute entirely, which
  the helper treats as a wildcard match (no regression).

  Stamped on both the non-streaming path (`ssr.ts::renderToHTML`) and
  the streaming shell (`streaming-ssr.ts::generateHTMLShell`) so the
  heuristic works regardless of render mode.

  3 new regression guard tests in `spa-nav-body-swap.test.ts` ensure
  the `data-mandu-layout` attribute, the "cross-layout transition"
  fallback reason string, and the key-compare block all stay in the
  minified helper body.

## 0.39.2

### Patch Changes

- [`49353c7`](https://github.com/konamgil/mandu/commit/49353c70415c31fec1501bb39c16652dce47f80a) Thanks [@konamgil](https://github.com/konamgil)! - fix(core,cli): #232 follow-up — eager page-component registration

  The initial #232 fix (dev server bypasses the prerender cache) unmasked
  a latent lazy-registration race: `registerPageHandler` /
  `registerPageLoader` only install thunks at HMR reload time; the actual
  page component is registered inside `routeComponents` when the first
  request triggers `loadPageData`. If the HMR-broadcast reload hits any
  code path that reaches `createDefaultAppFactory` before the lazy
  import completes, the fallback "404 - Route Not Found" renders even
  for perfectly valid routes (e.g. `[lang]/page.tsx` with a slot module).

  Previously, the prerender cache short-circuit masked this path — users
  never saw the 404 because the prerendered HTML was served instead.

  Fix: a new `prewarmPageRoutes(registry?)` public helper iterates every
  registered pageHandler / pageLoader and drives it through the same
  import + `registerRouteComponent` that the first request would. The
  CLI dev command invokes it at every registration site:

  - initial boot (`mandu dev`)
  - SSR change rebuild
  - API change re-register
  - route manifest watcher
  - full `restartDevServer`

  Prewarm failures log a per-route warning but do not block the reload —
  a single broken file stays broken while healthy routes keep serving.
  Production `mandu start` is unaffected (no HMR, no reload race).

## 0.39.1

### Patch Changes

- [`b13bfee`](https://github.com/konamgil/mandu/commit/b13bfeee9a2ce682cd71e99e5db89f701dfe557f) Thanks [@konamgil](https://github.com/konamgil)! - fix(core/runtime): #232 dev server bypasses prerendered HTML cache

  `mandu dev` now skips the `.mandu/prerendered/` short-circuit in
  `runtime/server.ts` entirely. Previously, a project that had run
  `mandu build` left prerendered HTML on disk; the dev server kept
  serving that stale HTML (`X-Mandu-Cache: PRERENDERED`) even after
  the user edited source files and HMR issued a "full reload" signal.
  The browser would reload, hit the cached path, and see the old page.

  In dev, freshness beats caching — SSR runs on every request. The
  prerender fast path still fires in production (`mandu start` uses
  `isDev: false`), so prod behavior is unchanged.

  Test coverage:

  - New "Issue #232 — dev mode bypasses prerendered cache" describe block.
  - Regression guard: production still serves PRERENDERED + production
    Cache-Control policy intact (all existing #221 tests pass).

## 0.39.0

### Minor Changes

- [`e77b035`](https://github.com/konamgil/mandu/commit/e77b035dd28cc256a596fe5221f781c5609645e9) Thanks [@konamgil](https://github.com/konamgil)! - feat(core,ate,mcp,cli): Phase C — primitives + mutation + RPC + oracle

  Ships ATE v2 Phase C (docs/ate/phase-c-spec.md, 364-line spec):

  - 5 Mandu-specific assertion primitives in @mandujs/core/testing:
    expectContract(strict/loose/drift-tolerant), expectNavigation,
    waitForIsland (data-hydrated polling), assertStreamBoundary
    (<!--$--> marker count + shell budget), expectSemantic
    (agent-delegated, CI non-blocking).
  - 9 contract-semantic mutation operators (remove_required_field,
    narrow_type, widen_enum, flip_nullable, rename_field,
    swap_sibling_type, skip_middleware, early_return,
    bypass_validation). runner writes tmpdir, kills/survives/timeout
    classification. mutationScore + severity report via
    mandu_ate_mutate + mandu_ate_mutation_report.
  - RPC parity: defineRpc extractor emits rpc_procedure nodes,
    context scope "rpc" with dot-notation id, boundary probe works
    automatically on input schemas.
  - Oracle queue: .mandu/ate-oracle-queue.jsonl, mandu_ate_oracle_pending /
    verdict / replay. Semantic judgments deferred to agent session,
    deterministic CI never blocked. promoteVerdicts regresses past
    fails on next run.
  - Prompt catalog +3: island_hydration, streaming_ssr, rpc_procedure.

  Test counts: ate 575 / mcp 220. Typecheck clean across 7 packages.
  ATE v2 core surface complete.

## 0.37.0

### Minor Changes

- [`8e53ca0`](https://github.com/konamgil/mandu/commit/8e53ca007cd588ce3cba0866222f5eb1982d01bd) Thanks [@konamgil](https://github.com/konamgil)! - fix(core,cli): #223 dual-stack default + #225 truthful startup banner

  **#223 — Default `server.hostname` is now `"::"` (IPv6 wildcard,
  dual-stack) instead of `"0.0.0.0"` (IPv4-only).** Bun leaves
  `IPV6_V6ONLY` off, so a single socket accepts both IPv4 (as
  IPv4-mapped IPv6) and IPv6 clients — effectively covering what users
  expected `"0.0.0.0"` to do. This silently fixes the Windows trap where
  Node 17+ `fetch("http://localhost:PORT")` resolves `localhost` to
  `::1` first and hit `ECONNREFUSED ::1:PORT` against an IPv4-only
  bind. `curl` and browsers silently fell back to IPv4, hiding the bug
  until a Node client (Playwright test runner, ATE-generated specs)
  tried to reach the server.

  Explicit `"0.0.0.0"` is still honored — users who need IPv4-only
  binds for container/firewall reasons keep that option. On Windows
  only, Mandu emits a one-line warning so the IPv6-localhost trap is
  discoverable:

  ```
  ⚠️  hostname="0.0.0.0" binds IPv4 only; Node fetch('localhost:PORT')
     may fail on Windows (prefers ::1). Consider hostname="::" for
     dual-stack.
  ```

  **#225 — The startup banner no longer lies about reachability.** The
  old code unconditionally printed

  ```
  🥟 Mandu server listening at http://localhost:3333
     (also reachable at http://127.0.0.1:3333, http://[::1]:3333)
  ```

  regardless of the actual bind address. When bound to `"0.0.0.0"` the
  `[::1]` URL never answered. The new `reachableHosts(hostname)` helper
  (exported from `@mandujs/core`) derives the URL list deterministically
  from the bind address:

  - `"0.0.0.0"` → `["127.0.0.1"]` only.
  - `"::"` / `"::0"` / `"[::]"` / `"0:0:0:0:0:0:0:0"` →
    `["127.0.0.1", "[::1]"]`.
  - `"::1"` / `"127.0.0.1"` / a specific IP → just that address.
  - DNS name → just that name.

  `formatServerAddresses()` consumes `reachableHosts()` so both the
  `startServer` banner and the `mandu start` / `mandu dev` CLI banners
  only promise addresses that actually answer.

  No new dependencies. Docker setups that pin `hostname: "0.0.0.0"`
  (explicit) are not silently upgraded.

## 0.36.0

### Minor Changes

- [`88d597a`](https://github.com/konamgil/mandu/commit/88d597ad50d5ac219e68f458e746f4f649de2c50) Thanks [@konamgil](https://github.com/konamgil)! - feat(openapi): hoist shared schemas into `components.schemas` with `$ref`

  The OpenAPI generator now performs a post-processing pass that detects
  structurally-identical object schemas appearing in two or more
  requestBody/response sites and hoists them into `components.schemas`,
  replacing inline usage with a `$ref` pointer. Result: smaller specs,
  deduplicated codegen output.

  Behavior:

  - Only `type: "object"` schemas with at least one property are hoisted;
    primitives, enums, and unions of primitives stay inline.
  - Parameter schemas (path/query/header) are never hoisted.
  - Names are derived from `contract.name` (falling back to the route id)
    with method/status qualification. Structurally-different schemas that
    would collide on name get deterministic `_v2` / `_v3` suffixes.
  - Hint-less schemas fall back to `Schema_<first-8-hex-of-hash>`.

  New generator options (both optional, on by default):

  - `hoistSchemas: boolean` (default `true`) — set to `false` to restore
    the previous fully-inline output.
  - `hoistThreshold: number` (default `2`, clamps to a minimum of `2`) —
    minimum occurrence count required to hoist.

  A new `hoistSharedSchemas(doc, options?)` helper is exported for
  callers who want to run the pass against a hand-built document.

  Note: projects with shared schemas will see a new `components.schemas`
  section in their spec, which changes the SHA-256 ETag served by the
  runtime OpenAPI endpoint. This is intentional.

## 0.35.1

### Patch Changes

- [`5e68c57`](https://github.com/konamgil/mandu/commit/5e68c57565b5bfb611d781e445025e05e8288d2e) Thanks [@konamgil](https://github.com/konamgil)! - fix(core/openapi): Zod optional no longer marked nullable

  `z.string().optional()` was emitting `nullable: true` in the OpenAPI
  spec, which conflated "may be absent" with "may literally be null" and
  broke Postman / codegen / Swagger UI imports of Mandu-generated specs.

  Optionality is now correctly expressed via the parent object's
  `required[]` array (or `parameter.required: false`), and `nullable` is
  reserved for `.nullable()` chains. `.nullable().optional()` still emits
  `nullable: true` on the inner schema as expected.

## 0.35.0

### Minor Changes

- [`5c9bac1`](https://github.com/konamgil/mandu/commit/5c9bac1afd3d769ec5889ec5ac65b6d587ff9f51) Thanks [@konamgil](https://github.com/konamgil)! - feat(core,cli): production-grade OpenAPI endpoint (opt-in, ETag'd)

  - `mandu build` now emits `.mandu/openapi.json` + `.mandu/openapi.yaml`
    whenever any route carries a `contractModule`.
  - New `ManduConfig.openapi: { enabled?, path? }` block exposes the spec
    at `/__mandu/openapi.json` / `.yaml` (default-off). Opt-in via config
    or `MANDU_OPENAPI_ENABLED=1`.
  - Response carries `Cache-Control: public, max-age=0, must-revalidate`
    - a SHA-256 ETag; `If-None-Match` short-circuits with 304.
  - Replaced the naive regex YAML converter with a conservative YAML 1.2
    subset emitter (stable round-trip through Swagger UI / yq / codegen).
  - Kitchen's dev endpoint (`/__kitchen/api/contracts/openapi*`) and the
    new prod endpoint share the same generator module.
  - Docs: `docs/runtime/openapi.md`.

## 0.34.2

### Patch Changes

- fix(core): #222 — preserve hash anchor target after SPA body swap.
  `window.scrollTo(0, 0)` unconditional call was clobbering hash anchors
  (`<a href="/docs#section">` 가 `#section` 대신 top으로 스크롤). 이제
  `extractHash(url)` + `document.getElementById` + `[name=]` fallback +
  `CSS.escape` 기반 `scrollIntoView`. Fragment-only 같은 페이지 링크는
  fetch 없이 pushState + scroll 만. 9 regression tests, 2466 B gz
  (budget 3072).

## 0.34.1

### Patch Changes

- fix(core): resolve #221 — prerendered HTML Cache-Control + ETag
  revalidation. 같은 패턴 재발 (#218 `/.mandu/client/*` fix 이후 prerender
  HTML 경로는 그대로 `immutable`). `tryServePrerendered()` 가 #218 helper
  (`computeStaticCacheControl` / `computeStrongEtag` / `matchesEtag`) 재사용,
  기본 policy `public, max-age=0, must-revalidate` + strong ETag +
  `If-None-Match` 304. 사용자 `PrerenderSettings.cacheControl` override
  우선. 13 regression tests.

## 0.34.0

### Minor Changes

- Phase 18 Wave E7 — 본연 주변 primitives 완결.

  **φ Bundle size budget** — `ManduConfig.build.budget` per-island + total raw/gz caps, mode `'error'|'warning'`, `mandu build --no-budget` bypass, analyzer HTML에 budget bar inline.

  **χ Accessibility audit** (`@mandujs/core/a11y`) — `mandu build --audit` axe-core 실행, optional peerDep (axe-core/jsdom/happy-dom 없으면 graceful skip), 25+ rule fix-hints, `--audit-fail-on=<impact>` 게이트.

  **ψ Perf marks dev API** — `time()` / `timeAsync()` / `createPerf()` zero-overhead disabled path + OTel span 자동 생성 + `/_mandu/heap` histogram (p50/p95/p99, LRU 1000).

  +61 regression tests, 7 packages typecheck clean, zero new runtime deps.

## 0.33.1

### Patch Changes

- fix: #213/#216 prerender + #217 silent + #218 Cache-Control + #219
  asset crawl + #220 SPA-nav swap.

  - **#213** crawler strips code regions (pre/code/fenced/inline/comment)
    - DEFAULT_CRAWL_DENYLIST (`/path`, `/example`, `/your-*`)
  - **#216** PrerenderError distinguishes missing export vs user throw;
    `--prerender-skip-errors` flag
  - **#217** `ServerOptions.silent` suppresses transient prerender banner
    during `mandu build`
  - **#218** Hash-aware Cache-Control + strong ETag for
    `/.mandu/client/*` (stable URL → `must-revalidate`, hashed URL →
    `immutable`)
  - **#219** `DEFAULT_ASSET_EXTENSIONS` (25 img/font/doc/media/text)
    filters `/hero.webp`/`/doc.pdf` from crawler + `build.crawl.
assetExtensions` override
  - **#220** SPA-nav body swap: logs every failure path with
    `[mandu-spa-nav]` prefix, selector cascade `main → #root → body`,
    script re-execution via `document.createElement`,
    `__MANDU_SPA_NAV__` CustomEvent, hard-nav fallback on all failures

  Quality: 7 packages typecheck clean, +100 regression tests, zero new
  runtime deps.

## 0.33.0

### Minor Changes

- Phase 18 Wave E6 + #214/#215.

  **π Guard dependency graph** — `mandu guard --graph` → `.mandu/guard/graph.html` (self-contained SVG, dark theme, click-to-drill, XSS-safe).

  **σ Test convergence** — `@mandujs/core/testing/reporter` (human/JSON/JUnit/lcov formats), `--reporter` CLI flag, per-metric coverage thresholds enforcement, unified watch-mode UX.

  **τ Plugin API 강화** — 7 new hook types (`onRouteRegistered`, `onManifestBuilt`, `definePrerenderHook`, `defineBundlerPlugin`, `defineMiddlewareChain`, `defineTestTransform`, `onBundleComplete`) + `definePlugin()` helper + 3 example plugins.

  **#214 dynamicParams route guard** — `export const dynamicParams = false` forces 404 on params outside `generateStaticParams` result (Next.js parity).

  **#215 diagnose 보강** — 5 new checks (`manifest_freshness`, `prerender_pollution`, `cloneelement_warnings`, `dev_artifacts_in_prod`, `package_export_gaps`) + new `mandu diagnose` CLI + MCP unified shape.

  Quality: 7 packages typecheck clean, +195 regression tests, zero new deps.

## 0.32.0

### Minor Changes

- Phase 18 Wave E5 + #211/#212 hotfixes.

  **μ i18n framework-level** (`@mandujs/core/i18n`) — `defineI18n({ locales, defaultLocale, strategy })` 4 strategies (path-prefix/domain/header/cookie), 자동 route synthesis, `ctx.locale`/`ctx.t` 타입드 헬퍼, Vary/Content-Language 헤더, 307 redirect.

  **ν defineGuardRule API** (`@mandujs/core/guard/define-rule` + `rule-presets`) — consumer custom guard rule + 3 presets (`forbidImport`, `requireNamedExport`, `requirePrefixForExports`).

  **ξ Streaming SSR + React.use()** — `resolveAsyncElement` streaming 경로 serialize 버그 fix: TTFB 250ms → 10ms (25×). `loading.tsx` Suspense streams 검증. React 19 `use(promise)` 지원.

  **#212** — `cloneElement` array 전달로 인한 spurious "missing key" 경고 fix (spread 로 variadic).

  **#211** — `mandu start` stale/dev/empty manifest silent accept fix.

  Quality: 7 packages typecheck clean, +208 new regression tests, zero
  new runtime deps.

## 0.31.0

### Minor Changes

- Phase 18 Wave E3+E4 — Mandu 차별화 레이어 완성.

  **ι AI refactor MCP tools** (`@mandujs/mcp`):

  - `mandu.refactor.rewrite_generated_barrel` — `__generated__/*` → `getGenerated()` + `GeneratedRegistry` augmentation
  - `mandu.refactor.migrate_route_conventions` — 인라인 Suspense/ErrorBoundary/NotFound → per-route convention files
  - `mandu.refactor.extract_contract` — 인라인 Zod 스키마 → `contract/<group>.contract.ts`

  **κ Typed RPC** (`@mandujs/core`):

  - `defineRpc({ method: { input, output, handler } })` + `createRpcClient<typeof rpc>()` Proxy 기반 end-to-end type inference. Zod 검증. tRPC 의존 없음.

  **λ Bun.cron scheduler** (`@mandujs/core` + `@mandujs/cli`):

  - `defineCron({ name, schedule, timezone, runOn, handler })` Bun.cron 기반
  - `mandu build --target=workers` 시 `[triggers] crons = [...]` 자동 emission
  - Cron 표현식 + timezone Intl 검증

  Quality: 7 packages typecheck clean, +132 regression tests, zero new
  runtime deps.

## 0.30.0

### Minor Changes

- Phase 18 Wave E2 — runtime depth (ISR + bundle analyzer + OTel tracing).

  **ζ ISR + cache tags** — filling loader가 `{ _cache: { tags, maxAge, staleWhileRevalidate } }` 반환 or `ctx.cache.tag('x').maxAge(10).swr(3600)` fluent API. `revalidate(tag)` tag-based invalidation. `Cache-Control` + `X-Mandu-Cache` 헤더 자동. Next.js ISR parity.

  **η Bundle analyzer** — `mandu build --analyze` → `.mandu/analyze/report.html` (self-contained SVG treemap, dark theme, click-to-drill) + `report.json`. Per-island raw+gz, shared chunk dedupe detection, top-20 heaviest modules. 외부 dep 없음.

  **θ Request tracing** — W3C Trace Context + AsyncLocalStorage propagation, Console + OTLP HTTP exporters. `ctx.span` + `ctx.startSpan(name, fn)` filling integration. Hand-rolled OTLP JSON encoding (opentelemetry-js dep 없음). Honeycomb / Jaeger / Tempo 호환.

  Quality: 7 packages typecheck clean, +84 regression tests, zero new
  runtime deps.

## 0.29.1

### Patch Changes

- fix: resolve #210 — `./bundler/plugins` + 6 sibling subpath exports for
  Wave E1 new modules (bundler/generate-static-params, dev-error-overlay,
  middleware/compose|define|bridge, client/hydrate). 같은 패턴 3회차
  (#194 kitchen / #202 content/prebuild 에 이어).

## 0.29.0

### Minor Changes

- Phase 18 Wave E1 — convention parity with Next.js / Astro / SvelteKit
  (5 orthogonal capabilities, 210+ regression tests).

  **α Dev Error Overlay** — 풀스크린 dev 에러 UI (`@mandujs/core/dev-error-overlay`). SSR + client 에러 양쪽, 4.4 KB gz client IIFE, 500-response에도 payload 임베드. Config `dev.errorOverlay` (default `true`, prod 3중 gate).

  **β Route conventions** — `app/<route>/{loading,error,not-found}.tsx` per-route + `(group)/` route groups + `[[...slug]]` optional catch-all. 런타임이 page를 `Suspense(loading)` + `ErrorBoundary(error)` 로 자동 감싸고, 404는 nearest-ancestor `not-found.tsx` 우선.

  **γ generateStaticParams** — Next.js-style build-time SSG. `.mandu/prerendered/` + `_manifest.json`, path-traversal-safe, 런타임 첫 dispatch check에서 `Cache-Control: immutable`로 serve. Nested dynamic / catch-all / optional catch-all 전부 지원.

  **δ Hydration strategy per-island** — `data-hydrate="load|idle|visible|interaction|media(<query>)"` 선언 spec. 1.07 KB gz runtime, public disposer contract, Astro parity + `interaction` 은 Mandu 고유.

  **ε Middleware composition API** — `defineMiddleware({ name, match?, handler })` + `compose(...)`. Onion model, short-circuit, error propagation, `ManduConfig.middleware[]` config. 기존 csrf/session/secure/rate-limit bridge adapter로 backward compat.

  Quality: 7 packages typecheck clean, 3211 core pass / 0 fail, 210+ new
  tests, zero new runtime deps.

## 0.28.0

### Minor Changes

- feat(core,cli): hard-fail `__generated__/` imports at bundler level.

  `mandu dev` / `mandu build` / `mandu start` 는 이제 bundler plugin
  레이어에서 직접 `__generated__/` import를 감지하면 번들링 자체를
  실패시킵니다. Guard rule만으로 부족했던 agent bypass 패턴의 원천 차단.

  에러 메시지는 importer 파일 경로 + `getGenerated()` 사용 예시 +
  docs URL을 포함합니다. `@mandujs/core/runtime` 내부 `__generated__`
  접근은 기본 allowlist로 제외됩니다.

  - `packages/core/src/bundler/plugins/block-generated-imports.ts` 신규
  - `defaultBundlerPlugins(config)` 헬퍼 — 단일 설치 포인트
  - `safeBuild` 6개 callsite + CLI SSR bundler 경로 자동 장착
  - `ManduConfig.guard.blockGeneratedImport` (Zod, default `true`) opt-out
  - `MANDU_DISABLE_BUNDLER_PLUGINS=1` 비상 탈출구
  - `mandu init` 3개 템플릿 `tsconfig.json` paths 봉쇄 (IDE defense)
  - 마이그레이션 가이드 `docs/migration/0.28-generated-block.md`
  - `docs/architect/generated-access.md` Enforcement 섹션 추가

  18 regression tests (15 unit + 3 integration). No new runtime deps.

## 0.27.0

### Minor Changes

- fix: #207 view-transition injection hardening + #208 inline SPA-nav
  helper for `hydration: "none"` projects.

  - **#207**: No code defect; `@view-transition` CSS was already injected
    across all SSR paths. Locked it down with 12-case regression suite
    covering streaming SSR / prerender / 404 / error / opt-out.
  - **#208**: Genuine defect. `ssr.spa: true` was documented default but
    intercept lived in client bundle that `hydration: "none"` projects
    never ship. New `client/spa-nav-helper.ts` inline IIFE (~2.7 KB)
    injected into `<head>` alongside the prefetch helper. Full 10-case
    exclusion parity with `handleLinkClick`. pushState + fetch +
    View-Transitions DOM-swap. Early-exits when full router present so
    hydrated pages unaffected.

  Wired through `ServerOptions.spa` to all 5 renderSSR/
  renderStreamingResponse call-sites. CLI dev + start pass `config.spa`.

  +66 regression tests (12 #207 + 54 #208). No new runtime deps.

## 0.26.0

### Minor Changes

- content + routes follow-ups (Closes #204, #205, #206):

  - **#204** — `Collection.all()/get()/getCompiled()` guaranteed
    watcher-free. Script chains exit cleanly. Watching via
    `collection.watch(cb)` opt-in. `dispose()` + `Symbol.asyncDispose`.
  - **#205** — `generateSidebar` reads `_meta.json` (title/icon/order/
    pages[]). New `generateCategoryTree`. `generateLLMSTxt` baseUrl +
    groupByCategory. `getCompiled` accepts `CompileOptions` (remark/
    rehype plugins + silent).
  - **#206** — Metadata Routes auto-discovery: `app/sitemap.ts`,
    `app/robots.ts`, `app/llms.txt.ts`, `app/manifest.ts` →
    `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/manifest.webmanifest`.
    New `@mandujs/core/routes` export with typed contracts + dispatcher.
    Default `Cache-Control: public, max-age=3600`.

  No new runtime deps. Existing `renderSitemap`/`renderRobots` helpers
  and `public/*.xml` workflow remain untouched (auto-discovery is
  additive). `app/` > `public/` precedence with warning.

  +74 regression tests. 7 packages typecheck clean.

## 0.25.3

### Patch Changes

- fix: resolve #203 — configurable prebuild timeout + preserve inner errors.

  - `mandu.config.ts` `dev.prebuildTimeoutMs` (default 120_000 ms) +
    `MANDU_PREBUILD_TIMEOUT_MS` env override.
  - New `PrebuildTimeoutError` (subclass of `PrebuildError`) names the
    failing script + limit + both override paths.
  - Inner error message + stack preserved via `.cause`. No more opaque
    "non-Error thrown" surface.
  - stdout/stderr tail (last 10 lines each) appended to
    `PrebuildError.message` on non-zero exit.
  - CLI `mandu dev` prints `err.message` + `cause.stack` on abort.

## 0.25.2

### Patch Changes

- fix: resolve #202 — add `./content/prebuild` + sibling subpath exports
  (collection / sidebar / slug / llms-txt / schema). Same pattern as #194
  kitchen export. `mandu dev` no longer fails with "Cannot find module
  '@mandujs/core/content/prebuild'".

## 0.25.1

### Patch Changes

- fix(runtime): DX-1 — loud 5xx for malformed page default exports.
  `export default function Page()` now works (bare function auto-wrapped).
  Missing / primitive / non-function default surfaces a clear error with
  route id + pattern instead of a silent 404.

## 0.25.0

### Minor Changes

- Wave D — 8 GitHub issues + Phase 17 memory/observability:

  - **#193 (BREAKING)** — SPA navigation is opt-out by default. Plain
    `<a href="/about">` now triggers client-side nav with View
    Transitions. Opt-out per link: `data-no-spa`. Opt-out global:
    `mandu.config.ts` `spa: false`. Legacy `data-mandu-link` still works.

  - **#194** — `@mandujs/core` exports map exposes `./kitchen` so
    `@mandujs/mcp` can import `computeAgentStats`.

  - **#195** — `mandu dev` prints a synchronous boot banner before any
    `await`, so a hang is always observable. `MANDU_DEBUG_BOOT=1` emits
    a phase trace.

  - **#196** — `mandu dev` auto-discovers and runs `scripts/prebuild-*.
{ts,tsx,js,mjs}` before serving. In watch mode, `content/` changes
    re-execute prebuild (500ms debounced) and broadcast HMR reload.
    Opt-out: `dev.autoPrebuild: false`.

  - **#197** — `@mandujs/skills` now writes every skill as
    `.claude/skills/<name>/SKILL.md` (Claude Code spec). All three
    installer paths (dev, CLI binary mode, per-project generator)
    corrected.

  - **#198** — SSR resolves `async function` components. `export default
async function Page()` / async layouts / async generateMetadata work.
    4 callsites pre-resolve via `resolveAsyncElement()`.

  - **#199 (MVP)** — `@mandujs/core/content`: `defineCollection`,
    frontmatter parser (no new runtime deps), `slugFromPath`,
    `generateSidebar`, `generateLLMSTxt`, content-types.d.ts emitter.
    Legacy `defineCollection({ loader })` preserved.

  - **#200** — runtime registry: `getGenerated`, `getManifest`,
    `registerManifest` at `@mandujs/core/runtime`. Guard
    `INVALID_GENERATED_IMPORT` message now points at
    `mandujs.com/docs/architect/generated-access`.

  - **Phase 17** — bounded LRU (patternCache/fetchCache/perFileTimers),
    `/_mandu/heap` + `/_mandu/metrics` endpoints (dev auto-on, prod
    gated), MCP heap heartbeat, long-run smoke harness.

  Quality: 6 packages typecheck clean, 200+ new regression tests, zero
  new runtime deps.

## 0.24.0

### Minor Changes

- Wave C — GitHub issue closures + R3 Low hardening + flake fixes:

  - **Issue #190** — `mandu dev/start` default hostname `0.0.0.0` (IPv4
    dual-stack). Fixes Windows `localhost` IPv4-resolve dead-page. Log
    now prints `http://localhost:PORT (also reachable at 127.0.0.1, [::1])`.

  - **Issue #191** — `_devtools.js` injected only when
    `bundleManifest.hasIslands === true`. Opt-in/out via
    `ManduConfig.dev.devtools`. URL gets `?v=<buildTime>` cache-bust +
    dev static `Cache-Control: no-cache, no-store, must-revalidate` so
    stale-bundle after HMR is impossible.

  - **Issue #192** — Zero-config smooth navigation: `@view-transition`
    CSS + ~500B hover prefetch IIFE auto-injected. Opt-out via
    `ManduConfig.transitions`/`prefetch` (default `true`) or per-link
    `data-no-prefetch`. Follow-up #193 tracks opt-in→opt-out SPA nav
    reversal (breaking change, deferred).

  - **Issue #189** — Transitive ESM cache: reverse-import-graph
    invalidation. Change a deep file → HMR now invalidates every
    transitive importer (barrel + static-map, deep re-export chain,
    singleton). Depth-capped BFS + HMR log shows invalidated count.

  - **R3 Low hardening** — AI chat `/save|/load|/system` containment
    under `./.mandu/ai-chat/`; skills generator `--out-dir` project-root
    guard; Workers `ctx` AsyncLocalStorage; Edge 500 body scrub in prod;
    `@mandujs/skills/loop-closure` subpath exports.

  - **DX** — Per-subcommand `--help` routing (8 commands); changeset
    CHANGELOG auto-update wired.

  - **Flake fixes** — dbPlan/dbApply path resolution; precommitCheck
    ts-morph pre-warm + 15s Windows ceiling; safe-build handoff-race.

  Quality: 6 packages typecheck clean, 97+ new tests, no new runtime
  deps, no production-code regressions.

## 0.14.0

### Minor Changes

- ATE Production Release v0.16.0

  ## 🎉 Major Features

  ### New Package: @mandujs/ate

  - **Automation Test Engine** - Complete E2E testing automation pipeline
  - Extract → Generate → Run → Report → Heal workflow
  - 195 tests, 100% pass rate

  ### ATE Core Features

  - **Trace Parser & Auto-Healing**: Playwright trace 분석 및 자동 복구
  - **Import Dependency Graph**: TypeScript 의존성 분석 (ts-morph 기반)
  - **Domain-Aware Assertions**: 5가지 도메인 자동 감지 (ecommerce, blog, dashboard, auth, generic)
  - **Selector Fallback System**: 4단계 fallback chain (mandu-id → text → class → role → xpath)
  - **Impact Analysis**: Git diff 기반 subset 테스트 자동 선택

  ### Performance Optimizations

  - **ts-morph Lazy Loading**: Dynamic import로 초기 로드 70% 감소
  - **Tree-shaking**: sideEffects: false 설정
  - **Bundle Size**: 최적화 완료

  ### Documentation

  - 2,243 lines 완전한 문서화
  - README.md (1,034 lines)
  - architecture.md (778 lines)
  - 8개 사용 예제

  ### Testing

  - 195 tests / 503 assertions
  - 13개 테스트 파일
  - 단위/통합 테스트 완비

  ### Error Handling

  - ATEFileError 커스텀 에러 클래스
  - 모든 file I/O에 try-catch
  - Graceful degradation
  - 한국어 에러 메시지

  ## 🔧 MCP Integration

  - 6개 ATE 도구 추가 (mandu.ate.\*)
  - extract, generate, run, report, heal, impact

  ## 📦 Breaking Changes

  None - 모든 기존 API 유지

  ## 🙏 Credits

  Developed by ate-production-team:

  - heal-expert: Trace parser, Error handling
  - impact-expert: Dependency graph
  - oracle-expert: Oracle L1 assertions
  - selector-expert: Selector fallback map
  - doc-expert: Documentation, Testing
  - bundle-optimizer: Performance optimization

## 0.13.2

### Patch Changes

- SSE reconnect improvements and critical bug fixes

  ## @mandujs/core

  - **Feature**: SSE reconnect with exponential backoff and jitter
  - **Feature**: Connection state tracking (connecting, connected, reconnecting, failed, closed)
  - **Fix**: Critical race condition in SSE snapshot/fetchChatHistory

  ## @mandujs/cli

  - **Template**: Add SSE reconnect logic to realtime-chat template
  - **Template**: Fix race condition in chat initialization
  - **Template**: Improve type clarity with ReconnectOptions alias
  - **Docs**: Add demo-first validation loop guide
  - **Docs**: Update CLI command examples

## 0.13.1

### Patch Changes

- Security and stability improvements

  ## @mandujs/core

  - **Security**: Fix rate limiting DoS vulnerability - prevent single user from blocking all users
  - **Fix**: Prevent SSE event ordering race condition in subscribeWithSnapshot
  - **Test**: Add comprehensive SSE stream integration tests

  ## @mandujs/cli

  - **Refactor**: Deduplicate lockfile validation flow in dev/start commands
  - **Fix**: Remove magic numbers in backup suffix retry logic
  - **Template**: Add SSE reconnect strategy with exponential backoff
  - **Template**: Add ARIA labels for accessibility (WCAG 2.1 AA)
  - **Template**: Improve error feedback in realtime-chat and ai-chat
  - **Template**: Optimize Date object creation in message rendering

## 0.13.0

### Minor Changes

- feat: manifest를 generated artifact로 전환 (Option D)

  - `spec/routes.manifest.json` → `.mandu/routes.manifest.json` (generated artifact)
  - `spec/spec.lock.json` → `.mandu/spec.lock.json`
  - `app/` (FS Routes)가 유일한 라우트 소스
  - legacy merge 로직 제거, auto-linking 추가
  - MCP tools FS Routes 기반으로 재작성

## 0.12.2

### Patch Changes

- fix: publish 스크립트를 bun publish로 변경하여 workspace:\* 의존성 자동 변환

## 0.12.1

### Patch Changes

- chore: change license from MIT to MPL-2.0 and fix workspace dependency
