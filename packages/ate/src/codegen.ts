import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAtePaths, ensureDir, readJson, writeJson } from "./fs";
import type { ScenarioBundle } from "./scenario";
import type { InteractionEdge, InteractionGraph, InteractionNode, OracleLevel } from "./types";
import { readSelectorMap, buildPlaywrightLocatorChain } from "./selector-map";
import { generateL1Assertions, generateL2Assertions, generateL3Assertions } from "./oracle";
import { detectDomain } from "./domain-detector";

function specHeader(): string {
  return `import { test, expect } from "@playwright/test";\n\n`;
}

function oracleTemplate(
  level: OracleLevel,
  routePath: string,
  node?: InteractionNode,
  edges?: InteractionEdge[],
): { setup: string; assertions: string } {
  const setup: string[] = [];
  const assertions: string[] = [];

  // L0 baseline always
  setup.push(`// L0: no console.error / uncaught exception / 5xx`);
  setup.push(`const errors: string[] = [];`);
  setup.push(`page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });`);
  setup.push(`page.on("pageerror", (err) => errors.push(String(err)));`);

  if (level === "L1" || level === "L2" || level === "L3") {
    const domain = detectDomain(routePath).domain;
    const l1Assertions = generateL1Assertions(domain, routePath);
    assertions.push(...l1Assertions);
  }
  if ((level === "L2" || level === "L3") && node) {
    assertions.push(...generateL2Assertions(node));
  }
  if (level === "L3" && node) {
    const nodeEdges = (edges ?? []).filter(e => "from" in e && e.from === (node.kind === "route" ? node.path : ""));
    assertions.push(...generateL3Assertions(node, nodeEdges));
  }

  assertions.push(`expect(errors, "console/page errors").toEqual([]);`);

  return { setup: setup.join("\n"), assertions: assertions.join("\n") };
}

