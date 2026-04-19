/**
 * Unit-test prompt template (ATE L0/L1 oracle — smoke + basic shape).
 *
 * Goal: produce a `bun:test` spec that exercises a single route handler
 * via `@mandujs/core/testing.testFilling` and asserts status + minimal
 * contract alignment. Matches the existing `generateUnitSpec` output so
 * callers can A/B template vs template-free modes.
 */

import type { PromptContext, PromptSpecInput, PromptTemplate } from "../types";
import { renderContextAsXml } from "../context";

export const unitTestTemplate: PromptTemplate = {
  kind: "unit-test",
  version: "1.0.0",
  buildSystem(_ctx: PromptContext): string {
    return [
      "<role>",
      "You are Mandu's unit-test generator. You produce Bun:test specs for API routes built with `Mandu.filling()`.",
      "</role>",
      "",
      "<constraints>",
      "  <rule>Use `import { testFilling } from \"@mandujs/core/testing\"` — never Node's http module directly.</rule>",
      "  <rule>Use `import { describe, it, expect } from \"bun:test\"`.</rule>",
      "  <rule>Assert response status codes for every listed HTTP method.</rule>",
      "  <rule>Prefer `expect(res.status).toBe(200)` for GET and `expect([200, 201]).toContain(res.status)` for POST.</rule>",
      "  <rule>Never import the real database, secrets, or external APIs. Mock or rely on dependency injection.</rule>",
      "  <rule>Keep each test focused: one behavior per `it()` block.</rule>",
      "</constraints>",
      "",
      "<output_format>",
      "  Plain TypeScript source for a single test file. No markdown fences. No commentary outside of code comments.",
      "</output_format>",
    ].join("\n");
  },
  buildUser(input: PromptSpecInput): string {
    const target = input.target ?? {};
    const methods = target.methods?.join(", ") ?? "GET";
    const contextXml = renderContextAsXml(input.context);

    const parts: string[] = [];
    parts.push(contextXml);
    parts.push("");
    parts.push("<task>");
    parts.push("  Generate a Bun:test unit spec that imports the route module and exercises each HTTP method using `testFilling`.");
    parts.push("</task>");
    parts.push("");
    parts.push("<target>");
    if (target.id) parts.push(`  <route_id>${target.id}</route_id>`);
    if (target.path) parts.push(`  <path>${target.path}</path>`);
    if (target.file) parts.push(`  <file>${target.file}</file>`);
    parts.push(`  <methods>${methods}</methods>`);
    if (target.snippet) {
      parts.push(`  <source_snippet><![CDATA[${target.snippet}]]></source_snippet>`);
    }
    parts.push("</target>");
    return parts.filter((p) => p !== "").join("\n");
  },
};
