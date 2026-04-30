# Performance Baseline

This directory defines the first fixed contract for Mandu performance tracking.

## Official Metrics

- `ssr_ttfb_p95_ms`
- `hydration_p95_ms`
- `initial_js_bundle_kb`
- `hmr_latency_p95_ms`
- `route_scan_p95_ms`
- `resource_generation_p95_ms`

## Current Status

- `tests/perf/perf-baseline.json` is the source of truth for metric names, scenarios, and budgets.
- Active scenarios point at `demo/todo-app` and now freeze HTTP-derived baselines for TTFB and initial JS.
- `hydration_p95_ms` may remain `baseline: null` on environments where Playwright/browser launch is unavailable; the run must leave a `browser-error.txt` artifact.
- Planned scenarios reserve metric scope for upcoming reference apps so the schema does not drift later.

## Freeze Snapshot

Last freeze: 2026-05-01, local Windows run.

Command:

```bash
bun run perf:run -- --runs 3 --warmup 1
```

Frozen active baselines:

| Scenario | Metric | Baseline | Notes |
|---|---|---:|---|
| `todo-app-home-dev` | `ssr_ttfb_p95_ms` | 74.5 | HTTP metric |
| `todo-app-home-dev` | `initial_js_bundle_kb` | 1124.4 | Dev bundle includes unminified dev/HMR payload |
| `todo-app-home-prod` | `ssr_ttfb_p95_ms` | 2.2 | HTTP metric |
| `todo-app-home-prod` | `initial_js_bundle_kb` | 0.0 | Home route ships no initial JS in prod |
| `todo-app-home-dev` / `todo-app-home-prod` | `hydration_p95_ms` | n/a | Browser launch unsupported in this Windows run |

## Commands

```bash
bun run perf:baseline:check
bun run perf:run
bun run perf:budget:check -- --summary .perf/latest/summary.json
bun run perf:ci
bun run perf:hydration -- http://localhost:3333/ 5 none
```

Optional JSON capture:

```bash
bun run perf:hydration -- http://localhost:3333/ 5 none --json-out tests/perf/latest/todo-list-home-dev.json
```

## Current Rule

- Budgets define the ceiling we do not want to exceed.
- Baselines define the historical number we compare against later.
- CI validates schema, runs active scenarios, and writes measured artifacts.
- Local scenario runs write their artifacts to `.perf/latest/` and do not modify tracked baseline files.
- `perf:budget:check` is soft by default. Add `--enforce` only when you are ready to make budget exceedance blocking.
- Perf runs set `MANDU_LOCK_BYPASS=1` for spawned demo servers so stale local `.mandu/lockfile.json` files do not block measurement of rendering performance.

## Updating Baselines

Baseline changes should be isolated from unrelated runtime or bundler changes.

1. Run `bun run perf:baseline:check`.
2. Run `bun run perf:run -- --runs 3 --warmup 1`.
3. Inspect `.perf/latest/report.md`, `.perf/latest/summary.json`, and any `browser-error.txt`.
4. Update only active scenario baseline values that were actually measured.
5. Leave unsupported browser metrics as `baseline: null` and document the reason.
6. Run `bun run perf:ci` before opening or merging the change.

Do not relax a budget in the same change as a runtime performance regression unless the PR explicitly documents why the ceiling changed.
