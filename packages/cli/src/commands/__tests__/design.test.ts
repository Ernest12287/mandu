/**
 * `mandu design` command tests — init / import / validate.
 *
 * `import` (and `init --from`) hits a real network if not stubbed; we
 * monkey-patch `globalThis.fetch` so the tests stay offline and fast.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { design } from "../design";

async function makeRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `mandu-design-${prefix}-`));
}

const STUB_DESIGN_MD = `# Stripe

## Visual Theme & Philosophy
Minimal, clear, calm.

## Color Palette
- primary — #635BFF — brand
`;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("stripe/DESIGN.md")) {
      return new Response(STUB_DESIGN_MD, { status: 200 });
    }
    if (url.includes("missing-brand/DESIGN.md")) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    return new Response("unhandled", { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mandu design init", () => {
  it("writes the empty 9-section skeleton when no --from is given", async () => {
    const root = await makeRoot("init-empty");
    const ok = await design({ action: "init", rootDir: root });
    expect(ok).toBe(true);
    const written = await fs.readFile(path.join(root, "DESIGN.md"), "utf8");
    expect(written).toContain("# DESIGN.md");
    expect(written).toContain("## Color Palette");
    expect(written).toContain("## Agent Prompts");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("imports an upstream brand DESIGN.md via --from <slug>", async () => {
    const root = await makeRoot("init-from");
    const ok = await design({ action: "init", rootDir: root, from: "stripe" });
    expect(ok).toBe(true);
    const written = await fs.readFile(path.join(root, "DESIGN.md"), "utf8");
    expect(written).toBe(STUB_DESIGN_MD);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses to overwrite an existing DESIGN.md without --force", async () => {
    const root = await makeRoot("init-existing");
    await fs.writeFile(path.join(root, "DESIGN.md"), "user content");
    const ok = await design({ action: "init", rootDir: root });
    expect(ok).toBe(false);
    const written = await fs.readFile(path.join(root, "DESIGN.md"), "utf8");
    expect(written).toBe("user content");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("overwrites with --force", async () => {
    const root = await makeRoot("init-force");
    await fs.writeFile(path.join(root, "DESIGN.md"), "user content");
    const ok = await design({ action: "init", rootDir: root, force: true });
    expect(ok).toBe(true);
    const written = await fs.readFile(path.join(root, "DESIGN.md"), "utf8");
    expect(written).toContain("# DESIGN.md");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails clean when the upstream slug is missing", async () => {
    const root = await makeRoot("init-missing");
    const ok = await design({ action: "init", rootDir: root, from: "missing-brand" });
    expect(ok).toBe(false);
    // Does not write a partial file.
    const exists = await fs
      .access(path.join(root, "DESIGN.md"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("mandu design import", () => {
  it("requires a slug argument", async () => {
    const root = await makeRoot("import-no-slug");
    const ok = await design({ action: "import", rootDir: root });
    expect(ok).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("overwrites the existing DESIGN.md", async () => {
    const root = await makeRoot("import-overwrite");
    await fs.writeFile(path.join(root, "DESIGN.md"), "stale");
    const ok = await design({ action: "import", rootDir: root, from: "stripe" });
    expect(ok).toBe(true);
    const written = await fs.readFile(path.join(root, "DESIGN.md"), "utf8");
    expect(written).toBe(STUB_DESIGN_MD);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("mandu design validate", () => {
  it("fails when DESIGN.md is missing", async () => {
    const root = await makeRoot("validate-missing");
    const ok = await design({ action: "validate", rootDir: root });
    expect(ok).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns ok for a populated DESIGN.md", async () => {
    const root = await makeRoot("validate-ok");
    const md = `# X

## Visual Theme & Philosophy
Minimal.

## Color Palette
- primary — #000

## Typography
- body — Inter, 16px

## Components
### Button
variant: primary | secondary

## Layout
- md — 16px

## Depth & Elevation
- card: 0 1px 2px rgba(0,0,0,.06)

## Do's & Don'ts
### Do
- Use tokens

## Responsive
- mobile — 640px

## Agent Prompts
### default
Use tokens.
`;
    await fs.writeFile(path.join(root, "DESIGN.md"), md);
    const ok = await design({ action: "validate", rootDir: root });
    expect(ok).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports gaps but still returns ok=true (non-blocking)", async () => {
    const root = await makeRoot("validate-gaps");
    await fs.writeFile(
      path.join(root, "DESIGN.md"),
      "## Color Palette\n- primary — #000\n",
    );
    // Validate is advisory — returns true even with gaps.
    const ok = await design({ action: "validate", rootDir: root });
    expect(ok).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});
