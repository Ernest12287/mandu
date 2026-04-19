/**
 * MCP tool — `mandu.loop.close` tests.
 *
 * The underlying loop-closure framework is tested exhaustively in
 * `packages/skills/src/loop-closure/__tests__/`. Here we focus on:
 *   - Tool definition shape & annotations
 *   - Input validation (typed stdout/stderr/exitCode/detectors)
 *   - Handler wiring — the tool surfaces the closeLoop() report verbatim
 *   - Safety: the handler never writes files, never spawns processes
 */

import { describe, it, expect } from "bun:test";
import {
  loopCloseToolDefinitions,
  loopCloseTools,
} from "../../src/tools/loop-close";

describe("loopCloseToolDefinitions", () => {
  it("declares the `mandu.loop.close` tool", () => {
    expect(loopCloseToolDefinitions).toHaveLength(1);
    const def = loopCloseToolDefinitions[0];
    expect(def.name).toBe("mandu.loop.close");
  });

  it("declares readOnlyHint to reflect the safety invariant", () => {
    const def = loopCloseToolDefinitions[0];
    expect(def.annotations?.readOnlyHint).toBe(true);
  });

  it("has no required fields — empty input is valid", () => {
    const def = loopCloseToolDefinitions[0];
    const schema = def.inputSchema as { required?: string[] };
    expect(Array.isArray(schema.required)).toBe(true);
    expect(schema.required).toHaveLength(0);
  });

  it("describes stdout / stderr / exitCode / detectors properties", () => {
    const def = loopCloseToolDefinitions[0];
    const schema = def.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.stdout).toBeDefined();
    expect(schema.properties?.stderr).toBeDefined();
    expect(schema.properties?.exitCode).toBeDefined();
    expect(schema.properties?.detectors).toBeDefined();
  });
});

describe("loopCloseTools handler", () => {
  it("returns `no-stall-detected` on empty input", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({})) as {
      stallReason?: string;
      nextPrompt?: string;
      evidence?: unknown[];
    };
    expect(result.stallReason).toBe("no-stall-detected");
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(result.evidence).toHaveLength(0);
    expect(typeof result.nextPrompt).toBe("string");
  });

  it("detects a typecheck error scenario", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({
      stdout: "",
      stderr: "src/foo.ts(1,1): error TS2322: boom",
      exitCode: 1,
    })) as { stallReason?: string; nextPrompt?: string };
    expect(result.stallReason).toContain("typecheck");
    expect(result.nextPrompt).toContain("src/foo.ts");
  });

  it("rejects a non-string stdout", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({ stdout: 42 })) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("stdout");
  });

  it("rejects a non-string stderr", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({ stderr: true })) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("stderr");
  });

  it("rejects a non-number exitCode", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({
      stdout: "",
      exitCode: "one",
    })) as { error?: string; field?: string };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("exitCode");
  });

  it("rejects a non-array detectors", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({
      detectors: "typecheck-error",
    })) as { error?: string; field?: string };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("detectors");
  });

  it("rejects detectors with non-string entries", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({
      detectors: ["typecheck-error", 42],
    })) as { error?: string; field?: string };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("detectors");
  });

  it("honours a detector allow-list", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({
      stdout: "TODO: foo",
      stderr: "a.ts(1,1): error TS1234: bad",
      exitCode: 1,
      detectors: ["typecheck-error"],
    })) as {
      stallReason?: string;
      evidence?: Array<{ kind: string }>;
    };
    expect(result.stallReason).toContain("typecheck");
    const kinds = new Set((result.evidence ?? []).map((e) => e.kind));
    expect(kinds.has("typecheck-error")).toBe(true);
    expect(kinds.has("todo-marker")).toBe(false);
  });

  it("is deterministic across repeated calls", async () => {
    const h = loopCloseTools("/fake/root");
    const a = await h["mandu.loop.close"]({
      stdout: "a.ts(1,1): error TS1111: A",
      stderr: "",
      exitCode: 1,
    });
    const b = await h["mandu.loop.close"]({
      stdout: "a.ts(1,1): error TS1111: A",
      stderr: "",
      exitCode: 1,
    });
    expect(a).toEqual(b);
  });

  it("returns no-patterns-matched when exitCode != 0 but no detector fires", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({
      stdout: "opaque",
      stderr: "",
      exitCode: 3,
    })) as { stallReason?: string };
    expect(result.stallReason).toBe("no-patterns-matched");
  });

  it("includes detectors_run in the response", async () => {
    const h = loopCloseTools("/fake/root");
    const result = (await h["mandu.loop.close"]({})) as {
      detectors_run?: string[];
    };
    expect(Array.isArray(result.detectors_run)).toBe(true);
    expect(result.detectors_run!.length).toBeGreaterThan(0);
  });
});
