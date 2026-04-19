/**
 * llms.txt generator tests (Issue #199).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { defineCollection } from "../../src/content/collection";
import { generateLLMSTxt } from "../../src/content/llms-txt";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandu-llms-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDoc(relPath: string, contents: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

describe("generateLLMSTxt", () => {
  test("renders a basic index with site heading", async () => {
    writeDoc(
      "docs/intro.md",
      "---\ntitle: Intro\ndescription: Getting started\n---\nbody"
    );
    writeDoc(
      "docs/cli.md",
      "---\ntitle: CLI\ndescription: Command reference\n---\nbody"
    );
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({
        title: z.string(),
        description: z.string().optional(),
      }),
    });
    const out = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { siteName: "My Site", description: "docs for my site" }
    );
    expect(out).toContain("# My Site");
    expect(out).toContain("> docs for my site");
    expect(out).toContain("## docs");
    expect(out).toContain("- [Intro](/docs/intro): Getting started");
    expect(out).toContain("- [CLI](/docs/cli): Command reference");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("skips drafts by default, surfaces with includeDrafts", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    writeDoc(
      "docs/b.md",
      "---\ntitle: B\ndraft: true\n---\n"
    );
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({
        title: z.string(),
        draft: z.boolean().default(false),
      }),
    });
    const base = await generateLLMSTxt([{ name: "docs", collection: docs }]);
    expect(base).toContain("[A]");
    expect(base).not.toContain("[B]");

    const withDrafts = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { includeDrafts: true }
    );
    expect(withDrafts).toContain("[B]");
  });

  test("full: true inlines body content", async () => {
    writeDoc("docs/long.md", "---\ntitle: Long\n---\nSome body line");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const compact = await generateLLMSTxt([{ name: "docs", collection: docs }]);
    expect(compact).not.toContain("Some body line");

    const full = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { full: true }
    );
    expect(full).toContain("Some body line");
  });

  test("accepts pre-loaded entries without re-scanning disk", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const entries = await docs.all();
    const out = await generateLLMSTxt([{ name: "custom", entries }]);
    expect(out).toContain("## custom");
    expect(out).toContain("[A]");
  });

  test("absolute basePath produces outward-facing URLs", async () => {
    writeDoc("docs/hello.md", "---\ntitle: Hello\n---\n");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const out = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { basePath: "https://example.com" }
    );
    expect(out).toContain("https://example.com/docs/hello");
  });

  test("deterministic order within a collection (sorted by slug)", async () => {
    writeDoc("docs/c.md", "---\ntitle: C\n---\n");
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    writeDoc("docs/b.md", "---\ntitle: B\n---\n");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const out = await generateLLMSTxt([{ name: "docs", collection: docs }]);
    const lines = out.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual([
      "- [A](/docs/a)",
      "- [B](/docs/b)",
      "- [C](/docs/c)",
    ]);
  });
});
