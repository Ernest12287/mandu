/**
 * Deep L2/L3 Oracle + a11y tests
 *
 * Covers:
 *   - L2 contract-driven assertion generation (happy path + edge cases)
 *   - L3 behavioral side-effect detection and state-change verification
 *   - a11y assertion generator output shape
 *   - Contract parser (Zod regex parsing)
 *   - Side-effect scanner (db.X.create, sendEmail, external fetch)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseContractSource,
  findContractForRoute,
  inferRouteFromFileName,
} from "../src/contract-parser";
import { scanSourceForSideEffects } from "../src/side-effect-scanner";
import {
  generateL2Assertions,
  generateL2AssertionsFromContract,
  generateL3Assertions,
  generateL3AssertionsFromSideEffects,
  generateA11yAssertions,
  generateA11yTestBlock,
  countBehavioralAssertions,
} from "../src/oracle";
import type { InteractionNode } from "../src/types";

const SAMPLE_CONTRACT = `
import { z } from "zod";
import { Mandu } from "@mandujs/core";

const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

export default Mandu.contract({
  request: {
    GET: {},
    POST: {
      body: z.object({
        name: z.string().min(1, "Name is required"),
        color: z.string().optional(),
      }),
    },
  },
  response: {
    200: z.object({
      categories: z.array(CategorySchema),
    }),
    201: z.object({
      category: CategorySchema,
    }),
    400: z.object({
      error: z.string(),
    }),
  },
});
`;

describe("contract-parser", () => {
  test("parses response status codes", () => {
    const parsed = parseContractSource("/fake/api-categories.contract.ts", SAMPLE_CONTRACT);
    const statuses = parsed.responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 201, 400]);
  });

  test("extracts top-level keys from response shape", () => {
    const parsed = parseContractSource("/fake/api-categories.contract.ts", SAMPLE_CONTRACT);
    const ok = parsed.responses.find((r) => r.status === 200)!;
    expect(ok.topLevelKeys.find((f) => f.name === "categories")?.kind).toBe("array");

    const created = parsed.responses.find((r) => r.status === 201)!;
    // "category: CategorySchema" is an identifier reference, not an inline z.object,
    // so parser kind is "unknown" — the top-level key is still captured.
    expect(created.topLevelKeys.find((f) => f.name === "category")).toBeDefined();
  });

  test("parses POST body fields with min length and optional", () => {
    const parsed = parseContractSource("/fake/api-categories.contract.ts", SAMPLE_CONTRACT);
    const post = parsed.requests.find((r) => r.method === "POST")!;
    const nameField = post.bodyFields.find((f) => f.name === "name")!;
    expect(nameField.kind).toBe("string");
    expect(nameField.optional).toBe(false);
    expect(nameField.minLength).toBe(1);

    const colorField = post.bodyFields.find((f) => f.name === "color")!;
    expect(colorField.optional).toBe(true);
  });

  test("inferRouteFromFileName handles basic and $param segments", () => {
    expect(inferRouteFromFileName("/x/api-categories.contract.ts")).toBe("/api/categories");
    expect(inferRouteFromFileName("/x/api-notes-$id.contract.ts")).toBe("/api/notes/:id");
  });
});

describe("generateL2AssertionsFromContract", () => {
  const node: InteractionNode = {
    kind: "route",
    id: "/api/categories",
    file: "app/api/categories/route.ts",
    path: "/api/categories",
    methods: ["POST"],
  };
  const parsed = parseContractSource("/fake/api-categories.contract.ts", SAMPLE_CONTRACT);
  const lines = generateL2AssertionsFromContract(node, parsed);
  const joined = lines.join("\n");

  test("emits method-aware request with synthesized valid body", () => {
    expect(joined).toContain('request.post("/api/categories"');
    expect(joined).toMatch(/"name":"x"/);
  });

  test("asserts happy-path status from contract", () => {
    // Generator prefers 200 over 201 when both are present.
    expect(joined).toMatch(/expect\(validRes\.status\(\)\)\.toBe\(200\)/);
  });

  test("asserts toHaveProperty for top-level response keys", () => {
    // 201 shape has "category" — or parser picks 200 (categories). Both are valid keys.
    const hasCategory = joined.includes('toHaveProperty("category")');
    const hasCategories = joined.includes('toHaveProperty("categories")');
    expect(hasCategory || hasCategories).toBe(true);
  });

  test("emits empty-body edge case rejection", () => {
    expect(joined).toContain("data: {}");
    expect(joined).toMatch(/emptyRes\.status\(\)\)\.toBeGreaterThanOrEqual\(400\)/);
  });

  test("emits empty-string edge case for required min-length field", () => {
    expect(joined).toContain('"name":""');
    expect(joined).toMatch(/invalid_name_Res.*toBeGreaterThanOrEqual\(400\)/s);
  });
});

describe("generateL2Assertions (integration with ctx)", () => {
  // Create a tempdir with a real contract file to exercise findContractForRoute
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "ate-l2-"));
    mkdirSync(join(tmp, "spec", "contracts"), { recursive: true });
    writeFileSync(join(tmp, "spec", "contracts", "api-categories.contract.ts"), SAMPLE_CONTRACT);
  });
  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  test("uses deep contract generator when contract is discoverable via repoRoot", () => {
    const node: InteractionNode = {
      kind: "route",
      id: "/api/categories",
      file: "app/api/categories/route.ts",
      path: "/api/categories",
      methods: ["POST"],
    };
    const lines = generateL2Assertions(node, { repoRoot: tmp });
    const joined = lines.join("\n");
    expect(joined).toContain("deep");
    expect(joined).toMatch(/toHaveProperty/);
  });

  test("falls back to shallow generator when no contract found", () => {
    const node: InteractionNode = {
      kind: "route",
      id: "/api/unknown",
      file: "app/api/unknown/route.ts",
      path: "/api/unknown",
      methods: ["GET"],
    };
    const lines = generateL2Assertions(node, { repoRoot: tmp });
    expect(lines.join("\n")).toContain("shallow");
  });

  test("findContractForRoute locates by inferred route", () => {
    const found = findContractForRoute(tmp, "/api/categories");
    expect(found).not.toBeNull();
    expect(found!.responses.length).toBeGreaterThan(0);
  });
});

describe("side-effect-scanner", () => {
  test("detects db.X.create and prisma.X.create", () => {
    const src = `
      export async function POST(ctx) {
        await db.users.create({ data: { name: "a" } });
        const y = await prisma.post.create({ data: {} });
      }
    `;
    const effects = scanSourceForSideEffects(src);
    const creates = effects.filter((e) => e.kind === "db-create");
    expect(creates.length).toBeGreaterThanOrEqual(2);
    expect(creates.some((e) => e.resource === "users")).toBe(true);
    expect(creates.some((e) => e.resource === "post")).toBe(true);
  });

  test("detects db.X.update and delete", () => {
    const src = `db.users.update({}); db.posts.delete({});`;
    const effects = scanSourceForSideEffects(src);
    expect(effects.some((e) => e.kind === "db-update" && e.resource === "users")).toBe(true);
    expect(effects.some((e) => e.kind === "db-delete" && e.resource === "posts")).toBe(true);
  });

  test("detects email send", () => {
    const src = `await sendEmail({ to: "a@b.c" }); mailer.send({});`;
    const effects = scanSourceForSideEffects(src);
    expect(effects.filter((e) => e.kind === "email").length).toBeGreaterThanOrEqual(2);
  });

  test("detects external fetch but skips localhost", () => {
    const src = `
      fetch("https://api.stripe.com/v1/charges");
      fetch("http://localhost:3333/api/foo");
    `;
    const effects = scanSourceForSideEffects(src);
    const ext = effects.filter((e) => e.kind === "external-fetch");
    expect(ext.length).toBe(1);
    expect(ext[0].match).toContain("stripe.com");
  });
});

describe("generateL3AssertionsFromSideEffects", () => {
  const node: InteractionNode = {
    kind: "route",
    id: "/api/users",
    file: "app/api/users/route.ts",
    path: "/api/users",
    methods: ["POST"],
  };

  test("emits before/after state-change check for db-create", () => {
    const lines = generateL3AssertionsFromSideEffects(node, [
      { kind: "db-create", resource: "users", match: "db.users.create(" },
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("before_users");
    expect(joined).toContain("after_users");
    expect(joined).toMatch(/afterCount_users.*toBeGreaterThanOrEqual.*beforeCount_users/s);
  });

  test("deduplicates repeated effects by kind+resource", () => {
    const lines = generateL3AssertionsFromSideEffects(node, [
      { kind: "db-create", resource: "users", match: "db.users.create(" },
      { kind: "db-create", resource: "users", match: "db.users.create(" },
    ]);
    // only one before_users declaration
    const count = lines.filter((l) => l.includes("const before_users")).length;
    expect(count).toBe(1);
  });

  test("countBehavioralAssertions returns non-zero for db-create", () => {
    const lines = generateL3AssertionsFromSideEffects(node, [
      { kind: "db-create", resource: "users", match: "db.users.create(" },
    ]);
    expect(countBehavioralAssertions(lines)).toBe(1);
  });

  test("returns empty array when no effects", () => {
    const lines = generateL3AssertionsFromSideEffects(node, []);
    expect(lines).toEqual([]);
  });
});

describe("generateL3Assertions with ctx.sideEffects", () => {
  test("uses deep generator when sideEffects provided", () => {
    const node: InteractionNode = {
      kind: "route",
      id: "/api/users",
      file: "app/api/users/route.ts",
      path: "/api/users",
      methods: ["POST"],
    };
    const lines = generateL3Assertions(node, [], {
      sideEffects: [{ kind: "db-create", resource: "users", match: "db.users.create(" }],
    });
    expect(lines.join("\n")).toContain("L3 (deep)");
  });

  test("falls back to shallow POST generator when no effects detected", () => {
    const node: InteractionNode = {
      kind: "route",
      id: "/api/legacy",
      file: "app/api/legacy/route.ts",
      path: "/api/legacy",
      methods: ["POST"],
    };
    const lines = generateL3Assertions(node, [], { sideEffects: [] });
    // Shallow variant uses "POST state change verification"
    expect(lines.join("\n")).toContain("POST state change verification");
  });
});

describe("generateA11yAssertions", () => {
  test("returns valid assertion lines with default WCAG tags", () => {
    const lines = generateA11yAssertions("/dashboard");
    const joined = lines.join("\n");
    expect(joined).toContain('page.goto("/dashboard")');
    expect(joined).toContain("@axe-core/playwright");
    expect(joined).toContain("wcag2a");
    expect(joined).toContain("wcag2aa");
    expect(joined).toContain("analyze()");
    expect(joined).toContain("violations");
    expect(joined).toContain("toEqual([])");
  });

  test("respects custom tags and include selector", () => {
    const lines = generateA11yAssertions("/x", { tags: ["wcag21aa"], include: "main" });
    const joined = lines.join("\n");
    expect(joined).toContain("wcag21aa");
    expect(joined).toContain('axe.include("main")');
  });

  test("generateA11yTestBlock wraps in a test(...) block", () => {
    const block = generateA11yTestBlock("/foo");
    expect(block).toMatch(/^test\("\/foo has no a11y violations"/);
    expect(block).toContain("async ({ page })");
    expect(block.endsWith("});")).toBe(true);
  });
});
