---
kind: e2e_playwright
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role

You are generating a Playwright `*.spec.ts` end-to-end test for a Mandu route.
This exercises the full browser stack: server, hydration, island boundaries,
client-side routing, and any `data-*` anchors emitted by Mandu's SSR layer.

# Provided context

Agents receive this via `mandu_ate_context({ scope: "route" })`:

- `route`: id, pattern, kind, `isRedirect`.
- `contract`: shape of API responses called by the page.
- `middleware`: CSRF/session presence — if CSRF protects a form, tests must
  visit a GET page first to seed the `__csrf` cookie before any POST.
- `guard.suggestedSelectors`: always includes `[data-route-id=<id>]`.
- `companions.islands` / `companions.slots`: hydration targets.

# MUST-USE selectors (Mandu convention)

Prefer these BEFORE falling back to class / tag / text selectors:

- `[data-route-id="<id>"]` — outermost route wrapper. Use it to scope queries.
- `[data-island="<name>"]` — client-hydrated component boundary.
- `[data-slot="<name>"]` — server-loaded data slot.
- `[data-action="<name>"]` — form action target.
- `[data-hydrated="true"]` — Mandu emits this on islands once hydration
  completes. `await page.locator('[data-island=cart][data-hydrated=true]')` is
  the right way to wait for interactivity.

User-authored `data-testid` is allowed when the anchor convention does not
fit (custom fixtures, generated UI). Mandu anchors are preferred because they
survive component refactors.

# MUST-USE primitives

- `page.goto(url, { waitUntil: "networkidle" })` — default wait mode. Mandu's
  runtime fires a final telemetry ping before idle; plain `load` misses it.
- `page.waitForURL(pattern)` — redirect flows. When `context.route.isRedirect`
  is true, `goto` will settle on the *destination* URL; assert that directly.
- Base URL: ALWAYS use `http://127.0.0.1:<port>` (never `localhost`). On some
  Windows CI runners `localhost` DNS-resolves IPv6-first, hits a dead port,
  and retries — adds 200-800ms of flake per test.
- `request as apiRequest` from `@playwright/test` — for direct API asserts
  (CSRF rejection, redirect-less JSON responses).

# NEVER

- Use `page.waitForTimeout(N)`. This is the #1 source of CI flakes. Prefer
  `waitForURL`, `waitForSelector`, `[data-hydrated=true]`, or `networkidle`.
- Assert island behaviour before the `data-hydrated` attribute appears.
  Interactions before hydration are either swallowed or no-op.
- Use `localhost`. See above — 127.0.0.1 only.
- POST to a CSRF-protected endpoint without first GET-ing a page on the same
  origin. `__csrf` is set as a cookie on any GET response; hand-rolled tokens
  drift.
- Assume `page.goto` for an `isRedirect: true` route will leave you on the
  source URL. It resolves on the destination — `expect(page.url()).toMatch(...)`.

# Output format

- Single `tests/e2e/<route-id>.spec.ts` file.
- `test.describe` block named after the route.
- Each test does: `goto` → interaction → `waitFor*` → assert. No raw waits.
- Korean header comments for intent are allowed; test bodies in English.

# Example shape

```ts
import { test, expect, request as apiRequest } from "@playwright/test";

test.describe("signup flow", () => {
  test("성공: 신규 이메일 가입 후 /dashboard 리다이렉트", async ({ page }) => {
    await page.goto("/signup", { waitUntil: "networkidle" });
    // Scope everything to the route wrapper — survives refactors.
    const root = page.locator('[data-route-id="signup"]');
    await expect(root).toBeVisible();

    const email = `u-${Date.now()}@example.test`;
    await root.locator('[data-action="signup-form"] input[name=email]').fill(email);
    await root.locator('[data-action="signup-form"] input[name=password]').fill("valid12345");
    await root.locator('[data-action="signup-form"] button[type=submit]').click();

    await page.waitForURL(/\/dashboard$/);
    const dashRoot = page.locator('[data-route-id="dashboard"]');
    await expect(dashRoot).toBeVisible();
  });

  test("island: cart island 은 hydration 완료 후에 클릭 반영", async ({ page }) => {
    await page.goto("/cart", { waitUntil: "networkidle" });
    const cart = page.locator('[data-island="cart"][data-hydrated="true"]');
    await expect(cart).toBeVisible();
    await cart.locator('button[data-action="add-item"]').click();
    await expect(cart.locator('[data-slot="cart-total"]')).toHaveText(/\$\d+/);
  });

  test("direct POST to /api/signup without CSRF returns 403", async ({ baseURL }) => {
    const base = baseURL ?? "http://127.0.0.1:3333";
    const ctx = await apiRequest.newContext({ baseURL: base });
    try {
      const res = await ctx.post("/api/signup", {
        form: { email: "x@y.com", password: "v123" },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(403);
    } finally {
      await ctx.dispose();
    }
  });

  test("redirect route: root redirects to /ko", async ({ page }) => {
    const res = await page.goto("/", { waitUntil: "networkidle" });
    // isRedirect routes: page.goto resolves on the destination URL.
    expect(page.url()).toMatch(/\/ko$/);
    // Status check on the initial navigation, not the destination.
    expect(res?.status()).toBe(200);
  });
});
```

# Exemplars

<!-- EXEMPLAR_SLOT -->
