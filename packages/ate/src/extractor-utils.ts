/**
 * Shared helpers used by the extractor when broadening its scope
 * from route-only scanning (pre Phase A.1) to the 7-kind node surface
 * (route / filling / slot / island / action / form / modal).
 *
 * These are intentionally small string/AST utilities — the heavier
 * logic lives in `extractor.ts` where ts-morph is already loaded.
 */
import type { StaticParamSample } from "./types";

/**
 * Derive a deterministic route id from a URL path. The id is used as
 * a cross-node key (filling → route, slot → route, etc.) and as the
 * `[data-route-id]` anchor surfaced to Playwright specs.
 *
 *   "/"              → "root"
 *   "/api/signup"    → "api-signup"
 *   "/posts/[id]"    → "posts-id"
 *   "/[...slug]"     → "slug"
 *
 * Dynamic segments (`[foo]`, `[...foo]`, `[[...foo]]`) collapse to
 * the bare identifier so specs can reference the route without
 * encoding the catch-all marker.
 */
export function routeIdFromPath(routePath: string): string {
  if (!routePath || routePath === "/") return "root";
  const cleaned = routePath
    .replace(/^\//, "")
    .replace(/\/$/, "")
    .split("/")
    .map((seg) => seg.replace(/^\[\[?\.{0,3}/, "").replace(/\]\]?$/, ""))
    .filter((seg) => seg.length > 0);
  return cleaned.length === 0 ? "root" : cleaned.join("-");
}

/**
 * Pattern-detect `name.includes("modal")` or `Modal` casing in a JSX
 * identifier. Used by the extractor to flag slot/component names that
 * the runtime treats as modals by convention.
 */
export function isLikelyModalName(name: string): boolean {
  return /modal/i.test(name);
}

/**
 * Attempt to extract a `generateStaticParams` return-value as an
 * array literal without executing user code. The parser looks for
 * the AST pattern:
 *
 *   export (async )?function generateStaticParams() {
 *     return [ { key: "value" }, { key: "value" } ];
 *   }
 *
 * Or:
 *
 *   export const generateStaticParams = () => [ ... ];
 *
 * If the function body references any free variable or performs
 * computation we can't resolve statically, returns `null`. This is
 * groundwork for Phase B's boundary probe — it must be deterministic
 * (no eval) and fail-closed.
 */
export function extractStaticParamsFromSource(source: string, limit = 8): StaticParamSample[] | null {
  // Quick grep first — avoid ts-morph overhead when the export is missing.
  if (!/generateStaticParams/.test(source)) return null;

  // Match `return [ ... ];` inside a generateStaticParams function OR
  // an arrow-returning literal. This deliberately only handles the
  // flat-literal case — anything with interpolation, imports, etc.
  // returns null and lets the caller fall back to "no static params".
  const literalBlock = findFirstReturnArrayLiteral(source);
  if (!literalBlock) return null;

  const entries = parseParamArrayLiteral(literalBlock, limit);
  return entries;
}

/**
 * Find the body of the first `return [ ... ]` expression inside the
 * `generateStaticParams` function. Returns the text *inside* the
 * outer square brackets, or null.
 */
function findFirstReturnArrayLiteral(source: string): string | null {
  // Find any occurrence of `generateStaticParams` used as a
  // declaration (function, const, etc.), then scan forward for the
  // first `return` or arrow body.
  const anchorRegex = /generateStaticParams\s*(?:=|\()/;
  const m = anchorRegex.exec(source);
  if (!m) return null;

  // Accept two shapes:
  //   (A) `... { return [...] }` — regular function or async function
  //   (B) `... => [...]`          — arrow expression body
  const tail = source.slice(m.index);
  const returnIdx = tail.search(/\breturn\s*\[/);
  const arrowIdx = tail.search(/=>\s*\[/);
  let bracketStart = -1;
  if (returnIdx !== -1 && (arrowIdx === -1 || returnIdx < arrowIdx)) {
    bracketStart = tail.indexOf("[", returnIdx);
  } else if (arrowIdx !== -1) {
    bracketStart = tail.indexOf("[", arrowIdx);
  }
  if (bracketStart === -1) return null;

  return extractBalanced(tail, bracketStart, "[", "]");
}

/**
 * Balanced-delimiter scanner. Returns the text *between* the matching
 * open/close pair (exclusive). Skips over quoted strings so an
 * embedded `]` inside `"foo]"` does not close the outer bracket.
 */
function extractBalanced(src: string, start: number, open: string, close: string): string | null {
  if (src[start] !== open) return null;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // skip string literal
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
    i++;
  }
  return null;
}

/**
 * Parse the inside of `[{...},{...}]` — an array of object literals
 * with string values. Example input:
 *
 *   ` { slug: "intro" }, { slug: "quickstart" } `
 *
 * Non-string values (numbers, expressions, template literals with
 * interpolation, spread, computed keys) cause the whole entry to be
 * dropped. This is intentional — the extractor must be deterministic.
 */
function parseParamArrayLiteral(body: string, limit: number): StaticParamSample[] {
  const results: StaticParamSample[] = [];
  let i = 0;
  while (i < body.length && results.length < limit) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body[i] !== "{") {
      // malformed — bail entirely rather than return partial garbage
      return results;
    }
    const obj = extractBalanced(body, i, "{", "}");
    if (obj === null) return results;
    i += obj.length + 2; // skip past '{' obj '}'
    const params = parseFlatObjectLiteral(obj);
    if (params) results.push({ params });
    // else: skip this entry silently
  }
  return results;
}

/**
 * Parse `{ a: "x", b: "y" }` into `{ a: "x", b: "y" }`. Returns null
 * if any value is non-string-literal (guards against eval semantics).
 */
function parseFlatObjectLiteral(src: string): Record<string, string | string[]> | null {
  const result: Record<string, string | string[]> = {};
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (i >= src.length) break;

    // key — identifier or quoted
    const keyMatch =
      src.slice(i).match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/) ||
      src.slice(i).match(/^['"]([^'"]+)['"]\s*:/);
    if (!keyMatch) return null;
    const key = keyMatch[1];
    i += keyMatch[0].length;

    // skip whitespace
    while (i < src.length && /\s/.test(src[i])) i++;

    // value — must be a string literal OR an array-literal of string literals.
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i];
      i++;
      let value = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      i++; // skip closing quote
      result[key] = value;
    } else if (src[i] === "[") {
      // catch-all param like `slug: ["a", "b"]`
      const inner = extractBalanced(src, i, "[", "]");
      if (inner === null) return null;
      i += inner.length + 2;
      const arr = parseStringArrayLiteral(inner);
      if (arr === null) return null;
      result[key] = arr;
    } else {
      // number / identifier / template → treat as non-deterministic
      return null;
    }
    while (i < src.length && /[\s,]/.test(src[i])) i++;
  }
  return result;
}

