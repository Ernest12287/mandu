/**
 * Package tarball integrity guard — prevents #230-class regressions
 * where a required directory (schemas/, prompts/, src/) is missing from
 * the published tarball because `files` in package.json is out of sync
 * with actual runtime imports.
 *
 * Runs `bun pm pack --dry-run` and asserts the output lists every
 * top-level directory that runtime code imports from. If this test
 * fails, update `packages/ate/package.json` `files` field.
 */
import { test, expect, describe } from "bun:test";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ATE_ROOT = path.resolve(import.meta.dir, "..");

function listPackedFiles(): string[] {
  const result = spawnSync("bun", ["pm", "pack", "--dry-run"], {
    cwd: ATE_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`bun pm pack --dry-run failed: ${result.stderr}`);
  }
  const combined = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  const lines = combined.split(/\r?\n/);
  return lines
    .map((l) => {
      const match = l.match(/packed\s+[\d.]+\s*[KMGB]+\s+(.+?)\s*$/);
      return match ? match[1].trim() : null;
    })
    .filter((x): x is string => x !== null);
}

describe("ate package integrity", () => {
  const packed = listPackedFiles();

  test("schemas/failure.v1.ts is in the tarball (regression guard for #230)", () => {
    const hit = packed.some((p) => p.endsWith("schemas/failure.v1.ts"));
    expect(hit).toBe(true);
  });

  test("src/index.ts is in the tarball (core entry)", () => {
    const hit = packed.some((p) => p.endsWith("src/index.ts"));
    expect(hit).toBe(true);
  });

  test("prompts/*.md files are in the tarball", () => {
    const hit = packed.some((p) => /prompts\/.*\.md$/.test(p));
    expect(hit).toBe(true);
  });

  test("at least one mutation operator file is in the tarball", () => {
    const hit = packed.some((p) => p.endsWith("src/mutation/operators.ts"));
    expect(hit).toBe(true);
  });

  test("oracle queue module is in the tarball", () => {
    const hit = packed.some((p) => p.endsWith("src/oracle/queue.ts"));
    expect(hit).toBe(true);
  });
});
