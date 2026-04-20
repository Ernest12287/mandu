/**
 * `mandu_ate_save` — Phase A.3 spec persistence with lint-before-write.
 *
 * See `docs/ate/roadmap-v2-agent-native.md` §4.7 and the §7 extension
 * ("mandu_ate_save lint-before-write").
 *
 * Semantics:
 *   1. Run `lintSpecContent` (from @mandujs/ate) which:
 *        - parses with ts-morph (syntax errors block),
 *        - walks import declarations (banned typos, unknown @mandujs/* barrels),
 *        - detects anti-patterns (bare localhost, hand-rolled CSRF, DB mocks).
 *   2. If any *blocking* diagnostic fires, return { saved: false, ... } WITHOUT
 *      writing. Otherwise write and return { saved: true, path }.
 *
 * Snake_case tool name (§11 decision #4).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { lintSpecContent, type LintDiagnostic } from "@mandujs/ate";

// Re-export the diagnostic shape so callers can type-check against it without
// pulling @mandujs/ate directly.
export type { LintDiagnostic, LintSeverity } from "@mandujs/ate";

export const ateSaveToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_save",
    description:
      "Phase A.3 persist-with-lint. Writes an agent-generated test file to " +
      "disk, but first runs a small lint pass that blocks common LLM mistakes: " +
      "ts-morph syntax errors, unresolved / banned import paths, hand-rolled " +
      "CSRF cookies, DB mocks when createTestDb is available, and bare " +
      "`localhost:<port>` URLs (prefer 127.0.0.1 per roadmap §9.2). Returns " +
      "{ saved: true, path, lintDiagnostics: [warnings...] } on success or " +
      "{ saved: false, blockingErrors: [...], lintDiagnostics: [...] } when " +
      "a blocker fires (in which case no file is written).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path where the spec will be written. Parent directories are created if needed.",
        },
        content: {
          type: "string",
          description: "The full TypeScript test source to write.",
        },
        intent: {
          type: "string",
          description:
            "Optional short description of what the test is verifying (logged to ATE memory).",
        },
        kind: {
          type: "string",
          description:
            "Optional prompt kind this spec was generated for (filling_unit, filling_integration, e2e_playwright).",
        },
        sourcePrompt: {
          type: "object",
          description:
            "Optional { kind, version } back-reference to the prompt that produced this spec (used by future memory queries).",
          additionalProperties: true,
        },
        allowWarnings: {
          type: "boolean",
          description:
            "When true, non-blocking warnings still allow the write (default true). When false, even warnings block.",
        },
      },
      required: ["path", "content"],
    },
  },
];

export function ateSaveTools(_projectRoot: string) {
  return {
    mandu_ate_save: async (args: Record<string, unknown>) => {
      const path = args.path as string | undefined;
      const content = args.content as string | undefined;
      const allowWarnings = args.allowWarnings !== false;

      if (!path || typeof path !== "string") {
        return { saved: false, error: "'path' is required" };
      }
      if (!isAbsolute(path)) {
        return {
          saved: false,
          error: "'path' must be absolute — relative paths are rejected to prevent cwd drift.",
        };
      }
      if (typeof content !== "string") {
        return { saved: false, error: "'content' is required and must be a string" };
      }

      const diagnostics = await lintSpecContent(path, content);

      const blocking = diagnostics.filter((d) => d.blocking);
      const warnings = diagnostics.filter((d) => !d.blocking);

      if (blocking.length > 0 || (!allowWarnings && warnings.length > 0)) {
        return {
          saved: false,
          path,
          blockingErrors: blocking,
          lintDiagnostics: diagnostics,
        };
      }

      const parent = dirname(path);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      if (!statSync(parent).isDirectory()) {
        return { saved: false, path, error: `Parent path is not a directory: ${parent}` };
      }

      writeFileSync(path, content, "utf8");

      return {
        saved: true,
        path,
        bytes: Buffer.byteLength(content, "utf8"),
        lintDiagnostics: diagnostics,
      };
    },
  };
}

// Re-export for tests that need direct access (package.json test patterns
// already reach here).
export async function lintContent(
  path: string,
  content: string,
): Promise<LintDiagnostic[]> {
  return lintSpecContent(path, content);
}
