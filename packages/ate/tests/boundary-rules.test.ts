/**
 * Phase B.1 — boundary rules unit tests.
 *
 * One test per Zod type row in docs/ate/phase-b-spec.md §B.1 table.
 */
import { describe, test, expect } from "bun:test";
import {
  parseZodExpression,
  probesForView,
  probesForString,
  probesForNumber,
  probesForBoolean,
  probesForEnum,
  probesForLiteral,
  probesForArray,
  probesForUnion,
  dedupProbes,
} from "../src/boundary/rules";

describe("parseZodExpression — root detection", () => {
  test("z.string() → root string", () => {
    expect(parseZodExpression("z.string()").root).toBe("string");
  });
  test("z.number() → root number", () => {
    expect(parseZodExpression("z.number()").root).toBe("number");
  });
  test("z.boolean() → root boolean", () => {
    expect(parseZodExpression("z.boolean()").root).toBe("boolean");
  });
  test("z.array(z.string()) → root array + element string", () => {
    const v = parseZodExpression("z.array(z.string())");
    expect(v.root).toBe("array");
    expect(v.constraints.element?.root).toBe("string");
  });
  test("z.object({}) → root object", () => {
    expect(parseZodExpression("z.object({ a: z.string() })").root).toBe("object");
  });
  test("z.enum([...]) → root enum + values", () => {
    const v = parseZodExpression("z.enum(['a','b'])");
    expect(v.root).toBe("enum");
    expect(v.constraints.enumValues).toEqual(["a", "b"]);
  });
  test("z.literal('x') → root literal + value", () => {
    const v = parseZodExpression("z.literal('x')");
    expect(v.root).toBe("literal");
    expect(v.constraints.literalValue).toBe("x");
  });
  test("z.literal(42) → root literal + numeric value", () => {
    const v = parseZodExpression("z.literal(42)");
    expect(v.constraints.literalValue).toBe(42);
  });
  test("z.union([z.string(), z.number()]) → root union + members", () => {
    const v = parseZodExpression("z.union([z.string(), z.number()])");
    expect(v.root).toBe("union");
    expect(v.constraints.unionMembers?.length).toBe(2);
  });
  test("z.int() → number with int constraint", () => {
    const v = parseZodExpression("z.int()");
    expect(v.root).toBe("number");
    expect(v.constraints.int).toBe(true);
  });
});

describe("parseZodExpression — chained constraints", () => {
  test(".min(N) captured", () => {
    expect(parseZodExpression("z.string().min(5)").constraints.min).toBe(5);
  });
  test(".max(N) captured", () => {
    expect(parseZodExpression("z.string().max(100)").constraints.max).toBe(100);
  });
  test(".email() flagged", () => {
    expect(parseZodExpression("z.string().email()").constraints.email).toBe(true);
  });
  test(".uuid() flagged", () => {
    expect(parseZodExpression("z.string().uuid()").constraints.uuid).toBe(true);
  });
  test(".int() flagged (chained)", () => {
    expect(parseZodExpression("z.number().int().min(0)").constraints.int).toBe(true);
  });
  test(".regex(/^a/) captured", () => {
    const v = parseZodExpression("z.string().regex(/^a+$/)");
    expect(typeof v.constraints.regex).toBe("string");
  });
  test(".optional() flagged", () => {
    expect(parseZodExpression("z.string().optional()").optional).toBe(true);
  });
  test(".nullable() flagged", () => {
    expect(parseZodExpression("z.string().nullable()").nullable).toBe(true);
  });
  test(".nullish() flags both", () => {
    const v = parseZodExpression("z.string().nullish()");
    expect(v.optional).toBe(true);
    expect(v.nullable).toBe(true);
  });
});

describe("probesForString — per table row", () => {
  test("z.string() emits empty + whitespace probes", () => {
    const v = parseZodExpression("z.string()");
    const probes = probesForString("name", v);
    expect(probes.some((p) => p.category === "empty" && p.value === "")).toBe(true);
    expect(probes.some((p) => p.value === " ")).toBe(true);
  });

  test("z.string().min(5) boundary probes", () => {
    const v = parseZodExpression("z.string().min(5)");
    const probes = probesForString("title", v);
    expect(probes.some((p) => p.category === "boundary_min" && typeof p.value === "string" && p.value.length === 4)).toBe(true);
    expect(probes.some((p) => p.category === "valid" && typeof p.value === "string" && p.value.length === 5)).toBe(true);
  });

  test("z.string().max(10) boundary probes", () => {
    const v = parseZodExpression("z.string().max(10)");
    const probes = probesForString("title", v);
    expect(probes.some((p) => p.category === "boundary_max" && typeof p.value === "string" && p.value.length === 11)).toBe(true);
  });

  test("z.string().email() emits the email set", () => {
    const v = parseZodExpression("z.string().email()");
    const probes = probesForString("email", v);
    expect(probes.some((p) => p.value === "valid@example.com" && p.category === "valid")).toBe(true);
    expect(probes.some((p) => p.value === "not-an-email")).toBe(true);
    expect(probes.some((p) => p.value === "@b.com")).toBe(true);
    expect(probes.some((p) => p.value === "a@")).toBe(true);
    expect(probes.some((p) => p.category === "empty" && p.value === "")).toBe(true);
  });

  test("z.string().uuid() emits v4 + v7 + fail cases", () => {
    const v = parseZodExpression("z.string().uuid()");
    const probes = probesForString("id", v);
    expect(probes.filter((p) => p.category === "valid").length).toBeGreaterThanOrEqual(2);
    expect(probes.some((p) => p.value === "not-a-uuid")).toBe(true);
  });

  test("z.string().regex(re) emits __invalid__", () => {
    const v = parseZodExpression("z.string().regex(/^a+$/)");
    const probes = probesForString("tag", v);
    expect(probes.some((p) => p.value === "__invalid__")).toBe(true);
  });
});

