---
title: "Playground Runner — Operator Deployment Guide"
status: scaffolding
created: 2026-04-19
phase: 16.2
related:
  - packages/playground-runner/README.md
  - docs/playground/security.md
  - docs/bun/phase-16-diagnostics/playground-runtime.md
---

# Playground Runner — Operator Deployment Guide

This guide walks through deploying `@mandujs/playground-runner` to a real
Cloudflare account. Until these steps are complete, the scaffold's
`CloudflareSandboxAdapter` throws a visible error on every request —
intentional, to prevent silent partial deploys.

Estimated total time: **~45 minutes** (first time) / ~5 min on re-deploys.

Expected cost at 30k runs/month: **~$8/month** (Workers Paid $5 +
CF Containers ~$3). See [`playground-runtime.md` §2.1][econ] for the
R0 economic model. Hard spend cap: **$25/month**.

[econ]: ../bun/phase-16-diagnostics/playground-runtime.md

## 1. Prerequisites

| Requirement | Why |
|---|---|
| Cloudflare account | Host the Worker + DO + Container |
| Workers Paid ($5/mo) | Required for Durable Objects + Containers |
| `wrangler >= 3.0.0` | CLI for deploy + KV + secrets |
| A CF-managed domain | For `sbx-<id>.<domain>` proxy routes |
| Turnstile site key + secret | Abuse gate (created in CF dashboard) |
| Docker Desktop OR `wrangler sandbox` local build | Build the sandbox image |

Authenticate:

```bash
wrangler login
wrangler whoami  # confirms account id — paste into wrangler.toml below
```

## 2. Initial workspace setup

```bash
cd packages/playground-runner

# 1. Copy the template; never commit the filled-in version.
cp wrangler.toml.template wrangler.toml

# 2. Create the KV namespace for rate-limit counters.
wrangler kv namespace create RATE_LIMIT
# → prints `id = "abc123..."` — paste into wrangler.toml

# 3. Paste your account_id from `wrangler whoami` into wrangler.toml
# 4. Fill in the route patterns with your domain
```

## 3. Sandbox container image

Build + push the sandbox image that vendors `@mandujs/core` + React:

```bash
# Build locally first to verify the image assembles.
docker build -f Dockerfile.sandbox -t mandu-playground-sandbox:latest .

# Push to Cloudflare's registry.
wrangler sandbox push -f Dockerfile.sandbox

# Verify — should list the image.
wrangler sandbox list
```

**Before the first push you MUST author `vendor/mandu-test-runner.ts`**.
The Dockerfile expects that file to exist under `packages/playground-runner/
vendor/`. Shape sketch is documented in `Dockerfile.sandbox`. Minimum
implementation:

```ts
// packages/playground-runner/vendor/mandu-test-runner.ts
import { startServer } from "@mandujs/core";

const manifest = {
  version: 1,
  routes: [{
    id: "index",
    pattern: "/",
    kind: "page",
    module: "/work/page.tsx",
  }],
};

const server = await startServer(manifest, { port: 0 });
const port = (server as any).port ?? 3000;
const res = await fetch(`http://localhost:${port}/`);
process.stdout.write(await res.text());
await server.stop();
```

TODO — the Phase 16.2 live agent will replace this sketch with the final
runner once the shape of the sandbox exec output is confirmed against CF's
GA SDK.

## 4. Secrets

Set all secrets via `wrangler secret put` — **never** paste into
`wrangler.toml`.

```bash
# Required: Turnstile server-side secret.
# Create a site at https://dash.cloudflare.com/?to=/:account/turnstile
wrangler secret put TURNSTILE_SECRET
# Paste the "Secret Key" when prompted.

