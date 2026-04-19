/**
 * Markdown → ANSI renderer for Mandu CLI UX (Phase 9a)
 *
 * Thin wrapper around `Bun.markdown.ansi` that honors NO_COLOR / TTY /
 * CI / `opts.plain` via the shared `isRich()` detector and degrades
 * gracefully to a plain-text fallback when either the runtime API is
 * unavailable or rich output is not supported by the current terminal.
 *
 * @see docs/bun/phase-9-diagnostics/markdown-cli-ux.md
 */
import { isRich } from "../terminal/theme.js";

export interface RenderOptions {
  /**
   * Force plain text output regardless of terminal capabilities.
   * Default: auto (determined by `isRich()`).
   */
  plain?: boolean;
  /**
   * Maximum column width to use when wrapping rendered output.
   * Default: `process.stdout.columns` or `80`.
   */
  columns?: number;
  /**
   * Enable OSC 8 clickable hyperlinks (modern terminals).
   * Default: follows the rich-output decision.
   */
  hyperlinks?: boolean;
}

/**
 * Minimal structural shape we rely on from `Bun.markdown.ansi`.
 * We intentionally avoid the full Bun-types declaration so that the CLI
 * keeps compiling on toolchains where those types lag the runtime.
 */
interface MarkdownAnsiTheme {
  colors?: boolean;
  columns?: number;
  hyperlinks?: boolean;
}

interface BunMarkdownLike {
  ansi(input: string, theme?: MarkdownAnsiTheme): string;
}

function getBunMarkdown(): BunMarkdownLike | null {
  // Accessing via `globalThis` avoids a static dependency on Bun types.
  const bun = (globalThis as { Bun?: { markdown?: unknown } }).Bun;
  const md = bun?.markdown as { ansi?: unknown } | undefined;
  if (!md || typeof md.ansi !== "function") return null;
  return md as BunMarkdownLike;
}

/**
 * Render Markdown input to ANSI-colored terminal output.
 *
 * - Honors `NO_COLOR`, `FORCE_COLOR`, non-TTY, `TERM=dumb` via `isRich()`.
 * - Falls back to plain text when `Bun.markdown` is unavailable (e.g.
 *   non-Bun runtime, older Bun, or an unexpected runtime error).
 * - Returns the input untouched when both the markdown engine and the
 *   plain fallback would agree (pure prose).
 */
export function renderMarkdown(source: string, opts: RenderOptions = {}): string {
  if (typeof source !== "string") return "";
  const rich = !opts.plain && isRich();
  if (!rich) {
    return plainFallback(source);
  }
  const md = getBunMarkdown();
  if (!md) return plainFallback(source);
  try {
    const columns = resolveColumns(opts.columns);
    const hyperlinks = opts.hyperlinks ?? true;
    return md.ansi(source, {
      colors: true,
      columns,
      hyperlinks,
    });
  } catch {
    return plainFallback(source);
  }
}

/**
 * Remove common Markdown markup so the result is still readable as plain
 * text in CI logs, file captures, or color-blocked environments.
 *
 * We keep the fallback deliberately small — just enough to avoid noise
 * from fences, inline code, bold, and link syntax. Headings and lists
 * are left untouched because the surrounding `#`, `-`, or `1.` still
 * reads naturally in plain output.
 */
export function plainFallback(source: string): string {
  if (!source) return "";
  return source
    // fenced code blocks: ```lang\n...\n``` → inner body
    .replace(/```[\w-]*\r?\n([\s\S]*?)```/g, "$1")
    // inline code: `foo` → foo
    .replace(/`([^`\n]+)`/g, "$1")
    // bold: **foo** → foo
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    // link: [label](url) → label
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
}

function resolveColumns(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) return cols;
  return 80;
}