describe("probesForNumber", () => {
  test("z.number() emits 0/-1/overflow/NaN", () => {
    const v = parseZodExpression("z.number()");
    const probes = probesForNumber("age", v);
    expect(probes.some((p) => p.value === 0)).toBe(true);
    expect(probes.some((p) => p.value === -1)).toBe(true);
    expect(probes.some((p) => p.category === "type_mismatch" && Number.isNaN(p.value as number))).toBe(true);
    expect(probes.some((p) => p.value === "42" && p.category === "type_mismatch")).toBe(true);
  });

  test("z.number().int() flags non-integer violations", () => {
    const v = parseZodExpression("z.number().int()");
    const probes = probesForNumber("count", v);
    expect(probes.some((p) => p.value === 1.5)).toBe(true);
  });

  test("z.number().min(0).max(120) boundary probes", () => {
    const v = parseZodExpression("z.number().min(0).max(120)");
    const probes = probesForNumber("age", v);
    expect(probes.some((p) => p.value === -1 && p.category === "boundary_min")).toBe(true);
    expect(probes.some((p) => p.value === 0 && p.category === "valid")).toBe(true);
    expect(probes.some((p) => p.value === 120 && p.category === "valid")).toBe(true);
    expect(probes.some((p) => p.value === 121 && p.category === "boundary_max")).toBe(true);
  });
});

describe("probesForBoolean / Enum / Literal / Array / Union", () => {
  test("boolean emits all 4 rows", () => {
    const v = parseZodExpression("z.boolean()");
    const probes = probesForBoolean("active", v);
    expect(probes.find((p) => p.value === true && p.category === "valid")).toBeDefined();
    expect(probes.find((p) => p.value === "true" && p.category === "type_mismatch")).toBeDefined();
  });

  test("enum emits every valid + __not_in_enum__ + null", () => {
    const v = parseZodExpression("z.enum(['a','b','c'])");
    const probes = probesForEnum("role", v);
    expect(probes.filter((p) => p.category === "valid").length).toBe(3);
    expect(probes.some((p) => p.value === "__not_in_enum__")).toBe(true);
    expect(probes.some((p) => p.value === null && p.category === "null")).toBe(true);
  });

  test("literal('x') emits pass + fail", () => {
    const v = parseZodExpression("z.literal('x')");
    const probes = probesForLiteral("kind", v);
    expect(probes.some((p) => p.value === "x" && p.category === "valid")).toBe(true);
    expect(probes.some((p) => p.value === "x_")).toBe(true);
  });

  test("array emits empty + [valid] + null", () => {
    const v = parseZodExpression("z.array(z.string())");
    const probes = probesForArray("tags", v, 0, 1);
    expect(probes.some((p) => Array.isArray(p.value) && (p.value as unknown[]).length === 0)).toBe(true);
    expect(probes.some((p) => p.value === null && p.category === "null")).toBe(true);
  });

  test("union(string|number) rejects boolean", () => {
    const v = parseZodExpression("z.union([z.string(), z.number()])");
    const probes = probesForUnion("q", v);
    expect(probes.some((p) => p.value === true && p.category === "type_mismatch")).toBe(true);
  });
});

describe("probesForView — optional / nullable envelope", () => {
  test(".optional() adds undefined-valid probe", () => {
    const v = parseZodExpression("z.string().optional()");
    const probes = probesForView("x", v);
    expect(probes.some((p) => p.value === undefined && p.category === "valid")).toBe(true);
  });

  test(".nullable() converts null from fail to valid", () => {
    const v = parseZodExpression("z.array(z.string()).nullable()");
    const probes = probesForView("xs", v, 0, 1);
    // With .nullable(), the null should appear as valid and NOT as a "null" fail.
    expect(probes.some((p) => p.value === null && p.category === "valid")).toBe(true);
    expect(probes.some((p) => p.value === null && p.category === "null")).toBe(false);
  });
});

describe("dedupProbes — same category + same value collapses", () => {
  test("duplicate email-pass probe merged", () => {
    const input = [
      { field: "email", category: "valid" as const, value: "a@b.com", reason: "r1" },
      { field: "email", category: "valid" as const, value: "a@b.com", reason: "r2" },
      { field: "email", category: "empty" as const, value: "", reason: "r3" },
    ];
    const out = dedupProbes(input);
    expect(out.length).toBe(2);
    expect(out[0].reason).toBe("r1");
  });

  test("different categories with same value do NOT merge", () => {
    const input = [
      { field: "f", category: "valid" as const, value: "", reason: "r1" },
      { field: "f", category: "empty" as const, value: "", reason: "r2" },
    ];
    expect(dedupProbes(input).length).toBe(2);
  });
});
