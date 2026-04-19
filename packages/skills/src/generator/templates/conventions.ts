/**
 * Conventions skill template — reflects the actual guard preset and any
 * recurring violations back to the agent as rules.
 */

import type { ProjectAnalysis } from "../types";

const PRESET_DESCRIPTIONS: Record<string, string> = {
  mandu:
    "Mandu default — client/server split with strict `shared/*` boundary. See `@mandujs/core/guard/presets/mandu`.",
  fsd: "Feature-Sliced Design — `app > pages > widgets > features > entities > shared`.",
  clean: "Clean Architecture — `api > application > domain` with infra at the edges.",
  hexagonal: "Hexagonal / Ports & Adapters — core domain isolated behind ports.",
  atomic: "Atomic Design — `atoms > molecules > organisms > templates > pages`.",
  cqrs: "CQRS — commands, queries, and events live in separate trees.",
};

export function buildConventionsSkill(analysis: ProjectAnalysis): string {
  const { projectName, guard } = analysis;

  const presetLabel = guard.preset ?? "(not detected)";
  const presetDesc = guard.preset ? PRESET_DESCRIPTIONS[guard.preset] : undefined;

  const frontmatter = [
    "---",
    `name: ${projectName}-conventions`,
    `description: |`,
    `  Project-specific rules for ${projectName}, derived from the guard preset (${presetLabel})`,
    `  and observed violations. Auto-called before changes to app/ or shared/.`,
    "---",
    "",
  ].join("\n");

  const body: string[] = [];
  body.push(`# ${projectName} Conventions`);
  body.push("");
  body.push(`Guard preset: **${presetLabel}**`);
  body.push("");
  if (presetDesc) {
    body.push(`> ${presetDesc}`);
    body.push("");
  }

  body.push("## Required Practices");
  body.push("");
  body.push("- API handlers MUST export a `Mandu.filling()` chain as default. Never `export default async function(ctx)`.");
  body.push("- Slot loaders (`*.slot.ts`) run on the server BEFORE render. They return typed props.");
  body.push("- Client islands (`*.client.ts` / `*.client.tsx`) MUST import from `@mandujs/core/client`, never the main `@mandujs/core` barrel.");
  body.push("- Contracts (`shared/contracts/*.contract.ts`) are the single source of truth for request/response shapes.");
  body.push("- Layout files live under `app/` and MUST NOT include `<html>`, `<head>`, or `<body>` tags — Mandu supplies them.");
  body.push("");

  if (guard.topRules && guard.topRules.length > 0) {
    body.push("## Recently Violated Rules");
    body.push("");
    body.push("| Rule ID | Occurrences |");
    body.push("|---|---|");
    for (const top of guard.topRules) {
      body.push(`| \`${top.ruleId}\` | ${top.count} |`);
    }
    body.push("");
    body.push("Resolve with `mandu guard arch` and `mandu explain <rule-id>`.");
    body.push("");
  } else if (guard.reportPresent) {
    body.push("## Guard Report");
    body.push("");
    body.push("Latest `mandu guard arch` found **no violations**. Keep it that way.");
    body.push("");
  } else {
    body.push("## Guard Report");
    body.push("");
    body.push("Run `mandu guard arch` to generate `.mandu/guard-report.json` and populate this section.");
    body.push("");
  }

  body.push("## When Adding a New Feature");
  body.push("");
  body.push("1. `mandu scaffold` or `mandu generate-ai` to produce the boilerplate.");
  body.push("2. Edit `app/<route>/route.ts` + `spec/slots/<name>.slot.ts` + contract.");
  body.push("3. `mandu guard arch` — must pass.");
  body.push("4. `mandu test-auto` — generate + run ATE specs.");
  body.push("");

  return frontmatter + body.join("\n") + "\n";
}
