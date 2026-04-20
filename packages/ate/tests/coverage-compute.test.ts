/**
 * Phase B.4 — coverage metric compute tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeCoverage } from "../src/coverage/compute";
import type { InteractionGraph } from "../src/types";
import type { SpecIndex } from "../src/spec-indexer";

function makeGraph(): InteractionGraph {
  return {
    schemaVersion: 1,
    generatedAt: "2026-04-20T00:00:00Z",
    buildSalt: "x",
    nodes: [
      {
        kind: "route",
        id: "/api/signup",
        file: "app/api/signup/route.ts",
        path: "/api/signup",
        routeId: "api-signup",
        hasContract: true,
        methods: ["POST"],
      },
      {
        kind: "route",
        id: "/api/login",
        file: "app/api/login/route.ts",
        path: "/api/login",
        routeId: "api-login",
        hasContract: true,
        methods: ["POST"],
      },
      {
        kind: "route",
        id: "/dashboard",
        file: "app/dashboard/page.tsx",
        path: "/dashboard",
        routeId: "dashboard",
      },
      {
        kind: "filling",
        id: "filling:api-signup",
        file: "app/api/signup/route.ts",
        routeId: "api-signup",
        methods: ["POST"],
        middlewareNames: ["withSession", "csrf"],
        actions: [],
      },
      {
        kind: "filling",
        id: "filling:api-login",
        file: "app/api/login/route.ts",
        routeId: "api-login",
        methods: ["POST"],
        middlewareNames: ["rateLimit"],
        actions: [],
      },
    ],
    edges: [],
    stats: { routes: 3, navigations: 0, modals: 0, actions: 0 },
  };
}

function makeSpecIndex(specs: Array<{ path: string; covers: string[] }>): SpecIndex {
  return {
    scanned: specs.length,
    specs: specs.map((s) => ({
      path: s.path,
      kind: "user-written" as const,
      coverage: { covers: s.covers, coversRouteId: s.covers[0] ?? null, coversFile: null },
      lastRun: null,
      status: null,
    })),
  };
}

describe("computeCoverage — route axis", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-cov-compute-"));
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("routes total equals route-node count", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    expect(metrics.routes.total).toBe(3);
  });

  test("withAnyKindOfSpec counts each route with ≥ 1 covering spec", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([
        { path: "tests/e2e/signup.spec.ts", covers: ["api-signup"] },
      ]),
      skipBoundaryProbe: true,
    });
    expect(metrics.routes.withAnyKindOfSpec).toBe(1);
  });

  test("withE2ESpec detects /e2e/ path segment", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([
        { path: "tests/e2e/signup.spec.ts", covers: ["api-signup"] },
      ]),
      skipBoundaryProbe: true,
    });
    expect(metrics.routes.withE2ESpec).toBe(1);
  });
});

describe("computeCoverage — invariants", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-cov-invariants-"));
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("csrf middleware + no csrf-named spec → missing", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([
        { path: "tests/e2e/signup.spec.ts", covers: ["api-signup"] },
      ]),
      skipBoundaryProbe: true,
    });
    expect(metrics.invariants.csrf).toBe("missing");
  });

  test("csrf middleware + 2+ csrf-named specs → covered", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([
        { path: "tests/server/csrf.test.ts", covers: ["api-signup"] },
        { path: "tests/e2e/csrf-flow.spec.ts", covers: ["api-signup"] },
      ]),
      skipBoundaryProbe: true,
    });
    expect(metrics.invariants.csrf).toBe("covered");
  });

  test("invariant not declared → marked covered (n/a)", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    // i18n middleware isn't declared → treated as "covered" (non-gap).
    expect(metrics.invariants.i18n).toBe("covered");
  });

  test("rate-limit middleware detected from middlewareNames", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    expect(metrics.invariants.rate_limit).toBe("missing");
  });
});

describe("computeCoverage — topGaps", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-cov-gaps-"));
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("routes without spec appear in topGaps", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    const gap = metrics.topGaps.find(
      (g) => g.kind === "route_without_spec" && g.target === "api-signup",
    );
    expect(gap).toBeDefined();
  });

  test("topGaps severity sorted high → medium → low", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    const ranks = metrics.topGaps.map((g) =>
      g.severity === "high" ? 0 : g.severity === "medium" ? 1 : 2,
    );
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
  });

  test("authed route (session mw) downgraded to medium severity", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    const sig = metrics.topGaps.find(
      (g) => g.kind === "route_without_spec" && g.target === "api-signup",
    );
    expect(sig?.severity).toBe("medium");
  });

  test("graphVersion is stamped on output", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    expect(metrics.graphVersion).toMatch(/^gv1:/);
  });
});

describe("computeCoverage — scope narrow", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-cov-scope-"));
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("scope=route + target=api-signup returns only that route", async () => {
    const metrics = await computeCoverage(root, {
      graph: makeGraph(),
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
      scope: "route",
      target: "api-signup",
    });
    expect(metrics.routes.total).toBe(1);
  });

  test("empty graph yields empty metrics", async () => {
    const metrics = await computeCoverage(root, {
      graph: undefined,
      specIndex: makeSpecIndex([]),
      skipBoundaryProbe: true,
    });
    expect(metrics.routes.total).toBe(0);
  });
});
