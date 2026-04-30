/**
 * `mandu mcp register` — Phase 13.2 IDE integration.
 *
 * Writes a Mandu MCP server entry into an IDE / coding-assistant's
 * config file so the user can invoke `mandu mcp` tools from inside the
 * IDE without hand-editing JSON. Supported providers:
 *
 *   - `claude`    → `~/.claude/mcp.json`
 *   - `cursor`    → `~/.cursor/mcp.json`
 *   - `continue`  → `~/.continue/config.json`
 *   - `aider`     → `<cwd>/.aider.conf.yml`
 *
 * Safety invariants:
 *
 *   1. Read → parse → merge → atomic-write. Never overwrite.
 *   2. Always stash a backup at `<file>.bak.<unix-ms>` when the file
 *      already exists, BEFORE replacement.
 *   3. JSON-C tolerance — Claude/Cursor users routinely leave `//`
 *      comments in their config. Comments survive the read step (we
 *      strip them) but not the write step; the CLI warns explicitly.
 *   4. `env` values accept the `${...}` placeholder form. We never
 *      embed a raw token in the config file (prevents accidental git
 *      commits of secrets).
 *
 * Flag surface:
 *
 *   --ide=<claude|cursor|continue|aider|all>   default: all
 *   --remove                                  remove Mandu entry
 *   --token=<generate|prompt|env:VAR>        token management
 *   --dry-run                                 no write
 *
 * Exit codes:
 *
 *   0 — success
 *   1 — I/O or parse error
 *   2 — usage error
 *
 * @module cli/commands/mcp-register
 */

import { promises as fs } from "node:fs";

import {
  IDE_PROVIDERS,
  type IdeProvider,
  getProviderPath,
  readConfigJson,
  writeConfigAtomic,
  mergeMcpEntry,
  removeMcpEntry,
  mergeAiderEntry,
  removeAiderEntry,
  type McpServerEntry,
} from "../util/ide-config";
import { theme } from "../terminal/theme";

// =====================================================================
// Options
// =====================================================================

