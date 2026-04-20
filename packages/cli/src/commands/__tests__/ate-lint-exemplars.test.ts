/**
 * `mandu ate lint-exemplars` — CLI subcommand tests.
 *
 * Uses a tmpdir repo so we don't depend on the state of the real repo's
 * markers (which evolve). The CLI's core logic is `lintExemplars()` —
 * the shell thin wrapper (flags parsing + theme colouring) is exercised
 * indirectly via that.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintExemplars } from "../ate";

describe("mandu ate lint-exemplars", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cli-ate-lint-"));
    mkdirSync(join(root, "tests"), { recursive: true });

    // 1. A clean exemplar.
    writeFileSync(
      join(root, "tests", "ok.test.ts"),
      `import { test } from "bun:test";
// @ate-exemplar: kind=filling_unit tags=a
test("ok", () => { expect(1).toBe(1); });
`
    );

    // 2. An orphan marker (no test block follows).
    writeFileSync(
      join(root, "tests", "orphan.test.ts"),
      `// @ate-exemplar: kind=filling_unit tags=orphan
export const foo = 1;
`
    );

    // 3. An anti-exemplar missing reason=.
    writeFileSync(
      join(root, "tests", "anti-no-reason.test.ts"),
      `import { test } from "bun:test";
// @ate-exemplar-anti: kind=filling_unit
test("bad", () => { expect(1).toBe(1); });
`
    );

    // 4. An unknown kind.
    writeFileSync(
      join(root, "tests", "unknown-kind.test.ts"),
      `import { test } from "bun:test";
// @ate-exemplar: kind=not_a_real_kind tags=x
test("weird", () => { expect(1).toBe(1); });
`
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("reports orphan, missing-reason, and unknown-kind issues", async () => {
    const report = await lintExemplars(root);
    expect(report.scanned).toBeGreaterThanOrEqual(4);

    const kinds = report.issues.map((i) => i.kind);
    expect(kinds).toContain("orphan");
    expect(kinds).toContain("anti_missing_reason");
    expect(kinds).toContain("unknown_kind");
  });

  test("each issue has path + line + detail fields", async () => {
    const report = await lintExemplars(root);
    expect(report.issues.length).toBeGreaterThan(0);
    for (const iss of report.issues) {
      expect(typeof iss.path).toBe("string");
      expect(typeof iss.line).toBe("number");
      expect(iss.line).toBeGreaterThan(0);
      expect(typeof iss.detail).toBe("string");
      expect(iss.detail.length).toBeGreaterThan(5);
    }
  });

  test("clean repo (no issues) returns empty issues array", async () => {
    const clean = mkdtempSync(join(tmpdir(), "cli-ate-lint-clean-"));
    mkdirSync(join(clean, "tests"), { recursive: true });
    writeFileSync(
      join(clean, "tests", "good.test.ts"),
      `import { test } from "bun:test";
// @ate-exemplar: kind=filling_unit tags=ok
test("clean", () => { expect(1).toBe(1); });
// @ate-exemplar-anti: kind=filling_unit reason="shows why"
test("anti-ok", () => { expect(1).toBe(1); });
`
    );
    try {
      const report = await lintExemplars(clean);
      expect(report.issues).toHaveLength(0);
      expect(report.positive).toBe(1);
      expect(report.anti).toBe(1);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
