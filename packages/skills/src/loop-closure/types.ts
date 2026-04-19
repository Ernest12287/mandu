/**
 * Loop Closure — Types
 *
 * A "loop closure" detector recognizes stall patterns in agent output
 * (stdout/stderr + exit code) and emits a structured `nextPrompt` that
 * a human or orchestrator can feed back into the agent. The detectors
 * themselves are *pure functions* — no I/O, no spawn, no file writes.
 *
 * Emission is advisory: the caller decides whether to act on the prompt.
 */
export type EvidenceKind =
  | "todo-marker"
  | "fixme-marker"
  | "not-implemented"
  | "unhandled-rejection"
  | "typecheck-error"
  | "test-failure"
  | "missing-module"
  | "incomplete-function"
  | "syntax-error"
  | "stack-trace";

/**
 * One detected signal. Detectors return zero or more of these per pattern.
 *
 * `file` / `line` are best-effort — detectors include them only when the
 * source output contains enough context to resolve them deterministically.
 */
export interface Evidence {
  /** Pattern category. */
  kind: EvidenceKind;
  /** File path mentioned by the signal, if any. */
  file?: string;
  /** Line number mentioned by the signal, if any. */
  line?: number;
  /** Raw snippet from the source output — trimmed, single-line where possible. */
  snippet: string;
  /** Optional secondary label — e.g. test name, error code. */
  label?: string;
}

/** Input to every detector. */
export interface DetectorInput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A detector is a pure function: (input) => evidence list.
 *
 * Must be deterministic — same input → same output. No Date.now(),
 * no Math.random(), no environment reads.
 */
export type Detector = (input: DetectorInput) => Evidence[];

/** Detector registration — keyed so callers can enable/disable. */
export interface DetectorRegistration {
  id: string;
  description: string;
  run: Detector;
}

/**
 * Final report returned by `closeLoop()`.
 *
 * - `stallReason` is a short human-readable label (primary reason).
 * - `nextPrompt` is the composed natural-language continuation message.
 * - `evidence` is the full list of all signals (may include low-priority ones).
 */
export interface LoopClosureReport {
  stallReason: string;
  nextPrompt: string;
  evidence: Evidence[];
}

/** Options for `closeLoop()`. */
export interface CloseLoopOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Restrict to specific detector IDs. Omit to run all. */
  detectors?: string[];
}
