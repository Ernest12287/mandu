/**
 * Phase B.1 — Zod type → boundary probe generators.
 *
 * Pure functions. No I/O. No LLM. Given a parsed Zod expression string
 * (e.g. `z.string().email()` or `z.number().int().min(0).max(120)`), return
 * a deterministic set of boundary probes. Each probe is the kind of value
 * an LLM-written `fast-check` property OR a hand-written `bun:test` case
 * would want to hit against the contract.
 *
 * See docs/ate/phase-b-spec.md §B.1 "Zod Type → Boundary 매핑" — the 18-row
 * table is what this module implements.
 *
 * Design decisions:
 *   - We parse Zod expression strings at SOURCE level (not runtime). Contract
 *     files import @mandujs/core and other modules that aren't resolvable
 *     from the ATE worker; regex + controlled balanced-paren walk is
 *     sufficient for the patterns we care about (see `contract-parser.ts`
 *     for precedent).
 *   - Category is one of 9 fixed tags (see `ProbeCategory`). This is the
 *     primary dedup key — same category + same value collapses (§B.10 Q2).
 *   - expectedStatus derivation is NOT this module's job. The orchestrator
 *     (`boundary/index.ts`) scans the contract response section and maps
 *     category → status.
 *   - Probe generation is **greedy**: we emit one representative per
 *     category. We do not generate a full fast-check arbitrary set —
 *     that's what the `property_based.v1` prompt teaches the LLM to do
 *     with probes as input.
 */

export type ProbeCategory =
  | "valid"
  | "invalid_format"
  | "boundary_min"
  | "boundary_max"
  | "empty"
  | "null"
  | "type_mismatch"
  | "enum_reject"
  | "missing_required";

export interface BoundaryProbe {
  /** Dotted field path: "email" | "user.age" | "items[].price". */
  field: string;
  category: ProbeCategory;
  value: unknown;
  reason: string;
}

/**
 * A Zod "type view" is a lightweight AST captured at source-parse time.
 * We care about the root type + the chained constraints (`.min`, `.max`,
 * `.email`, etc.) and whether the field is optional / nullable.
 */
