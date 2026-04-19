/**
 * Glossary skill template — turns detected resources + routes into a
 * living domain glossary so the agent always uses the right names.
 */

import type { ProjectAnalysis } from "../types";

export function buildGlossarySkill(analysis: ProjectAnalysis): string {
  const { manifest, projectName } = analysis;

  const frontmatter = [
    "---",
    `name: ${projectName}-domain-glossary`,
    `description: |`,
    `  Domain vocabulary for ${projectName}. Resources, route IDs, and`,
    `  standard naming conventions extracted from the project manifest.`,
    "---",
    "",
  ].join("\n");

  const body: string[] = [];
  body.push(`# ${projectName} Domain Glossary`);
  body.push("");
  body.push("Auto-generated from `.mandu/manifest.json` and `shared/resources/`.");
  body.push("Regenerate with `mandu skills:generate --regenerate`.");
  body.push("");

  if (manifest.resources.length > 0) {
    body.push("## Resources");
    body.push("");
    body.push("Resource names follow the singular, lowercase convention (e.g. `user` not `users` or `User`).");
    body.push("");
    for (const name of manifest.resources) {
      body.push(`- **${name}** — defined in \`shared/resources/${name}.resource.ts\`.`);
    }
    body.push("");
  } else {
    body.push("## Resources");
    body.push("");
    body.push("No `shared/resources/*.resource.ts` files found yet. Use `mandu scaffold collection <name>` to add one.");
    body.push("");
  }

  if (manifest.sampleRoutes.length > 0) {
    body.push("## Route IDs (sample)");
    body.push("");
    body.push("| Route ID | Pattern | Kind | Methods |");
    body.push("|---|---|---|---|");
    for (const r of manifest.sampleRoutes) {
      body.push(
        `| \`${r.id}\` | ${r.pattern ? `\`${r.pattern}\`` : "—"} | ${r.kind ?? "—"} | ${r.methods?.join(", ") ?? "—"} |`,
      );
    }
    body.push("");
    body.push(`Total: ${manifest.totalRoutes} routes (${manifest.apiRoutes} API + ${manifest.pageRoutes} page).`);
    body.push("");
  } else if (manifest.present) {
    body.push("## Routes");
    body.push("");
    body.push("Manifest is present but empty. Add an `app/` tree with `route.ts` or `page.tsx` files to register routes.");
    body.push("");
  }

  body.push("## Naming Rules");
  body.push("");
  body.push("- Resource names are singular, lowercase: `user`, `post`, `comment`.");
  body.push("- Route IDs match the URL: `/api/users` → `api.users`.");
  body.push("- Slot files live under `spec/slots/` and end in `.slot.ts` / `.client.ts`.");
  body.push("- Contract files live under `shared/contracts/` and end in `.contract.ts`.");
  body.push("");

  return frontmatter + body.join("\n") + "\n";
}
