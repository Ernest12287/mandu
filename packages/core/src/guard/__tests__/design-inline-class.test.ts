/**
 * Guard `DESIGN_INLINE_CLASS` rule tests (Issue #245 M2).
 *
 * Cover the three forbid-list sources (explicit / DESIGN.md auto /
 * combined), the exclude paths (canonical component dirs), and the
 * regex matcher's variant-prefix handling.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkDesignInlineClasses } from "../design-inline-class";

async function makeRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `mandu-design-guard-${prefix}-`));
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

describe("checkDesignInlineClasses", () => {
  it("returns no violations when guard.design is undefined", async () => {
    const root = await makeRoot("undef");
    await writeFile(
      root,
      "src/client/page.tsx",
      `export default () => <div className="btn-hard">x</div>;\n`,
    );
    const out = await checkDesignInlineClasses(root, undefined);
    expect(out).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("flags an inline forbidden class with line number", async () => {
    const root = await makeRoot("flag");
    await writeFile(
      root,
      "src/client/page.tsx",
      `import * as React from 'react';

export default () => (
  <div className="px-4 py-2 btn-hard rounded-md">x</div>
);
`,
    );
    const out = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.ruleId).toBe("DESIGN_INLINE_CLASS");
    expect(out[0]?.file.replace(/\\/g, "/")).toBe("src/client/page.tsx");
    expect(out[0]?.line).toBe(4);
    expect(out[0]?.message).toContain("btn-hard");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("surfaces the replacement component in the message + suggestion", async () => {
    const root = await makeRoot("hint");
    await writeFile(
      root,
      "src/client/page.tsx",
      `<div className="btn-hard">x</div>`,
    );
    const out = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
      requireComponent: { "btn-hard": "@/client/shared/ui#MButton" },
    });
    expect(out[0]?.message).toContain("@/client/shared/ui#MButton");
    expect(out[0]?.suggestion).toContain("@/client/shared/ui#MButton");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("excludes the canonical component dirs by default", async () => {
    const root = await makeRoot("exclude-default");
    // The component definition itself uses btn-hard — that's where it
    // legitimately lives. Default exclude must skip this file.
    await writeFile(
      root,
      "src/client/shared/ui/m-button.tsx",
      `<button className="btn-hard">x</button>`,
    );
    // A page that imports it must still be flagged.
    await writeFile(
      root,
      "src/client/pages/home.tsx",
      `<div className="btn-hard">x</div>`,
    );
    const out = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
    });
    const files = out.map((v) => v.file.replace(/\\/g, "/"));
    expect(files).toContain("src/client/pages/home.tsx");
    expect(files).not.toContain("src/client/shared/ui/m-button.tsx");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("strips Tailwind variant prefixes (hover:btn-hard matches btn-hard)", async () => {
    const root = await makeRoot("variant");
    await writeFile(
      root,
      "src/client/page.tsx",
      `<div className="hover:btn-hard focus:btn-hard">x</div>`,
    );
    const out = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
    });
    expect(out.length).toBeGreaterThanOrEqual(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("auto-extracts forbid tokens from DESIGN.md §7 Don't section", async () => {
    const root = await makeRoot("auto-design");
    await writeFile(
      root,
      "DESIGN.md",
      `# X

## Do's & Don'ts

### Do
- Use the \`MButton\` component.

### Don't
- Inline \`btn-hard\` directly in pages.
- Don't use \`shadow-hard\` outside ui/.
`,
    );
    await writeFile(
      root,
      "src/client/page.tsx",
      `<div className="btn-hard shadow-hard">x</div>`,
    );
    const out = await checkDesignInlineClasses(root, {
      autoFromDesignMd: true,
    });
    const tokens = out.map((v) => v.message.match(/"([\w-]+)"/)?.[1]);
    expect(tokens).toContain("btn-hard");
    expect(tokens).toContain("shadow-hard");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("merges explicit forbid + DESIGN.md auto", async () => {
    const root = await makeRoot("merge");
    await writeFile(
      root,
      "DESIGN.md",
      `## Do's & Don'ts

### Don't
- Avoid \`shadow-hard\`.
`,
    );
    await writeFile(
      root,
      "src/client/page.tsx",
      `<div className="btn-hard shadow-hard">x</div>`,
    );
    const out = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
      autoFromDesignMd: true,
    });
    const tokens = out.map((v) => v.message.match(/"([\w-]+)"/)?.[1]);
    expect(tokens).toContain("btn-hard");
    expect(tokens).toContain("shadow-hard");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("scans both src/ and app/ when present", async () => {
    const root = await makeRoot("dual-roots");
    await writeFile(root, "src/x.tsx", `<div className="btn-hard">x</div>`);
    await writeFile(root, "app/y.tsx", `<div className="btn-hard">y</div>`);
    const out = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
    });
    const files = out.map((v) => v.file.replace(/\\/g, "/")).sort();
    expect(files).toEqual(["app/y.tsx", "src/x.tsx"]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("respects custom exclude patterns", async () => {
    const root = await makeRoot("custom-exclude");
    await writeFile(root, "src/legacy/old-page.tsx", `<div className="btn-hard">x</div>`);
    const out = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
      exclude: ["src/legacy/**"],
    });
    expect(out).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("honours severity setting on emitted violations", async () => {
    const root = await makeRoot("severity");
    await writeFile(root, "src/x.tsx", `<div className="btn-hard">x</div>`);
    const errors = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
      severity: "error",
    });
    expect(errors[0]?.severity).toBe("error");
    const warnings = await checkDesignInlineClasses(root, {
      forbidInlineClasses: ["btn-hard"],
      severity: "warning",
    });
    expect(warnings[0]?.severity).toBe("warning");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns nothing when forbid list resolves to empty", async () => {
    const root = await makeRoot("empty-forbid");
    await writeFile(root, "src/x.tsx", `<div className="btn-hard">x</div>`);
    // No explicit list, autoFromDesignMd false → nothing to enforce.
    const out = await checkDesignInlineClasses(root, {});
    expect(out).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });
});
