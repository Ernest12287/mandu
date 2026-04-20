# @mandujs/playground-runner

Cloudflare Worker + Durable Object + adapter layer that runs user-submitted
Mandu code in isolated sandboxes. Powers the live playground on
**mandujs.com** (Phase 16.2).

**Status**: `private: true`, scaffolding landed 2026-04-19. Not published to
npm. Deploying to a real CF account requires:
1. Finishing `CloudflareSandboxAdapter` wiring in `src/adapter.ts`
2. Authoring `vendor/mandu-test-runner.ts`
3. Running `wrangler deploy`

See `docs/playground/deployment.md` for the step-by-step runbook.

---

## Local dev mode (Option 2)

Spin up a fully-working playground backend on `http://127.0.0.1:8788` —
**no Cloudflare account, no Wrangler, no Turnstile, no cost**. Uses the
same `MockAdapter` the test suite uses, plus a `Bun.serve`-based local
server (`src/local-server.ts`) that mirrors the Worker's SSE contract.

### What it is

- Loopback-only HTTP server (`127.0.0.1`), backed by `MockAdapter`
- Same public routes as production: `GET /api/playground/health`,
  `POST /api/playground/run`
- Same SSE event wire shape (`sandbox-url` → `stdout`/`stderr` → `exit`/`error`)
- Same security limits from `src/security.ts`: 30s wall clock, 64 KiB output
  cap, 50 KiB input cap — a `while(true){}` submission still times out
- **No** rate-limit, **no** Turnstile, **no** KV — those are CF prod concerns

### Start it

```bash
cd packages/playground-runner
bun install        # first time only
bun run dev        # starts the server on 127.0.0.1:8788
```

Expected startup log:

```
🎮 Playground dev server at http://127.0.0.1:8788 (local-only, MockAdapter)
```

Stop with `Ctrl+C` — in-flight runs are aborted, SSE streams close cleanly,
the process exits 130.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MANDU_PLAYGROUND_PORT` | `8788` | Override the bind port |
| `MANDU_PLAYGROUND_CORS_ORIGIN` | `http://localhost:5173` | Allowed origin for browser fetches |

CORS is pinned to the configured origin (never echoes `Origin` back). If
your front-end runs on a different port or a preview URL, set it explicitly:

```bash
MANDU_PLAYGROUND_CORS_ORIGIN=http://localhost:3000 bun run dev
```

### Verify

```bash
# Health
curl -s http://127.0.0.1:8788/api/playground/health | jq .
# → { "ok": true, "mode": "local", "adapter": "mock", "limits": {...} }

# Run (SSE)
curl -sN -X POST http://127.0.0.1:8788/api/playground/run \
  -H "Content-Type: application/json" \
  -d '{"code":"console.log(1+1)","example":"hello-mandu"}'
# → event: sandbox-url / event: stdout / event: exit
```

### Pointing mandujs.com's playground UI at a local runner

The public **mandujs.com** playground runs in *static mode* — its UI ships
without a backend. To point a local clone of mandujs.com at this runner:

1. Set a dev-only env var on the front-end pointing at the local runner:
   ```
   PUBLIC_PLAYGROUND_ENDPOINT=http://127.0.0.1:8788
   ```
2. In the playground component, guard the fetch behind a dev check — e.g.
   `if (import.meta.env.DEV && PUBLIC_PLAYGROUND_ENDPOINT)`.
3. Bump `MANDU_PLAYGROUND_CORS_ORIGIN` to match the front-end dev origin
   (Vite `5173`, Astro `4321`, Next `3000`, etc.).

Do **not** ship the dev fetch guard to production — the public site stays
static-mode. The hosted playground requires the Option 1 CF deploy.

### Security boundary

The local server runs user code on **your own machine**, via
`Bun.spawn` inside `MockAdapter`. That's safe as long as:

- The bind is `127.0.0.1` (loopback only) — enforced in `local-server.ts`.
  Tests assert `server.hostname === "127.0.0.1"`.
- You never expose the port over the network (no `0.0.0.0`, no port
  forwarding, no ngrok).
- The `code` you're running is code you wrote / code you trust.

If you need isolation from untrusted input, deploy the Cloudflare Worker
path (Option 1). The CF Sandboxes SDK provides the container isolation
that `MockAdapter` does not.

### When to use which mode

|  | Option 1 (CF production) | Option 2 (local dev) |
|---|---|---|
| **Audience** | Public mandujs.com visitors | Your laptop |
| **Isolation** | CF Sandboxes container | `Bun.spawn` in-process |
| **Cost** | ~$8/month @ 30k runs | Free |
| **Setup time** | ~45 min (CF account, KV, Turnstile, domain) | `bun run dev` |
| **Rate limit + Turnstile** | Yes | No (trust boundary = localhost) |
| **File** | `src/worker.ts` | `src/local-server.ts` |

