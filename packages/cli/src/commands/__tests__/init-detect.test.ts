/**
 * Tests for `detectProject()` — the project state classifier used by
 * `mandu init` retrofit decisions.
 *
 * Strategy: each test creates a tmpdir with the relevant fixture
 * shape (empty, package.json only, with framework markers, etc.) and
 * asserts the returned `kind` + `suggestedAction`. No code is executed
 * in those fixtures and no installs run.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectProject } from "../init-detect";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "mandu-detect-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writePkg(
  cwd: string,
  pkg: Record<string, unknown>
): Promise<void> {
  await writeFile(path.join(cwd, "package.json"), JSON.stringify(pkg, null, 2));
}

describe("detectProject", () => {
  test("empty directory → kind=empty, retrofit", async () => {
    const result = await detectProject(workDir);
    expect(result.kind).toBe("empty");
    expect(result.suggestedAction).toBe("retrofit");
    expect(result.conflicts).toEqual([]);
  });

  test("only hidden git entries → still kind=empty", async () => {
    await mkdir(path.join(workDir, ".git"));
    await writeFile(path.join(workDir, ".gitignore"), "node_modules\n");
    const result = await detectProject(workDir);
    expect(result.kind).toBe("empty");
    expect(result.suggestedAction).toBe("retrofit");
  });

  test("bare package.json → kind=barePackageJson, retrofit", async () => {
    await writePkg(workDir, { name: "x", version: "0.0.0" });
    const result = await detectProject(workDir);
    expect(result.kind).toBe("barePackageJson");
    expect(result.suggestedAction).toBe("retrofit");
    expect(result.conflicts).toEqual([]);
  });

  test("package.json with @mandujs/core → kind=manduProject, abort", async () => {
    await writePkg(workDir, {
      name: "x",
      dependencies: { "@mandujs/core": "0.43.0" },
    });
    const result = await detectProject(workDir);
    expect(result.kind).toBe("manduProject");
    expect(result.suggestedAction).toBe("abort");
  });

  test("@mandujs/core in devDependencies also counts", async () => {
    await writePkg(workDir, {
      name: "x",
      devDependencies: { "@mandujs/core": "0.43.0" },
    });
    const result = await detectProject(workDir);
    expect(result.kind).toBe("manduProject");
  });

  test("next.config.ts present → kind=nextProject, abort", async () => {
    await writePkg(workDir, { name: "x" });
    await writeFile(path.join(workDir, "next.config.ts"), "export default {};");
    const result = await detectProject(workDir);
    expect(result.kind).toBe("nextProject");
    expect(result.suggestedAction).toBe("abort");
    expect(result.reason).toMatch(/Next\.js/);
  });

  test("next in deps but no config file → still kind=nextProject", async () => {
    await writePkg(workDir, {
      name: "x",
      dependencies: { next: "^15.0.0" },
    });
    const result = await detectProject(workDir);
    expect(result.kind).toBe("nextProject");
  });

  test("vite.config.js present → kind=viteProject, abort", async () => {
    await writePkg(workDir, { name: "x" });
    await writeFile(path.join(workDir, "vite.config.js"), "export default {};");
    const result = await detectProject(workDir);
    expect(result.kind).toBe("viteProject");
    expect(result.suggestedAction).toBe("abort");
  });

  test("remix.config.js present → kind=remixProject, abort", async () => {
    await writePkg(workDir, { name: "x" });
    await writeFile(
      path.join(workDir, "remix.config.js"),
      "module.exports = {};"
    );
    const result = await detectProject(workDir);
    expect(result.kind).toBe("remixProject");
    expect(result.suggestedAction).toBe("abort");
  });

  test("@remix-run/dev in deps → kind=remixProject", async () => {
    await writePkg(workDir, {
      name: "x",
      dependencies: { "@remix-run/dev": "^2.0.0" },
    });
    const result = await detectProject(workDir);
    expect(result.kind).toBe("remixProject");
  });

  test("foreign framework wins over @mandujs/core if both present", async () => {
    await writePkg(workDir, {
      name: "x",
      dependencies: { "@mandujs/core": "0.43.0", next: "^15.0.0" },
    });
    const result = await detectProject(workDir);
    expect(result.kind).toBe("nextProject");
    expect(result.suggestedAction).toBe("abort");
  });

  test("package.json + partial mandu structure (app/) → polyglot, force-required", async () => {
    await writePkg(workDir, { name: "x" });
    await mkdir(path.join(workDir, "app"));
    const result = await detectProject(workDir);
    expect(result.kind).toBe("polyglot");
    expect(result.suggestedAction).toBe("force-required");
    expect(result.conflicts).toContain("app");
  });

  test("no package.json but other files exist → polyglot, force-required", async () => {
    await writeFile(path.join(workDir, "README.md"), "# stray");
    const result = await detectProject(workDir);
    expect(result.kind).toBe("polyglot");
    expect(result.suggestedAction).toBe("force-required");
  });

  test("conflicts list reports every Mandu scaffold path that's already present", async () => {
    await writePkg(workDir, { name: "x" });
    await mkdir(path.join(workDir, "app"));
    await mkdir(path.join(workDir, "tests"));
    await writeFile(path.join(workDir, "tsconfig.json"), "{}");
    const result = await detectProject(workDir);
    expect(result.conflicts).toContain("app");
    expect(result.conflicts).toContain("tests");
    expect(result.conflicts).toContain("tsconfig.json");
  });
});
