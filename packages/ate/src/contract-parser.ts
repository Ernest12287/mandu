/**
 * Contract parser — regex/source-level Zod schema detection for *.contract.ts files.
 *
 * Design notes:
 * - We do NOT execute Zod at extract time. The contract file imports @mandujs/core
 *   and other runtime dependencies that may not be resolvable from the ATE process.
 * - Instead, we parse the source text and extract a lightweight "shape" description
 *   that's sufficient to generate L2 Playwright assertions:
 *     - response status codes present in `response: { 200: ..., 201: ..., 400: ... }`
 *     - top-level response object keys (e.g. `z.object({ categories: z.array(...) })`
 *       → key "categories" of kind "array")
 *     - request body required string fields (for edge-case generation)
 */
import fg from "fast-glob";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type ZodFieldKind = "string" | "number" | "boolean" | "array" | "object" | "unknown";

export interface ContractField {
  name: string;
  kind: ZodFieldKind;
  optional: boolean;
  minLength?: number;
}

export interface ContractResponseShape {
  status: number;
  topLevelKeys: ContractField[];
}

export interface ContractRequestShape {
  method: string; // GET, POST, PUT, PATCH, DELETE
  bodyFields: ContractField[];
}

export interface ParsedContract {
  file: string;
  /** Route path inferred from file name, e.g. api-categories.contract.ts → /api/categories */
  inferredRoute: string;
  responses: ContractResponseShape[];
  requests: ContractRequestShape[];
}

