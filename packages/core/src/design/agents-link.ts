/**
 * AGENTS.md / CLAUDE.md ↔ DESIGN.md linker (Issue #245 M5).
 *
 * Drops a markered `## Design System` section into the project's
 * agent guide files so coding agents read DESIGN.md and use the
 * Mandu MCP tools (M4) before touching UI. Idempotent — running it
 * twice never duplicates the section.
 *
 * The linker writes the same payload to whichever of `AGENTS.md` /
 * `CLAUDE.md` exists. When neither exists in `force: true` mode it
 * creates `AGENTS.md` (the open standard) seeded with just the
 * design block — agents that consume `CLAUDE.md` follow the
 * cross-reference to `AGENTS.md` per Anthropic's convention.
 *
 * The injected section:
 *
 *   - Names DESIGN.md as the canonical design source.
 *   - Lists the 8 MCP tools with one-line descriptions.
 *   - Spells out the §3.5 incremental loop as a 5-step prompt agents
 *     can follow verbatim.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const DESIGN_LINK_MARKER_START =
  "<!-- @mandu-design-link:start — managed by `mandu design link` / `init --design`, do not edit -->";
export const DESIGN_LINK_MARKER_END = "<!-- @mandu-design-link:end -->";

export interface LinkAgentsOptions {
  /** Project root. */
  rootDir: string;
  /** Filenames to update. Defaults to `["AGENTS.md", "CLAUDE.md"]`. */
  filenames?: readonly string[];
  /**
   * When true, create a fresh `AGENTS.md` containing just the design
   * link block when none of `filenames` exists. Default false — the
   * linker only updates existing files unless explicitly asked.
   */
  createIfMissing?: boolean;
  /** Override DESIGN.md filename. Defaults to `DESIGN.md`. */
  designFilename?: string;
}

export interface LinkAgentsResult {
  files: Array<{
    path: string;
    /** "created" | "inserted" (markered block added) | "updated" (markered block replaced) | "unchanged" */
    action: "created" | "inserted" | "updated" | "unchanged";
  }>;
  /** True when at least one file was written. */
  changed: boolean;
}

/** Generate the markered block payload. Pure — used by tests too. */
export function buildAgentsDesignBlock(designFilename: string = "DESIGN.md"): string {
  const lines = [
    DESIGN_LINK_MARKER_START,
    "",
    "## Design System",
    "",
    `This project uses **${designFilename}** as the single source of truth for visual design (colors, typography, spacing, shadows, components, agent prompts).`,
    "Mandu's MCP tools expose every part of it without grepping the codebase. Agents MUST read DESIGN.md *before* writing or editing UI.",
    "",
    "### Tools (call before / during UI work)",
    "",
    "| Phase | Tool | Use it for |",
    "|---|---|---|",
    "| Read | `mandu.design.get` | Section-by-section DESIGN.md (or `'all'` for full spec). |",
    "| Read | `mandu.design.prompt` | §9 Agent Prompts — pre-warm context every session. |",
    "| Read | `mandu.component.list` | Existing components in `src/client/shared/ui/` + `widgets/`. Don't re-implement. |",
    "| Check | `mandu.design.check` | Lint a file BEFORE editing — surfaces forbidden inline classes. |",
    "| Discover | `mandu.design.extract` | Find token candidates the project uses but DESIGN.md doesn't list. |",
    "| Patch | `mandu.design.propose` | One-call: extract → dry-run patch → user reviews diff. |",
    "| Patch | `mandu.design.patch` | Section-safe add/update/remove. Defaults to `dry_run: true`. |",
    "| Sync | `mandu.design.diff_upstream` | Compare against awesome-design-md slugs (e.g. `'stripe'`). |",
    "",
    "### 5-step UI workflow",
    "",
    "1. **Pre-warm.** Call `mandu.design.prompt` (and `mandu.design.get` for the section you'll touch) so your edit honours existing tokens.",
    "2. **Inventory.** Call `mandu.component.list` for the matching category. Re-use first; only add when nothing fits.",
    "3. **Check.** Before editing a file, call `mandu.design.check { file }` to see if the file already violates DESIGN.md §7.",
    "4. **Edit.** Write the change. Use existing tokens from §2 / components from §1.",
    "5. **Propose tokens.** If you introduced a new color/font/spacing pattern, call `mandu.design.propose` and ask the user to apply the patch (default `dry_run: true`).",
    "",
    "### Hard rules",
    "",
    "- Never invent colors / fonts / spacing values without a `mandu.design.propose` round.",
    "- Never bypass `mandu.design.check` on a file you're about to edit.",
    "- DESIGN.md is the spec — when in doubt, update DESIGN.md *first*, then write code.",
    "",
    DESIGN_LINK_MARKER_END,
    "",
  ];
  return lines.join("\n");
}

/**
 * Update agent guide files to reference DESIGN.md and the MCP tools.
 *
 * Behaviour per file:
 *   - Marker present → replace the markered region (idempotent).
 *   - File exists, no marker → append the block at the end.
 *   - File missing → skip unless `createIfMissing: true`.
 */
export async function linkAgentsToDesignMd(
  options: LinkAgentsOptions,
): Promise<LinkAgentsResult> {
  const filenames = options.filenames ?? ["AGENTS.md", "CLAUDE.md"];
  const block = buildAgentsDesignBlock(options.designFilename);
  const files: LinkAgentsResult["files"] = [];

  let anyExists = false;
  for (const name of filenames) {
    const full = path.join(options.rootDir, name);
    let existing: string | null;
    try {
      existing = await fs.readFile(full, "utf8");
      anyExists = true;
    } catch {
      existing = null;
    }

    if (existing === null) {
      files.push({ path: full, action: "unchanged" });
      continue;
    }

    const startIdx = existing.indexOf(DESIGN_LINK_MARKER_START);
    const endIdx = existing.indexOf(DESIGN_LINK_MARKER_END);
    let next: string;
    let action: LinkAgentsResult["files"][number]["action"];
    if (startIdx >= 0 && endIdx > startIdx) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + DESIGN_LINK_MARKER_END.length);
      const replacement = block.replace(/\n+$/, "");
      next = `${before}${replacement}${after}`;
      action = next === existing ? "unchanged" : "updated";
    } else {
      const sep = existing.endsWith("\n") ? "" : "\n";
      next = `${existing}${sep}\n${block}`;
      action = "inserted";
    }

    if (action !== "unchanged") {
      await fs.writeFile(full, next, "utf8");
    }
    files.push({ path: full, action });
  }

  if (!anyExists && options.createIfMissing) {
    const target = path.join(options.rootDir, filenames[0] ?? "AGENTS.md");
    const seed = `# Project Agent Guide\n\n${block}`;
    await fs.writeFile(target, seed, "utf8");
    // Replace the placeholder "unchanged" entry with the real outcome.
    const idx = files.findIndex((f) => f.path === target);
    if (idx >= 0) files[idx] = { path: target, action: "created" };
    else files.push({ path: target, action: "created" });
  }

  return {
    files,
    changed: files.some((f) => f.action !== "unchanged"),
  };
}
