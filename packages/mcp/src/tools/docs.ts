import type * as __ManduNodeFsTypes0 from "node:fs";
/**
 * MCP tools — `mandu.docs.search` + `mandu.docs.get`
 *
 * Issue #243 — agents had 100+ MCP tools but none pointed at the Mandu
 * docs tree. These two tools close that gap by indexing the project's
 * `docs/` directory (where the framework's own markdown lives) and
 * returning search hits + full page bodies.
 *
 * Implementation is deliberately offline-first: we walk `docs/` with
 * `fs.readdir` and grep by title / frontmatter / body. No Pagefind, no
 * network, no extra dependencies — good for any repo that vendors the
 * Mandu docs or has its own markdown tree under `docs/`.
 *
 * Invariants:
 *   - Read-only. Never writes files.
 *   - Bounded: at most `MAX_FILES` files walked, `MAX_SNIPPET_CHARS` per
 *     excerpt. A docs tree of ~10k files would otherwise OOM the handler.
 *   - Fails soft: missing `docs/` returns `{ results: [], note: "…" }`.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import fs from "fs/promises";

const DOCS_DIR_NAME = "docs";
const MAX_FILES = 5_000;
const MAX_SNIPPET_CHARS = 280;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

type Scope = "all" | string;

interface DocsSearchInput {
  query?: unknown;
  scope?: unknown;
  limit?: unknown;
  includeBody?: unknown;
}

interface DocsGetInput {
  slug?: unknown;
}

interface DocHit {
  slug: string;
  title: string;
  path: string;
  excerpt: string;
  score: number;
  body?: string;
}

interface DocsSearchResult {
  query: string;
  scope: Scope;
  results: DocHit[];
  totalMatched: number;
  note?: string;
}

interface DocsGetResult {
  slug: string;
  path: string;
  title: string;
  body: string;
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────

function validateSearch(raw: Record<string, unknown>): {
  ok: true; query: string; scope: Scope; limit: number; includeBody: boolean;
} | { ok: false; error: string; field: string } {
  const q = raw.query;
  if (typeof q !== "string" || q.trim().length === 0) {
    return { ok: false, error: "'query' must be a non-empty string", field: "query" };
  }
  const scope = raw.scope ?? "all";
  if (typeof scope !== "string") {
    return { ok: false, error: "'scope' must be a string or omitted", field: "scope" };
  }
  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit) || raw.limit < 1) {
      return { ok: false, error: "'limit' must be a positive number", field: "limit" };
    }
    limit = Math.min(Math.floor(raw.limit), MAX_LIMIT);
  }
  const includeBody = raw.includeBody === true;
  return { ok: true, query: q.trim(), scope, limit, includeBody };
}

function validateGet(raw: Record<string, unknown>): {
  ok: true; slug: string;
} | { ok: false; error: string; field: string } {
  const s = raw.slug;
  if (typeof s !== "string" || s.trim().length === 0) {
    return { ok: false, error: "'slug' must be a non-empty string", field: "slug" };
  }
  // Block traversal explicitly — the handler joins against `docs/` and
  // would otherwise happily read /etc/passwd on Unix.
  if (s.includes("..") || path.isAbsolute(s)) {
    return { ok: false, error: "'slug' must be a relative docs path without '..'", field: "slug" };
  }
  return { ok: true, slug: s.trim() };
}

// ─────────────────────────────────────────────────────────────────────────
// Indexing + search
// ─────────────────────────────────────────────────────────────────────────

async function walkDocs(rootDir: string, relPrefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: __ManduNodeFsTypes0.Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    const absPath = path.join(rootDir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip generated / hidden noise.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const nested = await walkDocs(absPath, relPath);
      out.push(...nested);
    } else if (entry.isFile() && /\.(md|mdx)$/.test(entry.name)) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Extract a human-readable title. Preference order:
 *   1. `title:` frontmatter field
 *   2. First `# heading` line
 *   3. Slug basename
 */
function extractTitle(body: string, fallback: string): string {
  // Frontmatter block (--- ... ---) — scan for `title:` only.
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end > 0) {
      const front = body.slice(3, end);
      const m = /\btitle\s*:\s*["']?([^"\n\r]+?)["']?\s*$/m.exec(front);
      if (m?.[1]) return m[1].trim();
    }
  }
  const h = /^#\s+(.+)$/m.exec(body);
  if (h?.[1]) return h[1].trim();
  return path.basename(fallback).replace(/\.(md|mdx)$/, "");
}

/**
 * Cheap, deterministic scoring: +3 for every title hit, +1 per body hit,
 * tie-broken by shorter path (shorter paths are usually more canonical).
 */
function scoreDoc(query: string, title: string, body: string, pathLen: number): {
  score: number;
  matchedInTitle: boolean;
  firstHitOffset: number;
} {
  const q = query.toLowerCase();
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();
  let score = 0;
  const matchedInTitle = titleLower.includes(q);
  if (matchedInTitle) score += 3;
  const firstHit = bodyLower.indexOf(q);
  if (firstHit >= 0) score += 1;
  // Every extra hit (bounded at 10 to avoid abuse by repeated-word pages).
  let idx = firstHit;
  let extra = 0;
  while (idx >= 0 && extra < 9) {
    const next = bodyLower.indexOf(q, idx + q.length);
    if (next < 0) break;
    extra += 1;
    idx = next;
  }
  score += extra;
  // Tiebreaker — shorter paths float up. Encoded as a small negative so
  // it never eclipses a body-hit delta.
  score += 1 / (pathLen + 10);
  return { score, matchedInTitle, firstHitOffset: firstHit };
}

