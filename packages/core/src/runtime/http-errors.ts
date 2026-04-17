/**
 * Module-level HTTP error helpers.
 *
 * These are the standalone counterparts to `ctx.unauthorized()`,
 * `ctx.forbidden()`, and `ctx.error()` on {@link ManduContext}. When a
 * caller is inside a filling handler the ctx methods are ergonomic —
 * they thread pending cookies through automatically. Outside the ctx
 * (e.g. plain utilities, middleware composition, SSR loaders that
 * prefer `return` over `ctx.json`), these module-level functions mint
 * the same shape directly.
 *
 * ## Design notes
 *
 *   - `unauthorized()` sets `WWW-Authenticate: Bearer` per RFC 7235 so
 *     browsers/proxies know a scheme. Opt out by passing a custom
 *     `WWW-Authenticate` header (or `null` via `{ headers }`).
 *   - `forbidden()` is JSON by default (same shape as `ctx.forbidden()`).
 *   - `badRequest()` accepts either a string (→ simple error body) or a
 *     `{ message, errors }` object for structured validation failures.
 *   - All three merge caller-provided headers via `new Headers(init)`
 *     semantics — later keys win, which matches Response constructor.
 *
 * The returned Response is plain — no brand symbol. Unlike `redirect()`
 * / `notFound()`, these do not short-circuit the SSR pipeline; they are
 * terminal API responses and the caller is expected to return them up.
 */

/** Shape of the JSON body for `badRequest()` when given an object. */
export interface BadRequestBody {
  /** Human-readable message. Required. */
  message: string;
  /** Optional structured validation detail (e.g. per-field errors). */
  errors?: unknown;
}

/**
 * 401 Unauthorized. Sets `WWW-Authenticate: Bearer` by default so clients
 * know the expected auth scheme. To override, pass a custom header via
 * `options.headers`:
 *
 * ```ts
 * unauthorized("Token expired", { headers: { "WWW-Authenticate": 'Basic realm="app"' } });
 * ```
 *
 * Body is JSON: `{ error: "Unauthorized" }` (or the provided `message`).
 */
export function unauthorized(message?: string, options: ResponseInit = {}): Response {
  const body = JSON.stringify({ error: message ?? "Unauthorized" });
  const headers = new Headers(options.headers);
  if (!headers.has("WWW-Authenticate")) {
    headers.set("WWW-Authenticate", "Bearer");
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(body, {
    status: 401,
    statusText: options.statusText,
    headers,
  });
}

/**
 * 403 Forbidden. JSON body: `{ error: string }`.
 *
 * Use this when the client is authenticated but not authorised for the
 * resource (contrast with {@link unauthorized}, which signals a missing
 * or invalid credential).
 */
export function forbidden(message?: string, options: ResponseInit = {}): Response {
  const body = JSON.stringify({ error: message ?? "Forbidden" });
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(body, {
    status: 403,
    statusText: options.statusText,
    headers,
  });
}

/**
 * 400 Bad Request. Accepts either a plain string or a `{ message, errors }`
 * object. In both cases the response body is JSON.
 *
 * - `badRequest("invalid id")` → `{ "error": "invalid id" }`
 * - `badRequest({ message: "validation failed", errors: { email: ["required"] } })`
 *   → `{ "error": "validation failed", "errors": { "email": ["required"] } }`
 *
 * The top-level key is always `error` (string), matching `ctx.error()` in
 * `filling/context.ts`. Structured `errors` is passed through untouched —
 * callers decide the shape (Zod flatten, per-field map, etc.).
 */
export function badRequest(
  input: string | BadRequestBody = "Bad Request",
  options: ResponseInit = {}
): Response {
  const body =
    typeof input === "string"
      ? { error: input }
      : { error: input.message, ...(input.errors !== undefined ? { errors: input.errors } : {}) };

  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(body), {
    status: 400,
    statusText: options.statusText,
    headers,
  });
}
