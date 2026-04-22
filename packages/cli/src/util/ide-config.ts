/**
 * IDE configuration file reader / writer — Phase 13.2 (mcp register).
 *
 * Provides OS-aware resolution of editor / coding-assistant config file
 * paths plus safe JSON(-C) merge semantics. Three invariants the rest of
 * `mandu mcp register` relies on:
 *
 *   1. **Non-destructive writes.** Existing user content (other MCP
 *      servers, unrelated keys, comments in JSON-C) is always preserved.
 *      A Mandu entry is inserted/updated under `mcpServers.mandu` or the
 *      equivalent provider-specific key without touching siblings.
 *
 *   2. **Atomic replacement with backup.** Before overwriting a config
 *      file we copy it to `<file>.bak.<unix-ms>` and write the new bytes
 *      to `<file>.tmp.<pid>` then rename into place. Rename is the only
 *      operation that is atomic on NTFS + ext4 + APFS.
 *
 *   3. **JSON-C tolerance.** Claude Code and Cursor allow JSON with `//`
 *      line comments. We tolerate those on read by stripping them before
 *      `JSON.parse`. On write we emit plain JSON — the user loses their
 *      comments if they had any. This is explicitly called out in the
 *      CLI success message so it isn't a silent surprise.
 *
 * **NOT** in scope (out of band for v1):
 *   - VS Code settings.json merge (it uses JSONC with trailing commas —
 *     needs a real JSONC parser); tracked as a follow-up.
 *   - Interactive prompt for file path overrides; paths come from the
 *     `ide-config.getProviderPath()` table only.
 *
 * @module cli/util/ide-config
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// =====================================================================
// Types
// =====================================================================

/**
 * Supported IDE / MCP-host identifiers.
 *
 * The `aider` target writes to a project-local `.aider.conf.yml` — it's
 * the only non-global provider in the table. All others resolve to a
 * global config file under the user's home / roaming directory.
 */
export type IdeProvider = "claude" | "cursor" | "continue" | "aider";

/** Literal tuple form used by the CLI dispatcher. */
export const IDE_PROVIDERS = ["claude", "cursor", "continue", "aider"] as const;

/**
 * Entry we write into each provider's config. All four providers use a
 * superset of this shape; unknown fields pass through (we don't re-
 * serialise the whole object — only the `mandu` subkey).
 */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Result of a merge / remove operation. Tests + CLI consume this as a
 * machine-readable record of what changed.
 */
export interface ConfigMergeResult {
  /** Absolute path of the config file touched. */
  path: string;
  /** `"added" | "updated" | "removed" | "noop"` */
  action: "added" | "updated" | "removed" | "noop";
  /** Backup file written (if any). Relative to parent of `path`. */
  backup?: string;
  /** Serialised config body that was written (stringified JSON). */
  written?: string;
}

// =====================================================================
// Path resolution — OS-specific
// =====================================================================

/**
 * Resolve the on-disk path of a provider's config file.
 *
 * - `claude`   → `<home>/.claude/mcp.json`
 * - `cursor`   → `<home>/.cursor/mcp.json`
 * - `continue` → `<home>/.continue/config.json`
 * - `aider`    → `<cwd>/.aider.conf.yml`  (project-local)
 *
 * On Windows, `<home>` falls through to `%USERPROFILE%`. On macOS /
 * Linux we use `os.homedir()` which maps to `$HOME`. We intentionally
 * do NOT consult `%APPDATA%` for `claude`/`cursor` — their published
 * docs list `~/.claude` and `~/.cursor` as canonical on all three OSes.
 * See the URLs in docs/bun/phase-13-diagnostics/cli-extensions.md §5.2.
 *
 * @param provider which IDE to resolve for
 * @param cwd project root, used for aider only
 * @param homeOverride test hook (defaults to `os.homedir()`)
 */
