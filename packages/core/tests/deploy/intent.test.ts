/**
 * Issue #250 — DeployIntent schema contract tests.
 *
 * The schema is the boundary every part of the deploy pipeline talks
 * over (`.deploy()` builder, plan command, cache file, adapters).
 * These tests pin the parsing rules so a downstream consumer can
 * trust what it gets.
 */

import { describe, it, expect } from "bun:test";
import {
  DeployIntent,
  DeployIntentInput,
  isStaticIntentValidFor,
} from "../../src/deploy/intent";

describe("DeployIntent — defaults", () => {
  it("fills cache='no-store' and visibility='public' when omitted", () => {
    const intent = DeployIntent.parse({ runtime: "edge" });
    expect(intent.cache).toBe("no-store");
    expect(intent.visibility).toBe("public");
  });

  it("preserves an explicit lifetime cache object", () => {
    const intent = DeployIntent.parse({
      runtime: "static",
      cache: { sMaxAge: 3600, swr: 86_400 },
    });
    expect(intent.cache).toEqual({ sMaxAge: 3600, swr: 86_400 });
  });
});

describe("DeployIntent — validation", () => {
  it("rejects an unknown runtime", () => {
    expect(() =>
      DeployIntent.parse({ runtime: "lambda" as unknown as string }),
    ).toThrow();
  });

  it("rejects negative timeout", () => {
    expect(() =>
      DeployIntent.parse({ runtime: "edge", timeout: -1 }),
    ).toThrow();
  });

  it("rejects empty regions list entries", () => {
    expect(() =>
      DeployIntent.parse({ runtime: "edge", regions: [""] }),
    ).toThrow();
  });

  it("accepts arbitrary shape inside overrides", () => {
    const intent = DeployIntent.parse({
      runtime: "edge",
      overrides: { vercel: { memory: 1024 }, fly: { vm: "shared-cpu-2x" } },
    });
    expect((intent.overrides!.vercel as { memory: number }).memory).toBe(1024);
  });
});

describe("DeployIntentInput — partial input form", () => {
  it("accepts an empty object", () => {
    expect(() => DeployIntentInput.parse({})).not.toThrow();
  });

  it("accepts a single field", () => {
    const input = DeployIntentInput.parse({ runtime: "node" });
    expect(input.runtime).toBe("node");
  });
});

describe("isStaticIntentValidFor", () => {
  it("accepts static for a non-dynamic page", () => {
    const r = isStaticIntentValidFor(
      DeployIntent.parse({ runtime: "static" }),
      { isDynamic: false, hasGenerateStaticParams: false, kind: "page" },
    );
    expect(r.ok).toBe(true);
  });

  it("rejects static for an API route", () => {
    const r = isStaticIntentValidFor(
      DeployIntent.parse({ runtime: "static" }),
      { isDynamic: false, hasGenerateStaticParams: false, kind: "api" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/API/);
  });

  it("rejects static for a dynamic page without generateStaticParams", () => {
    const r = isStaticIntentValidFor(
      DeployIntent.parse({ runtime: "static" }),
      { isDynamic: true, hasGenerateStaticParams: false, kind: "page" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/generateStaticParams/);
  });

  it("accepts static for a dynamic page WITH generateStaticParams", () => {
    const r = isStaticIntentValidFor(
      DeployIntent.parse({ runtime: "static" }),
      { isDynamic: true, hasGenerateStaticParams: true, kind: "page" },
    );
    expect(r.ok).toBe(true);
  });

  it("does nothing for non-static runtimes", () => {
    const r = isStaticIntentValidFor(
      DeployIntent.parse({ runtime: "edge" }),
      { isDynamic: true, hasGenerateStaticParams: false, kind: "page" },
    );
    expect(r.ok).toBe(true);
  });
});
