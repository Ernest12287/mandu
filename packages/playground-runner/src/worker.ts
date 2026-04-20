/**
 * Cloudflare Worker entry for `@mandujs/playground-runner`.
 *
 * **Routes**:
 *   - POST /api/playground/run    — start a run, return SSE stream
 *   - GET  /api/playground/health — liveness probe
 *   - /sbx-<id>.*                 — proxied to the sandbox via
 *                                    `sandbox.proxyToSandbox(req)`
 *
 * **Deployment**: see `docs/playground/deployment.md`. This module is the
 * Wrangler main: set `main = "src/worker.ts"` in `wrangler.toml`.
 *
 * **Test boundary**: the POST handler creates a DO stub via
 * `env.PLAYGROUND_DO` — in tests we pass a mock stub. The adapter is
 * selected by `env.ADAPTER_MODE` (see `adapter.ts`).
 */

import { PlaygroundRunner } from "./durable-object";
import {
  SECURITY_POLICY,
  rateLimitKey,
  verifyTurnstile,
  isAllowedEgress,
} from "./security";
import type {
  ExecutionContext,
  RunRequestBody,
  SSEEvent,
  WorkerBindings,
} from "./types";

// Re-export the DO class so `wrangler.toml`'s
// `new_classes = ["PlaygroundRunner"]` can bind it.
export { PlaygroundRunner };

// Re-export public surfaces for consumers of this package (e.g. the
// mandujs.com front-end that builds a typed client against these types).
export type {
  PlaygroundAdapter,
  SSEEvent,
  ExampleSlug,
  RunRequestBody,
  RunOptions,
  WorkerBindings,
} from "./types";

// -----------------------------------------------------------------------------
// Default fetch handler
// -----------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: WorkerBindings,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // 1. Sandbox proxy routes — Cloudflare's Sandbox SDK exposes user
    //    containers at `sbx-<id>.<zone>`; the SDK handles request routing
    //    via `proxyToSandbox`. We match on hostname prefix.
    if (url.hostname.startsWith("sbx-")) {
      return await proxyToSandbox(request, env);
    }

    // 2. Health check — used by uptime monitors + deployment verification.
    if (request.method === "GET" && url.pathname === "/api/playground/health") {
      return Response.json({
        status: "ok",
        adapter: env.ADAPTER_MODE ?? "cloudflare",
        // Surface the limits publicly so the front-end can render them.
        limits: {
          wallClockMs: SECURITY_POLICY.wallClockMs,
          cpuBudgetMs: SECURITY_POLICY.cpuBudgetMs,
          outputCapBytes: SECURITY_POLICY.outputCapBytes,
          memoryMib: SECURITY_POLICY.memoryMib,
        },
      });
    }

    // 3. Main run endpoint.
    if (
      request.method === "POST" &&
      url.pathname === "/api/playground/run"
    ) {
      return await handleRun(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

// -----------------------------------------------------------------------------
// POST /api/playground/run
// -----------------------------------------------------------------------------

async function handleRun(
  request: Request,
  env: WorkerBindings,
  ctx: ExecutionContext
): Promise<Response> {
  // -- 1. Extract IP from Cloudflare-provided header -------------------------
  const clientIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";

  // -- 2. Parse body ----------------------------------------------------------
  let body: RunRequestBody;
  try {
    body = (await request.json()) as RunRequestBody;
  } catch {
    return sseError("compile", "request body must be JSON");
  }

  if (typeof body.code !== "string" || body.code.length === 0) {
    return sseError("compile", "`code` must be a non-empty string");
  }
  if (body.code.length > 50_000) {
    // 50 KiB input cap — the editor UI already enforces 10 KiB but we
    // double-check here. Adjust alongside front-end limits.
    return sseError("compile", "`code` exceeds 50 KiB input limit");
  }

  // -- 3. Rate-limit check ----------------------------------------------------
  const rateVerdict = await checkRateLimit(clientIp, env);
  if (rateVerdict.status === "block") {
    return new Response(
      JSON.stringify({ error: "rate-limit", retryAfterMs: rateVerdict.retryAfterMs }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rateVerdict.retryAfterMs / 1000)),
        },
      }
    );
  }

  // -- 4. Turnstile (after threshold) ----------------------------------------
  if (rateVerdict.status === "needs-turnstile") {
    const verdict = await verifyTurnstile(
      body.turnstileToken,
      env.TURNSTILE_SECRET,
      clientIp
    );
    if (!verdict.valid) {
      return new Response(
        JSON.stringify({ error: "turnstile-required", reason: verdict.reason }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  // -- 5. Create DO + forward -------------------------------------------------
  const runId = crypto.randomUUID();
  const doId = env.PLAYGROUND_DO.idFromName(runId);
  const stub = env.PLAYGROUND_DO.get(doId);

  // Rewrite URL to match the DO's expected `/run` path.
  const doRequest = new Request("https://do.internal/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: body.code,
      example: body.example,
      runId,
      clientIp,
    }),
  });

  // The DO returns an SSE stream — we pipe it straight back to the client.
  const response = await stub.fetch(doRequest);

  // Fire-and-forget: increment the IP counter. Failures are non-fatal;
  // Turnstile + per-hour cap are independent defenses.
  ctx.waitUntil(bumpRateLimit(clientIp, env));

  return response;
}