export function getProviderPath(
  provider: IdeProvider,
  cwd: string,
  homeOverride?: string,
): string {
  const home = homeOverride ?? os.homedir();
  switch (provider) {
    case "claude":
      return path.join(home, ".claude", "mcp.json");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "continue":
      return path.join(home, ".continue", "config.json");
    case "aider":
      return path.join(cwd, ".aider.conf.yml");
  }
}

// =====================================================================
// JSON-C tolerance
// =====================================================================

/**
 * Strip `//` line comments and `/* … *\/` block comments from a JSON-ish
 * string so the result is parseable by `JSON.parse`. Preserves content
 * inside string literals (naive state machine sufficient for editor
 * configs — we don't claim full JSON-C spec compliance).
 *
 * Exported for unit testing.
 */
export function stripJsonComments(src: string): string {
  let out = "";
  let i = 0;
  const len = src.length;
  let inString = false;
  let stringChar: '"' | "'" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < len) {
    const ch = src[i];
    const next = i + 1 < len ? src[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch; // keep line breaks — line numbers stable for error diagnostics
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === "\n") out += ch;
      i++;
      continue;
    }

    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        // Preserve escape pair as-is.
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
      i++;
      continue;
    }

    // Not in string, not in comment — look for comment starts.
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch as '"' | "'";
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }

  return out;
}

/**
 * Read a config file and parse it as JSON (tolerating `//` / `/* *\/`
 * comments). Returns `null` if the file does not exist — callers treat
 * that as "empty config" and create a fresh object.
 *
 * Throws only on (a) a non-ENOENT read error, or (b) unparseable JSON
 * after comment stripping. Unparseable JSON includes a path and the
 * first parser error message — operators need both to fix their file.
 */
