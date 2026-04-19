/**
 * Loop Closure — public API.
 *
 * A loop closure detector recognizes stall patterns in agent output
 * (stdout/stderr + exit code) and emits a structured `nextPrompt`.
 *
 * SAFETY INVARIANT — enforced by design:
 *   • Detectors are pure functions (`(input) => Evidence[]`).
 *   • The emitter is a pure function (`(evidence, exit) => report`).
 *   • `closeLoop()` never touches the filesystem, spawns a process, or
 *     performs any I/O. It returns prompt text only.
 *
 * @example
 * ```ts
 * import { closeLoop } from "@mandujs/skills/loop-closure";
 *
 * const report = closeLoop({
 *   stdout: testRunStdout,
 *   stderr: testRunStderr,
 *   exitCode: 1,
 * });
 * // → { stallReason: "3 test failures detected",
 * //     nextPrompt: "# Stall detected: ...",
 * //     evidence: [...] }
 * ```
 */

import { runDetectors, DEFAULT_DETECTORS, listDetectorIds } from "./detectors.js";
import { emitReport, emitNoStallReport } from "./emitter.js";
import type { CloseLoopOptions, LoopClosureReport } from "./types.js";

export type {
  CloseLoopOptions,
  Detector,
  DetectorInput,
  DetectorRegistration,
  Evidence,
  EvidenceKind,
  LoopClosureReport,
} from "./types.js";

export {
  DEFAULT_DETECTORS,
  listDetectorIds,
  runDetectors,
  detectTodoMarkers,
  detectFixmeMarkers,
  detectNotImplemented,
  detectUnhandledRejection,
  detectTypecheckErrors,
  detectTestFailures,
  detectMissingModule,
  detectIncompleteFunction,
  detectStackTrace,
  detectSyntaxError,
} from "./detectors.js";

export { emitReport, emitNoStallReport } from "./emitter.js";

/** Hard cap on how many characters of stdout/stderr we scan per stream. */
const MAX_STREAM_CHARS = 1_000_000;

/**
 * Truncate a stream to the last `MAX_STREAM_CHARS` characters. We keep the
 * *tail* because error banners and failure summaries live at the end of
 * the output; early boilerplate rarely carries useful stall signals.
 */
function clampStream(raw: string): string {
  if (raw.length <= MAX_STREAM_CHARS) return raw;
  return raw.slice(-MAX_STREAM_CHARS);
}

/**
 * Run all (or a selected subset of) detectors against the given output
 * and emit a structured loop-closure report.
 *
 * The function is **pure** — same input → same output, no side effects.
 */
export function closeLoop(options: CloseLoopOptions = {}): LoopClosureReport {
  const stdout =
    typeof options.stdout === "string" ? clampStream(options.stdout) : "";
  const stderr =
    typeof options.stderr === "string" ? clampStream(options.stderr) : "";
  const exitCode =
    typeof options.exitCode === "number" && Number.isFinite(options.exitCode)
      ? Math.trunc(options.exitCode)
      : 0;

  if (!stdout && !stderr) {
    return emitNoStallReport(exitCode);
  }

  const evidence = runDetectors({ stdout, stderr, exitCode }, options.detectors);
  return emitReport(evidence, exitCode);
}
