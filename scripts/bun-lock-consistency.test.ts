import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { collectBunLockConsistencyIssues } from "./bun-lock-consistency";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "mandu-bun-lock-check-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "packages", "core"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "root",
    private: true,
    workspaces: { packages: ["packages/*"], catalog: { zod: "^3.25.0" } },
    devDependencies: { "@types/bun": "^1.4.0" },
  }));
  await fs.writeFile(path.join(root, "packages", "core", "package.json"), JSON.stringify({
    name: "@fixture/core",
    version: "1.0.0",
    dependencies: { zod: "catalog:" },
  }));
  await fs.writeFile(path.join(root, "bun.lock"), `{
    "lockfileVersion": 1,
    "workspaces": {
      "": {
        "name": "root",
        "devDependencies": { "@types/bun": "^1.4.0" },
      },
      "packages/core": {
        "name": "@fixture/core",
        "version": "1.0.0",
        "dependencies": { "zod": "catalog:" },
      },
    },
    "catalog": { "zod": "^3.25.0" },
    "packages": {},
  }`);
  return root;
}

describe("collectBunLockConsistencyIssues", () => {
  it("accepts matching JSONC workspace metadata", async () => {
    const root = await fixture();
    expect(await collectBunLockConsistencyIssues(root)).toEqual([]);
  });

  it("reports dependency metadata changed after the lockfile was written", async () => {
    const root = await fixture();
    const file = path.join(root, "packages", "core", "package.json");
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    manifest.dependencies.zod = "^4.0.0";
    await fs.writeFile(file, JSON.stringify(manifest));

    expect(await collectBunLockConsistencyIssues(root)).toContain(
      "packages/core: dependencies differs from bun.lock",
    );
  });

  it("reports workspaces missing from the lockfile", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "packages", "cli"), { recursive: true });
    await fs.writeFile(path.join(root, "packages", "cli", "package.json"), JSON.stringify({
      name: "@fixture/cli",
      version: "1.0.0",
    }));

    expect(await collectBunLockConsistencyIssues(root)).toContain(
      "packages/cli: workspace is missing from bun.lock",
    );
  });
});
