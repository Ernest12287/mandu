/**
 * Secure headers middleware tests
 *
 * Covers:
 *   - `buildCsp` directive merging + nonce interpolation
 *   - `secure` middleware plugin (beforeHandle/afterHandle) applied to a real
 *     `ManduContext` + `Response`, matching how the lifecycle would drive it
 *
 * Fixture style mirrors `tests/middleware/csrf.test.ts` and
 * `src/middleware/oauth/__tests__/oauth.test.ts`:
 *   - Real `Request` / `Response` / `ManduContext` — no mocks
 *   - Middleware is executed manually (before → handler → after) to simulate
 *     the Elysia-style lifecycle pipeline
 */
import { describe, it, expect } from "bun:test";
import {
  secure,
  buildCsp,
  applySecureHeadersToResponse,
  DEFAULT_CSP_DIRECTIVES,
  type SecureMiddlewareOptions,
  type CspOptions,
} from "../index";
import { ManduContext } from "../../../filling/context";
import type { MiddlewarePlugin } from "../../../filling/filling";

// ========== Helpers ==========

function makeReq(
  url: string,
  init: RequestInit & { cookie?: string } = {}
): Request {
  const { cookie, headers: rawHeaders, ...rest } = init;
  const headers = new Headers(rawHeaders as HeadersInit | undefined);
  if (cookie) headers.set("cookie", cookie);
  return new Request(url, { ...rest, headers });
}

function makeCtx(req: Request): ManduContext {
  return new ManduContext(req);
}

/**
 * Drive the full plugin pipeline:
 *   1. beforeHandle (may mutate ctx)
 *   2. handler produces a Response
 *   3. afterHandle (returns possibly-wrapped Response)
 */
async function runPlugin(
  plugin: MiddlewarePlugin,
  ctx: ManduContext,
  handler: (ctx: ManduContext) => Response | Promise<Response>
): Promise<Response> {
  if (plugin.beforeHandle) {
    const early = await plugin.beforeHandle(ctx);
    if (early instanceof Response) return early;
  }
  let res = await handler(ctx);
  if (plugin.afterHandle) {
    res = await plugin.afterHandle(ctx, res);
  }
  return res;
}

// ============================================
// buildCsp
// ============================================

