/**
 * Issue #250 — Heuristic inferer rule-tree tests.
 *
 * One test per rule-tree branch — adding a rule means adding a test.
 * Rationale strings are validated at the substring level so wording
 * tweaks don't break tests but missing reasons do.
 */

import { describe, it, expect } from "bun:test";
import { inferDeployIntentHeuristic } from "../../../src/deploy/inference/heuristic";
import type { DependencyClass, DeployInferenceContext } from "../../../src/deploy/inference/context";

function ctx(overrides: Partial<DeployInferenceContext>): DeployInferenceContext {
  return {
    routeId: "x",
    pattern: "/x",
    kind: "api",
    isDynamic: false,
    hasGenerateStaticParams: false,
    imports: [],
    dependencyClasses: new Set<DependencyClass>(["fetch-only"]),
    exportsFilling: true,
    sourceHash: "h".repeat(64),
    ...overrides,
  };
}

describe("heuristic — metadata", () => {
  it("metadata routes ship as static with cache headers", () => {
    const r = inferDeployIntentHeuristic(ctx({ kind: "metadata", pattern: "/sitemap.xml" }));
    expect(r.intent.runtime).toBe("static");
    expect(r.intent.cache).toEqual({ sMaxAge: 3600, swr: 86_400 });
  });
});

describe("heuristic — pages", () => {
  it("non-dynamic page → static + long s-maxage", () => {
    const r = inferDeployIntentHeuristic(ctx({ kind: "page", isDynamic: false }));
    expect(r.intent.runtime).toBe("static");
    expect(r.intent.cache).toEqual({ sMaxAge: 31_536_000, swr: 86_400 });
  });

  it("dynamic page WITH generateStaticParams → static", () => {
    const r = inferDeployIntentHeuristic(
      ctx({ kind: "page", isDynamic: true, hasGenerateStaticParams: true }),
    );
    expect(r.intent.runtime).toBe("static");
    expect(r.rationale).toMatch(/generateStaticParams/);
  });

  it("dynamic page WITHOUT generateStaticParams + edge-safe deps → edge", () => {
    const r = inferDeployIntentHeuristic(
      ctx({
        kind: "page",
        isDynamic: true,
        hasGenerateStaticParams: false,
        dependencyClasses: new Set<DependencyClass>(["fetch-only"]),
      }),
    );
    expect(r.intent.runtime).toBe("edge");
    expect(r.intent.cache).toBe("no-store");
  });

  it("dynamic page with DB import → node", () => {
    const r = inferDeployIntentHeuristic(
      ctx({
        kind: "page",
        isDynamic: true,
        hasGenerateStaticParams: false,
        dependencyClasses: new Set<DependencyClass>(["db"]),
      }),
    );
    expect(r.intent.runtime).toBe("node");
    expect(r.rationale).toMatch(/database/);
  });
});

describe("heuristic — APIs", () => {
  it("stateless API → edge", () => {
    const r = inferDeployIntentHeuristic(
      ctx({
        kind: "api",
        dependencyClasses: new Set<DependencyClass>(["fetch-only"]),
      }),
    );
    expect(r.intent.runtime).toBe("edge");
  });

  it("API with DB import → node", () => {
    const r = inferDeployIntentHeuristic(
      ctx({
        kind: "api",
        dependencyClasses: new Set<DependencyClass>(["db"]),
      }),
    );
    expect(r.intent.runtime).toBe("node");
  });

  it("API with bun:* import → bun", () => {
    const r = inferDeployIntentHeuristic(
      ctx({
        kind: "api",
        dependencyClasses: new Set<DependencyClass>(["bun-native"]),
      }),
    );
    expect(r.intent.runtime).toBe("bun");
    expect(r.rationale).toMatch(/bun:/);
  });

  it("API with AI SDK → node (long latency, edge-incompatible)", () => {
    const r = inferDeployIntentHeuristic(
      ctx({
        kind: "api",
        dependencyClasses: new Set<DependencyClass>(["ai-sdk"]),
      }),
    );
    expect(r.intent.runtime).toBe("node");
    expect(r.rationale).toMatch(/AI SDK/);
  });

  it("API never gets a cache directive other than no-store", () => {
    const r = inferDeployIntentHeuristic(
      ctx({
        kind: "api",
        dependencyClasses: new Set<DependencyClass>(["fetch-only"]),
      }),
    );
    expect(r.intent.cache).toBe("no-store");
  });
});

describe("heuristic — every branch produces a non-empty rationale", () => {
  const cases: Array<Partial<DeployInferenceContext>> = [
    { kind: "metadata" },
    { kind: "page", isDynamic: false },
    { kind: "page", isDynamic: true, hasGenerateStaticParams: true },
    { kind: "page", isDynamic: true, dependencyClasses: new Set<DependencyClass>(["fetch-only"]) },
    { kind: "page", isDynamic: true, dependencyClasses: new Set<DependencyClass>(["db"]) },
    { kind: "api", dependencyClasses: new Set<DependencyClass>(["fetch-only"]) },
    { kind: "api", dependencyClasses: new Set<DependencyClass>(["db"]) },
  ];
  for (const overrides of cases) {
    it(`rationale present for ${JSON.stringify(overrides)}`, () => {
      const r = inferDeployIntentHeuristic(ctx(overrides));
      expect(r.rationale.length).toBeGreaterThan(10);
    });
  }
});
