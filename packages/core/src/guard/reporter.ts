/**
 * Mandu Guard Reporter
 *
 * 에이전트 친화적 경고 출력
 */

import type {
  Violation,
  ViolationReport,
  Severity,
  GuardPreset,
} from "./types";
import {
  toAgentFormat,
} from "./suggestions";

// ═══════════════════════════════════════════════════════════════════════════
// ANSI Colors
// ═══════════════════════════════════════════════════════════════════════════

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
};

// ═══════════════════════════════════════════════════════════════════════════
// Formatting Helpers
// ═══════════════════════════════════════════════════════════════════════════

const SEPARATOR = "━".repeat(60);

function getSeverityIcon(severity: Severity): string {
  switch (severity) {
    case "error":
      return "🚨";
    case "warn":
      return "⚠️";
    case "info":
      return "ℹ️";
  }
}

function getSeverityColor(severity: Severity): string {
  switch (severity) {
    case "error":
      return colors.red;
    case "warn":
      return colors.yellow;
    case "info":
      return colors.blue;
  }
}

function getSeverityLabel(severity: Severity): string {
  switch (severity) {
    case "error":
      return "ERROR";
    case "warn":
      return "WARNING";
    case "info":
      return "INFO";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Violation Formatting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 단일 위반 포맷팅 (에이전트 친화적)
 */
export function formatViolation(
  violation: Violation,
  hierarchy?: string[]
): string {
  const icon = getSeverityIcon(violation.severity);
  const color = getSeverityColor(violation.severity);
  const _label = getSeverityLabel(violation.severity);

  const lines: string[] = [
    "",
    `${color}${SEPARATOR}${colors.reset}`,
    `${icon} ${color}${colors.bold}ARCHITECTURE VIOLATION DETECTED${colors.reset}`,
    `${color}${SEPARATOR}${colors.reset}`,
    "",
    `${colors.dim}📁 File:${colors.reset} ${violation.filePath}`,
    `${colors.dim}📍 Line:${colors.reset} ${violation.line}, ${colors.dim}Column:${colors.reset} ${violation.column}`,
    `${colors.red}❌ Violation:${colors.reset} ${violation.importStatement}`,
    "",
    `${color}🔴 Rule:${colors.reset} ${violation.ruleName}`,
    `   ${violation.ruleDescription}`,
    "",
  ];

  // 레이어 계층 시각화
  if (hierarchy && hierarchy.length > 0) {
    lines.push(`${colors.cyan}📊 Layer Hierarchy:${colors.reset}`);
    lines.push(formatHierarchy(hierarchy, violation.fromLayer, violation.toLayer));
    lines.push("");
  }

  // 허용된 레이어
  if (violation.allowedLayers.length > 0) {
    lines.push(`${colors.green}✅ Allowed imports from "${violation.fromLayer}":${colors.reset}`);
    for (const layer of violation.allowedLayers) {
      lines.push(`   • @/${layer}/*`);
    }
    lines.push("");
  }

  // 해결 제안
  if (violation.suggestions.length > 0) {
    lines.push(`${colors.magenta}💡 Suggestions:${colors.reset}`);
    violation.suggestions.forEach((suggestion, i) => {
      lines.push(`   ${i + 1}. ${suggestion}`);
    });
    lines.push("");
  }

  lines.push(`${color}${SEPARATOR}${colors.reset}`);

  return lines.join("\n");
}

/**
 * 레이어 계층 시각화
 */
function formatHierarchy(
  hierarchy: string[],
  fromLayer: string,
  toLayer: string
): string {
  const fromIndex = hierarchy.indexOf(fromLayer);
  const toIndex = hierarchy.indexOf(toLayer);

  // 계층 화살표 생성
  const layerLine = hierarchy.join(" → ");
  let visualization = `   ${layerLine}`;

  // 위반 방향 표시
  if (fromIndex !== -1 && toIndex !== -1) {
    if (fromIndex > toIndex) {
      visualization += `\n   ${" ".repeat(getPositionOffset(hierarchy, toLayer))}↑`;
      visualization += ` ${" ".repeat(getPositionOffset(hierarchy, fromLayer) - getPositionOffset(hierarchy, toLayer) - 2)}↓`;
      visualization += `\n   ${colors.red}(violation: ${fromLayer} importing UP)${colors.reset}`;
    } else {
      visualization += `\n   ${colors.red}(violation: importing restricted layer)${colors.reset}`;
    }
  }

  return visualization;
}

/**
 * 레이어 위치 오프셋 계산
 */
function getPositionOffset(hierarchy: string[], layer: string): number {
  let offset = 0;
  for (const l of hierarchy) {
    if (l === layer) break;
    offset += l.length + 4; // " → " = 4 chars
  }
  return offset;
}

// ═══════════════════════════════════════════════════════════════════════════
// Report Formatting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 전체 리포트 포맷팅
 */
export function formatReport(
  report: ViolationReport,
  hierarchy?: string[]
): string {
  const lines: string[] = [];

  // 헤더
  lines.push("");
  lines.push(`${colors.bold}${colors.cyan}╔══════════════════════════════════════════════════════════╗${colors.reset}`);
  lines.push(`${colors.bold}${colors.cyan}║${colors.reset}              🛡️  Mandu Guard Report                     ${colors.bold}${colors.cyan}║${colors.reset}`);
  lines.push(`${colors.bold}${colors.cyan}╚══════════════════════════════════════════════════════════╝${colors.reset}`);
  lines.push("");

  // 요약
  lines.push(`${colors.dim}📊 Summary:${colors.reset}`);
  lines.push(`   Files analyzed: ${report.filesAnalyzed}`);
  lines.push(`   Analysis time: ${report.analysisTime}ms`);
  lines.push(`   Total violations: ${report.totalViolations}`);
  lines.push("");

  // 심각도별 카운트
  if (report.totalViolations > 0) {
    lines.push(`${colors.dim}📈 By Severity:${colors.reset}`);
    if (report.bySeverity.error > 0) {
      lines.push(`   ${colors.red}🚨 Errors: ${report.bySeverity.error}${colors.reset}`);
    }
    if (report.bySeverity.warn > 0) {
      lines.push(`   ${colors.yellow}⚠️  Warnings: ${report.bySeverity.warn}${colors.reset}`);
    }
    if (report.bySeverity.info > 0) {
      lines.push(`   ${colors.blue}ℹ️  Info: ${report.bySeverity.info}${colors.reset}`);
    }
    lines.push("");
  }

  // 각 위반 출력
  for (const violation of report.violations) {
    lines.push(formatViolation(violation, hierarchy));
  }

  // 결과
  if (report.totalViolations === 0) {
    lines.push(`${colors.green}✅ No architecture violations found!${colors.reset}`);
  } else {
    lines.push(`${colors.red}❌ ${report.totalViolations} violation(s) found. Please fix them.${colors.reset}`);
  }

  lines.push("");

  return lines.join("\n");
}

/**
 * 간략한 위반 요약 (한 줄)
 */
export function formatViolationSummary(violation: Violation): string {
  const icon = getSeverityIcon(violation.severity);
  return `${icon} ${violation.filePath}:${violation.line} - ${violation.fromLayer} → ${violation.toLayer} (${violation.ruleName})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Console Output
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 위반 콘솔 출력
 */
export function printViolation(
  violation: Violation,
  hierarchy?: string[]
): void {
  console.log(formatViolation(violation, hierarchy));
}

/**
 * 리포트 콘솔 출력
 */
export function printReport(
  report: ViolationReport,
  hierarchy?: string[]
): void {
  console.log(formatReport(report, hierarchy));
}

/**
 * 실시간 위반 알림 (짧은 형식)
 */
export function printRealtimeViolation(violation: Violation): void {
  const icon = getSeverityIcon(violation.severity);
  const color = getSeverityColor(violation.severity);

  console.log("");
  console.log(`${color}${SEPARATOR}${colors.reset}`);
  console.log(`${icon} ${color}${colors.bold}ARCHITECTURE VIOLATION${colors.reset}`);
  console.log(`${colors.dim}File:${colors.reset} ${violation.filePath}:${violation.line}`);
  console.log(`${colors.red}${violation.fromLayer} → ${violation.toLayer}${colors.reset} (not allowed)`);
  console.log(`${colors.green}Allowed:${colors.reset} ${violation.allowedLayers.join(", ") || "none"}`);
  if (violation.suggestions.length > 0) {
    console.log(`${colors.magenta}Fix:${colors.reset} ${violation.suggestions[0]}`);
  }
  console.log(`${color}${SEPARATOR}${colors.reset}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON Output (CI/CD)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * JSON 형식 리포트
 */
export function formatReportAsJSON(report: ViolationReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * 위반을 GitHub Actions 형식으로 출력
 */
export function formatForGitHubActions(violation: Violation): string {
  const level = violation.severity === "error" ? "error" : "warning";
  return `::${level} file=${violation.filePath},line=${violation.line},col=${violation.column}::${violation.ruleName}: ${violation.ruleDescription}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent-Optimized Output
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 에이전트 최적화 형식으로 위반 출력
 *
 * AI Agent가 파싱하고 자동 수정하기 쉬운 형식
 */
export function formatViolationForAgent(
  violation: Violation,
  preset?: GuardPreset
): string {
  const agentFormat = toAgentFormat(violation, preset);
  const lines: string[] = [];

  lines.push("");
  lines.push(`${colors.cyan}┌─ GUARD VIOLATION ──────────────────────────────────────────┐${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset} ${colors.red}[${agentFormat.severity.toUpperCase()}]${colors.reset} ${agentFormat.rule.name}`);
  lines.push(`${colors.cyan}│${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset} ${colors.dim}FILE:${colors.reset} ${agentFormat.location.file}:${agentFormat.location.line}:${agentFormat.location.column}`);
  lines.push(`${colors.cyan}│${colors.reset} ${colors.dim}RULE:${colors.reset} ${agentFormat.violation.fromLayer} → ${agentFormat.violation.toLayer} (NOT ALLOWED)`);
  lines.push(`${colors.cyan}│${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset} ${colors.yellow}VIOLATION:${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset}   ${agentFormat.violation.importStatement}`);
  lines.push(`${colors.cyan}│${colors.reset}`);

  // 수정 방법
  lines.push(`${colors.cyan}│${colors.reset} ${colors.green}FIX:${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset}   ${agentFormat.fix.primary}`);

  if (agentFormat.fix.codeChange) {
    lines.push(`${colors.cyan}│${colors.reset}`);
    lines.push(`${colors.cyan}│${colors.reset} ${colors.magenta}CODE CHANGE:${colors.reset}`);
    lines.push(`${colors.cyan}│${colors.reset}   ${colors.red}- ${agentFormat.fix.codeChange.before}${colors.reset}`);
    lines.push(`${colors.cyan}│${colors.reset}   ${colors.green}+ ${agentFormat.fix.codeChange.after}${colors.reset}`);
  }

  // 허용된 import
  if (agentFormat.allowed.length > 0) {
    lines.push(`${colors.cyan}│${colors.reset}`);
    lines.push(`${colors.cyan}│${colors.reset} ${colors.blue}ALLOWED:${colors.reset} ${agentFormat.allowed.join(", ")}`);
  }

  // 문서 링크
  lines.push(`${colors.cyan}│${colors.reset}`);
  lines.push(`${colors.cyan}│${colors.reset} ${colors.dim}DOCS:${colors.reset} ${agentFormat.rule.documentation}`);
  lines.push(`${colors.cyan}│${colors.reset}`);
  lines.push(`${colors.cyan}└────────────────────────────────────────────────────────────┘${colors.reset}`);

  return lines.join("\n");
}

/**
 * 에이전트용 JSON 포맷
 */
export function formatViolationAsAgentJSON(
  violation: Violation,
  preset?: GuardPreset
): string {
  return JSON.stringify(toAgentFormat(violation, preset), null, 2);
}

/**
 * 여러 위반을 에이전트 형식으로 출력
 */
export function formatReportForAgent(
  report: ViolationReport,
  preset?: GuardPreset
): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`${colors.bold}${colors.cyan}╔══════════════════════════════════════════════════════════════╗${colors.reset}`);
  lines.push(`${colors.bold}${colors.cyan}║${colors.reset}              🛡️  MANDU GUARD ANALYSIS                        ${colors.bold}${colors.cyan}║${colors.reset}`);
  lines.push(`${colors.bold}${colors.cyan}╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  lines.push("");

  // 요약 (에이전트가 빠르게 파악할 수 있도록)
  lines.push(`${colors.dim}SUMMARY:${colors.reset}`);
  lines.push(`  files_analyzed: ${report.filesAnalyzed}`);
  lines.push(`  total_violations: ${report.totalViolations}`);
  lines.push(`  errors: ${report.bySeverity.error}`);
  lines.push(`  warnings: ${report.bySeverity.warn}`);
  lines.push(`  info: ${report.bySeverity.info}`);
  lines.push("");

  if (report.totalViolations === 0) {
    lines.push(`${colors.green}✅ ALL CLEAR - No architecture violations detected${colors.reset}`);
    lines.push("");
    return lines.join("\n");
  }

  // 위반별 상세
  lines.push(`${colors.yellow}VIOLATIONS:${colors.reset}`);
  lines.push("");

  for (const violation of report.violations) {
    lines.push(formatViolationForAgent(violation, preset));
  }

  // 액션 요약
  lines.push("");
  lines.push(`${colors.bold}ACTION REQUIRED:${colors.reset}`);
  if (report.bySeverity.error > 0) {
    lines.push(`  ${colors.red}• Fix ${report.bySeverity.error} error(s) before continuing${colors.reset}`);
  }
  if (report.bySeverity.warn > 0) {
    lines.push(`  ${colors.yellow}• Consider fixing ${report.bySeverity.warn} warning(s)${colors.reset}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * 전체 리포트를 에이전트 JSON으로
 */
export function formatReportAsAgentJSON(
  report: ViolationReport,
  preset?: GuardPreset
): string {
  const agentReport = {
    summary: {
      filesAnalyzed: report.filesAnalyzed,
      totalViolations: report.totalViolations,
      analysisTime: report.analysisTime,
      bySeverity: report.bySeverity,
      byType: report.byType,
    },
    violations: report.violations.map((v) => toAgentFormat(v, preset)),
    actionRequired: report.bySeverity.error > 0,
  };

  return JSON.stringify(agentReport, null, 2);
}
