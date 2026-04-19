---
title: "Testing — E2E (Playwright via ATE)"
status: phase-12.2
audience: Mandu app authors
bun_version: "1.3.12"
related:
  - packages/cli/src/commands/test.ts
  - packages/ate/src/e2e-codegen.ts
  - packages/ate/src/e2e-runner.ts
  - docs/testing/getting-started.md
---

# E2E Tests with `mandu test --e2e`

`mandu test --e2e` wraps the **ATE (Automation Test Engine)** pipeline
to produce a complete Playwright run — extract the interaction graph
from `app/`, generate specs under `tests/e2e/auto/`, and invoke
`playwright test` with your config. It works alongside the existing
unit/integration runner; pass `--e2e` on its own to run only the E2E
leg, or combine with `mandu test` to fan out.

---

## Quick start

```bash
# Run the full pipeline (unit → integration → E2E)
mandu test --e2e

# Only the E2E pipeline, with heal-on-failure suggestions
mandu test --e2e --heal

# Preview what would happen (no spawn)
mandu test --e2e --dry-run

# CI: fail fast + pass through headless mode
mandu test --e2e --bail --ci
```

---

## Prerequisites

- `@playwright/test >= 1.40.0` — add via `bun add -d @playwright/test`.
  If missing, `mandu test --e2e` exits with `CLI_E063` and a clear
  install hint.
- `tests/e2e/playwright.config.ts` — the config Mandu will pass to
  Playwright's `--config` flag.  `mandu init` templates ship with one.

---

## Pipeline stages

1. **Extract** — `ateExtract()` scans `app/` for routes, islands, and
   interactions, writing `.mandu/interaction-graph.json`.
2. **Generate** — `ateGenerate()` emits one spec per route under
   `tests/e2e/auto/<routeId>.spec.ts`. Scenarios are derived from the
   graph + any `.mandu/scenarios.json` overrides.
3. **Spawn** — `runE2E()` invokes `bunx playwright test --config
   tests/e2e/playwright.config.ts`, forwarding `CI=true`, `BASE_URL`,
   and optional `--grep` filters.
4. **(Optional)** Heal — when `--heal` is set AND Playwright exited
   non-zero, `ateHeal()` inspects the latest report and emits
   selector-map / test-code diffs. **No auto-commit** — you review and
   apply manually (see `docs/testing/watch.md` for the heal loop in
   watch mode).

---

## Flags

| Flag               | Effect                                                           |
| ------------------ | ---------------------------------------------------------------- |
| `--e2e`            | Enable the pipeline. Combines with `unit`/`integration` targets. |
| `--heal`           | Emit healing suggestions after a failing run.                    |
| `--dry-run`        | Print the plan, skip the subprocess. Exit 0.                     |
| `--coverage`       | Set `PW_COVERAGE=1` + emit LCOV to `.mandu/coverage/e2e.lcov`.   |
| `--base-url <url>` | Override `BASE_URL` passed to Playwright.                        |
| `--ci`             | Forward `CI=true`.                                               |
| `--only-route <id>`| Filter via Playwright `--grep`. Repeatable.                      |

---

## Dry-run example

```bash
$ mandu test --e2e --dry-run
mandu test --e2e --dry-run
ATE E2E generation plan (oracle L1)
  out: tests/e2e/auto
  routes: 2
    - /home  [GET]      → tests/e2e/auto/_home.spec.ts
    - /api/users [GET]  → tests/e2e/auto/_api_users.spec.ts

ATE E2E execution plan
  cwd:         /repo
  command:     bunx playwright test --config tests/e2e/playwright.config.ts
  timeout:     600000ms
  lcov output: (coverage off)
```

---

## Exit codes

| Code | Meaning                                          |
| ---- | ------------------------------------------------ |
|   0  | All specs passed (or dry-run)                    |
|   1  | At least one spec failed                         |
|   2  | Infra failure (spawn error, timeout)             |
|   4  | Config error (playwright missing, config missing)|

---

## Troubleshooting

**`CLI_E063: @playwright/test peer dependency is not installed.`** —
run `bun add -d @playwright/test`.

**Empty route list in the plan** — run `mandu test:auto` once to
regenerate the interaction graph. The plan reads
`.mandu/interaction-graph.json` to enumerate routes.

**Playwright runs but no specs match** — check your
`tests/e2e/playwright.config.ts` `testDir` points at `tests/e2e/auto`
(or includes it).

**Heal loop prints "No failed locators detected"** — Playwright's JSON
report must be present at `.mandu/reports/latest/playwright-report.json`.
Ensure your config has the `json` reporter enabled (see
`docs/testing/getting-started.md`).
