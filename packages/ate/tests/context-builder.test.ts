import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extract } from "../src/extractor";
import { buildContext } from "../src/context-builder";

describe("context-builder (Phase A.1)", () => {
  let repoRoot: string;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-context-builder-"));

    // Minimal auth-starter-shaped project:
    //   app/api/signup/route.ts           — Filling with session+csrf middleware
    //   app/api/login/route.ts            — Filling with session middleware
    //   app/signup/page.tsx               — Signup page (ui entry point)
    //   app/dashboard/page.tsx            — Authenticated page (island)
    //   app/dashboard/counter.client.tsx  — Client island
    //   spec/contracts/signup.contract.ts — Contract with examples
    //   tests/e2e/signup.spec.ts          — Existing user-written spec
    //   mandu.config.ts                   — guard preset = "mandu"
    mkdirSync(join(repoRoot, "app", "api", "signup"), { recursive: true });
    mkdirSync(join(repoRoot, "app", "api", "login"), { recursive: true });
    mkdirSync(join(repoRoot, "app", "signup"), { recursive: true });
    mkdirSync(join(repoRoot, "app", "dashboard"), { recursive: true });
    mkdirSync(join(repoRoot, "spec", "contracts"), { recursive: true });
    mkdirSync(join(repoRoot, "tests", "e2e"), { recursive: true });

    writeFileSync(
      join(repoRoot, "mandu.config.ts"),
      `export default { guard: { preset: "mandu" } };`
    );

    writeFileSync(
      join(repoRoot, "app", "api", "signup", "route.ts"),
      `
        import { Mandu } from "@mandujs/core";
        export default Mandu.filling()
          .use(withSession())
          .use(withCsrf())
          .post(async (ctx) => { return new Response(); });
      `
    );

    writeFileSync(
      join(repoRoot, "app", "api", "login", "route.ts"),
      `
        import { Mandu } from "@mandujs/core";
        export default Mandu.filling()
          .use(withSession())
          .post(async (ctx) => { return new Response(); });
      `
    );

    writeFileSync(
      join(repoRoot, "app", "signup", "page.tsx"),
      `
        export default function SignupPage() {
          return <form method="POST" action="/api/signup"></form>;
        }
      `
    );

    writeFileSync(
      join(repoRoot, "app", "dashboard", "page.tsx"),
      `export default function Dashboard() { return <div /> }`
    );
    writeFileSync(
      join(repoRoot, "app", "dashboard", "counter.client.tsx"),
      `"use client";\nexport default function Counter() { return <button /> }`
    );

    writeFileSync(
      join(repoRoot, "spec", "contracts", "api-signup.contract.ts"),
      `
        import { z } from "zod";
        export default {
          request: {
            POST: {
              body: z.object({
                email: z.string().min(1),
                password: z.string().min(8),
              }),
              examples: {
                valid: { email: "user@example.com", password: "hunter2!!" },
                duplicate: { email: "taken@example.com", password: "hunter2!!" }
              }
            }
          },
          response: {
            201: z.object({ userId: z.string() }),
            409: z.object({ error: z.string() }),
          }
        };
      `
    );

    writeFileSync(
      join(repoRoot, "tests", "e2e", "signup.spec.ts"),
      `
        // @ate-covers: api-signup
        import { test } from "@playwright/test";
        test("signup happy path", async () => {});
      `
    );

    // Extract once — context-builder reads .mandu/interaction-graph.json.
    await extract({
      repoRoot,
      routeGlobs: ["app/**/page.tsx", "app/**/route.ts"],
      buildSalt: "test",
    });
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ───────── project scope ─────────

  test("project scope returns summary + all routes", () => {
    const ctx = buildContext(repoRoot, { scope: "project" });
    expect(ctx.scope).toBe("project");
    if (ctx.scope !== "project") throw new Error("unreachable");

    expect(ctx.summary.routes).toBeGreaterThanOrEqual(4);
    expect(ctx.summary.apiRoutes).toBe(2);
    expect(ctx.summary.pageRoutes).toBe(2);
    expect(ctx.summary.existingSpecs).toBe(1);
    expect(ctx.routes.length).toBe(ctx.summary.routes);

    const signup = ctx.routes.find((r) => r.id === "api-signup");
    expect(signup).toBeDefined();
    expect(signup?.existingSpecCount).toBe(1);
  });

  // ───────── route scope ─────────

  test("route scope resolves by route pattern and surfaces contract + middleware", () => {
    const ctx = buildContext(repoRoot, { scope: "route", route: "/api/signup" });
    expect(ctx.scope).toBe("route");
    if (ctx.scope !== "route" || !ctx.found) throw new Error("expected route context");

    expect(ctx.route.id).toBe("api-signup");
    expect(ctx.route.kind).toBe("api");
    expect(ctx.route.methods).toContain("POST");

    // Contract ingestion — examples must carry through.
    expect(ctx.contract).not.toBeNull();
    const postRequest = ctx.contract?.methods.find((m) => m.key === "POST" && m.kind === "request");
    expect(postRequest?.examples.length).toBe(2);
    expect(postRequest?.examples.map((e) => e.name)).toEqual(
      expect.arrayContaining(["valid", "duplicate"])
    );

    // Middleware chain — canonicalized names.
    const mwNames = ctx.middleware.map((m) => m.name);
    expect(mwNames).toEqual(expect.arrayContaining(["session", "csrf"]));

    // Guard: preset + suggested selectors.
    expect(ctx.guard.preset).toBe("mandu");
    expect(ctx.guard.suggestedSelectors).toContain("[data-route-id=api-signup]");
    expect(ctx.guard.tags).toEqual(expect.arrayContaining(["api", "authenticated", "csrf-protected"]));

    // Fixtures — session middleware → createTestSession + createTestDb + expectContract.
    expect(ctx.fixtures.recommended).toEqual(
      expect.arrayContaining(["createTestSession", "createTestDb", "expectContract"])
    );

    // Existing specs — one user-written spec via @ate-covers.
    expect(ctx.existingSpecs).toHaveLength(1);
    expect(ctx.existingSpecs[0].path).toBe("tests/e2e/signup.spec.ts");
    expect(ctx.existingSpecs[0].kind).toBe("user-written");

    // Related routes — api-login is a sibling (same first segment "api").
    const related = ctx.relatedRoutes.map((r) => r.id);
    expect(related).toContain("api-login");
    // signup page is the UI entry point for /api/signup.
    const uiEntry = ctx.relatedRoutes.find((r) => r.relationship === "ui-entry-point");
    expect(uiEntry?.id).toBe("signup");
  });

  test("route scope returns found=false for unknown id", () => {
    const ctx = buildContext(repoRoot, { scope: "route", id: "nope-nope" });
    expect(ctx.found).toBe(false);
    if (!ctx.found) {
      expect(ctx.reason).toMatch(/No route matches/);
    }
  });

  // ───────── filling scope ─────────

  test("filling scope returns middleware + actions for a filling handler", () => {
    const ctx = buildContext(repoRoot, { scope: "filling", id: "filling:api-signup" });
    expect(ctx.scope).toBe("filling");
    if (ctx.scope !== "filling" || !ctx.found) throw new Error("expected filling context");

    expect(ctx.filling.routeId).toBe("api-signup");
    expect(ctx.filling.methods).toContain("POST");
    const mwNames = ctx.middleware.map((m) => m.name);
    expect(mwNames).toEqual(expect.arrayContaining(["session", "csrf"]));
    // Contract is inherited from the sibling route.
    expect(ctx.contract).not.toBeNull();
  });

  // ───────── contract scope ─────────

  test("contract scope surfaces methods + examples", () => {
    const ctx = buildContext(repoRoot, { scope: "contract", id: "api-signup" });
    expect(ctx.scope).toBe("contract");
    if (ctx.scope !== "contract" || !ctx.found) throw new Error("expected contract context");

    expect(ctx.contract.methods.length).toBeGreaterThan(0);
    const postRequest = ctx.contract.methods.find(
      (m) => m.kind === "request" && m.key === "POST"
    );
    expect(postRequest).toBeDefined();
    expect(postRequest?.examples.map((e) => e.name)).toEqual(
      expect.arrayContaining(["valid", "duplicate"])
    );

    // usedByRoutes — /api/signup route hooks into this contract.
    expect(ctx.usedByRoutes.map((r) => r.id)).toContain("api-signup");
  });

  test("contract scope returns found=false when id does not match", () => {
    const ctx = buildContext(repoRoot, { scope: "contract", id: "does-not-exist" });
    expect(ctx.found).toBe(false);
  });

  // ───────── companions ─────────

  test("route scope includes slot/island/form companions for a page route", () => {
    const ctx = buildContext(repoRoot, { scope: "route", route: "/signup" });
    if (ctx.scope !== "route" || !ctx.found) throw new Error("expected route context");

    expect(ctx.companions.forms.length).toBeGreaterThanOrEqual(1);
    expect(ctx.companions.forms[0].action).toBe("/api/signup");
    expect(ctx.companions.forms[0].method).toBe("POST");

    const dashboardCtx = buildContext(repoRoot, { scope: "route", route: "/dashboard" });
    if (dashboardCtx.scope !== "route" || !dashboardCtx.found) {
      throw new Error("expected dashboard route context");
    }
    expect(dashboardCtx.companions.islands).toContainEqual(
      expect.objectContaining({ name: "counter" })
    );
  });
});
