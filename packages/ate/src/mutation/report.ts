/**
 * Phase C.2 — mutation report.
 *
 * Aggregate `MutationResult[]` into a single report the MCP tool and CLI
 * surface. Assigns severity to survivors (per spec §C.2.3):
 *
 *   - skip_middleware / bypass_validation survivors ⇒ "high"
 *   - narrow_type / swap_sibling_type / rename_field ⇒ "medium"
 *   - everything else ⇒ "low"
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutationOperatorName } from "./operators";
import type { MutationResult } from "./runner";

export type MutationSeverity = "high" | "medium" | "low";

export interface MutationSurvivor {
  id: string;
  operator: MutationOperatorName;
  description: string;
  line?: number;
  severity: MutationSeverity;
  reason: string;
}

export interface MutationReport {
  totalMutations: number;
  killed: number;
  survived: number;
  timeout: number;
  error: number;
  /** Killed / (killed + survived) — timeouts / errors excluded. */
  mutationScore: number;
  survivorsBySeverity: MutationSurvivor[];
  byOperator: Record<string, { total: number; killed: number; survived: number }>;
}

const SEVERITY_HIGH: Readonly<Set<MutationOperatorName>> = new Set([
  "skip_middleware",
  "bypass_validation",
]);

const SEVERITY_MEDIUM: Readonly<Set<MutationOperatorName>> = new Set([
  "narrow_type",
  "swap_sibling_type",
  "rename_field",
]);

function severityFor(op: MutationOperatorName): MutationSeverity {
  if (SEVERITY_HIGH.has(op)) return "high";
  if (SEVERITY_MEDIUM.has(op)) return "medium";
  return "low";
}

function reasonFor(op: MutationOperatorName): string {
  switch (op) {
    case "remove_required_field":
      return "no spec exercises missing-required-field path";
    case "narrow_type":
      return "spec does not probe wide-type range of this field";
    case "widen_enum":
      return "spec does not reject unknown enum values";
    case "flip_nullable":
      return "spec does not probe null-vs-value branch";
    case "rename_field":
      return "spec does not check snake/camel-case drift";
    case "swap_sibling_type":
      return "spec does not probe type-mismatch path";
    case "skip_middleware":
      return "spec does not exercise middleware (csrf / rate-limit / auth)";
    case "early_return":
      return "spec does not validate response content / shape";
    case "bypass_validation":
      return "spec does not exercise invalid-input Zod path";
    default:
      return "no spec exercises this mutation path";
  }
}

export function computeMutationReport(results: MutationResult[]): MutationReport {
  const byOperator: MutationReport["byOperator"] = {};
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let error = 0;
  const survivors: MutationSurvivor[] = [];

  for (const r of results) {
    const bucket = byOperator[r.operator] ?? { total: 0, killed: 0, survived: 0 };
    bucket.total++;
    byOperator[r.operator] = bucket;

    switch (r.status) {
      case "killed":
        killed++;
        bucket.killed++;
        break;
      case "survived":
        survived++;
        bucket.survived++;
        survivors.push({
          id: r.id,
          operator: r.operator,
          description: r.description,
          line: r.line,
          severity: severityFor(r.operator),
          reason: reasonFor(r.operator),
        });
        break;
      case "timeout":
        timeout++;
        break;
      case "error":
        error++;
        break;
    }
  }

  // Sort survivors: high → medium → low, then by id.
  const rank: Record<MutationSeverity, number> = { high: 0, medium: 1, low: 2 };
  survivors.sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));

  const denom = killed + survived;
  const mutationScore = denom === 0 ? 0 : killed / denom;

  return {
    totalMutations: results.length,
    killed,
    survived,
    timeout,
    error,
    mutationScore,
    survivorsBySeverity: survivors,
    byOperator,
  };
}

export interface PersistedMutationRun {
  targetFile: string;
  totalGenerated: number;
  totalExecuted: number;
  generatedAt: string;
  results: MutationResult[];
}

/**
 * Load the last persisted run — used by `mandu_ate_mutation_report`.
 */
export function loadLastMutationRun(repoRoot: string): PersistedMutationRun | null {
  const path = join(repoRoot, ".mandu", "ate-mutations", "last-run.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PersistedMutationRun;
  } catch {
    return null;
  }
}
