/**
 * MCP design discovery tools — Issue #245 M4 tests.
 *
 * Pin the contracts agents rely on:
 *   - `mandu.design.get` returns the parsed spec / per-section payload
 *     and friendly errors when DESIGN.md is missing.
 *   - `mandu.design.prompt` surfaces §9 prompts (or empty + hint).
 *   - `mandu.design.check` runs the Guard rule on a single file.
 *   - `mandu.component.list` walks the conventional folders.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  designTools,
  designToolDefinitions,
} from "../../src/tools/design";

const SAMPLE_DESIGN_MD = `# Test
## Visual Theme & Philosophy
Warm, calm.

## Color Palette
- Primary — #FF8C42 — brand accent
- Surface — #FFF8F0 — background

## Typography
- body: font-family: Inter, sans-serif; size: 16px

## Do's & Don'ts

### Don'ts
- Avoid using \`btn-hard\` directly in pages.

## Agent Prompts
### Brand voice
Keep tone direct and warm.
`;

async function setupFixture(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-mcp-design-"));
  await fs.writeFile(path.join(root, "DESIGN.md"), SAMPLE_DESIGN_MD);
  // Component fixtures
  await fs.mkdir(path.join(root, "src", "client", "shared", "ui"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "client", "shared", "ui", "button.tsx"),
    `/** Mandu primary button. */
export function MButton(props: MButtonProps) { return null; }
interface MButtonProps {
  variant: string;
  size?: string;
}
`,
  );
  await fs.mkdir(path.join(root, "src", "client", "widgets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "client", "widgets", "site-header.tsx"),
    `/** Top of every page. */
export function SiteHeader() { return null; }
`,
  );
  // A bad file using the forbidden inline class.
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  await fs.writeFile(
    path.join(root, "app", "page.tsx"),
    `export default function Page() {
  return <div className="btn-hard">Click</div>;
}
`,
  );
  // Minimal mandu.config.ts so loadDesignGuardConfig finds something.
  await fs.writeFile(
    path.join(root, "mandu.config.ts"),
    `export default { guard: { design: { autoFromDesignMd: true, severity: "warning" } } };\n`,
  );
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

describe("designToolDefinitions", () => {
  it("declares 4 tools, all read-only", () => {
    expect(designToolDefinitions).toHaveLength(4);
    for (const def of designToolDefinitions) {
      expect(def.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("exposes the canonical tool names", () => {
    const names = designToolDefinitions.map((t) => t.name).sort();
    expect(names).toEqual([
      "mandu.component.list",
      "mandu.design.check",
      "mandu.design.get",
      "mandu.design.prompt",
    ]);
  });
});

describe("mandu.design.get", () => {
  let fix: { root: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it("returns the full spec when section is omitted", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.design.get"]!({})) as {
      title?: string;
      sections: Record<string, { present: boolean }>;
    };
    expect(result.title).toBe("Test");
    expect(result.sections["color-palette"]?.present).toBe(true);
    expect(result.sections.typography?.present).toBe(true);
  });

  it("returns a single section when requested", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.design.get"]!({ section: "color-palette" })) as {
      section: string;
      tokens: Array<{ name: string; value?: string }>;
    };
    expect(result.section).toBe("color-palette");
    expect(result.tokens.find((t) => t.name === "Primary")?.value).toBe("#FF8C42");
  });

  it("rejects unknown sections with a hint", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.design.get"]!({ section: "made-up" })) as {
      error: string;
      hint?: string;
    };
    expect(result.error).toContain("Unknown section");
    expect(result.hint).toContain("color-palette");
  });

  it("returns a friendly error when DESIGN.md is missing", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-mcp-design-empty-"));
    try {
      const h = designTools(empty);
      const result = (await h["mandu.design.get"]!({})) as { error: string };
      expect(result.error).toContain("DESIGN.md");
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe("mandu.design.prompt", () => {
  let fix: { root: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it("returns §9 prompts", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.design.prompt"]!({})) as {
      prompts: Array<{ title: string }>;
    };
    expect(result.prompts.length).toBeGreaterThan(0);
    expect(result.prompts.some((p) => p.title.includes("Brand voice"))).toBe(true);
  });
});

describe("mandu.design.check", () => {
  let fix: { root: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it("flags inline forbidden classes derived from DESIGN.md §7", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.design.check"]!({ file: "app/page.tsx" })) as {
      violations: Array<{ rule: string; line: number }>;
    };
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]!.rule).toBe("DESIGN_INLINE_CLASS");
  });

  it("requires a `file` argument", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.design.check"]!({})) as { error?: string };
    expect(result.error).toBeDefined();
  });
});

describe("mandu.component.list", () => {
  let fix: { root: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it("inventories ui-primitives + widgets with descriptions and props", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.component.list"]!({})) as {
      count: number;
      components: Array<{
        name: string;
        category: string;
        description?: string;
        props?: string[];
      }>;
    };
    expect(result.count).toBe(2);
    const button = result.components.find((c) => c.name === "MButton");
    expect(button?.category).toBe("ui-primitive");
    expect(button?.description).toContain("Mandu primary");
    expect(button?.props).toContain("variant");
    expect(button?.props).toContain("size");

    const header = result.components.find((c) => c.name === "SiteHeader");
    expect(header?.category).toBe("widget");
  });

  it("filters by category", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.component.list"]!({ category: "widget" })) as {
      components: Array<{ name: string; category: string }>;
    };
    expect(result.components.every((c) => c.category === "widget")).toBe(true);
  });

  it("populates usage_count when count_usage:true", async () => {
    const h = designTools(fix.root);
    const result = (await h["mandu.component.list"]!({ count_usage: true })) as {
      components: Array<{ name: string; usage_count?: number }>;
    };
    for (const c of result.components) {
      expect(typeof c.usage_count).toBe("number");
    }
  });
});
