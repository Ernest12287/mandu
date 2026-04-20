/**
 * Local dev server for `@mandujs/playground-runner` — Option 2 of the
 * Phase 16.2 rollout.
 *
 * **Scope**:
 *   - A `Bun.serve`-based HTTP server that mirrors the Cloudflare Worker's
 *     SSE contract. Developers run `bun run dev` and get a working
 *     playground backend at `http://127.0.0.1:8788` without touching
 *     Cloudflare, Turnstile, KV, or Durable Objects.
 *   - Loopback-only: binds to `127.0.0.1` so nothing on the network can
 *     reach the MockAdapter. The MockAdapter spawns `bun -e ${script}` and
 *     is NOT hardened for untrusted input — localhost-only is the security
 *     boundary.
 *
 * **What this is NOT**:
 *   - Not a production runner. Use `worker.ts` + a real CF deploy for
 *     mandujs.com.
 *   - Not rate-limited, not Turnstile-gated. Those are CF prod concerns;
 *     locally you run your own code against your own machine.
 *   - Not a replacement for the MockAdapter's internal enforcement. Wall-
 *     clock / output-cap policies from `SECURITY_POLICY` still apply — an
 *     infinite-loop submission still times out at 30s.
 *
 * **Integration with mandujs.com (public site)**:
 *   The public site stays in static mode. For developers who want to wire
 *   the public playground UI at a local runner, see `README.md` —
 *   dev-only env var pointing at `http://127.0.0.1:8788`.
 */

import { LocalRunner } from "./local-runner";
import { SECURITY_POLICY } from "./security";
import type { ExampleSlug, RunRequestBody, SSEEvent } from "./types";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Default bind port. Override via `MANDU_PLAYGROUND_PORT`. */
const DEFAULT_PORT = 8788;

/**
 * Default CORS origin — Vite's default dev server. Override via
 * `MANDU_PLAYGROUND_CORS_ORIGIN` for a different front-end dev port
 * (e.g. Next.js 3000, Astro 4321, or a deployed preview URL).
 *
 * **Security note**: We do NOT default to `*`. A wildcard would let any
 * browser-visited page POST user code to this local server, which would
 * then run on the developer's machine. Keeping the allowlist specific
 * forces an explicit opt-in when integrating with a new origin.
 */
const DEFAULT_CORS_ORIGIN = "http://localhost:5173";

/** Loopback-only bind address. See §security boundary in README. */
const BIND_HOSTNAME = "127.0.0.1";

/** Configuration for {@link startLocalServer}. */
export interface LocalServerOptions {
  /** Override the bind port. Defaults to env `MANDU_PLAYGROUND_PORT` or 8788. */
  port?: number;
  /** Override the allowed CORS origin. Defaults to env or Vite's 5173. */
  corsOrigin?: string;
  /** Inject a pre-built runner — used by tests to supply a short-clock runner. */
  runner?: LocalRunner;
  /** Suppress startup log — used by tests. Defaults to `false`. */
  quiet?: boolean;
}

/**
 * Server handle returned by {@link startLocalServer}. Callers (tests,
 * integrations) use it to read the resolved port + hostname and to shut
 * down gracefully.
 */
export interface LocalServerHandle {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): Promise<void>;
}

// -----------------------------------------------------------------------------
// Public entrypoint — start the server
// -----------------------------------------------------------------------------

/**
 * Start the local playground dev server. Returns a handle the caller can
 * use to stop the server + read the bound port.
 *
 * **Usage from a script** (e.g. `bun run dev`):
 *
 *   if (import.meta.main) {
 *     const handle = await startLocalServer();
 *     registerShutdown(handle);
 *   }
 */
export async function startLocalServer(
  options: LocalServerOptions = {}
): Promise<LocalServerHandle> {
  const port = options.port ?? readPort();
  const corsOrigin = options.corsOrigin ?? readCorsOrigin();
  const runner = options.runner ?? new LocalRunner();

  const server = Bun.serve({
    port,
    hostname: BIND_HOSTNAME,
    async fetch(request: Request): Promise<Response> {
      return await handleRequest(request, runner, corsOrigin);
    },
  });

  // Bun.serve returns `server.port` (resolved) and `server.hostname`.
  // Both are typed as optional because Bun also supports unix-socket
  // servers where they're absent. For HTTP bind they're always defined,
  // so we coerce with a runtime guard rather than a blind cast.
  const resolvedPort = server.port;
  const resolvedHost = server.hostname;
  if (typeof resolvedPort !== "number" || typeof resolvedHost !== "string") {
    throw new Error(
      "[playground] Bun.serve returned without a resolved HTTP bind — " +
        "check that you're not running on a unix socket."
    );
  }

  if (!options.quiet) {
    // Startup log — format matches the task spec exactly.
    console.log(
      `🎮 Playground dev server at http://${resolvedHost}:${resolvedPort} (local-only, MockAdapter)`
    );
  }

  return {
    port: resolvedPort,
    hostname: resolvedHost,
    url: `http://${resolvedHost}:${resolvedPort}`,
    async stop() {
      // Abort in-flight runs FIRST so their ReadableStream controllers
      // close before Bun tears down the server. Otherwise the pending
      // adapter iterations leak.
      runner.shutdown();
      server.stop(true /* closeActiveConnections */);
    },
  };
}

// -----------------------------------------------------------------------------
// Request routing
// -----------------------------------------------------------------------------

