/**
 * Mandu Guard — oxlint type-aware bridge.
 *
 * Spawns `oxlint --type-aware` as a one-shot child process, translates the
 * JSON diagnostic stream into Mandu's `Violation` contract, and returns a
 * merged `{ violations, summary }` envelope that the `guard` runner /
 * MCP surface can slot in next to the architecture-layer results.
 *
 * ## Contract
 *
 *   - Bridge never throws for "oxlint not installed" — returns
 *     `{ skipped: "oxlint-not-installed" }` so the architecture check keeps
 *     running. The bridge DOES throw on malformed JSON output or spawn
 *     errors, because those are operator-visible bugs (e.g. a stale
 *     oxlint binary) that should fail loudly rather than silently.
 *   - Child process is invoked with `cwd: projectRoot`, `stdout: "pipe"`,
 *     `stderr: "pipe"`, and a 60-second timeout (configurable via the
 *     `MANDU_TSGOLINT_TIMEOUT_MS` env override for slow CI agents).
 *   - Exit code is NOT treated as authoritative — oxlint exits non-zero
 *     when ANY diagnostic is emitted, even warnings. We always parse
 *     stdout; stderr is captured for diagnostics but does not override the
 *     JSON body.
 *
 * ## oxlint JSON shape (oxlint >= 1.61)
 *
 * ```json
 * {
 *   "diagnostics": [
 *     {
 *       "message": "Unexpected `any`. Specify a different type.",
 *       "code": "typescript-eslint(no-explicit-any)",
 *       "severity": "error" | "warning" | "advice",
 *       "filename": "src/foo.ts",
 *       "labels": [{ "span": { "offset": N, "length": N, "line": N, "column": N } }],
 *       "help": "...",
 *       "url": "https://oxc.rs/...",
 *       "causes": [],
 *       "related": []
 *     }
 *   ],
 *   "number_of_files": N,
 *   "number_of_rules": N,
 *   "start_time": N
 * }
 * ```
 *
 * @module guard/tsgolint-bridge
 */

import path from "path";
import type { Severity, Violation } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bridge invocation options.
 *
 * All fields optional — the bridge's out-of-the-box behavior is
 * `projectRoot = process.cwd()` and everything else picked up from
 * `.oxlintrc.json` at the project root.
 */
export interface TsgolintBridgeOptions {
  /**
   * Absolute path to the project root — the cwd the child process runs
   * in AND the directory the binary is resolved under (`<root>/node_modules/.bin/oxlint`).
   */
  projectRoot: string;

  /**
   * Explicit rule allowlist. When present, only these rules are reported;
   * everything else is filtered out of the bridge's returned violations
   * (oxlint itself still evaluates them, but we drop the non-matching
   * diagnostics — trading a small post-filter cost for a simpler
   * propagation path that avoids CLI rule-flag plumbing).
   *
   * Rule ids follow oxlint's `<plugin>/<rule-name>` convention
   * (`typescript/no-floating-promises`, `no-debugger`).
   *
   * Undefined / empty = "trust oxlint defaults" (respect the user's
   * `.oxlintrc.json` allowlist, emit every reported diagnostic).
   */
  rules?: string[];

  /**
   * Override every diagnostic's severity to this value. Undefined =
   * "respect oxlint's per-rule severity". Useful when a project wants
   * type-aware hits to always be warnings (soft-landing period) or
   * always errors (CI gate).
   */
  severity?: Severity | "off";

  /**
   * Custom oxlintrc path. Falls through to oxlint's default project-root
   * lookup (`.oxlintrc.json` / `.oxlintrc.jsonc`) when unset.
   */
  configPath?: string;

  /**
   * Paths to lint — file or directory globs. Defaults to the project root,
   * letting oxlint's own traversal decide which files to walk.
   */
  paths?: string[];

  /**
   * Wall-clock timeout in milliseconds. Default: 60_000 (60s).
   * `MANDU_TSGOLINT_TIMEOUT_MS` env override wins when the caller
   * leaves this undefined.
   */
  timeoutMs?: number;
}

