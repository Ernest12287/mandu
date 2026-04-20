/**
 * Phase A.3 — exemplar-scanner tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanExemplars,
  scanMarkers,
  parseMarker,
} from "../src/exemplar-scanner";

describe("exemplar-scanner", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ate-exemplar-scanner-"));
    mkdirSync(join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });

    // A file with multiple positive exemplars + one anti + one untagged block.
    writeFileSync(
      join(dir, "tests", "auth.test.ts"),
      `import { test, describe, it } from "bun:test";

describe("auth", () => {
  // @ate-exemplar: kind=filling_unit depth=basic tags=happy,signup
  test("signup happy path", async () => {
    // pretend body
    const value = { ok: true };
    expect(value.ok).toBe(true);
  });

  // No marker — should not appear.
  it("untagged", () => {
    expect(1).toBe(1);
  });

  // @ate-exemplar-anti: kind=filling_unit reason="mocks DB"
  it("bad example — mocks db", () => {
    vi.mock("./db", () => ({}));
    expect(true).toBe(true);
  });
});
`
    );

    // A .tsx file with a JSDoc-style marker.
    writeFileSync(
      join(dir, "tests", "form.test.tsx"),
      `import { test } from "bun:test";

/** @ate-exemplar: kind=e2e_playwright tags=tsx,form */
test("renders a form", async () => {
  const markup = <form data-route-id="signup"></form>;
  expect(markup).toBeTruthy();
});
`
    );

    // An orphan marker — no test block follows.
    writeFileSync(
      join(dir, "tests", "orphan.test.ts"),
      `import { test } from "bun:test";

// @ate-exemplar: kind=filling_unit tags=orphan
// (nothing follows — should be caught by scanMarkers but NOT by scanExemplars)
export const foo = 1;
`
    );

    // Malformed marker — no kind=.
    writeFileSync(
      join(dir, "tests", "malformed.test.ts"),
      `import { test } from "bun:test";

// @ate-exemplar: depth=basic tags=nokind
test("no kind attr", () => {});
`
    );

    // node_modules / .mandu / .git should be ignored.
    mkdirSync(join(dir, "node_modules", "foo"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "foo", "bad.test.ts"),
      `// @ate-exemplar: kind=filling_unit tags=from-node-modules\ntest("x", () => {});`
    );

    // A non-test file with a marker — still captured (scanner doesn't demand
    // *.test.*). Uses a describe call which the scanner treats as a valid block.
    writeFileSync(
      join(dir, "src", "helper.ts"),
      `// @ate-exemplar: kind=filling_integration depth=basic tags=helper
describe("helper block", () => {
  it("inner", () => {});
});
`
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("parseMarker extracts kind + depth + tags + reason", () => {
    const m1 = parseMarker(
      "// @ate-exemplar: kind=filling_unit depth=basic tags=post,formdata"
    );
    expect(m1).not.toBeNull();
    expect(m1!.anti).toBe(false);
    expect(m1!.kind).toBe("filling_unit");
    expect(m1!.depth).toBe("basic");
    expect(m1!.tags).toEqual(["post", "formdata"]);

    const m2 = parseMarker('// @ate-exemplar-anti: kind=foo reason="mocks DB"');
    expect(m2).not.toBeNull();
    expect(m2!.anti).toBe(true);
    expect(m2!.kind).toBe("foo");
    expect(m2!.reason).toBe("mocks DB");

    // Malformed — no kind.
    const m3 = parseMarker("// @ate-exemplar: depth=basic");
    expect(m3).toBeNull();

    // Not a marker at all.
    const m4 = parseMarker("// just a comment");
    expect(m4).toBeNull();
  });

  test("scanExemplars captures positive and anti markers with full code", async () => {
    const entries = await scanExemplars(dir);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("tests/auth.test.ts");
    expect(paths).toContain("tests/form.test.tsx");
    // Orphan is NOT included (no following test block).
    expect(paths.filter((p) => p === "tests/orphan.test.ts")).toHaveLength(0);
    // Malformed is NOT included (no kind).
    expect(paths.filter((p) => p === "tests/malformed.test.ts")).toHaveLength(0);
    // node_modules filtered out.
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);

    const signup = entries.find((e) => e.code.includes("signup happy path"));
    expect(signup).toBeDefined();
    expect(signup!.kind).toBe("filling_unit");
    expect(signup!.depth).toBe("basic");
    expect(signup!.tags).toEqual(["happy", "signup"]);
    expect(signup!.anti).toBeUndefined();
    expect(signup!.code).toContain("test(");
    expect(signup!.code).toContain("expect(value.ok).toBe(true)");
    expect(signup!.endLine).toBeGreaterThan(signup!.startLine);
  });

  test("scanExemplars captures anti-exemplars with reason", async () => {
    const entries = await scanExemplars(dir);
    const anti = entries.find((e) => e.anti === true);
    expect(anti).toBeDefined();
    expect(anti!.reason).toBe("mocks DB");
    expect(anti!.code).toContain("vi.mock");
  });

  test("scanExemplars handles .tsx with JSDoc markers", async () => {
    const entries = await scanExemplars(dir);
    const tsx = entries.find((e) => e.path.endsWith(".tsx"));
    expect(tsx).toBeDefined();
    expect(tsx!.kind).toBe("e2e_playwright");
    expect(tsx!.tags).toContain("tsx");
    // Code capture must still include the JSX call.
    expect(tsx!.code).toContain("data-route-id=\"signup\"");
  });

  test("scanExemplars captures the full block, not just the call line", async () => {
    const entries = await scanExemplars(dir);
    const signup = entries.find((e) => e.tags.includes("signup"));
    expect(signup).toBeDefined();
    // Multi-line capture — at least one line after the opening call.
    expect(signup!.code.split("\n").length).toBeGreaterThan(2);
  });

  test("scanMarkers reports even orphans + malformed so the CLI lint can flag them", async () => {
    const markers = await scanMarkers(dir);
    const orphanSite = markers.find((m) => m.path === "tests/orphan.test.ts");
    expect(orphanSite).toBeDefined();
    expect(orphanSite!.marker.kind).toBe("filling_unit");

    // Malformed (no kind) should not be surfaced — parseMarker filters it.
    const malformedSite = markers.find((m) => m.path === "tests/malformed.test.ts");
    expect(malformedSite).toBeUndefined();
  });
});
