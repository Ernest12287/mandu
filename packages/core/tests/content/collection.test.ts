/**
 * Collection API tests (Issue #199).
 *
 * Covers the end-to-end flow:
 *   - scan a directory on disk
 *   - parse frontmatter
 *   - validate with Zod
 *   - default + custom sort order
 *   - slug override (frontmatter + callback)
 *   - legacy `defineCollection({ loader })` passthrough
 *
 * Every test isolates into its own `mkdtemp` fixture so parallel
 * bun-test runs don't clobber each other.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import {
  defineCollection,
  Collection,
  type CollectionEntry,
} from "../../src/content/collection";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandu-collection-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDoc(relPath: string, contents: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

describe("defineCollection (MVP)", () => {
  test("returns a Collection instance for { path, schema }", () => {
    const c = defineCollection({
      path: "content/docs",
      schema: z.object({ title: z.string() }),
    });
    expect(c).toBeInstanceOf(Collection);
  });

  test("passes legacy { loader } config through unchanged", () => {
    const legacy = { loader: { name: "noop", load: async () => {} } };
    const out = defineCollection(legacy);
    // The passthrough branch returns the SAME object reference so
    // `defineContentConfig({ collections: { docs: defineCollection(...) }})`
    // keeps the legacy ContentLayer happy.
    expect(out).toBe(legacy);
  });

  test("throws when config mixes loader + path", () => {
    expect(() =>
      defineCollection({ loader: {}, path: "x" } as never)
    ).toThrow(/both `loader` and `path`/);
  });
});

describe("Collection.load()", () => {
  test("returns empty array when directory is missing", async () => {
    const c = defineCollection({
      path: "does-not-exist",
      root: tmpDir,
    });
    expect(await c.all()).toEqual([]);
  });

  test("scans markdown files recursively", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\nBody A");
    writeDoc("docs/sub/b.md", "---\ntitle: B\n---\nBody B");
    writeDoc("docs/ignored.txt", "should be ignored");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const entries = await c.all();
    expect(entries.map((e) => e.slug).sort()).toEqual(["a", "sub/b"]);
    expect(entries.find((e) => e.slug === "a")?.data.title).toBe("A");
    expect(entries.find((e) => e.slug === "sub/b")?.content).toBe("Body B");
  });

  test("applies schema defaults", async () => {
    writeDoc("docs/intro.md", "---\ntitle: Intro\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({
        title: z.string(),
        draft: z.boolean().default(false),
      }),
    });
    const entry = await c.get("intro");
    expect(entry?.data.draft).toBe(false);
  });

  test("throws helpful error on schema validation failure", async () => {
    writeDoc("docs/bad.md", "---\ntitle: 42\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    await expect(c.all()).rejects.toThrow(/schema validation failed for bad\.md/);
  });

  test("without schema, returns raw frontmatter data", async () => {
    writeDoc("docs/free.md", "---\nfoo: bar\nqux: 9\n---\nbody");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
    });
    const [entry] = await c.all();
    expect(entry.data).toEqual({ foo: "bar", qux: 9 });
    expect(entry.content).toBe("body");
  });

  test("caches entries across calls (same reference)", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\nbody");
    const c = defineCollection({ path: "docs", root: tmpDir });
    const first = await c.all();
    const second = await c.all();
    expect(first).toBe(second);
  });

  test("invalidate() forces a rescan", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\nbody");
    const c = defineCollection({ path: "docs", root: tmpDir });
    const first = await c.all();
    writeDoc("docs/b.md", "---\ntitle: B\n---\nbody");
    const cached = await c.all();
    expect(cached.length).toBe(1);
    c.invalidate();
    const reloaded = await c.all();
    expect(reloaded.length).toBe(2);
    expect(reloaded).not.toBe(first);
  });
});

describe("Collection sorting", () => {
  test("default sort uses data.order ascending, then slug", async () => {
    writeDoc("docs/alpha.md", "---\ntitle: A\norder: 2\n---\n");
    writeDoc("docs/beta.md", "---\ntitle: B\norder: 1\n---\n");
    writeDoc("docs/charlie.md", "---\ntitle: C\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string(), order: z.number().optional() }),
    });
    const entries = await c.all();
    expect(entries.map((e) => e.slug)).toEqual(["beta", "alpha", "charlie"]);
  });

  test("custom comparator overrides default", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n");
    writeDoc("docs/b.md", "---\ntitle: B\n---\n");
    writeDoc("docs/c.md", "---\ntitle: C\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
      sort: (a, b) => (b.data.title > a.data.title ? 1 : -1),
    });
    const entries = await c.all();
    expect(entries.map((e) => e.slug)).toEqual(["c", "b", "a"]);
  });

  test("sort tiebreaker is stable via slug", async () => {
    writeDoc("docs/b.md", "---\ntitle: B\norder: 1\n---\n");
    writeDoc("docs/a.md", "---\ntitle: A\norder: 1\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string(), order: z.number() }),
    });
    const entries = await c.all();
    expect(entries.map((e) => e.slug)).toEqual(["a", "b"]);
  });
});

describe("Collection slug resolution", () => {
  test("frontmatter `slug` overrides default", async () => {
    writeDoc(
      "docs/getting-started.md",
      "---\ntitle: Start\nslug: start-here\n---\n"
    );
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
    });
    const [entry] = await c.all();
    expect(entry.slug).toBe("start-here");
  });

  test("callback override receives path + data", async () => {
    writeDoc("docs/Readme.md", "---\ntitle: T\n---\n");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      slug: ({ path: p }) => `custom/${p.replace(/\.md$/, "").toLowerCase()}`,
    });
    const [entry] = await c.all();
    expect(entry.slug).toBe("custom/readme");
  });
});

describe("Collection.getCompiled()", () => {
  test("returns a React-like element when MDX tooling is absent", async () => {
    writeDoc("docs/a.md", "---\ntitle: A\n---\n# Hello\n\nBody.");
    const c = defineCollection({ path: "docs", root: tmpDir });
    const compiled = await c.getCompiled("a");
    expect(compiled).toBeDefined();
    // Even without unified+remark+rehype installed, we guarantee a
    // callable Component that produces a React element shape.
    const element = compiled!.Component() as {
      type: string;
      props: unknown;
      $$typeof: symbol;
    };
    expect(element.type === "pre" || element.type === "div").toBe(true);
    expect(element.$$typeof).toBe(Symbol.for("react.element"));
  });

  test("returns undefined for unknown slug", async () => {
    const c = defineCollection({ path: "docs", root: tmpDir });
    expect(await c.getCompiled("none")).toBeUndefined();
  });
});

describe("CollectionEntry shape", () => {
  test("entries include slug, filePath, data, content", async () => {
    writeDoc("docs/hello.md", "---\ntitle: Hello\n---\nBody");
    const c = defineCollection({
      path: "docs",
      root: tmpDir,
      schema: z.object({ title: z.string() }),
    });
    const entries = await c.all();
    const entry: CollectionEntry<{ title: string }> = entries[0];
    expect(entry.slug).toBe("hello");
    expect(entry.data.title).toBe("Hello");
    expect(entry.content).toBe("Body");
    expect(entry.filePath.endsWith("hello.md")).toBe(true);
  });
});
