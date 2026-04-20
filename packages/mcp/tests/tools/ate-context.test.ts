/**
 * Phase A.1 acceptance — `mandu_ate_context` round-trip.
 *
 * Loads the real `demo/auth-starter/` project, runs the ATE extractor
 * against it, then invokes the MCP tool handler (no SDK wiring — we
 * call the registered handler directly with a plain args object, same
 * as the other ai-brief / loop-close tests do).
 *
 * Asserts the returned context blob contains:
 *   - the signup route metadata (id, pattern, POST method)
 *   - the csrf + session middleware chain
 *   - recommended session + db fixture hints
 *   - the existing auth-flow spec surfaces via the indexer
 *
 * This test depends on demo/auth-starter's on-disk shape. If a file
 * moves, the assertions below will tell us which.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  ateContextToolDefinitions,
  ateContextTools,
} from "../../src/tools/ate-context";
import { ateExtract } from "@mandujs/ate";

// Repo root is 3 levels above `packages/mcp/tests/tools/`.
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const AUTH_STARTER = join(REPO_ROOT, "demo", "auth-starter");

describe("mandu_ate_context MCP tool — demo/auth-starter round trip", () => {
  beforeAll(async () => {
    // Skip gracefully if the demo isn't present (e.g. shallow checkout).
    if (!existsSync(join(AUTH_STARTER, "app", "api", "signup", "route.ts"))) {
      throw new Error(
        `demo/auth-starter missing — test expects ${AUTH_STARTER}/app/api/signup/route.ts to exist`
      );
    }

    // Run extract before context so the interaction graph on disk is
    // up to date with the live repo layout. This writes to
    // `demo/auth-starter/.mandu/interaction-graph.json`. The test
    // does NOT clean up afterwards — the file is gitignored and
    // small, and subsequent `bun run test:ate` invocations will
    // regenerate it anyway.
    await ateExtract({
      repoRoot: AUTH_STARTER,
      routeGlobs: ["app/**/page.tsx", "app/**/route.ts"],
      buildSalt: "ate-context-test",
    });
  });

  test("tool definition is registered with the correct name and schema", () => {
    expect(ateContextToolDefinitions).toHaveLength(1);
    const def = ateContextToolDefinitions[0];
    expect(def.name).toBe("mandu_ate_context");
    // §11 decision 4 — snake_case.
    expect(def.name).toMatch(/^mandu_ate_[a-z_]+$/);

    // Required schema fields per §4.1.
    expect(def.inputSchema.required).toEqual(expect.arrayContaining(["repoRoot", "scope"]));
    const properties = (def.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties).toHaveProperty("scope");
    expect(properties).toHaveProperty("id");
    expect(properties).toHaveProperty("route");
  });

  test("route scope on /api/signup returns contract + middleware + fixtures + specs", async () => {
    const handlers = ateContextTools(AUTH_STARTER);
    const result = await handlers.mandu_ate_context({
      repoRoot: AUTH_STARTER,
      scope: "route",
      route: "/api/signup",
    });

    // Top-level envelope.
    expect(result.ok).toBe(true);
    const envelope = result as { ok: true; context: unknown };
    const ctx = envelope.context as {
      scope: string;
      found: boolean;
      route?: { id: string; pattern: string; kind: string; methods?: string[] };
      middleware?: Array<{ name: string }>;
      fixtures?: { recommended: string[] };
      existingSpecs?: Array<{ path: string; kind: string }>;
      guard?: { preset: string; suggestedSelectors: string[]; tags: string[] };
      relatedRoutes?: Array<{ id: string; relationship: string }>;
      contract?: unknown;
    };

    expect(ctx.scope).toBe("route");
    expect(ctx.found).toBe(true);

    // 1. Route metadata.
    expect(ctx.route?.id).toBe("api-signup");
    expect(ctx.route?.pattern).toBe("/api/signup");
    expect(ctx.route?.kind).toBe("api");
    expect(ctx.route?.methods).toContain("POST");

    // 2. Middleware — signup route uses session + csrf via withSession/withCsrf.
    const mwNames = ctx.middleware?.map((m) => m.name) ?? [];
    expect(mwNames).toEqual(expect.arrayContaining(["session", "csrf"]));

    // 3. Fixtures — session & db recommendations.
    const recs = ctx.fixtures?.recommended ?? [];
    expect(recs).toContain("createTestSession");
    expect(recs).toContain("createTestDb");
    expect(recs).toContain("testFilling");

    // 4. Guard surface — data-route-id selector + tags.
    expect(ctx.guard?.suggestedSelectors).toContain("[data-route-id=api-signup]");
    expect(ctx.guard?.tags).toEqual(
      expect.arrayContaining(["api", "authenticated", "csrf-protected"])
    );

    // 5. Existing spec — auth-flow.spec.ts links /api/signup via the UI
    //    entry (page /signup + <form action="/api/signup">). The indexer
    //    may or may not map it to api-signup depending on how coverage
    //    is declared; what we require is that *some* spec shows up here
    //    OR that relatedRoutes surfaces the UI entry point.
    const specs = ctx.existingSpecs ?? [];
    const related = ctx.relatedRoutes ?? [];
    const signupUiEntry = related.find((r) => r.id === "signup");
    // Either the spec indexer mapped a spec to api-signup, OR the
    // related-route probe surfaced the signup page as an entry point.
    expect(specs.length + (signupUiEntry ? 1 : 0)).toBeGreaterThan(0);
  });

  test("project scope returns summary with at least the signup + login routes", async () => {
    const handlers = ateContextTools(AUTH_STARTER);
    const result = await handlers.mandu_ate_context({
      repoRoot: AUTH_STARTER,
      scope: "project",
    });

    expect(result.ok).toBe(true);
    const ctx = (result as { ok: true; context: {
      scope: string;
      summary: { routes: number; apiRoutes: number };
      routes: Array<{ id: string; pattern: string }>;
    } }).context;

    expect(ctx.scope).toBe("project");
    expect(ctx.summary.routes).toBeGreaterThanOrEqual(4);
    expect(ctx.summary.apiRoutes).toBeGreaterThanOrEqual(2);

    const ids = ctx.routes.map((r) => r.id);
    expect(ids).toContain("api-signup");
    expect(ids).toContain("api-login");
  });

  test("unknown route returns found=false with suggestions", async () => {
    const handlers = ateContextTools(AUTH_STARTER);
    const result = await handlers.mandu_ate_context({
      repoRoot: AUTH_STARTER,
      scope: "route",
      id: "definitely-not-a-real-route",
    });
    expect(result.ok).toBe(true);
    const ctx = (result as { ok: true; context: {
      found: boolean;
      suggestions: string[];
    } }).context;
    expect(ctx.found).toBe(false);
    expect(Array.isArray(ctx.suggestions)).toBe(true);
  });

  test("validates required inputs", async () => {
    const handlers = ateContextTools(AUTH_STARTER);
    const missingRoot = await handlers.mandu_ate_context({ scope: "project" } as Record<string, unknown>);
    expect(missingRoot.ok).toBe(false);
  });
});