function parseStringArrayLiteral(src: string): string[] | null {
  const result: string[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] !== '"' && src[i] !== "'") return null;
    const quote = src[i];
    i++;
    let value = "";
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\" && i + 1 < src.length) {
        value += src[i + 1];
        i += 2;
        continue;
      }
      value += src[i];
      i++;
    }
    i++;
    result.push(value);
  }
  return result;
}

/**
 * Detect `.use(xxx())` / `.use(xxx)` callees on a chain starting from
 * `Mandu.filling()` or an imported `filling()`. Returns the plain
 * identifier text for each middleware registration, e.g.
 * ["withSession", "withCsrf"].
 *
 * This is a source-level scan — we do NOT resolve what the middleware
 * actually does. The context builder matches identifier names against
 * a known registry (`session`, `csrf`, `rate-limit`, etc.) to expose
 * structured options downstream.
 */
export function scanMiddlewareIdentifiers(source: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const regex = /\.use\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      result.push(m[1]);
    }
  }
  return result;
}

/**
 * Detect `.action("name", handler)` registrations on a Filling chain.
 * Returns the list of action names (strings only — dynamic names are
 * skipped).
 */
export function scanFillingActionNames(source: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const regex = /\.action\s*\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      result.push(m[1]);
    }
  }
  return result;
}

/**
 * Detect HTTP-method registrations on a Filling chain — `.get(...)`,
 * `.post(...)`, `.put(...)`, `.patch(...)`, `.delete(...)`. Returned
 * in uppercase. If no chain method is found, returns an empty array
 * (API route with explicit named exports is handled separately by the
 * extractor).
 */
export function scanFillingMethods(source: string): string[] {
  const result = new Set<string>();
  const regex = /\.(get|post|put|patch|delete)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    result.add(m[1].toUpperCase());
  }
  return [...result];
}

/**
 * Detect whether the module appears to be a Filling handler. We accept
 * either `Mandu.filling()` or a bare `filling()` call — both are valid
 * imports from `@mandujs/core`.
 */
export function isFillingSource(source: string): boolean {
  return /\bMandu\.filling\s*\(/.test(source) || /\bfilling\s*\(\s*\)/.test(source);
}
