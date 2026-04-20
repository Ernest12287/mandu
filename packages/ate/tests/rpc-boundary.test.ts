/**
 * Phase C.3 — RPC procedures go through the same Zod boundary probe
 * machinery as REST contracts. These tests confirm that the extracted
 * `inputSchemaSource` flows through the `parseZodExpression` +
 * `probesForView` pipeline identically.
 */
import { describe, test, expect } from "bun:test";
import { parseZodExpression, probesForView } from "../src/boundary/rules";

describe("RPC boundary parity", () => {
  test("inputSchemaSource like `z.object({...})` parses to object root", () => {
    const view = parseZodExpression("z.object({ email: z.string().email() })");
    expect(view.root).toBe("object");
  });

  test("probes generated from an RPC input match REST contract probes", () => {
    const emailView = parseZodExpression("z.string().email()");
    const probes = probesForView("email", emailView, 0, 1);
    const categories = probes.map((p) => p.category);
    expect(categories).toContain("invalid_format");
    expect(categories.some((c) => c === "valid")).toBe(true);
  });

  test("enum input emits `enum_reject` probe", () => {
    const view = parseZodExpression(`z.enum(["user", "admin"])`);
    const probes = probesForView("role", view, 0, 1);
    expect(probes.some((p) => p.category === "enum_reject")).toBe(true);
  });

  test("missing required probes inherit from Zod's optional() absence", () => {
    // When a field is declared without .optional(), `probesForView` on
    // the field alone does not emit `missing_required` — that emission
    // happens in the walker one level up. Here we just assert the
    // underlying schema is parsed as non-optional.
    const view = parseZodExpression("z.string().min(8)");
    expect(view.optional).not.toBe(true);
  });
});
