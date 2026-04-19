/**
 * Heal prompt template — wraps existing heal failure categories in an
 * LLM-friendly XML structure so a model can either (a) recommend the
 * best of the provided candidate fixes or (b) synthesize an alternate
 * fix when none fit.
 *
 * Backwards compatibility: existing `heal()` in `packages/ate/src/heal.ts`
 * is NOT changed; this template is opt-in for future LLM integration.
 */

import type { PromptContext, PromptSpecInput, PromptTemplate } from "../types";
import { renderContextAsXml } from "../context";

export const healTemplate: PromptTemplate = {
  kind: "heal",
  version: "1.0.0",
  buildSystem(_ctx: PromptContext): string {
    return [
      "<role>",
      "You are Mandu's test heal agent. A test suite just failed. You must pick the safest fix from the provided candidates, or propose a new one if none applies.",
      "</role>",
      "",
      "<constraints>",
      "  <rule>Prefer fixes classified as auto-applicable (selector-stale) over manual-review categories.</rule>",
      "  <rule>Never silently weaken an assertion — if the assertion was correct, fix the production code instead.</rule>",
      "  <rule>Never modify unrelated files.</rule>",
      "  <rule>Reply with a single XML block `<heal_decision>` containing `<category>`, `<action>`, `<confidence>`, and `<diff>`.</rule>",
      "</constraints>",
      "",
      "<output_format>",
      "  <heal_decision>",
      "    <category>selector-stale|api-shape-changed|component-restructured|race-condition|timeout|assertion-mismatch|unknown</category>",
      "    <action>apply|review|reject</action>",
      "    <confidence>0.0-1.0</confidence>",
      "    <diff><![CDATA[unified diff]]></diff>",
      "  </heal_decision>",
      "</output_format>",
    ].join("\n");
  },
  buildUser(input: PromptSpecInput): string {
    const contextXml = renderContextAsXml(input.context);

    const parts: string[] = [];
    parts.push(contextXml);
    parts.push("");
    parts.push("<task>");
    parts.push("  Inspect the failing test trace and candidate suggestions, then decide the heal action.");
    parts.push("</task>");

    if (input.target?.snippet) {
      parts.push("<failure_trace><![CDATA[");
      parts.push(input.target.snippet);
      parts.push("]]></failure_trace>");
    }
    if (input.target?.file) {
      parts.push(`<test_file>${input.target.file}</test_file>`);
    }

    return parts.filter((p) => p !== "").join("\n");
  },
};
