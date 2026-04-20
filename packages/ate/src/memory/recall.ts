/**
 * Phase B.2 — memory recall.
 *
 * Query the append-only JSONL with simple substring + token-overlap
 * scoring. No embeddings (decision §B.2 privacy note — LLM-free).
 *
 * Score formula per event:
 *   baseScore  = 1 if kind filter matches else 0
 *   intentHit  = token-overlap( query.intent, event.intent )
 *   routeHit   = 1 if query.route matches event.routeId else 0
 *   finalScore = intentHit + 0.4 * routeHit + 0.1 * recency
 *
 * Where recency is in [0,1], linear over the 90-day window.
 *
 * Tie-break on finalScore: newest-first (events are already read in
 * append order).
 */
import type { MemoryEvent, MemoryEventKind } from "./schema";
import { readMemoryEvents } from "./store";

export interface RecallQuery {
  intent?: string;
  /** Route id ("api-signup") OR route pattern ("/api/signup"). */
  route?: string;
  kind?: MemoryEventKind;
  limit?: number;
  sinceDays?: number;
}

export interface RecallResult {
  events: MemoryEvent[];
  totalMatching: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_SINCE_DAYS = 90;

export function recallMemory(repoRoot: string, query: RecallQuery = {}): RecallResult {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const sinceDays = query.sinceDays ?? DEFAULT_SINCE_DAYS;
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  const all = readMemoryEvents(repoRoot);
  const scored: Array<{ event: MemoryEvent; score: number }> = [];

  for (const ev of all) {
    const t = Date.parse(ev.timestamp);
    if (Number.isFinite(t) && t < sinceMs) continue;

    if (query.kind && ev.kind !== query.kind) continue;

    let score = 1;
    if (query.intent) {
      const intentSource = extractIntentText(ev);
      score += tokenOverlapScore(query.intent, intentSource);
    }
    if (query.route) {
      const routeSource = extractRouteText(ev);
      if (routeSource && matchesRoute(query.route, routeSource)) score += 0.4;
      else if (query.route) score -= 0.2; // weak penalty — caller wanted a route filter.
    }

    // Recency boost (up to 0.1).
    if (Number.isFinite(t)) {
      const ageMs = Date.now() - t;
      const windowMs = sinceDays * 24 * 60 * 60 * 1000;
      const recency = Math.max(0, 1 - ageMs / windowMs);
      score += 0.1 * recency;
    }

    scored.push({ event: ev, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // newest first
    return b.event.timestamp.localeCompare(a.event.timestamp);
  });

  const matching = scored.filter((s) => s.score > 0);
  return {
    events: matching.slice(0, limit).map((s) => s.event),
    totalMatching: matching.length,
  };
}

/**
 * Token overlap — pre-normalized. Case-folded, split on [^a-z0-9].
 * Returns a ratio in [0, 1]. Substring match also contributes.
 */
export function tokenOverlapScore(query: string, target: string): number {
  const q = tokenize(query);
  const t = tokenize(target);
  if (q.size === 0 || t.size === 0) return 0;
  let overlap = 0;
  for (const tok of q) if (t.has(tok)) overlap += 1;
  const base = overlap / q.size;

  // Light substring bonus so "signup form" lightly matches "signup-flow".
  const substring = target.toLowerCase().includes(query.toLowerCase().trim()) ? 0.2 : 0;

  return Math.min(1, base + substring);
}

function tokenize(s: string): Set<string> {
  const parts = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(parts);
}

function extractIntentText(ev: MemoryEvent): string {
  switch (ev.kind) {
    case "intent_history":
      return ev.intent;
    case "rejected_spec":
    case "rejected_healing":
      return ev.reason;
    case "accepted_healing":
      return JSON.stringify(ev.change);
    case "boundary_gap_filled":
      return ev.contractName;
    case "prompt_version_drift":
      return `${ev.kindName} v${ev.oldVersion}→v${ev.newVersion}`;
    case "coverage_snapshot":
      return `coverage ${ev.withSpec}/${ev.routes}`;
    default:
      return "";
  }
}

function extractRouteText(ev: MemoryEvent): string | undefined {
  switch (ev.kind) {
    case "intent_history":
    case "rejected_spec":
      return ev.routeId;
    case "accepted_healing":
    case "rejected_healing":
      return ev.specPath;
    default:
      return undefined;
  }
}

function matchesRoute(query: string, target: string): boolean {
  if (query === target) return true;
  // Normalize: `/api/signup` vs `api-signup`.
  const q = query.replace(/^\//, "").replace(/\//g, "-");
  const t = target.replace(/^\//, "").replace(/\//g, "-");
  return q === t || target.toLowerCase().includes(query.toLowerCase());
}
