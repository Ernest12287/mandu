/**
 * Sidebar generator tests (Issue #199).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { defineCollection } from "../../src/content/collection";
import {
  generateSidebar,
  generateCategoryTree,
  type Category,
  type CategoryEntry,
} from "../../src/content/sidebar";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandu-sidebar-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDoc(relPath: string, contents: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

function writeMeta(relPath: string, meta: Record<string, unknown>): void {
  writeDoc(relPath, JSON.stringify(meta, null, 2));
}

describe("generateSidebar", () => {
  test("builds flat tree with default basePath", async () => {
    writeDoc("docs/a.md", "---\ntitle: Alpha\norder: 1\n---\n");
    writeDoc("docs/b.md", "---\ntitle: Beta\norder: 2\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string(), order: z.number().optional() }),
    });
    const sidebar = await generateSidebar(c);
    expect(sidebar.map((n) => n.href)).toEqual(["/a", "/b"]);
    expect(sidebar[0].title).toBe("Alpha");
  });

  test("respects basePath option", async () => {
    writeDoc("docs/intro.md", "---\ntitle: Intro\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const sidebar = await generateSidebar(c, { basePath: "/docs" });
    expect(sidebar[0].href).toBe("/docs/intro");
  });

  test("groups nested slugs into children", async () => {
    writeDoc("docs/intro.md", "---\ntitle: Intro\n---\n");
    writeDoc("docs/guide/setup.md", "---\ntitle: Setup\n---\n");
    writeDoc("docs/guide/deploy.md", "---\ntitle: Deploy\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const sidebar = await generateSidebar(c);
    const guide = sidebar.find((n) => n.title === "guide" || n.href === "/guide");
    expect(guide).toBeDefined();
    expect(guide!.children?.length).toBe(2);
    const titles = guide!.children!.map((c) => c.title).sort();
    expect(titles).toEqual(["Deploy", "Setup"]);
  });

  test("filters drafts by default", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    writeDoc(
      "docs/b.md",
      "---\ntitle: B\ndraft: true\n---\n"
    );
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({
        title: z.string(),
        draft: z.boolean().default(false),
      }),
    });
    const sidebar = await generateSidebar(c);
    expect(sidebar.map((n) => n.title)).toEqual(["A"]);
  });

  test("includeDrafts: true surfaces drafts with flag", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    writeDoc(
      "docs/b.md",
      "---\ntitle: B\ndraft: true\n---\n"
    );
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({
        title: z.string(),
        draft: z.boolean().default(false),
      }),
    });
    const sidebar = await generateSidebar(c, { includeDrafts: true });
    const b = sidebar.find((n) => n.title === "B");
    expect(b?.draft).toBe(true);
  });

  test("custom getTitle override is respected", async () => {
    writeDoc("docs/a.md", "---\ntitle: Alpha\nnav_label: α\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string(), nav_label: z.string().optional() }),
    });
    const sidebar = await generateSidebar(c, {
      getTitle: (e) => e.data.nav_label ?? e.data.title,
    });
    expect(sidebar[0].title).toBe("α");
  });

  test("numeric-aware sorting (10 after 2)", async () => {
    writeDoc("docs/02-intro.md", "---\ntitle: 02 Intro\n---\n");
    writeDoc("docs/10-advanced.md", "---\ntitle: 10 Advanced\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const sidebar = await generateSidebar(c);
    // Titles sort numeric-aware so 02 < 10 even though lex "10" < "02"
    expect(sidebar[0].title).toBe("02 Intro");
    expect(sidebar[1].title).toBe("10 Advanced");
  });
});

describe("generateSidebar with _meta.json (Issue #205)", () => {
  test("_meta.json pages[] array controls explicit sibling order", async () => {
    writeDoc("docs/alpha.md", "---\ntitle: Alpha\n---\n");
    writeDoc("docs/beta.md", "---\ntitle: Beta\n---\n");
    writeDoc("docs/gamma.md", "---\ntitle: Gamma\n---\n");
    // Explicit pages order overrides alphabetical default — Beta
    // should sort first even though it's lex-middle.
    writeMeta("docs/_meta.json", { pages: ["beta", "gamma", "alpha"] });
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const sidebar = await generateSidebar(c);
    expect(sidebar.map((n) => n.title)).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  test("entries not listed in pages[] are appended after listed ones", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    writeDoc("docs/b.md", "---\ntitle: B\n---\n");
    writeDoc("docs/c.md", "---\ntitle: C\n---\n");
    writeMeta("docs/_meta.json", { pages: ["c"] });
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const sidebar = await generateSidebar(c);
    // C first (explicit), then A + B alphabetical as fallback.
    expect(sidebar.map((n) => n.title)).toEqual(["C", "A", "B"]);
  });

  test("malformed _meta.json logs a warning and falls back gracefully", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    // Deliberately broken JSON: no closing brace.
    writeDoc("docs/_meta.json", "{ this is not valid json");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const c = defineCollection({
        path: "docs",
        root: tmpDir,
        schema: z.object({ title: z.string() }),
      });
      const sidebar = await generateSidebar(c);
      expect(sidebar.map((n) => n.title)).toEqual(["A"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("_meta.json"))).toBe(true);
  });

  test("useDirMeta: false skips _meta.json even when present", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    writeDoc("docs/b.md", "---\ntitle: B\n---\n");
    // With meta, A should come before B (by pages order) — with
    // meta disabled, we fall back to alphabetical.
    writeMeta("docs/_meta.json", { pages: ["b", "a"] });
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const sidebar = await generateSidebar(c, { useDirMeta: false });
    // When useDirMeta is false, the `pages` ordering is ignored —
    // fallback alphabetical (A, B).
    expect(sidebar.map((n) => n.title)).toEqual(["A", "B"]);
  });

  test("empty collection returns empty array (regression)", async () => {
    const c = defineCollection({
      path: "empty-dir",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const sidebar = await generateSidebar(c);
    expect(sidebar).toEqual([]);
  });
});

describe("generateCategoryTree (Issue #205)", () => {
  test("emits Category tree with kind discriminator", async () => {
    writeDoc("docs/intro.md", "---\ntitle: Intro\n---\n");
    writeDoc("docs/guide/setup.md", "---\ntitle: Setup\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const tree = await generateCategoryTree(c);
    const guide = tree.find(
      (n): n is Category => n.kind === "category" && n.slug === "guide"
    );
    expect(guide).toBeDefined();
    expect(guide!.items.length).toBe(1);
    const setup = guide!.items[0] as CategoryEntry;
    expect(setup.kind).toBe("entry");
    expect(setup.title).toBe("Setup");
    expect(setup.href).toBe("/guide/setup");
  });

  test("applies _meta.json title + icon + order to Category", async () => {
    writeDoc("docs/guide/setup.md", "---\ntitle: Setup\n---\n");
    writeMeta("docs/guide/_meta.json", {
      title: "Installation Guide",
      icon: "rocket",
      order: 1,
    });
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const tree = await generateCategoryTree(c);
    const guide = tree.find((n): n is Category => n.kind === "category");
    expect(guide).toBeDefined();
    expect(guide!.title).toBe("Installation Guide");
    expect(guide!.icon).toBe("rocket");
    expect(guide!.order).toBe(1);
  });

  test("deep nesting preserves per-directory _meta.json", async () => {
    writeDoc("docs/a/b/c/leaf.md", "---\ntitle: Leaf\n---\n");
    writeMeta("docs/a/_meta.json", { title: "A section", order: 1 });
    writeMeta("docs/a/b/_meta.json", { title: "B section", order: 2 });
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const tree = await generateCategoryTree(c);
    const a = tree.find((n): n is Category => n.kind === "category" && n.slug === "a");
    expect(a?.title).toBe("A section");
    const b = a?.items.find(
      (n): n is Category => n.kind === "category" && n.slug === "a/b"
    );
    expect(b?.title).toBe("B section");
  });

  test("entries sort by frontmatter order before alphabetical", async () => {
    writeDoc("docs/z.md", "---\ntitle: Z\norder: 1\n---\n");
    writeDoc("docs/a.md", "---\ntitle: A\norder: 2\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string(), order: z.number().optional() }),
    });
    const tree = await generateCategoryTree(c);
    const titles = tree.map((n) => n.title);
    // Z (order=1) before A (order=2) despite alphabetical default.
    expect(titles).toEqual(["Z", "A"]);
  });

  test("missing _meta.json falls back to directory name", async () => {
    writeDoc("docs/guide/setup.md", "---\ntitle: Setup\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const tree = await generateCategoryTree(c);
    const guide = tree.find((n): n is Category => n.kind === "category");
    // With no _meta.json, the category title is the directory name.
    expect(guide?.title).toBe("guide");
    expect(guide?.icon).toBeUndefined();
  });
});
