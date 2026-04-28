/**
 * `mandu build --static` materializer tests (Issue #249).
 *
 * Exercises the file-shaped contract: prerendered HTML at the root,
 * client bundles preserved at `<outDir>/.mandu/client/...` so the
 * absolute URLs the prerender step already wrote into HTML resolve,
 * and `public/` files merged into the root.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { emitStaticExport } from "../static-export";

async function makeFixture(prefix: string): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mandu-static-${prefix}-`));
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function seedBuild(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".mandu", "prerendered"), { recursive: true });
  await fs.mkdir(path.join(root, ".mandu", "client"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".mandu", "prerendered", "index.html"),
    `<!doctype html><link rel="stylesheet" href="/.mandu/client/globals.css">`
  );
  await fs.mkdir(path.join(root, ".mandu", "prerendered", "ko"));
  await fs.writeFile(
    path.join(root, ".mandu", "prerendered", "ko", "index.html"),
    `<!doctype html>`
  );
  await fs.writeFile(
    path.join(root, ".mandu", "client", "globals.css"),
    `body{}`
  );
  await fs.writeFile(
    path.join(root, ".mandu", "client", "page.island.js"),
    `export default null;`
  );
}

describe("emitStaticExport", () => {
  it("flattens prerendered + client + public into a single dir", async () => {
    const fx = await makeFixture("flatten");
    await seedBuild(fx.root);
    await fs.mkdir(path.join(fx.root, "public"));
    await fs.writeFile(path.join(fx.root, "public", "favicon.ico"), "");

    const result = await emitStaticExport({ rootDir: fx.root, outDir: "dist" });

    expect(result.copied.prerendered).toBe(2);
    expect(result.copied.client).toBe(2);
    expect(result.copied.public).toBe(1);

    // HTML at root, not nested under .mandu/prerendered/.
    const html = await fs.readFile(
      path.join(fx.root, "dist", "index.html"),
      "utf8"
    );
    expect(html).toContain(`/.mandu/client/globals.css`);

    // Client bundles preserved at the path the HTML references.
    const css = await fs.readFile(
      path.join(fx.root, "dist", ".mandu", "client", "globals.css"),
      "utf8"
    );
    expect(css).toBe("body{}");

    // public/ merged at root.
    await fs.access(path.join(fx.root, "dist", "favicon.ico"));

    await fx.cleanup();
  });

  it("works without a public/ directory", async () => {
    const fx = await makeFixture("no-public");
    await seedBuild(fx.root);

    const result = await emitStaticExport({ rootDir: fx.root, outDir: "dist" });
    expect(result.copied.public).toBe(0);

    await fx.cleanup();
  });

  it("fails loud when prerendered/ is missing", async () => {
    const fx = await makeFixture("missing-prerendered");
    await fs.mkdir(path.join(fx.root, ".mandu", "client"), { recursive: true });

    await expect(
      emitStaticExport({ rootDir: fx.root, outDir: "dist" })
    ).rejects.toThrow(/prerendered/);

    await fx.cleanup();
  });

  it("fails loud when client/ is missing", async () => {
    const fx = await makeFixture("missing-client");
    await fs.mkdir(path.join(fx.root, ".mandu", "prerendered"), { recursive: true });
    await fs.writeFile(
      path.join(fx.root, ".mandu", "prerendered", "index.html"),
      ""
    );

    await expect(
      emitStaticExport({ rootDir: fx.root, outDir: "dist" })
    ).rejects.toThrow(/client/);

    await fx.cleanup();
  });

  it("refuses to overwrite the project root or .mandu/", async () => {
    const fx = await makeFixture("guarded");
    await seedBuild(fx.root);

    await expect(
      emitStaticExport({ rootDir: fx.root, outDir: fx.root })
    ).rejects.toThrow(/refused/i);
    await expect(
      emitStaticExport({ rootDir: fx.root, outDir: ".mandu" })
    ).rejects.toThrow(/refused/i);

    await fx.cleanup();
  });

  it("cleans the output directory by default", async () => {
    const fx = await makeFixture("clean");
    await seedBuild(fx.root);

    // Stale file from a previous build.
    await fs.mkdir(path.join(fx.root, "dist"), { recursive: true });
    await fs.writeFile(path.join(fx.root, "dist", "stale.html"), "old");

    await emitStaticExport({ rootDir: fx.root, outDir: "dist" });

    await expect(
      fs.access(path.join(fx.root, "dist", "stale.html"))
    ).rejects.toThrow();

    await fx.cleanup();
  });
});
