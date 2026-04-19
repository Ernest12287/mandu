/**
 * Artifact writer — secret-leak guard + append-unique (Phase 13.1).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  appendUniqueLines,
  SecretLeakError,
  writeArtifact,
} from "../artifact-writer";

describe("writeArtifact", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-artifact-"));
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes content to disk (creates parent dirs)", async () => {
    const target = path.join(tmp, "sub", "dir", "file.txt");
    const result = await writeArtifact({
      path: target,
      content: "hello world",
    });
    expect(result.preserved).toBe(false);
    expect(await fs.readFile(target, "utf8")).toBe("hello world");
  });

  it("preserves existing file when preserveIfExists=true", async () => {
    const target = path.join(tmp, "keep.txt");
    await fs.writeFile(target, "original");
    const result = await writeArtifact({
      path: target,
      content: "should-not-overwrite",
      preserveIfExists: true,
    });
    expect(result.preserved).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it("rejects content containing a secret value", async () => {
    const target = path.join(tmp, "leaky.toml");
    const forbidden = new Map([["FLY_API_TOKEN", "super-secret-token-1234"]]);
    await expect(
      writeArtifact({
        path: target,
        content: `token = "super-secret-token-1234"\n`,
        forbiddenValues: forbidden,
      })
    ).rejects.toBeInstanceOf(SecretLeakError);
    // File must not exist after a rejection.
    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("ignores short values (< 8 chars) to avoid false positives", async () => {
    const target = path.join(tmp, "ok.txt");
    const forbidden = new Map([["FLAG", "1"]]);
    await expect(
      writeArtifact({
        path: target,
        content: "PORT = 1\n",
        forbiddenValues: forbidden,
      })
    ).resolves.toBeDefined();
  });
});

describe("appendUniqueLines", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-append-"));
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates a new file with the provided lines", async () => {
    const file = path.join(tmp, ".dockerignore");
    await appendUniqueLines(file, ["node_modules", ".git"]);
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("node_modules");
    expect(content).toContain(".git");
  });

  it("appends only new lines; preserves existing order", async () => {
    const file = path.join(tmp, ".dockerignore-2");
    await fs.writeFile(file, "node_modules\ntmp\n");
    await appendUniqueLines(file, ["node_modules", ".env", "tmp", "coverage"]);
    const content = await fs.readFile(file, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.includes("node_modules")).toBe(true);
    expect(lines.includes("tmp")).toBe(true);
    expect(lines.includes(".env")).toBe(true);
    expect(lines.includes("coverage")).toBe(true);
    // No duplicates:
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("no-ops when no new lines to add", async () => {
    const file = path.join(tmp, ".dockerignore-3");
    await fs.writeFile(file, "a\nb\n");
    const before = await fs.stat(file);
    await appendUniqueLines(file, ["a", "b"]);
    const after = await fs.stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
