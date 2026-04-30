/**
 * Phase B.1 — Boundary probe orchestrator.
 *
 * Consumes a contract file, walks its request-body shape for the named
 * method (or every method), and returns the full boundary probe set
 * stamped with `graphVersion` + derived `expectedStatus`.
 *
 * Inputs accepted:
 *   - `generateProbes({ repoRoot, contractName })` — resolves the file
 *     from the repo's `*.contract.ts` index (by basename).
 *   - `generateProbes({ repoRoot, contractFile })` — direct path.
 *
 * Output shape mirrors docs/ate/phase-b-spec.md §B.1 MCP spec.
 *
 * Limits:
 *   - Default depth 1 (nested objects aren't recursed). Override via
 *     `depth`, capped at 3 (§B.10 Q1).
 *   - We parse source text — Zod runtime is never loaded (the contract
 *     file imports `@mandujs/core` which isn't resolvable from the
 *     ATE worker).
 */
import { readFileSync, existsSync } from "node:fs";
import { relative } from "node:path";
import fg from "fast-glob";
import { parseZodExpression, probesForView, dedupProbes } from "./rules";
import type { BoundaryProbe, ProbeCategory, ZodTypeView } from "./rules";
import { graphVersionFromGraph } from "../graph-version";
import type { InteractionGraph } from "../types";
import { getAtePaths, fileExists } from "../fs";

export type { BoundaryProbe, ProbeCategory, ZodTypeView } from "./rules";
export { parseZodExpression, probesForView, dedupProbes } from "./rules";

export interface GenerateProbesInput {
  repoRoot: string;
  /** Contract file basename (without `.contract.ts`) or full name. */
  contractName?: string;
  /** Explicit absolute path — bypasses repo scan. */
  contractFile?: string;
  /** HTTP method filter; omitted = every declared method. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Nested object depth, default 1, max 3. */
  depth?: number;
}

export interface GenerateProbesResult {
  contractName: string;
  contractFile: string;
  graphVersion: string;
  probes: Array<
    BoundaryProbe & {
      method: string;
      expectedStatus: number | null;
    }
  >;
  /** Warnings — e.g. "method not declared in contract". */
  warnings: string[];
}

const MAX_DEPTH = 3;

/**
 * Main entrypoint — the `mandu_ate_boundary_probe` MCP tool wraps this.
 */
