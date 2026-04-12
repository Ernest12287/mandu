import type { InteractionNode, OracleLevel } from "./types";
import { detectDomain, type AppDomain } from "./domain-detector";

export interface OracleResult {
  level: OracleLevel;
  l0: { ok: boolean; errors: string[] };
  l1: { ok: boolean; signals: string[] };
  l2: { ok: boolean; signals: string[] };
  l3: { ok: boolean; notes: string[] };
}

export function createDefaultOracle(level: OracleLevel): OracleResult {
  return {
    level,
    l0: { ok: true, errors: [] },
    l1: { ok: level !== "L0", signals: [] },
    l2: { ok: true, signals: [] },
    l3: { ok: true, notes: [] },
  };
}

/**
 * Generate L1 assertions based on detected domain
 */
export function generateL1Assertions(domain: AppDomain, routePath: string): string[] {
  const assertions: string[] = [];

  // Common structural assertions for all domains
  assertions.push(`// L1: Domain-aware structure signals (${domain})`);
  assertions.push(`await expect(page.locator("main, [role='main']")).toBeVisible();`);

  switch (domain) {
    case "ecommerce":
      if (routePath.includes("/cart")) {
        assertions.push(`await expect(page.locator("[data-testid='cart-items'], .cart-item, [class*='cart']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("button:has-text('Checkout'), button:has-text('Proceed')")).toBeVisible();`);
      } else if (routePath.includes("/product")) {
        assertions.push(`await expect(page.locator("h1, [data-testid='product-title']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("button:has-text('Add to Cart'), button[class*='add']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("[data-testid='price'], .price, [class*='price']")).toBeVisible();`);
      } else if (routePath.includes("/checkout")) {
        assertions.push(`await expect(page.locator("form, [data-testid='checkout-form']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("input[type='email'], input[name*='email']")).toBeVisible();`);
      } else if (routePath.includes("/shop")) {
        assertions.push(`await expect(page.locator("[data-testid='product-card'], .product, [class*='product']")).toHaveCount({ min: 1 });`);
        assertions.push(`await expect(page.locator("a[href*='/product'], [data-testid='product-link']")).toHaveCount({ min: 1 });`);
      } else {
        // Generic ecommerce page fallback
        assertions.push(`await expect(page.locator("nav, [role='navigation']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("a, button")).toHaveCount({ min: 1 });`);
      }
      break;

    case "blog":
      if (routePath.includes("/post") || routePath.includes("/article")) {
        assertions.push(`await expect(page.locator("article, [role='article']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("h1, [data-testid='post-title']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("[data-testid='post-content'], .content, [class*='content']")).toBeVisible();`);
      } else if (routePath.includes("/author")) {
        assertions.push(`await expect(page.locator("[data-testid='author-name'], .author")).toBeVisible();`);
        assertions.push(`await expect(page.locator("[data-testid='author-posts'], .posts")).toBeVisible();`);
      } else {
        // Blog index/listing fallback
        assertions.push(`await expect(page.locator("h1, h2")).toBeVisible();`);
        assertions.push(`await expect(page.locator("a")).toHaveCount({ min: 1 });`);
      }
      break;

    case "dashboard":
      assertions.push(`await expect(page.locator("nav, [role='navigation'], aside, [data-testid='sidebar']")).toBeVisible();`);
      if (routePath.includes("/analytics") || routePath.includes("/dashboard")) {
        assertions.push(`await expect(page.locator("canvas, svg, [data-testid='chart']")).toHaveCount({ min: 1 });`);
        assertions.push(`await expect(page.locator("[data-testid='metric'], .metric, [class*='stat']")).toHaveCount({ min: 1 });`);
      } else if (routePath.includes("/settings")) {
        assertions.push(`await expect(page.locator("form, [data-testid='settings-form']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("button:has-text('Save'), button[type='submit']")).toBeVisible();`);
      } else {
        // Generic dashboard page fallback
        assertions.push(`await expect(page.locator("h1, h2")).toBeVisible();`);
        assertions.push(`await expect(page.locator("a, button")).toHaveCount({ min: 1 });`);
      }
      break;

    case "auth":
      assertions.push(`await expect(page.locator("form, [data-testid='auth-form']")).toBeVisible();`);
      if (routePath.includes("/login")) {
        assertions.push(`await expect(page.locator("input[type='email'], input[name*='email']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("input[type='password']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("button:has-text('Login'), button:has-text('Sign in')")).toBeVisible();`);
      } else if (routePath.includes("/signup") || routePath.includes("/register")) {
        assertions.push(`await expect(page.locator("input[type='email'], input[name*='email']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("input[type='password']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("button:has-text('Sign up'), button:has-text('Register')")).toBeVisible();`);
      } else if (routePath.includes("/forgot-password")) {
        assertions.push(`await expect(page.locator("input[type='email'], input[name*='email']")).toBeVisible();`);
        assertions.push(`await expect(page.locator("button:has-text('Reset'), button:has-text('Send')")).toBeVisible();`);
      } else {
        // Generic auth page fallback
        assertions.push(`await expect(page.locator("input")).toHaveCount({ min: 1 });`);
        assertions.push(`await expect(page.locator("button[type='submit'], button")).toHaveCount({ min: 1 });`);
      }
      break;

    case "generic":
    default:
      // Generic fallback assertions
      assertions.push(`await expect(page.locator("h1")).toBeVisible();`);
      assertions.push(`await expect(page.locator("a, button")).toHaveCount({ min: 1 });`);
      assertions.push(`await expect(page).toHaveTitle(/.+/);`);
      break;
  }

  return assertions;
}

/**
 * Upgrade L0 test code to L1 with domain-aware assertions
 */
