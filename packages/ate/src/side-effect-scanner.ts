/**
 * Side-effect scanner — detects mutating operations in route/slot source files.
 *
 * Detects:
 *   - DB mutations: db.X.create|update|delete, prisma.X.create|update|delete|upsert,
 *     drizzle-like `.insert(...)`, `.update(...)`, `.delete(...)` calls
 *   - Email: sendEmail(, mailer.send(, transporter.sendMail(
 *   - External fetch: fetch("http...") or fetch(`https...`) (non-localhost)
 *
 * Uses regex on source text — lightweight and doesn't require a TypeScript project.
 */
import fg from "fast-glob";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type SideEffectKind = "db-create" | "db-update" | "db-delete" | "email" | "external-fetch";

export interface SideEffect {
  kind: SideEffectKind;
  /** Detected resource name if available (e.g. "users" for db.users.create) */
  resource?: string;
  /** Raw matched text for debugging */
  match: string;
}

export interface SideEffectScanResult {
  file: string;
  effects: SideEffect[];
}

const DB_CREATE_PATTERNS: RegExp[] = [
  // db.users.create(, prisma.user.create(, prisma.user.createMany(
  /\b(?:db|prisma)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\.\s*create(?:Many)?\s*\(/g,
  // drizzle-ish: db.insert(users) / .insert(users).values(
  /\b(?:db|drizzle)\s*\.\s*insert\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
];
const DB_UPDATE_PATTERNS: RegExp[] = [
  /\b(?:db|prisma)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\.\s*(?:update(?:Many)?|upsert)\s*\(/g,
  /\b(?:db|drizzle)\s*\.\s*update\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
];
const DB_DELETE_PATTERNS: RegExp[] = [
  /\b(?:db|prisma)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\.\s*delete(?:Many)?\s*\(/g,
  /\b(?:db|drizzle)\s*\.\s*delete\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
];
const EMAIL_PATTERNS: RegExp[] = [
  /\bsendEmail\s*\(/g,
  /\b(?:mailer|transporter)\s*\.\s*(?:send|sendMail)\s*\(/g,
  /\bresend\s*\.\s*emails\s*\.\s*send\s*\(/g,
];
// Match fetch("http(s)://...") or fetch(`http(s)://...`) where URL is not localhost/127.x
const EXTERNAL_FETCH_PATTERN =
  /\bfetch\s*\(\s*[`'"](https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^`'"]+)[`'"]/g;

export function scanSourceForSideEffects(source: string): SideEffect[] {
  const effects: SideEffect[] = [];

  const scan = (patterns: RegExp[], kind: SideEffectKind) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        effects.push({ kind, resource: m[1], match: m[0] });
      }
    }
  };

  scan(DB_CREATE_PATTERNS, "db-create");
  scan(DB_UPDATE_PATTERNS, "db-update");
  scan(DB_DELETE_PATTERNS, "db-delete");

  for (const re of EMAIL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      effects.push({ kind: "email", match: m[0] });
    }
  }

  EXTERNAL_FETCH_PATTERN.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = EXTERNAL_FETCH_PATTERN.exec(source)) !== null) {
    effects.push({ kind: "external-fetch", match: fm[1] });
  }

  return effects;
}

export function scanFileForSideEffects(filePath: string): SideEffectScanResult | null {
  if (!existsSync(filePath)) return null;
  try {
    const source = readFileSync(filePath, "utf8");
    return { file: filePath, effects: scanSourceForSideEffects(source) };
  } catch {
    return null;
  }
}

/**
 * Scan all slot files and the route file itself (for inline handler patterns).
 * Returns aggregated side effects across all related source files.
 */
export function scanRouteSideEffects(routeFileAbs: string): SideEffect[] {
  const effects: SideEffect[] = [];

  // 1. Scan route file directly
  const routeResult = scanFileForSideEffects(routeFileAbs);
  if (routeResult) effects.push(...routeResult.effects);

  // 2. Scan colocated slot files
  try {
    const dir = dirname(routeFileAbs);
    const slots = fg.sync(["*.slot.ts", "*.slot.tsx"], {
      cwd: dir,
      absolute: true,
      onlyFiles: true,
    });
    for (const slot of slots) {
      const r = scanFileForSideEffects(slot);
      if (r) effects.push(...r.effects);
    }
  } catch {
    // ignore
  }

  return effects;
}