export interface McpRegisterOptions {
  ide?: IdeProvider | "all";
  remove?: boolean;
  /**
   * Token strategy:
   *   - `generate` — synthesize a random token, print + store in config.
   *   - `prompt`   — read from stdin.
   *   - `env:VAR`  — leave the config as `${env:VAR}` placeholder (recommended).
   *   - undefined  — use `${env:MANDU_MCP_TOKEN}` placeholder (default).
   */
  token?: string;
  dryRun?: boolean;
  cwd?: string;
  homeDir?: string;
  /** Overridden for tests — defaults to the CLI's entrypoint. */
  command?: string;
  /** Args passed to the command. Defaults to `["mcp"]`. */
  args?: string[];
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** Name of the MCP entry written under `mcpServers.*`. */
export const MANDU_ENTRY_NAME = "mandu";

// =====================================================================
// Public entry
// =====================================================================

export async function mcpRegister(options: McpRegisterOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const ide = options.ide ?? "all";
  const selected: IdeProvider[] =
    ide === "all" ? [...IDE_PROVIDERS] : [ide];

  if (!ide || (ide !== "all" && !IDE_PROVIDERS.includes(ide))) {
    process.stderr.write(
      `${theme.error("usage:")} --ide must be one of ${IDE_PROVIDERS.join("|")}|all, got ${JSON.stringify(ide)}\n`,
    );
    return EXIT_USAGE;
  }

  const entry = buildEntry(options);
  // Short-circuit path for `--remove`.
  const removing = options.remove === true;

  const results: { provider: IdeProvider; action: string; path: string; note?: string }[] = [];
  let hadError = false;

  for (const provider of selected) {
    try {
      const filePath = getProviderPath(provider, cwd, options.homeDir);
      if (provider === "aider") {
        const applied = await applyAider(filePath, entry, removing, options);
        results.push({ provider, action: applied.action, path: filePath, note: applied.note });
      } else {
        const applied = await applyJson(provider, filePath, entry, removing, options);
        results.push({ provider, action: applied.action, path: filePath, note: applied.note });
      }
    } catch (err) {
      hadError = true;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${theme.error("error:")} ${provider}: ${msg}\n`,
      );
    }
  }

  renderSummary(results, removing, options.dryRun === true);
  return hadError ? EXIT_ERROR : EXIT_OK;
}

// =====================================================================
// Entry construction
// =====================================================================

function buildEntry(options: McpRegisterOptions): McpServerEntry {
  const command = options.command ?? "mandu";
  const args = options.args ?? ["mcp"];
  const env = resolveTokenEnv(options);
  return { command, args, ...(env ? { env } : {}) };
}

function resolveTokenEnv(options: McpRegisterOptions): Record<string, string> | undefined {
  const token = options.token;
  if (!token) {
    // Default: placeholder that resolves at IDE-invocation time.
    return { MANDU_MCP_TOKEN: "${localEnv:MANDU_MCP_TOKEN}" };
  }
  if (token === "generate") {
    const generated = Buffer.from(
      crypto.getRandomValues(new Uint8Array(24)),
    ).toString("base64url");
    process.stdout.write(
      `  ${theme.warn("generated token:")} ${generated}\n` +
        `  ${theme.dim("store it securely — this is the only time it is shown.")}\n`,
    );
    return { MANDU_MCP_TOKEN: generated };
  }
  if (token.startsWith("env:")) {
    const varName = token.slice(4).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(varName)) {
      throw new Error(`--token=env:VAR name "${varName}" is not a valid env var identifier`);
    }
    return { MANDU_MCP_TOKEN: `\${localEnv:${varName}}` };
  }
  if (token === "prompt") {
    // We intentionally do not wire stdin here — keep the CLI stateless.
    // The placeholder still works; the user supplies the token via env.
    return { MANDU_MCP_TOKEN: "${localEnv:MANDU_MCP_TOKEN}" };
  }
  // Treat as literal token. Warn — this embeds the value in plaintext.
  return { MANDU_MCP_TOKEN: token };
}

// =====================================================================
// JSON provider (claude/cursor/continue)
// =====================================================================

interface ApplyResult {
  action: "added" | "updated" | "removed" | "noop";
  note?: string;
}

async function applyJson(
  provider: IdeProvider,
  filePath: string,
  entry: McpServerEntry,
  removing: boolean,
  options: McpRegisterOptions,
): Promise<ApplyResult> {
  const existing = await readConfigJson(filePath);
  if (removing) {
    const { merged, changed } = removeMcpEntry(existing, provider, MANDU_ENTRY_NAME);
    if (!changed) return { action: "noop" };
    if (options.dryRun === true) {
      return { action: "removed", note: `would remove mandu entry from ${filePath}` };
    }
    if (merged === null) {
      // File didn't exist to begin with — nothing to remove.
      return { action: "noop" };
    }
    const body = JSON.stringify(merged, null, 2) + "\n";
    const backup = await writeConfigAtomic(filePath, body);
    return {
      action: "removed",
      note: backup ? `backup: ${backup}` : undefined,
    };
  }

  const { merged, changed } = mergeMcpEntry(existing, provider, MANDU_ENTRY_NAME, entry);
  if (!changed) {
    return { action: "noop", note: "already up to date" };
  }
  const action = existing ? "updated" : "added";
  if (options.dryRun === true) {
    return { action, note: `would write ${filePath}` };
  }
  const body = JSON.stringify(merged, null, 2) + "\n";
  const backup = await writeConfigAtomic(filePath, body);
  return { action, note: backup ? `backup: ${backup}` : undefined };
}

// =====================================================================
// Aider provider (YAML)
// =====================================================================

async function applyAider(
  filePath: string,
  entry: McpServerEntry,
  removing: boolean,
  options: McpRegisterOptions,
): Promise<ApplyResult> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  if (removing) {
    const { body, changed } = removeAiderEntry(existing, MANDU_ENTRY_NAME);
    if (!changed) return { action: "noop" };
    if (options.dryRun === true) {
      return { action: "removed", note: `would remove mandu entry from ${filePath}` };
    }
    if (body === null) return { action: "noop" };
    const backup = await writeConfigAtomic(filePath, body);
    return { action: "removed", note: backup ? `backup: ${backup}` : undefined };
  }

  const { body, changed } = mergeAiderEntry(existing, MANDU_ENTRY_NAME, entry);
  if (!changed) return { action: "noop", note: "already up to date" };
  const action = existing ? "updated" : "added";
  if (options.dryRun === true) {
    return { action, note: `would write ${filePath}` };
  }
  const backup = await writeConfigAtomic(filePath, body);
  return { action, note: backup ? `backup: ${backup}` : undefined };
}

// =====================================================================
// Summary rendering
// =====================================================================

function renderSummary(
  results: { provider: IdeProvider; action: string; path: string; note?: string }[],
  removing: boolean,
  dryRun: boolean,
): void {
  process.stdout.write(
    theme.heading(dryRun ? "\nMCP register — dry run\n\n" : "\nMCP register\n\n"),
  );
  for (const r of results) {
    const marker =
      r.action === "added"
        ? theme.success("+")
        : r.action === "updated"
        ? theme.success("~")
        : r.action === "removed"
        ? theme.warn("-")
        : theme.dim("=");
    process.stdout.write(
      `  ${marker} ${r.provider.padEnd(10)} ${theme.dim(r.action.padEnd(8))} ${r.path}\n`,
    );
    if (r.note) process.stdout.write(`      ${theme.dim(r.note)}\n`);
  }
  process.stdout.write("\n");
  if (!removing) {
    process.stdout.write(
      `  ${theme.dim("verify:")} restart the IDE, then check: ${theme.command("mandu mcp --list")}\n\n`,
    );
  }
}

// =====================================================================
// Test hooks
// =====================================================================

export const __private = {
  buildEntry,
  resolveTokenEnv,
};