/**
 * Bridge result envelope.
 *
 * Always returns an object — callers that need to branch on "skipped"
 * narrow via the `skipped` discriminator. Shape stays stable whether
 * oxlint was invoked or not so the CLI / MCP renderer has a single
 * code path.
 */
export interface TsgolintBridgeResult {
  /** Violations translated into Mandu's contract (empty on skip). */
  violations: Violation[];
  /** Per-run summary metadata. */
  summary: TsgolintBridgeSummary;
  /** When present, oxlint was not invoked and `violations` is empty. */
  skipped?: TsgolintBridgeSkipReason;
}

export interface TsgolintBridgeSummary {
  /** Rule ids that actually fired (post-filter). Empty on skip. */
  rulesEnabled: string[];
  /** Wall-clock time spent in the child process (ms). 0 on skip. */
  elapsedMs: number;
  /** Total diagnostics seen BEFORE the rule filter. */
  diagnosticsReceived: number;
  /** Number of files oxlint reported walking. 0 on skip. */
  filesAnalyzed: number;
  /** Non-empty stderr, if any (diagnostic hint for operators). */
  stderr?: string;
}

export type TsgolintBridgeSkipReason =
  | "oxlint-not-installed"
  | "severity-off";

// ═══════════════════════════════════════════════════════════════════════════
// oxlint JSON shape (internal — not re-exported; the bridge is the contract)
// ═══════════════════════════════════════════════════════════════════════════

interface OxlintLabelSpan {
  offset: number;
  length: number;
  line: number;
  column: number;
}

interface OxlintLabel {
  span: OxlintLabelSpan;
  message?: string;
}

interface OxlintDiagnostic {
  message: string;
  /** e.g. `typescript-eslint(no-floating-promises)` or `no-debugger`. */
  code?: string;
  severity?: "error" | "warning" | "advice";
  filename?: string;
  labels?: OxlintLabel[];
  help?: string;
  url?: string;
  causes?: unknown[];
  related?: unknown[];
}