export async function readConfigJson(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
  // Strip BOM — some editors on Windows write UTF-8 with BOM.
  const noBom = raw.replace(/^\uFEFF/, "");
  const cleaned = stripJsonComments(noBom);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[${filePath}] invalid JSON: ${msg}`, { cause: err });
  }
}

// =====================================================================
// Safe write + backup
// =====================================================================

/**
 * Atomically rewrite `filePath` with `contents`. Before overwriting, the
 * existing file (if any) is copied to `<filePath>.bak.<unix-ms>` so the
 * user can always roll back. The final rename is the only atomic step.
 *
 * Returns the basename of the backup file (or undefined when no prior
 * file existed).
 */
export async function writeConfigAtomic(
  filePath: string,
  contents: string,
): Promise<string | undefined> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  let backupName: string | undefined;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      backupName = path.basename(filePath) + ".bak." + Date.now();
      await fs.copyFile(filePath, path.join(dir, backupName));
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  // tmp file in the same directory so the rename is intra-filesystem.
  const tmpPath =
    filePath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 10);
  await fs.writeFile(tmpPath, contents, "utf8");
  // On Windows, rename onto an existing file fails unless we unlink first.
  if (process.platform === "win32") {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
  await fs.rename(tmpPath, filePath);
  return backupName;
}

// =====================================================================
// Provider-aware merge logic
// =====================================================================

/**
 * Shape of the "mcp servers" block a provider uses. Two conventions:
 *
 *   - Claude / Cursor / Continue: `mcpServers: { <name>: { ... } }`
 *   - Aider:                       YAML with `mcp: { servers: { ... } }`
 *
 * We unify them via `mcpServersKey` per provider.
 */
function mcpServersKey(provider: IdeProvider): string {
  // Claude Code: `mcpServers` (confirmed in Anthropic docs).
  // Cursor:      `mcpServers` (same shape).
  // Continue:    `mcpServers` (since mcp-schema v2 config).
  // Aider:       handled separately — YAML, not JSON.
  return "mcpServers";
}

/**
 * Merge a Mandu MCP server entry into an existing JSON config object.
 *
 * - `existing` is **mutated**. The returned object is a shallow clone
 *   so call sites that want to keep the original intact can deep-copy
 *   upstream.
 * - Preserves every other `mcpServers.*` entry the user has.
 * - Preserves every other top-level key in the file.
 *
 * Returns the merged object + a `changed` flag so callers can skip
 * the file rewrite when the config is already correct.
 */
export function mergeMcpEntry(
  existing: Record<string, unknown> | null,
  provider: IdeProvider,
  name: string,
  entry: McpServerEntry,
): { merged: Record<string, unknown>; changed: boolean } {
  const base: Record<string, unknown> = existing ? { ...existing } : {};
  const key = mcpServersKey(provider);
  const servers = isRecord(base[key]) ? { ...(base[key] as Record<string, unknown>) } : {};
  const prior = isRecord(servers[name]) ? (servers[name] as Record<string, unknown>) : null;

  const nextEntry: Record<string, unknown> = {
    command: entry.command,
    args: [...entry.args],
  };
  if (entry.env && Object.keys(entry.env).length > 0) {
    nextEntry.env = { ...entry.env };
  }

  const changed = !prior || !shallowMcpEqual(prior, nextEntry);
  servers[name] = nextEntry;
  base[key] = servers;
  return { merged: base, changed };
}

/**
 * Remove a Mandu MCP server entry. Returns `{ changed: false }` if the
 * entry did not exist. Never throws — "nothing to remove" is a no-op.
 */
export function removeMcpEntry(
  existing: Record<string, unknown> | null,
  provider: IdeProvider,
  name: string,
): { merged: Record<string, unknown> | null; changed: boolean } {
  if (!existing) return { merged: null, changed: false };
  const base: Record<string, unknown> = { ...existing };
  const key = mcpServersKey(provider);
  if (!isRecord(base[key])) return { merged: base, changed: false };
  const servers = { ...(base[key] as Record<string, unknown>) };
  if (!(name in servers)) return { merged: base, changed: false };
  delete servers[name];
  base[key] = servers;
  return { merged: base, changed: true };
}

/**
 * Lightweight structural equality for the MCP entry shape. Avoids
 * pulling in `JSON.stringify` canonicalisation for a 3-field object.
 */
function shallowMcpEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (a.command !== b.command) return false;
  if (!arraysEqual(asStringArray(a.args), asStringArray(b.args))) return false;
  const envA = isRecord(a.env) ? (a.env as Record<string, string>) : {};
  const envB = isRecord(b.env) ? (b.env as Record<string, string>) : {};
  const keysA = Object.keys(envA).sort();
  const keysB = Object.keys(envB).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (envA[keysA[i]!] !== envB[keysB[i]!]) return false;
  }
  return true;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// =====================================================================
// YAML helpers (aider only)
// =====================================================================

/**
 * Very small YAML reader/writer — enough for aider's flat config which
 * our entry touches only the `mcp.servers.mandu:` subtree. We do NOT
 * attempt to parse arbitrary YAML (anchors, flow style, multi-docs are
 * all out of scope). Writes are emitted in a canonical, stable order.
 *
 * Aider uses YAML 1.2 — keys + flow-style maps for simple scalars is
 * valid. The emitter produces block style for readability.
 *
 * Exposed as `mergeAiderEntry` / `removeAiderEntry` below so callers
 * don't have to know the file is YAML.
 */
function emitAiderYaml(servers: Record<string, McpServerEntry>): string {
  if (Object.keys(servers).length === 0) return "";
  const lines: string[] = [];
  lines.push("mcp:");
  lines.push("  servers:");
  for (const name of Object.keys(servers).sort()) {
    const entry = servers[name]!;
    lines.push(`    ${name}:`);
    lines.push(`      command: ${quoteYamlString(entry.command)}`);
    if (entry.args.length === 0) {
      lines.push("      args: []");
    } else {
      lines.push("      args:");
      for (const a of entry.args) {
        lines.push(`        - ${quoteYamlString(a)}`);
      }
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      lines.push("      env:");
      for (const k of Object.keys(entry.env).sort()) {
        lines.push(`        ${k}: ${quoteYamlString(entry.env[k]!)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Read an existing `.aider.conf.yml` and extract the `mcp.servers`
 * subtree. This is NOT a general YAML parser — if the user's file
 * contains anchors or flow-style mappings we return the empty object
 * and on write we preserve whatever content exists OUTSIDE our subtree
 * verbatim. That's the "never-destructive" contract.
 *
 * Implementation: line-based with fixed indent levels, which matches
 * what our own emitter produces. Foreign structures under `mcp:` are
 * tolerated but not round-tripped — our write path replaces the whole
 * `mcp:` block.
 */
function parseAiderYamlSubtree(
  src: string,
): { servers: Record<string, McpServerEntry>; preamble: string; trailing: string } {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const mcpStart = lines.findIndex((l) => /^mcp\s*:/.test(l));
  if (mcpStart < 0) {
    return {
      servers: {},
      preamble: src.length === 0 ? "" : src.endsWith("\n") ? src : src + "\n",
      trailing: "",
    };
  }
  // Walk forward — consume any line that is indented (leading space) or
  // blank. Stop at the first top-level key.
  let end = mcpStart + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line === "") {
      end++;
      continue;
    }
    if (/^\s/.test(line)) {
      end++;
      continue;
    }
    break;
  }
  const preamble = lines.slice(0, mcpStart).join("\n");
  const trailing = lines.slice(end).join("\n");
  const mcpBlockLines = lines.slice(mcpStart, end);

  const servers = parseAiderServers(mcpBlockLines);

  return {
    servers,
    preamble: preamble.length > 0 && !preamble.endsWith("\n") ? preamble + "\n" : preamble,
    trailing: trailing.length > 0 && !trailing.startsWith("\n") ? "\n" + trailing : trailing,
  };
}

