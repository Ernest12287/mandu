/**
 * Issue #250 M4 — brain inferer tests.
 *
 * The brain inferer wraps the heuristic; its job is to confirm or
 * refine the first-pass intent without breaking the deploy when the
 * LLM is unavailable / malformed / hallucinating. These tests pin
 * each fallback path and the happy path.
 */

import { describe, it, expect } from "bun:test";
import { inferDeployIntentWithBrain } from "../../../src/deploy/inference/brain";
import type { DependencyClass, DeployInferenceContext } from "../../../src/deploy/inference/context";
import type { LLMAdapter } from "../../../src/brain/adapters/base";
import type { ChatMessage, CompletionOptions, CompletionResult, AdapterStatus } from "../../../src/brain/types";

class StubAdapter implements LLMAdapter {
  readonly name = "stub";
  constructor(private readonly response: string | (() => string | Promise<string>)) {}
  async checkStatus(): Promise<AdapterStatus> {
    return { available: true, model: "stub" };
  }
  async complete(_messages: ChatMessage[], _options?: CompletionOptions): Promise<CompletionResult> {
    return { content: await this.text(), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async generate(): Promise<string> {
    return this.text();
  }
  private async text(): Promise<string> {
    return typeof this.response === "function" ? await this.response() : this.response;
  }
}

class ThrowingAdapter implements LLMAdapter {
  readonly name = "throwing";
  async checkStatus(): Promise<AdapterStatus> {
    return { available: false, model: null, error: "stub" };
  }
  async complete(): Promise<CompletionResult> {
    throw new Error("network down");
  }
  async generate(): Promise<string> {
    throw new Error("network down");
  }
}

function ctx(overrides: Partial<DeployInferenceContext> = {}): DeployInferenceContext {
  return {
    routeId: "api-embed",
    pattern: "/api/embed",
    kind: "api",
    isDynamic: false,
    hasGenerateStaticParams: false,
    imports: [],
    dependencyClasses: new Set<DependencyClass>(["fetch-only"]),
    exportsFilling: true,
    sourceHash: "h".repeat(64),
    ...overrides,
  };
}

describe("brain inferer — happy path", () => {
  it("uses the brain's intent when it's valid JSON + valid Zod", async () => {
    const adapter = new StubAdapter(
      JSON.stringify({
        runtime: "node",
        cache: "no-store",
        visibility: "public",
        rationale: "uses Postgres connection pool",
      }),
    );
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(ctx({ dependencyClasses: new Set(["db"]) }));
    expect(r.intent.runtime).toBe("node");
    expect(r.rationale).toMatch(/agreed with heuristic|brain refined/);
  });

  it("merges brain partial output with heuristic defaults", async () => {
    // Brain only specifies runtime; cache/visibility should come from heuristic.
    const adapter = new StubAdapter(
      JSON.stringify({ runtime: "edge", rationale: "stateless transform" }),
    );
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(ctx());
    expect(r.intent.runtime).toBe("edge");
    expect(r.intent.cache).toBe("no-store"); // heuristic default for API
    expect(r.intent.visibility).toBe("public");
  });

  it("strips ```json fences before parsing", async () => {
    const adapter = new StubAdapter(
      "```json\n" +
        JSON.stringify({ runtime: "edge", rationale: "fenced" }) +
        "\n```",
    );
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(ctx());
    expect(r.intent.runtime).toBe("edge");
  });
});

describe("brain inferer — fallback to heuristic", () => {
  it("falls back when the brain returns empty", async () => {
    const adapter = new StubAdapter("");
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(ctx());
    // Heuristic for stateless API → edge
    expect(r.intent.runtime).toBe("edge");
  });

  it("falls back when the brain returns non-JSON", async () => {
    const adapter = new StubAdapter("Sorry, I can't help with that.");
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(ctx());
    expect(r.intent.runtime).toBe("edge");
  });

  it("falls back when the brain JSON fails Zod validation", async () => {
    const adapter = new StubAdapter(
      JSON.stringify({ runtime: "lambda", rationale: "wrong runtime enum" }),
    );
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(ctx());
    expect(r.intent.runtime).toBe("edge"); // heuristic survives
  });

  it("falls back when the brain throws (network, auth, etc)", async () => {
    const adapter = new ThrowingAdapter();
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(ctx());
    expect(r.intent.runtime).toBe("edge");
    expect(r.rationale).toContain("brain unavailable");
  });

  it("rejects brain runtime:'static' on a dynamic page without generateStaticParams", async () => {
    const adapter = new StubAdapter(
      JSON.stringify({
        runtime: "static",
        rationale: "should not work",
      }),
    );
    const infer = inferDeployIntentWithBrain({ adapter });
    const r = await infer(
      ctx({
        kind: "page",
        isDynamic: true,
        hasGenerateStaticParams: false,
      }),
    );
    expect(r.intent.runtime).not.toBe("static");
    expect(r.rationale).toMatch(/conflicts with route shape/);
  });
});

describe("brain inferer — failOnError", () => {
  it("propagates the error when failOnError is true", async () => {
    const adapter = new ThrowingAdapter();
    const infer = inferDeployIntentWithBrain({ adapter, failOnError: true });
    await expect(infer(ctx())).rejects.toThrow(/network down/);
  });
});
