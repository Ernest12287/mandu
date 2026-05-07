/**
 * Tests for `mergeManduIntoPackageJson()`.
 *
 * Covers the three-way decision matrix (existing absent / aligned /
 * conflicting) for both deps and scripts, plus the `--force` override
 * path and the warning shape consumers rely on for dry-run output.
 */

import { describe, expect, test } from "bun:test";

import {
  mergeManduIntoPackageJson,
  type ManduManifest,
} from "../init-merge-package-json";

const MANIFEST: ManduManifest = {
  dependencies: {
    "@mandujs/core": "0.43.0",
    react: "^19.2.0",
    "react-dom": "^19.2.0",
  },
  devDependencies: {
    oxlint: "^1.0.0",
  },
  scripts: {
    dev: "mandu dev",
    build: "mandu build",
    start: "mandu start",
  },
};

describe("mergeManduIntoPackageJson", () => {
  test("null existing → produces a fresh package.json with all fields", () => {
    const { merged, warnings, conflicts } = mergeManduIntoPackageJson(
      null,
      MANIFEST
    );
    expect(merged.dependencies).toEqual(MANIFEST.dependencies);
    expect(merged.devDependencies).toEqual(MANIFEST.devDependencies!);
    expect(merged.scripts).toEqual(MANIFEST.scripts);
    expect(warnings).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  test("existing pkg with unrelated fields → mandu only adds, never strips", () => {
    const existing = {
      name: "user-app",
      version: "0.0.1",
      author: "alice",
    };
    const { merged } = mergeManduIntoPackageJson(existing, MANIFEST);
    expect(merged.name).toBe("user-app");
    expect(merged.version).toBe("0.0.1");
    expect(merged.author).toBe("alice");
    expect(merged.dependencies).toEqual(MANIFEST.dependencies);
  });

  test("existing dep with aligned version → no warning, no conflict", () => {
    const existing = {
      dependencies: { react: "^19.2.0" },
    };
    const { warnings, conflicts, merged } = mergeManduIntoPackageJson(
      existing,
      MANIFEST
    );
    expect(warnings).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(merged.dependencies!.react).toBe("^19.2.0");
  });

  test("existing dep with conflicting version → kept + warning", () => {
    const existing = {
      dependencies: { react: "^18.2.0" },
    };
    const { warnings, conflicts, merged } = mergeManduIntoPackageJson(
      existing,
      MANIFEST
    );
    expect(merged.dependencies!.react).toBe("^18.2.0");
    expect(conflicts).toContain("react");
    expect(warnings).toContainEqual({
      kind: "kept-existing-dep",
      name: "react",
      existing: "^18.2.0",
      proposed: "^19.2.0",
    });
  });

  test("--force overrides conflicting dep silently", () => {
    const existing = {
      dependencies: { react: "^18.2.0" },
    };
    const { warnings, conflicts, merged } = mergeManduIntoPackageJson(
      existing,
      MANIFEST,
      { force: true }
    );
    expect(merged.dependencies!.react).toBe("^19.2.0");
    expect(warnings).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  test("existing script with conflicting body → kept + warning", () => {
    const existing = {
      scripts: { dev: "vite" },
    };
    const { warnings, conflicts, merged } = mergeManduIntoPackageJson(
      existing,
      MANIFEST
    );
    expect(merged.scripts!.dev).toBe("vite");
    expect(conflicts).toContain("dev");
    expect(warnings).toContainEqual({
      kind: "kept-existing-script",
      name: "dev",
      existing: "vite",
      proposed: "mandu dev",
    });
  });

  test("--force overrides conflicting script silently", () => {
    const existing = {
      scripts: { dev: "vite" },
    };
    const { warnings, merged } = mergeManduIntoPackageJson(
      existing,
      MANIFEST,
      { force: true }
    );
    expect(merged.scripts!.dev).toBe("mandu dev");
    expect(warnings).toEqual([]);
  });

  test("existing scripts that don't collide are preserved alongside new ones", () => {
    const existing = {
      scripts: { lint: "oxlint .", custom: "echo hi" },
    };
    const { merged } = mergeManduIntoPackageJson(existing, MANIFEST);
    expect(merged.scripts!.lint).toBe("oxlint .");
    expect(merged.scripts!.custom).toBe("echo hi");
    expect(merged.scripts!.dev).toBe("mandu dev");
    expect(merged.scripts!.build).toBe("mandu build");
  });

  test("merge does not mutate the input pkg object", () => {
    const existing = {
      dependencies: { react: "^18.2.0" },
      scripts: { dev: "vite" },
    };
    const snapshot = JSON.stringify(existing);
    mergeManduIntoPackageJson(existing, MANIFEST);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  test("multiple conflicts are all reported", () => {
    const existing = {
      dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
      scripts: { dev: "vite", build: "tsc" },
    };
    const { conflicts } = mergeManduIntoPackageJson(existing, MANIFEST);
    expect(conflicts.sort()).toEqual(["build", "dev", "react", "react-dom"]);
  });
});
