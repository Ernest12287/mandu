/**
 * Guard analyzer — detects the applied guard preset and (if present)
 * summarizes the latest violation report so the conventions skill can
 * highlight concrete project anti-patterns.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GuardAnalysis } from "../types";

const VALID_PRESETS = new Set(["fsd", "clean", "hexagonal", "atomic", "cqrs", "mandu"]);

function detectPresetFromConfig(repoRoot: string): string | undefined {
  const candidates = [
    join(repoRoot, "guard.config.ts"),
    join(repoRoot, "guard.config.js"),
    join(repoRoot, "mandu.config.ts"),
    join(repoRoot, "mandu.config.js"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf8");
      const match = content.match(/preset\s*:\s*['"]([a-z]+)['"]/);
      if (match && VALID_PRESETS.has(match[1])) {
        return match[1];
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function analyzeGuard(repoRoot: string): GuardAnalysis {
  const result: GuardAnalysis = {
    preset: detectPresetFromConfig(repoRoot),
    reportPresent: false,
    violationCount: undefined,
    topRules: undefined,
  };

  const reportPath = join(repoRoot, ".mandu", "guard-report.json");
  if (existsSync(reportPath)) {
    try {
      const raw = readFileSync(reportPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        result.reportPresent = true;
        const violations = (parsed as { violations?: unknown }).violations;
        if (Array.isArray(violations)) {
          result.violationCount = violations.length;
          const byRule = new Map<string, number>();
          for (const v of violations) {
            if (!v || typeof v !== "object") continue;
            const ruleId = (v as { ruleId?: unknown }).ruleId;
            if (typeof ruleId === "string") {
              byRule.set(ruleId, (byRule.get(ruleId) ?? 0) + 1);
            }
          }
          if (byRule.size > 0) {
            result.topRules = Array.from(byRule.entries())
              .map(([ruleId, count]) => ({ ruleId, count }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 5);
          }
        }
      }
    } catch {
      // ignore malformed report
    }
  }

  return result;
}
