/**
 * graph-version — freshness hash tests.
 *
 * Covers:
 *   1. Stable hash — identical inputs (any order) produce identical output.
 *   2. Route add → hash changes.
 *   3. Contract add → hash changes.
 */
import { describe, test, expect } from "bun:test";
import { computeGraphVersion, graphVersionFromGraph } from "../src/graph-version";
import type { InteractionGraph } from "../src/types";

describe("graph-version (Phase A.2)", () => {
  test("stable hash: reordering inputs yields the same digest", () => {
    const a = computeGraphVersion({
      routeIds: ["api-signup", "api-login", "dashboard"],
      contractIds: ["contract:/api/signup", "contract:/api/login"],
    });
    const b = computeGraphVersion({
      routeIds: ["dashboard", "api-login", "api-signup", "dashboard"], // dup + reorder
      contractIds: ["contract:/api/login", "contract:/api/signup"],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^gv1:[a-f0-9]{32}$/);
  });

  test("adding a route changes the hash", () => {
    const baseline = computeGraphVersion({
      routeIds: ["api-signup"],
      contractIds: [],
    });
    const grown = computeGraphVersion({
      routeIds: ["api-signup", "api-login"],
      contractIds: [],
    });
    expect(baseline).not.toBe(grown);
  });

  test("adding a contract changes the hash", () => {
    const noContract = computeGraphVersion({
      routeIds: ["api-signup"],
      contractIds: [],
    });
    const withContract = computeGraphVersion({
      routeIds: ["api-signup"],
      contractIds: ["contract:/api/signup"],
    });
    expect(noContract).not.toBe(withContract);

    // And from an actual InteractionGraph shape:
    const graph: InteractionGraph = {
      schemaVersion: 1,
      generatedAt: "now",
      buildSalt: "test",
      nodes: [
        {
          kind: "route",
          id: "route:/api/signup",
          file: "app/api/signup/route.ts",
          path: "/api/signup",
          routeId: "api-signup",
          hasContract: true,
        },
      ],
      edges: [],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
    };
    const fromGraph = graphVersionFromGraph(graph);
    expect(fromGraph).toMatch(/^gv1:[a-f0-9]{32}$/);

    // null graph returns the well-known sentinel.
    expect(graphVersionFromGraph(null)).toBe("gv1:unknown");
  });
});
