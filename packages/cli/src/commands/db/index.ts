/**
 * `mandu db` — top-level dispatcher.
 *
 * Registered from `packages/cli/src/commands/registry.ts`; the registry
 * entry delegates to {@link dbDispatch} which reads the subcommand
 * from `ctx.args[1]`. Subcommand implementations live in peer files:
 *
 *   plan.ts    — compute + persist next migration file
 *   apply.ts   — run pending migrations against the live DB
 *   status.ts  — informational snapshot
 *   reset.ts   — DANGEROUS; drops __mandu_migrations
 *
 * ## Exit code convention
 *
 *   0 — success / informational
 *   1 — generic error (I/O, SQL, connection)
 *   2 — usage / argv error
 *   3 — migration tampered (apply-only path)
 *   4 — reset refused (safety gate)
 *
 * These numbers are stable; shell wrappers (CI, operators) may branch
 * on them.
 *
 * @module cli/commands/db
 */

import type { CommandContext } from "../registry";
import { dbPlan, type DbPlanOptions } from "./plan";
import { dbApply, type DbApplyOptions } from "./apply";
import { dbStatus, type DbStatusOptions } from "./status";
import { dbReset, type DbResetOptions } from "./reset";
import { dbSeed, type DbSeedOptions, type SeedEnv } from "../db-seed";

export { dbPlan, type DbPlanOptions } from "./plan";
export { dbApply, type DbApplyOptions } from "./apply";
export { dbStatus, type DbStatusOptions } from "./status";
export { dbReset, type DbResetOptions } from "./reset";
export { dbSeed, type DbSeedOptions } from "../db-seed";
export { resolveDb, DbResolutionError } from "./resolve-db";
export { applyRenames, findRenameCandidates, formatPrompt } from "./rename-prompt";

export const DB_SUBCOMMANDS = ["plan", "apply", "status", "reset", "seed"] as const;
export type DbSubcommand = (typeof DB_SUBCOMMANDS)[number];

export const EXIT_USAGE = 2;

/**
 * Help text shown when the user runs `mandu db` with no subcommand.
 *
 * Exported so the registry-based help aggregator can render it alongside
 * other commands.
 */
export const DB_HELP = [
  "",
  "  mandu db — manage schema migrations",
  "",
  "  Subcommands:",
  "    plan     Diff resources → next migration file",
  "    apply    Run pending migrations against the live DB",
  "    status   Print applied / pending / tampered / orphaned",
  "    reset    DANGEROUS: drop __mandu_migrations (--force + confirm)",
  "    seed     Replay spec/seeds/*.seed.ts against the live DB",
  "",
  "  Flags:",
  "    --ci       Non-interactive mode (exit fast on prompts)",
  "    --json     Machine-readable stdout",
  "    --dry-run  (apply | seed) simulate without executing",
  "    --check    (status) exit 1 if pending > 0",
  "    --force    (reset) required; plus confirmation",
  "    --env      (seed) dev|staging|prod — env whitelist filter",
  "    --reset    (seed) truncate target tables before inserting",
  "    --file     (seed) prefix filter (e.g. --file=001)",
  "",
  "  Environment:",
  "    DATABASE_URL                     Primary source for the DB connection",
  "    MANDU_DB_RESET_CONFIRM           Required for `db reset --ci`",
  "    MANDU_DB_SEED_PROD_CONFIRM       Required for `db seed --env=prod`",
  "",
  "  Examples:",
  "    mandu db plan",
  "    mandu db apply --dry-run",
  "    mandu db status --json",
  "    mandu db reset --force --drop-tables",
  "    mandu db seed --env=dev",
  "    mandu db seed --file=001 --dry-run",
  "",
].join("\n");

/**
 * Main dispatch. Returns a boolean for the registry contract
 * (`true` = success, `false` = unknown subcommand / usage error),
 * and exits the process with the correct numeric code.
 */
export async function dbDispatch(ctx: CommandContext): Promise<boolean> {
  const sub = ctx.args[1];
  if (!sub || sub.startsWith("--")) {
    process.stdout.write(DB_HELP);
    // No subcommand == help view. Treat as success so the CLI doesn't
    // print a second "unknown subcommand" error.
    return true;
  }

  switch (sub) {
    case "plan": {
      const code = await dbPlan(readPlanOptions(ctx));
      process.exit(code);
      // unreachable, but TypeScript wants it:
      return true;
    }
    case "apply": {
      const code = await dbApply(readApplyOptions(ctx));
      process.exit(code);
      return true;
    }
    case "status": {
      const code = await dbStatus(readStatusOptions(ctx));
      process.exit(code);
      return true;
    }
    case "reset": {
      const code = await dbReset(readResetOptions(ctx));
      process.exit(code);
      return true;
    }
    case "seed": {
      const code = await dbSeed(readSeedOptions(ctx));
      process.exit(code);
      return true;
    }
    default:
      process.stderr.write(
        `mandu db: unknown subcommand "${sub}". Try one of: ${DB_SUBCOMMANDS.join(", ")}\n`,
      );
      process.exit(EXIT_USAGE);
      return false;
  }
}

// =====================================================================
// Option readers — translate ctx.options string maps to typed objects
// =====================================================================

function readPlanOptions(ctx: CommandContext): DbPlanOptions {
  return {
    ci: ctx.options.ci === "true",
    json: ctx.options.json === "true",
  };
}

function readApplyOptions(ctx: CommandContext): DbApplyOptions {
  return {
    dryRun: ctx.options["dry-run"] === "true" || ctx.options.dryRun === "true",
    ci: ctx.options.ci === "true",
    json: ctx.options.json === "true",
  };
}

function readStatusOptions(ctx: CommandContext): DbStatusOptions {
  return {
    json: ctx.options.json === "true",
    check: ctx.options.check === "true",
  };
}

function readResetOptions(ctx: CommandContext): DbResetOptions {
  return {
    force: ctx.options.force === "true",
    ci: ctx.options.ci === "true",
    allowTamper: ctx.options["allow-tamper"] === "true" || ctx.options.allowTamper === "true",
    dropTables: ctx.options["drop-tables"] === "true" || ctx.options.dropTables === "true",
  };
}

function readSeedOptions(ctx: CommandContext): DbSeedOptions {
  const rawEnv = ctx.options.env;
  const env: SeedEnv | undefined =
    rawEnv === "dev" || rawEnv === "staging" || rawEnv === "prod" ? rawEnv : undefined;
  return {
    env,
    file: ctx.options.file && ctx.options.file !== "true" ? ctx.options.file : undefined,
    dryRun: ctx.options["dry-run"] === "true" || ctx.options.dryRun === "true",
    reset: ctx.options.reset === "true",
    ci: ctx.options.ci === "true",
    json: ctx.options.json === "true",
  };
}