export function upgradeL0ToL1(testCode: string, routePath: string, sourceCode?: string): string {
  const detection = detectDomain(routePath, sourceCode);
  const l1Assertions = generateL1Assertions(detection.domain, routePath);

  // Find the L0 error check assertion
  const l0ErrorCheckRegex = /expect\(errors.*?\)\.toEqual\(\[\]\);/;
  const match = testCode.match(l0ErrorCheckRegex);

  if (!match) {
    // If no L0 error check found, append L1 assertions before the closing braces
    const closingBraceIndex = testCode.lastIndexOf("});");
    if (closingBraceIndex === -1) return testCode;

    const beforeClosing = testCode.slice(0, closingBraceIndex);
    const afterClosing = testCode.slice(closingBraceIndex);

    return `${beforeClosing}\n    ${l1Assertions.join("\n    ")}\n${afterClosing}`;
  }

  // Insert L1 assertions before the L0 error check
  const insertIndex = match.index!;
  const before = testCode.slice(0, insertIndex);
  const after = testCode.slice(insertIndex);

  return `${before}${l1Assertions.join("\n    ")}\n    ${after}`;
}

/**
 * Get assertion count for a domain and route
 */
export function getAssertionCount(domain: AppDomain, routePath: string): number {
  const assertions = generateL1Assertions(domain, routePath);
  return assertions.filter((a) => a.includes("expect(")).length;
}

/**
 * Generate L2 assertions: contract schema validation and SSR data verification
 */
export function generateL2Assertions(node: InteractionNode): string[] {
  if (node.kind !== "route") return [];
  const assertions: string[] = [];
  const isApi = node.path.startsWith("/api/") || (node.methods && node.methods.length > 0);

  if (isApi) {
    assertions.push(`// L2: API contract validation`);
    assertions.push(`const response = await request.get("${node.path}");`);
    assertions.push(`expect(response.status()).toBeLessThan(500);`);
    assertions.push(`const contentType = response.headers()["content-type"] ?? "";`);
    assertions.push(`expect(contentType).toContain("application/json");`);
    assertions.push(`const responseBody = await response.json();`);
    assertions.push(`expect(responseBody).toBeDefined();`);
    // Edge case: malformed body on POST endpoints
    if (node.methods?.includes("POST") || node.methods?.includes("PUT")) {
      assertions.push(`// Edge case: reject empty body on mutation endpoint`);
      assertions.push(`const badResponse = await request.${node.methods.includes("POST") ? "post" : "put"}("${node.path}", { data: {} });`);
      assertions.push(`expect(badResponse.status()).toBeGreaterThanOrEqual(400);`);
      assertions.push(`expect(badResponse.status()).toBeLessThan(500);`);
    }
  } else {
    // Page route: verify SSR data injection
    assertions.push(`// L2: SSR data injection verification`);
    assertions.push(`const manduDataEl = page.locator("#__MANDU_DATA__");`);
    assertions.push(`const dataCount = await manduDataEl.count();`);
    assertions.push(`if (dataCount > 0) {`);
    assertions.push(`  const raw = await manduDataEl.textContent();`);
    assertions.push(`  expect(() => JSON.parse(raw!)).not.toThrow();`);
    assertions.push(`}`);
  }

  return assertions;
}

/**
 * Generate L3 assertions: behavioral verification (state changes, island hydration, navigation)
 */
export function generateL3Assertions(node: InteractionNode, edges: { kind: string; to?: string }[]): string[] {
  if (node.kind !== "route") return [];
  const assertions: string[] = [];
  const isApi = node.path.startsWith("/api/") || (node.methods && node.methods.length > 0);

  if (isApi && node.methods?.includes("POST")) {
    assertions.push(`// L3: POST state change verification`);
    assertions.push(`const beforeRes = await request.get("${node.path}");`);
    assertions.push(`const beforeStatus = beforeRes.status();`);
    assertions.push(`if (beforeStatus < 400) {`);
    assertions.push(`  const beforeBody = await beforeRes.json();`);
    assertions.push(`  const beforeCount = Array.isArray(beforeBody) ? beforeBody.length : 0;`);
    assertions.push(`  await request.post("${node.path}", { data: { _ate: true } });`);
    assertions.push(`  const afterBody = await (await request.get("${node.path}")).json();`);
    assertions.push(`  const afterCount = Array.isArray(afterBody) ? afterBody.length : 0;`);
    assertions.push(`  expect(afterCount).toBeGreaterThanOrEqual(beforeCount);`);
    assertions.push(`}`);
  }

  if (!isApi && node.hasIsland) {
    assertions.push(`// L3: Island hydration verification`);
    assertions.push(`const islands = page.locator("[data-mandu-island]");`);
    assertions.push(`const islandCount = await islands.count();`);
    assertions.push(`if (islandCount > 0) {`);
    assertions.push(`  await expect(islands.first()).toBeVisible();`);
    assertions.push(`  // Verify island has been hydrated (script loaded)`);
    assertions.push(`  const hydrated = await page.evaluate(() => typeof window.__MANDU_ISLANDS__ === "object");`);
    assertions.push(`  expect(hydrated).toBe(true);`);
    assertions.push(`}`);
  }

  // Navigation flow: verify that outgoing links resolve to valid pages
  const navTargets = edges.filter(e => e.kind === "navigate" && e.to).slice(0, 3);
  if (!isApi && navTargets.length > 0) {
    assertions.push(`// L3: Navigation flow verification`);
    for (const nav of navTargets) {
      assertions.push(`const navRes_${nav.to!.replace(/[^a-zA-Z0-9]/g, "_")} = await request.get("${nav.to}");`);
      assertions.push(`expect(navRes_${nav.to!.replace(/[^a-zA-Z0-9]/g, "_")}.status()).toBeLessThan(500);`);
    }
  }

  return assertions;
}
