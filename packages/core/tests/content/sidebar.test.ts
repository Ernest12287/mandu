/**
 * Sidebar generator tests (Issue #199).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { defineCollection } from "../../src/content/collection";
import { generateSidebar } from "../../src/content/sidebar";

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
