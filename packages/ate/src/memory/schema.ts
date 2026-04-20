/**
 * Phase B.2 — memory event schema.
 *
 * One JSONL record per event. Append-only. 7 discriminated kinds per
 * docs/ate/phase-b-spec.md §B.2. Zod runtime is not a dependency of
 * this package; we validate shape with plain TypeScript guards and
 * reject malformed records at append time.
 *
 * The validator here is intentionally lenient — unknown extra keys
 * pass through (future-proofing for v2 fields) as long as the
 * required keys are present and well-typed.
 */

export type MemoryEventKind =
  | "intent_history"
  | "rejected_spec"
  | "accepted_healing"
  | "rejected_healing"
  | "prompt_version_drift"
  | "boundary_gap_filled"
  | "coverage_snapshot";

export interface IntentHistoryEvent {
  kind: "intent_history";
  timestamp: string;
  intent: string;
  routeId?: string;
  agent: string;
  resulting: { saved: string[] };
}

export interface RejectedSpecEvent {
  kind: "rejected_spec";
  timestamp: string;
  specPath: string;
  reason: string;
  routeId?: string;
}

export interface AcceptedHealingEvent {
  kind: "accepted_healing";
  timestamp: string;
  specPath: string;
  change: {
    change: string;
    old?: unknown;
    new?: unknown;
    [k: string]: unknown;
  };
  confidence: number;
}

export interface RejectedHealingEvent {
  kind: "rejected_healing";
  timestamp: string;
  specPath: string;
  change: {
    change: string;
    [k: string]: unknown;
  };
  reason: string;
}

export interface PromptVersionDriftEvent {
  kind: "prompt_version_drift";
  timestamp: string;
  /** Prompt kind (filling_unit etc). */
  kindName: string;
  oldVersion: number;
  newVersion: number;
}

export interface BoundaryGapFilledEvent {
  kind: "boundary_gap_filled";
  timestamp: string;
  contractName: string;
  probes: number;
}

export interface CoverageSnapshotEvent {
  kind: "coverage_snapshot";
  timestamp: string;
  routes: number;
  withSpec: number;
  withProperty: number;
}

export type MemoryEvent =
  | IntentHistoryEvent
  | RejectedSpecEvent
  | AcceptedHealingEvent
  | RejectedHealingEvent
  | PromptVersionDriftEvent
  | BoundaryGapFilledEvent
  | CoverageSnapshotEvent;

/** Validate + narrow. Returns null for malformed records. */
export function parseMemoryEvent(raw: unknown): MemoryEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== "string" || typeof obj.timestamp !== "string") return null;

  switch (obj.kind) {
    case "intent_history":
      if (typeof obj.intent !== "string") return null;
      if (typeof obj.agent !== "string") return null;
      if (!obj.resulting || typeof obj.resulting !== "object") return null;
      if (!Array.isArray((obj.resulting as Record<string, unknown>).saved)) return null;
      return obj as unknown as IntentHistoryEvent;
    case "rejected_spec":
      if (typeof obj.specPath !== "string") return null;
      if (typeof obj.reason !== "string") return null;
      return obj as unknown as RejectedSpecEvent;
    case "accepted_healing":
      if (typeof obj.specPath !== "string") return null;
      if (typeof obj.confidence !== "number") return null;
      if (!obj.change || typeof obj.change !== "object") return null;
      return obj as unknown as AcceptedHealingEvent;
    case "rejected_healing":
      if (typeof obj.specPath !== "string") return null;
      if (typeof obj.reason !== "string") return null;
      if (!obj.change || typeof obj.change !== "object") return null;
      return obj as unknown as RejectedHealingEvent;
    case "prompt_version_drift":
      if (typeof obj.kindName !== "string") return null;
      if (typeof obj.oldVersion !== "number" || typeof obj.newVersion !== "number") return null;
      return obj as unknown as PromptVersionDriftEvent;
    case "boundary_gap_filled":
      if (typeof obj.contractName !== "string") return null;
      if (typeof obj.probes !== "number") return null;
      return obj as unknown as BoundaryGapFilledEvent;
    case "coverage_snapshot":
      if (
        typeof obj.routes !== "number" ||
        typeof obj.withSpec !== "number" ||
        typeof obj.withProperty !== "number"
      ) {
        return null;
      }
      return obj as unknown as CoverageSnapshotEvent;
    default:
      return null;
  }
}

/** ISO-8601 UTC timestamp. §B.10 Q4. */
export function nowTimestamp(): string {
  return new Date().toISOString();
}