/**
 * Line-based parser for the `mcp:`/`  servers:` block. Iterates each
 * line, tracking indent state. Robust enough for any file produced by
 * `emitAiderYaml` above.
 */
function parseAiderServers(mcpBlockLines: string[]): Record<string, McpServerEntry> {
  const servers: Record<string, McpServerEntry> = {};
  // Find `  servers:` (exactly 2-space indent).
  let serversIdx = -1;
  for (let i = 0; i < mcpBlockLines.length; i++) {
    if (/^  servers\s*:/.test(mcpBlockLines[i]!)) {
      serversIdx = i;
      break;
    }
  }
  if (serversIdx < 0) return servers;

  let i = serversIdx + 1;
  let currentName: string | null = null;
  let currentCmd: string | undefined;
  let currentArgs: string[] = [];
  let currentEnv: Record<string, string> | undefined;
  let readingArgs = false;
  let readingEnv = false;

  const flush = () => {
    if (currentName !== null) {
      servers[currentName] = {
        command: currentCmd ?? "",
        args: currentArgs,
        ...(currentEnv && Object.keys(currentEnv).length > 0
          ? { env: currentEnv }
          : {}),
      };
    }
    currentName = null;
    currentCmd = undefined;
    currentArgs = [];
    currentEnv = undefined;
    readingArgs = false;
    readingEnv = false;
  };

  while (i < mcpBlockLines.length) {
    const line = mcpBlockLines[i]!;
    // Blank or out of the servers block.
    if (line.trim() === "") {
      i++;
      continue;
    }
    // New server (4-space indent).
    const nameMatch = /^    ([a-zA-Z0-9_.-]+)\s*:\s*$/.exec(line);
    if (nameMatch) {
      flush();
      currentName = nameMatch[1]!;
      i++;
      continue;
    }
    // Scalar field (6-space indent, `key: value`).
    const scalarMatch = /^      (\w+)\s*:\s*(.*)$/.exec(line);
    if (scalarMatch && currentName) {
      const key = scalarMatch[1]!;
      const value = scalarMatch[2]!;
      if (key === "command") {
        currentCmd = unquoteYamlString(value);
        readingArgs = false;
        readingEnv = false;
      } else if (key === "args") {
        // Either inline `[a, b]` or block following.
        if (value.length > 0) {
          const inline = /^\[(.*)\]$/.exec(value);
          if (inline) {
            currentArgs = inline[1]!
              .split(",")
              .map((s) => unquoteYamlString(s.trim()))
              .filter((s) => s.length > 0);
          }
          readingArgs = false;
        } else {
          readingArgs = true;
        }
        readingEnv = false;
      } else if (key === "env") {
        readingEnv = value.length === 0;
        readingArgs = false;
        if (!currentEnv) currentEnv = {};
      }
      i++;
      continue;
    }
    // List item (8-space indent `- item`).
    if (readingArgs) {
      const listMatch = /^        -\s+(.+)$/.exec(line);
      if (listMatch) {
        currentArgs.push(unquoteYamlString(listMatch[1]!.trim()));
        i++;
        continue;
      }
      readingArgs = false;
    }
    // Env entry (8-space indent `KEY: value`).
    if (readingEnv) {
      const envMatch = /^        (\w+)\s*:\s*(.*)$/.exec(line);
      if (envMatch) {
        if (!currentEnv) currentEnv = {};
        currentEnv[envMatch[1]!] = unquoteYamlString(envMatch[2]!);
        i++;
        continue;
      }
      readingEnv = false;
    }
    // Anything else — break out.
    i++;
  }
  flush();
  return servers;
}

