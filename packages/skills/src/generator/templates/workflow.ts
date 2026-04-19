/**
 * Workflow skill template — stack-aware command recipes.
 */

import type { ProjectAnalysis } from "../types";

export function buildWorkflowSkill(analysis: ProjectAnalysis): string {
  const { projectName, stack, manifest } = analysis;

  const frontmatter = [
    "---",
    `name: ${projectName}-workflow`,
    `description: |`,
    `  Common commands and recipes for ${projectName}. Stack-aware —`,
    `  includes Playwright / Tailwind / Bun tips only when those are installed.`,
    "---",
    "",
  ].join("\n");

  const body: string[] = [];
  body.push(`# ${projectName} Workflow`);
  body.push("");

  body.push("## Daily Development");
  body.push("");
  const runner = stack.bunRuntime ? "bun run" : "npm run";
  body.push(`- \`${runner} dev\` — start Mandu dev server.`);
  body.push(`- \`${runner} build\` — compile client bundles.`);
  body.push(`- \`${runner} start\` — boot production server (after build).`);
  body.push(`- \`mandu guard arch\` — architecture violations check.`);
  body.push(`- \`mandu check\` — run guard + spec verification together.`);
  body.push("");

  if (manifest.totalRoutes > 0) {
    body.push("## Adding Routes");
    body.push("");
    body.push(`Project currently has **${manifest.totalRoutes}** route(s) (${manifest.apiRoutes} API, ${manifest.pageRoutes} page).`);
    body.push("");
    body.push("- `mandu routes list` — inspect the current manifest.");
    body.push("- `mandu scaffold <type> <name>` — create boilerplate (middleware, ws, session, auth, collection).");
    body.push("- `mandu generate-ai --prompt \"...\"` — AI-assisted scaffold.");
    body.push("");
  }

  body.push("## Testing");
  body.push("");
  body.push("- `bun test` — unit + integration tests.");
  body.push("- `mandu test-auto` — ATE extract → generate → run.");
  body.push("- `mandu test-heal --run-id <id>` — auto-heal failed selectors.");
  if (stack.hasPlaywright) {
    body.push("- `bunx playwright test` — run Playwright E2E directly.");
  } else {
    body.push("- Add Playwright with `bun add -d @playwright/test playwright` to unlock E2E.");
  }
  body.push("");

  if (stack.hasTailwind) {
    body.push("## Tailwind");
    body.push("");
    body.push("- Tailwind CSS is installed. Styles live in `app/globals.css` and auto-inject via `startServer({ cssPath })`.");
    body.push("- `mandu dev` watches Tailwind and rebuilds via the bundler's CSS watcher.");
    body.push("");
  }

  if (stack.manduCore) {
    body.push("## Versions");
    body.push("");
    body.push(`- @mandujs/core: ${stack.manduCore}`);
    body.push("- Upgrade with `mandu upgrade` (interactive).");
    body.push("");
  }

  body.push("## Safety Checks Before Commit");
  body.push("");
  body.push("1. `mandu guard arch` — must pass.");
  body.push("2. `bun test` — must pass.");
  body.push(`3. \`${runner} build\` — verifies bundler can ship.`);
  body.push("");

  return frontmatter + body.join("\n") + "\n";
}
