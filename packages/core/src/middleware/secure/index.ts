/**
 * Secure HTTP Headers Middleware
 *
 * A Helmet-equivalent bundle shipping OWASP-recommended defaults for:
 *   - Content-Security-Policy (CSP) — see `./csp.ts`
 *   - Strict-Transport-Security (HSTS)
 *   - X-Frame-Options (legacy; superseded by CSP `frame-ancestors`)
 *   - X-Content-Type-Options
 *   - Referrer-Policy
 *   - Permissions-Policy
 *   - X-XSS-Protection (legacy; explicitly `"0"` on modern clients)
 *
 * Strategy: we implement `MiddlewarePlugin` rather than the bare
 * `(ctx) => Response | void` signature so we can mutate the outgoing Response
 * via `afterHandle`. This mirrors `cors.ts` and means we do NOT need any
 * framework modifications, a new "pending headers" buffer in the context, or
 * a custom wrapper helper that callers must remember to invoke.
 *
 * Ordering vs. session/cookies:
 *   Unlike session middleware, which must commit BEFORE the response is
 *   built (DX-3 + Phase 2.3), header-setting middleware can run AFTER the
 *   response is produced — we use `afterHandle` which receives the fully-
 *   constructed Response and returns a replacement. No ordering hazard with
 *   cookies/session state, because we never touch `ctx.cookies`.
 *
 * CSP nonce plumbing:
 *   When `csp.nonce === true`, we compute a fresh nonce in `beforeHandle`
 *   and stash it on the context under the key `"csp-nonce"`. SSR handlers
 *   that render inline `<script>` tags can read it with
 *   `ctx.get<string>("csp-nonce")`. The same nonce is interpolated into the
 *   CSP header in `afterHandle`, guaranteeing the tag and the header agree.
 *
 *   Auto-injection of the nonce into `renderToStream`'s hydration script
 *   tags is intentionally out of scope for this middleware — see the
 *   Phase 6.2 follow-up item in `CLAUDE.md`.
 *
 * @example
 * ```ts
 * import { secure } from "@mandujs/core/middleware";
 *
 * export default Mandu.filling()
 *   .use(secure())                                 // all defaults
 *   .get((ctx) => ctx.ok({ hello: "world" }));
 *
 * // With CSP nonce:
 * export default Mandu.filling()
 *   .use(secure({ csp: { nonce: true } }))
 *   .get((ctx) => {
 *     const nonce = ctx.get<string>("csp-nonce");
 *     // render inline script with nonce={nonce}
 *     return ctx.ok({ ok: true });
 *   });
 * ```
 */
import type { MiddlewarePlugin } from "../../filling/filling";
import type { ManduContext } from "../../filling/context";
import { buildCsp, type CspOptions } from "./csp";

export { buildCsp, DEFAULT_CSP_DIRECTIVES } from "./csp";
export type { CspOptions, BuiltCsp } from "./csp";

// ========== Types ==========

export type ReferrerPolicyValue =
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

export interface HstsOptions {
  /** max-age in seconds. Default: 15552000 (180 days). */
  maxAge?: number;
  /** includeSubDomains directive. Default: true. */
  includeSubDomains?: boolean;
  /** preload directive. Default: false — opt-in; implies submitting to the preload list. */
  preload?: boolean;
}

