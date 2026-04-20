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
