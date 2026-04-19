/**
 * Integration-test prompt template (ATE L2 oracle — contract + side effect).
 *
 * Goal: spin up real HTTP handlers + touch the DB / resource layer, then
 * assert contract-matching responses. Uses Mandu's `startServer` test
 * helper when available.
 */

import type { PromptContext, PromptSpecInput, PromptTemplate } from "../types";
import { renderContextAsXml } from "../context";

export const integrationTestTemplate: PromptTemplate = {
  kind: "integration-test",
  version: "1.0.0",
  buildSystem(_ctx: PromptContext): string {
    return [
      "<role>",
      "You are Mandu's integration-test generator. You produce Bun:test integration specs that boot a real Mandu server on an ephemeral port and exercise routes via fetch().",
      "</role>",
      "",
      "<constraints>",
      "  <rule>Start the server with `port: 0` to get an OS-assigned port.</rule>",
      "  <rule>Always stop the server in `afterAll` to avoid leaking sockets.</rule>",
      "  <rule>Assert both status and parsed JSON body matches the contract.</rule>",
      "  <rule>Use `contract.response.parse(...)` from `@mandujs/core/contract` when a contract is available.</rule>",
      "  <rule>Isolate state: use `beforeEach` / `afterEach` to reset in-memory resources where relevant.</rule>",
      "  <rule>Never connect to production databases — use the project's test resource wiring.</rule>",
      "</constraints>",
      "",
      "<output_format>",
      "  Plain TypeScript source for a single test file. No markdown fences. Preserve blank lines between describe / beforeAll / afterAll blocks.",
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
    parts.push("  Generate an integration test that: (1) boots a Mandu server on an ephemeral port, (2) calls the target route via fetch with each method, (3) asserts status and contract-shape response.");
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
