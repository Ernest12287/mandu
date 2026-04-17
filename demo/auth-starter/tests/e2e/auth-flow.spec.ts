/**
 * End-to-end validation for the Phase 2 auth pipeline.
 *
 * Covers the full user journey (signup → dashboard → logout → login) plus
 * the edge cases that exercise each middleware: CSRF protection on a
 * direct API POST, a wrong-password path, and duplicate-email rejection.
 *
 * Each test uses its own Playwright context (default — one per test) so
 * cookies/sessions don't bleed between cases. Emails are randomized so
 * ordering within the file doesn't matter.
 */
import { test, expect, request as apiRequest } from "@playwright/test";

function freshEmail(prefix: string = "user"): string {
  // Keeps rerunning the spec repeatedly safe against the in-memory store
  // (which accumulates across test runs since we don't restart the server).
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

const STRONG_PASSWORD = "correct-horse-battery";
const ANOTHER_PASSWORD = "another-correct-horse";

test.describe("auth flow", () => {
  test("signup with fresh email lands on /dashboard with the email visible", async ({ page }) => {
    const email = freshEmail("signup-fresh");

    await page.goto("/signup");
    await expect(page.getByTestId("signup-form")).toBeVisible();

    await page.getByTestId("signup-email").fill(email);
    await page.getByTestId("signup-password").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-confirm").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-submit").click();

    await page.waitForURL("**/dashboard");
    await expect(page.getByTestId("dashboard-email")).toHaveText(email);
  });

  test("logout returns to / and re-protects /dashboard", async ({ page }) => {
    const email = freshEmail("logout");

    // Register + land on dashboard.
    await page.goto("/signup");
    await page.getByTestId("signup-email").fill(email);
    await page.getByTestId("signup-password").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-confirm").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-submit").click();
    await page.waitForURL("**/dashboard");

    // Log out via the dashboard's own button.
    await page.getByTestId("dashboard-logout").click();
    await page.waitForURL("**/");

    // Going back to /dashboard now redirects to /login.
    await page.goto("/dashboard");
    await page.waitForURL("**/login");
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("login with correct credentials lands on /dashboard", async ({ page }) => {
    const email = freshEmail("login-ok");

    // Seed the account.
    await page.goto("/signup");
    await page.getByTestId("signup-email").fill(email);
    await page.getByTestId("signup-password").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-confirm").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-submit").click();
    await page.waitForURL("**/dashboard");

    // Log out then log back in.
    await page.getByTestId("dashboard-logout").click();
    await page.waitForURL("**/");

    await page.goto("/login");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(STRONG_PASSWORD);
    await page.getByTestId("login-submit").click();

    await page.waitForURL("**/dashboard");
    await expect(page.getByTestId("dashboard-email")).toHaveText(email);
  });

  test("login with wrong password shows an error on /login (no session)", async ({ page }) => {
    const email = freshEmail("login-bad");

    // Seed account.
    await page.goto("/signup");
    await page.getByTestId("signup-email").fill(email);
    await page.getByTestId("signup-password").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-confirm").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-submit").click();
    await page.waitForURL("**/dashboard");

    await page.getByTestId("dashboard-logout").click();
    await page.waitForURL("**/");

    await page.goto("/login");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(ANOTHER_PASSWORD); // wrong
    await page.getByTestId("login-submit").click();

    // Bounces back to /login with ?error=...
    await page.waitForURL(/\/login\?/);
    await expect(page.getByTestId("login-error")).toBeVisible();

    // And /dashboard is still protected — we're not logged in.
    await page.goto("/dashboard");
    await page.waitForURL("**/login");
  });

  test("signup with an existing email shows the duplicate error", async ({ page }) => {
    const email = freshEmail("dup");

    // First signup succeeds.
    await page.goto("/signup");
    await page.getByTestId("signup-email").fill(email);
    await page.getByTestId("signup-password").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-confirm").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-submit").click();
    await page.waitForURL("**/dashboard");

    // Log out so the second attempt looks like a guest.
    await page.getByTestId("dashboard-logout").click();
    await page.waitForURL("**/");

    // Second signup with the same email should be rejected.
    await page.goto("/signup");
    await page.getByTestId("signup-email").fill(email);
    await page.getByTestId("signup-password").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-confirm").fill(STRONG_PASSWORD);
    await page.getByTestId("signup-submit").click();

    await page.waitForURL(/\/signup\?/);
    await expect(page.getByTestId("signup-error")).toBeVisible();
  });

  test("visiting /dashboard without a session redirects to /login", async ({ page }) => {
    // Fresh context — no cookies.
    await page.goto("/dashboard");
    await page.waitForURL("**/login");
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("direct POST to /api/login without CSRF token returns 403", async ({ baseURL }) => {
    // Uses a fresh request context with NO cookies, so neither the CSRF
    // cookie nor the form field token is present. The csrf() middleware
    // will reject with 403.
    const ctx = await apiRequest.newContext({ baseURL: baseURL ?? "http://localhost:3333" });
    try {
      const res = await ctx.post("/api/login", {
        form: {
          email: "whoever@example.test",
          password: "whatever",
          // intentionally no _csrf field
        },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(403);
    } finally {
      await ctx.dispose();
    }
  });
});
