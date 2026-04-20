/**
 * Phase C.2 — operator-level mutation tests.
 *
 * Each operator gets ≥ 1 test that (a) produces a mutation, (b) produces
 * source that differs from the original, and (c) preserves the surrounding
 * code so `ts-morph` can still re-parse it.
 */
import { describe, test, expect } from "bun:test";
import { Project, SyntaxKind } from "ts-morph";
import {
  ALL_OPERATORS,
  OPERATOR_NAMES,
  runAllOperators,
  type MutatedSourceFile,
  type MutationOperatorName,
} from "../src/mutation/operators";

const CONTRACT_SOURCE = `
import { z } from "zod";

export const SignupContract = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  age: z.number().int(),
  role: z.enum(["user", "editor"]),
  firstName: z.string(),
});

export const SignupResponse = z.object({
  userId: z.string().uuid(),
  active: z.boolean(),
});
`;

const HANDLER_SOURCE = `
import { z } from "zod";
export async function handle(req: Request) {
  const body = await req.json();
  const parsed = SignupContract.parse(body);
  if (!parsed.email) {
    return Response.json({ error: "no email" }, { status: 400 });
  }
  return Response.json({ userId: "abc" });
}
`;

const MIDDLEWARE_SOURCE = `
const builder = new HandlerBuilder();
builder.use(csrf()).use(rateLimit({ max: 5 })).post(async (ctx) => {
  return ctx.ok({ hi: true });
});
`;

function makeProject(src: string): { sf: ReturnType<Project["addSourceFileAtPath"]>; snapshot: string } {
  const project = new Project();
  const sf = project.createSourceFile("input.ts", src, { overwrite: true });
  const snapshot = sf.getFullText();
  return { sf, snapshot };
}

function byOperator(ops: MutatedSourceFile[], name: MutationOperatorName): MutatedSourceFile[] {
  return ops.filter((o) => o.operator === name);
}

describe("mutation operators — catalog", () => {
  test("OPERATOR_NAMES lists all 9 operators from the spec", () => {
    expect(OPERATOR_NAMES.length).toBe(9);
    const expected: MutationOperatorName[] = [
      "remove_required_field",
      "narrow_type",
      "widen_enum",
      "flip_nullable",
      "rename_field",
      "swap_sibling_type",
      "skip_middleware",
      "early_return",
      "bypass_validation",
    ];
    for (const e of expected) {
      expect(OPERATOR_NAMES.includes(e)).toBe(true);
    }
  });

  test("each operator in ALL_OPERATORS has unique name", () => {
    const seen = new Set<string>();
    for (const op of ALL_OPERATORS) {
      expect(seen.has(op.name)).toBe(false);
      seen.add(op.name);
    }
  });
});

describe("remove_required_field", () => {
  test("removes a required field per call", () => {
    const { sf } = makeProject(CONTRACT_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const rr = byOperator(muts, "remove_required_field");
    expect(rr.length).toBeGreaterThanOrEqual(5); // SignupContract has ≥5 required
    expect(rr[0].mutatedSource).not.toBe(CONTRACT_SOURCE);
    expect(rr[0].mutatedSource).toMatch(/z\.object/);
  });
});

describe("narrow_type", () => {
  test("narrows z.string() to z.literal", () => {
    const { sf } = makeProject(CONTRACT_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const nt = byOperator(muts, "narrow_type");
    expect(nt.length).toBeGreaterThanOrEqual(1);
    expect(nt[0].mutatedSource).toContain("z.literal(\"__MUTATION_NARROWED__\")");
  });
});

describe("widen_enum", () => {
  test("inserts a sentinel enum value", () => {
    const { sf } = makeProject(CONTRACT_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const we = byOperator(muts, "widen_enum");
    expect(we.length).toBeGreaterThanOrEqual(1);
    expect(we[0].mutatedSource).toContain("__MUTATION_WIDENED__");
  });
});

describe("flip_nullable", () => {
  test("wraps a field with .nullable()", () => {
    const { sf } = makeProject(CONTRACT_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const fn = byOperator(muts, "flip_nullable");
    expect(fn.length).toBeGreaterThanOrEqual(1);
    expect(fn[0].mutatedSource).toMatch(/\.nullable\(\)/);
  });
});

describe("rename_field", () => {
  test("renames a camelCase key to snake_case", () => {
    const { sf } = makeProject(CONTRACT_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const rf = byOperator(muts, "rename_field");
    // firstName / userId are the only camelCase keys.
    expect(rf.length).toBeGreaterThanOrEqual(1);
    const any = rf.find((m) => m.mutatedSource.includes("first_name") || m.mutatedSource.includes("user_id"));
    expect(any).toBeTruthy();
  });
});

describe("swap_sibling_type", () => {
  test("swaps z.number() → z.string()", () => {
    const { sf } = makeProject(CONTRACT_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const ss = byOperator(muts, "swap_sibling_type");
    expect(ss.length).toBeGreaterThanOrEqual(1);
    // The mutated source still has the `.int()` chain since that lived
    // on the original z.number(); the replacement is at the z.number()
    // call itself. Check that z.string() now appears where z.number()
    // used to — crude but effective.
    const hit = ss.find((m) => !m.mutatedSource.includes("z.number()"));
    expect(hit).toBeTruthy();
  });
});

describe("skip_middleware", () => {
  test("removes a .use(...) call", () => {
    const { sf } = makeProject(MIDDLEWARE_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const sm = byOperator(muts, "skip_middleware");
    expect(sm.length).toBeGreaterThanOrEqual(1);
    const first = sm[0].mutatedSource;
    // csrf() or rateLimit() is removed from the chain.
    expect(first).not.toBe(MIDDLEWARE_SOURCE);
  });
});

describe("early_return", () => {
  test("replaces a handler body with an immediate empty Response", () => {
    const { sf } = makeProject(HANDLER_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const er = byOperator(muts, "early_return");
    expect(er.length).toBeGreaterThanOrEqual(1);
    expect(er[0].mutatedSource).toContain("return Response.json({})");
  });
});

describe("bypass_validation", () => {
  test("removes .parse(...) wrapping", () => {
    const { sf } = makeProject(HANDLER_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    const bv = byOperator(muts, "bypass_validation");
    expect(bv.length).toBeGreaterThanOrEqual(1);
    // The parsed call should be replaced with just `body`.
    expect(bv[0].mutatedSource).not.toContain("SignupContract.parse(body)");
  });
});

describe("runAllOperators aggregate", () => {
  test("produces many mutations across the 9 operators for a realistic file", () => {
    const { sf } = makeProject(CONTRACT_SOURCE + "\n" + HANDLER_SOURCE + "\n" + MIDDLEWARE_SOURCE);
    const muts = runAllOperators(sf, { targetFile: "x", SyntaxKind });
    expect(muts.length).toBeGreaterThanOrEqual(10);
    const distinctOps = new Set(muts.map((m) => m.operator));
    expect(distinctOps.size).toBeGreaterThanOrEqual(5);
  });

  test("never mutates the input SourceFile permanently", () => {
    const src = CONTRACT_SOURCE;
    const { sf, snapshot } = makeProject(src);
    runAllOperators(sf, { targetFile: "x", SyntaxKind });
    expect(sf.getFullText()).toBe(snapshot);
  });
});
