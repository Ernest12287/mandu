/**
 * Unit tests for `packages/cli/src/util/ide-config.ts`.
 *
 * Covers:
 *   - JSON-C tolerance (strip `//` and `/* *\/`).
 *   - Non-destructive merge (foreign `mcpServers.*` keys preserved).
 *   - Atomic write + backup.
 *   - Aider YAML merge/remove (preserves preamble + trailing keys).
 *
 * All tests operate on `fs.mkdtemp` fixtures — no network, no real home
 * directory side effects.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  stripJsonComments,
  readConfigJson,
  writeConfigAtomic,
  mergeMcpEntry,
  removeMcpEntry,
  mergeAiderEntry,
  removeAiderEntry,
  getProviderPath,
} from "../ide-config";

const PREFIX = path.join(os.tmpdir(), "mandu-ide-config-test-");

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(PREFIX);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("stripJsonComments", () => {
  it("strips line comments", () => {
    const src = `{\n  // hello\n  "a": 1\n}`;
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 1 });
  });

  it("strips block comments", () => {
    const src = `{ /* block */ "a": 1 }`;
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 1 });
  });

  it("preserves strings that contain // or /*", () => {
    const src = `{ "url": "https://example.com/path", "note": "/* not a comment */" }`;
    const parsed = JSON.parse(stripJsonComments(src));
    expect(parsed.url).toBe("https://example.com/path");
    expect(parsed.note).toBe("/* not a comment */");
  });
});

describe("readConfigJson", () => {
  it("returns null when the file does not exist", async () => {
    const parsed = await readConfigJson(path.join(tmp, "missing.json"));
    expect(parsed).toBeNull();
  });

  it("parses JSON-C", async () => {
    const filePath = path.join(tmp, "mcp.json");
    await fs.writeFile(filePath, `{\n  // comment\n  "a": 1\n}`);
    const parsed = await readConfigJson(filePath);
    expect(parsed).toEqual({ a: 1 });
  });

  it("throws on invalid JSON", async () => {
    const filePath = path.join(tmp, "mcp.json");
    await fs.writeFile(filePath, `{ "a": ,,, }`);
    await expect(readConfigJson(filePath)).rejects.toThrow(/invalid JSON/);
  });

  it("throws when the root is not an object", async () => {
    const filePath = path.join(tmp, "mcp.json");
    await fs.writeFile(filePath, `[1,2,3]`);
    await expect(readConfigJson(filePath)).rejects.toThrow(/must be a JSON object/);
  });
});

describe("writeConfigAtomic", () => {
  it("creates the file when it does not exist (no backup)", async () => {
    const filePath = path.join(tmp, "dir1", "config.json");
    const backup = await writeConfigAtomic(filePath, `{"a":1}\n`);
    expect(backup).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);
  });

  it("overwrites existing file and creates a .bak sibling", async () => {
    const filePath = path.join(tmp, "config.json");
    await fs.writeFile(filePath, `{"prev":true}\n`);
    const backup = await writeConfigAtomic(filePath, `{"new":true}\n`);
    expect(backup).toBeDefined();
    expect(backup!.startsWith("config.json.bak.")).toBe(true);
    const bakPath = path.join(tmp, backup!);
    expect(existsSync(bakPath)).toBe(true);
    const newBody = await fs.readFile(filePath, "utf8");
    expect(newBody).toContain("new");
  });
});

describe("mergeMcpEntry", () => {
  it("adds an entry when the config was empty", () => {
    const { merged, changed } = mergeMcpEntry(null, "claude", "mandu", {
      command: "mandu",
      args: ["mcp"],
    });
    expect(changed).toBe(true);
    expect(merged).toEqual({
      mcpServers: {
        mandu: { command: "mandu", args: ["mcp"] },
      },
    });
  });

  it("preserves existing unrelated keys and other MCP servers", () => {
    const existing = {
      otherKey: { keep: true },
      mcpServers: {
        foreign: { command: "other", args: [] },
      },
    };
    const { merged, changed } = mergeMcpEntry(existing, "claude", "mandu", {
      command: "mandu",
      args: ["mcp"],
    });
    expect(changed).toBe(true);
    expect(merged.otherKey).toEqual({ keep: true });
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.foreign).toEqual({ command: "other", args: [] });
    expect(servers.mandu).toEqual({ command: "mandu", args: ["mcp"] });
  });

  it("reports changed=false when the entry is already present and identical", () => {
    const existing = {
      mcpServers: {
        mandu: { command: "mandu", args: ["mcp"] },
      },
    };
    const { changed } = mergeMcpEntry(existing, "claude", "mandu", {
      command: "mandu",
      args: ["mcp"],
    });
    expect(changed).toBe(false);
  });

  it("reports changed=true when env differs", () => {
    const existing = {
      mcpServers: {
        mandu: { command: "mandu", args: ["mcp"], env: { TOKEN: "old" } },
      },
    };
    const { changed, merged } = mergeMcpEntry(existing, "claude", "mandu", {
      command: "mandu",
      args: ["mcp"],
      env: { TOKEN: "new" },
    });
    expect(changed).toBe(true);
    const entry = (merged.mcpServers as Record<string, unknown>).mandu as Record<string, unknown>;
    expect(entry.env).toEqual({ TOKEN: "new" });
  });
});

