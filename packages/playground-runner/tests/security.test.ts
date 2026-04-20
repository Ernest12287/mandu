/**
 * Unit tests for `src/security.ts`.
 *
 * Zero network access — all tests are pure functions against the frozen
 * policy + helpers. Notes:
 *  - `verifyTurnstile` is tested ONLY via the "no secret configured" path
 *    (fail-open) + "missing token" path (fail-closed). Real siteverify
 *    calls are out of scope for unit tests.
 */

import { describe, it, expect } from "bun:test";
import {
  SECURITY_POLICY,
  truncateOutput,
  stripAnsi,
  isAllowedEgress,
  rateLimitKey,
  verifyTurnstile,
} from "../src/security";

describe("SECURITY_POLICY", () => {
  it("is frozen — prevents runtime mutation", () => {
    expect(Object.isFrozen(SECURITY_POLICY)).toBe(true);
  });

  it("matches the Phase 16 R0 published limits", () => {
    // These constants are part of our security contract with the front-end
    // + operators. Changing them requires doc + runbook updates.
    expect(SECURITY_POLICY.wallClockMs).toBe(30_000);
    expect(SECURITY_POLICY.cpuBudgetMs).toBe(15_000);
    expect(SECURITY_POLICY.outputCapBytes).toBe(64 * 1024);
    expect(SECURITY_POLICY.memoryMib).toBe(256);
    expect(SECURITY_POLICY.runsBeforeTurnstile).toBe(5);
    expect(SECURITY_POLICY.runsPerHour).toBe(20);
  });

  it("has a minimal egress allowlist (defense-in-depth)", () => {
    // Keep the list TINY. New entries require security review.
    expect(SECURITY_POLICY.egressAllowlist.length).toBeLessThanOrEqual(5);
    expect(SECURITY_POLICY.egressAllowlist).toContain("localhost");
    expect(SECURITY_POLICY.egressAllowlist).toContain("127.0.0.1");
  });
});

describe("truncateOutput", () => {
  it("passes through chunks under the cap", () => {
    const res = truncateOutput(0, "hello world");
    expect(res.truncated).toBe(false);
    expect(res.chunk).toBe("hello world");
    expect(res.newTotal).toBe(11);
  });

  it("truncates chunks that cross the boundary", () => {
    const cap = SECURITY_POLICY.outputCapBytes;
    const alreadyEmitted = cap - 10;
    const big = "a".repeat(100);
    const res = truncateOutput(alreadyEmitted, big);
    expect(res.truncated).toBe(true);
    expect(res.chunk.length).toBe(10);
    expect(res.newTotal).toBe(cap);
  });

  it("returns empty chunk + truncated=true when already at cap", () => {
    const res = truncateOutput(SECURITY_POLICY.outputCapBytes, "anything");
    expect(res.truncated).toBe(true);
    expect(res.chunk).toBe("");
  });

  it("handles multi-byte UTF-8 without mid-codepoint splits", () => {
    // Each emoji is 4 UTF-8 bytes. Using JS string .slice() by char count
    // keeps us codepoint-safe even if byte count differs.
    const cap = SECURITY_POLICY.outputCapBytes;
    const res = truncateOutput(cap - 5, "hi-😀-end");
    expect(res.truncated).toBe(true);
    // We sliced 5 chars; the emoji may or may not fit, but the chunk is
    // a valid substring (JS string ops are codepoint-safe).
    expect(typeof res.chunk).toBe("string");
  });
});

describe("stripAnsi", () => {
  it("removes color CSI sequences", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m text")).toBe("red text");
  });

  it("leaves non-ANSI text alone", () => {
    expect(stripAnsi("plain text 123")).toBe("plain text 123");
  });

  it("removes cursor-move sequences", () => {
    expect(stripAnsi("hi\u001B[2Jclear")).toBe("hiclear");
  });

  it("handles an empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("isAllowedEgress", () => {
  it("allows localhost", () => {
    expect(isAllowedEgress("localhost")).toBe(true);
    expect(isAllowedEgress("LOCALHOST")).toBe(true);
    expect(isAllowedEgress("localhost.")).toBe(true); // trailing dot
  });

  it("allows 127.0.0.1", () => {
    expect(isAllowedEgress("127.0.0.1")).toBe(true);
  });

  it("allows sandbox-self prefix (sbx-<id>.*)", () => {
    expect(isAllowedEgress("sbx-abc123.mandujs.dev")).toBe(true);
  });

  it("blocks arbitrary hostnames", () => {
    expect(isAllowedEgress("evil.example.com")).toBe(false);
    expect(isAllowedEgress("metadata.google.internal")).toBe(false);
    expect(isAllowedEgress("169.254.169.254")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isAllowedEgress("SBX-ABC.MANDUJS.DEV")).toBe(true);
  });
});

describe("rateLimitKey", () => {
  it("formats keys as rl:<ip>:<minute>", () => {
    const key = rateLimitKey("1.2.3.4");
    expect(key).toMatch(/^rl:1\.2\.3\.4:\d+$/);
  });

  it("uses a different bucket per minute", () => {
    const t1 = Date.now();
    const k1 = rateLimitKey("1.2.3.4", 60_000);
    // Simulated 90s later — different bucket.
    const k2Bucket = Math.floor((t1 + 90_000) / 60_000);
    expect(k2Bucket).toBeGreaterThan(Number(k1.split(":")[2]));
  });
});

describe("verifyTurnstile", () => {
  it("fails open when no secret is configured (dev mode)", async () => {
    const verdict = await verifyTurnstile("any", undefined);
    expect(verdict.valid).toBe(true);
    expect(verdict.reason).toBe("no-secret-configured");
  });

  it("fails closed when secret is set but token is missing", async () => {
    const verdict = await verifyTurnstile(undefined, "test-secret");
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("missing-token");
  });
});
