# Long-run dev server heap smoke test

A manual regression harness that spawns `mandu dev` on `demo/auth-starter`, issues a controlled burst of HTTP requests, and asserts the final RSS is within `+100 MB` of the initial RSS. Catches process-level leaks that unit tests cannot.

## Running locally

```bash
bun run scripts/smoke/dev-server-heap.ts
```

Exit code `0` → pass, `1` → fail (diagnostic printed). Total runtime ~60 s.

### What it does

1. `cd demo/auth-starter && bun install` (idempotent).
2. Spawn `bun run C:/Users/.../packages/cli/dist/bin/mandu.js dev` on a dynamic port.
3. Poll `/_mandu/heap` for an initial RSS reading.
4. Issue **1000 requests** to `/` over ~60 s.
5. Sample `/_mandu/heap` every 5 s (≈12 samples), recording `process.rss`.
6. Assert `finalRss - initialRss < 100 * 1024 * 1024` (100 MB).
7. Print a compact table with initial / peak / final / delta, then shut down the dev server.

### Environment variables

| Name                              | Default  | Purpose                                |
|-----------------------------------|----------|----------------------------------------|
| `MANDU_SMOKE_REQUESTS`            | `1000`   | Number of requests to issue            |
| `MANDU_SMOKE_DURATION_MS`         | `60000`  | Window over which to spread requests   |
| `MANDU_SMOKE_SAMPLE_INTERVAL_MS`  | `5000`   | Heap sampling cadence                  |
| `MANDU_SMOKE_MAX_GROWTH_MB`       | `100`    | Fail threshold for RSS delta           |
| `MANDU_SMOKE_DEMO`                | `demo/auth-starter` | Which demo app to exercise  |

### Why it is not in CI

Dev server startup + per-request RSS measurement is noisy on shared runners (shared page cache, kernel scheduler). Final growth varies by 30-40 MB even on a healthy build. Running this on PRs would produce ~15% flake.

Two alternate integration paths:

1. **Opt-in CI workflow** (`.github/workflows/smoke-heap.yml`) triggered on `workflow_dispatch`. Operators run it before a release.
2. **Nightly job** on a dedicated runner where the variance budget is documented and accepted.

Either way, it is not wired to the default `bun test` sweep.

### Expected output (pass)

```
[smoke] demo=demo/auth-starter port=51234
[smoke] dev server started in 3.2s
[smoke] initial rss=148MB heap=72MB external=2MB
[smoke] t=5s   rss=156MB heap=78MB external=3MB (delta=+8MB)
[smoke] t=10s  rss=162MB heap=81MB external=3MB (delta=+14MB)
[smoke] ...
[smoke] t=60s  rss=195MB heap=95MB external=4MB (delta=+47MB)
[smoke] 1000 requests sent in 58.9s
[smoke] summary: initial=148MB peak=201MB final=195MB delta=+47MB budget=100MB
[smoke] PASS
```

### Expected output (fail)

```
[smoke] summary: initial=148MB peak=312MB final=298MB delta=+150MB budget=100MB
[smoke] FAIL: RSS grew by 150 MB (> 100 MB budget)
```

If you hit a FAIL:

1. Capture `/_mandu/metrics` output at peak.
2. Compare `mandu_cache_entries` series — unbounded growth likely there.
3. Run `bun test packages/core/src/utils/__tests__/lru-cache.test.ts` to confirm LRU integrity.
