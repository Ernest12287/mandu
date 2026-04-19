/**
 * Unit tests for `packages/cli/src/util/ai-client.ts`.
 *
 * These tests only touch the `local` provider (deterministic + offline)
 * plus the pure helpers. Real HTTP adapters are NOT exercised here —
 * they're integration-tested separately with a mock fetch in future
 * phases; CI must never depend on outbound network.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_TIMEOUT_MS,
  InvalidProviderError,
  MissingApiKeyError,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_ENV_VARS,
  StreamTimeoutError,
  collectChat,
  maskSecret,
  resolveApiKey,
  resolveProvider,
  resolveTimeoutMs,
  sanitizeUtf8Input,
  streamChat,
} from "../ai-client";
import type { PromptMessage } from "@mandujs/ate/prompts";

const baseMessages: PromptMessage[] = [
  { role: "system", content: "be helpful" },
  { role: "user", content: "hello" },
];

describe("resolveProvider", () => {
  it("accepts each of the 4 canonical providers", () => {
    expect(resolveProvider("claude")).toBe("claude");
    expect(resolveProvider("openai")).toBe("openai");
    expect(resolveProvider("gemini")).toBe("gemini");
    expect(resolveProvider("local")).toBe("local");
  });

  it("lowercases the input", () => {
    expect(resolveProvider("CLAUDE")).toBe("claude");
  });

  it("defaults undefined → local", () => {
    expect(resolveProvider(undefined)).toBe("local");
  });

  it("throws InvalidProviderError on unknown", () => {
    expect(() => resolveProvider("grok")).toThrow(InvalidProviderError);
  });
});

describe("maskSecret", () => {
  it("returns sk-*** for empty / short keys", () => {
    expect(maskSecret(undefined)).toBe("sk-***");
    expect(maskSecret("")).toBe("sk-***");
    expect(maskSecret("abc")).toBe("sk-***");
  });

  it("shows 3 prefix chars + 2 suffix chars for longer keys", () => {
    expect(maskSecret("sk-abcdef12345")).toBe("sk-***45");
  });

  it("never logs more than 5 total chars of key material", () => {
    const key = "sk-very-long-secret-abcdef";
    const masked = maskSecret(key);
    // 3 prefix + `***` + 2 suffix = 8 chars visible; no middle chars.
    expect(masked.length).toBe(8);
    expect(masked.includes("very")).toBe(false);
    expect(masked.includes("long")).toBe(false);
  });
});

describe("resolveApiKey", () => {
  it("returns undefined for local provider", async () => {
    const key = await resolveApiKey("local");
    expect(key).toBeUndefined();
  });

  it("reads MANDU_*_API_KEY from env", async () => {
    const key = await resolveApiKey("claude", (name) =>
      name === "MANDU_CLAUDE_API_KEY" ? "sk-test-claude-aaaabbbb" : undefined,
    );
    expect(key).toBe("sk-test-claude-aaaabbbb");
  });

  it("ignores empty env values", async () => {
    const key = await resolveApiKey("openai", () => "");
    expect(key).toBeUndefined();
  });

  it("trims whitespace", async () => {
    const key = await resolveApiKey("openai", (name) =>
      name === "MANDU_OPENAI_API_KEY" ? "  sk-secret  " : undefined,
    );
    expect(key).toBe("sk-secret");
  });

  it("each provider has its own env var name", () => {
    expect(PROVIDER_ENV_VARS.claude).toBe("MANDU_CLAUDE_API_KEY");
    expect(PROVIDER_ENV_VARS.openai).toBe("MANDU_OPENAI_API_KEY");
    expect(PROVIDER_ENV_VARS.gemini).toBe("MANDU_GEMINI_API_KEY");
  });
});

describe("resolveTimeoutMs", () => {
  it("falls back to 60000ms by default", () => {
    delete process.env.MANDU_AI_TIMEOUT_MS;
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("honors explicit option over env", () => {
    process.env.MANDU_AI_TIMEOUT_MS = "5000";
    try {
      expect(resolveTimeoutMs(12_345)).toBe(12_345);
    } finally {
      delete process.env.MANDU_AI_TIMEOUT_MS;
    }
  });

  it("honors env when no option", () => {
    process.env.MANDU_AI_TIMEOUT_MS = "7777";
    try {
      expect(resolveTimeoutMs()).toBe(7777);
    } finally {
      delete process.env.MANDU_AI_TIMEOUT_MS;
    }
  });

  it("ignores non-numeric env", () => {
    process.env.MANDU_AI_TIMEOUT_MS = "not-a-number";
    try {
      expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    } finally {
      delete process.env.MANDU_AI_TIMEOUT_MS;
    }
  });

  it("ignores negative option + env", () => {
    expect(resolveTimeoutMs(-1)).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("sanitizeUtf8Input", () => {
  it("accepts plain printable text", () => {
    expect(sanitizeUtf8Input("hello world")).toBe("hello world");
  });

  it("keeps newlines and tabs intact", () => {
    expect(sanitizeUtf8Input("line1\nline2\tcol")).toBe("line1\nline2\tcol");
  });

  it("rejects NUL bytes", () => {
    expect(() => sanitizeUtf8Input("hi\u0000there")).toThrow(/NUL byte/);
  });

  it("strips low control chars (except tab/newline/CR)", () => {
    expect(sanitizeUtf8Input("a\u0001b\u0008c")).toBe("abc");
  });

  it("rejects U+FFFD replacement chars (invalid UTF-8 upstream)", () => {
    expect(() => sanitizeUtf8Input("hello \ufffd world")).toThrow(/invalid UTF-8/);
  });

  it("strips a leading BOM", () => {
    expect(sanitizeUtf8Input("\ufeffhello")).toBe("hello");
  });

  it("rejects non-string input", () => {
    expect(() => sanitizeUtf8Input(42 as unknown as string)).toThrow(/must be a string/);
  });
});

describe("streamChat — local dummy responder", () => {
  it("yields chunk events, then a done event with tokens", async () => {
    const events: Array<{ type: string; delta?: string; response?: string }> = [];
    for await (const e of streamChat({ provider: "local", messages: baseMessages })) {
      events.push(e);
    }
    expect(events.length).toBeGreaterThan(1);
    expect(events[events.length - 1]?.type).toBe("done");
    const chunkCount = events.filter((e) => e.type === "chunk").length;
    expect(chunkCount).toBeGreaterThan(0);
    const done = events[events.length - 1] as { response?: string; tokens?: { tokensEstimated: number } };
    expect(typeof done.response).toBe("string");
    expect(done.response).toContain("hello");
    expect(done.tokens?.tokensEstimated).toBeGreaterThan(0);
  });

  it("collectChat concatenates chunks into the final response", async () => {
    const { response, latencyMs, tokens } = await collectChat({
      provider: "local",
      messages: baseMessages,
    });
    expect(response).toContain("hello");
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(tokens.tokensEstimated).toBeGreaterThan(0);
  });

  it("two identical calls produce identical responses (deterministic)", async () => {
    const a = await collectChat({ provider: "local", messages: baseMessages });
    const b = await collectChat({ provider: "local", messages: baseMessages });
    expect(a.response).toBe(b.response);
  });
});

describe("streamChat — error paths", () => {
  it("throws MissingApiKeyError for non-local provider without env", async () => {
    const saved = {
      claude: process.env.MANDU_CLAUDE_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.MANDU_CLAUDE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const gen = streamChat({ provider: "claude", messages: baseMessages });
      await expect(gen.next()).rejects.toThrow(MissingApiKeyError);
    } finally {
      if (saved.claude) process.env.MANDU_CLAUDE_API_KEY = saved.claude;
      if (saved.anthropic) process.env.ANTHROPIC_API_KEY = saved.anthropic;
    }
  });

  it("propagates AbortError when the caller aborts", async () => {
    const ctl = new AbortController();
    const gen = streamChat({
      provider: "local",
      messages: baseMessages,
      signal: ctl.signal,
    });
    ctl.abort();
    await expect(gen.next()).rejects.toThrow(/aborted/i);
  });
});

describe("streamChat — timeout", () => {
  it("resolveTimeoutMs plumbs the budget to the underlying stream", () => {
    // Direct unit-level check: we can't portably simulate a
    // hanging TCP connect across Windows/Linux/macOS in bun:test
    // without a local echo server. We instead verify the timeout
    // helper honors both explicit overrides and env, which is what
    // the stream path consumes.
    expect(resolveTimeoutMs(100)).toBe(100);
    expect(resolveTimeoutMs()).toBeGreaterThan(0);
  });

  it("StreamTimeoutError carries provider + timeoutMs metadata", () => {
    const err = new StreamTimeoutError("openai", 1234);
    expect(err.provider).toBe("openai");
    expect(err.timeoutMs).toBe(1234);
    expect(err.message).toContain("1234");
  });
});

describe("provider defaults", () => {
  it("exposes a default model per provider", () => {
    expect(PROVIDER_DEFAULT_MODEL.claude).toMatch(/claude/);
    expect(PROVIDER_DEFAULT_MODEL.openai).toMatch(/gpt/);
    expect(PROVIDER_DEFAULT_MODEL.gemini).toMatch(/gemini/);
    expect(PROVIDER_DEFAULT_MODEL.local).toBe("local-model");
  });
});
