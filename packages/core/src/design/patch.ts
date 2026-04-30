/**
 * Section-safe DESIGN.md patcher (Issue #245 M4 §3.5).
 *
 * The patcher rewrites only the *body* of a target H2 section, leaving:
 *   - the H1 title and other H2 sections untouched (verbatim)
 *   - the target heading line itself untouched
 *   - any free-form prose between the heading and the first structured
 *     row preserved
 *
 * Operations are scoped to one `(section, key)` pair at a time so an
 * agent can stream multiple patches without re-loading the file. The
 * `dryRun` flag returns the would-be next source without writing it,
 * so MCP tools can show the user a diff before committing.
 *
 * Token row rules per section:
 *   - color-palette / shadows / layout / typography: bullet rows of
 *     the form `- <Name> — <value>` (extra columns preserved verbatim
 *     for `update`).
 *   - components: H3 sub-headings with optional bullet body.
 *
 * Unsupported sections return `{ applied: false, reason: ... }` —
 * they're free-form by design. Callers decide whether to surface the
 * limitation or fall back to a hand-edit.
 */

import { parseDesignMd } from "./parser";

export type PatchableSection =
  | "color-palette"
  | "typography"
  | "layout"
  | "shadows"
  | "components";

export interface PatchOperation {
  section: PatchableSection;
  /** "add" creates the row; "update" replaces an existing matching row;
   *  "remove" deletes a matching row. */
  operation: "add" | "update" | "remove";
  /** Token name. Match is case-insensitive on the slug. */
  key: string;
  /** Required for `add` / `update`. Free-form value (`#FF8C42`,
   *  `Inter, sans-serif`, `0 1px 3px rgba(...)`). */
  value?: string;
  /** Optional functional role / usage hint (color/shadow). */
  role?: string;
}

export interface PatchResult {
  applied: boolean;
  /** Reason the operation was a no-op or rejected. */
  reason?: string;
  /** Source after applying — same as input when not applied. */
  next: string;
  /** Old row (for `update` / `remove`). Undefined for clean adds. */
  before?: string;
  /** New row (for `add` / `update`). Undefined for `remove`. */
  after?: string;
}

const HEADING_BY_SECTION: Record<PatchableSection, RegExp> = {
  "color-palette": /^##\s+.*?(color|palette).*$/im,
  typography: /^##\s+.*?(typograph|typeface|font|type scale).*$/im,
  layout: /^##\s+.*?(layout|spacing|grid).*$/im,
  shadows: /^##\s+.*?(shadow|elevation|depth).*$/im,
  components: /^##\s+.*?(component|button|card|input).*$/im,
};

/**
 * Apply a single patch. Pure — does not touch the filesystem.
 *
 * The result's `applied` flag tells the caller whether the source
 * actually changed (e.g. `remove` of a non-existent key returns
 * `applied: false` with `reason`).
 */
export function patchDesignMd(source: string, op: PatchOperation): PatchResult {
  const headingRx = HEADING_BY_SECTION[op.section];
  const headingMatch = headingRx.exec(source);
  if (!headingMatch) {
    return {
      applied: false,
      reason: `Section "${op.section}" not found in DESIGN.md`,
      next: source,
    };
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const nextHeadingIdx = source.indexOf("\n## ", sectionStart);
  const sectionEnd = nextHeadingIdx >= 0 ? nextHeadingIdx : source.length;
  const sectionBody = source.slice(sectionStart, sectionEnd);

  const updated = applyToBody(sectionBody, op);
  if (!updated.applied) {
    return { ...updated, next: source };
  }

  const next = source.slice(0, sectionStart) + updated.body + source.slice(sectionEnd);
  return {
    applied: true,
    next,
    before: updated.before,
    after: updated.after,
  };
}

interface BodyApplyResult {
  applied: boolean;
  reason?: string;
  body: string;
  before?: string;
  after?: string;
}

function applyToBody(body: string, op: PatchOperation): BodyApplyResult {
  const lines = body.split(/\r?\n/);
  const targetSlug = slug(op.key);

  const matchIdx = lines.findIndex((line) => {
    const row = parseTokenRow(line, op.section);
    return row !== null && slug(row.name) === targetSlug;
  });

  if (op.operation === "remove") {
    if (matchIdx < 0) {
      return { applied: false, reason: `No row with name "${op.key}"`, body };
    }
    const before = lines[matchIdx]!;
    lines.splice(matchIdx, 1);
    return { applied: true, body: lines.join("\n"), before };
  }

  if (op.operation === "update") {
    if (matchIdx < 0) {
      return { applied: false, reason: `No row with name "${op.key}"`, body };
    }
    if (op.value === undefined) {
      return { applied: false, reason: "`value` is required for update", body };
    }
    const before = lines[matchIdx]!;
    const after = renderRow(op);
    lines[matchIdx] = after;
    return { applied: true, body: lines.join("\n"), before, after };
  }

  // add — value is required for token rows, optional for component H3
  if (op.section !== "components" && op.value === undefined) {
    return { applied: false, reason: "`value` is required for add", body };
  }
  if (matchIdx >= 0) {
    return {
      applied: false,
      reason: `Row "${op.key}" already exists — use update or remove first`,
      body,
    };
  }

  const after = renderRow(op);
  // Find the last existing token row to anchor the insertion. When
  // none exist, insert at the bottom of the section before any
  // trailing whitespace.
  let insertAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (parseTokenRow(lines[i]!, op.section) !== null) {
      insertAt = i + 1;
      break;
    }
  }
  lines.splice(insertAt, 0, after);
  // Ensure the section body keeps its trailing blank line before the
  // next H2 (or EOF) so subsequent patches don't crowd headers.
  let next = lines.join("\n");
  if (!next.endsWith("\n")) next = `${next}\n`;
  return { applied: true, body: next, after };
}

interface ParsedTokenRow {
  name: string;
  rest: string;
}

function parseTokenRow(line: string, section: PatchableSection): ParsedTokenRow | null {
  if (section === "components") {
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) return { name: h3[1]!, rest: "" };
    return null;
  }
  const stripped = line.trim().replace(/^[-*+]\s*/, "");
  if (!stripped || /^[#|]/.test(stripped)) return null;
  const m = /^([^—:|]+?)\s*[—:–|]\s*(.+)$/.exec(stripped);
  if (!m) return null;
  return { name: m[1]!.replace(/[`*_]/g, "").trim(), rest: m[2]!.trim() };
}

function renderRow(op: PatchOperation): string {
  if (op.section === "components") {
    return `### ${op.key}`;
  }
  const value = op.value ?? "";
  const role = op.role ? ` — ${op.role}` : "";
  return `- ${op.key} — ${value}${role}`;
}

function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

// ─── Multi-op sugar ───────────────────────────────────────────────────

export interface PatchBatchResult {
  next: string;
  results: PatchResult[];
  appliedCount: number;
}

/**
 * Apply a list of operations in order. Each operation runs against
 * the cumulative source — later ops see earlier ones. Failures are
 * surfaced per-entry but never abort the batch (so a partial success
 * is observable).
 */
export function patchDesignMdBatch(
  source: string,
  ops: readonly PatchOperation[],
): PatchBatchResult {
  let current = source;
  const results: PatchResult[] = [];
  let appliedCount = 0;
  for (const op of ops) {
    const r = patchDesignMd(current, op);
    results.push(r);
    if (r.applied) {
      appliedCount++;
      current = r.next;
    }
  }
  return { next: current, results, appliedCount };
}
