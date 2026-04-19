/**
 * Phase 9b B — Embedded template access.
 *
 * Public API for reading `packages/cli/templates/*` scaffolds at runtime.
 * The underlying storage is `packages/cli/generated/templates-manifest.js`
 * (plus a companion `.d.ts`), emitted by `scripts/generate-template-manifest.ts`
 * from static `import … with { type: "file" }` declarations — those imports
 * are what drive `bun build --compile` to embed the bytes into the binary.
 *
 * Both execution modes resolve identically via `Bun.file(path)`:
 *   - Dev (`bun run src/main.ts`): path is the real on-disk location.
 *   - Compiled (`mandu.exe`): path is a `$bunfs/root/...` virtual entry
 *     that Bun satisfies from `Bun.embeddedFiles`.
 *
 * Call sites: `src/commands/init.ts` (copyEmbeddedTemplate, setupCiWorkflows).
 *
 * See also:
 *   docs/bun/phase-9-diagnostics/compile-binary.md §3.1 (blocker)
 *   docs/bun/phase-9-team-plan.md §2 (file-ownership map)
 */

// Runtime import of the auto-generated manifest.
//
// The physical module lives at `packages/cli/generated/templates-manifest.js`
// (plain JavaScript — `tsc` ignores `.js` files when `allowJs` is off, which
// it is here) with a companion `.d.ts` that supplies the type surface. The
// `.js` file contains ~110 static `with { type: "file" }` imports that drive
// `bun build --compile` to embed every template byte; none of those imports
// ever reach the TypeScript compiler, so none of the template `.ts` / `.tsx`
// files get pulled into the compilation graph.
//
// We use the `.js` specifier explicitly so `bun` prefers the real runtime
// module over the `.d.ts` (which has no side effects).
import {
  TEMPLATE_MANIFEST,
  EMBEDDED_FILE_COUNT,
} from "../../generated/templates-manifest.js";

export interface EmbeddedTemplateFile {
  /** POSIX-normalized path relative to the template root. */
  readonly relPath: string;
  /**
   * Embedded path consumable by `Bun.file(path)`. In dev this is an on-disk
   * absolute path; in a compiled binary it is a virtual `$bunfs` path.
   */
  readonly embeddedPath: string;
}

/**
 * Normalize a user-provided relative path to the canonical POSIX form used
 * as keys in `TEMPLATE_MANIFEST`. Mirrors the POSIX-first normalization
 * used in the generator, so Windows callers (`path.join` with backslashes)
 * still resolve correctly.
 */
function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * List template names that ship with the CLI.
 *
 * The order is deterministic (generator-defined) and stable across builds —
 * tests rely on it.
 */
export function listTemplates(): readonly string[] {
  return Array.from(TEMPLATE_MANIFEST.keys());
}

/**
 * Return the set of files for a named template, or `null` if the template
 * is unknown. Entries are sorted by POSIX `relPath` so callers can rely on
 * a stable iteration order (needed for directory-first creation logic).
 */
export function loadTemplate(name: string): readonly EmbeddedTemplateFile[] | null {
  const inner = TEMPLATE_MANIFEST.get(name);
  if (!inner) return null;

  const out: EmbeddedTemplateFile[] = [];
  for (const [relPath, embeddedPath] of inner) {
    out.push({ relPath, embeddedPath });
  }
  // Map iteration order already matches generator output (sorted), but we
  // re-sort defensively so downstream copy loops are guaranteed deterministic
  // even if someone hand-edits the generated file.
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/**
 * Read the contents of a single template file as UTF-8 text. Returns `null`
 * when either the template or the relative path is unknown. Binary files
 * (none currently shipped, but reserved for future use) should prefer
 * `readTemplateFileBytes` to avoid UTF-8 corruption.
 */
export async function readTemplateFile(
  name: string,
  relPath: string
): Promise<string | null> {
  const embeddedPath = resolveEmbeddedPath(name, relPath);
  if (!embeddedPath) return null;
  const file = Bun.file(embeddedPath);
  if (!(await file.exists())) return null;
  return file.text();
}

/**
 * Read the raw bytes of a single template file. Same null semantics as
 * `readTemplateFile`. Callers that need to write to disk should use this
 * variant to preserve exact byte sequences (e.g. binary assets, files with
 * non-UTF-8 encodings in future templates).
 */
export async function readTemplateFileBytes(
  name: string,
  relPath: string
): Promise<Uint8Array | null> {
  const embeddedPath = resolveEmbeddedPath(name, relPath);
  if (!embeddedPath) return null;
  const file = Bun.file(embeddedPath);
  if (!(await file.exists())) return null;
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Resolve a (template, relPath) pair to the embedded path string, or `null`
 * when either lookup misses. Exposed for callers that want their own read
 * semantics (e.g. streaming).
 */
export function resolveEmbeddedPath(name: string, relPath: string): string | null {
  const inner = TEMPLATE_MANIFEST.get(name);
  if (!inner) return null;
  const normalized = normalizeRelPath(relPath);
  return inner.get(normalized) ?? null;
}

/** Total file count — useful for sanity checks in tests and CLI diagnostics. */
export function getEmbeddedFileCount(): number {
  return EMBEDDED_FILE_COUNT;
}
