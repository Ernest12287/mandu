/**
 * Heuristic deploy intent inferer.
 *
 * Issue #250 — Phase 1.
 *
 * The rule tree below is the offline, brain-free inferer. It produces
 * an intent for every route the manifest contains using nothing but
 * the source code and manifest metadata gathered by `context.ts`.
 *
 * Design constraints:
 *
 *   1. **Conservative on doubt.** When a signal is ambiguous, prefer
 *      `node`/`bun` over `edge` and `no-store` over caching. A
 *      slightly-too-pessimistic intent is fixable with one explicit
 *      `.deploy()` call; a too-aggressive one breaks production.
 *
 *   2. **Deterministic.** Same context → same intent, byte-for-byte.
 *      The cache hashes the source so unchanged routes never re-
 *      infer; we don't want flapping intents across runs.
 *
 *   3. **Reasoned.** Every result carries a `rationale` string. Plan
 *      diff surfaces it so reviewers can audit "why edge here?".
 *
 *   4. **Replaceable.** The brain inferer (M4) calls into the same
 *      shape (`InferenceResult`) so adapters never need to know which
 *      engine produced the intent.
 */

import type { DeployIntent } from "../intent";
import type { DependencyClass, DeployInferenceContext } from "./context";

export interface InferenceResult {
  intent: DeployIntent;
  rationale: string;
}

/**
 * Run the rule tree on a single route context.
 *
 * The rules below are checked top-to-bottom; the first match wins.
 * Adding a new rule? Put it in priority order — the most specific /
 * highest-confidence rule first.
 */
export function inferDeployIntentHeuristic(
  ctx: DeployInferenceContext,
): InferenceResult {
  // ─── Metadata routes (sitemap.xml, robots.txt, llms.txt, manifest.json)
  if (ctx.kind === "metadata") {
    return {
      intent: {
        runtime: "static",
        cache: { sMaxAge: 3600, swr: 86_400 },
        visibility: "public",
      },
      rationale:
        "metadata route — sitemap/robots/llms.txt are stable across requests; prerender + 1h s-maxage with 1d SWR.",
    };
  }

  // ─── Page routes
  if (ctx.kind === "page") {
    // Static-prerenderable: no dynamic segments, OR has generateStaticParams.
    if (!ctx.isDynamic) {
      return {
        intent: {
          runtime: "static",
          cache: { sMaxAge: 31_536_000, swr: 86_400 },
          visibility: "public",
        },
        rationale: "page with no dynamic segments — prerender at build time.",
      };
    }
    if (ctx.hasGenerateStaticParams) {
      return {
        intent: {
          runtime: "static",
          cache: { sMaxAge: 31_536_000, swr: 86_400 },
          visibility: "public",
        },
        rationale:
          "dynamic page exports generateStaticParams — every parameter combination prerenders at build time.",
      };
    }
    // Dynamic page without static params: needs SSR. Pick edge unless
    // the handler imports something edge can't run.
    if (canRunOnEdge(ctx.dependencyClasses)) {
      return {
        intent: {
          runtime: "edge",
          cache: "no-store",
          visibility: "public",
        },
        rationale:
          "dynamic page (SSR) with no Node/Bun-only dependencies — edge runtime keeps latency low.",
      };
    }
    return {
      intent: {
        runtime: pickServerRuntime(ctx.dependencyClasses),
        cache: "no-store",
        visibility: "public",
      },
      rationale: explainServerRuntime(ctx.dependencyClasses, "page"),
    };
  }

  // ─── API routes
  // APIs are never `static`. Pick edge when stateless, server runtime
  // otherwise. Cache always defaults to `no-store` — caching API
  // responses is a deliberate decision, not something we infer.
  if (canRunOnEdge(ctx.dependencyClasses)) {
    return {
      intent: {
        runtime: "edge",
        cache: "no-store",
        visibility: "public",
      },
      rationale:
        "API route with only fetch-class dependencies — edge runtime; opt into caching with .deploy({ cache }).",
    };
  }
  return {
    intent: {
      runtime: pickServerRuntime(ctx.dependencyClasses),
      cache: "no-store",
      visibility: "public",
    },
    rationale: explainServerRuntime(ctx.dependencyClasses, "API"),
  };
}

// ─── Rule-tree primitives ────────────────────────────────────────────

/**
 * The classes that disqualify edge — DB drivers (open TCP sockets and
 * ship native modules), Node-only filesystem/networking modules, Bun
 * native primitives (sqlite/ffi/s3), AI SDKs (long-running, large
 * payloads), and explicitly heavy native libraries (sharp/playwright).
 */
const NON_EDGE_CLASSES: ReadonlySet<DependencyClass> = new Set([
  "db",
  "node-fs",
  "node-net",
  "node-child",
  "bun-native",
  "ai-sdk",
  "heavy",
]);

function canRunOnEdge(classes: ReadonlySet<DependencyClass>): boolean {
  for (const cls of classes) {
    if (NON_EDGE_CLASSES.has(cls)) return false;
  }
  return true;
}

/**
 * Choose between `bun` and `node` for routes that must run on a
 * server runtime. `bun-native` imports force `bun`; everything else
 * defaults to `node` for maximum portability (every adapter supports
 * Node; not every adapter supports Bun yet).
 */
function pickServerRuntime(classes: ReadonlySet<DependencyClass>): "node" | "bun" {
  return classes.has("bun-native") ? "bun" : "node";
}

function explainServerRuntime(
  classes: ReadonlySet<DependencyClass>,
  routeLabel: string,
): string {
  const reasons: string[] = [];
  if (classes.has("db")) reasons.push("imports a database driver");
  if (classes.has("node-fs")) reasons.push("uses node:fs");
  if (classes.has("node-net")) reasons.push("uses node:net/tls/dgram");
  if (classes.has("node-child")) reasons.push("uses node:child_process or worker_threads");
  if (classes.has("bun-native")) reasons.push("imports bun:* primitives");
  if (classes.has("ai-sdk")) reasons.push("imports an AI SDK (long latency)");
  if (classes.has("heavy")) reasons.push("imports a heavy native dependency");
  const why = reasons.length > 0 ? reasons.join(", ") : "non-edge dependencies";
  const runtime = pickServerRuntime(classes);
  return `${routeLabel} ${why} — ${runtime} runtime required.`;
}
