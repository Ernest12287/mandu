/**
 * Phase B.2 — memory store.
 *
 * Append-only JSONL at `.mandu/ate-memory.jsonl`. Auto-rotates when the
 * active file exceeds 10 MB — the rotated file becomes
 * `.mandu/ate-memory.<timestamp>.jsonl.bak` and a fresh `.jsonl` begins.
 *
 * Design notes:
 *   - Project-local only (decision §11 #3). No global fallback.
 *   - Corrupt lines are SKIPPED on read (best-effort trail, not a ledger).
 *   - Rotation threshold is 10 MB (spec §B.2). Callers may override with
 *     `MANDU_ATE_MEMORY_MAX_BYTES` env for tests.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../fs";
import { parseMemoryEvent, type MemoryEvent } from "./schema";

const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;

export function memoryFilePath(repoRoot: string): string {
  return join(repoRoot, ".mandu", "ate-memory.jsonl");
}

export function memoryDir(repoRoot: string): string {
  return join(repoRoot, ".mandu");
}

function rotateThreshold(): number {
  const raw = process.env.MANDU_ATE_MEMORY_MAX_BYTES;
  if (!raw) return DEFAULT_ROTATE_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ROTATE_BYTES;
}

export interface AppendMemoryResult {
  written: true;
  /** When rotation fired, the path of the archived .bak file. */
  rotation?: { oldPath: string };
}

/**
 * Append one event. Creates `.mandu/` if missing. Returns a rotation
 * descriptor when the new write pushed the file past the threshold.
 */
export function appendMemoryEvent(
  repoRoot: string,
  event: MemoryEvent,
): AppendMemoryResult {
  ensureDir(memoryDir(repoRoot));
  const path = memoryFilePath(repoRoot);
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(path, line, "utf8");

  // After the write, check whether we've tripped the rotate cap.
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    size = 0;
  }
  if (size >= rotateThreshold()) {
    const rotated = rotateNow(repoRoot);
    if (rotated) return { written: true, rotation: { oldPath: rotated } };
  }
  return { written: true };
}

/**
 * Force rotation. Returns the archived path, or `null` when the file
 * doesn't exist or is empty. Exposed for CLI / tests.
 */
export function rotateNow(repoRoot: string): string | null {
  const current = memoryFilePath(repoRoot);
  if (!existsSync(current)) return null;
  let size = 0;
  try {
    size = statSync(current).size;
  } catch {
    return null;
  }
  if (size === 0) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = join(memoryDir(repoRoot), `ate-memory.${stamp}.jsonl.bak`);
  try {
    renameSync(current, archived);
  } catch {
    // Fallback: copy + truncate. rename fails on some Windows filesystems
    // when the target already exists with an atomic rename lock.
    try {
      const content = readFileSync(current, "utf8");
      writeFileSync(archived, content, "utf8");
      unlinkSync(current);
    } catch {
      return null;
    }
  }
  return archived;
}

/**
 * Stream every parseable event from the active JSONL. Corrupt lines
 * are silently skipped. Most recent event is at the tail — callers that
 * want reverse order should reverse after.
 */
export function readMemoryEvents(repoRoot: string): MemoryEvent[] {
  const path = memoryFilePath(repoRoot);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: MemoryEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = parseMemoryEvent(JSON.parse(line));
      if (parsed) out.push(parsed);
    } catch {
      // skip
    }
  }
  return out;
}

export interface MemoryStats {
  total: number;
  byKind: Record<string, number>;
  bytes: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  /** Absolute path to the jsonl file (whether it exists or not). */
  path: string;
}

/** Aggregate — used by `mandu ate memory stats`. */
export function memoryStats(repoRoot: string): MemoryStats {
  const path = memoryFilePath(repoRoot);
  const byKind: Record<string, number> = {};
  let total = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  let bytes = 0;

  if (existsSync(path)) {
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = 0;
    }
    for (const ev of readMemoryEvents(repoRoot)) {
      total += 1;
      byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
      if (oldest === null || ev.timestamp < oldest) oldest = ev.timestamp;
      if (newest === null || ev.timestamp > newest) newest = ev.timestamp;
    }
  }

  return {
    total,
    byKind,
    bytes,
    oldestTimestamp: oldest,
    newestTimestamp: newest,
    path,
  };
}

/** Delete the active jsonl (archived .bak files are kept). */
export function clearMemory(repoRoot: string): boolean {
  const path = memoryFilePath(repoRoot);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
