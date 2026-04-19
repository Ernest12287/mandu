/**
 * @mandujs/core/testing/snapshot
 *
 * `toMatchSnapshot()` assertion helper for Mandu tests — mirrors the Jest
 * API but without the Jest runtime. Snapshots live next to the source
 * file as `__snapshots__/<basename>.snap` and are plain JSON for easy
 * review under `git diff`.
 *
 * ## Why a custom implementation?
 *
 * `bun test` ships its own `toMatchSnapshot`, but it (a) stores files as
 * a non-JSON textual format with newline escaping, (b) has no hook for
 * output normalization, and (c) cannot be invoked imperatively outside
 * of `expect()`. Mandu tests frequently capture generated code, routes
 * manifests, and CLI output — all of which need deterministic scrubbing
 * of timestamps, absolute paths, and random IDs before comparison.
 *
 * This module provides:
 *
 * - `matchSnapshot(value, options)` — pure function returning a
 *   `SnapshotResult`. No dependency on a test runner — callable from
 *   CLI scripts, golden-file tools, or ATE's oracle.
 * - `toMatchSnapshot(value, name)` — test-binding that throws on
 *   mismatch. Designed to be called from `bun:test` `it()` blocks.
 * - Update-in-place via `UPDATE_SNAPSHOTS=1` (or passing
 *   `update: true` programmatically).
 *
 * ## Determinism contract
 *
 * Comparison uses `JSON.stringify` with a **stable key ordering**. This
 * means snapshots are invariant under object-key reordering — which
 * prevents spurious diffs when a handler adds/removes unrelated keys.
 * Arrays preserve order (they are semantically ordered).
 *
 * For timestamps, UUIDs, and other non-deterministic values, pass a
 * `normalize` function that replaces them with stable placeholders
 * before comparison. The tests in `tests/testing/snapshot.test.ts`
 * demonstrate the common patterns.
 *
 * ## Storage layout
 *
 * ```
 * myfeature.test.ts
 * __snapshots__/
 *   myfeature.test.ts.snap   ← JSON map { "snapshot name": "stringified value" }
 * ```
 *
 * The snapshot file is one JSON object — a map of snapshot names to their
 * stringified values. This lets a single test file own many named
 * snapshots (`toMatchSnapshot(x, "user profile")`,
 * `toMatchSnapshot(y, "settings")`) without spamming the filesystem.
 *
 * @module testing/snapshot
 */

import fs from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Options accepted by `matchSnapshot` / `toMatchSnapshot`. */
export interface SnapshotOptions {
  /**
   * Snapshot file path. When omitted, the caller must supply `testFile`
   * so we can derive `<dir>/__snapshots__/<basename>.snap` automatically.
   */
  snapshotPath?: string;
  /**
   * Path to the test file the snapshot belongs to. Used to derive
   * `snapshotPath` when it is not passed explicitly.
   */
  testFile?: string;
  /** Named key inside the snapshot file. Defaults to "default". */
  name?: string;
  /**
   * Force update-in-place regardless of the `UPDATE_SNAPSHOTS` env var.
   * Useful in golden-file generators or one-shot scripts.
   */
  update?: boolean;
  /**
   * Pre-comparison transform. Useful to scrub timestamps, random IDs,
   * or absolute paths so the stored snapshot is stable across runs and
   * machines.
   */
  normalize?: (value: unknown) => unknown;
}

/** Outcome of a snapshot comparison. */
export interface SnapshotResult {
  /** True when the stored snapshot matches (or we just wrote it). */
  readonly match: boolean;
  /** True when the file did not exist and we created it. */
  readonly created: boolean;
  /** True when we overwrote an existing snapshot (update mode). */
  readonly updated: boolean;
  /** The serialized form of the value being snapshotted. */
  readonly actual: string;
  /** The stored snapshot — `null` when the file did not exist. */
  readonly expected: string | null;
  /** Absolute path of the snapshot file. */
  readonly snapshotPath: string;
  /** The key inside the snapshot file. */
  readonly name: string;
  /**
   * Minimal unified-style diff when `match === false`. Empty string
   * on match or when the snapshot was just created.
   */
  readonly diff: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Serialization — deterministic JSON
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stringify `value` with deterministic, sorted object keys. Arrays keep
 * their order (order is semantically meaningful for arrays). Undefined
 * values and functions become `null` so the output is valid JSON across
 * all runtimes.
 *
 * Two-space indent matches `git diff` expectations and keeps snapshots
 * reviewable in PRs. The trailing newline is intentional — `echo` /
 * `cat` don't clobber the last line.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const replacer = (val: unknown): unknown => {
    if (val === null || typeof val !== "object") return val;
    if (seen.has(val as object)) return "[Circular]";
    seen.add(val as object);

