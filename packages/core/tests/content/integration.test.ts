/**
 * End-to-end integration test (Issue #199).
 *
 * Exercises the entire MVP flow from a realistic `content.config.ts`
 * shape — `content/docs/hello.md` with frontmatter + body, validated
 * through a Zod schema, composed into a sidebar, and exported as
 * llms.txt. This is the acceptance test for the issue's "Demo" gate.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { defineCollection } from "../../src/content/collection";
import { generateSidebar } from "../../src/content/sidebar";
import { generateLLMSTxt } from "../../src/content/llms-txt";
import {
  generateContentTypes,
  renderContentTypes,
} from "../../src/content/generate-types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandu-e2e-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDoc(relPath: string, contents: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

describe("content collections end-to-end", () => {
  test("real-world docs project flow", async () => {
    // Arrange: realistic `content/docs/` tree mirroring what a user
    // would author by hand.
    writeDoc(
      "content/docs/hello.md",
      `---
title: Hello Mandu
order: 1
description: First page of the docs
tags:
  - intro
  - basics
draft: false
---

# Hello Mandu

Welcome! This is the first docs entry.`
    );
    writeDoc(
      "content/docs/guide/setup.md",
      `---
title: Setup
order: 2
description: Install and configure
---

Follow these steps.`
    );
    writeDoc(
      "content/docs/guide/deploy.md",
      `---
title: Deploy
order: 3
description: Ship to production
draft: true
---

Not ready yet.`
    );

    // Act: mirror what `content.config.ts` would look like.
    const docs = defineCollection({
      path: "content/docs",
      root: tmpDir,
      schema: z.object({
        title: z.string(),
        order: z.number().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).default([]),
        draft: z.boolean().default(false),
      }),
    });

    // Assert: collection.all() returns sorted, validated entries.
    const entries = await docs.all();
    expect(entries.length).toBe(3);
    expect(entries[0].slug).toBe("hello");
    expect(entries[0].data.title).toBe("Hello Mandu");
    expect(entries[0].data.tags).toEqual(["intro", "basics"]);
    expect(entries[0].data.draft).toBe(false);

    // Assert: collection.get(slug)
    const setup = await docs.get("guide/setup");
    expect(setup?.data.description).toBe("Install and configure");

    // Assert: sidebar drops drafts by default.
    const sidebar = await generateSidebar(docs, { basePath: "/docs" });
    const flat = flattenSidebar(sidebar);
    expect(flat.some((n) => n.title === "Deploy")).toBe(false);
    expect(flat.find((n) => n.title === "Setup")?.href).toBe("/docs/guide/setup");
    expect(flat.find((n) => n.title === "Hello Mandu")?.href).toBe("/docs/hello");

    // Assert: llms.txt renders the deterministic index.
    const llms = await generateLLMSTxt(
      [{ name: "docs", collection: docs }],
      { siteName: "Mandu Docs", basePath: "/" }
    );
    expect(llms).toContain("# Mandu Docs");
    expect(llms).toContain("## docs");
    expect(llms).toContain("- [Hello Mandu](/docs/hello)");
    expect(llms).not.toContain("Deploy"); // draft filtered

    // Assert: type emitter produces a parseable .d.ts string.
    const types = renderContentTypes({ docs });
    expect(types).toContain("EntryDocs");
    expect(types).toContain(`export type CollectionName = "docs"`);

    const emit = generateContentTypes(
      { docs },
      { root: tmpDir, outFile: ".mandu/generated/content-types.d.ts" }
    );
    expect(fs.existsSync(emit.outFile)).toBe(true);
  });
});

function flattenSidebar(
  nodes: Array<{
    title: string;
    href: string;
    children?: ReturnType<typeof flattenSidebar>;
  }>
): Array<{ title: string; href: string }> {
  const out: Array<{ title: string; href: string }> = [];
  for (const node of nodes) {
    out.push({ title: node.title, href: node.href });
    if (node.children) out.push(...flattenSidebar(node.children));
  }
  return out;
}
