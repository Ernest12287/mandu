/**
 * Regression tests for the SSE event wire contract.
 *
 * The mandujs.com front-end parses these events with a typed client —
 * any shape drift silently breaks the playground UI. We test the shape
 * exhaustively here so type-level changes force test updates.
 */

import { describe, it, expect } from "bun:test";
import type { SSEEvent } from "../src/types";

describe("SSEEvent wire contract", () => {
  it("sandbox-url events carry a url string + runId", () => {
    const event: SSEEvent = {
      type: "sandbox-url",
      data: { url: "https://sbx-abc.mandujs.dev", runId: "run-001" },
    };
    expect(event.type).toBe("sandbox-url");
    if (event.type === "sandbox-url") {
      expect(typeof event.data.url).toBe("string");
      expect(typeof event.data.runId).toBe("string");
    }
  });

  it("stdout/stderr events carry a chunk string", () => {
    const stdout: SSEEvent = { type: "stdout", data: { chunk: "hello" } };
    const stderr: SSEEvent = { type: "stderr", data: { chunk: "oops" } };
    expect(stdout.data.chunk).toBe("hello");
    expect(stderr.data.chunk).toBe("oops");
  });

  it("exit events carry code + durationMs numbers", () => {
    const event: SSEEvent = {
      type: "exit",
      data: { code: 0, durationMs: 1234 },
    };
    if (event.type === "exit") {
      expect(event.data.code).toBe(0);
      expect(event.data.durationMs).toBe(1234);
    }
  });

  it("error events carry a typed reason enum", () => {
    const reasons = [
      "timeout",
      "oom",
      "compile",
      "egress-denied",
      "output-cap",
      "internal",
    ] as const;

    for (const reason of reasons) {
      const event: SSEEvent = { type: "error", data: { reason } };
      expect(event.type).toBe("error");
      if (event.type === "error") {
        expect(event.data.reason).toBe(reason);
      }
    }
  });

  it("events serialize to parsable JSON (over-the-wire safety)", () => {
    const samples: SSEEvent[] = [
      { type: "sandbox-url", data: { url: "x", runId: "y" } },
      { type: "stdout", data: { chunk: "hi" } },
      { type: "exit", data: { code: 0, durationMs: 0 } },
      { type: "error", data: { reason: "timeout", message: "x" } },
    ];

    for (const event of samples) {
      const serialized = JSON.stringify(event.data);
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual(event.data);
    }
  });

  it("error.message is optional (some reasons need no text)", () => {
    const event: SSEEvent = { type: "error", data: { reason: "oom" } };
    if (event.type === "error") {
      expect(event.data.reason).toBe("oom");
      expect(event.data.message).toBeUndefined();
    }
  });
});
