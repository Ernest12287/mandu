/**
 * E2E-test prompt template (ATE L3 oracle — full browser + journey).
 *
 * Goal: Playwright spec covering navigation, hydration, interactive
 * islands, and end-user assertions. Tailored for Mandu's Islands +
 * FS routes.
 */

import type { PromptContext, PromptSpecInput, PromptTemplate } from "../types";
import { renderContextAsXml } from "../context";

export const e2eTestTemplate: PromptTemplate = {
  kind: "e2e-test",
  version: "1.0.0",
  buildSystem(_ctx: PromptContext): string {
    return [
      "<role>",
      "You are Mandu's E2E test generator. You produce Playwright specs that cover Mandu page routes including island hydration and user flows.",
      "</role>",
      "",
      "<constraints>",
      "  <rule>Use `import { test, expect } from \"@playwright/test\"`.</rule>",
      "  <rule>Navigate with `await page.goto(path)` — use the route's `path` not its `id`.</rule>",
      "  <rule>Wait for hydration when interacting with islands: `await page.waitForLoadState(\"networkidle\")`.</rule>",
      "  <rule>Prefer accessible locators: `page.getByRole`, `page.getByLabel`, `page.getByText`.</rule>",
      "  <rule>Never rely on brittle CSS selectors unless no accessible alternative exists.</rule>",
      "  <rule>Assert at least one visible element per page to verify successful render.</rule>",
      "</constraints>",
      "",
      "<output_format>",
      "  Plain TypeScript source for a single `.spec.ts` file. No markdown fences.",
      "</output_format>",
    ].join("\n");
  },
  buildUser(input: PromptSpecInput): string {
    const target = input.target ?? {};
    const contextXml = renderContextAsXml(input.context);

    const parts: string[] = [];
    parts.push(contextXml);
    parts.push("");
    parts.push("<task>");
    parts.push("  Generate a Playwright E2E spec that: (1) navigates to the target route, (2) asserts the page renders with expected headings / content, (3) exercises any interactive island if listed.");
    parts.push("</task>");
    parts.push("");
    parts.push("<target>");
    if (target.id) parts.push(`  <route_id>${target.id}</route_id>`);
    if (target.path) parts.push(`  <path>${target.path}</path>`);
    if (target.file) parts.push(`  <file>${target.file}</file>`);
    if (target.snippet) {
      parts.push(`  <source_snippet><![CDATA[${target.snippet}]]></source_snippet>`);
    }
    parts.push("</target>");
    return parts.filter((p) => p !== "").join("\n");
  },
};
