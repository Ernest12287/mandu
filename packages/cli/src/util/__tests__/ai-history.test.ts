/**
 * Unit tests for `packages/cli/src/util/ai-history.ts`.
 *
 * Covers the in-memory `ChatHistory` class, round-trip JSON
 * save/load, and strict schema validation (rejecting any file that
 * won't reload cleanly).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ChatHistory,
  HISTORY_MAX_TURNS,
  HISTORY_SCHEMA_VERSION,
  HistoryValidationError,
  createSnapshot,
  loadHistory,
  saveHistory,
  validateHistorySnapshot,
} from "../ai-history";

const PREFIX = path.join(os.tmpdir(), "mandu-ai-history-test-");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(PREFIX);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ChatHistory — basic operations", () => {
  it("stores and returns turns in insertion order", () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "a" });
    h.push({ role: "assistant", content: "b" });
    expect(h.getTurns()).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(h.size).toBe(2);
  });

  it("rejects invalid roles", () => {
    const h = new ChatHistory();
    expect(() =>
      h.push({ role: "system" as "user", content: "x" }),
    ).toThrow(/invalid role/);
  });

  it("rejects non-string content", () => {
    const h = new ChatHistory();
    expect(() =>
      h.push({ role: "user", content: 42 as unknown as string }),
    ).toThrow(/content must be a string/);
  });

  it("bounds scrollback to maxTurns (default 100)", () => {
    const h = new ChatHistory();
    for (let i = 0; i < HISTORY_MAX_TURNS + 10; i += 1) {
      h.push({ role: "user", content: `msg-${i}` });
    }
    expect(h.size).toBe(HISTORY_MAX_TURNS);
    // Oldest 10 should be gone; the surviving head starts at index 10.
    expect(h.getTurns()[0]?.content).toBe("msg-10");
  });

  it("honors a custom maxTurns cap", () => {
    const h = new ChatHistory({ maxTurns: 3 });
    h.push({ role: "user", content: "1" });
    h.push({ role: "user", content: "2" });
    h.push({ role: "user", content: "3" });
    h.push({ role: "user", content: "4" });
    expect(h.size).toBe(3);
    expect(h.getTurns().map((t) => t.content)).toEqual(["2", "3", "4"]);
  });

  it("rejects non-positive maxTurns", () => {
    expect(() => new ChatHistory({ maxTurns: 0 })).toThrow(/positive integer/);
    expect(() => new ChatHistory({ maxTurns: -1 })).toThrow(/positive integer/);
  });

  it("clear() resets all turns", () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "a" });
    h.push({ role: "assistant", content: "b" });
    h.clear();
    expect(h.size).toBe(0);
    expect(h.getTurns()).toEqual([]);
  });

  it("replace() trims overflow at the TAIL (keep newest)", () => {
    const h = new ChatHistory({ maxTurns: 2 });
    h.replace([
      { role: "user", content: "1" },
      { role: "user", content: "2" },
      { role: "user", content: "3" },
    ]);
    expect(h.getTurns()).toEqual([
      { role: "user", content: "2" },
      { role: "user", content: "3" },
    ]);
  });

  it("getTurns returns a defensive copy", () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "a" });
    const turns = h.getTurns();
    turns.push({ role: "assistant", content: "hacked" });
    expect(h.size).toBe(1);
  });
});

describe("ChatHistory — prompt message rendering", () => {
  it("prepends system when provided", () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "hello" });
    const msgs = h.toPromptMessages("be brief");
    expect(msgs[0]).toEqual({ role: "system", content: "be brief" });
    expect(msgs[1]).toEqual({ role: "user", content: "hello" });
  });

  it("skips system when empty", () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "hello" });
    const msgs = h.toPromptMessages("   ");
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.role).toBe("user");
  });
});

describe("validateHistorySnapshot — schema enforcement", () => {
  function valid() {
    return {
      version: HISTORY_SCHEMA_VERSION,
      provider: "local",
      model: "local-model",
      system: "sys",
      savedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "hi" }],
    };
  }

  it("accepts a well-formed object", () => {
    const snap = validateHistorySnapshot(valid());
    expect(snap.provider).toBe("local");
    expect(snap.messages.length).toBe(1);
  });

  it("rejects null / array / primitive roots", () => {
    expect(() => validateHistorySnapshot(null)).toThrow(HistoryValidationError);
    expect(() => validateHistorySnapshot([])).toThrow(HistoryValidationError);
    expect(() => validateHistorySnapshot("string")).toThrow(HistoryValidationError);
  });

  it("rejects unknown version", () => {
    const bad = { ...valid(), version: 999 };
    expect(() => validateHistorySnapshot(bad)).toThrow(/unsupported version/);
  });

  it("rejects invalid provider", () => {
    const bad = { ...valid(), provider: "xai" };
    expect(() => validateHistorySnapshot(bad)).toThrow(/invalid provider/);
  });

  it("rejects non-array messages", () => {
    const bad = { ...valid(), messages: "not an array" };
    expect(() => validateHistorySnapshot(bad)).toThrow(/messages is not an array/);
  });

  it("rejects invalid message role", () => {
    const bad = { ...valid(), messages: [{ role: "system", content: "x" }] };
    expect(() => validateHistorySnapshot(bad)).toThrow(/role must be/);
  });

  it("rejects non-string content", () => {
    const bad = { ...valid(), messages: [{ role: "user", content: 123 }] };
    expect(() => validateHistorySnapshot(bad)).toThrow(/content must be a string/);
  });
});

describe("save / load round trip", () => {
  it("round-trips a full snapshot", async () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "hello" });
    h.push({ role: "assistant", content: "hi" });

    const snapshot = createSnapshot("openai", h, {
      model: "gpt-4o-mini",
      system: "be concise",
    });
    const file = path.join(tmpDir, "hist.json");
    await saveHistory(file, snapshot);

    const loaded = await loadHistory(file);
    expect(loaded.provider).toBe("openai");
    expect(loaded.model).toBe("gpt-4o-mini");
    expect(loaded.system).toBe("be concise");
    expect(loaded.messages.length).toBe(2);
    expect(loaded.messages[1]?.content).toBe("hi");
  });

  it("loadHistory throws HistoryValidationError on missing file", async () => {
    const missing = path.join(tmpDir, "does-not-exist.json");
    await expect(loadHistory(missing)).rejects.toThrow(HistoryValidationError);
  });

  it("loadHistory throws on invalid JSON", async () => {
    const file = path.join(tmpDir, "bad.json");
    await fs.writeFile(file, "{not valid json", "utf8");
    await expect(loadHistory(file)).rejects.toThrow(/invalid JSON/);
  });

  it("loadHistory throws on malformed content", async () => {
    const file = path.join(tmpDir, "bad-shape.json");
    await fs.writeFile(file, JSON.stringify({ version: 1, provider: "x" }), "utf8");
    await expect(loadHistory(file)).rejects.toThrow(HistoryValidationError);
  });

  it("saveHistory creates parent directories", async () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "hi" });
    const nested = path.join(tmpDir, "a", "b", "c", "hist.json");
    await saveHistory(nested, createSnapshot("local", h));
    const contents = await fs.readFile(nested, "utf8");
    expect(contents.startsWith("{")).toBe(true);
  });
});

describe("createSnapshot", () => {
  it("emits the current turns + metadata", () => {
    const h = new ChatHistory();
    h.push({ role: "user", content: "x" });
    const snap = createSnapshot("claude", h, { model: "claude-3", system: "be nice" });
    expect(snap.version).toBe(HISTORY_SCHEMA_VERSION);
    expect(snap.provider).toBe("claude");
    expect(snap.model).toBe("claude-3");
    expect(snap.system).toBe("be nice");
    expect(snap.messages).toEqual([{ role: "user", content: "x" }]);
    expect(typeof snap.savedAt).toBe("string");
  });
});
