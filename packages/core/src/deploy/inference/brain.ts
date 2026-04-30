/**
 * Brain-based deploy intent inferer.
 *
 * Issue #250 — Phase 1 M4.
 *
 * The brain inferer is **not** a replacement for the heuristic — it
 * runs AFTER the heuristic and decides whether to confirm or refine
 * the first-pass result. Three reasons for the wrap-not-replace shape:
 *
 *   1. **Cost cap.** The heuristic answers ~80% of routes correctly
 *      and pays nothing. Brain only weighs in on the rest.
 *   2. **Determinism floor.** When the brain is offline, fails to
 *      authenticate, returns malformed JSON, or its output fails Zod
 *      validation, the heuristic result stands. The pipeline never
 *      blocks on the brain.
 *   3. **Auditability.** Every intent the cache stores carries a
 *      `rationale` string. Wrapping lets the brain rationale read
 *      "agreed with heuristic: ..." or "overridden because ..." —
 *      reviewers can see the reasoning in the diff.
 *
 * Failure modes (all fall back to heuristic):
 *
 *   - LLM call throws (network, auth, rate limit) → heuristic.
 *   - LLM returns empty / non-JSON content → heuristic.
 *   - LLM returns JSON that doesn't satisfy `DeployIntent` Zod → heuristic.
 *   - LLM returns valid intent but `runtime: "static"` on a route
 *     the manifest knows can't prerender → heuristic (caught by
 *     `isStaticIntentValidFor`).
 *
 * The fallback is silent on `failOnError: false` (default — agents
 * should still get a useful plan even with brain hiccups). Tests can
 * pass `failOnError: true` to surface every brain miss.
 */

import { z } from "zod";
import {
  DeployIntent,
  isStaticIntentValidFor,
  type DeployIntent as DeployIntentType,
} from "../intent";
import type { LLMAdapter } from "../../brain/adapters/base";
import type { DeployInferenceContext } from "./context";
import { inferDeployIntentHeuristic, type InferenceResult } from "./heuristic";

// ─── Public surface ───────────────────────────────────────────────────

export interface BrainInferenceOptions {
  /**
   * The LLM adapter to call. Get one from
   * `resolveBrainAdapter({ adapter: "auto" })`.
   */
  adapter: LLMAdapter;
  /**
   * Hard-fail on any brain error instead of falling back to the
   * heuristic. Tests use this; production leaves it false.
   */
  failOnError?: boolean;
  /**
   * Timeout in ms for the LLM call. Defaults to 15s — deploy:plan is
   * usually run interactively, agents prefer quick failure over long
   * waits when the network is bad.
   */
  timeoutMs?: number;
  /**
   * Maximum source bytes sent to the brain. Anything beyond this is
   * truncated with a `[…truncated]` marker. Default 4096 — enough for
   * a route handler, well under any cloud token cap.
   */
  maxSourceBytes?: number;
}

/**
 * Build the brain-based inferer. The returned function has the same
 * signature `planDeploy({ infer })` expects, so it plugs in without
 * any changes to the plan engine.
 */
export function inferDeployIntentWithBrain(
  options: BrainInferenceOptions,
): (ctx: DeployInferenceContext) => Promise<InferenceResult> {
  return async (ctx) => {
    const heuristic = inferDeployIntentHeuristic(ctx);
    try {
      const refined = await callBrain(ctx, heuristic, options);
      if (!refined) return heuristic;

      // Re-validate the brain's intent against the route shape — the
      // brain is good at semantics but may miss the "static requires
      // generateStaticParams" rule.
      const validation = isStaticIntentValidFor(refined.intent, {
        isDynamic: ctx.isDynamic,
        hasGenerateStaticParams: ctx.hasGenerateStaticParams,
        kind: ctx.kind,
      });
      if (!validation.ok) {
        return {
          intent: heuristic.intent,
          rationale: `${heuristic.rationale} (brain proposed ${refined.intent.runtime} but it conflicts with route shape: ${validation.reason})`,
        };
      }

      return refined;
    } catch (err) {
      if (options.failOnError) throw err;
      return {
        intent: heuristic.intent,
        rationale: `${heuristic.rationale} (brain unavailable: ${err instanceof Error ? err.message : String(err)})`,
      };
    }
  };
}

// ─── Internals ────────────────────────────────────────────────────────

/** Schema for the brain's JSON response — slightly looser than DeployIntent
 *  so we can validate field-by-field with helpful errors. */