/**
 * Quote a YAML scalar when it contains characters that would otherwise
 * parse as something else (colons, leading/trailing spaces, `#`, etc).
 */
function quoteYamlString(s: string): string {
  if (s === "") return '""';
  if (/^[a-zA-Z0-9_./+\\-]+$/.test(s) && !/^(true|false|null|yes|no|~)$/i.test(s)) {
    return s;
  }
  // Use double-quoted form with backslash escaping.
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function unquoteYamlString(s: string): string {
  const t = s.trim();
  if (t.length === 0) return t;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    const body = t.slice(1, -1);
    if (t.startsWith('"')) {
      return body.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return body.replace(/''/g, "'");
  }
  return t;
}

/**
 * Merge an aider MCP entry. Returns the new file contents (full YAML
 * body including preserved `preamble` / `trailing`) and a `changed`
 * flag. Caller is responsible for the atomic write.
 */
export function mergeAiderEntry(
  existing: string | null,
  name: string,
  entry: McpServerEntry,
): { body: string; changed: boolean } {
  const base = existing ?? "";
  const parsed = parseAiderYamlSubtree(base);
  const prior = parsed.servers[name];
  const next: McpServerEntry = { command: entry.command, args: [...entry.args] };
  if (entry.env && Object.keys(entry.env).length > 0) {
    next.env = { ...entry.env };
  }
  const changed =
    !prior ||
    prior.command !== next.command ||
    !arraysEqual(prior.args, next.args) ||
    !envEqual(prior.env, next.env);
  parsed.servers[name] = next;
  const yaml = emitAiderYaml(parsed.servers);
  const body =
    (parsed.preamble.length > 0 ? parsed.preamble : "") +
    yaml +
    (parsed.trailing.length > 0 ? parsed.trailing : "");
  return { body: body.endsWith("\n") ? body : body + "\n", changed };
}

/**
 * Remove an aider MCP entry. Noop when the entry doesn't exist.
 */
export function removeAiderEntry(
  existing: string | null,
  name: string,
): { body: string | null; changed: boolean } {
  if (!existing) return { body: null, changed: false };
  const parsed = parseAiderYamlSubtree(existing);
  if (!(name in parsed.servers)) {
    return { body: existing, changed: false };
  }
  delete parsed.servers[name];
  const yaml = emitAiderYaml(parsed.servers);
  const body =
    (parsed.preamble.length > 0 ? parsed.preamble : "") +
    yaml +
    (parsed.trailing.length > 0 ? parsed.trailing : "");
  return { body: body.endsWith("\n") ? body : body + "\n", changed: true };
}

function envEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if ((a ?? {})[ka[i]!] !== (b ?? {})[kb[i]!]) return false;
  }
  return true;
}
