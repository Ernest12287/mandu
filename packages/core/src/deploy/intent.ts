/**
 * Deploy Intent — typed declaration of how a route should be deployed.
 *
 * Issue #250 — Phase 1.
 *
 * The schema is the contract between three parts of Mandu:
 *
 *   1. Inference (`packages/core/src/deploy/inference/`) — emits intents
 *      from route source + manifest metadata. Heuristic first; OpenAI
 *      brain is optional.
 *
 *   2. Cache (`.mandu/deploy.intent.json`, see `cache.ts`) — versioned,
 *      committable file the inferer writes and adapters read. Re-using
 *      it across runs is what makes deploys deterministic and offline-
 *      capable (no brain call required at deploy time).
 *
 *   3. Adapters (`packages/cli/src/commands/deploy/adapters/*`) —
 *      compile a manifest + intent cache into a provider-specific
 *      config (`vercel.json`, `fly.toml`, …). Adapters never invent
 *      defaults; missing intent for any non-static route is a hard
 *      error so deploys can't drift silently.
 *
 * Schema portability: only fields every supported provider can express
 * live in the core schema. Provider-specific fields (Fly's `vm_size`,
 * Vercel's `memory`, …) go in `overrides` keyed by target name.
 */

import { z } from "zod";

// ─── Runtime ──────────────────────────────────────────────────────────

/**
 * Deploy runtime — the execution model the route ships in.
 *
 *   - `static` — prerendered at build time, served from a CDN. No
 *     server execution at request time. Only valid when the route can
 *     be rendered to bytes ahead of time (no per-request data).
 *   - `edge` — short-lived, V8-isolate-class environment near the
 *     viewer. No filesystem, no native modules. Best for low-latency
 *     transforms and stateless API.
 *   - `node` — long-running server with full Node API. Use when the
 *     route imports things edge can't run (DB drivers, file IO, large
 *     dependencies).
 *   - `bun` — long-running Bun server. Same role as `node` but with
 *     Bun primitives (`bun:sqlite`, `Bun.s3`, etc.). Provider support
 *     varies — Vercel `@vercel/bun` is required for this on Vercel.
 */
export const DeployRuntime = z.enum(["static", "edge", "node", "bun"]);
export type DeployRuntime = z.infer<typeof DeployRuntime>;

// ─── Cache ────────────────────────────────────────────────────────────

/**
 * Cache directive — compiled to provider-specific cache headers /
 * `s-maxage` / `stale-while-revalidate` / etc.
 *
 * Three forms are accepted:
 *
 *   - `"no-store"` — never cache. Default for API routes.
 *   - `"public"` — cache without explicit lifetimes. Use for assets.
 *   - `{ maxAge?, sMaxAge?, swr? }` — explicit lifetimes (seconds).
 *     `maxAge` controls the browser cache, `sMaxAge` the shared CDN
 *     cache, `swr` the stale-while-revalidate window.
 */
export const DeployCacheLifetime = z.object({
  /** Browser cache lifetime in seconds. */
  maxAge: z.number().int().nonnegative().optional(),
  /** Shared CDN cache lifetime in seconds. */
  sMaxAge: z.number().int().nonnegative().optional(),
  /** stale-while-revalidate window in seconds. */
  swr: z.number().int().nonnegative().optional(),
});
export type DeployCacheLifetime = z.infer<typeof DeployCacheLifetime>;

export const DeployCache = z.union([
  z.literal("no-store"),
  z.literal("public"),
  DeployCacheLifetime,
]);
export type DeployCache = z.infer<typeof DeployCache>;

// ─── Visibility ───────────────────────────────────────────────────────

/**
 * Network visibility — public reach vs internal-only. Adapters with no
 * native private-route concept reject this when set to `"private"`.
 */
export const DeployVisibility = z.enum(["public", "private"]);
export type DeployVisibility = z.infer<typeof DeployVisibility>;

// ─── Target ───────────────────────────────────────────────────────────

/**
 * Per-route target override. When set, the route ships to this
 * provider regardless of the top-level `mandu deploy --target=...`
 * flag. Phase 3 makes this load-bearing for heterogeneous deploys
 * ("docs to cf-pages, api to fly, admin to docker"). Phase 1 stores it
 * but the multi-target dispatcher is not yet implemented — a non-
 * matching `target` in Phase 1 raises an error from the adapter.
 */
export const DeployTarget = z.enum(["vercel", "fly", "cf-pages", "docker"]);
export type DeployTarget = z.infer<typeof DeployTarget>;

// ─── Intent ───────────────────────────────────────────────────────────

/**
 * The intent itself. Adapters MUST treat this as the single source of
 * truth — no out-of-band defaults, no provider-specific shortcuts that
 * bypass the schema.
 */
export const DeployIntent = z.object({
  runtime: DeployRuntime,
  cache: DeployCache.default("no-store"),
  /** Geographic regions (provider-specific identifiers). */
  regions: z.array(z.string().min(1)).optional(),
  /** Lower bound on warm instances. */
  minInstances: z.number().int().nonnegative().optional(),
  /** Upper bound on concurrent instances. */
  maxInstances: z.number().int().positive().optional(),
  /** Per-request execution timeout in milliseconds. */
  timeout: z.number().int().positive().optional(),
  visibility: DeployVisibility.default("public"),
  target: DeployTarget.optional(),
  /**
   * Provider-specific overrides keyed by adapter name. The schema
   * accepts any shape; each adapter validates its own slice. Use
   * sparingly — prefer pushing recurring needs into the core schema.
   *
   * @example { vercel: { memory: 1024 }, fly: { vm: "shared-cpu-2x" } }
   */
  overrides: z.record(z.string(), z.unknown()).optional(),
});
export type DeployIntent = z.infer<typeof DeployIntent>;

/**
 * Partial-input variant for `.deploy()` builder calls — every field
 * stays optional at the call site so users can declare just `runtime`
 * or just `cache`. The full `DeployIntent.parse()` step happens at the
 * cache-write boundary, where defaults fill in.
 */
export const DeployIntentInput = DeployIntent.partial();
export type DeployIntentInput = z.input<typeof DeployIntentInput>;

// ─── Validation helpers ──────────────────────────────────────────────

/**
 * `runtime: "static"` requires the route to be prerenderable. A
 * dynamic-segment page with no `generateStaticParams` cannot satisfy
 * that — adapters should refuse to compile such intents and surface
 * the route id in the error.
 */
export function isStaticIntentValidFor(
  intent: DeployIntent,
  route: { isDynamic: boolean; hasGenerateStaticParams: boolean; kind: string },
): { ok: true } | { ok: false; reason: string } {
  if (intent.runtime !== "static") return { ok: true };

  if (route.kind === "api") {
    return {
      ok: false,
      reason:
        "runtime: \"static\" is not valid for an API route — APIs execute at request time. Use \"edge\", \"node\", or \"bun\".",
    };
  }
  if (route.isDynamic && !route.hasGenerateStaticParams) {
    return {
      ok: false,
      reason:
        "runtime: \"static\" requires the dynamic route to export `generateStaticParams` so all parameter combinations are known at build time.",
    };
  }
  return { ok: true };
}