describe("buildCsp", () => {
  it("emits default directives including default-src 'self'", () => {
    const built = buildCsp();
    expect(built.name).toBe("Content-Security-Policy");
    expect(built.header).toContain("default-src 'self'");
    expect(built.header).toContain("object-src 'none'");
    expect(built.header).toContain("frame-ancestors 'none'");
  });

  it("interpolates {NONCE} into script-src when nonce is enabled", () => {
    const built = buildCsp({ nonce: true });
    expect(built.nonce).toBeDefined();
    expect(built.nonce!.length).toBeGreaterThan(0);
    // The nonce should appear as part of a `'nonce-...'` token in script-src.
    const scriptSrcMatch = built.header.match(/script-src ([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    expect(scriptSrcMatch![1]).toContain(`'nonce-${built.nonce}'`);
    // Placeholder literal should NOT leak through.
    expect(built.header).not.toContain("{NONCE}");
  });

  it("reuses the same nonce across script-src and style-src", () => {
    const built = buildCsp({ nonce: true });
    const nonce = built.nonce!;
    const scriptMatch = built.header.match(/script-src [^;]*'nonce-([^']+)'/);
    const styleMatch = built.header.match(/style-src [^;]*'nonce-([^']+)'/);
    expect(scriptMatch).not.toBeNull();
    expect(styleMatch).not.toBeNull();
    expect(scriptMatch![1]).toBe(nonce);
    expect(styleMatch![1]).toBe(nonce);
  });

  it("accepts a caller-supplied literal nonce verbatim", () => {
    const built = buildCsp({ nonce: "mY-NoNcE_123" });
    expect(built.nonce).toBe("mY-NoNcE_123");
    expect(built.header).toContain("'nonce-mY-NoNcE_123'");
  });

  it("flips header name to Content-Security-Policy-Report-Only when reportOnly is set", () => {
    const built = buildCsp({ reportOnly: true });
    expect(built.name).toBe("Content-Security-Policy-Report-Only");
  });

  it("emits bare directive names for empty-array directives", () => {
    // `upgrade-insecure-requests` is a flag-style directive in defaults.
    const built = buildCsp();
    // Should appear as a standalone token, not as "upgrade-insecure-requests ".
    expect(built.header).toMatch(/\bupgrade-insecure-requests(;|$)/);
  });

  it("merges caller directives by replacing default values for that key", () => {
    const built = buildCsp({
      directives: { "default-src": ["'self'", "https://cdn.example.com"] },
    });
    expect(built.header).toContain("default-src 'self' https://cdn.example.com");
    // Other defaults must survive.
    expect(built.header).toContain("object-src 'none'");
  });

  it("preserves literal CSP keywords like 'self' and 'none' exactly", () => {
    const built = buildCsp({
      directives: { "script-src": ["'self'", "'none'", "'strict-dynamic'"] },
    });
    const match = built.header.match(/script-src ([^;]+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("'self' 'none' 'strict-dynamic'");
  });

  it("normalizes camelCase directive names to kebab-case", () => {
    const built = buildCsp({
      directives: { scriptSrc: ["'self'"], frameAncestors: ["'self'"] },
    });
    // Normalized directive names should land in the header.
    expect(built.header).toContain("script-src 'self'");
    expect(built.header).toContain("frame-ancestors 'self'");
    // And should NOT appear in their camelCase form.
    expect(built.header).not.toMatch(/\bscriptSrc\b/);
  });

  it("strips broken nonce tokens when nonce is disabled (defaults path)", () => {
    const built = buildCsp({ nonce: false });
    // No `'nonce-'` token should leak through from defaults.
    expect(built.header).not.toContain("'nonce-");
    // The surviving script-src must still list 'self' from defaults.
    expect(built.header).toContain("script-src 'self'");
    // Sanity: DEFAULT_CSP_DIRECTIVES declared a placeholder.
    expect(DEFAULT_CSP_DIRECTIVES["script-src"]).toContain("'nonce-{NONCE}'");
  });
});

// ============================================
// secure() middleware — default behavior
// ============================================

describe("secure middleware: defaults", () => {
  it("sets all expected default headers on the response", async () => {
    const plugin = secure();
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));

    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(res.headers.get("X-XSS-Protection")).toBe("0");
    // HSTS requires https — which the fixture uses.
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("omits the CSP header when csp: false", async () => {
    const plugin = secure({ csp: false });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("omits Strict-Transport-Security when hsts: false", async () => {
    const plugin = secure({ hsts: false });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("emits HSTS only for HTTPS requests", async () => {
    const plugin = secure();
    const httpCtx = makeCtx(makeReq("http://example.com/"));
    const httpRes = await runPlugin(plugin, httpCtx, (c) => c.ok({ ok: true }));
    expect(httpRes.headers.get("Strict-Transport-Security")).toBeNull();

    const httpsCtx = makeCtx(makeReq("https://example.com/"));
    const httpsRes = await runPlugin(plugin, httpsCtx, (c) => c.ok({ ok: true }));
    expect(httpsRes.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("respects x-forwarded-proto: https for HSTS emission", async () => {
    const plugin = secure();
    const req = makeReq("http://example.com/", {
      headers: { "x-forwarded-proto": "https" },
    });
    const res = await runPlugin(plugin, makeCtx(req), (c) => c.ok({ ok: true }));
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=15552000");
    expect(res.headers.get("Strict-Transport-Security")).toContain("includeSubDomains");
  });

  it("supports frameOptions: SAMEORIGIN", async () => {
    const plugin = secure({ frameOptions: "SAMEORIGIN" });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("omits X-Content-Type-Options when noSniff: false", async () => {
    const plugin = secure({ noSniff: false });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
  });

  it("applies a custom referrerPolicy value", async () => {
    const plugin = secure({ referrerPolicy: "no-referrer" });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("emits default Permissions-Policy with deny-by-default list", async () => {
    const plugin = secure();
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    const pp = res.headers.get("Permissions-Policy");
    expect(pp).toBeTruthy();
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
    expect(pp).toContain("geolocation=()");
    expect(pp).toContain("payment=()");
    expect(pp).toContain("usb=()");
    expect(pp).toContain("interest-cohort=()");
  });

  it("sets extra headers verbatim", async () => {
    const plugin = secure({
      extra: { "X-Custom-Header": "hello", "X-Build-Id": "abc123" },
    });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("X-Custom-Header")).toBe("hello");
    expect(res.headers.get("X-Build-Id")).toBe("abc123");
  });

  it("stashes the CSP nonce on ctx.get('csp-nonce') during request", async () => {
    const plugin = secure({ csp: { nonce: true } });
    const ctx = makeCtx(makeReq("https://example.com/"));

    let nonceDuringHandler: string | undefined;
    const res = await runPlugin(plugin, ctx, (c) => {
      nonceDuringHandler = c.get<string>("csp-nonce");
      return c.ok({ ok: true });
    });

    expect(nonceDuringHandler).toBeDefined();
    expect(nonceDuringHandler!.length).toBeGreaterThan(0);
    // Header must agree with the nonce the handler saw.
    const cspHeader = res.headers.get("Content-Security-Policy");
    expect(cspHeader).toContain(`'nonce-${nonceDuringHandler}'`);
  });

  it("preserves handler-set headers (e.g. Content-Type)", async () => {
    const plugin = secure();
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, () =>
      new Response("hi", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-App-Header": "keep-me" },
      })
    );
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-App-Header")).toBe("keep-me");
    // Secure headers still added alongside.
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("is idempotent — running the middleware twice yields the same headers", async () => {
    const plugin = secure();
    const ctx = makeCtx(makeReq("https://example.com/"));
    const firstPass = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    // Apply afterHandle a second time to simulate accidental double-wiring.
    const secondPass = await plugin.afterHandle!(ctx, firstPass);
    // Each unique header name should have exactly one value.
    const xfoValues = secondPass.headers.getSetCookie?.() ?? []; // no set-cookie involvement
    expect(xfoValues.length).toBe(0);
    expect(secondPass.headers.get("X-Frame-Options")).toBe("DENY");
    expect(secondPass.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // Verify CSP is a single header (not duplicated).
    const csp = secondPass.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    // The value should not contain a semicolon-doubled policy (rough smoke check).
    expect(csp!.split("default-src").length).toBe(2);
  });

  it("honors Report-Only mode via csp.reportOnly", async () => {
    const plugin = secure({ csp: { reportOnly: true } });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("allows disabling X-XSS-Protection via xssProtection: false", async () => {
    const plugin = secure({ xssProtection: false });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    expect(res.headers.get("X-XSS-Protection")).toBeNull();
  });

  it("supports custom HSTS maxAge + preload combo", async () => {
    const plugin = secure({
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    });
    const ctx = makeCtx(makeReq("https://example.com/"));
    const res = await runPlugin(plugin, ctx, (c) => c.ok({ ok: true }));
    const hsts = res.headers.get("Strict-Transport-Security");
    expect(hsts).toBe("max-age=63072000; includeSubDomains; preload");
  });
});

// ============================================
// Stand-alone applySecureHeadersToResponse
// ============================================

describe("applySecureHeadersToResponse", () => {
  it("wraps an arbitrary Response with the default header set", () => {
    const base = new Response("hello", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const { response } = applySecureHeadersToResponse(base, { hsts: false });
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
  });

  it("returns the generated nonce when csp.nonce: true", () => {
    const base = new Response(null, { status: 204 });
    const { nonce, response } = applySecureHeadersToResponse(base, {
      hsts: false,
      csp: { nonce: true },
    });
    expect(nonce).toBeDefined();
    expect(response.headers.get("Content-Security-Policy")).toContain(`'nonce-${nonce}'`);
  });
});
