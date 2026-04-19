/**
 * Content types generator tests (Issue #199).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { defineCollection, Collection } from "../../src/content/collection";
import {
  generateContentTypes,
  renderContentTypes,
} from "../../src/content/generate-types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandu-types-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("renderContentTypes", () => {
  test("emits CollectionMap + aliases, sorted by name", () => {
    const docs = defineCollection({ path: "docs" }) as Collection<unknown>;
    const blog = defineCollection({
      path: "blog",
      schema: z.object({ title: z.string() }),
    }) as Collection<unknown>;
    const out = renderContentTypes({ docs, blog });
    // Aliases sorted alphabetically: blog, docs
    const blogIdx = out.indexOf("EntryBlog");
    const docsIdx = out.indexOf("EntryDocs");
    expect(blogIdx).toBeGreaterThan(-1);
    expect(docsIdx).toBeGreaterThan(blogIdx);
    expect(out).toContain(`"blog": Collection<Record<string, unknown>>`);
    expect(out).toContain(`"docs": Collection<Record<string, unknown>>`);
    expect(out).toContain(`export type CollectionName = "blog" | "docs"`);
  });

  test("emits `never` for empty registry", () => {
    const out = renderContentTypes({});
    expect(out).toContain("export type CollectionName = never");
  });

  test("sanitizes collection names with dashes", () => {
    const c = defineCollection({ path: "my-docs" }) as Collection<unknown>;
    const out = renderContentTypes({ "my-docs": c });
    expect(out).toContain("EntryMyDocs");
    expect(out).toContain(`"my-docs": Collection<Record<string, unknown>>`);
  });
});

describe("generateContentTypes", () => {
  test("writes file to disk and returns wrote=true on first run", () => {
    const docs = defineCollection({ path: "docs" }) as Collection<unknown>;
    const result = generateContentTypes(
      { docs },
      {
        root: tmpDir,
        outFile: ".mandu/generated/content-types.d.ts",
      }
    );
    expect(result.wrote).toBe(true);
    const written = fs.readFileSync(result.outFile, "utf8");
    expect(written).toContain("EntryDocs");
  });

  test("returns wrote=false when content unchanged", () => {
    const docs = defineCollection({ path: "docs" }) as Collection<unknown>;
    const first = generateContentTypes(
      { docs },
      { root: tmpDir, outFile: ".mandu/generated/content-types.d.ts" }
    );
    expect(first.wrote).toBe(true);
    const second = generateContentTypes(
      { docs },
      { root: tmpDir, outFile: ".mandu/generated/content-types.d.ts" }
    );
    expect(second.wrote).toBe(false);
  });

  test("creates intermediate directories", () => {
    const docs = defineCollection({ path: "docs" }) as Collection<unknown>;
    const result = generateContentTypes(
      { docs },
      { root: tmpDir, outFile: "deep/nested/dir/types.d.ts" }
    );
    expect(fs.existsSync(result.outFile)).toBe(true);
  });
});
