import { describe, it, expect } from "bun:test";
import { generateUnitSpec, promptForUnitTest } from "../../unit-codegen";
import type { InteractionNode } from "../../types";

type RouteNode = Extract<InteractionNode, { kind: "route" }>;

const sampleRoute: RouteNode = {
  kind: "route",
  id: "/api/users",
  file: "app/api/users/route.ts",
  path: "/api/users",
  methods: ["GET", "POST"],
};

describe("unit-codegen backward compat", () => {
  it("generateUnitSpec emits deterministic template-based output (unchanged)", () => {
    const spec = generateUnitSpec(sampleRoute);
    // Exact substring match — this is the v0.17 contract.
    expect(spec).toContain(`import { testFilling } from "@mandujs/core/testing";`);
    expect(spec).toContain(`import { describe, it, expect } from "bun:test";`);
    expect(spec).toContain(`import route from "app/api/users/route.ts";`);
    expect(spec).toContain(`describe("/api/users", () => {`);
    expect(spec).toContain(`it("GET returns 200"`);
    expect(spec).toContain(`it("POST with valid body returns 200/201"`);
  });

  it("generateUnitSpec defaults to GET when methods missing", () => {
    const minimal = { ...sampleRoute, methods: undefined };
    const out = generateUnitSpec(minimal);
    expect(out).toContain(`it("GET returns 200"`);
    expect(out).not.toContain(`POST with valid body`);
  });

  it("generateUnitSpec omits POST if only GET is configured", () => {
    const only = { ...sampleRoute, methods: ["GET"] };
    const out = generateUnitSpec(only);
    expect(out).toContain(`GET returns 200`);
    expect(out).not.toContain(`POST with valid body`);
  });
});

describe("promptForUnitTest (new LLM bridge)", () => {
  it("wraps route info into a Claude prompt spec by default", () => {
    const spec = promptForUnitTest(sampleRoute);
    expect(spec.provider).toBe("claude");
    expect(spec.kind).toBe("unit-test");
    const user = spec.messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("/api/users");
    expect(user.content).toContain("app/api/users/route.ts");
    expect(user.content).toContain("GET, POST");
  });

  it("respects the provider override", () => {
    const spec = promptForUnitTest(sampleRoute, { provider: "openai" });
    expect(spec.provider).toBe("openai");
  });

  it("attaches repoRoot into the context when supplied", () => {
    const spec = promptForUnitTest(sampleRoute, { repoRoot: "/tmp/proj" });
    const user = spec.messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("/tmp/proj");
  });
});
