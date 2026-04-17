/**
 * Content-Security-Policy builder
 *
 * Standalone because CSP has many directives, user overrides need to merge
 * deterministically with defaults, and per-request nonce interpolation needs
 * a single authoritative code path so `script-src` and `style-src` are
 * guaranteed to share the same nonce (OWASP recommendation — one nonce per
 * request, reused across directives).
 *
 * Consumers:
 *   - `secure()` middleware (via `buildCsp`)
 *   - Callers who want ONLY CSP (public re-export from the secure barrel)
 *
 * @see https://www.w3.org/TR/CSP3/
 * @see https://owasp.org/www-project-secure-headers/
 */

// ========== Types ==========

export interface CspOptions {
  /** Directive map. Values are joined with space. Merged over defaults. */
  directives?: Record<string, string[]>;
  /** When true, emits `Content-Security-Policy-Report-Only` instead. */
  reportOnly?: boolean;
  /**
   * Nonce source:
   *   - `true`  → generate a fresh 128-bit random nonce per call
   *   - string  → use the provided literal nonce value (must be base64url-safe)
   *   - `false` / undefined → no nonce; any `{NONCE}` placeholder is stripped
   */
  nonce?: boolean | string | false;
}

export interface BuiltCsp {
  /** Final header value. */
  header: string;
  /** Which header name to set. */
  name: "Content-Security-Policy" | "Content-Security-Policy-Report-Only";
  /** Populated only when `nonce` resolved to a concrete value. */
  nonce?: string;
}

// ========== Defaults ==========

/**
 * Production-safe SSR + islands defaults.
 *
 * Key choices:
 *   - `'strict-dynamic'` on `script-src` means: once a trusted nonce-authorized
 *     script loads, further scripts it creates inherit trust. This allows
 *     hydration bundles to lazy-load chunks without reloading their nonce.
 *     Modern browsers (CSP 3+) honor this; older browsers fall back to the
 *     nonce allowlist, which still works for the SSR-emitted scripts.
 *   - `frame-ancestors 'none'` supersedes `X-Frame-Options: DENY` for modern
 *     browsers. We still emit XFO for legacy clients.
 *   - `upgrade-insecure-requests` silently rewrites `http:` subresources to
 *     `https:`. Safe default for modern apps; cheap insurance against mixed
 *     content from third-party embeds.
 *   - NO `'unsafe-inline'` / `'unsafe-eval'`. If your app needs them, opt in
 *     explicitly via `directives` — don't let them sneak in as defaults.
 */
export const DEFAULT_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "default-src": ["'self'"],
  "script-src": ["'self'", "'nonce-{NONCE}'", "'strict-dynamic'"],
  "style-src": ["'self'", "'nonce-{NONCE}'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
  "img-src": ["'self'", "data:", "https:"],
  "connect-src": ["'self'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "object-src": ["'none'"],
  "upgrade-insecure-requests": [],
});

/** Placeholder literal that `buildCsp` rewrites to the real nonce value. */
export const NONCE_PLACEHOLDER = "{NONCE}";

// ========== Public API ==========

/**
 * Build a single `Content-Security-Policy` header from defaults + overrides.
 *
 * Merge semantics:
 *   - User-supplied directives REPLACE the default values for that directive
 *     (caller owns the full value list). We do not concatenate, because CSP
 *     parsing is order-sensitive and partial merges surprise callers.
 *   - Directive names are normalized to lowercase-kebab. Caller may supply
 *     either `"script-src"` or `"scriptSrc"`; both map to `script-src`.
 *   - Empty-array directives emit as bare directive names (e.g.
 *     `upgrade-insecure-requests`) — required by the CSP grammar for flag
 *     directives.
 *
 * Nonce handling:
 *   - If `nonce === true`, we generate a per-call nonce via
 *     `crypto.getRandomValues` (16 bytes → 128 bits of entropy, base64url).
 *   - If `nonce === string`, we trust the caller's value verbatim. Useful for
 *     integrating with a pre-existing per-request nonce generator.
 *   - The SAME nonce is substituted into every `{NONCE}` occurrence across
 *     ALL directives (script-src, style-src, ...). Per OWASP guidance.
 *   - If no nonce, `{NONCE}` placeholders are stripped along with their
 *     surrounding `'nonce-...'` wrapper to avoid emitting broken tokens.
 */
export function buildCsp(options: CspOptions = {}): BuiltCsp {
  const nonce = resolveNonce(options.nonce);

  // Normalize + merge.
  const merged: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(DEFAULT_CSP_DIRECTIVES)) {
    merged[normalizeDirectiveName(k)] = [...v];
  }
  if (options.directives) {
    for (const [k, v] of Object.entries(options.directives)) {
      if (!Array.isArray(v)) continue;
      merged[normalizeDirectiveName(k)] = [...v];
    }
  }

  const parts: string[] = [];
  for (const [name, values] of Object.entries(merged)) {
    const processed = values
      .map((v) => interpolateNonce(v, nonce))
      // Strip broken nonce tokens when no nonce was produced.
      .filter((v): v is string => v !== null);

    if (processed.length === 0) {
      // Flag-style directive (no value list) — emit bare name.
      parts.push(name);
    } else {
      parts.push(`${name} ${processed.join(" ")}`);
    }
  }

  return {
    header: parts.join("; "),
    name: options.reportOnly
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy",
    nonce,
  };
}

// ========== Internal ==========

/**
 * Resolve the `nonce` option to a concrete string (or undefined for "off").
 * Generation uses `crypto.getRandomValues` rather than `crypto.randomUUID`
 * to match OWASP's recommendation of ≥128 bits of entropy with raw random
 * bytes (UUIDs have lower effective entropy due to version/variant bits).
 */
function resolveNonce(opt: CspOptions["nonce"]): string | undefined {
  if (opt === true) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  }
  if (typeof opt === "string" && opt.length > 0) {
    return opt;
  }
  return undefined;
}

/**
 * Replace `{NONCE}` in a single directive value.
 *
 * Returns `null` to signal "this value depended on a nonce that was never
 * produced — drop it entirely" so callers don't emit `'nonce-'` (broken
 * token). Returns the original value when no placeholder is present.
 */
function interpolateNonce(value: string, nonce: string | undefined): string | null {
  if (!value.includes(NONCE_PLACEHOLDER)) return value;
  if (!nonce) return null;
  return value.split(NONCE_PLACEHOLDER).join(nonce);
}

/**
 * Accepts `"scriptSrc"` / `"script-src"` / `"Script-Src"` → `"script-src"`.
 * camelCase → kebab-case via the standard regex; already-kebab inputs are
 * lowercased without further transformation.
 */
function normalizeDirectiveName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
