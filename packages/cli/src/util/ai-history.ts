/**
 * In-memory chat history with JSON save/load (bounded scrollback).
 *
 * Phase 14.2 — Agent F. Owned by `packages/cli/src/commands/ai/chat.ts`.
 *
 * Schema v1 (forward-compatible via `version`):
 *
 * ```json
 * {
 *   "version": 1,
 *   "provider": "claude|openai|gemini|local",
 *   "model": "optional-model-id",
 *   "system": "optional system prompt text",
 *   "savedAt": "ISO-8601 timestamp",
 *   "messages": [
 *     { "role": "user"|"assistant", "content": "..." }
 *   ]
 * }
 * ```
 *
 * We reject malformed files with {@link HistoryValidationError} so the CLI
 * can surface `CLI_E302` cleanly. System messages are NOT stored in
 * `messages[]` — they live on `system` so preset swaps don't pollute the
 * turn history.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PromptMessage, PromptProvider } from "@mandujs/ate/prompts";

/** Maximum turns kept in memory to bound scrollback and prompt size. */
export const HISTORY_MAX_TURNS = 100;

export const HISTORY_SCHEMA_VERSION = 1 as const;

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface HistorySnapshot {
  version: typeof HISTORY_SCHEMA_VERSION;
  provider: PromptProvider;
  model?: string;
  system?: string;
  savedAt: string;
  messages: HistoryTurn[];
}

export class HistoryValidationError extends Error {
  readonly path?: string;
  constructor(message: string, filePath?: string) {
    super(message);
    this.name = "HistoryValidationError";
    this.path = filePath;
  }
}

/** In-memory rolling chat history. */
export class ChatHistory {
  private turns: HistoryTurn[] = [];
  private maxTurns: number;

  constructor(options: { maxTurns?: number } = {}) {
    this.maxTurns = options.maxTurns ?? HISTORY_MAX_TURNS;
    if (!Number.isInteger(this.maxTurns) || this.maxTurns <= 0) {
      throw new Error(`maxTurns must be a positive integer (got ${this.maxTurns})`);
    }
  }

  /** Append a turn, trimming the oldest when the cap is exceeded. */
  push(turn: HistoryTurn): void {
    if (turn.role !== "user" && turn.role !== "assistant") {
      throw new Error(`ChatHistory.push: invalid role "${turn.role}"`);
    }
    if (typeof turn.content !== "string") {
      throw new Error("ChatHistory.push: content must be a string");
    }
    this.turns.push({ role: turn.role, content: turn.content });
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }

  /** Return a shallow copy of turns (callers can't mutate internal state). */
  getTurns(): HistoryTurn[] {
    return this.turns.slice();
  }

  /** Convert turns into PromptMessage[] for adapter.stream. */
  toPromptMessages(systemPrompt?: string): PromptMessage[] {
    const msgs: PromptMessage[] = [];
    if (systemPrompt && systemPrompt.trim().length > 0) {
      msgs.push({ role: "system", content: systemPrompt });
    }
    for (const t of this.turns) {
      msgs.push({ role: t.role, content: t.content });
    }
    return msgs;
  }

  /** Drop all turns. */
  clear(): void {
    this.turns.length = 0;
  }

  /** Current turn count. */
  get size(): number {
    return this.turns.length;
  }

  /** Replace turns wholesale (used by /load). */
  replace(turns: HistoryTurn[]): void {
    this.turns = turns.slice(-this.maxTurns).map((t) => ({ role: t.role, content: t.content }));
  }
}

/**
 * Shape-validate a parsed JSON object as a {@link HistorySnapshot}. Throws
 * {@link HistoryValidationError} on any structural mismatch.
 *
 * Exported so the CLI `/load` command can reuse this for user-facing
 * error messages without pulling in the full chat loop.
 */
export function validateHistorySnapshot(
  raw: unknown,
  filePath?: string,
): HistorySnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HistoryValidationError("history root is not an object", filePath);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== HISTORY_SCHEMA_VERSION) {
    throw new HistoryValidationError(
      `unsupported version ${String(obj.version)} (expected ${HISTORY_SCHEMA_VERSION})`,
      filePath,
    );
  }
  const provider = obj.provider;
  if (
    provider !== "claude" &&
    provider !== "openai" &&
    provider !== "gemini" &&
    provider !== "local"
  ) {
    throw new HistoryValidationError(
      `invalid provider "${String(provider)}"`,
      filePath,
    );
  }
  if (!Array.isArray(obj.messages)) {
    throw new HistoryValidationError("messages is not an array", filePath);
  }
  const turns: HistoryTurn[] = [];
  for (let i = 0; i < obj.messages.length; i += 1) {
    const m = obj.messages[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      throw new HistoryValidationError(`messages[${i}] is not an object`, filePath);
    }
    const mo = m as Record<string, unknown>;
    if (mo.role !== "user" && mo.role !== "assistant") {
      throw new HistoryValidationError(
        `messages[${i}].role must be "user" or "assistant" (got "${String(mo.role)}")`,
        filePath,
      );
    }
    if (typeof mo.content !== "string") {
      throw new HistoryValidationError(
        `messages[${i}].content must be a string`,
        filePath,
      );
    }
    turns.push({ role: mo.role, content: mo.content });
  }
  const system = typeof obj.system === "string" ? obj.system : undefined;
  const model = typeof obj.model === "string" ? obj.model : undefined;
  const savedAt = typeof obj.savedAt === "string" ? obj.savedAt : new Date(0).toISOString();

  return {
    version: HISTORY_SCHEMA_VERSION,
    provider,
    model,
    system,
    savedAt,
    messages: turns,
  };
}

/** Save a snapshot to disk as pretty-printed JSON. */
export async function saveHistory(
  filePath: string,
  snapshot: HistorySnapshot,
): Promise<void> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const serialized = JSON.stringify(snapshot, null, 2) + "\n";
  await fs.writeFile(resolved, serialized, "utf8");
}

/** Load + validate a snapshot. Throws {@link HistoryValidationError} on failure. */
export async function loadHistory(filePath: string): Promise<HistorySnapshot> {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new HistoryValidationError(`file not found: ${resolved}`, resolved);
    }
    throw new HistoryValidationError(
      `cannot read file (${code ?? "IO"}): ${resolved}`,
      resolved,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HistoryValidationError(
      `invalid JSON: ${(err as Error).message}`,
      resolved,
    );
  }
  return validateHistorySnapshot(parsed, resolved);
}

/** Build a snapshot ready for `saveHistory`. */
export function createSnapshot(
  provider: PromptProvider,
  history: ChatHistory,
  extras: { model?: string; system?: string } = {},
): HistorySnapshot {
  return {
    version: HISTORY_SCHEMA_VERSION,
    provider,
    model: extras.model,
    system: extras.system,
    savedAt: new Date().toISOString(),
    messages: history.getTurns(),
  };
}
