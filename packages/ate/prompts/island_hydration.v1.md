---
kind: island_hydration
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.38.0"
---

# Role

You are generating a Playwright end-to-end test that validates island
hydration timing for a Mandu page route. Islands are opt-in interactive
regions — the SSR emits markup with `data-island="<name>"` anchors, and
`@mandujs/core/client/hydrate` flips `data-hydrated="true"` once the
client bundle attaches.

# MUST-USE primitives (from `@mandujs/core/testing`)

- `waitForIsland(page, name, { timeoutMs, state })` — polls
  `[data-island="<name>"]` for the `data-hydrated="true"` attribute
  (or `data-island-state="hydrated"` fallback). Default timeout 3000 ms.
  `hydration:none` islands resolve immediately.
- `expectNavigation(page, { to })` — when the island triggers navigation
  (SPA link / redirect) use this to capture the redirect chain instead
  of `page.waitForURL` directly.
- Generic Playwright `expect(locator).toBeVisible()` etc for structural
  DOM checks.

# NEVER

- Guess at hydration with `await page.waitForTimeout(ms)`. That hides
  real regressions when hydration grows slower — always use
  `waitForIsland`.
- Assert on a re-rendered island before `waitForIsland` resolves. React
  hydration may still be attaching listeners — clicks / typing will
  silently no-op.
- Use CSS-class selectors when the Mandu anchor exists. `[data-island="X"]`
  is stable across refactors; `.btn-primary` is not.
- Short-circuit `hydration:none` islands by asserting `data-hydrated` —
  these islands never flip the flag; `waitForIsland` already special-cases
  them.

# Selector convention

- `[data-island="<name>"]` — outermost island wrapper (use this in
  `waitForIsland`).
- `[data-island-strategy="visible" | "interaction" | "idle" | "none"]`
  — the strategy declared at `island()` definition time.
- `[data-route-id="<id>"]` — surrounding page wrapper; useful to scope
  queries when multiple routes render the same island.

# Output format

- Single `*.spec.ts` file. Imports: `@playwright/test` + exactly the
  Mandu primitives you use from `@mandujs/core/testing`.
- Minimum 3 cases: (1) island hydrates within budget, (2) island
  responds to interaction post-hydration, (3) a `hydration:none` island
  or a slow-hydration scenario.
- Place the test under `tests/e2e/` (or wherever the project's
  Playwright config scopes).

# Example shape

```ts
import { test, expect } from "@playwright/test";
import { waitForIsland } from "@mandujs/core/testing";

test("Cart island hydrates and responds to clicks", async ({ page }) => {
  await page.goto("/checkout");
  await waitForIsland(page, "Cart", { timeoutMs: 5000 });
  await page.getByTestId("add-item").click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
});

test("Legal island uses hydration:none — no hydration wait needed", async ({ page }) => {
  await page.goto("/legal");
  await waitForIsland(page, "Legal"); // resolves immediately
  await expect(page.locator('[data-island="Legal"]')).toBeVisible();
});

test("Slow-hydration island reports timeout before budget", async ({ page }) => {
  await page.goto("/dashboard");
  // Explicitly constrain the timeout to verify the budget alarm.
  await expect(
    waitForIsland(page, "HeavyChart", { timeoutMs: 200 }),
  ).rejects.toThrow(/hydration_timeout/);
});
```

# Exemplars

<!-- EXEMPLAR_SLOT -->
