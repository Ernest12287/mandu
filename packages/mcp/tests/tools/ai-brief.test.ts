/**
 * MCP tool — `mandu.ai.brief` tests.
 *
 * We build a temporary fake project with package.json + CLAUDE.md
 * + some generated skills, then invoke the handler and inspect the
 * structured brief. No network, no real git history — just filesystem.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  aiBriefToolDefinitions,
  aiBriefTools,
  buildSuggestedNext,
} from "../../src/tools/ai-brief";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-ai-brief-"));

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "demo-app",
        version: "1.2.3",
        description: "A test Mandu project",
        dependencies: { "@mandujs/core": "0.22.1" },
        devDependencies: { "@playwright/test": "1.40.0" },
      },
      null,
      2,
    ),
  );

  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "readme.md"),
    "# The Real Title\n\nBody text.",
  );
  writeFileSync(
    join(root, "docs", "guide.md"),
    "# Another Heading\n\nMore.",
  );

  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "skills", "demo-app-conventions.md"),
    "# Generated skill",
  );

  writeFileSync(join(root, "CLAUDE.md"), "# CLAUDE\n");
  writeFileSync(join(root, "AGENTS.md"), "# AGENTS\n");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("aiBriefToolDefinitions", () => {
  it("declares the `mandu.ai.brief` tool", () => {
    expect(aiBriefToolDefinitions).toHaveLength(1);
    const def = aiBriefToolDefinitions[0];
    expect(def.name).toBe("mandu.ai.brief");
    expect(def.annotations?.readOnlyHint).toBe(true);
  });

  it("accepts depth `short` or `full`", () => {
    const def = aiBriefToolDefinitions[0];
    const schema = def.inputSchema as {
      properties?: { depth?: { enum?: string[] } };
    };
    expect(schema.properties?.depth?.enum).toEqual(["short", "full"]);
  });
});

describe("aiBriefTools handler", () => {
  it("returns a brief with title + summary + files + skills + config", async () => {
    const h = aiBriefTools(root);
    const result = (await h["mandu.ai.brief"]({})) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.title).toContain("demo-app");
    expect(result.title).toContain("1.2.3");
    expect(typeof result.summary).toBe("string");
    expect(Array.isArray(result.files)).toBe(true);
    expect(Array.isArray(result.skills)).toBe(true);
    expect(Array.isArray(result.docs)).toBe(true);
    expect(typeof result.config).toBe("object");
    expect(Array.isArray(result.suggested_next)).toBe(true);
  });

  it("includes the generated skill when present", async () => {
    const h = aiBriefTools(root);
    const result = (await h["mandu.ai.brief"]({ depth: "full" })) as {
      skills: Array<{ id: string; source: string }>;
    };
    const generated = result.skills.find((s) => s.source === "generated");
    expect(generated?.id).toBe("demo-app-conventions");
  });

  it("detects playwright in config.has_playwright", async () => {
    const h = aiBriefTools(root);
    const result = (await h["mandu.ai.brief"]({})) as {
      config: { has_playwright?: boolean };
    };
    expect(result.config.has_playwright).toBe(true);
  });

  it("returns AGENTS.md + CLAUDE.md in the files list", async () => {
    const h = aiBriefTools(root);
    const result = (await h["mandu.ai.brief"]({})) as { files: string[] };
    expect(result.files.some((f) => f.endsWith("AGENTS.md"))).toBe(true);
    expect(result.files.some((f) => f.endsWith("CLAUDE.md"))).toBe(true);
  });

  it("trims lists in 'short' depth", async () => {
    const h = aiBriefTools(root);
    const shortResult = (await h["mandu.ai.brief"]({ depth: "short" })) as {
      skills: unknown[];
      recent_changes: unknown[];
      docs: unknown[];
    };
    expect(shortResult.skills.length).toBeLessThanOrEqual(12);
    expect(shortResult.recent_changes.length).toBeLessThanOrEqual(5);
    expect(shortResult.docs.length).toBeLessThanOrEqual(5);
  });

  it("rejects invalid depth with a structured error", async () => {
    const h = aiBriefTools(root);
    const result = (await h["mandu.ai.brief"]({ depth: "megalong" })) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("depth");
  });
});

describe("buildSuggestedNext", () => {
  it("suggests skills:generate when no generated skills are present", () => {
    const suggestions = buildSuggestedNext({
      commits: [],
      hasGeneratedSkills: false,
    });
    expect(suggestions.some((s) => s.includes("skills:generate"))).toBe(true);
  });

  it("omits skills:generate when generated skills already exist", () => {
    const suggestions = buildSuggestedNext({
      commits: [],
      hasGeneratedSkills: true,
    });
    expect(suggestions.some((s) => s.includes("skills:generate"))).toBe(false);
  });

  it("surfaces WIP commits from recent history", () => {
    const suggestions = buildSuggestedNext({
      commits: [
        { hash: "abc1234", subject: "WIP: implementing auth flow" },
        { hash: "def5678", subject: "chore: version bump" },
      ],
      hasGeneratedSkills: true,
    });
    expect(suggestions.some((s) => s.includes("auth flow"))).toBe(true);
  });

  it("always suggests a test baseline", () => {
    const suggestions = buildSuggestedNext({
      commits: [],
      hasGeneratedSkills: true,
    });
    expect(suggestions.some((s) => s.includes("run_tests"))).toBe(true);
  });

  it("surfaces the guard preset when configured", () => {
    const suggestions = buildSuggestedNext({
      commits: [],
      hasGeneratedSkills: true,
      guardPreset: "fsd",
    });
    expect(suggestions.some((s) => s.includes("fsd"))).toBe(true);
  });
});
