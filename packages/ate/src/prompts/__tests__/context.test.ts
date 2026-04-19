import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectContext } from "../index";

describe("loadProjectContext", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-prompts-ctx-"));

    // Sample manifest
    mkdirSync(join(root, ".mandu"), { recursive: true });
    writeFileSync(
      join(root, ".mandu", "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          routes: [
            { id: "/api/users", pattern: "/api/users", kind: "api", methods: ["GET", "POST"], module: "app/api/users/route.ts" },
            { id: "/users", pattern: "/users", kind: "page", componentModule: "app/users/page.tsx" },
          ],
        },
        null,
        2,
      ),
    );

    // Sample resources
    mkdirSync(join(root, "shared", "resources"), { recursive: true });
    writeFileSync(join(root, "shared", "resources", "user.resource.ts"), "// user");
    writeFileSync(join(root, "shared", "resources", "post.resource.ts"), "// post");

    // Guard config
    writeFileSync(
      join(root, "guard.config.ts"),
      `export default { preset: "mandu", report: true };`,
    );

    // Docs prompts
    mkdirSync(join(root, "docs", "prompts"), { recursive: true });
    writeFileSync(join(root, "docs", "prompts", "system.md"), "# System\nSys content");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads manifest with routes", () => {
    const ctx = loadProjectContext({ repoRoot: root });
    expect(ctx.manifest?.routes?.length).toBe(2);
    expect(ctx.manifest?.routes?.[0].id).toBe("/api/users");
    expect(ctx.manifest?.routes?.[0].methods).toEqual(["GET", "POST"]);
  });

  it("discovers resources from shared/resources", () => {
    const ctx = loadProjectContext({ repoRoot: root });
    const names = ctx.resources?.map((r) => r.name) ?? [];
    expect(names).toContain("user");
    expect(names).toContain("post");
  });

  it("detects guard preset from guard.config.ts", () => {
    const ctx = loadProjectContext({ repoRoot: root });
    expect(ctx.guardPreset).toBe("mandu");
  });

  it("includes prompt docs when requested", () => {
    const ctx = loadProjectContext({ repoRoot: root });
    const docs = ctx.systemDocs ?? [];
    expect(docs.some((d) => d.name === "system")).toBe(true);
  });

  it("skips prompt docs when flag disabled", () => {
    const ctx = loadProjectContext({ repoRoot: root, includePromptDocs: false });
    expect(ctx.systemDocs).toBeUndefined();
  });

  it("is safe when repo has nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "ate-prompts-empty-"));
    try {
      const ctx = loadProjectContext({ repoRoot: empty });
      expect(ctx.repoRoot).toBe(empty);
      expect(ctx.manifest).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("truncates oversized docs using maxDocChars", () => {
    const bigRoot = mkdtempSync(join(tmpdir(), "ate-prompts-big-"));
    try {
      mkdirSync(join(bigRoot, "docs", "prompts"), { recursive: true });
      writeFileSync(join(bigRoot, "docs", "prompts", "huge.md"), "a".repeat(50_000));
      const ctx = loadProjectContext({ repoRoot: bigRoot, maxDocChars: 500 });
      const huge = ctx.systemDocs?.find((d) => d.name === "huge");
      expect(huge).toBeDefined();
      expect(huge!.content.length).toBeLessThanOrEqual(600); // 500 + truncation marker
      expect(huge!.content).toContain("truncated");
    } finally {
      rmSync(bigRoot, { recursive: true, force: true });
    }
  });
});
