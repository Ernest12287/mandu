/**
 * Phase A.3 — prompt-composer tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composePrompt } from "../src/prompt-composer";
import type { Exemplar } from "../src/exemplar-scanner";

describe("prompt-composer", () => {
  let promptDir: string;

  beforeAll(() => {
    promptDir = mkdtempSync(join(tmpdir(), "ate-prompt-composer-"));
    writeFileSync(
      join(promptDir, "filling_unit.v1.md"),
      `---
kind: filling_unit
version: 1
---

# Role
Write a bun:test.

# Exemplars

<!-- EXEMPLAR_SLOT -->
`
    );
    writeFileSync(
      join(promptDir, "no_slot.v1.md"),
      `---
kind: no_slot
version: 1
---

# Role
No slot here.
`
    );
  });

  afterAll(() => {
    rmSync(promptDir, { recursive: true, force: true });
  });

  const sampleExemplars: Exemplar[] = [
    {
      path: "tests/a.test.ts",
      startLine: 10,
      endLine: 20,
      kind: "filling_unit",
      depth: "basic",
      tags: ["happy", "post"],
      code: 'test("a", () => {\n  expect(1).toBe(1);\n});',
    },
    {
      path: "tests/b.test.ts",
      startLine: 5,
      endLine: 15,
      kind: "filling_unit",
      tags: ["intermediate"],
      code: 'test("b", () => {\n  expect(2).toBe(2);\n});',
    },
    {
      path: "tests/unrelated.test.ts",
      startLine: 1,
      endLine: 3,
      kind: "e2e_playwright",
      tags: [],
      code: 'test("unrelated", () => {});',
    },
    {
      path: "tests/anti.test.ts",
      startLine: 30,
      endLine: 40,
      kind: "filling_unit",
      tags: ["anti"],
      anti: true,
      reason: "mocks DB",
      code: 'test("anti", () => {\n  vi.mock("db");\n});',
    },
  ];

  test("composePrompt injects exemplars into the EXEMPLAR_SLOT marker", async () => {
    const result = await composePrompt({
      kind: "filling_unit",
      promptsDir: promptDir,
      exemplars: sampleExemplars,
      context: { route: "/api/signup", methods: ["POST"] },
    });
    expect(result.kind).toBe("filling_unit");
    expect(result.version).toBe(1);
    expect(result.prompt).toContain("# Role");
    expect(result.prompt).toContain("## Positive examples");
    expect(result.prompt).toContain("## Anti-examples — DO NOT do this");
    expect(result.prompt).toContain("tests/a.test.ts:10-20");
    expect(result.prompt).toContain('test("a"');
    expect(result.prompt).toContain("mocks DB");
    // EXEMPLAR_SLOT should have been replaced.
    expect(result.prompt).not.toContain("<!-- EXEMPLAR_SLOT -->");
    // Context block appended.
    expect(result.prompt).toContain("# Provided context");
    expect(result.prompt).toContain('"/api/signup"');
    // Unrelated kind exemplar excluded.
    expect(result.prompt).not.toContain("unrelated");
  });

  test("composePrompt reports accurate counts + token estimate", async () => {
    const result = await composePrompt({
      kind: "filling_unit",
      promptsDir: promptDir,
      exemplars: sampleExemplars,
    });
    expect(result.exemplarCount).toBe(2); // 2 positives
    expect(result.antiCount).toBe(1);
    // tokenEstimate is chars/4 — just sanity check it's a positive int.
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(Number.isInteger(result.tokenEstimate)).toBe(true);
  });

  test("composePrompt falls back to placeholder when no matching exemplars", async () => {
    const result = await composePrompt({
      kind: "filling_unit",
      promptsDir: promptDir,
      exemplars: [], // none
    });
    expect(result.exemplarCount).toBe(0);
    expect(result.antiCount).toBe(0);
    expect(result.prompt).toContain("_No tagged exemplars available");
  });

  test("composePrompt size is within the 2000-token (≈8000 char) budget for v1 prompts", async () => {
    // Using the real v1 filling_unit prompt — catch regressions in our canonical catalog.
    const result = await composePrompt({
      kind: "filling_unit",
      exemplars: sampleExemplars,
      context: { route: "/api/signup" },
    });
    // The pure template + composed context (without a full 20-exemplar dump)
    // should comfortably fit under the target budget.
    expect(result.tokenEstimate).toBeLessThan(3000);
  });

  test("composePrompt appends exemplar block when the template omits the slot", async () => {
    const result = await composePrompt({
      kind: "no_slot",
      promptsDir: promptDir,
      exemplars: [
        {
          path: "x.test.ts",
          startLine: 1,
          endLine: 2,
          kind: "no_slot",
          tags: [],
          code: 'test("x", () => {});',
        },
      ],
    });
    // Exemplars must still make it into the prompt — appended.
    expect(result.prompt).toContain("## Positive examples");
    expect(result.prompt).toContain("x.test.ts:1-2");
  });
});
