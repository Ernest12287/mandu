/**
 * Phase A.3 — prompt goldens.
 *
 * For each prompt kind we keep a canonical (context, exemplars) fixture and
 * a frozen `<kind>.golden.md` file capturing the expected composer output.
 * The test compares the live composer against the golden — failures indicate
 * either a catalog drift (expected, re-run with `UPDATE_GOLDEN=1`) or a
 * regression in the composer.
 *
 * Re-generate goldens:
 *   UPDATE_GOLDEN=1 bun test packages/ate/tests/prompts/goldens.test.ts
 */
import { describe, test, expect } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { composePrompt } from "../../src/prompt-composer";
import type { Exemplar } from "../../src/exemplar-scanner";

const GOLDEN_DIR = join(__dirname);
const UPDATE = process.env.UPDATE_GOLDEN === "1";

interface GoldenCase {
  kind: string;
  context: unknown;
  exemplars: Exemplar[];
}

const fillingUnitExemplar: Exemplar = {
  path: "packages/core/tests/filling/action.test.ts",
  startLine: 17,
  endLine: 29,
  kind: "filling_unit",
  depth: "basic",
  tags: ["post", "action", "json"],
  code: `it("dispatches POST with _action in JSON body to action handler", async () => {
  const filling = new ManduFilling()
    .action("create", async (ctx) => ctx.ok({ handler: "create" }))
    .post(async (ctx) => ctx.ok({ handler: "post" }));

  const req = jsonPost("http://localhost/items", { _action: "create", title: "test" });
  const res = await filling.handle(req);
  const data = await res.json();

  expect(res.status).toBe(200);
  expect(data.handler).toBe("create");
})`,
};

const integrationExemplar: Exemplar = {
  path: "packages/core/tests/server/rate-limit.test.ts",
  startLine: 34,
  endLine: 58,
  kind: "filling_integration",
  depth: "basic",
  tags: ["rate-limit", "server", "429"],
  code: `it("설정된 횟수를 초과하면 429를 반환한다", async () => {
  registry.registerApiHandler("api/limited", async () => Response.json({ ok: true }));
  server = startServer(testManifest, { port: 0, registry, rateLimit: { windowMs: 5000, max: 2 } });
  // ... (abbreviated for golden stability)
})`,
};

const e2eExemplar: Exemplar = {
  path: "demo/auth-starter/tests/e2e/auth-flow.spec.ts",
  startLine: 25,
  endLine: 38,
  kind: "e2e_playwright",
  depth: "basic",
  tags: ["signup", "happy-path", "navigation"],
  code: `test("signup with fresh email lands on /dashboard with the email visible", async ({ page }) => {
  const email = freshEmail("signup-fresh");
  await page.goto("/signup");
  await expect(page.getByTestId("signup-form")).toBeVisible();
  // ... (abbreviated for golden stability)
})`,
};

const CASES: GoldenCase[] = [
  {
    kind: "filling_unit",
    context: {
      route: { id: "api-signup", pattern: "/api/signup", methods: ["POST"] },
      middleware: [{ name: "session" }, { name: "csrf" }],
      fixtures: { recommended: ["createTestSession", "createTestDb", "testFilling"] },
    },
    exemplars: [fillingUnitExemplar],
  },
  {
    kind: "filling_integration",
    context: {
      route: { id: "api-signup", pattern: "/api/signup", methods: ["POST"] },
      middleware: [{ name: "session" }, { name: "csrf" }, { name: "rate-limit" }],
      fixtures: { recommended: ["createTestServer", "createTestSession", "createTestDb"] },
    },
    exemplars: [integrationExemplar],
  },
  {
    kind: "e2e_playwright",
    context: {
      route: { id: "signup", pattern: "/signup", kind: "page", isRedirect: false },
      guard: { suggestedSelectors: ["[data-route-id=signup]"] },
    },
    exemplars: [e2eExemplar],
  },
];

describe("prompt goldens", () => {
  for (const c of CASES) {
    test(`${c.kind} composed prompt matches golden`, async () => {
      const composed = await composePrompt({
        kind: c.kind,
        context: c.context,
        exemplars: c.exemplars,
      });

      if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
      const goldenPath = join(GOLDEN_DIR, `${c.kind}.golden.md`);

      if (UPDATE || !existsSync(goldenPath)) {
        writeFileSync(goldenPath, composed.prompt, "utf8");
        // When updating, the assertion below is trivially true.
      }

      const expected = readFileSync(goldenPath, "utf8");
      // Normalize line endings so CRLF on Windows doesn't flake.
      const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd() + "\n";
      expect(norm(composed.prompt)).toBe(norm(expected));
    });
  }
});
