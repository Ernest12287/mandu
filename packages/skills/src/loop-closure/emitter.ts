/**
 * Loop Closure — Emitter
 *
 * Composes a structured "next prompt" from detector evidence. The emitter
 * is **pure**: it performs no I/O, spawns no processes, and touches no
 * filesystem. It returns prompt text that a human or orchestrator can
 * choose to feed back into the agent.
 *
 * Design invariants:
 *   - Identical evidence lists produce identical prompts (deterministic).
 *   - Evidence ordering drives reason-selection — the first non-empty
 *     category in `priority` wins `stallReason`.
 *   - The prompt is advisory, never an instruction to exec / write files.
 */

import type { Evidence, EvidenceKind, LoopClosureReport } from "./types.js";

// Priority ordering. Earlier = higher severity.
const PRIORITY: readonly EvidenceKind[] = [
  "typecheck-error",
  "syntax-error",
  "test-failure",
  "missing-module",
  "unhandled-rejection",
  "not-implemented",
  "incomplete-function",
  "stack-trace",
  "fixme-marker",
  "todo-marker",
];

/** Human-readable label for each evidence kind. */
const LABELS: Record<EvidenceKind, string> = {
  "typecheck-error": "typecheck error",
  "syntax-error": "syntax error",
  "test-failure": "test failure",
  "missing-module": "missing module",
  "unhandled-rejection": "unhandled promise rejection",
  "not-implemented": "not-implemented stub",
  "incomplete-function": "incomplete function",
  "stack-trace": "stack frame",
  "fixme-marker": "FIXME marker",
  "todo-marker": "TODO marker",
};

/**
 * Group evidence by kind, preserving the original order within each group.
 */
function groupByKind(evidence: Evidence[]): Map<EvidenceKind, Evidence[]> {
  const groups = new Map<EvidenceKind, Evidence[]>();
  for (const ev of evidence) {
    const bucket = groups.get(ev.kind);
    if (bucket) {
      bucket.push(ev);
    } else {
      groups.set(ev.kind, [ev]);
    }
  }
  return groups;
}

/** Choose the dominant evidence kind based on `PRIORITY`. */
function pickPrimaryKind(evidence: Evidence[]): EvidenceKind | null {
  if (evidence.length === 0) return null;
  const present = new Set(evidence.map((e) => e.kind));
  for (const kind of PRIORITY) {
    if (present.has(kind)) return kind;
  }
  // Fallback: pick whatever the first evidence is.
  return evidence[0].kind;
}

/**
 * Deterministic file list: unique, sorted ascending by path.
 */
