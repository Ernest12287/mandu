/**
 * Frontmatter Parser (Issue #199)
 *
 * Minimal, dependency-free YAML frontmatter parser for the MVP
 * `defineCollection()` API. Handles the common subset used in docs
 * collections — enough to cover the `title`/`order`/`draft`/`tags`
 * patterns called out by the feature spec without pulling in
 * `gray-matter` or `yaml` as a runtime dep.
 *
 * # Supported frontmatter syntax
 *
 *   - Standard `---` fenced YAML at the top of the file
 *   - CRLF or LF line endings (so Windows authors do not have to
 *     convert before committing)
 *   - Scalar values: strings, numbers (int/float), booleans, null
 *   - Quoted strings: single + double quotes (with trailing content
 *     preservation — escape sequences NOT interpreted)
 *   - Simple inline arrays: `tags: [a, b, c]`
 *   - Block arrays:
 *         tags:
 *           - a
 *           - b
 *   - Comments (`#`) at end of line and on their own line
 *
 * # Explicitly unsupported (out of MVP scope)
 *
 *   - Nested maps (`author: { name: ... }`) — use JSON-style inline
 *     or restructure with a Zod transform
 *   - Anchors, aliases, tags (`&anchor`, `*ref`, `!!tag`)
 *   - Multi-line scalars (`>` / `|`)
 *   - Complex quoted string escape sequences
 *
 * Projects that outgrow this parser can install `yaml` themselves and
 * wrap their collection with a custom loader — the existing
 * `glob()` loader in `./loaders/glob.ts` already dynamic-imports
 * `yaml` when present.
 */

/** Result of parsing a Markdown file with optional frontmatter. */
export interface ParsedFrontmatter {
  /** Parsed key/value pairs from the YAML block (empty if no frontmatter). */
  data: Record<string, unknown>;
  /** Body content following the closing `---` fence (or whole file if none). */
  body: string;
  /** Raw YAML text inside the fences — useful for diagnostics. */
  raw?: string;
}

/**
 * Parse a Markdown-style source string into frontmatter data + body.
 *
 * When the source does NOT start with `---`, returns `{ data: {}, body: src }`
 * verbatim — callers should treat that as "no frontmatter" rather than a
 * parse error. When the source DOES open with `---` but the block is
 * malformed (no closing fence), throws so the calling `Collection.load()`
 * can attach the file path for reporting.
 */
export function parseFrontmatter(src: string): ParsedFrontmatter {
  // Normalize line endings once up front so the fence regex and the
  // per-line scanner agree on `\n` as the only delimiter. We preserve
  // the body exactly as authored except for this normalization.
  const normalized = src.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    // The spec's MVP never requires frontmatter — a .md file without
    // it just becomes an entry with empty `data` and the whole file
    // as `body`. Zod validation downstream will catch missing required
    // fields and report them with a helpful collection/entry label.
    return { data: {}, body: src };
  }
  const [, rawFront, body] = match;
  const data = parseSimpleYaml(rawFront);
  return { data, body: body.replace(/^\n/, ""), raw: rawFront };
}

/**
 * Parse a small, opinionated subset of YAML. Not a general-purpose YAML
 * parser — see the file header for the supported subset.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const line = stripComment(rawLine);
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Top-level entries must be unindented — nested maps are out of
    // scope, and treating indented lines as their own keys would mask
    // real parse errors.
    if (/^\s/.test(line) && !/^\s*-\s/.test(line)) {
      // Unexpected indentation at top level — skip defensively rather
      // than throw, since some authors add stray spaces.
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const [, key, rest] = m;
    const value = rest.trim();
    if (value === "") {
      // Could be a block array — peek ahead for `  - item` lines.
      const blockItems: unknown[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = stripComment(lines[j] ?? "");
        const itemMatch = next.match(/^\s+-\s+(.+)$/);
        if (!itemMatch) break;
        blockItems.push(parseScalar(itemMatch[1].trim()));
        j++;
      }
      if (blockItems.length > 0) {
        out[key] = blockItems;
        i = j;
        continue;
      }
      // Empty value with no following list — store as null rather than
      // empty string so downstream Zod `.optional()` behaves correctly.
      out[key] = null;
      i++;
      continue;
    }
    out[key] = parseScalar(value);
    i++;
  }
  return out;
}

/**
 * Strip a trailing `# comment` from a line, respecting quoted strings
 * so `title: "pricing # free"` does not lose the `# free` tail.
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, k);
    }
  }
  return line;
}

/**
 * Coerce a trimmed scalar token into the most appropriate JS primitive.
 * The ordering here matters — booleans and null must come before the
 * number check so `null`/`true` aren't accidentally parsed as NaN.
 */
export function parseScalar(v: string): unknown {
  if (v === "") return null;
  // Inline array: `[a, b, c]` — parse each element as a scalar. We
  // intentionally use a non-quoted split because the spec's MVP only
  // needs flat tag lists; nested arrays go via the block form.
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  // Number check: accept int + float, reject leading-zero-padded (e.g.
  // `007`) to stay consistent with YAML 1.2 — treat those as strings
  // so ID fields are preserved.
  if (/^-?\d+$/.test(v) && !/^-?0\d/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}
