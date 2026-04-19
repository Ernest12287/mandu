/**
 * Integration tests for `packages/cli/src/commands/ai/eval.ts`.
 *
 * Tests use only the `local` provider so CI never hits the network.
 * The evaluator is designed to emit well-formed JSON regardless of
 * provider success/failure — every test parses the raw output to
 * guarantee that contract.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";
import { aiEval, parseProviderList, evalOne } from "../ai/eval";

const PREFIX = path.join(os.tmpdir(), "mandu-ai-eval-test-");

let tmpDir: string;
let errorSpy: ReturnType<typeof spyOn>;

function makeOutput(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      cb();
    },
  });
  return { stream, chunks };
}

function parseStdout(chunks: string[]): unknown {
  return JSON.parse(chunks.join(""));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(PREFIX);
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy.mockRestore();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parseProviderList", () => {
  it("uses --provider when --providers is absent", () => {
    expect(parseProviderList({ provider: "openai" })).toEqual(["openai"]);
  });

  it("defaults to ['local'] when nothing is supplied", () => {
    expect(parseProviderList({})).toEqual(["local"]);
  });

  it("splits CSV in --providers", () => {
    expect(
      parseProviderList({ providers: ["local,openai,claude"] }),
    ).toEqual(["local", "openai", "claude"]);
  });

  it("dedupes providers (order preserved)", () => {
    expect(
      parseProviderList({ providers: ["local,openai,local,claude,openai"] }),
    ).toEqual(["local", "openai", "claude"]);
  });

  it("throws on an unknown provider", () => {
    expect(() => parseProviderList({ providers: ["grok"] })).toThrow();
  });
});

describe("evalOne — local provider always succeeds", () => {
  it("returns ok=true with a non-empty response + latency", async () => {
    const row = await evalOne("local", [{ role: "user", content: "hi" }]);
    expect(row.ok).toBe(true);
    expect(row.provider).toBe("local");
    expect(row.response).toContain("hi");
    expect(row.latency_ms).toBeDefined();
    expect(row.latency_ms!).toBeGreaterThanOrEqual(0);
    expect(row.tokens_estimated).toBeGreaterThan(0);
  });
});

describe("evalOne — missing API key → ok=false with actionable error", () => {
  it("openai without env → 'MANDU_OPENAI_API_KEY is not set'", async () => {
    const saved = process.env.MANDU_OPENAI_API_KEY;
    delete process.env.MANDU_OPENAI_API_KEY;
    try {
      const row = await evalOne("openai", [{ role: "user", content: "x" }]);
      expect(row.ok).toBe(false);
      expect(row.error).toContain("MANDU_OPENAI_API_KEY");
      expect(row.response).toBeUndefined();
    } finally {
      if (saved) process.env.MANDU_OPENAI_API_KEY = saved;
    }
  });
});

describe("mandu ai eval — end-to-end JSON output", () => {
  it("local-only prompt succeeds, exit 0, valid JSON", async () => {
    const { stream, chunks } = makeOutput();
    const code = await aiEval({
      prompt: "hello",
      providers: ["local"],
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const parsed = parseStdout(chunks) as {
      prompt: string;
      results: Array<{ provider: string; ok: boolean; response?: string }>;
    };
    expect(parsed.prompt).toBe("hello");
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0]?.provider).toBe("local");
    expect(parsed.results[0]?.ok).toBe(true);
    expect(parsed.results[0]?.response).toContain("hello");
  });

  it("multiple providers → exit 1 if any fails, but JSON still valid", async () => {
    const saved = process.env.MANDU_OPENAI_API_KEY;
    delete process.env.MANDU_OPENAI_API_KEY;
    try {
      const { stream, chunks } = makeOutput();
      const code = await aiEval({
        prompt: "hello",
        providers: ["local,openai"],
        output: stream,
        cwd: tmpDir,
      });
      expect(code).toBe(1);
      const parsed = parseStdout(chunks) as {
        results: Array<{ provider: string; ok: boolean }>;
      };
      expect(parsed.results.length).toBe(2);
      expect(parsed.results.find((r) => r.provider === "local")?.ok).toBe(true);
      expect(parsed.results.find((r) => r.provider === "openai")?.ok).toBe(false);
    } finally {
      if (saved) process.env.MANDU_OPENAI_API_KEY = saved;
    }
  });

  it("--prompt-file reads prompt from disk", async () => {
    const file = path.join(tmpDir, "prompt.txt");
    await fs.writeFile(file, "how are you?", "utf8");
    const { stream, chunks } = makeOutput();
    const code = await aiEval({
      promptFile: file,
      provider: "local",
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const parsed = parseStdout(chunks) as { prompt: string };
    expect(parsed.prompt).toBe("how are you?");
  });

  it("--prompt-file pointing at missing file returns exit 2", async () => {
    const { stream } = makeOutput();
    const code = await aiEval({
      promptFile: path.join(tmpDir, "does-not-exist.txt"),
      provider: "local",
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(2);
  });

  it("no --prompt / --prompt-file → exit 2", async () => {
    const { stream } = makeOutput();
    const code = await aiEval({
      provider: "local",
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(2);
  });

  it("--preset loads system from docs/prompts/<name>.md", async () => {
    const promptsDir = path.join(tmpDir, "docs", "prompts");
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(
      path.join(promptsDir, "tiny.md"),
      "tiny system prompt",
      "utf8",
    );
    const { stream, chunks } = makeOutput();
    const code = await aiEval({
      prompt: "hi",
      preset: "tiny",
      provider: "local",
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const parsed = parseStdout(chunks) as { system?: string };
    expect(parsed.system).toContain("tiny system prompt");
  });

  it("--preset unknown → exit 1", async () => {
    const { stream } = makeOutput();
    const code = await aiEval({
      prompt: "hi",
      preset: "no-such-preset",
      provider: "local",
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(1);
  });

  it("--help prints help + exits 0 (no network)", async () => {
    const { stream, chunks } = makeOutput();
    const code = await aiEval({ help: true, output: stream });
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("mandu ai eval");
  });

  it("rejects non-UTF8 / NUL bytes with exit 2", async () => {
    const { stream } = makeOutput();
    const code = await aiEval({
      prompt: "hello\u0000world",
      provider: "local",
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(2);
  });

  it("unknown provider → exit 2", async () => {
    const { stream } = makeOutput();
    const code = await aiEval({
      prompt: "hi",
      providers: ["grok"],
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(2);
  });
});

describe("mandu ai eval — token + latency shape", () => {
  it("each successful row includes latency_ms + tokens_estimated", async () => {
    const { stream, chunks } = makeOutput();
    const code = await aiEval({
      prompt: "t",
      providers: ["local"],
      output: stream,
      cwd: tmpDir,
    });
    expect(code).toBe(0);
    const parsed = parseStdout(chunks) as {
      results: Array<{ latency_ms?: number; tokens_estimated?: number; ok: boolean }>;
    };
    const row = parsed.results[0];
    expect(row.ok).toBe(true);
    expect(typeof row.latency_ms).toBe("number");
    expect(typeof row.tokens_estimated).toBe("number");
    expect(row.tokens_estimated).toBeGreaterThan(0);
  });
});