interface OxlintJsonOutput {
  diagnostics: OxlintDiagnostic[];
  number_of_files?: number;
  number_of_rules?: number;
  threads_count?: number;
  start_time?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Binary resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the oxlint binary under `<root>/node_modules/.bin/`.
 *
 * Windows: prefer `.exe` then `.cmd`. POSIX: the extensionless shim.
 * Returns `undefined` when no candidate exists so the bridge can
 * emit the `oxlint-not-installed` skip reason without touching the
 * filesystem again.
 *
 * `Bun.file(path).exists()` is async but we stay sync here on purpose —
 * the bridge entry point is already async and this keeps the callsite's
 * control flow linear (`await resolveOxlintBinary(root)`).
 */
export async function resolveOxlintBinary(rootDir: string): Promise<string | undefined> {
  const binDir = path.join(rootDir, "node_modules", ".bin");
  const candidates =
    process.platform === "win32"
      ? ["oxlint.exe", "oxlint.cmd", "oxlint"]
      : ["oxlint"];

  for (const name of candidates) {
    const full = path.join(binDir, name);
    if (await Bun.file(full).exists()) {
      return full;
    }
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Diagnostic translation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract the canonical rule id from an oxlint `code` field.
 *
 * oxlint emits either:
 *   - `no-debugger`                            → `no-debugger`
 *   - `typescript-eslint(no-floating-promises)` → `typescript/no-floating-promises`
 *
 * We normalize the second form to the `.oxlintrc.json` rule-id shape
 * (`typescript/no-floating-promises`) so callers can match against
 * their config-level allowlist without a plugin-name-translation table.
 */
export function extractRuleId(code: string | undefined): string {
  if (!code) return "unknown";
  const parenStart = code.indexOf("(");
  const parenEnd = code.lastIndexOf(")");
  if (parenStart > 0 && parenEnd > parenStart) {
    const plugin = code.slice(0, parenStart);
    const ruleName = code.slice(parenStart + 1, parenEnd);
    // typescript-eslint → typescript; eslint → (bare); unicorn → unicorn
    const normalizedPlugin =
      plugin === "typescript-eslint"
        ? "typescript"
        : plugin === "eslint"
          ? ""
          : plugin;
    return normalizedPlugin ? `${normalizedPlugin}/${ruleName}` : ruleName;
  }
  return code;
}

/**
 * Map oxlint severity strings onto Mandu's `Severity` vocabulary.
 *
 *   - `error`   → `error`
 *   - `warning` → `warn`
 *   - `advice`  → `info`
 *   - anything else → `warn` (conservative default; unknown severity
 *     shouldn't silently disappear as `info`).
 */
export function mapOxlintSeverity(raw: string | undefined): Severity {
  if (raw === "error") return "error";
  if (raw === "warning") return "warn";
  if (raw === "advice") return "info";
  return "warn";
}

/**
 * Translate a single oxlint diagnostic into a Mandu `Violation`.
 *
 * Type-aware lint hits don't naturally fit the architecture-layer
 * shape (no `fromLayer` / `toLayer`). We populate those fields with
 * sentinel values (`"type-aware"` / `"<file>"`) so consumers that
 * iterate violations uniformly don't crash on undefined, while the
 * `ruleName` / `ruleDescription` carry the real signal.
 */
export function translateDiagnostic(
  diag: OxlintDiagnostic,
  projectRoot: string,
  severityOverride?: Severity,
): Violation {
  const label = diag.labels?.[0]?.span;
  const line = label?.line ?? 1;
  const column = label?.column ?? 1;
  const ruleId = extractRuleId(diag.code);
  const severity = severityOverride ?? mapOxlintSeverity(diag.severity);
  const filePath = diag.filename
    ? path.isAbsolute(diag.filename)
      ? diag.filename
      : path.join(projectRoot, diag.filename)
    : projectRoot;

  const suggestions: string[] = [];
  if (diag.help) suggestions.push(diag.help);
  if (diag.url) suggestions.push(`Docs: ${diag.url}`);

  return {
    // Architectural violation types don't cover lint hits; we reuse
    // `file-type` (the nearest category — "something about the file
    // itself is wrong") so downstream reporters that switch on `type`
    // don't fall into an "unknown enum" default branch.
    type: "file-type",
    filePath,
    line,
    column,
    importStatement: "",
    importPath: "",
    fromLayer: "type-aware",
    toLayer: "type-aware",
    ruleName: ruleId,
    ruleDescription: diag.message,
    severity,
    allowedLayers: [],
    suggestions,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default wall-clock cap for the child process.
 *
 * 60s matches the scope constraint. `MANDU_TSGOLINT_TIMEOUT_MS` env
 * override handles the "my CI agent is slow" case without code changes.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run `oxlint --type-aware` and return translated violations.
 *
 * Never throws for "oxlint binary missing" — returns a skip envelope
 * so the surrounding Guard pipeline stays on the happy path. DOES
 * throw on malformed JSON output or unexpected spawn failures so
 * operators see the real error.
 *
 * @example
 * ```ts
 * const { violations, summary, skipped } = await runTsgolint({
 *   projectRoot: process.cwd(),
 * });
 * if (skipped === "oxlint-not-installed") {
 *   console.warn("oxlint not installed — skipping type-aware lint");
 * }
 * ```
 */
export async function runTsgolint(
  options: TsgolintBridgeOptions,
): Promise<TsgolintBridgeResult> {
  const {
    projectRoot,
    rules,
    severity,
    configPath,
    paths,
    timeoutMs,
  } = options;

  // Severity "off" short-circuits before we touch the filesystem.
  // The caller used to have to gate on this themselves; moving the
  // check here centralizes the "no work needed" path and gives the
  // summary / skipped fields a consistent shape.
  if (severity === "off") {
    return {
      violations: [],
      summary: {
        rulesEnabled: [],
        elapsedMs: 0,
        diagnosticsReceived: 0,
        filesAnalyzed: 0,
      },
      skipped: "severity-off",
    };
  }

  const binary = await resolveOxlintBinary(projectRoot);
  if (!binary) {
    return {
      violations: [],
      summary: {
        rulesEnabled: [],
        elapsedMs: 0,
        diagnosticsReceived: 0,
        filesAnalyzed: 0,
      },
      skipped: "oxlint-not-installed",
    };
  }

  // Build argv.
  //
  // `--type-aware` toggles tsgolint rules; `--format=json` gives us the
  // structured envelope we parse above. We deliberately do NOT forward
  // `rules` as `-D <rule>` flags — oxlint rule-flag semantics interact
  // non-trivially with categories (enabling `typescript/no-explicit-any`
  // with `-D` would also re-enable the whole `correctness` category
  // on some oxlint versions). Post-filtering keeps the behavior
  // predictable at the cost of a small wasted-work penalty.
  const argv: string[] = [binary, "--type-aware", "--format=json"];
  if (configPath) {
    argv.push("--config", configPath);
  }
  for (const p of paths ?? []) argv.push(p);

  const envTimeout = (() => {
    const raw = process.env.MANDU_TSGOLINT_TIMEOUT_MS;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  const timeout = timeoutMs ?? envTimeout ?? DEFAULT_TIMEOUT_MS;

  const started = performance.now();

  // Bun.spawn doesn't expose a built-in timeout knob the same way node
  // child_process does, so we race the `exited` promise against a
  // setTimeout that explicitly kills the process. Follows the
  // Mandu/MCP convention (see #136, runCommand Promise.race timeout).
  const proc = Bun.spawn(argv, {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* process already gone */
    }
  }, timeout);

  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = Math.round(performance.now() - started);

  if (timedOut) {
    throw new Error(
      `oxlint --type-aware timed out after ${timeout}ms ` +
        `(MANDU_TSGOLINT_TIMEOUT_MS to override). stderr: ${stderr.slice(0, 400)}`,
    );
  }

  // Empty stdout with non-zero exit = binary detonated before writing
  // anything (missing node_modules, permissions, etc.). Surface loudly.
  if (!stdout.trim()) {
    if (stderr.trim()) {
      throw new Error(
        `oxlint --type-aware produced no stdout. stderr: ${stderr.slice(0, 800)}`,
      );
    }
    // Unusual but not fatal — no files to lint.
    return {
      violations: [],
      summary: {
        rulesEnabled: [],
        elapsedMs,
        diagnosticsReceived: 0,
        filesAnalyzed: 0,
        stderr: stderr.trim() || undefined,
      },
    };
  }

  let parsed: OxlintJsonOutput;
  try {
    parsed = JSON.parse(stdout) as OxlintJsonOutput;
  } catch (cause) {
    throw new Error(
      `Failed to parse oxlint JSON output: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `First 400 chars: ${stdout.slice(0, 400)}`,
      { cause },
    );
  }

  const diagnostics = Array.isArray(parsed.diagnostics)
    ? parsed.diagnostics
    : [];
  const ruleFilter = rules && rules.length > 0 ? new Set(rules) : undefined;

  const violations: Violation[] = [];
  const rulesSeen = new Set<string>();
  for (const diag of diagnostics) {
    const ruleId = extractRuleId(diag.code);
    if (ruleFilter && !ruleFilter.has(ruleId)) continue;
    const violation = translateDiagnostic(diag, projectRoot, severity);
    violations.push(violation);
    rulesSeen.add(ruleId);
  }

  return {
    violations,
    summary: {
      rulesEnabled: [...rulesSeen].sort(),
      elapsedMs,
      diagnosticsReceived: diagnostics.length,
      filesAnalyzed: parsed.number_of_files ?? 0,
      stderr: stderr.trim() || undefined,
    },
  };
}
