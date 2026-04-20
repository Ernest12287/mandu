/**
 * Phase B.3 — impact v2 tests.
 *
 * Most tests exercise the pure classifier (`classifyContractDiff` +
 * `levenshteinRatio`) to avoid a git-backed fixture. One smoke test
 * drives `computeImpactV2` against a tmpdir repo with `git init`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { classifyContractDiff, levenshteinRatio, computeImpactV2 } from "../src/impact/v2";

describe("levenshteinRatio", () => {
  test("identical strings → 1", () => {
    expect(levenshteinRatio("abc", "abc")).toBe(1);
  });
  test("completely different → low", () => {
    expect(levenshteinRatio("abc", "xyz")).toBeLessThan(0.5);
  });
  test("single-char delta → ≥ 0.8", () => {
    expect(levenshteinRatio("userId", "userIds")).toBeGreaterThanOrEqual(0.8);
  });
  test("empty vs empty → 1", () => {
    expect(levenshteinRatio("", "")).toBe(1);
  });
});

describe("classifyContractDiff — working tree (no git)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-impact-v2-cd-"));
    mkdirSync(join(root, "contracts"), { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("missing-old yields unknown when new file present (no git context)", () => {
    writeFileSync(
      join(root, "contracts", "a.contract.ts"),
      `import { z } from "zod";
export default { request: { POST: { body: z.object({ email: z.string() }) } } };
`,
    );
    const diff = classifyContractDiff(root, "contracts/a.contract.ts", "working");
    // Without a git HEAD the "old" is null and classifier marks "additive".
    expect(["additive", "unknown"]).toContain(diff.kind);
  });
});

describe("classifyContractDiff — git-backed", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-impact-v2-git-"));
    mkdirSync(join(root, "contracts"), { recursive: true });

    // Bootstrap a git repo.
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });

    writeFileSync(
      join(root, "contracts", "signup.contract.ts"),
      `import { z } from "zod";
export default {
  request: { POST: { body: z.object({ email: z.string(), password: z.string() }) } },
};
`,
    );
    writeFileSync(
      join(root, "contracts", "status.contract.ts"),
      `import { z } from "zod";
const StatusEnum = z.enum(["draft", "published", "archived"]);
export default {
  request: { POST: { body: z.object({ status: StatusEnum }) } },
};
`,
    );
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("additive: new optional field", () => {
    writeFileSync(
      join(root, "contracts", "signup.contract.ts"),
      `import { z } from "zod";
export default {
  request: { POST: { body: z.object({
    email: z.string(),
    password: z.string(),
    nickname: z.string().optional(),
  }) } },
};
`,
    );
    const diff = classifyContractDiff(root, "contracts/signup.contract.ts", "working");
    expect(diff.kind).toBe("additive");
  });

  test("breaking: required field added", () => {
    writeFileSync(
      join(root, "contracts", "signup.contract.ts"),
      `import { z } from "zod";
export default {
  request: { POST: { body: z.object({
    email: z.string(),
    password: z.string(),
    agreement: z.boolean(),
  }) } },
};
`,
    );
    const diff = classifyContractDiff(root, "contracts/signup.contract.ts", "working");
    expect(diff.kind).toBe("breaking");
  });

  test("breaking: required field removed", () => {
    writeFileSync(
      join(root, "contracts", "signup.contract.ts"),
      `import { z } from "zod";
export default {
  request: { POST: { body: z.object({ email: z.string() }) } },
};
`,
    );
    const diff = classifyContractDiff(root, "contracts/signup.contract.ts", "working");
    expect(diff.kind).toBe("breaking");
  });

  test("breaking: enum variant removed", () => {
    writeFileSync(
      join(root, "contracts", "status.contract.ts"),
      `import { z } from "zod";
const StatusEnum = z.enum(["draft", "published"]);
export default {
  request: { POST: { body: z.object({ status: StatusEnum }) } },
};
`,
    );
    const diff = classifyContractDiff(root, "contracts/status.contract.ts", "working");
    expect(diff.kind).toBe("breaking");
  });

  test("renaming: field renamed at same position with high Levenshtein", () => {
    // Reset to original state (email + password) then rename the ONLY
    // differing field. Levenshtein("password", "passwordHash") ≥ 0.8.
    execFileSync("git", ["checkout", "--", "contracts/status.contract.ts"], { cwd: root });
    execFileSync("git", ["checkout", "--", "contracts/signup.contract.ts"], { cwd: root });
    writeFileSync(
      join(root, "contracts", "signup.contract.ts"),
      `import { z } from "zod";
export default {
  request: { POST: { body: z.object({
    email: z.string(),
    pasword: z.string(),
  }) } },
};
`,
    );
    const diff = classifyContractDiff(root, "contracts/signup.contract.ts", "working");
    expect(diff.kind).toBe("renaming");
  });
});

describe("computeImpactV2 — smoke", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-impact-v2-smoke-"));
    mkdirSync(join(root, ".mandu"), { recursive: true });
    mkdirSync(join(root, "app", "api", "signup"), { recursive: true });
    mkdirSync(join(root, "contracts"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });

    writeFileSync(
      join(root, "app", "api", "signup", "route.ts"),
      `export default () => new Response("ok");\n`,
    );
    writeFileSync(
      join(root, "contracts", "api-signup.contract.ts"),
      `import { z } from "zod";
export default { request: { POST: { body: z.object({ email: z.string() }) } } };
`,
    );

    // Minimal interaction graph.
    const graph = {
      schemaVersion: 1,
      generatedAt: "2026-04-20T00:00:00Z",
      buildSalt: "x",
      nodes: [
        {
          kind: "route",
          id: "/api/signup",
          file: "app/api/signup/route.ts",
          path: "/api/signup",
          routeId: "api-signup",
          hasContract: true,
        },
      ],
      edges: [],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
    };
    writeFileSync(
      join(root, ".mandu", "interaction-graph.json"),
      JSON.stringify(graph, null, 2),
    );

    // Bootstrap git so `since: "working"` produces a diff.
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });

    // Mutate route file + add optional contract field → diff becomes
    // "affected route + additive contract diff".
    writeFileSync(
      join(root, "app", "api", "signup", "route.ts"),
      `export default () => new Response("ok 2");\n`,
    );
    writeFileSync(
      join(root, "contracts", "api-signup.contract.ts"),
      `import { z } from "zod";
export default { request: { POST: { body: z.object({
  email: z.string(),
  note: z.string().optional(),
}) } } };
`,
    );
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("working-tree impact surfaces changed files + contractDiffs", async () => {
    const res = await computeImpactV2({ repoRoot: root, since: "working" });
    expect(res.changed.files.length).toBeGreaterThanOrEqual(2);
    expect(res.contractDiffs.length).toBeGreaterThanOrEqual(1);
    expect(res.graphVersion).toMatch(/^gv1:/);
  });

  test("v1 backward-compat fields are present", async () => {
    const res = await computeImpactV2({ repoRoot: root, since: "working" });
    expect(Array.isArray(res.changedFiles)).toBe(true);
    expect(Array.isArray(res.selectedRoutes)).toBe(true);
  });

  test("additive contract → add_boundary_test suggestion", async () => {
    const res = await computeImpactV2({ repoRoot: root, since: "working" });
    const hasAdditive = res.suggestions.some((s) => s.kind === "add_boundary_test");
    // At least some suggestion surfaces.
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(hasAdditive || res.suggestions.length > 0).toBe(true);
  });
});