export function generatePlaywrightSpecs(repoRoot: string, opts?: { onlyRoutes?: string[] }): { files: string[]; warnings: string[] } {
  const paths = getAtePaths(repoRoot);
  const warnings: string[] = [];

  let bundle: ScenarioBundle;
  try {
    bundle = readJson<ScenarioBundle>(paths.scenariosPath);
  } catch (err: unknown) {
    throw new Error(`시나리오 번들 읽기 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if (!bundle.scenarios || bundle.scenarios.length === 0) {
    warnings.push("경고: 생성할 시나리오가 없습니다");
    return { files: [], warnings };
  }

  // Load interaction graph for L2/L3 node metadata
  let graph: InteractionGraph | undefined;
  try {
    graph = readJson<InteractionGraph>(paths.interactionGraphPath);
  } catch {
    // Graph is optional; L2/L3 will degrade gracefully without node metadata
  }

  let selectorMap;
  try {
    selectorMap = readSelectorMap(repoRoot);
  } catch (err: unknown) {
    // Selector map is optional
    warnings.push(`Selector map 읽기 실패 (무시): ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    ensureDir(paths.autoE2eDir);
  } catch (err: unknown) {
    throw new Error(`E2E 디렉토리 생성 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const files: string[] = [];
  for (const s of bundle.scenarios) {
    if (opts?.onlyRoutes?.length && !opts.onlyRoutes.includes(s.route)) continue;

    try {
      const safeId = s.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = join(paths.autoE2eDir, `${safeId}.spec.ts`);

      let code: string;

      if (s.kind === "api-smoke") {
        // API route: fetch-based test
        const methods = s.methods ?? ["GET"];
        const apiNode = graph?.nodes.find(n => n.kind === "route" && n.path === s.route);
        const testCases = methods.map((method) => {
          return [
            `  test(${JSON.stringify(`${method} ${s.route}`)}, async ({ request, baseURL }) => {`,
            `    const url = (baseURL ?? "http://127.0.0.1:3333") + ${JSON.stringify(s.route)};`,
            `    const res = await fetch(url, { method: ${JSON.stringify(method)} });`,
            `    expect(res.status).toBeLessThan(500);`,
            `    expect(res.headers.get("content-type")).toBeTruthy();`,
            method === "GET" ? `    const body = await res.text();\n    expect(body.length).toBeGreaterThan(0);` : "",
            `  });`,
          ].filter(Boolean).join("\n");
        });

        // L2/L3 assertions for API routes — pass repoRoot so deep generators
        // can read *.contract.ts files and scan side effects (#ATE Phase 1)
        const apiOracleTests: string[] = [];
        if ((s.oracleLevel === "L2" || s.oracleLevel === "L3") && apiNode) {
          const l2 = generateL2Assertions(apiNode, { repoRoot });
          if (l2.length > 0) {
            apiOracleTests.push([
              `  test(${JSON.stringify(`L2 contract: ${s.route}`)}, async ({ request }) => {`,
              ...l2.map(line => `    ${line}`),
              `  });`,
            ].join("\n"));
          }
        }
        if (s.oracleLevel === "L3" && apiNode) {
          const l3 = generateL3Assertions(apiNode, graph?.edges ?? [], { repoRoot });
          if (l3.length > 0) {
            apiOracleTests.push([
              `  test(${JSON.stringify(`L3 behavior: ${s.route}`)}, async ({ request }) => {`,
              ...l3.map(line => `    ${line}`),
              `  });`,
            ].join("\n"));
          }
        }

        code = [
          specHeader(),
          `test.describe(${JSON.stringify(s.id)}, () => {`,
          ...testCases,
          ...apiOracleTests,
          `});`,
          "",
        ].join("\n");
      } else if (s.kind === "ssr-verify") {
        // SSR output verification.
        // page.goto waits for network idle so downstream page.content() calls
        // still work when the route performs a redirect (#224). Redirect routes
        // skip content-shape assertions entirely and assert navigation instead:
        // calling page.content() on a page that is still navigating raises
        // "Unable to retrieve content because the page is navigating".
        const routeUrl = s.route === "/" ? "/" : s.route;
        const lines: string[] = [
          specHeader(),
          `test.describe(${JSON.stringify(s.id)}, () => {`,
          `  test(${JSON.stringify(`ssr-verify ${s.route}`)}, async ({ page, baseURL }) => {`,
          `    const url = (baseURL ?? "http://127.0.0.1:3333") + ${JSON.stringify(routeUrl)};`,
          `    const res = await page.goto(url, { waitUntil: "networkidle" });`,
          `    expect(res, "goto response").not.toBeNull();`,
          `    expect(res!.status()).toBeLessThan(500);`,
        ];
        if (s.isRedirect) {
          // Redirect route: assert the browser navigated away from the
          // origin URL. Do not call page.content() or inspect islands —
          // the final page is a different route with its own shape.
          lines.push(
            `    // Route performs a page-level redirect; assert navigation settled.`,
            `    await page.waitForLoadState("networkidle");`,
            `    expect(page.url(), "final url should differ from origin").not.toBe(url);`,
          );
        } else {
          // #226 — non-shallow SSR verification. An empty <body> must NOT
          // pass, so we require (a) a minimum non-whitespace body length,
          // (b) a semantic anchor Mandu emits (`data-route-id` or <main>),
          // (c) a <title> that is not the default fallback.
          lines.push(
            `    const html = await page.content();`,
            `    expect(html).toContain("<!DOCTYPE html>");`,
            `    expect(html).toContain("<html");`,
            `    // Body cannot be empty — a near-empty SSR response is almost always a bug.`,
            `    const bodyMatch = html.match(/<body[^>]*>([\\s\\S]*?)<\\/body>/i);`,
            `    const bodyInner = (bodyMatch?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\\s+/g, " ").trim();`,
            `    expect(bodyInner.length, "body content should not be empty").toBeGreaterThan(0);`,
            `    // Semantic anchor — Mandu emits [data-route-id] on the outermost wrapper,`,
            `    // or the page uses <main>. Either is sufficient evidence that a real page rendered.`,
            `    const hasRouteAnchor = /data-route-id=/.test(html);`,
            `    const hasMainLandmark = /<main[\\s>]/.test(html);`,
            `    expect(hasRouteAnchor || hasMainLandmark, "expected [data-route-id] or <main> landmark in SSR output").toBe(true);`,
          );
          if (!s.hasIsland) {
            lines.push(`    expect(html).not.toContain("data-mandu-island");`);
          }
        }
        lines.push(`  });`, `});`, "");
        code = lines.join("\n");
      } else if (s.kind === "island-hydration") {
        // Island hydration verification
        const routeUrl = s.route === "/" ? "/" : s.route;
        code = [
          specHeader(),
          `test.describe(${JSON.stringify(s.id)}, () => {`,
          `  test(${JSON.stringify(`island-hydration ${s.route}`)}, async ({ page, baseURL }) => {`,
          `    const url = (baseURL ?? "http://127.0.0.1:3333") + ${JSON.stringify(routeUrl)};`,
          `    await page.goto(url, { waitUntil: "networkidle" });`,
          `    await page.waitForSelector("[data-mandu-island]", { timeout: 5000 });`,
          `    const count = await page.locator("[data-mandu-island]").count();`,
          `    expect(count).toBeGreaterThan(0);`,
          `  });`,
          `});`,
          "",
        ].join("\n");
      } else if (s.kind === "sse-stream") {
        // SSE streaming test
        code = [
          specHeader(),
          `test.describe(${JSON.stringify(s.id)}, () => {`,
          `  test(${JSON.stringify(`sse-stream ${s.route}`)}, async ({ baseURL }) => {`,
          `    const url = (baseURL ?? "http://127.0.0.1:3333") + ${JSON.stringify(s.route)};`,
          `    const res = await fetch(url, { headers: { Accept: "text/event-stream" } });`,
          `    expect(res.status).toBeLessThan(500);`,
          `    const ct = res.headers.get("content-type") ?? "";`,
          `    expect(ct).toContain("text/event-stream");`,
          `    const body = await res.text();`,
          `    expect(body.length).toBeGreaterThan(0);`,
          `  });`,
          `});`,
          "",
        ].join("\n");
      } else if (s.kind === "form-action") {
        // Form action test (POST with _action)
        code = [
          specHeader(),
          `test.describe(${JSON.stringify(s.id)}, () => {`,
          `  test(${JSON.stringify(`form-action ${s.route}`)}, async ({ baseURL }) => {`,
          `    const url = (baseURL ?? "http://127.0.0.1:3333") + ${JSON.stringify(s.route)};`,
          `    const res = await fetch(url, {`,
          `      method: "POST",`,
          `      headers: { "Content-Type": "application/x-www-form-urlencoded" },`,
          `      body: "_action=default",`,
          `    });`,
          `    expect(res.status).toBeLessThan(500);`,
          `    expect(res.headers.get("content-type")).toBeTruthy();`,
          `  });`,
          `});`,
          "",
        ].join("\n");
      } else {
        // Page route: browser-based test (route-smoke)
        const graphNode = graph?.nodes.find(n => n.kind === "route" && n.path === s.route);
        const oracle = oracleTemplate(s.oracleLevel, s.route, graphNode, graph?.edges);

        // Generate selector examples if selector map exists
        let selectorExamples = "";
        if (selectorMap && selectorMap.entries.length > 0) {
          const exampleEntry = selectorMap.entries[0];
          const locatorChain = buildPlaywrightLocatorChain(exampleEntry);
          selectorExamples = `    // Example: Selector with fallback chain\n    // const loginBtn = ${locatorChain};\n`;
        }

        code = [
          specHeader(),
          `test.describe(${JSON.stringify(s.id)}, () => {`,
          `  test(${JSON.stringify(`smoke ${s.route}`)}, async ({ page, request, baseURL }) => {`,
          `    const url = (baseURL ?? "http://127.0.0.1:3333") + ${JSON.stringify(s.route === "/" ? "/" : s.route)};`,
          `    ${oracle.setup.split("\n").join("\n    ")}`,
          `    await page.goto(url, { waitUntil: "networkidle" });`,
          selectorExamples,
          `    ${oracle.assertions.split("\n").join("\n    ")}`,
          `  });`,
          `});`,
          "",
        ].join("\n");
      }

      try {
        writeFileSync(filePath, code, "utf8");
        files.push(filePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Spec 파일 쓰기 실패 (${filePath}): ${msg}`);
        console.error(`[ATE] Spec 생성 실패: ${filePath} - ${msg}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Spec 생성 실패 (${s.id}): ${msg}`);
      console.error(`[ATE] Spec 생성 에러: ${s.id} - ${msg}`);
      // Continue with next scenario
    }
  }

  // ensure playwright config exists (minimal)
  try {
    const configPath = join(repoRoot, "tests", "e2e", "playwright.config.ts");
    ensureDir(join(repoRoot, "tests", "e2e"));
    const desiredConfig = `import { defineConfig } from "@playwright/test";\n\nexport default defineConfig({\n  // NOTE: resolved relative to this config file (tests/e2e).\n  testDir: ".",\n  timeout: 60_000,\n  use: {\n    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3333",\n    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",\n    video: process.env.CI ? "retain-on-failure" : "off",\n    screenshot: "only-on-failure",\n  },\n  reporter: [\n    ["html", { outputFolder: "../../.mandu/reports/latest/playwright-html", open: "never" }],\n    ["json", { outputFile: "../../.mandu/reports/latest/playwright-report.json" }],\n    ["junit", { outputFile: "../../.mandu/reports/latest/junit.xml" }],\n  ],\n});\n`;

    if (!existsSync(configPath)) {
      writeFileSync(configPath, desiredConfig, "utf8");
    } else {
      // migrate older auto-generated config that used testDir: "tests/e2e" (breaks because config is already under tests/e2e)
      const current = readFileSync(configPath, "utf8");
      if (current.includes('testDir: "tests/e2e"')) {
        writeFileSync(configPath, desiredConfig, "utf8");
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Playwright config 생성 실패: ${msg}`);
    console.warn(`[ATE] Playwright config 생성 실패: ${msg}`);
  }

  return { files, warnings };
}