// -----------------------------------------------------------------------------
// Rate-limit + Turnstile gate
// -----------------------------------------------------------------------------

type RateVerdict =
  | { status: "allow" }
  | { status: "needs-turnstile" }
  | { status: "block"; retryAfterMs: number };

async function checkRateLimit(
  ip: string,
  env: WorkerBindings
): Promise<RateVerdict> {
  if (ip === "unknown") {
    // Without an IP we can't rate-limit — demand Turnstile.
    return { status: "needs-turnstile" };
  }

  // Count hits in the last ~15 minutes.
  const now = Date.now();
  const bucketMs = 60_000;
  const bucketsInWindow = Math.ceil(SECURITY_POLICY.turnstileWindowMs / bucketMs);
  let count = 0;

  const keys: string[] = [];
  for (let i = 0; i < bucketsInWindow; i++) {
    const bucket = Math.floor(now / bucketMs) - i;
    keys.push(`rl:${ip}:${bucket}`);
  }

  // KV reads in parallel. KV is eventually consistent (~60s globally) —
  // acceptable for rate-limit because we combine with a hard hourly cap.
  const values = await Promise.all(keys.map((k) => env.RATE_LIMIT.get(k)));
  for (const v of values) {
    if (v) count += Number(v) || 0;
  }

  if (count >= SECURITY_POLICY.runsPerHour) {
    return {
      status: "block",
      retryAfterMs: SECURITY_POLICY.turnstileWindowMs,
    };
  }

  if (count >= SECURITY_POLICY.runsBeforeTurnstile) {
    return { status: "needs-turnstile" };
  }

  return { status: "allow" };
}

async function bumpRateLimit(ip: string, env: WorkerBindings): Promise<void> {
  if (ip === "unknown") return;
  const key = rateLimitKey(ip);
  try {
    const prev = await env.RATE_LIMIT.get(key);
    const next = (Number(prev) || 0) + 1;
    await env.RATE_LIMIT.put(key, String(next), {
      expirationTtl: 3600, // 1 hour — covers the 15-min window + burst grace.
    });
  } catch {
    // KV errors are logged by the runtime; a missed increment is not
    // catastrophic because we have other gates.
  }
}

// -----------------------------------------------------------------------------
// Sandbox proxy
// -----------------------------------------------------------------------------

/**
 * Forward a request to a sandbox instance. In production this delegates
 * to the Sandbox SDK's `proxyToSandbox(req)`; the STUB here returns 501
 * so we can deploy the Worker shell without live sandboxes.
 *
 * TODO(phase-16.2-live): Replace with:
 *   import { proxyToSandbox } from "@cloudflare/sandbox";
 *   return await proxyToSandbox(request);
 */
async function proxyToSandbox(
  request: Request,
  _env: WorkerBindings
): Promise<Response> {
  const url = new URL(request.url);

  // Defense-in-depth: double-check egress allowlist even for the proxy.
  // The adapter sets the `Host` header; we strip bad values.
  if (!isAllowedEgress(url.hostname)) {
    return new Response("egress-denied", { status: 403 });
  }

  return new Response(
    JSON.stringify({
      error: "proxy-not-wired",
      message:
        "Complete CloudflareSandboxAdapter wiring before deploying live. " +
        "See docs/playground/deployment.md §3.",
    }),
    {
      status: 501,
      headers: { "Content-Type": "application/json" },
    }
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Extracts the `reason` union from the typed SSE error event. Kept as a
 * named alias so call sites reference a readable identifier rather than
 * an inline conditional type.
 */
type ErrorReason = Extract<SSEEvent, { type: "error" }>["data"]["reason"];

/**
 * Build a single-event SSE response. Used for early errors before the DO
 * is engaged (parse errors, rate-limit blocks).
 */
function sseError(reason: ErrorReason, message: string): Response {
  const payload =
    `event: error\n` +
    `data: ${JSON.stringify({ reason, message })}\n\n`;

  return new Response(payload, {
    status: 400,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
