#!/usr/bin/env bun
/**
 * @mandujs/skills CLI
 *
 * Usage:
 *   bunx mandu-skills install [options]
 *   bunx mandu-skills install --force
 *   bunx mandu-skills install --dry-run
 *   bunx mandu-skills list
 */

import { installSkills, listSkillIds, type SkillId } from "./index.js";

const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  console.log(`
@mandujs/skills - Claude Code Plugin for Mandu Framework

Usage:
  mandu-skills install [options]    Install skills into current project
  mandu-skills list                 List available skills
  mandu-skills help                 Show this help

Install Options:
  --force              Overwrite existing files
  --dry-run            Report what would be done without writing
  --target <dir>       Target directory (default: cwd)
  --skills <ids>       Comma-separated skill IDs to install
  --skip-mcp           Skip .mcp.json setup
  --skip-settings      Skip .claude/settings.json setup
`);
}

function parseFlag(flag: string): boolean {
  return args.includes(flag);
}

function parseFlagValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  if (command === "list") {
    console.log("\nAvailable Mandu Skills:\n");
    const skills = listSkillIds();
    for (const id of skills) {
      console.log(`  - ${id}`);
    }
    console.log(`\nTotal: ${skills.length} skills\n`);
    process.exit(0);
  }

  if (command === "install") {
    const force = parseFlag("--force");
    const dryRun = parseFlag("--dry-run");
    const targetDir = parseFlagValue("--target") || process.cwd();
    const skipMcp = parseFlag("--skip-mcp");
    const skipSettings = parseFlag("--skip-settings");
    const skillsRaw = parseFlagValue("--skills");
    const skills = skillsRaw
      ? (skillsRaw.split(",").map((s) => s.trim()) as SkillId[])
      : undefined;

    console.log(`\n  Mandu Skills Installer${dryRun ? " (dry-run)" : ""}\n`);
    console.log(`  Target: ${targetDir}`);
    if (force) console.log("  Mode: force (overwrite existing)");
    console.log();

    const result = await installSkills({
      targetDir,
      force,
      dryRun,
      skills,
      skipMcp,
      skipSettings,
    });

    if (result.installed.length > 0) {
      console.log("  Installed:");
      for (const file of result.installed) {
        console.log(`    + ${file}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log("  Skipped:");
      for (const file of result.skipped) {
        console.log(`    - ${file}`);
      }
    }

    if (result.errors.length > 0) {
      console.log("  Errors:");
      for (const err of result.errors) {
        console.log(`    ! ${err}`);
      }
    }

    const total = result.installed.length + result.skipped.length;
    console.log(`\n  Done. ${result.installed.length}/${total} files written.\n`);

    if (result.errors.length > 0) {
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