## Architecture

```
Client (mandujs.com)
  │ POST /api/playground/run  { code, example, turnstileToken }
  ▼
Cloudflare Worker  (src/worker.ts)
  │ 1. rate-limit check (KV)
  │ 2. Turnstile (after 5 runs/15min/IP)
  │ 3. idFromName(runId) → stub.fetch
  ▼
Durable Object  (src/durable-object.ts)
  │ 1. setAlarm(30s)   ← watchdog
  │ 2. selectAdapter(env)
  │ 3. return SSE ReadableStream
  ▼
Adapter  (src/adapter.ts)
  │ CloudflareSandboxAdapter → writeFile → exec → stream stdout
  │ MockAdapter               → Bun.spawn locally (CI only)
  │ FlyMachineAdapter         → TODO fallback
  ▼
SSE events: sandbox-url / stdout / stderr / exit / error
```

## Security

All limits live in `src/security.ts` as a single frozen policy:

| Gate | Limit | Where |
|---|---|---|
| Wall clock | 30s | `AbortSignal` in adapter + DO alarm |
| CPU budget | 15s | Sandbox instance class |
| Output cap | 64 KiB | per-chunk truncation |
| Memory | 256 MiB | container `dev` instance |
| Egress | allowlist (`localhost`, `sandbox-self`) | outbound proxy |
| Per-IP | 5 runs before Turnstile, 20/hr hard cap | Worker KV counter |

Details: `docs/playground/security.md` (threat model + incident runbook).

## Local development

```bash
# Unit + integration tests (uses MockAdapter, no CF required)
cd packages/playground-runner
bun test

# Local Worker dev with the mock adapter (no sandbox)
# Set ADAPTER_MODE=mock in your local wrangler.toml [vars] block
wrangler dev
```

**The production `CloudflareSandboxAdapter` is never invoked in tests** —
the suite runs entirely in-process with `MockAdapter`. This is enforced
by `env.ADAPTER_MODE === "mock"` in the test harness.

## Deployment (operator)

**Prerequisites**:
- Cloudflare account with Workers Paid ($5/mo)
- `wrangler` CLI authenticated (`wrangler login`)
- Domain with a CF zone (for `sbx-<id>.<domain>` proxy routes)

**Steps** (detailed in `docs/playground/deployment.md`):

1. **KV namespace**: `wrangler kv namespace create RATE_LIMIT` → copy id
2. **Config**: `cp wrangler.toml.template wrangler.toml` → fill placeholders
3. **Turnstile secret**: `wrangler secret put TURNSTILE_SECRET`
4. **Sandbox image**: `wrangler sandbox push -f Dockerfile.sandbox`
5. **Deploy**: `wrangler deploy`
6. **Verify**: `curl https://<worker>.workers.dev/api/playground/health`
7. **Spend cap**: CF dashboard → Billing → Alerts → cap $25/mo

Expected cost at 30k runs/month (R0 model): **~$8/month** (Workers Paid $5 +
CF Containers ~$3). See `docs/bun/phase-16-diagnostics/playground-runtime.md
§2.1` for the economic model.

## Package layout

```
packages/playground-runner/
├── src/
│   ├── worker.ts          ← Worker entry (default export)
│   ├── durable-object.ts  ← PlaygroundRunner DO class
│   ├── adapter.ts         ← PlaygroundAdapter + 3 implementations
│   ├── security.ts        ← SECURITY_POLICY + helpers
│   └── types.ts           ← SSE event + binding types
├── tests/
│   ├── adapter.test.ts          ← MockAdapter behavior
│   ├── security.test.ts         ← truncateOutput, stripAnsi, allowlist
│   ├── sse-event-shape.test.ts  ← wire contract regression
│   └── mock-flow.test.ts        ← end-to-end flow via MockAdapter
├── Dockerfile.sandbox           ← sandbox base image
├── wrangler.toml.template       ← deployment config template
├── tsconfig.json
├── package.json                 ← `private: true`, NOT published
└── README.md
```

## Abuse response runbook

When you see abnormal traffic:

1. **Check Worker logs**: `wrangler tail` → filter for `rate-limit` + `error`
2. **Pull Turnstile stats**: CF dashboard → Security → Turnstile → challenges
3. **Manual ban**: `wrangler kv key put --binding=RATE_LIMIT "rl:<ip>:block" "1"`
4. **Emergency stop**: `wrangler deployments delete <id>` (503 all traffic)
5. **Post-mortem**: runbook in `docs/playground/security.md §7`

## See also

- Phase 16 R0 research: `docs/bun/phase-16-diagnostics/playground-runtime.md`
- GitHub issue: #201
- Upstream SDK docs: https://developers.cloudflare.com/sandbox/

## License

MPL-2.0 (inherited from workspace root).