export async function generateProbes(input: GenerateProbesInput): Promise<GenerateProbesResult> {
  const repoRoot = input.repoRoot;
  const depth = Math.min(Math.max(0, input.depth ?? 1), MAX_DEPTH);
  const warnings: string[] = [];

  // 1. Resolve the contract file path.
  const contractFile = resolveContractFile(repoRoot, input);
  if (!contractFile) {
    return {
      contractName: input.contractName ?? "",
      contractFile: "",
      graphVersion: loadGraphVersion(repoRoot),
      probes: [],
      warnings: [`No contract file resolved for ${input.contractName ?? input.contractFile ?? "<unknown>"}`],
    };
  }

  const source = readFileSync(contractFile, "utf8");
  const contractName = input.contractName ?? deriveContractName(contractFile);

  // 2. Walk declared request methods.
  const requestBlock = extractNamedBlock(source, "request");
  const responseBlock = extractNamedBlock(source, "response");
  const responseStatuses = responseBlock ? collectResponseStatuses(responseBlock) : new Set<number>();

  const methods = extractMethodBlocks(requestBlock ?? "");
  const filteredMethods = input.method ? methods.filter((m) => m.method === input.method) : methods;
  if (input.method && filteredMethods.length === 0) {
    warnings.push(`Method ${input.method} not declared in contract ${contractName}`);
  }

  const probes: GenerateProbesResult["probes"] = [];

  for (const m of filteredMethods) {
    // Body probes.
    const bodyBlock = extractBodyObjectSource(m.block);
    if (bodyBlock) {
      const rawProbes = walkObjectForProbes("", bodyBlock, depth, 0);
      for (const p of rawProbes) {
        probes.push({
          ...p,
          method: m.method,
          expectedStatus: deriveExpectedStatus(p.category, responseStatuses),
        });
      }
    } else if (m.method !== "DELETE") {
      warnings.push(`No body schema found for ${m.method} in ${contractName}`);
    }
  }

  // Dedup across the aggregated set.
  const deduped = dedupWithMeta(probes);

  return {
    contractName,
    contractFile: relative(repoRoot, contractFile).replace(/\\/g, "/"),
    graphVersion: loadGraphVersion(repoRoot),
    probes: deduped,
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Response status derivation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map a probe category to the expected HTTP status based on the
 * response codes the contract actually declares. When no obvious
 * mapping exists the function returns `null` (per §B.1 rules) so
 * the caller can surface that and let the agent pick.
 */
export function deriveExpectedStatus(
  category: ProbeCategory,
  declared: Set<number>,
): number | null {
  const has = (n: number) => declared.has(n);
  switch (category) {
    case "valid":
      // Prefer 200 → 201 → first 2xx. 204 is also acceptable if present.
      if (has(200)) return 200;
      if (has(201)) return 201;
      if (has(204)) return 204;
      for (const s of declared) if (s >= 200 && s < 300) return s;
      return null;
    case "invalid_format":
    case "boundary_min":
    case "boundary_max":
    case "empty":
    case "enum_reject":
    case "missing_required":
      if (has(422)) return 422;
      if (has(400)) return 400;
      for (const s of declared) if (s >= 400 && s < 500) return s;
      return null;
    case "type_mismatch":
      if (has(400)) return 400;
      if (has(422)) return 422;
      return null;
    case "null":
      if (has(400)) return 400;
      if (has(422)) return 422;
      return null;
    default:
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Source walkers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Extract the source of a named top-level contract key: `request`
 * or `response`. The returned string is the inside of the `{...}`
 * (balanced braces). Returns null if the key is absent.
 */
function extractNamedBlock(source: string, keyName: string): string | null {
  const re = new RegExp(`\\b${keyName}\\s*:\\s*\\{`);
  const m = re.exec(source);
  if (!m) return null;
  const openIdx = source.indexOf("{", m.index);
  return extractBalanced(source, openIdx, "{", "}");
}

function collectResponseStatuses(block: string): Set<number> {
  const out = new Set<number>();
  const re = /(\d{3})\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 599) out.add(n);
  }
  return out;
}

interface MethodBlock {
  method: string;
  /** Source of the method's `{...}` contents. */
  block: string;
}

function extractMethodBlocks(requestBlock: string): MethodBlock[] {
  if (!requestBlock) return [];
  const out: MethodBlock[] = [];
  const re = /\b(GET|POST|PUT|PATCH|DELETE)\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(requestBlock)) !== null) {
    const openIdx = requestBlock.indexOf("{", m.index + m[0].length - 1);
    const inner = extractBalanced(requestBlock, openIdx, "{", "}");
    if (inner !== null) out.push({ method: m[1], block: inner });
  }
  return out;
}

/**
 * Given the inner source of a method block (e.g. `{ body: z.object({...}) }`),
 * return the source of the `z.object({...})` that sits behind `body:`.
 * Returns the inside of its object (ready for `walkObjectForProbes`).
 */
