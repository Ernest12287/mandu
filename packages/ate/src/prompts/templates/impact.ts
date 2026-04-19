/**
 * Impact prompt template — given a git diff and an interaction graph,
 * ask the model which tests are most likely to regress. Strictly
 * opt-in; default `computeImpact()` remains deterministic.
 */

import type { PromptContext, PromptSpecInput, PromptTemplate } from "../types";
import { renderContextAsXml } from "../context";

export const impactTemplate: PromptTemplate = {
  kind: "impact",
  version: "1.0.0",
  buildSystem(_ctx: PromptContext): string {
    return [
      "<role>",
      "You are Mandu's regression impact analyst. Given a diff + the project's interaction graph, return the minimal set of tests that cover the changed surface.",
      "</role>",
      "",
      "<constraints>",
      "  <rule>Prefer over-selection (false positives) to under-selection (false negatives).</rule>",
      "  <rule>Return route IDs that appear in the provided manifest.</rule>",
      "  <rule>If you are unsure, return an empty list and set `mode=\"full\"`.</rule>",
      "</constraints>",
      "",
      "<output_format>",
      "  <impact>",
      "    <mode>subset|full</mode>",
      "    <selected_routes>",
      "      <route>/api/users</route>",
      "    </selected_routes>",
      "    <rationale>1-3 sentences</rationale>",
      "  </impact>",
      "</output_format>",
    ].join("\n");
  },
  buildUser(input: PromptSpecInput): string {
    const contextXml = renderContextAsXml(input.context);
    const parts: string[] = [contextXml];
    parts.push("");
    parts.push("<task>");
    parts.push("  Determine which routes may regress given the diff below.");
    parts.push("</task>");

    if (input.target?.snippet) {
      parts.push("<diff><![CDATA[");
      parts.push(input.target.snippet);
      parts.push("]]></diff>");
    }

    return parts.filter((p) => p !== "").join("\n");
  },
};
