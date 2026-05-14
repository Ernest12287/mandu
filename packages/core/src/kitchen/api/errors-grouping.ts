/**
 * Plan 18 P1-4 — Error grouping for the Kitchen Errors panel.
 *
 * The Kitchen error ring buffer (`kitchen-handler.ts:storedErrors`) is a
 * flat list. When the same hydration failure or unhandled rejection
 * fires repeatedly on every render, the buffer fills with near-identical
 * rows and the operator has to scroll through them to spot the count.
 *
 * `groupErrors()` collapses runs of "the same error" into one row with
 * count / first-seen / last-seen / affected-sources / a representative
 * sample. The group key is intentionally conservative so that
 * superficially different errors stay separate:
 *
 *   key = sha1(`${type}|${source}|${normalize(message)}`)
 *
 * `normalize` collapses obvious noise (numbers, UUIDs, file:line refs)
 * but leaves stack-shape and message word order intact. This is a
 * smaller hammer than full stack-trace fingerprinting — that lives
 * elsewhere if we ever need it.
 */

import crypto from "node:crypto";

export interface KitchenErrorLike {
  id?: string;
  type?: string;
  severity?: string;
  message: string;
  stack?: string;
  url?: string;
  source?: string;
  line?: number;
  column?: number;
  timestamp?: number;
}

export interface GroupedError {
  /** Stable hash of (type, source, normalized message). */
  key: string;
  /** How many raw errors collapsed into this group. */
  count: number;
  /** Representative event — the most recent occurrence. */
  sample: KitchenErrorLike;
  /** Severity of the sample. Same across the group in practice. */
  severity: string | undefined;
  /** Earliest timestamp seen for this signature. */
  firstSeen: number;
  /** Latest timestamp seen for this signature. */
  lastSeen: number;
  /** Distinct source / file refs across the group, capped for transport. */
  affectedSources: string[];
}

const NUM_RE = /\d{1,}/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b0x[0-9a-f]+\b/gi;

/**
 * Replace noise that varies run-to-run but doesn't change which bug is
 * being reported. Kept intentionally narrow so user-visible message
 * structure stays recognizable for the operator.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(UUID_RE, "<UUID>")
    .replace(HEX_RE, "<HEX>")
    .replace(NUM_RE, "<N>")
    .trim()
    .toLowerCase();
}

export function errorKey(err: KitchenErrorLike): string {
  const parts = [
    err.type ?? "runtime",
    err.source ?? "unknown",
    normalizeMessage(err.message ?? ""),
  ].join("|");
  return crypto.createHash("sha1").update(parts).digest("hex").slice(0, 16);
}

export interface GroupOptions {
  /** Cap `affectedSources` length in the response. Default 5. */
  maxSourcesPerGroup?: number;
}

/**
 * Collapse a flat error list into `GroupedError[]`, newest-group first.
 * Stable: a single error becomes a group of size 1.
 */
export function groupErrors(errors: readonly KitchenErrorLike[], options: GroupOptions = {}): GroupedError[] {
  const maxSources = options.maxSourcesPerGroup ?? 5;
  const byKey = new Map<string, GroupedError>();

  for (const err of errors) {
    const key = errorKey(err);
    const ts = err.timestamp ?? 0;
    const existing = byKey.get(key);
    if (!existing) {
      const sources = err.source ? [err.source] : [];
      byKey.set(key, {
        key,
        count: 1,
        sample: err,
        severity: err.severity,
        firstSeen: ts,
        lastSeen: ts,
        affectedSources: sources,
      });
      continue;
    }
    existing.count += 1;
    if (ts < existing.firstSeen || existing.firstSeen === 0) existing.firstSeen = ts;
    if (ts > existing.lastSeen) {
      existing.lastSeen = ts;
      existing.sample = err; // newest wins so the operator sees the freshest message
    }
    if (err.source && !existing.affectedSources.includes(err.source)) {
      if (existing.affectedSources.length < maxSources) {
        existing.affectedSources.push(err.source);
      }
    }
  }

  // Newest groups first — the operator wants the most recent regression up top.
  return Array.from(byKey.values()).sort((a, b) => b.lastSeen - a.lastSeen);
}