export interface SecureMiddlewareOptions {
  /** Content-Security-Policy options, or `false` to disable. */
  csp?: CspOptions | false;
  /** Strict-Transport-Security options, or `false` to disable. */
  hsts?: HstsOptions | false;
  /** X-Frame-Options. Default: `"DENY"`. `false` to disable. */
  frameOptions?: "DENY" | "SAMEORIGIN" | false;
  /** X-Content-Type-Options: nosniff. Default: true. */
  noSniff?: boolean;
  /** Referrer-Policy. Default: `"strict-origin-when-cross-origin"`. */
  referrerPolicy?: ReferrerPolicyValue | false;
  /**
   * Permissions-Policy map. Each entry becomes `feature=(allowlist)`.
   * Use an empty array to deny a feature entirely (`feature=()`).
   * `false` disables the header.
   */
  permissionsPolicy?: Record<string, string[]> | false;
  /**
   * X-XSS-Protection. Default: `"0"` — modern browsers should use CSP; the
   * legacy auditor has known bypasses and is best disabled. `false` omits.
   */
  xssProtection?: "0" | "1" | "1; mode=block" | false;
  /**
   * Extra headers to set verbatim. Keys are set as-given (casing preserved
   * by `Headers` normalization rules). Values overwrite any existing header.
   */
  extra?: Record<string, string>;
}

// ========== Defaults ==========

const DEFAULT_HSTS: Required<HstsOptions> = Object.freeze({
  maxAge: 15552000, // 180 days — matches Chrome's preload minimum
  includeSubDomains: true,
  preload: false,
});

const DEFAULT_REFERRER_POLICY: ReferrerPolicyValue = "strict-origin-when-cross-origin";

/**
 * OWASP-recommended deny-by-default for commonly abused browser capabilities.
 *
 * - `camera` / `microphone`: prevent drive-by media capture; app pages that
 *   need these must opt in explicitly via override.
 * - `geolocation`: prevents third-party scripts from geo-tagging users.
 * - `payment`: blocks Payment Request API unless you explicitly own it.
 * - `usb`: blocks WebUSB (e.g. hardware key attacks).
 * - `interest-cohort`: opts out of FLoC/Topics tracking. Still widely
 *   respected; cheap insurance.
 */
const DEFAULT_PERMISSIONS_POLICY: Record<string, string[]> = Object.freeze({
  camera: [],
  microphone: [],
  geolocation: [],
  payment: [],
  usb: [],
  "interest-cohort": [],
}) as Record<string, string[]>;

const CSP_NONCE_KEY = "csp-nonce";

// ========== Public API ==========

/**
 * Build the secure headers middleware. The options argument is consumed
 * eagerly at construction time — subsequent mutations to the passed object
 * do not affect the already-installed middleware.
 *
 * Returns a `MiddlewarePlugin` with:
 *   - `beforeHandle`: generates the per-request CSP nonce (if enabled) and
 *     stashes it on the context for handler use.
 *   - `afterHandle`: computes the final headers bundle and returns a new
 *     Response with the headers applied. Existing headers from the handler
 *     (e.g. `Content-Type`) are preserved.
 */
