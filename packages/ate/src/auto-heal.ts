/**
 * auto-heal — deterministic selector-drift healer (Phase A.2).
 *
 * Input:  a failure.v1 payload with `kind === "selector_drift"`.
 * Output: a ranked candidate list `{ change, old, new, confidence, reason }`.
 *
 * Similarity = 0.5 * text_match + 0.3 * role_match + 0.2 * dom_proximity
 *
 * where:
 *   text_match     = 1 if normalized text equals target text else
 *                    Levenshtein-based fuzzy ratio
 *   role_match     = 1 if ARIA role / tag matches else 0
 *   dom_proximity  = 1 - (normalized levenshtein of DOM path strings)
 *
 * Confidence threshold precedence (highest wins):
 *   1. explicit `threshold` argument to `autoHeal(...)`
 *   2. `.mandu/config.json` -> `{ ate: { autoHealThreshold: number } }`
 *   3. `MANDU_ATE_AUTO_HEAL_THRESHOLD` env var
 *   4. default: 0.75
 *
 * Design constraints:
 *   - **Dry-run by default.** `autoHeal` never writes. `applyHeal`
 *     is a separate call that takes an already-approved candidate.
 *   - No LLM, no network. Similarity math only.
 *   - Output list is sorted high-confidence-first and filtered by
 *     the threshold (items below it are dropped, not marked
 *     "requires_llm" — the failure JSON's `healing.requires_llm`
 *     flag already covers that).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureV1, HealAction } from "../schemas/failure.v1";
import { appendMemoryEvent } from "./memory/store";
import { nowTimestamp } from "./memory/schema";

const DEFAULT_THRESHOLD = 0.75;

export interface AutoHealOptions {
  /** Override threshold for this call. Precedence: arg > config > env > default. */
  threshold?: number;
  /** Inject repoRoot so config lookup works outside tests. */
  repoRoot?: string;
}

export interface ApplyHealOptions {
  repoRoot: string;
  /** Absolute OR repo-relative path to the spec file. */
  spec: string;
  change: HealAction;
}

export interface ApplyHealResult {
  applied: boolean;
  spec: string;
  changedLines: number;
  error?: string;
}

/**
 * Dry-run healer. Given a `selector_drift` failure, returns the
 * candidate replacements that exceed the resolved threshold.
 *
 * Returns an empty array when the failure kind is not
 * `selector_drift` or when no candidate clears the bar — callers
 * should treat empty output as "needs LLM" and flip
 * `healing.requires_llm = true` upstream.
 */
export function autoHeal(failure: FailureV1, options: AutoHealOptions = {}): HealAction[] {
  if (failure.kind !== "selector_drift") return [];
  const detail = failure.detail;

  const threshold = resolveThreshold(options);
  const old = detail.old;
  const candidates = detail.domCandidates ?? [];

  const scored: HealAction[] = candidates
    .map((c) => ({
      change: "selector_replace",
      old,
      new: c.selector,
      // The caller (context-builder / runner) is expected to have
      // already computed a similarity that uses the 0.5/0.3/0.2 split
      // from the docstring. `computeSimilarity` below is exposed for
      // runners that have raw DOM access instead.
      confidence: clampUnit(c.similarity),
      reason: c.reason ?? (c.text ? `text="${c.text}"` : undefined),
    }))
    .filter((a) => typeof a.confidence === "number" && a.confidence! >= threshold);

  scored.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return scored;
}

/**
 * Apply one healing action to a spec file. In-place string replace,
 * creating no backup (the caller is responsible for git-level safety).
 *
 * Only `selector_replace` is supported in Phase A.2. Unknown change
 * types are rejected with `applied: false`.
 */