# Optional: Fly.io fallback token (only if ADAPTER_MODE=fly).
wrangler secret put FLY_API_TOKEN
```

Verify:

```bash
wrangler secret list
```

## 5. Finish the CloudflareSandboxAdapter wiring

The scaffold ships the adapter shape + SDK call-site comments. Before
the first live deploy, a developer must:

1. Open `packages/playground-runner/src/adapter.ts`.
2. Find the `TODO(phase-16.2-live)` block inside `CloudflareSandboxAdapter.run()`.
3. Replace the `throw new Error(...)` with the SDK call sequence
   (`writeFile`, `exec`, `proxyToSandbox`) as sketched.
4. Open `src/worker.ts` → `proxyToSandbox()` → replace the stub body with
   `import { proxyToSandbox } from "@cloudflare/sandbox"` + delegation.
5. Run `bun test` — MockAdapter tests MUST still pass.

The scaffold holds both the intent (type interface, event shapes) and the
guard rail (explicit throw). Removing the throw without implementing the
SDK calls will produce silent failures — don't shortcut this step.

## 6. First deploy

```bash
# From packages/playground-runner/
wrangler deploy
```

Wrangler prints the deployed URL. Verify the health endpoint:

```bash
curl https://<your-worker>.workers.dev/api/playground/health
# Expected:
# {"status":"ok","adapter":"cloudflare","limits":{...}}
```

If `adapter` reads `"mock"`, you deployed with `ADAPTER_MODE=mock` — check
`wrangler.toml [vars]` and redeploy.

## 7. Custom routes + sandbox proxy

Enable the `sbx-<id>` proxy pattern on your CF zone:

```toml
# In wrangler.toml
[[routes]]
pattern = "playground.mandujs.com/api/playground/*"
zone_name = "mandujs.com"

[[routes]]
pattern = "sbx-*.mandujs.dev/*"
zone_name = "mandujs.dev"
```

Each sandbox instance exposes its server at `https://sbx-<id>.mandujs.dev`.
The front-end's `<iframe sandbox>` loads this URL directly — no SameSite
cookies cross, no `allow-same-origin`.

## 8. Billing + alerting

**Critical**: set a spend cap BEFORE you allow any public traffic.

```
CF Dashboard → Billing → Usage alerts
  → Set "Notify me at": $10/month
  → Set "Pause workload at": $25/month
```

Also enable email alerts for:
- Turnstile challenge volume (indicates abuse)
- Worker error rate > 5%
- DO CPU-sec overage

The R0 model projects ~$3/month at 30k runs. If you exceed $10 in a week,
pause the Worker and investigate — likely signs: a bot farm, a widely-shared
link, or a regression in the rate-limit gate.

## 9. Health + smoke

Post-deploy smoke check (script it in CI for re-deploys):

```bash
URL="https://<your-worker>.workers.dev"

# 1. Health endpoint
curl -sf "$URL/api/playground/health" | jq .

# 2. Happy-path run (hello-mandu example)
curl -N -X POST "$URL/api/playground/run" \
  -H "Content-Type: application/json" \
  -d '{"code":"console.log(\"ok\")","example":"hello-mandu"}'

# 3. Watch logs live
wrangler tail
```

You should see `event: sandbox-url` → `event: stdout` → `event: exit` as
SSE frames.

## 10. Rollback

If a deploy misbehaves:

```bash
# List recent deployments.
wrangler deployments list

# Roll back to a known-good deploy id.
wrangler rollback <deployment-id>

# Or fully take the Worker offline (emergency stop).
wrangler deployments delete <id>
```

The front-end (`mandujs.com`) degrades gracefully — the playground UI shows
a "runner offline" banner when `/api/playground/health` 503s.

## 11. Next steps

- Phase 16.3 (live tutorial): add `content/playground/tutorial/*.mdx` on the
  mandujs.com side, pointing at this deployed Worker.
- Observability: wire structured logs (`console.log({ runId, example,
  exitCode })`) into Logpush → R2 for long-term audit.
- Warm pool: extend the DO to pre-warm sandbox instances (optional, saves
  cold-start latency).

See also: `docs/playground/security.md` (threat model + abuse response).
