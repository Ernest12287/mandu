import { describe, it, expect } from "bun:test";
import {
  promptFor,
  listKinds,
  getTemplate,
  renderContextAsXml,
  unitTestTemplate,
  integrationTestTemplate,
  e2eTestTemplate,
  healTemplate,
  impactTemplate,
} from "../index";

describe("promptFor - basic contract", () => {
  it("returns a PromptSpec with system + user message for Claude", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      target: { id: "/api/users", path: "/api/users", methods: ["GET"] },
    });
    expect(spec.kind).toBe("unit-test");
    expect(spec.provider).toBe("claude");
    expect(spec.templateId).toBe("unit-test@1.0.0");
    expect(spec.messages.length).toBeGreaterThanOrEqual(2);
    expect(spec.messages[0].role).toBe("system");
    expect(spec.messages[spec.messages.length - 1].role).toBe("user");
    expect(spec.system).toContain("<role>");
  });

  it("throws when kind is missing", () => {
    // @ts-expect-error intentional
    expect(() => promptFor({ provider: "claude" })).toThrow();
  });

  it("throws when provider is missing", () => {
    // @ts-expect-error intentional
    expect(() => promptFor({ kind: "unit-test" })).toThrow();
  });

  it("throws on unknown kind", () => {
    expect(() =>
      // @ts-expect-error intentional
      promptFor({ kind: "nonsense", provider: "claude" }),
    ).toThrow();
  });
});

describe("promptFor - provider formats", () => {
  it("OpenAI adapter keeps OpenAI chat format", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "openai",
      target: { id: "/api/a", methods: ["GET"] },
    });
    expect(spec.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(spec.messages[0].content).toContain("<role>");
  });

  it("Gemini adapter preserves system slot (caller peels it off)", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "gemini",
      target: { id: "/api/a", methods: ["GET"] },
    });
    expect(spec.messages.length).toBe(2);
    expect(spec.messages[0].role).toBe("system");
  });

  it("local adapter produces OpenAI-compatible shape", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "local",
      target: { id: "/api/a", methods: ["GET"] },
    });
    expect(spec.messages[0].role).toBe("system");
    expect(spec.messages[1].role).toBe("user");
  });

  it("Claude adapter merges multiple system messages into one", () => {
    // Use overrides to force two system strings via docs injection
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      target: { id: "/api/x", methods: ["GET"] },
      context: {
        systemDocs: [
          { name: "docA", content: "Doc A content" },
          { name: "docB", content: "Doc B content" },
        ],
      },
    });
    // Expect exactly one system message, which contains both docs
    const systems = spec.messages.filter((m) => m.role === "system");
    expect(systems.length).toBe(1);
    expect(systems[0].content).toContain("Doc A content");
    expect(systems[0].content).toContain("Doc B content");
  });
});

describe("promptFor - templates", () => {
  it("lists all registered kinds", () => {
    const kinds = listKinds();
    expect(kinds).toContain("unit-test");
    expect(kinds).toContain("integration-test");
    expect(kinds).toContain("e2e-test");
    expect(kinds).toContain("heal");
    expect(kinds).toContain("impact");
  });

  it("unit-test template includes Bun:test imports mandate", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      target: { id: "/api/u", methods: ["GET", "POST"] },
    });
    expect(spec.system).toContain("bun:test");
    expect(spec.system).toContain("testFilling");
    // user prompt includes methods
    const userMsg = spec.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("GET, POST");
  });

  it("integration-test template mentions ephemeral port", () => {
    const spec = promptFor({
      kind: "integration-test",
      provider: "claude",
      target: { id: "/api/u", methods: ["GET"] },
    });
    expect(spec.system).toContain("port: 0");
  });

  it("e2e-test template mentions accessible locators", () => {
    const spec = promptFor({
      kind: "e2e-test",
      provider: "claude",
      target: { id: "/users", path: "/users" },
    });
    expect(spec.system).toContain("getByRole");
  });

  it("heal template requires heal_decision XML block", () => {
    const spec = promptFor({
      kind: "heal",
      provider: "claude",
      target: { snippet: "boom: locator not found" },
    });
    expect(spec.system).toContain("<heal_decision>");
    const user = spec.messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("failure_trace");
  });

  it("impact template requires <impact> output", () => {
    const spec = promptFor({
      kind: "impact",
      provider: "claude",
      target: { snippet: "diff --git a/app/x b/app/x" },
    });
    expect(spec.system).toContain("<impact>");
  });

  it("getTemplate returns the right versioned template", () => {
    expect(getTemplate("unit-test")).toBe(unitTestTemplate);
    expect(getTemplate("integration-test")).toBe(integrationTestTemplate);
    expect(getTemplate("e2e-test")).toBe(e2eTestTemplate);
    expect(getTemplate("heal")).toBe(healTemplate);
    expect(getTemplate("impact")).toBe(impactTemplate);
  });
});