export interface ZodTypeView {
  /**
   * Canonical root type. `union` and `literal` are special-cased below.
   * `unknown` is the escape hatch when the parser can't classify — the
   * orchestrator falls back to `{ category: "type_mismatch" }` probes.
   */
  root:
    | "string"
    | "number"
    | "boolean"
    | "array"
    | "object"
    | "enum"
    | "union"
    | "literal"
    | "unknown";
  /** True if `.optional()` or `.nullish()` appears on the chain. */
  optional: boolean;
  /** True if `.nullable()` or `.nullish()` appears on the chain. */
  nullable: boolean;
  /** Constraints collected from the chain. */
  constraints: {
    min?: number;
    max?: number;
    int?: boolean;
    email?: boolean;
    uuid?: boolean;
    regex?: string;
    /** Enum values captured from `z.enum([...])`. */
    enumValues?: string[];
    /** Literal captured from `z.literal(...)`. */
    literalValue?: string | number | boolean;
    /** Union member views (best-effort — each is a shallow parse). */
    unionMembers?: ZodTypeView[];
    /** Element type for `z.array(T)`. */
    element?: ZodTypeView;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Expression parser
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a Zod expression source snippet (e.g. `z.string().min(5).email()`)
 * into a `ZodTypeView`. This is a best-effort regex + balanced-paren walk,
 * NOT a full Zod runtime. When the expression is too complex the root is
 * returned as `"unknown"` with `optional/nullable` flags still detected.
 *
 * Exported for testability.
 */
export function parseZodExpression(expr: string): ZodTypeView {
  const trimmed = expr.trim();
  const view: ZodTypeView = {
    root: "unknown",
    optional: /\.optional\s*\(/.test(trimmed) || /\.nullish\s*\(/.test(trimmed),
    nullable: /\.nullable\s*\(/.test(trimmed) || /\.nullish\s*\(/.test(trimmed),
    constraints: {},
  };

  // Root type detection — the first `z.X` or `.X(` following the initial z.
  const rootMatch = trimmed.match(
    /z\s*\.\s*(string|number|boolean|array|object|enum|union|literal|int|bigint|date|any|unknown)\b/,
  );
  if (rootMatch) {
    const tok = rootMatch[1];
    switch (tok) {
      case "string":
      case "number":
      case "boolean":
      case "array":
      case "object":
      case "enum":
      case "union":
      case "literal":
        view.root = tok;
        break;
      case "int":
      case "bigint":
        view.root = "number";
        view.constraints.int = true;
        break;
      default:
        view.root = "unknown";
    }
  }

  // .min(N) / .max(N) — numeric constraints (shared by string length + number).
  const minMatch = trimmed.match(/\.min\s*\(\s*(-?\d+(?:\.\d+)?)/);
  if (minMatch) view.constraints.min = Number(minMatch[1]);
  const maxMatch = trimmed.match(/\.max\s*\(\s*(-?\d+(?:\.\d+)?)/);
  if (maxMatch) view.constraints.max = Number(maxMatch[1]);

  // .int()
  if (/\.int\s*\(/.test(trimmed)) view.constraints.int = true;

  // .email()
  if (/\.email\s*\(/.test(trimmed)) view.constraints.email = true;
  // .uuid()
  if (/\.uuid\s*\(/.test(trimmed)) view.constraints.uuid = true;

  // .regex(/.../)
  const regexMatch = trimmed.match(/\.regex\s*\(\s*\/([^/]+)\//);
  if (regexMatch) view.constraints.regex = regexMatch[1];

  // z.enum([...])
  if (view.root === "enum") {
    const enumArgs = extractFirstCallArgs(trimmed, "enum");
    if (enumArgs) {
      const arr = extractBalanced(enumArgs, 0, "[", "]");
      if (arr !== null) {
        const values: string[] = [];
        const re = /['"`]([^'"`]+)['"`]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(arr)) !== null) values.push(m[1]);
        if (values.length > 0) view.constraints.enumValues = values;
      }
    }
  }

  // z.literal(...)
  if (view.root === "literal") {
    const litArgs = extractFirstCallArgs(trimmed, "literal");
    if (litArgs) {
      const s = litArgs.trim();
      const strMatch = s.match(/^['"`]([^'"`]*)['"`]$/);
      if (strMatch) {
        view.constraints.literalValue = strMatch[1];
      } else if (/^(true|false)$/.test(s)) {
        view.constraints.literalValue = s === "true";
      } else if (/^-?\d+(?:\.\d+)?$/.test(s)) {
        view.constraints.literalValue = Number(s);
      }
    }
  }

  // z.array(T) — capture element type
  if (view.root === "array") {
    const arrArgs = extractFirstCallArgs(trimmed, "array");
    if (arrArgs) {
      view.constraints.element = parseZodExpression(arrArgs);
    }
  }

  // z.union([A, B, ...]) — capture member views (shallow, first 3).
  if (view.root === "union") {
    const unionArgs = extractFirstCallArgs(trimmed, "union");
    if (unionArgs) {
      const arr = extractBalanced(unionArgs, 0, "[", "]");
      if (arr !== null) {
        const members: ZodTypeView[] = [];
        // Split by top-level commas.
        let depth = 0;
        let start = 0;
        for (let i = 0; i <= arr.length; i++) {
          const ch = arr[i];
          if (ch === "(" || ch === "{" || ch === "[") depth++;
          else if (ch === ")" || ch === "}" || ch === "]") depth--;
          if ((ch === "," && depth === 0) || i === arr.length) {
            const member = arr.slice(start, i).trim();
            if (member) members.push(parseZodExpression(member));
            start = i + 1;
            if (members.length >= 3) break;
          }
        }
        if (members.length > 0) view.constraints.unionMembers = members;
      }
    }
  }

  return view;
}

function extractFirstCallArgs(src: string, fn: string): string | null {
  // Find `fn(` (with optional whitespace), then balanced-match to the `)`.
  const re = new RegExp(`\\b${fn}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const openIdx = src.indexOf("(", m.index);
  const inner = extractBalanced(src, openIdx, "(", ")");
  return inner;
}

function extractBalanced(src: string, start: number, open: string, close: string): string | null {
  if (src[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Probe generators — per Zod type
// ──────────────────────────────────────────────────────────────────────────

/** 10001-char string — the "obvious overflow" case. */
const OVERFLOW_STRING = "a".repeat(10001);

/** Placeholder for a deterministic valid UUID (v4). */
const VALID_UUID_V4 = "550e8400-e29b-41d4-a716-446655440000";
/** Placeholder for a deterministic valid UUID (v7 — first-octet 7). */
const VALID_UUID_V7 = "01890000-0000-7000-8000-000000000000";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export function probesForString(field: string, view: ZodTypeView): BoundaryProbe[] {
  const out: BoundaryProbe[] = [];
  const c = view.constraints;

  // Format probes (email / uuid / regex) — specialized, take priority.
  if (c.email) {
    out.push(
      { field, category: "valid", value: "valid@example.com", reason: "email pass: well-formed address" },
      { field, category: "invalid_format", value: "not-an-email", reason: "email fail: missing '@'" },
      { field, category: "invalid_format", value: "@b.com", reason: "email fail: missing local-part" },
      { field, category: "invalid_format", value: "a@", reason: "email fail: missing domain" },
      { field, category: "empty", value: "", reason: "email fail: empty string" },
    );
    return out;
  }

  if (c.uuid) {
    out.push(
      { field, category: "valid", value: VALID_UUID_V4, reason: "uuid pass: v4 canonical" },
      { field, category: "valid", value: VALID_UUID_V7, reason: "uuid pass: v7 canonical" },
      { field, category: "invalid_format", value: "not-a-uuid", reason: "uuid fail: non-hex string" },
      { field, category: "empty", value: "", reason: "uuid fail: empty string" },
      { field, category: "invalid_format", value: ZERO_UUID, reason: "uuid edge: all-zero (spec-invalid variant)" },
    );
    return out;
  }

  if (c.regex) {
    out.push(
      { field, category: "invalid_format", value: "__invalid__", reason: `regex fail: does not match /${c.regex}/` },
    );
    // Emit one probe-shaped valid hint — we can't synthesize a matching value
    // reliably, so leave it to fast-check (agent prompt handles it).
    return out;
  }

  // min/max length probes — string constraints interpreted as character length.
  if (typeof c.min === "number") {
    const n = c.min;
    out.push(
      { field, category: "boundary_min", value: "a".repeat(Math.max(0, n - 1)), reason: `string.min(${n}) boundary: length n-1` },
      { field, category: "valid", value: "a".repeat(n), reason: `string.min(${n}) boundary: length n exactly` },
    );
    if (n > 0) {
      out.push({ field, category: "empty", value: "", reason: `string.min(${n}) fail: empty string` });
    }
  } else {
    out.push({ field, category: "empty", value: "", reason: "string: empty (no min set)" });
  }

  if (typeof c.max === "number") {
    const n = c.max;
    out.push(
      { field, category: "valid", value: "a".repeat(n), reason: `string.max(${n}) boundary: length n exactly` },
      { field, category: "boundary_max", value: "a".repeat(n + 1), reason: `string.max(${n}) boundary: length n+1` },
    );
  } else {
    // No max — still emit a loud overflow probe so agents consider DoS class.
    out.push({ field, category: "boundary_max", value: OVERFLOW_STRING, reason: "string: 10001-char overflow (no max set)" });
  }

  // Generic whitespace probe — cheap, surfaces trim() regressions.
  if (!out.some((p) => p.category === "valid")) {
    out.push({ field, category: "valid", value: "ok", reason: "string: short representative value" });
  }
  out.push({ field, category: "invalid_format", value: " ", reason: "string: whitespace-only" });
  return out;
}

export function probesForNumber(field: string, view: ZodTypeView): BoundaryProbe[] {
  const out: BoundaryProbe[] = [];
  const c = view.constraints;

  if (typeof c.min === "number" && typeof c.max === "number") {
    const lo = c.min;
    const hi = c.max;
    out.push(
      { field, category: "boundary_min", value: lo - 1, reason: `number.min(${lo}) boundary: lo-1` },
      { field, category: "valid", value: lo, reason: `number.min(${lo}) boundary: lo exactly` },
      { field, category: "valid", value: hi, reason: `number.max(${hi}) boundary: hi exactly` },
      { field, category: "boundary_max", value: hi + 1, reason: `number.max(${hi}) boundary: hi+1` },
    );
  } else if (typeof c.min === "number") {
    out.push(
      { field, category: "boundary_min", value: c.min - 1, reason: `number.min(${c.min}) boundary: below` },
      { field, category: "valid", value: c.min, reason: `number.min(${c.min}) boundary: exactly` },
    );
  } else if (typeof c.max === "number") {
    out.push(
      { field, category: "valid", value: c.max, reason: `number.max(${c.max}) boundary: exactly` },
      { field, category: "boundary_max", value: c.max + 1, reason: `number.max(${c.max}) boundary: above` },
    );
  } else {
    out.push(
      { field, category: "valid", value: 0, reason: "number: zero" },
      { field, category: "boundary_min", value: -1, reason: "number: negative (no lower bound)" },
      { field, category: "boundary_max", value: Number.MAX_SAFE_INTEGER + 1, reason: "number: > MAX_SAFE_INTEGER" },
    );
  }

  if (c.int) {
    out.push(
      { field, category: "invalid_format", value: 1.5, reason: "number.int() fail: non-integer" },
      { field, category: "invalid_format", value: 0.0001, reason: "number.int() fail: near-zero fraction" },
    );
  }

  out.push(
    { field, category: "type_mismatch", value: NaN, reason: "number: NaN" },
    { field, category: "type_mismatch", value: "42", reason: "number: string coercion attempt" },
  );
  return out;
}

export function probesForBoolean(field: string, _view: ZodTypeView): BoundaryProbe[] {
  return [
    { field, category: "valid", value: true, reason: "boolean pass: true" },
    { field, category: "valid", value: false, reason: "boolean pass: false" },
    { field, category: "type_mismatch", value: "true", reason: "boolean fail: string-shaped" },
    { field, category: "type_mismatch", value: 1, reason: "boolean fail: number-shaped" },
  ];
}

export function probesForEnum(field: string, view: ZodTypeView): BoundaryProbe[] {
  const values = view.constraints.enumValues ?? [];
  const out: BoundaryProbe[] = values.map((v) => ({
    field,
    category: "valid",
    value: v,
    reason: `enum pass: "${v}"`,
  }));
  out.push(
    { field, category: "enum_reject", value: "__not_in_enum__", reason: "enum fail: unknown variant" },
    { field, category: "null", value: null, reason: "enum fail: null" },
  );
  return out;
}

export function probesForLiteral(field: string, view: ZodTypeView): BoundaryProbe[] {
  const v = view.constraints.literalValue;
  const out: BoundaryProbe[] = [];
  if (v === undefined) {
    return [
      { field, category: "invalid_format", value: "__literal_mismatch__", reason: "literal fail: could not parse literal — agent to fill" },
    ];
  }
  out.push({ field, category: "valid", value: v, reason: `literal pass: ${JSON.stringify(v)}` });
  if (typeof v === "string") {
    out.push({ field, category: "invalid_format", value: v + "_", reason: "literal fail: appended char" });
  } else if (typeof v === "number") {
    out.push({ field, category: "invalid_format", value: v + 1, reason: "literal fail: +1" });
  } else if (typeof v === "boolean") {
    out.push({ field, category: "invalid_format", value: !v, reason: "literal fail: negated" });
  }
  return out;
}

export function probesForArray(field: string, view: ZodTypeView, depth: number, maxDepth: number): BoundaryProbe[] {
  const out: BoundaryProbe[] = [];
  const c = view.constraints;

  out.push({ field, category: "valid", value: [], reason: "array pass: empty" });
  if (typeof c.min === "number" && c.min > 0) {
    out.push({ field, category: "boundary_min", value: [], reason: `array.min(${c.min}) fail: fewer than required` });
  }

  // One-element valid/invalid based on element type.
  if (c.element && depth < maxDepth) {
    const elementName = `${field}[]`;
    const elementProbes = probesForView(elementName, c.element, depth + 1, maxDepth);
    const validEl = elementProbes.find((p) => p.category === "valid");
    const invalidEl = elementProbes.find((p) => p.category !== "valid" && p.category !== "missing_required");
    if (validEl !== undefined) {
      out.push({
        field,
        category: "valid",
        value: [validEl.value],
        reason: `array pass: [valid element]`,
      });
    }
    if (invalidEl !== undefined) {
      out.push({
        field,
        category: "type_mismatch",
        value: [invalidEl.value],
        reason: `array fail: [invalid element of kind ${c.element.root}]`,
      });
    }
  } else {
    out.push({ field, category: "valid", value: ["item"], reason: "array pass: single string item" });
  }

  out.push({ field, category: "null", value: null, reason: "array fail: null" });
  return out;
}

export function probesForUnion(field: string, view: ZodTypeView): BoundaryProbe[] {
  const out: BoundaryProbe[] = [];
  const members = view.constraints.unionMembers ?? [];
  for (const m of members.slice(0, 2)) {
    const sample = probesForView(field, m, 0, 0).find((p) => p.category === "valid");
    if (sample) {
      out.push({ ...sample, reason: `union pass: member ${m.root} (${sample.reason})` });
    }
  }
  // A value that should be rejected by every member — `true` is never string
  // or number, and only matches when the union explicitly lists boolean.
  const roots = new Set(members.map((m) => m.root));
  if (!roots.has("boolean")) {
    out.push({ field, category: "type_mismatch", value: true, reason: "union fail: boolean where no member accepts it" });
  } else if (!roots.has("number")) {
    out.push({ field, category: "type_mismatch", value: 42, reason: "union fail: number where no member accepts it" });
  } else {
    out.push({ field, category: "type_mismatch", value: Symbol("x").toString(), reason: "union fail: foreign symbol-str" });
  }
  return out;
}

/**
 * Dispatcher. Takes a parsed view and returns the category-representative
 * probe set for its root type, applying `optional/nullable` envelope.
 */
export function probesForView(
  field: string,
  view: ZodTypeView,
  depth = 0,
  maxDepth = 1,
): BoundaryProbe[] {
  let probes: BoundaryProbe[];
  switch (view.root) {
    case "string":
      probes = probesForString(field, view);
      break;
    case "number":
      probes = probesForNumber(field, view);
      break;
    case "boolean":
      probes = probesForBoolean(field, view);
      break;
    case "enum":
      probes = probesForEnum(field, view);
      break;
    case "literal":
      probes = probesForLiteral(field, view);
      break;
    case "array":
      probes = probesForArray(field, view, depth, maxDepth);
      break;
    case "union":
      probes = probesForUnion(field, view);
      break;
    case "object":
      // Object handled separately by the orchestrator since it recurses
      // into named children. We return a null probe here — the
      // orchestrator is expected to walk the children.
      probes = [
        { field, category: "null", value: null, reason: "object fail: null" },
      ];
      break;
    default:
      probes = [
        { field, category: "type_mismatch", value: null, reason: "unknown zod type — agent to refine" },
      ];
  }

  // Envelope handling — optional/nullable add their own probes.
  if (view.optional) {
    probes.push({ field, category: "valid", value: undefined, reason: "optional: undefined is allowed" });
  }
  if (view.nullable) {
    // If nullable, null becomes valid — overwrite any "null"-category fail probe.
    probes = probes.filter((p) => !(p.category === "null" && p.value === null));
    probes.push({ field, category: "valid", value: null, reason: "nullable: null is allowed" });
  }

  return probes;
}

// ──────────────────────────────────────────────────────────────────────────
// Dedup
// ──────────────────────────────────────────────────────────────────────────

/**
 * Collapse probes by (field, category, value). First occurrence wins.
 * Spec §B.10 Q2: same-category same-value probes collapse.
 */
export function dedupProbes(probes: BoundaryProbe[]): BoundaryProbe[] {
  const seen = new Set<string>();
  const out: BoundaryProbe[] = [];
  for (const p of probes) {
    const key = `${p.field}|${p.category}|${stableStringify(p.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function stableStringify(v: unknown): string {
  if (v === undefined) return "__undefined__";
  if (v === null) return "null";
  if (typeof v === "number" && Number.isNaN(v)) return "__NaN__";
  if (typeof v === "number" && !Number.isFinite(v)) return v > 0 ? "__Infinity__" : "__-Infinity__";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
