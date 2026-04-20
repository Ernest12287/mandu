/**
 * Phase B acceptance — end-to-end integration per docs/ate/phase-b-spec.md §B.6.
 *
 * Roundtrip covered:
 *   1. Boundary probe on a demo-like SignupContract → ≥ 10 probes.
 *   2. Coverage metrics surface the contract as a topGap.
 *   3. Memory remember/recall cycle.
 *   4. Memory clear empties the file.
 *
 * Uses a tmpdir-backed mini-project rather than touching demo/auth-starter,
 * so the acceptance test is hermetic across CI runs.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateBoundaryProbes,
  computeCoverage,
  appendMemoryEvent,
  recallMemory,
  clearMemory,
  memoryFilePath,
} from "../src";

describe("Phase B acceptance — auth-starter round-trip", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-phase-b-acceptance-"));
    mkdirSync(join(root, ".mandu"), { recursive: true });
    mkdirSync(join(root, "spec", "contracts"), { recursive: true });
    mkdirSync(join(root, "app", "api", "signup"), { recursive: true });

    // SignupContract that mirrors the demo/auth-starter shape.
    writeFileSync(
      join(root, "spec", "contracts", "SignupContract.contract.ts"),
      `import { z } from "zod";
export default {
  request: { POST: { body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(72),
    confirmPassword: z.string().min(8),
  }) } },
  response: {
    302: z.object({}),
    400: z.object({ error: z.string() }),
    409: z.object({ error: z.string() }),
  },
};
`,
    );

    writeFileSync(
      join(root, "app", "api", "signup", "route.ts"),
      `export default () => new Response("ok");\n`,
    );

    const graph = {
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
          kind: "filling",
          id: "filling:api-signup",
          file: "app/api/signup/route.ts",
          routeId: "api-signup",
          methods: ["POST"],
          middlewareNames: ["withSession", "withCsrf"],
          actions: [],
        },
      ],
      edges: [],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
    };
    writeFileSync(
      join(root, ".mandu", "interaction-graph.json"),
      JSON.stringify(graph, null, 2),
    );
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("1. mandu_ate_boundary_probe({ contractName: 'SignupContract' }) → ≥ 10 probes", async () => {
    const res = await generateBoundaryProbes({
      repoRoot: root,
      contractName: "SignupContract",
      method: "POST",
    });
    expect(res.probes.length).toBeGreaterThanOrEqual(10);
    const fields = new Set(res.probes.map((p) => p.field));
    expect(fields.has("email")).toBe(true);
    expect(fields.has("password")).toBe(true);
    expect(fields.has("confirmPassword")).toBe(true);
    expect(res.graphVersion).toMatch(/^gv1:/);
  });

  test("2. mandu_ate_coverage({ scope: 'project' }) surfaces signup contract in topGaps", async () => {
    const metrics = await computeCoverage(root, { scope: "project" });
    const gap = metrics.topGaps.find((g) =>
      g.kind === "contract_without_boundary" && /SignupContract|signup/i.test(g.target),
    );
    // Either a contract gap OR a route gap surfaces for signup.
    const anySignupGap = metrics.topGaps.some((g) =>
      /signup/i.test(g.target),
    );
    expect(anySignupGap || Boolean(gap)).toBe(true);
  });

  test("3. mandu_ate_remember writes event; mandu_ate_recall finds it", () => {
    appendMemoryEvent(root, {
      kind: "boundary_gap_filled",
      timestamp: new Date().toISOString(),
      contractName: "SignupContract",
      probes: 14,
    });

    const recall = recallMemory(root, { intent: "SignupContract" });
    expect(recall.events.some((e) => e.kind === "boundary_gap_filled")).toBe(true);
  });

  test("4. mandu ate memory clear empties the file", () => {
    expect(existsSync(memoryFilePath(root))).toBe(true);
    clearMemory(root);
    expect(existsSync(memoryFilePath(root))).toBe(false);
    const recall = recallMemory(root);
    expect(recall.events.length).toBe(0);
  });
});