describe("promptFor - context injection", () => {
  it("renders manifest routes as XML in user prompt", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      context: {
        manifest: {
          version: 1,
          routes: [
            { id: "/api/users", pattern: "/api/users", kind: "api", methods: ["GET"] },
            { id: "/users", pattern: "/users", kind: "page" },
          ],
        },
      },
      target: { id: "/api/users", methods: ["GET"] },
    });
    const userMsg = spec.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("<routes count=\"2\">");
    expect(userMsg.content).toContain("/api/users");
  });

  it("includes resources in context rendering", () => {
    const xml = renderContextAsXml({
      resources: [{ name: "user" }, { name: "post" }],
    });
    expect(xml).toContain("<resource name=\"user\"");
    expect(xml).toContain("<resource name=\"post\"");
  });

  it("includes guard preset + violations in context", () => {
    const xml = renderContextAsXml({
      guardPreset: "mandu",
      guardViolations: [
        { ruleId: "LAYER_VIOLATION", file: "a.ts", message: "bad", severity: "error" },
      ],
    });
    expect(xml).toContain("preset=\"mandu\"");
    expect(xml).toContain("LAYER_VIOLATION");
  });

  it("escapes XML special characters in context values", () => {
    const xml = renderContextAsXml({
      repoRoot: "/tmp/<project>&stuff",
    });
    expect(xml).toContain("&lt;project&gt;");
    expect(xml).toContain("&amp;");
  });

  it("returns empty string for undefined context", () => {
    expect(renderContextAsXml(undefined)).toBe("");
  });
});

describe("promptFor - budgeting + overrides", () => {
  it("truncates when user prompt exceeds budget", () => {
    const hugeSnippet = "x".repeat(100_000);
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      target: { id: "/api/u", methods: ["GET"], snippet: hugeSnippet },
      budget: { maxUserChars: 1000 },
    });
    const user = spec.messages.find((m) => m.role === "user")!;
    expect(user.content.length).toBeLessThanOrEqual(1000);
    expect(user.content).toContain("truncated");
  });

  it("overrides.system wins over template system", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      target: { id: "/api/a", methods: ["GET"] },
      overrides: { system: "SENTINEL-SYSTEM" },
    });
    expect(spec.system).toContain("SENTINEL-SYSTEM");
  });

  it("overrides.user wins over template user", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      target: { id: "/api/a", methods: ["GET"] },
      overrides: { user: "SENTINEL-USER-BODY" },
    });
    const user = spec.messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("SENTINEL-USER-BODY");
  });

  it("tracks charCount across all messages", () => {
    const spec = promptFor({
      kind: "unit-test",
      provider: "claude",
      target: { id: "/api/a", methods: ["GET"] },
    });
    const manual = spec.messages.reduce((acc, m) => acc + m.content.length, 0);
    expect(spec.charCount).toBe(manual);
  });
});
