/**
 * Issue #245 M5 — AGENTS.md / CLAUDE.md linker tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildAgentsDesignBlock,
  DESIGN_LINK_MARKER_END,
  DESIGN_LINK_MARKER_START,
  linkAgentsToDesignMd,
} from "../agents-link";

describe("buildAgentsDesignBlock", () => {
  it("contains markers, the canonical heading, and all 8 MCP tools", () => {
    const block = buildAgentsDesignBlock();
    expect(block).toContain(DESIGN_LINK_MARKER_START);
    expect(block).toContain(DESIGN_LINK_MARKER_END);
    expect(block).toContain("## Design System");
    for (const tool of [
      "mandu.design.get",
      "mandu.design.prompt",
      "mandu.component.list",
      "mandu.design.check",
      "mandu.design.extract",
      "mandu.design.propose",
      "mandu.design.patch",
      "mandu.design.diff_upstream",
    ]) {
      expect(block).toContain(tool);
    }
  });

  it("respects custom DESIGN.md filename", () => {
    expect(buildAgentsDesignBlock("Stripe-DESIGN.md")).toContain("Stripe-DESIGN.md");
  });
});

describe("linkAgentsToDesignMd", () => {
  let TEST_DIR: string;
  beforeEach(async () => {
    TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-design-link-"));
  });
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("inserts the block at end of an existing AGENTS.md", async () => {
    await fs.writeFile(path.join(TEST_DIR, "AGENTS.md"), "# Existing\n\nSome notes.\n");
    const result = await linkAgentsToDesignMd({ rootDir: TEST_DIR });
    expect(result.changed).toBe(true);
    expect(result.files.find((f) => f.path.endsWith("AGENTS.md"))?.action).toBe("inserted");
    const after = await fs.readFile(path.join(TEST_DIR, "AGENTS.md"), "utf8");
    expect(after).toContain("# Existing");
    expect(after).toContain("Some notes.");
    expect(after).toContain("## Design System");
  });

  it("is idempotent — running twice produces no diff on the second run", async () => {
    await fs.writeFile(path.join(TEST_DIR, "AGENTS.md"), "# X\n");
    await linkAgentsToDesignMd({ rootDir: TEST_DIR });
    const after1 = await fs.readFile(path.join(TEST_DIR, "AGENTS.md"), "utf8");
    const second = await linkAgentsToDesignMd({ rootDir: TEST_DIR });
    const after2 = await fs.readFile(path.join(TEST_DIR, "AGENTS.md"), "utf8");
    expect(after1).toBe(after2);
    expect(second.files.find((f) => f.path.endsWith("AGENTS.md"))?.action).toBe("unchanged");
  });

  it("replaces an existing markered block when the body changed", async () => {
    await fs.writeFile(
      path.join(TEST_DIR, "AGENTS.md"),
      `# X\n\n${DESIGN_LINK_MARKER_START}\n\n## Old block\n\n${DESIGN_LINK_MARKER_END}\n`,
    );
    await linkAgentsToDesignMd({ rootDir: TEST_DIR });
    const after = await fs.readFile(path.join(TEST_DIR, "AGENTS.md"), "utf8");
    expect(after).not.toContain("## Old block");
    expect(after).toContain("## Design System");
  });

  it("touches CLAUDE.md too when both exist", async () => {
    await fs.writeFile(path.join(TEST_DIR, "AGENTS.md"), "# A\n");
    await fs.writeFile(path.join(TEST_DIR, "CLAUDE.md"), "# C\n");
    const result = await linkAgentsToDesignMd({ rootDir: TEST_DIR });
    expect(result.files.filter((f) => f.action === "inserted")).toHaveLength(2);
    expect(await fs.readFile(path.join(TEST_DIR, "CLAUDE.md"), "utf8")).toContain(
      "## Design System",
    );
  });

  it("creates AGENTS.md when neither file exists and createIfMissing is true", async () => {
    const result = await linkAgentsToDesignMd({
      rootDir: TEST_DIR,
      createIfMissing: true,
    });
    expect(result.changed).toBe(true);
    expect(result.files.find((f) => f.action === "created")).toBeDefined();
    expect(await fs.readFile(path.join(TEST_DIR, "AGENTS.md"), "utf8")).toContain(
      "## Design System",
    );
  });

  it("is a no-op when neither file exists and createIfMissing is false", async () => {
    const result = await linkAgentsToDesignMd({ rootDir: TEST_DIR });
    expect(result.changed).toBe(false);
    await expect(fs.access(path.join(TEST_DIR, "AGENTS.md"))).rejects.toThrow();
  });
});
