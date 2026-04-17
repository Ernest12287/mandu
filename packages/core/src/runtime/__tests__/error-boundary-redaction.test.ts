/**
 * Phase 6.3: error-boundary stack redaction tests.
 *
 * Verifies the contract enforced by `redactErrorForBoundary()` in
 * runtime/server.ts — user-land `error.tsx` receives full fidelity in
 * dev and a trimmed view in prod, with a stable `digest` correlating
 * the two. This is the defensive layer that keeps server-side stack
 * frames from reaching the browser.
 */

import { describe, it, expect } from "bun:test";
import {
  redactErrorForBoundary,
  computeErrorDigest,
} from "../server";

function buildFakeError(): Error {
  // Build an error with a long, predictable stack so we can assert on frame
  // count. The Node stack format starts with `Error: msg\n    at foo (...)`.
  const e = new Error("boom");
  e.stack = [
    "Error: boom",
    "    at level0 (/proj/src/a.ts:10:5)",
    "    at level1 (/proj/src/a.ts:20:5)",
    "    at level2 (/proj/src/b.ts:30:5)",
    "    at level3 (/proj/src/b.ts:40:5)",
    "    at level4 (/proj/src/c.ts:50:5)",
    "    at level5 (/proj/src/c.ts:60:5)",
  ].join("\n");
  return e;
}

describe("redactErrorForBoundary() — dev mode (isDev=true)", () => {
  it("returns the original Error unchanged", () => {
    const original = buildFakeError();
    const { error } = redactErrorForBoundary(original, true);
    expect(error).toBe(original);
    // Full stack preserved.
    expect(error.stack).toContain("level5");
  });

  it("still produces a digest in dev", () => {
    const original = buildFakeError();
    const { digest } = redactErrorForBoundary(original, true);
    expect(typeof digest).toBe("string");
    expect(digest.length).toBe(8);
  });
});

describe("redactErrorForBoundary() — prod mode (isDev=false)", () => {
  it("returns a clone with preserved message", () => {
    const original = buildFakeError();
    const { error } = redactErrorForBoundary(original, false);
    expect(error).not.toBe(original);
    expect(error.message).toBe("boom");
    expect(error.name).toBe("Error");
  });

  it("trims stack to header + top 3 frames", () => {
    const original = buildFakeError();
    const { error } = redactErrorForBoundary(original, false);
    expect(typeof error.stack).toBe("string");
    const lines = error.stack!.split("\n");
    // Header + 3 frames = 4 lines.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Error: boom");
    expect(lines[1]).toContain("level0");
    expect(lines[2]).toContain("level1");
    expect(lines[3]).toContain("level2");
    // Deeper frames are gone.
    expect(error.stack).not.toContain("level3");
    expect(error.stack).not.toContain("level4");
    expect(error.stack).not.toContain("level5");
  });

  it("preserves .name on custom Error subclasses", () => {
    class MyError extends Error {}
    const custom = new MyError("hmm");
    custom.name = "MyError";
    const { error } = redactErrorForBoundary(custom, false);
    expect(error.name).toBe("MyError");
    expect(error.message).toBe("hmm");
  });

  it("handles errors with no stack gracefully", () => {
    const noStack = new Error("bare");
    noStack.stack = undefined;
    const { error, digest } = redactErrorForBoundary(noStack, false);
    expect(error.message).toBe("bare");
    expect(error.stack).toBeUndefined();
    expect(digest.length).toBe(8);
  });
});

describe("computeErrorDigest()", () => {
  it("produces the same digest for structurally identical errors", () => {
    const a = new Error("same");
    a.stack = "Error: same\n    at foo (/x:1:1)";
    const b = new Error("same");
    b.stack = "Error: same\n    at foo (/x:1:1)";
    expect(computeErrorDigest(a)).toBe(computeErrorDigest(b));
  });

  it("produces a different digest when the message changes", () => {
    const a = new Error("a");
    a.stack = "Error: a\n    at foo (/x:1:1)";
    const b = new Error("b");
    b.stack = "Error: b\n    at foo (/x:1:1)";
    expect(computeErrorDigest(a)).not.toBe(computeErrorDigest(b));
  });

  it("produces a different digest when the top frame changes", () => {
    const a = new Error("same");
    a.stack = "Error: same\n    at foo (/x:1:1)";
    const b = new Error("same");
    b.stack = "Error: same\n    at bar (/x:1:1)";
    expect(computeErrorDigest(a)).not.toBe(computeErrorDigest(b));
  });

  it("returns an 8-char hex string", () => {
    const d = computeErrorDigest(new Error("any"));
    expect(d).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles Error with empty stack", () => {
    const e = new Error("");
    e.stack = "";
    expect(computeErrorDigest(e)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("redactErrorForBoundary() ↔ computeErrorDigest() contract", () => {
  it("dev digest equals prod digest for the same original error", () => {
    // The digest must survive the redaction — same underlying event on
    // client (redacted) and server logs (full) must be joinable.
    const original = buildFakeError();
    const dev = redactErrorForBoundary(original, true);
    const prod = redactErrorForBoundary(original, false);
    expect(dev.digest).toBe(prod.digest);
  });
});
