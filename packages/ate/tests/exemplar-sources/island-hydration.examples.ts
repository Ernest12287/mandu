/**
 * Phase C.5 — tagged exemplars for `island_hydration` prompt kind.
 * These are reference patterns, not executed tests.
 */

// @ate-exemplar: kind=island_hydration depth=basic tags=visible,hydrates
test("Cart island becomes hydrated within budget", async ({ page }) => {
  await page.goto("/cart");
  await waitForIsland(page, "Cart", { timeoutMs: 3000 });
  await expect(page.locator('[data-island="Cart"][data-hydrated="true"]')).toBeVisible();
});

// @ate-exemplar: kind=island_hydration depth=advanced tags=none,short-circuit
test("hydration:none island resolves immediately", async ({ page }) => {
  await page.goto("/legal");
  await waitForIsland(page, "LegalNotice");
  await expect(page.locator('[data-island="LegalNotice"]')).toBeVisible();
});

// @ate-exemplar: kind=island_hydration depth=basic tags=interaction,post-hydration
test("Counter island increments after hydration completes", async ({ page }) => {
  await page.goto("/counter");
  await waitForIsland(page, "Counter", { timeoutMs: 3000 });
  await page.getByTestId("counter-plus").click();
  await expect(page.getByTestId("counter-value")).toHaveText("1");
});

// @ate-exemplar: kind=island_hydration depth=edge tags=timeout,budget
test("reports hydration_timeout when island is wedged", async ({ page }) => {
  await page.goto("/slow");
  await expect(
    waitForIsland(page, "NeverHydrates", { timeoutMs: 100 }),
  ).rejects.toThrow(/hydration_timeout/);
});