export function applyHeal(options: ApplyHealOptions): ApplyHealResult {
  const { repoRoot, spec, change } = options;
  if (change.change !== "selector_replace" || !change.old || !change.new) {
    return {
      applied: false,
      spec,
      changedLines: 0,
      error: `Unsupported or incomplete change: ${change.change}`,
    };
  }
  const abs = resolveSpecPath(repoRoot, spec);
  if (!existsSync(abs)) {
    return { applied: false, spec: abs, changedLines: 0, error: "Spec file not found" };
  }
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch (err) {
    return {
      applied: false,
      spec: abs,
      changedLines: 0,
      error: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const escapedOld = escapeRegex(change.old);
  const regex = new RegExp(escapedOld, "g");
  const changedLines = (source.match(regex) ?? []).length;
  if (changedLines === 0) {
    return { applied: false, spec: abs, changedLines: 0, error: "Selector not found in spec" };
  }
  const updated = source.replace(regex, change.new);
  try {
    writeFileSync(abs, updated, "utf8");
  } catch (err) {
    return {
      applied: false,
      spec: abs,
      changedLines: 0,
      error: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Phase B.2 — auto-record accepted healing event to memory. Failures
  // here are non-fatal; the heal itself already succeeded.
  try {
    appendMemoryEvent(repoRoot, {
      kind: "accepted_healing",
      timestamp: nowTimestamp(),
      specPath: abs,
      change: { change: change.change, old: change.old, new: change.new },
      // Confidence is the caller's field on the HealAction shape.
      confidence:
        typeof (change as { confidence?: number }).confidence === "number"
          ? (change as { confidence: number }).confidence
          : 0,
    });
  } catch {
    // swallow — memory writes must not block heal propagation.
  }

  return { applied: true, spec: abs, changedLines };
}

/**
 * Similarity scoring helper — exposed for runners that can produce
 * live DOM samples rather than pre-computed candidate similarities.
 *
 * `old` and `candidate` are selector strings; `target` is the target
 * DOM element shape (text + role + path). When `target` is omitted
 * the score degenerates to DOM-path proximity only (0.2 weight).
 */
export interface SimilarityInput {
  old: string;
  candidate: string;
  target?: {
    text?: string;
    role?: string;
    path?: string;
  };
  candidateAttrs?: {
    text?: string;
    role?: string;
    path?: string;
  };
}

export function computeSimilarity(input: SimilarityInput): number {
  const text = similarityText(input.target?.text, input.candidateAttrs?.text);
  const role = similarityRole(input.target?.role, input.candidateAttrs?.role);
  const dom = similarityDomPath(
    input.target?.path ?? input.old,
    input.candidateAttrs?.path ?? input.candidate,
  );
  const score = 0.5 * text + 0.3 * role + 0.2 * dom;
  return clampUnit(score);
}

// ────────────────────────────────────────────────────────────────────────────
// threshold resolution
// ────────────────────────────────────────────────────────────────────────────

function resolveThreshold(options: AutoHealOptions): number {
  if (typeof options.threshold === "number" && Number.isFinite(options.threshold)) {
    return clampUnit(options.threshold);
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  const cfg = readConfigThreshold(repoRoot);
  if (typeof cfg === "number") return clampUnit(cfg);
  const env = readEnvThreshold();
  if (typeof env === "number") return clampUnit(env);
  return DEFAULT_THRESHOLD;
}

function readConfigThreshold(repoRoot: string): number | null {
  const candidate = join(repoRoot, ".mandu", "config.json");
  if (!existsSync(candidate)) return null;
  try {
    const raw = readFileSync(candidate, "utf8");
    const parsed = JSON.parse(raw) as {
      ate?: { autoHealThreshold?: unknown };
    };
    const value = parsed?.ate?.autoHealThreshold;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function readEnvThreshold(): number | null {
  const raw = process.env.MANDU_ATE_AUTO_HEAL_THRESHOLD;
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ────────────────────────────────────────────────────────────────────────────
// similarity primitives
// ────────────────────────────────────────────────────────────────────────────

function similarityText(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  return 1 - levenshteinRatio(na, nb);
}

function similarityRole(a?: string, b?: string): number {
  if (!a || !b) return 0;
  return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
}

function similarityDomPath(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = normalizeSelector(a);
  const nb = normalizeSelector(b);
  if (na === nb) return 1;
  return 1 - levenshteinRatio(na, nb);
}

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeSelector(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length ? 1 : 0;
  if (!b.length) return 1;
  const dist = levenshtein(a, b);
  return dist / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j - 1], dp[j]);
      prev = temp;
    }
  }
  return dp[n];
}

// ────────────────────────────────────────────────────────────────────────────
// path helpers
// ────────────────────────────────────────────────────────────────────────────

function resolveSpecPath(repoRoot: string, spec: string): string {
  // Treat as absolute when it looks like one (Windows drive letter or
  // POSIX root). Otherwise join with repoRoot.
  if (/^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith("/")) return spec;
  return join(repoRoot, spec);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