describe("removeMcpEntry", () => {
  it("no-ops when the entry does not exist", () => {
    const { changed } = removeMcpEntry(
      { mcpServers: { foreign: { command: "x", args: [] } } },
      "claude",
      "mandu",
    );
    expect(changed).toBe(false);
  });

  it("removes the mandu entry and keeps siblings", () => {
    const existing = {
      mcpServers: {
        mandu: { command: "mandu", args: ["mcp"] },
        foreign: { command: "other", args: [] },
      },
    };
    const { merged, changed } = removeMcpEntry(existing, "claude", "mandu");
    expect(changed).toBe(true);
    const servers = merged!.mcpServers as Record<string, unknown>;
    expect(servers.mandu).toBeUndefined();
    expect(servers.foreign).toEqual({ command: "other", args: [] });
  });

  it("returns changed=false when called with null existing", () => {
    const { changed } = removeMcpEntry(null, "claude", "mandu");
    expect(changed).toBe(false);
  });
});

describe("mergeAiderEntry", () => {
  it("creates the mcp block when file is empty", () => {
    const { body, changed } = mergeAiderEntry(null, "mandu", {
      command: "mandu",
      args: ["mcp"],
    });
    expect(changed).toBe(true);
    expect(body).toContain("mcp:");
    expect(body).toContain("mandu:");
    expect(body).toContain("command: mandu");
  });

  it("preserves unrelated preamble keys", () => {
    const src = ["model: gpt-4", "temperature: 0.2", ""].join("\n");
    const { body, changed } = mergeAiderEntry(src, "mandu", {
      command: "mandu",
      args: ["mcp"],
    });
    expect(changed).toBe(true);
    expect(body).toContain("model: gpt-4");
    expect(body).toContain("temperature: 0.2");
    expect(body).toContain("mandu:");
  });

  it("reports changed=false when already up to date", () => {
    const first = mergeAiderEntry(null, "mandu", { command: "mandu", args: ["mcp"] });
    const second = mergeAiderEntry(first.body, "mandu", {
      command: "mandu",
      args: ["mcp"],
    });
    expect(second.changed).toBe(false);
  });
});

describe("removeAiderEntry", () => {
  it("removes the entry when present", () => {
    const src = mergeAiderEntry(null, "mandu", { command: "mandu", args: ["mcp"] }).body;
    const { body, changed } = removeAiderEntry(src, "mandu");
    expect(changed).toBe(true);
    expect(body).toBeDefined();
    expect(body!.includes("mandu:")).toBe(false);
  });

  it("no-ops when the file is null", () => {
    const { changed } = removeAiderEntry(null, "mandu");
    expect(changed).toBe(false);
  });
});

describe("getProviderPath", () => {
  it("resolves platform-independent paths for each provider", () => {
    // Use tmpdir-rooted paths so the fixture is absolute and matches
    // path.join semantics on the current OS.
    const home = path.join(os.tmpdir(), "fake-home");
    const cwd = path.join(os.tmpdir(), "fake-project");
    expect(getProviderPath("claude", cwd, home).endsWith(path.join(".claude", "mcp.json"))).toBe(true);
    expect(getProviderPath("cursor", cwd, home).endsWith(path.join(".cursor", "mcp.json"))).toBe(true);
    expect(getProviderPath("continue", cwd, home).endsWith(path.join(".continue", "config.json"))).toBe(true);
    expect(getProviderPath("aider", cwd, home).endsWith(".aider.conf.yml")).toBe(true);
    // Aider uses cwd, not home — path comparison normalises separators.
    const aiderPath = getProviderPath("aider", cwd, home);
    expect(path.dirname(aiderPath)).toBe(cwd);
  });
});