/** Locate all *.contract.ts files in the repo. */
export function findContractFiles(repoRoot: string): string[] {
  try {
    return fg.sync(
      ["**/*.contract.ts", "**/*.contract.tsx"],
      {
        cwd: repoRoot,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/.mandu/**", "**/dist/**"],
      },
    );
  } catch {
    return [];
  }
}

/** Infer route path from contract file name. e.g. api-categories-$id → /api/categories/:id */
export function inferRouteFromFileName(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const name = base.replace(/\.contract\.(ts|tsx)$/, "");
  // convert "api-categories-$id" → "/api/categories/:id"
  const parts = name.split("-").map((p) => (p.startsWith("$") ? `:${p.slice(1)}` : p));
  return "/" + parts.join("/");
}

/**
 * Extract the innermost balanced block starting at `start` (pointing at '{' or '(').
 * Returns the substring inside the braces (exclusive), or null on failure.
 */
function extractBalanced(src: string, start: number, open = "{", close = "}"): string | null {
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

function parseZodFieldKind(expr: string): ZodFieldKind {
  // expr is something like "z.string()" or "z.array(X)" or "z.object({...})"
  const m = expr.match(/z\s*\.\s*(string|number|boolean|array|object)\b/);
  if (!m) return "unknown";
  return m[1] as ZodFieldKind;
}

/**
 * Parse a `z.object({ a: z.string(), b: z.number().optional() })` block.
 * Returns an array of ContractField. Simple top-level key scan — handles nested
 * z.object(...) by consuming balanced parens.
 */
function parseObjectShape(src: string): ContractField[] {
  const fields: ContractField[] = [];
  let i = 0;
  while (i < src.length) {
    // skip whitespace/commas
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (i >= src.length) break;

    // match identifier or quoted key
    let keyMatch: RegExpMatchArray | null = null;
    const rest = src.slice(i);
    keyMatch =
      rest.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/) ||
      rest.match(/^['"]([^'"]+)['"]\s*:/);
    if (!keyMatch) {
      // advance past next char and try again
      i++;
      continue;
    }
    const key = keyMatch[1];
    i += keyMatch[0].length;

    // capture value expression up to the next top-level comma
    let depth = 0;
    let start = i;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) break;
      i++;
    }
    const valueExpr = src.slice(start, i);
    const kind = parseZodFieldKind(valueExpr);
    const optional = /\.optional\s*\(/.test(valueExpr) || /\.nullish\s*\(/.test(valueExpr);
    const minMatch = valueExpr.match(/\.min\s*\(\s*(\d+)/);
    const minLength = minMatch ? Number(minMatch[1]) : undefined;
    fields.push({ name: key, kind, optional, ...(minLength !== undefined ? { minLength } : {}) });
  }
  return fields;
}

/**
 * Parse a contract file source into a ParsedContract.
 *
 * Matches patterns like:
 *   response: {
 *     200: z.object({ todos: z.array(...) }),
 *     201: z.object({ todo: ... }),
 *     400: z.object({ error: z.string() }),
 *   }
 * and:
 *   request: {
 *     POST: { body: z.object({ title: z.string().min(1) }) },
 *   }
 */
export function parseContractSource(filePath: string, source: string): ParsedContract {
  const responses: ContractResponseShape[] = [];
  const requests: ContractRequestShape[] = [];

  // Find "response:" block
  const respIdx = source.search(/\bresponse\s*:\s*\{/);
  if (respIdx !== -1) {
    const braceStart = source.indexOf("{", respIdx);
    const block = extractBalanced(source, braceStart);
    if (block) {
      // For each entry like `200: z.object({ ... })`
      const statusRegex = /(\d{3})\s*:\s*z\s*\.\s*object\s*\(\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = statusRegex.exec(block)) !== null) {
        const status = Number(m[1]);
        // find the balanced {...} after this match
        const innerBraceStart = block.indexOf("{", m.index + m[0].length - 1);
        const innerBlock = extractBalanced(block, innerBraceStart);
        if (innerBlock) {
          responses.push({ status, topLevelKeys: parseObjectShape(innerBlock) });
        } else {
          responses.push({ status, topLevelKeys: [] });
        }
      }
      // Also capture shorthand like `400: z.object({error: z.string()})` — covered above.
      // Capture entries with no object shape: `204: z.null()` etc.
      const bareStatus = /(\d{3})\s*:\s*z\s*\.\s*(null|void|undefined)/g;
      while ((m = bareStatus.exec(block)) !== null) {
        responses.push({ status: Number(m[1]), topLevelKeys: [] });
      }
    }
  }

  // Find "request:" block
  const reqIdx = source.search(/\brequest\s*:\s*\{/);
  if (reqIdx !== -1) {
    const braceStart = source.indexOf("{", reqIdx);
    const block = extractBalanced(source, braceStart);
    if (block) {
      const methodRegex = /\b(GET|POST|PUT|PATCH|DELETE)\s*:\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = methodRegex.exec(block)) !== null) {
        const method = m[1];
        const methodBraceStart = block.indexOf("{", m.index + m[0].length - 1);
        const methodBlock = extractBalanced(block, methodBraceStart);
        if (!methodBlock) continue;

        // look for `body: z.object({ ... })`
        const bodyIdx = methodBlock.search(/\bbody\s*:\s*z\s*\.\s*object\s*\(\s*\{/);
        let bodyFields: ContractField[] = [];
        if (bodyIdx !== -1) {
          const bodyBraceStart = methodBlock.indexOf("{", bodyIdx + "body:".length);
          const bodyBlock = extractBalanced(methodBlock, bodyBraceStart);
          if (bodyBlock) bodyFields = parseObjectShape(bodyBlock);
        }
        requests.push({ method, bodyFields });
      }
    }
  }

  return {
    file: filePath,
    inferredRoute: inferRouteFromFileName(filePath),
    responses,
    requests,
  };
}

/** Load and parse a contract file from disk. Returns null if unreadable. */
export function parseContractFile(filePath: string): ParsedContract | null {
  if (!existsSync(filePath)) return null;
  try {
    const source = readFileSync(filePath, "utf8");
    return parseContractSource(filePath, source);
  } catch {
    return null;
  }
}

/**
 * Find a contract for a given route path. Checks two locations:
 *   1. colocated with the route file (same directory, any .contract.ts)
 *   2. global search — match by inferredRoute equal to route path
 */
export function findContractForRoute(
  repoRoot: string,
  routePath: string,
  routeFileAbs?: string,
): ParsedContract | null {
  // 1. Colocated
  if (routeFileAbs) {
    try {
      const dir = dirname(routeFileAbs);
      const colocated = fg.sync(["*.contract.ts", "*.contract.tsx"], {
        cwd: dir,
        absolute: true,
        onlyFiles: true,
      });
      for (const file of colocated) {
        const parsed = parseContractFile(file);
        if (parsed) return parsed;
      }
    } catch {
      // ignore
    }
  }

  // 2. Global search by inferred route
  const all = findContractFiles(repoRoot);
  for (const file of all) {
    const parsed = parseContractFile(file);
    if (!parsed) continue;
    if (parsed.inferredRoute === routePath) return parsed;
  }
  return null;
}