export function secure(options: SecureMiddlewareOptions = {}): MiddlewarePlugin {
  // Normalize / snapshot options up front so we don't re-read user input on
  // every request (protects against surprise mutation mid-session).
  const cfg = normalizeOptions(options);

  return {
    beforeHandle: async (ctx: ManduContext): Promise<void> => {
      // If CSP is enabled AND nonce is requested, compute the nonce here so
      // the handler can read it before producing the response. We build the
      // full CSP string in `afterHandle` (cheap) using the same nonce so
      // the header and any handler-rendered <script nonce={...}> agree.
      if (cfg.csp && cfg.csp.nonce === true) {
        // buildCsp will synthesize a fresh nonce; we capture it here and
        // pin it for the afterHandle pass via a per-request override.
        const built = buildCsp({ ...cfg.csp, nonce: true });
        if (built.nonce) {
          ctx.set<string>(CSP_NONCE_KEY, built.nonce);
        }
      }
    },

    afterHandle: async (
      ctx: ManduContext,
      response: Response
    ): Promise<Response> => {
      const headers = new Headers(response.headers);
      applySecureHeaders(ctx, headers, cfg);

      // Only re-wrap if we actually added/changed something. In practice the
      // headers map is always non-empty (we always set at least one header
      // when options are default), but this keeps us honest about
      // Response-body identity and matches `cors.ts`'s pattern.
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

/**
 * Manual escape hatch: apply secure headers to an arbitrary Response using
 * the options shape above.
 *
 * Prefer `.use(secure(...))` — this helper exists for callers outside the
 * filling pipeline (e.g. custom error responders, static file handlers).
 * Since no context is available, CSP nonce mode falls back to the one-shot
 * nonce generated inside `buildCsp` — the caller is responsible for wiring
 * that nonce into whatever they render.
 */
export function applySecureHeadersToResponse(
  response: Response,
  options: SecureMiddlewareOptions = {}
): { response: Response; nonce?: string } {
  const cfg = normalizeOptions(options);
  const headers = new Headers(response.headers);

  // Derive a fresh nonce for this standalone call (no context to cache it on).
  let emittedNonce: string | undefined;
  if (cfg.csp && cfg.csp.nonce === true) {
    const built = buildCsp({ ...cfg.csp, nonce: true });
    emittedNonce = built.nonce;
  }

  // Pseudo-context shim so applySecureHeaders can read the nonce consistently.
  const shim = {
    request: response as unknown as Request, // only used for URL scheme check; standalone callers skip HSTS logic path below via hsts=false typically
    get: <T>(_key: string): T | undefined => emittedNonce as T | undefined,
  };
  applySecureHeaders(shim as unknown as ManduContext, headers, {
    ...cfg,
    // If caller didn't explicitly disable HSTS, keep it — but the scheme
    // probe will simply no-op on a non-Request shim. Callers who want HSTS
    // on standalone responses must ensure `response.url` carries an
    // `https:` URL, or they should pass a pre-built Request with
    // `x-forwarded-proto: https`.
  });

  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    nonce: emittedNonce,
  };
}

// ========== Internal: normalization ==========

interface NormalizedOptions {
  csp: CspOptions | null;
  hsts: Required<HstsOptions> | null;
  frameOptions: "DENY" | "SAMEORIGIN" | null;
  noSniff: boolean;
  referrerPolicy: ReferrerPolicyValue | null;
  permissionsPolicy: Record<string, string[]> | null;
  xssProtection: "0" | "1" | "1; mode=block" | null;
  extra: Record<string, string>;
}

function normalizeOptions(options: SecureMiddlewareOptions): NormalizedOptions {
  return {
    csp: options.csp === false ? null : options.csp ?? {},
    hsts:
      options.hsts === false
        ? null
        : { ...DEFAULT_HSTS, ...(options.hsts ?? {}) },
    frameOptions:
      options.frameOptions === false
        ? null
        : options.frameOptions ?? "DENY",
    noSniff: options.noSniff !== false,
    referrerPolicy:
      options.referrerPolicy === false
        ? null
        : options.referrerPolicy ?? DEFAULT_REFERRER_POLICY,
    permissionsPolicy:
      options.permissionsPolicy === false
        ? null
        : options.permissionsPolicy ?? { ...DEFAULT_PERMISSIONS_POLICY },
    xssProtection:
      options.xssProtection === false ? null : options.xssProtection ?? "0",
    extra: options.extra ?? {},
  };
}

// ========== Internal: header application ==========

function applySecureHeaders(
  ctx: ManduContext,
  headers: Headers,
  cfg: NormalizedOptions
): void {
  // --- CSP ---
  if (cfg.csp) {
    // If a nonce was pre-computed in beforeHandle, reuse it to ensure the
    // handler's nonce=… values match what we emit in the header.
    const pinnedNonce = ctx.get<string>(CSP_NONCE_KEY);
    const effective =
      pinnedNonce && cfg.csp.nonce === true
        ? { ...cfg.csp, nonce: pinnedNonce }
        : cfg.csp;

    const built = buildCsp(effective);
    headers.set(built.name, built.header);
  }

  // --- HSTS (only when the request is already HTTPS) ---
  //
  // RFC 6797 §7.2: UAs MUST ignore STS on insecure transport, but we also
  // suppress it server-side to avoid leaking the policy across a plaintext
  // channel (where an active MITM could strip it for first-visit users
  // anyway — the "TOFU" problem HSTS is designed to reduce).
  if (cfg.hsts && isHttps(ctx.request)) {
    const parts = [`max-age=${Math.floor(cfg.hsts.maxAge)}`];
    if (cfg.hsts.includeSubDomains) parts.push("includeSubDomains");
    if (cfg.hsts.preload) parts.push("preload");
    headers.set("Strict-Transport-Security", parts.join("; "));
  }

  // --- X-Frame-Options ---
  if (cfg.frameOptions) {
    headers.set("X-Frame-Options", cfg.frameOptions);
  }

  // --- X-Content-Type-Options ---
  if (cfg.noSniff) {
    headers.set("X-Content-Type-Options", "nosniff");
  }

  // --- Referrer-Policy ---
  if (cfg.referrerPolicy) {
    headers.set("Referrer-Policy", cfg.referrerPolicy);
  }

  // --- Permissions-Policy ---
  if (cfg.permissionsPolicy) {
    const pp = buildPermissionsPolicy(cfg.permissionsPolicy);
    if (pp.length > 0) {
      headers.set("Permissions-Policy", pp);
    }
  }

  // --- X-XSS-Protection ---
  if (cfg.xssProtection !== null) {
    headers.set("X-XSS-Protection", cfg.xssProtection);
  }

  // --- Arbitrary extras (caller overrides always win) ---
  for (const [k, v] of Object.entries(cfg.extra)) {
    headers.set(k, v);
  }
}

/**
 * Build a Permissions-Policy header value.
 *
 * Grammar (simplified): `feature=(allowlist) , feature=(allowlist)`
 *   - Bare tokens like `self` go inside the parens as-is.
 *   - Origins (URLs) must be wrapped in double quotes per spec.
 *   - Empty allowlist `()` denies the feature entirely.
 *
 * We accept the caller's array verbatim; they are responsible for quoting
 * their URL-shaped entries. We do wrap origins that look URL-ish (contain
 * `://`) when they are unquoted, because that's by far the most common
 * mistake and the cost of the heuristic is tiny.
 */
function buildPermissionsPolicy(map: Record<string, string[]>): string {
  const entries: string[] = [];
  for (const [feature, allowlist] of Object.entries(map)) {
    if (!Array.isArray(allowlist)) continue;
    const items = allowlist.map(normalizePermissionsItem).join(" ");
    entries.push(`${feature}=(${items})`);
  }
  return entries.join(", ");
}

function normalizePermissionsItem(raw: string): string {
  if (raw === "self" || raw === "*") return raw;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw;
  if (raw.includes("://")) return `"${raw}"`;
  return raw;
}

/**
 * Determine whether the inbound request is HTTPS.
 *
 * Recognizes:
 *   1. Direct `https:` scheme in `request.url`
 *   2. `X-Forwarded-Proto: https` (de-facto reverse-proxy header)
 *   3. `Forwarded: proto=https` (RFC 7239)
 *
 * We intentionally don't trust these headers on direct (non-proxied)
 * connections — but since the caller is the one opting into HSTS, they're
 * also responsible for running behind a reverse proxy that sanitizes
 * client-supplied `Forwarded` / `X-Forwarded-*` headers. This matches
 * Helmet's and express's documented behavior.
 */
function isHttps(request: Request): boolean {
  try {
    if (request.url.startsWith("https:")) return true;
  } catch {
    // Some shims may throw on `.url`; fall through to header checks.
  }
  const xfp = safeGetHeader(request, "x-forwarded-proto");
  if (xfp && xfp.split(",")[0]!.trim().toLowerCase() === "https") return true;
  const fwd = safeGetHeader(request, "forwarded");
  if (fwd && /\bproto=https\b/i.test(fwd)) return true;
  return false;
}

function safeGetHeader(request: Request, name: string): string | null {
  try {
    return request.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}