async function handleRequest(
  request: Request,
  runner: LocalRunner,
  corsOrigin: string
): Promise<Response> {
  const url = new URL(request.url);

  // Every response gets the same CORS headers so preflight + actual
  // requests stay consistent. `Vary: Origin` prevents browser / proxy
  // cache cross-origin contamination.
  const cors = buildCorsHeaders(corsOrigin);

  // CORS preflight — matches any method.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: cors,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/playground/health") {
    return handleHealth(cors, runner);
  }

  if (request.method === "POST" && url.pathname === "/api/playground/run") {
    return await handleRun(request, runner, cors);
  }

  return new Response("Not found", {
    status: 404,
    headers: cors,
  });
}

// -----------------------------------------------------------------------------
// GET /api/playground/health
// -----------------------------------------------------------------------------

function handleHealth(
  cors: HeadersInit,
  runner: LocalRunner
): Response {
  // Surface enough state to let a smoke check verify:
  //   1. The server is up (200 + JSON body)
  //   2. It's the local server (mode === "local") — distinguishes from
  //      the CF Worker which returns `status: "ok"` + `adapter: "..."`
  //   3. Security limits match the policy (operators / tests assert)
  return Response.json(
    {
      ok: true,
      mode: "local" as const,
      adapter: "mock",
      activeRuns: runner.activeRunCount,
      limits: {
        wallClockMs: SECURITY_POLICY.wallClockMs,
        cpuBudgetMs: SECURITY_POLICY.cpuBudgetMs,
        outputCapBytes: SECURITY_POLICY.outputCapBytes,
        memoryMib: SECURITY_POLICY.memoryMib,
      },
    },
    {
      headers: {
        ...Object.fromEntries(new Headers(cors).entries()),
        "Cache-Control": "no-store",
      },
    }
  );
}

// -----------------------------------------------------------------------------
// POST /api/playground/run
// -----------------------------------------------------------------------------

async function handleRun(
  request: Request,
  runner: LocalRunner,
  cors: HeadersInit
): Promise<Response> {
  let body: RunRequestBody;
  try {
    body = (await request.json()) as RunRequestBody;
  } catch {
    return sseError("compile", "request body must be JSON", cors);
  }

  if (typeof body.code !== "string" || body.code.length === 0) {
    return sseError("compile", "`code` must be a non-empty string", cors);
  }
  if (body.code.length > 50_000) {
    // 50 KiB input cap — matches the Worker path. Local-only, but we
    // keep parity so front-end assumptions never diverge.
    return sseError("compile", "`code` exceeds 50 KiB input limit", cors);
  }
  if (typeof body.example !== "string" || body.example.length === 0) {
    return sseError("compile", "`example` must be a non-empty string", cors);
  }

  // Mint a run id locally. The production path uses the DO id-from-name
  // mapping; here we just need a stable string for the SSE stream.
  const runId = `run-${crypto.randomUUID()}`;

  const stream = runner.buildStream({
    code: body.code,
    example: body.example as ExampleSlug,
    runId,
    clientIp: "127.0.0.1",
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...Object.fromEntries(new Headers(cors).entries()),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type ErrorReason = Extract<SSEEvent, { type: "error" }>["data"]["reason"];

/**
 * Emit a one-shot SSE error response for early validation failures. The
 * front-end reads the same event shape whether the error came from the
 * adapter or from the pre-adapter validation layer.
 *
 * We return HTTP 400 (not 200) so devtools / curl exit codes surface the
 * failure. The body is still a valid SSE frame — EventSource clients
 * tolerate mixed status codes.
 */
function sseError(
  reason: ErrorReason,
  message: string,
  cors: HeadersInit
): Response {
  const payload =
    `event: error\n` +
    `data: ${JSON.stringify({ reason, message })}\n\n`;

  return new Response(payload, {
    status: 400,
    headers: {
      ...Object.fromEntries(new Headers(cors).entries()),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Build the CORS headers for every response (including preflight).
 *
 * Design decision: we do NOT echo `Origin` — we always return the
 * configured allowlist value. That way an attacker who tricks a user
 * into visiting `http://evil.example` cannot elicit a permissive
 * `Access-Control-Allow-Origin: http://evil.example` header by setting
 * their `Origin` to match.
 */
function buildCorsHeaders(corsOrigin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function readPort(): number {
  const raw = process.env.MANDU_PLAYGROUND_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    console.warn(
      `[playground] invalid MANDU_PLAYGROUND_PORT=${raw} — falling back to ${DEFAULT_PORT}`
    );
    return DEFAULT_PORT;
  }
  return parsed;
}

function readCorsOrigin(): string {
  return process.env.MANDU_PLAYGROUND_CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN;
}

// -----------------------------------------------------------------------------
// CLI entry — `bun run src/local-server.ts` / `bun run dev`
// -----------------------------------------------------------------------------

/**
 * Register SIGINT / SIGTERM handlers that gracefully close the server
 * and any in-flight runs. Called from the main block below.
 */
function registerShutdown(handle: LocalServerHandle): void {
  let closing = false;
  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n[playground] ${signal} received — closing in-flight runs...`);
    try {
      await handle.stop();
      console.log("[playground] stopped cleanly");
    } catch (err) {
      console.error("[playground] shutdown error:", err);
    } finally {
      // Exit on SIGINT (Ctrl+C) so the shell prompt returns immediately.
      // Using 130 = 128 + SIGINT(2) per POSIX convention.
      process.exit(signal === "SIGINT" ? 130 : 0);
    }
  };

  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
}

if (import.meta.main) {
  const handle = await startLocalServer();
  registerShutdown(handle);
}