    if (Array.isArray(val)) {
      return val.map(replacer);
    }

    // Dates / RegExps / Errors — serialize by toString() so they compare by
    // value instead of structure (empty-object serialization would hide real
    // differences).
    if (val instanceof Date) return `[Date ${val.toISOString()}]`;
    if (val instanceof RegExp) return `[RegExp ${val.toString()}]`;
    if (val instanceof Error) return `[Error ${val.name}: ${val.message}]`;
    if (val instanceof Map) {
      const entries: Array<[string, unknown]> = [];
      for (const [k, v] of val.entries()) {
        entries.push([String(k), replacer(v)]);
      }
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return { __type: "Map", entries };
    }
    if (val instanceof Set) {
      const items = Array.from(val.values()).map(replacer);
      return { __type: "Set", items };
    }

    const rec = val as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = rec[k];
      // Drop undefined/function keys — JSON cannot represent them and we
      // want the snapshot to elide them rather than fail serialization.
      if (typeof v === "function" || typeof v === "undefined") continue;
      out[k] = replacer(v);
    }
    return out;
  };

  const normalized = replacer(value);
  const serialized = JSON.stringify(normalized, null, 2);
  return `${serialized ?? "null"}\n`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Storage IO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the default snapshot path from a test file: co-locate in a
 * `__snapshots__/` directory next to the test.
 */
export function deriveSnapshotPath(testFile: string): string {
  const dir = path.dirname(testFile);
  const base = path.basename(testFile);
  return path.join(dir, "__snapshots__", `${base}.snap`);
}

interface SnapshotFile {
  readonly snapshots: Record<string, string>;
}

function readSnapshotFile(snapshotPath: string): SnapshotFile | null {
  if (!fs.existsSync(snapshotPath)) return null;
  const raw = fs.readFileSync(snapshotPath, "utf8");
  if (!raw.trim()) return { snapshots: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).snapshots !== "object" ||
      (parsed as Record<string, unknown>).snapshots === null
    ) {
      // Legacy / corrupt file — treat as empty so we don't explode in CI.
      return { snapshots: {} };
    }
    const raw_snapshots = (parsed as { snapshots: Record<string, unknown> }).snapshots;
    const snapshots: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw_snapshots)) {
      if (typeof v === "string") snapshots[k] = v;
    }
    return { snapshots };
  } catch {
    return { snapshots: {} };
  }
}

function writeSnapshotFile(snapshotPath: string, file: SnapshotFile): void {
  const dir = path.dirname(snapshotPath);
  fs.mkdirSync(dir, { recursive: true });
  // Sort keys deterministically so new additions don't reshuffle the file.
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(file.snapshots).sort()) {
    sorted[key] = file.snapshots[key];
  }
  const body = `${JSON.stringify({ snapshots: sorted }, null, 2)}\n`;
  fs.writeFileSync(snapshotPath, body, "utf8");
}

// ═══════════════════════════════════════════════════════════════════════════
// Diff — tiny line-based delta for failure messages
// ═══════════════════════════════════════════════════════════════════════════