function uniqueFiles(evidence: Evidence[]): string[] {
  const seen = new Set<string>();
  for (const ev of evidence) {
    if (ev.file) seen.add(ev.file);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * Build the short reason label — the first line of the `nextPrompt`.
 */
function buildReason(primary: EvidenceKind, count: number): string {
  const label = LABELS[primary];
  return count === 1
    ? `1 ${label} detected`
    : `${count} ${label}s detected`;
}

/**
 * Turn an evidence row into a bullet line for the prompt.
 * Format: `- [kind] <file>:<line> — <snippet>`
 */
function evidenceBullet(ev: Evidence): string {
  const parts: string[] = [`- [${ev.kind}]`];
  if (ev.file) {
    parts.push(ev.line ? `${ev.file}:${ev.line}` : ev.file);
  }
  if (ev.label && ev.label !== ev.snippet) {
    parts.push(`(${ev.label})`);
  }
  parts.push(`— ${ev.snippet}`);
  return parts.join(" ");
}

/**
 * Suggest a fix for the primary evidence kind. Kept deterministic and
 * conservative — we never speculate on solutions, only on investigation
 * angles.
 */
function suggestFix(primary: EvidenceKind): string {
  switch (primary) {
    case "typecheck-error":
      return "Resolve the reported TypeScript errors. Run `bun run typecheck` to reproduce. Fix the listed files before re-running tests.";
    case "syntax-error":
      return "Fix the parser syntax error at the referenced location. Syntax errors block every downstream step.";
    case "test-failure":
      return "Investigate the failing test(s) above. Re-run with `bun test --filter=<name>` to focus. Fix the implementation, not the test, unless the expectation is wrong.";
    case "missing-module":
      return "Install or resolve the missing module. Check `package.json`, `bun.lockb`, and import paths. If it's a workspace package, verify it's built.";
    case "unhandled-rejection":
      return "An async path threw without being awaited or caught. Add a `try/catch` or `.catch()`, or ensure the promise is awaited in the call-stack above.";
    case "not-implemented":
      return "A stub has been hit at runtime. Implement the function, or short-circuit the call path if it's unreachable in this context.";
    case "incomplete-function":
      return "An empty/TODO-only function was flagged. Complete the body or remove the placeholder entirely.";
    case "fixme-marker":
      return "A FIXME marker surfaced in output. Address the referenced defect before continuing.";
    case "todo-marker":
      return "A TODO marker surfaced in output. Either complete the task or move it to the tracker.";
    case "stack-trace":
      return "A runtime crash occurred. Inspect the first stack frame — that's where the failure originated. Add defensive handling after the root cause is clear.";
    default:
      return "Review the evidence above and address the dominant failure category first.";
  }
}

/** Compose the human-readable `nextPrompt`. */
function composePrompt(
  reason: string,
  primary: EvidenceKind,
  grouped: Map<EvidenceKind, Evidence[]>,
  touchedFiles: string[],
  exitCode: number,
): string {
  const lines: string[] = [];
  lines.push(`# Stall detected: ${reason} (exit ${exitCode})`);
  lines.push("");
  lines.push(`## Fix by:`);
  lines.push(suggestFix(primary));
  lines.push("");

  // Primary evidence block (max 10 items for readability).
  // Sort by (file, line) so the output is stable & deterministic for
  // callers that compare prompts across runs.
  const primaryList = [...(grouped.get(primary) ?? [])].sort((a, b) => {
    const fa = a.file ?? "";
    const fb = b.file ?? "";
    if (fa !== fb) return fa.localeCompare(fb);
    return (a.line ?? 0) - (b.line ?? 0);
  });
  lines.push(`## Primary evidence (${LABELS[primary]}):`);
  const head = primaryList.slice(0, 10);
  for (const ev of head) {
    lines.push(evidenceBullet(ev));
  }
  if (primaryList.length > head.length) {
    lines.push(`- … and ${primaryList.length - head.length} more`);
  }
  lines.push("");

  // Other categories (count-only summary, no spam).
  const secondary: string[] = [];
  for (const kind of PRIORITY) {
    if (kind === primary) continue;
    const list = grouped.get(kind);
    if (!list || list.length === 0) continue;
    secondary.push(`- ${LABELS[kind]}: ${list.length}`);
  }
  if (secondary.length > 0) {
    lines.push(`## Other signals:`);
    for (const line of secondary) lines.push(line);
    lines.push("");
  }

  // Files touched — absolute paths preserved, sorted, deduped.
  if (touchedFiles.length > 0) {
    lines.push(`## Files touched:`);
    for (const f of touchedFiles.slice(0, 25)) {
      lines.push(`- ${f}`);
    }
    if (touchedFiles.length > 25) {
      lines.push(`- … and ${touchedFiles.length - 25} more`);
    }
    lines.push("");
  }

  lines.push(`## Next step:`);
  lines.push(
    "Re-read the failing output, patch the listed files, then re-run the failing command to verify.",
  );
  return lines.join("\n");
}

/**
 * Empty-evidence response. `exitCode === 0` implies a successful run —
 * callers should treat this as "no stall".
 */
export function emitNoStallReport(exitCode: number): LoopClosureReport {
  const ok = exitCode === 0;
  const stallReason = ok ? "no-stall-detected" : "no-patterns-matched";
  const nextPrompt = ok
    ? "# No stall detected\nExit code is zero and no stall patterns matched. Proceed with the next planned step."
    : "# No loop-closure patterns matched\nThe command exited with a non-zero code, but none of the built-in detectors fired. Inspect the raw output manually, or add a detector if this represents a recurring pattern.";
  return { stallReason, nextPrompt, evidence: [] };
}

/**
 * Main entry: build a full report from evidence + exit code.
 *
 * This function is pure — it reads its inputs and returns a value.
 * No side effects. No time dependence. No randomness.
 */
export function emitReport(
  evidence: Evidence[],
  exitCode: number,
): LoopClosureReport {
  if (evidence.length === 0) return emitNoStallReport(exitCode);

  const primary = pickPrimaryKind(evidence);
  if (!primary) return emitNoStallReport(exitCode);

  const grouped = groupByKind(evidence);
  const primaryCount = grouped.get(primary)?.length ?? 0;
  const reason = buildReason(primary, primaryCount);
  const touchedFiles = uniqueFiles(evidence);
  const nextPrompt = composePrompt(reason, primary, grouped, touchedFiles, exitCode);

  return {
    stallReason: reason,
    nextPrompt,
    evidence,
  };
}
