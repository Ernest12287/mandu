/**
 * Shared security policy for the playground runner.
 *
 * **Every** execution path MUST consult `SECURITY_POLICY` rather than
 * hard-coding its own limits. Changes here ripple through the Worker,
 * the Durable Object, and all adapters — that's intentional.
 *
 * See `docs/playground/security.md` for the threat model and the
 * defense-in-depth rationale. See `docs/bun/phase-16-diagnostics/
 * playground-runtime.md §3` for the original design decisions.
 */

/**
 * Immutable runtime policy for a single playground execution. A single
 * frozen singleton — do not mutate at runtime.
 */
export const SECURITY_POLICY = Object.freeze({
  /**
   * Maximum wall-clock duration for a single run. Runs exceeding this are
   * aborted by the DO `alarm()` and the adapter emits a `{reason:"timeout"}`
   * error event. Keep in sync with `docs/playground/security.md §4.1`.
   */
  wallClockMs: 30_000,

  /**
   * CPU-time budget. Cloudflare Sandboxes bill on active-CPU — we cap below
   * the wall clock to catch tight loops that burn CPU but stay under the
   * wall. Exceeding this triggers a `{reason:"oom"|"timeout"}` exit.
   */
  cpuBudgetMs: 15_000,

  /**
   * Max stdout + stderr bytes streamed back to the front-end. Output past
   * this is truncated and the stream closes with an `{reason:"output-cap"}`
   * event. Prevents unbounded memory on the client + abuse vector where a
   * submission spams `console.log` to dodge Turnstile.
   */
  outputCapBytes: 64 * 1024,

  /**
   * Egress allowlist — any DNS name / CIDR NOT on this list is blocked by
   * the Worker's outbound proxy. Deliberately tiny: user code should
   * normally only talk to localhost (the sandbox itself).
   *
   * Do not add public hostnames here without a security review.
   */
  egressAllowlist: Object.freeze([
    "localhost",
    "127.0.0.1",
    // sandbox-self is expanded at runtime to `sbx-<id>.mandujs.dev`
    "sandbox-self",
  ] as const),

  /**
   * Memory cap, enforced by the container instance class. The sandbox's
   * `dev` instance (0.5 vCPU / 512 MiB) is our default — we set this
   * tighter at 256 MiB for playground runs.
   */
  memoryMib: 256,

  /**
   * Per-IP rate limit. After this many runs in a 15-minute window, the
   * Worker demands a fresh Turnstile token before accepting another POST.
   */
  runsBeforeTurnstile: 5,

  /** Window for the Turnstile threshold above. */
  turnstileWindowMs: 15 * 60_000,

  /**
   * Hard per-IP ceiling — once this is hit, the Worker returns 429 even
   * with a valid token. Catches credential-stuffing / bot farms.
   */
  runsPerHour: 20,

  /**
   * Timeout for the Turnstile siteverify HTTP call. Kept short — if CF's
   * challenge service is degraded, we fall open rather than hang user
   * requests (Turnstile is defense-in-depth, not the only line).
   */
  turnstileVerifyTimeoutMs: 3_000,
} as const);

/**
 * Truncate output to the configured cap. Returns `{ chunk, truncated }`.
 * Call sites should emit an `{reason:"output-cap"}` event when `truncated`
 * is `true` and stop forwarding further chunks.
 */
export function truncateOutput(
  accumulated: number,
  next: string
): { chunk: string; truncated: boolean; newTotal: number } {
  const remaining = SECURITY_POLICY.outputCapBytes - accumulated;
  if (remaining <= 0) {
    return { chunk: "", truncated: true, newTotal: accumulated };
  }
  const nextBytes = Buffer.byteLength(next, "utf8");
  if (nextBytes <= remaining) {
    return { chunk: next, truncated: false, newTotal: accumulated + nextBytes };
  }
  // Truncate on a UTF-8 safe boundary. Using `Buffer.from(str).slice(..)`
  // can split mid-codepoint; we slice the string by character count as a
  // safe over-estimate (UTF-8 is 1-4 bytes/char, so string.length >= bytes
  // for ASCII and bounded for multi-byte).
  const safe = next.slice(0, remaining);
  return {
    chunk: safe,
    truncated: true,
    newTotal: accumulated + Buffer.byteLength(safe, "utf8"),
  };
}

/**
 * Strip ANSI escape sequences (colors, cursor moves). User code may
 * deliberately emit terminal-only control sequences to garbage the
 * front-end display. Mandu's front-end renders plain text.
 *
 * The regex covers CSI sequences + OSC sequences + common single-char
 * controls. See https://en.wikipedia.org/wiki/ANSI_escape_code.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Check whether a hostname is on the egress allowlist. Used by the outbound
 * proxy. Normalizes case and trims trailing dot.
 */
export function isAllowedEgress(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return SECURITY_POLICY.egressAllowlist.some((allowed) => {
    if (allowed === normalized) return true;
    if (allowed === "sandbox-self" && normalized.startsWith("sbx-")) return true;
    return false;
  });
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint.
 *
 * **STUB / TODO**: This is the integration shape. The real key comes from
 * `env.TURNSTILE_SECRET` — operators set it via `wrangler secret put`.
 * See `docs/playground/deployment.md §4` for setup.
 *
 * Fails open (returns `true`) when `secret` is absent. This matches the
 * "degrade gracefully when CF challenge service is down" policy, but in
 * production `secret` MUST be configured — see `deployment.md` runbook.
 */
export async function verifyTurnstile(
  token: string | undefined,
  secret: string | undefined,
  clientIp?: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!secret) {
    // TODO(phase-16.2): Require secret in production. Log loud warning.
    return { valid: true, reason: "no-secret-configured" };
  }
  if (!token) {
    return { valid: false, reason: "missing-token" };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    SECURITY_POLICY.turnstileVerifyTimeoutMs
  );

  try {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (clientIp) body.append("remoteip", clientIp);

    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body, signal: controller.signal }
    );

    if (!response.ok) {
      return { valid: false, reason: `siteverify-${response.status}` };
    }
    const payload = (await response.json()) as { success?: boolean };
    return payload.success ? { valid: true } : { valid: false, reason: "rejected" };
  } catch (err) {
    // Fail closed on explicit network errors, fail open on abort so a slow
    // siteverify doesn't DOS legitimate users. Matches §4.3 policy.
    if (err instanceof Error && err.name === "AbortError") {
      return { valid: true, reason: "siteverify-timeout" };
    }
    return { valid: false, reason: "siteverify-error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a rate-limit key for the `RATE_LIMIT` KV namespace.
 * Format: `rl:<ip>:<minute-bucket>` — one KV entry per IP per minute.
 */
export function rateLimitKey(ip: string, bucketMs: number = 60_000): string {
  const bucket = Math.floor(Date.now() / bucketMs);
  return `rl:${ip}:${bucket}`;
}