function extractBodyObjectSource(methodBlock: string): string | null {
  const re = /\bbody\s*:\s*z\s*\.\s*object\s*\(\s*\{/;
  const m = re.exec(methodBlock);
  if (!m) return null;
  const openIdx = methodBlock.indexOf("{", m.index + m[0].length - 1);
  return extractBalanced(methodBlock, openIdx, "{", "}");
}

/**
 * Walk `{ key: zExpr, ... }` and emit probes for each key. `parentPath`
 * controls the dotted field prefix — empty at root, e.g. "user" when
 * recursing into a nested `user: z.object({...})`.
 */
function walkObjectForProbes(
  parentPath: string,
  inner: string,
  maxDepth: number,
  depth: number,
): BoundaryProbe[] {
  const out: BoundaryProbe[] = [];
  const fields = splitObjectFields(inner);
  // Track required fields so we emit "missing_required" probes.
  const requiredFields: Array<{ name: string; view: ZodTypeView }> = [];

  for (const f of fields) {
    const fieldName = parentPath ? `${parentPath}.${f.name}` : f.name;
    const view = parseZodExpression(f.expr);

    if (view.root === "object" && depth < maxDepth) {
      // Recurse into a nested object schema.
      const nestedInner = extractFirstCallArgsInner(f.expr, "object");
      if (nestedInner !== null) {
        out.push(...walkObjectForProbes(fieldName, nestedInner, maxDepth, depth + 1));
      }
    } else {
      out.push(...probesForView(fieldName, view, depth, maxDepth));
    }

    if (!view.optional) {
      requiredFields.push({ name: f.name, view });
    }
  }

  // Emit one `missing_required` probe per required field at this level.
  for (const req of requiredFields) {
    const fieldName = parentPath ? `${parentPath}.${req.name}` : req.name;
    out.push({
      field: fieldName,
      category: "missing_required",
      value: undefined,
      reason: `required field absent: contract declares ${req.name} without .optional()`,
    });
  }

  return out;
}

/** Helper — return the inside of the first `fn(...)` call as source text. */
function extractFirstCallArgsInner(src: string, fn: string): string | null {
  const re = new RegExp(`\\b${fn}\\s*\\(\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const openIdx = src.indexOf("{", m.index);
  return extractBalanced(src, openIdx, "{", "}");
}

interface ObjectField {
  name: string;
  expr: string;
}

/**
 * Split `{ a: z.string(), b: z.number().min(0) }` inner source into
 * `[{ name: "a", expr: "z.string()" }, ...]`. Handles balanced parens
 * / braces / brackets inside expressions.
 */
function splitObjectFields(inner: string): ObjectField[] {
  const out: ObjectField[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i++;
    if (i >= inner.length) break;

    // Match key (identifier OR quoted).
    const rest = inner.slice(i);
    const keyMatch =
      rest.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/) ||
      rest.match(/^['"]([^'"]+)['"]\s*:/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const name = keyMatch[1];
    i += keyMatch[0].length;

    // Capture the value expression up to the next top-level comma.
    let depth = 0;
    const start = i;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) break;
      i++;
    }
    const expr = inner.slice(start, i).trim();
    if (expr) out.push({ name, expr });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// misc
// ──────────────────────────────────────────────────────────────────────────

function dedupWithMeta(
  probes: GenerateProbesResult["probes"],
): GenerateProbesResult["probes"] {
  const bare = dedupProbes(
    probes.map((p) => ({
      field: p.field,
      category: p.category,
      value: p.value,
      reason: p.reason,
    })),
  );
  // Re-attach method / expectedStatus by (field, category, value) index.
  const byKey = new Map<string, (typeof probes)[number]>();
  for (const p of probes) {
    const key = probeKey(p);
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return bare.map((b) => {
    const key = probeKey(b);
    const meta = byKey.get(key);
    return {
      ...b,
      method: meta?.method ?? "POST",
      expectedStatus: meta?.expectedStatus ?? null,
    };
  });
}

function probeKey(p: { field: string; category: string; value: unknown }): string {
  return `${p.field}|${p.category}|${stableKeyValue(p.value)}`;
}

function stableKeyValue(v: unknown): string {
  if (v === undefined) return "__undefined__";
  if (typeof v === "number" && Number.isNaN(v)) return "__NaN__";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function loadGraphVersion(repoRoot: string): string {
  const paths = getAtePaths(repoRoot);
  if (!fileExists(paths.interactionGraphPath)) return "gv1:unknown";
  try {
    const content = readFileSync(paths.interactionGraphPath, "utf8");
    const graph = JSON.parse(content) as InteractionGraph;
    return graphVersionFromGraph(graph);
  } catch {
    return "gv1:unknown";
  }
}

function resolveContractFile(
  repoRoot: string,
  input: GenerateProbesInput,
): string | null {
  if (input.contractFile) {
    return existsSync(input.contractFile) ? input.contractFile : null;
  }
  if (!input.contractName) return null;
  const files = fg.sync(["**/*.contract.ts", "**/*.contract.tsx"], {
    cwd: repoRoot,
    absolute: true,
    ignore: ["**/node_modules/**", "**/.mandu/**", "**/dist/**"],
  });
  // Match by basename without extension, or by contract default-export
  // identifier if present in source.
  const want = normalizeName(input.contractName);
  for (const abs of files) {
    const base = normalizeName(abs.replace(/\\/g, "/").split("/").pop() ?? "");
    if (base === want) return abs;
    // Also check source — contracts often name themselves via comments.
    try {
      const src = readFileSync(abs, "utf8");
      if (new RegExp(`\\b${escapeRegex(input.contractName)}\\b`).test(src)) return abs;
    } catch {
      // ignore
    }
  }
  return null;
}

function normalizeName(s: string): string {
  return s
    .replace(/\.contract\.(ts|tsx)$/i, "")
    .replace(/[-_\s]/g, "")
    .toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveContractName(contractFile: string): string {
  const base = contractFile.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.contract\.(ts|tsx)$/i, "");
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
