/**
 * Phase A.3 — prompt catalog loader.
 *
 * Reads the versioned Markdown prompt templates from `packages/ate/prompts/`
 * and exposes a small API for:
 *
 *   - `loadPrompt(kind, version?)` — resolve the file for a kind (and optional
 *      specific version) and return the parsed `{frontmatter, body, sha256}`.
 *   - `listPrompts()` — enumerate every discovered `(kind, version)` pair.
 *
 * Semantics:
 *
 *   - File naming: `<kind>.v<N>.md` (versioned) OR `<kind>.md` (alias for the
 *     latest discovered version — we resolve this to the highest `v<N>` found).
 *   - Frontmatter: YAML-like, parsed by a minimal line-splitter (we deliberately
 *     do NOT pull in `yaml` as a dep — §constraints say no new dependencies).
 *     Supported scalar keys: `kind`, `version`, `base`, `audience`, `mandu_min`.
 *   - sha256: stable fingerprint of the entire file contents (frontmatter + body).
 *     The MCP surface uses this as a cache key per §4.2.
 *
 * Intentionally small surface — the composer layer (see `prompt-composer.ts`)
 * is the thing that stitches exemplars and context into the final string.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface PromptFrontmatter {
  kind: string;
  version: number;
  base?: string;
  audience?: string;
  mandu_min?: string;
  /** Anything else found in the YAML block, passed through verbatim. */
  extra?: Record<string, string>;
}

export interface LoadedPrompt {
  frontmatter: PromptFrontmatter;
  /** Body portion — everything after the closing `---` fence. */
  body: string;
  /** Raw file contents (frontmatter + body), useful for goldens. */
  raw: string;
  /** sha256 of the raw file contents. Cache key. */
  sha256: string;
  /** Absolute path to the resolved file. */
  path: string;
}

export interface PromptIndexEntry {
  kind: string;
  version: number;
  path: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Resolve the prompts directory
//
// The catalog lives at `packages/ate/prompts/`. We discover it via
// `import.meta.url` so the loader works regardless of cwd (tests may run
// from anywhere in the repo).
// ──────────────────────────────────────────────────────────────────────────

function promptsDir(): string {
  // This file lives at `packages/ate/src/prompt-loader.ts`. The catalog
  // is a sibling of `src/` at `packages/ate/prompts/`.
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", "prompts");
}

/** Allow tests / power users to point at an alternative catalog. */
export interface LoadPromptOptions {
  dir?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Frontmatter parsing
//
// We accept exactly what the ATE catalog emits — a `---` fenced YAML-like
// block at the very top of the file, with simple `key: value` lines.
// No anchors, no nested maps, no multi-line strings. Anything unrecognized
// is stuffed into `extra` so future fields don't break the loader.
// ──────────────────────────────────────────────────────────────────────────

const FRONTMATTER_FENCE = /^---\r?\n/;

function parseFrontmatter(raw: string): { frontmatter: PromptFrontmatter; body: string } {
  if (!FRONTMATTER_FENCE.test(raw)) {
    throw new PromptLoadError(
      `Prompt file missing YAML frontmatter (expected leading '---' fence)`
    );
  }
  const afterOpen = raw.replace(FRONTMATTER_FENCE, "");
  const closeIdx = afterOpen.search(/^---\r?\n/m);
  if (closeIdx < 0) {
    throw new PromptLoadError(
      `Prompt file has opening '---' but no closing '---' fence`
    );
  }
  const yaml = afterOpen.slice(0, closeIdx);
  const body = afterOpen.slice(closeIdx).replace(/^---\r?\n/, "");

  const fm: PromptFrontmatter = {
    kind: "",
    version: 0,
    extra: {},
  };

  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case "kind":
        fm.kind = value;
        break;
      case "version":
        fm.version = Number(value);
        break;
      case "base":
        fm.base = value;
        break;
      case "audience":
        fm.audience = value;
        break;
      case "mandu_min":
        fm.mandu_min = value;
        break;
      default:
        fm.extra![key] = value;
    }
  }

  if (!fm.kind) {
    throw new PromptLoadError(`Frontmatter missing required field: kind`);
  }
  if (!Number.isFinite(fm.version) || fm.version <= 0) {
    throw new PromptLoadError(`Frontmatter field 'version' must be a positive integer`);
  }

  return { frontmatter: fm, body };
}

// ──────────────────────────────────────────────────────────────────────────
// Index
// ──────────────────────────────────────────────────────────────────────────

const PROMPT_FILE = /^([a-z][a-z0-9_]*)(?:\.v(\d+))?\.md$/;

function scanDir(dir: string): PromptIndexEntry[] {
  if (!existsSync(dir)) return [];
  const entries: PromptIndexEntry[] = [];
  for (const file of readdirSync(dir)) {
    const m = file.match(PROMPT_FILE);
    if (!m) continue;
    // "alias" files (`filling_unit.md` without `.vN`) are skipped from the
    // index — they're resolved by `loadPrompt` via a latest-version lookup.
    if (!m[2]) continue;
    entries.push({
      kind: m[1],
      version: Number(m[2]),
      path: join(dir, file),
    });
  }
  // Stable sort: kind then ascending version.
  entries.sort((a, b) => (a.kind === b.kind ? a.version - b.version : a.kind.localeCompare(b.kind)));
  return entries;
}

export function listPrompts(options: LoadPromptOptions = {}): PromptIndexEntry[] {
  const dir = options.dir ?? promptsDir();
  return scanDir(dir);
}

// ──────────────────────────────────────────────────────────────────────────
// Load
// ──────────────────────────────────────────────────────────────────────────

export class PromptLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptLoadError";
  }
}

/**
 * Resolve a prompt by kind + optional version.
 *
 *   - If `version` is given: look for `<dir>/<kind>.v<version>.md` exactly.
 *   - If `version` is omitted: pick the highest `v<N>` in the index. Also
 *     accept an alias file `<kind>.md` if it exists and no `v<N>` file does
 *     (future-friendly — not used in the initial catalog).
 */
export function loadPrompt(
  kind: string,
  version?: number,
  options: LoadPromptOptions = {}
): LoadedPrompt {
  const dir = options.dir ?? promptsDir();

  let resolvedPath: string;

  if (version !== undefined) {
    const candidate = join(dir, `${kind}.v${version}.md`);
    if (!existsSync(candidate)) {
      throw new PromptLoadError(
        `No prompt for kind='${kind}' version=${version} (expected ${candidate})`
      );
    }
    resolvedPath = candidate;
  } else {
    const idx = scanDir(dir).filter((e) => e.kind === kind);
    if (idx.length === 0) {
      // fall back to un-versioned alias
      const alias = join(dir, `${kind}.md`);
      if (existsSync(alias)) {
        resolvedPath = alias;
      } else {
        throw new PromptLoadError(`No prompts found for kind='${kind}' in ${dir}`);
      }
    } else {
      // highest version wins
      idx.sort((a, b) => b.version - a.version);
      resolvedPath = idx[0].path;
    }
  }

  const raw = readFileSync(resolvedPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const sha256 = createHash("sha256").update(raw).digest("hex");

  return {
    frontmatter,
    body,
    raw,
    sha256,
    path: resolvedPath,
  };
}
