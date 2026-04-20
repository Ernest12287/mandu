import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexSpecs, specsForRouteId } from "../src/spec-indexer";

describe("spec-indexer (Phase A.1)", () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-spec-indexer-"));

    // Lay out: tests/e2e + tests/e2e/auto + packages/foo/tests — mirrors
    // the real mandu monorepo topology.
    mkdirSync(join(repoRoot, "tests", "e2e"), { recursive: true });
    mkdirSync(join(repoRoot, "tests", "e2e", "auto"), { recursive: true });
    mkdirSync(join(repoRoot, "app", "api", "signup"), { recursive: true });
    mkdirSync(join(repoRoot, "app", "api", "login"), { recursive: true });
    mkdirSync(join(repoRoot, "packages", "foo", "tests"), { recursive: true });
    mkdirSync(join(repoRoot, ".mandu"), { recursive: true });

    // 1. User-written spec with `@ate-covers` comment.
    writeFileSync(
      join(repoRoot, "tests", "e2e", "signup.spec.ts"),
      `
        // @ate-covers: api-signup, page-signup
        import { test } from "@playwright/test";
        test("signup happy path", async () => {});
      `
    );

    // 2. User-written spec that covers a route by import resolution.
    writeFileSync(
      join(repoRoot, "app", "api", "login", "route.ts"),
      `export async function POST() { return new Response(); }`
    );
    writeFileSync(
      join(repoRoot, "tests", "e2e", "login.spec.ts"),
      `
        import handler from "../../app/api/login/route";
        test("login flow", async () => {});
      `
    );

    // 3. ATE-generated spec under tests/e2e/auto/ — should be classified
    //    as "ate-generated" regardless of coverage resolution.
    writeFileSync(
      join(repoRoot, "tests", "e2e", "auto", "api__signup.spec.ts"),
      `
        // @ate-covers: api-signup
        import { test } from "@playwright/test";
        test("auto-generated signup", async () => {});
      `
    );

    // 4. Package-local unit test — globs include packages/**/tests/**/*.test.ts.
    writeFileSync(
      join(repoRoot, "packages", "foo", "tests", "widget.test.ts"),
      `test("widget", () => {});`
    );

    // 5. Last-run record — one pass, one fail.
    writeFileSync(
      join(repoRoot, ".mandu", "ate-last-run.json"),
      JSON.stringify({
        "tests/e2e/signup.spec.ts": { status: "pass", lastRun: "2026-04-20T10:32:00Z" },
        "tests/e2e/login.spec.ts": { status: "fail", lastRun: "2026-04-20T10:33:00Z" },
      })
    );
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("indexes spec files across tests/ and packages/**/tests/", () => {
    const index = indexSpecs(repoRoot);
    // 4 spec files in total (signup, login, auto/api__signup, widget).
    expect(index.scanned).toBe(4);
    expect(index.specs).toHaveLength(4);
  });

  test("classifies specs under tests/e2e/auto/ as ate-generated", () => {
    const index = indexSpecs(repoRoot);
    const auto = index.specs.find((s) => s.path === "tests/e2e/auto/api__signup.spec.ts");
    expect(auto).toBeDefined();
    expect(auto?.kind).toBe("ate-generated");

    const userWritten = index.specs.find((s) => s.path === "tests/e2e/signup.spec.ts");
    expect(userWritten?.kind).toBe("user-written");
  });

  test("resolves coverage via @ate-covers comment", () => {
    const index = indexSpecs(repoRoot);
    const signup = index.specs.find((s) => s.path === "tests/e2e/signup.spec.ts");
    expect(signup?.coverage.covers).toEqual(expect.arrayContaining(["api-signup", "page-signup"]));
    expect(signup?.coverage.coversRouteId).toBe("api-signup");
  });

  test("resolves coverage via import path → route id", () => {
    const index = indexSpecs(repoRoot);
    const login = index.specs.find((s) => s.path === "tests/e2e/login.spec.ts");
    expect(login?.coverage.covers).toContain("api-login");
    expect(login?.coverage.coversFile).toBeTruthy();
  });

  test("attaches last-run status when .mandu/ate-last-run.json is present", () => {
    const index = indexSpecs(repoRoot);
    const signup = index.specs.find((s) => s.path === "tests/e2e/signup.spec.ts");
    expect(signup?.status).toBe("pass");
    expect(signup?.lastRun).toBe("2026-04-20T10:32:00Z");

    const login = index.specs.find((s) => s.path === "tests/e2e/login.spec.ts");
    expect(login?.status).toBe("fail");
  });

  test("returns null status when no last-run record for a spec", () => {
    const index = indexSpecs(repoRoot);
    const widget = index.specs.find((s) => s.path === "packages/foo/tests/widget.test.ts");
    expect(widget?.status).toBeNull();
    expect(widget?.lastRun).toBeNull();
  });

  test("specsForRouteId filters by coverage", () => {
    const index = indexSpecs(repoRoot);
    const hits = specsForRouteId(index, "api-signup");
    // 2 specs cover api-signup: the user-written spec + the auto-generated one.
    expect(hits).toHaveLength(2);
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("tests/e2e/signup.spec.ts");
    expect(paths).toContain("tests/e2e/auto/api__signup.spec.ts");
  });

  test("handles missing last-run file gracefully", () => {
    const barren = mkdtempSync(join(tmpdir(), "ate-spec-indexer-bare-"));
    mkdirSync(join(barren, "tests", "e2e"), { recursive: true });
    writeFileSync(
      join(barren, "tests", "e2e", "nope.spec.ts"),
      `test("nope", () => {});`
    );
    const index = indexSpecs(barren);
    expect(index.specs).toHaveLength(1);
    expect(index.specs[0].lastRun).toBeNull();
    rmSync(barren, { recursive: true, force: true });
  });
});