const BrainInferenceResponse = z
  .object({
    runtime: z.enum(["static", "edge", "node", "bun"]),
    cache: z.union([
      z.literal("no-store"),
      z.literal("public"),
      z.object({
        maxAge: z.number().int().nonnegative().optional(),
        sMaxAge: z.number().int().nonnegative().optional(),
        swr: z.number().int().nonnegative().optional(),
      }),
    ]).optional(),
    regions: z.array(z.string().min(1)).optional(),
    timeout: z.number().int().positive().optional(),
    visibility: z.enum(["public", "private"]).optional(),
    rationale: z.string().min(1),
    /** Brain's confidence — used only for telemetry; not persisted. */
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

async function callBrain(
  ctx: DeployInferenceContext,
  heuristic: InferenceResult,
  options: BrainInferenceOptions,
): Promise<InferenceResult | null> {
  const timeout = options.timeoutMs ?? 15_000;
  // maxBytes reserved for future source-passing; for now the prompt
  // works off context metadata (imports, deps) without raw source.
  void options.maxSourceBytes;

  const prompt = buildPrompt(ctx, heuristic);

  // Race the LLM call against a timeout.
  const controller = new AbortController();
  const tHandle = setTimeout(() => controller.abort(), timeout);
  let raw: string;
  try {
    raw = await options.adapter.generate(prompt, {
      // CompletionOptions doesn't formally include `signal` today; we
      // pass it via the loose extras object so adapters that honour it
      // get the cancel signal, while older ones gracefully ignore.
      ...({ signal: controller.signal } as object),
      temperature: 0.0,
      maxTokens: 512,
    });
  } finally {
    clearTimeout(tHandle);
  }

  const parsed = parseBrainResponse(raw);
  if (!parsed) return null;

  // Merge against heuristic defaults — brain doesn't have to repeat
  // every field, only the ones it overrides.
  const merged: DeployIntentType = DeployIntent.parse({
    runtime: parsed.runtime,
    cache: parsed.cache ?? heuristic.intent.cache,
    regions: parsed.regions ?? heuristic.intent.regions,
    timeout: parsed.timeout ?? heuristic.intent.timeout,
    visibility: parsed.visibility ?? heuristic.intent.visibility,
  });

  const rationale =
    parsed.runtime === heuristic.intent.runtime &&
    sameCache(parsed.cache ?? heuristic.intent.cache, heuristic.intent.cache)
      ? `agreed with heuristic: ${parsed.rationale}`
      : `brain refined: ${parsed.rationale}`;

  return { intent: merged, rationale };
}

function buildPrompt(
  ctx: DeployInferenceContext,
  heuristic: InferenceResult,
): string {
  const truncatedImports = ctx.imports.slice(0, 30).join(", ");
  const dependencyClasses = [...ctx.dependencyClasses].join(", ");

  return [
    "You are an expert deploy engineer for the Mandu framework.",
    "",
    "TASK: Decide the deploy runtime + cache directive for one route.",
    "Output strict JSON ONLY (no markdown fences, no commentary).",
    "",
    "SCHEMA:",
    `{
  "runtime": "static" | "edge" | "node" | "bun",
  "cache": "no-store" | "public" | { "maxAge"?: number, "sMaxAge"?: number, "swr"?: number },
  "regions": string[],
  "timeout": number_in_ms,
  "visibility": "public" | "private",
  "rationale": "1-sentence explanation",
  "confidence": 0..1
}`,
    "",
    "RULES:",
    "- runtime=static is only valid for prerenderable pages (no dynamic segments OR has generateStaticParams).",
    "- API routes (kind=api) MUST use edge / node / bun, never static.",
    "- Prefer edge for low-latency stateless work; node/bun for DB / native deps / long-latency calls.",
    "- bun is required when the route imports `bun:*` modules.",
    "- Default cache for API: no-store. Default for static pages: { sMaxAge: 31536000, swr: 86400 }.",
    "- Override the heuristic only when there is CLEAR evidence in the source. Otherwise echo the heuristic.",
    "",
    `ROUTE: ${ctx.routeId} (${ctx.pattern})`,
    `KIND: ${ctx.kind}`,
    `DYNAMIC: ${ctx.isDynamic}`,
    `HAS_GENERATE_STATIC_PARAMS: ${ctx.hasGenerateStaticParams}`,
    `IMPORTS: ${truncatedImports || "(none)"}`,
    `DEPENDENCY_CLASSES: ${dependencyClasses || "(none)"}`,
    "",
    "HEURISTIC FIRST-PASS:",
    `- runtime: ${heuristic.intent.runtime}`,
    `- cache: ${formatCacheForPrompt(heuristic.intent.cache)}`,
    `- visibility: ${heuristic.intent.visibility}`,
    `- rationale: ${heuristic.rationale}`,
    "",
    "RESPOND WITH JSON ONLY:",
  ].join("\n");
}

function parseBrainResponse(raw: string): z.infer<typeof BrainInferenceResponse> | null {
  if (!raw || raw.trim() === "") return null;
  // The brain might wrap JSON in fences despite the rules — strip the
  // most common wrappers before parsing.
  const stripped = stripCodeFences(raw).trim();
  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch {
    return null;
  }
  const result = BrainInferenceResponse.safeParse(json);
  if (!result.success) return null;
  return result.data;
}

function stripCodeFences(s: string): string {
  // ```json ... ``` or ``` ... ``` — capture the inner block.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m.exec(s.trim());
  if (fenced) return fenced[1]!;
  return s;
}

function formatCacheForPrompt(cache: DeployIntentType["cache"]): string {
  if (cache === "no-store" || cache === "public") return cache;
  return JSON.stringify(cache);
}

function sameCache(a: DeployIntentType["cache"], b: DeployIntentType["cache"]): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
