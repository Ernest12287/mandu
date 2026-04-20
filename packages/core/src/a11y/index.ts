/**
 * @mandujs/core/a11y — public surface.
 *
 * Accessibility audit runner (Phase 18.χ). Consumers typically reach
 * for `runAudit` + `formatAuditReport`; the type exports are there so
 * CI tooling can build typed gates on top of the report shape.
 */

export { runAudit, formatAuditReport } from "./run-audit";
export { AXE_RULE_FIX_HINTS, getFixHint } from "./fix-hints";
export { AUDIT_IMPACT_ORDER, impactAtLeast } from "./types";
export type {
  AuditImpact,
  AuditNode,
  AuditViolation,
  AuditReport,
  RunAuditOptions,
} from "./types";
