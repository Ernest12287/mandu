/**
 * @mandujs/core/a11y — audit result types.
 *
 * Phase 18.χ introduces a framework-level accessibility guardrail that
 * runs axe-core against prerendered HTML and aggregates WCAG violations
 * into a structured report. axe-core and jsdom are **optional peer
 * dependencies** — we never install them for the user. When absent, the
 * runner degrades gracefully to an `"axe-missing"` outcome instead of
 * throwing or bundling ~1 MB of rules into every consumer.
 *
 * Severity mapping matches axe-core's `impact` scale verbatim so CI
 * gates using `--audit-fail-on=<impact>` speak the same vocabulary as
 * the axe documentation:
 *
 *   - `minor`    — nice-to-fix cosmetic a11y issue
 *   - `moderate` — noticeable UX degradation
 *   - `serious`  — significant barrier for users with disabilities
 *   - `critical` — blocks assistive-tech users outright (default gate)
 */

/** axe-core impact scale (lowest → highest). */
export type AuditImpact = "minor" | "moderate" | "serious" | "critical";

/** Canonical ordering used by severity comparisons. */
export const AUDIT_IMPACT_ORDER: readonly AuditImpact[] = [
  "minor",
  "moderate",
  "serious",
  "critical",
] as const;

/**
 * Return `true` when `candidate` is at least as severe as `threshold`.
 * Used by both the runner (severity filter) and the CLI gate
 * (`--audit-fail-on`).
 */
export function impactAtLeast(candidate: AuditImpact | null | undefined, threshold: AuditImpact): boolean {
  if (!candidate) return false;
  const ci = AUDIT_IMPACT_ORDER.indexOf(candidate);
  const ti = AUDIT_IMPACT_ORDER.indexOf(threshold);
  return ci >= 0 && ti >= 0 && ci >= ti;
}

/** Per-node failure detail. Keeps payloads small — we intentionally
 *  discard axe's full `any`/`all`/`none` check trees and keep only the
 *  fields humans act on (selector + failure summary). */
export interface AuditNode {
  /** CSS selector chain axe-core emits (e.g. `html > body > div#root`). */
  target: string;
  /** axe's `failureSummary` — already-localized multi-line description. */
  failureSummary: string;
  /** Raw HTML snippet for the offending node (truncated to 300 chars). */
  html?: string;
}

/** One WCAG violation emitted by axe-core, scoped to a single HTML file. */
export interface AuditViolation {
  /** Source HTML file (absolute path). */
  file: string;
  /** axe-core rule id, e.g. `color-contrast`, `label`, `image-alt`. */
  rule: string;
  /** Severity — may be `null` when axe fails to classify (rare). */
  impact: AuditImpact | null;
  /** One-line human-readable rule summary (`node.help`). */
  help: string;
  /** URL to axe-core's documentation for this rule. */
  helpUrl?: string;
  /** Offending DOM nodes. Capped at 10 to keep reports consumable. */
  nodes: AuditNode[];
  /** Phase 18.χ hint — short actionable fix recipe when we recognize the rule. */
  fixHint?: string;
}

/**
 * Audit outcome. The three arms are mutually exclusive:
 *
 *   - `ok`              — runner executed, zero violations ≥ minImpact.
 *   - `violations`      — runner executed, at least one violation fired.
 *   - `axe-missing`     — optional dep not installed; runner was a no-op.
 *
 * The `filesScanned` counter is always present so callers can print a
 * meaningful summary ("audited 12 files, 0 violations") regardless of
 * outcome.
 */
export interface AuditReport {
  outcome: "ok" | "violations" | "axe-missing";
  /** Number of HTML files actually fed to axe-core (0 when dep missing). */
  filesScanned: number;
  /** Aggregated violations across every file. Empty when `outcome !== "violations"`. */
  violations: AuditViolation[];
  /** Count of violations at each impact level. */
  impactCounts: Record<AuditImpact, number>;
  /** Effective severity filter applied during this run. */
  minImpact: AuditImpact;
  /** Optional human-readable note (e.g. why the runner skipped). */
  note?: string;
  /** Elapsed wallclock ms. Zero when runner was a no-op. */
  durationMs: number;
}

/** Options accepted by `runAudit`. */
export interface RunAuditOptions {
  /**
   * Minimum severity to include in the report. Violations below this
   * threshold are dropped at aggregation time. Default `"minor"`.
   */
  minImpact?: AuditImpact;
  /**
   * Cap on files to audit. Prevents catastrophic CI runs on projects
   * that accidentally prerender thousands of routes. Default `500`.
   */
  maxFiles?: number;
  /**
   * Override for axe-core module resolution. When undefined, the runner
   * uses dynamic `import("axe-core")`. Tests inject a fixture instead
   * of shimming the module resolver.
   */
  axeLoader?: () => Promise<unknown>;
  /**
   * Override for jsdom module resolution. Same contract as `axeLoader`;
   * returning `null` forces the runner to fall back to HappyDOM which is
   * already a transitive test-time dep for Mandu.
   */
  domLoader?: () => Promise<unknown>;
}
