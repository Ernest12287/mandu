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

describe("generateLLMSTxt expanded options (Issue #205)", () => {
  test("baseUrl alias produces absolute URLs", async () => {
    writeDoc("docs/hello.md", "---\ntitle: Hello\n---\n");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const out = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { baseUrl: "https://mandujs.com" }
    );
    expect(out).toContain("https://mandujs.com/docs/hello");
  });

  test("baseUrl overrides basePath when both provided", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    // `baseUrl` wins — the doc comment promises that.
    const out = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { basePath: "/ignored", baseUrl: "https://example.com" }
    );
    expect(out).toContain("https://example.com/docs/a");
    expect(out).not.toContain("/ignored");
  });

  test("groupByCategory buckets entries by first slug segment", async () => {
    writeDoc("docs/intro.md", "---\ntitle: Intro\n---\n");
    writeDoc("docs/guide/setup.md", "---\ntitle: Setup\n---\n");
    writeDoc("docs/guide/deploy.md", "---\ntitle: Deploy\n---\n");
    writeDoc("docs/api/client.md", "---\ntitle: Client\n---\n");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const out = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { groupByCategory: true }
    );
    // Categories appear as ### headings under ## docs.
    expect(out).toContain("## docs");
    expect(out).toContain("### api");
    expect(out).toContain("### guide");
    // The root entry (intro) appears BEFORE the category headings.
    const introIdx = out.indexOf("[Intro]");
    const apiIdx = out.indexOf("### api");
    expect(introIdx).toBeGreaterThan(-1);
    expect(apiIdx).toBeGreaterThan(introIdx);
  });

  test("full: true + groupByCategory inlines body under categorized entries", async () => {
    writeDoc("docs/guide/setup.md", "---\ntitle: Setup\n---\nPoint A");
    writeDoc("docs/guide/deploy.md", "---\ntitle: Deploy\n---\nPoint B");
    const docs = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const out = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { full: true, groupByCategory: true }
    );
    expect(out).toContain("### guide");
    expect(out).toContain("Point A");
    expect(out).toContain("Point B");
  });

  test("empty collection yields no category heading output", async () => {
    const docs = defineCollection({
      path: "missing",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const out = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { groupByCategory: true }
    );
    expect(out).not.toContain("## docs");
    expect(out).not.toContain("###");
  });
});
