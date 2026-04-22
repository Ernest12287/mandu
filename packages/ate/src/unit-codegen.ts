import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ensureDir, getAtePaths, readJson } from "./fs";
import type { InteractionGraph, InteractionNode } from "./types";
import { promptFor } from "./prompts";
import type { PromptProvider, PromptSpec } from "./prompts";

type RouteNode = Extract<InteractionNode, { kind: "route" }>;

/**
 * Generate a bun:test unit spec for a single route node using testFilling.
 *
 * Backwards-compatible: the output format is byte-equivalent to the v0.17
 * implementation. This function is deterministic and does NOT call any
 * LLM. See `promptForUnitTest()` if you want the prompt-library variant
 * for model-based generation.
 */
export function generateUnitSpec(route: RouteNode): string {
  const lines: string[] = [];
  lines.push(`import { testFilling } from "@mandujs/core/testing";`);
  lines.push(`import { describe, it, expect } from "bun:test";`);
  lines.push(`import route from "${route.file}";`);
  lines.push(``);
  lines.push(`describe("${route.id}", () => {`);

  const methods = route.methods ?? ["GET"];

  if (methods.includes("GET")) {
    lines.push(`  it("GET returns 200", async () => {`);
    lines.push(`    const res = await testFilling(route, { method: "GET" });`);
    lines.push(`    expect(res.status).toBe(200);`);
    lines.push(`  });`);
  }

  if (methods.includes("POST")) {
    lines.push(`  it("POST with valid body returns 200/201", async () => {`);
    lines.push(`    const res = await testFilling(route, { method: "POST", body: {} });`);
    lines.push(`    expect([200, 201]).toContain(res.status);`);
    lines.push(`  });`);
  }

  lines.push(`});`);
  return lines.join("\n");
}

/**
 * Build a PromptSpec for unit-test generation of a single route. Callers
 * pass the result to their LLM SDK.
 *
 * This is an additive helper — existing deterministic codegen keeps working.
 */
export function promptForUnitTest(
  route: RouteNode,
  opts: { provider?: PromptProvider; repoRoot?: string } = {},
): PromptSpec {
  return promptFor({
    kind: "unit-test",
    provider: opts.provider ?? "claude",
    context: opts.repoRoot ? { repoRoot: opts.repoRoot } : undefined,
    target: {
      id: route.id,
      file: route.file,
      path: route.path,
      methods: route.methods,
    },
  });
}

export interface UnitCodegenResult {
  files: string[];
  warnings: string[];
}

/**
 * Generate bun:test unit specs for all route nodes in the interaction graph.
 * Writes files to tests/unit/auto/ under the repo root.
 */
export function generateUnitSpecs(
  repoRoot: string,
  opts?: { onlyRoutes?: string[] },
): UnitCodegenResult {
  const paths = getAtePaths(repoRoot);
  const warnings: string[] = [];

  let graph: InteractionGraph;
  try {
    graph = readJson<InteractionGraph>(paths.interactionGraphPath);
  } catch (err: unknown) {
    throw new Error(
      `Interaction graph read failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const routes = graph.nodes.filter((n): n is RouteNode => n.kind === "route");
  if (routes.length === 0) {
    warnings.push("No route nodes found in interaction graph");
    return { files: [], warnings };
  }

  const outDir = join(repoRoot, "tests", "unit", "auto");
  ensureDir(outDir);

  const files: string[] = [];
  for (const route of routes) {
    if (opts?.onlyRoutes?.length && !opts.onlyRoutes.includes(route.id)) continue;

    const safeId = route.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(outDir, `${safeId}.test.ts`);
    try {
      writeFileSync(filePath, generateUnitSpec(route), "utf8");
      files.push(filePath);
    } catch (err: unknown) {
      warnings.push(
        `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { files, warnings };
}
