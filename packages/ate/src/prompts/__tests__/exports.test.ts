import { describe, it, expect } from "bun:test";
import * as ate from "../../index";
import * as prompts from "../index";

describe("public exports", () => {
  it("re-exports promptFor from @mandujs/ate root", () => {
    expect(typeof ate.promptFor).toBe("function");
    expect(typeof ate.listKinds).toBe("function");
    expect(typeof ate.loadProjectContext).toBe("function");
    expect(typeof ate.renderContextAsXml).toBe("function");
    expect(typeof ate.getTemplate).toBe("function");
    expect(typeof ate.getAdapter).toBe("function");
  });

  it("re-exports all adapters from @mandujs/ate root", () => {
    expect(ate.claudeAdapter.name).toBe("claude");
    expect(ate.openaiAdapter.name).toBe("openai");
    expect(ate.geminiAdapter.name).toBe("gemini");
    expect(ate.localAdapter.name).toBe("local");
  });

  it("re-exports all templates from @mandujs/ate root", () => {
    expect(ate.unitTestTemplate.kind).toBe("unit-test");
    expect(ate.integrationTestTemplate.kind).toBe("integration-test");
    expect(ate.e2eTestTemplate.kind).toBe("e2e-test");
    expect(ate.healTemplate.kind).toBe("heal");
    expect(ate.impactTemplate.kind).toBe("impact");
  });

  it("adapters applied via getAdapter match direct imports", () => {
    expect(prompts.getAdapter("claude")).toBe(prompts.claudeAdapter);
    expect(prompts.getAdapter("openai")).toBe(prompts.openaiAdapter);
    expect(prompts.getAdapter("gemini")).toBe(prompts.geminiAdapter);
    expect(prompts.getAdapter("local")).toBe(prompts.localAdapter);
  });

  it("fallback to local adapter for unknown provider", () => {
    // @ts-expect-error intentional
    expect(prompts.getAdapter("unknown-provider")).toBe(prompts.localAdapter);
  });

  it("all template versions are semver 1.x.y", () => {
    for (const kind of prompts.listKinds()) {
      const tpl = prompts.getTemplate(kind);
      expect(tpl.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("char budget adapters differ", () => {
    const c = prompts.claudeAdapter.getDefaultUserCharBudget();
    const o = prompts.openaiAdapter.getDefaultUserCharBudget();
    const l = prompts.localAdapter.getDefaultUserCharBudget();
    expect(c).toBeGreaterThan(l);
    expect(o).toBeGreaterThan(l);
  });
});