function excerptAround(body: string, hitOffset: number): string {
  if (hitOffset < 0) return body.slice(0, MAX_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
  const start = Math.max(0, hitOffset - Math.floor(MAX_SNIPPET_CHARS / 3));
  const end = Math.min(body.length, start + MAX_SNIPPET_CHARS);
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (end < body.length ? "…" : "");
}

async function searchDocs(projectRoot: string, input: {
  query: string; scope: Scope; limit: number; includeBody: boolean;
}): Promise<DocsSearchResult> {
  const docsRoot = path.join(projectRoot, DOCS_DIR_NAME);
  const files = await walkDocs(docsRoot);
  if (files.length === 0) {
    return {
      query: input.query,
      scope: input.scope,
      results: [],
      totalMatched: 0,
      note: `No files under ${DOCS_DIR_NAME}/ — project has no local docs tree indexed yet.`,
    };
  }

  const scopeFilter = input.scope === "all"
    ? null
    : new RegExp(`^${input.scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`);

  const hits: DocHit[] = [];
  for (const rel of files) {
    if (scopeFilter && !scopeFilter.test(rel)) continue;
    const abs = path.join(docsRoot, rel);
    let body: string;
    try {
      body = await fs.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const title = extractTitle(body, rel);
    const { score, firstHitOffset } = scoreDoc(input.query, title, body, rel.length);
    if (score < 1) continue;
    const hit: DocHit = {
      slug: rel,
      title,
      path: path.join(DOCS_DIR_NAME, rel),
      excerpt: excerptAround(body, firstHitOffset),
      score: Math.round(score * 1000) / 1000,
    };
    if (input.includeBody) hit.body = body;
    hits.push(hit);
  }

  hits.sort((a, b) => b.score - a.score);
  const totalMatched = hits.length;
  return {
    query: input.query,
    scope: input.scope,
    results: hits.slice(0, input.limit),
    totalMatched,
  };
}

async function getDoc(projectRoot: string, slug: string): Promise<DocsGetResult> {
  const docsRoot = path.join(projectRoot, DOCS_DIR_NAME);
  const abs = path.join(docsRoot, slug);
  // Guard — ensure resolved path still sits inside docsRoot after
  // normalization. Defense in depth vs. the `..` check in validation.
  if (!path.resolve(abs).startsWith(path.resolve(docsRoot) + path.sep)) {
    return {
      slug,
      path: "",
      title: "",
      body: "",
      note: "Resolved path escaped docs/ — refused.",
    };
  }
  let body: string;
  try {
    body = await fs.readFile(abs, "utf-8");
  } catch (err) {
    return {
      slug,
      path: path.join(DOCS_DIR_NAME, slug),
      title: path.basename(slug).replace(/\.(md|mdx)$/, ""),
      body: "",
      note: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    slug,
    path: path.join(DOCS_DIR_NAME, slug),
    title: extractTitle(body, slug),
    body,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool definitions + handler map
// ─────────────────────────────────────────────────────────────────────────

export const docsToolDefinitions: Tool[] = [
  {
    name: "mandu.docs.search",
    description:
      "Search the project's docs/ markdown tree by keyword. Returns ranked slugs + excerpts so agents can ground answers in Mandu documentation instead of hallucinating. Read-only. Pass `scope` (e.g. 'architect' or 'bun') to narrow to a subdirectory; `includeBody:true` returns the full MDX body for each hit.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text. Matches title + body (case-insensitive)." },
        scope: {
          type: "string",
          description: "Restrict search to a `docs/` subdirectory (e.g. 'architect', 'bun'). Default 'all'.",
        },
        limit: {
          type: "number",
          description: `Maximum results returned. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
        },
        includeBody: {
          type: "boolean",
          description: "Return the full markdown body for each hit. Default false (excerpt only).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "mandu.docs.get",
    description:
      "Fetch a single markdown page from the project's docs/ tree by relative slug (e.g. 'architect/rendering-modes.md'). Returns the full body + extracted title. Read-only. Pair with `mandu.docs.search` — search to discover, get to read.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Relative path under docs/ (no leading slash, no '..'). Example: 'architect/rendering-modes.md'.",
        },
      },
      required: ["slug"],
    },
  },
];

export function docsTools(projectRoot: string) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    "mandu.docs.search": async (args) => {
      const v = validateSearch(args as DocsSearchInput as Record<string, unknown>);
      if (!v.ok) return { error: v.error, field: v.field };
      return searchDocs(projectRoot, v);
    },
    "mandu.docs.get": async (args) => {
      const v = validateGet(args as DocsGetInput as Record<string, unknown>);
      if (!v.ok) return { error: v.error, field: v.field };
      return getDoc(projectRoot, v.slug);
    },
  };
  return handlers;
}