function computeDiff(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  const out: string[] = [];
  out.push("--- expected (stored snapshot)");
  out.push("+++ actual   (current value)");
  for (let i = 0; i < max; i++) {
    const e = expectedLines[i];
    const a = actualLines[i];
    if (e === a) {
      if (e !== undefined) out.push(`  ${e}`);
    } else {
      if (e !== undefined) out.push(`- ${e}`);
      if (a !== undefined) out.push(`+ ${a}`);
    }
  }
  return out.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whether update-in-place mode is active for this process.
 *
 * Controlled by the `UPDATE_SNAPSHOTS=1` environment variable. Any
 * truthy value (`"1"`, `"true"`) activates. Exported for callers that
 * want to emit different log output in update mode.
 */
export function isUpdateMode(): boolean {
  const raw = process.env.UPDATE_SNAPSHOTS;
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Compare `value` against the stored snapshot at the resolved path.
 *
 * This is a pure function — it does not throw. Callers decide whether
 * to fail the test (`toMatchSnapshot`) or surface the result some other
 * way (`matchSnapshot()` in a CLI golden-file script).
 */
export function matchSnapshot(
  value: unknown,
  options: SnapshotOptions = {},
): SnapshotResult {
  const snapshotPath =
    options.snapshotPath ??
    (options.testFile ? deriveSnapshotPath(options.testFile) : undefined);

  if (!snapshotPath) {
    throw new TypeError(
      "[testing/snapshot] matchSnapshot requires either snapshotPath or testFile.",
    );
  }

  const name = options.name ?? "default";
  const normalized = options.normalize ? options.normalize(value) : value;
  const actual = stableStringify(normalized);

  const existingFile = readSnapshotFile(snapshotPath);
  const existing = existingFile?.snapshots[name] ?? null;
  const shouldUpdate = options.update ?? isUpdateMode();

  // First-time capture → write without comparing. Treat this as a pass so
  // new tests don't spuriously fail on the first run. CI environments can
  // guard against accidental captures by running with `CI=true` and
  // enforcing `existing !== null` at a higher layer if needed.
  if (existing === null) {
    const next: SnapshotFile = {
      snapshots: {
        ...(existingFile?.snapshots ?? {}),
        [name]: actual,
      },
    };
    writeSnapshotFile(snapshotPath, next);
    return {
      match: true,
      created: true,
      updated: false,
      actual,
      expected: null,
      snapshotPath,
      name,
      diff: "",
    };
  }

  if (existing === actual) {
    return {
      match: true,
      created: false,
      updated: false,
      actual,
      expected: existing,
      snapshotPath,
      name,
      diff: "",
    };
  }

  if (shouldUpdate) {
    const next: SnapshotFile = {
      snapshots: {
        ...(existingFile?.snapshots ?? {}),
        [name]: actual,
      },
    };
    writeSnapshotFile(snapshotPath, next);
    return {
      match: true,
      created: false,
      updated: true,
      actual,
      expected: existing,
      snapshotPath,
      name,
      diff: "",
    };
  }

  return {
    match: false,
    created: false,
    updated: false,
    actual,
    expected: existing,
    snapshotPath,
    name,
    diff: computeDiff(existing, actual),
  };
}

/**
 * Test-suite binding. Calls `matchSnapshot()` and throws a well-formed
 * `Error` on mismatch so `bun test` / `jest` display a clear failure.
 *
 * `name` defaults to the caller-supplied string (recommended) — omit
 * it only when a single snapshot per test is sufficient.
 */
export function toMatchSnapshot(
  value: unknown,
  options: SnapshotOptions | string = {},
): SnapshotResult {
  const opts: SnapshotOptions =
    typeof options === "string" ? { name: options } : options;

  const result = matchSnapshot(value, opts);

  if (!result.match) {
    const header =
      `Snapshot mismatch: ${result.name}\n  snapshot: ${result.snapshotPath}\n  ` +
      `Run with UPDATE_SNAPSHOTS=1 to accept the new value.\n`;
    throw new Error(`${header}\n${result.diff}`);
  }

  return result;
}

/**
 * Convenience normalizer: scrub values that change every run.
 *
 * Replaces:
 *  - ISO-8601 timestamps → `"<timestamp>"`
 *  - Unix epoch millis    → `"<timestamp>"`
 *  - UUIDs (v4 + v7)      → `"<uuid>"`
 *  - Absolute file paths  → `"<abs path>"`
 *
 * Applied recursively to strings. Non-string values pass through.
 */
export function scrubVolatile(value: unknown): unknown {
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
  const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  // Absolute-ish paths: POSIX (/a/b) or Windows (C:\a\b). We intentionally do
  // not scrub short paths like `/foo` that might appear in URLs.
  const WIN_ABS = /[A-Z]:\\[^\s"']+/g;
  const POSIX_ABS = /\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+){2,}/g;

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v
        .replace(ISO, "<timestamp>")
        .replace(UUID, "<uuid>")
        .replace(WIN_ABS, "<abs path>")
        .replace(POSIX_ABS, "<abs path>");
    }
    if (typeof v === "number") {
      // Epoch millis in the last ~50 years → placeholder.
      if (Number.isInteger(v) && v > 1_000_000_000_000 && v < 10_000_000_000_000) {
        return "<timestamp>";
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };

  return walk(value);
}
