/**
 * Vercel compiler — manifest + DeployIntent cache → `vercel.json`.
 *
 * Issue #250 — Phase 1 M3.
 *
 * The compiler is the new identity of the Vercel adapter. The old
 * adapter was a config scaffolder that emitted the same hand-writable
 * `vercel.json` regardless of project shape (Issue #250). With the
 * intent cache in place, `compileVercelJson()` reads:
 *
 *   - the routes manifest (what routes exist and their kind)
 *   - `.mandu/deploy.intent.json` (typed DeployIntent per route)
 *
 * and emits a `vercel.json` whose functions block, regions, headers,
 * and rewrites are derived from the intents — no template variables,
 * no copy-paste-and-edit. Adapters never invent defaults; missing
 * intent for any route is a hard error so deploys can't drift
 * silently into the wrong shape.
 *
 * # Runtime mapping
 *
 *   - `static` → no function entry. The route prerenders at build
 *     time and ships from the CDN.
 *   - `edge`   → `runtime: "edge"` on the function entry.
 *   - `node`   → omit `runtime` so Vercel uses its built-in Node
 *     runtime. (Note: current Mandu `startServer` is Bun-only, so
 *     a `node` intent on Vercel is flagged as not-yet-supported in
 *     `compileWarnings`. The compile still succeeds — the user can
 *     opt out by changing the intent.)
 *   - `bun`    → `runtime: "@vercel/bun@1.0.0"`. Issue #248 noted
 *     that the package is unpublished today; the compiler emits
 *     the field anyway and surfaces a warning. Once the runtime
 *     ships, no compiler change is required.
 *
 * # Cache mapping
 *
 *   - `"no-store"` → `Cache-Control: no-store`
 *   - `"public"`   → `Cache-Control: public`
 *   - `{ maxAge, sMaxAge, swr }` → `public, max-age=...,
 *     s-maxage=..., stale-while-revalidate=...` (only the keys
 *     present are written).
 *
 * Per-route headers go in `vercel.json#headers` keyed off the route
 * pattern (with `:param` segments mapped to `:param`).
 *
 * # Provider-specific overrides
 *
 * `intent.overrides.vercel` is shallow-merged onto the function entry,
 * so things like `memory` / `maxDuration` / regions overrides work
 * without growing the core schema.
 *
 * # Schema portability gates
 *
 * `runtime: "static"` on a dynamic page without `generateStaticParams`
 * is rejected via `isStaticIntentValidFor`. Issue #250 RFC marks this
 * as the canonical "schema portability" failure mode adapters must
 * surface clearly — we list the offending routes in the error.
 */

import type { RouteSpec, RoutesManifest } from "../../spec/schema";
import {
  isStaticIntentValidFor,
  type DeployIntent,
  type DeployRuntime,
} from "../intent";
import type { DeployIntentCache } from "../cache";

// ─── Vercel config shape ──────────────────────────────────────────────

export interface VercelHeader {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

export interface VercelFunctionConfig {
  /** Vercel runtime spec; omit for built-in Node. */
  runtime?: string;
  /** Per-function regions (provider-specific identifiers). */
  regions?: string[];
  /** Function timeout in seconds (Vercel field name). */
  maxDuration?: number;
  /** Memory in MB. */
  memory?: number;
  /** Anything else from `intent.overrides.vercel`. */
  [key: string]: unknown;
}

export interface VercelConfig {
  $schema: string;
  version: 2;
  framework: null;
  buildCommand: string;
  installCommand: string;
  outputDirectory: string;
  functions?: Record<string, VercelFunctionConfig>;
  headers?: VercelHeader[];
  rewrites?: Array<{ source: string; destination: string }>;
}

// ─── Public surface ───────────────────────────────────────────────────

export interface CompileVercelOptions {
  /** Project name (Mandu-side bookkeeping; not emitted into vercel.json). */
  projectName: string;
  /** Build command. Defaults to `bun run mandu build --static` (static-only). */
  buildCommand?: string;
  /** Install command. */
  installCommand?: string;
  /** Output directory. Defaults to `dist`. */
  outputDirectory?: string;
}

export interface VercelCompileResult {
  config: VercelConfig;
  /**
   * Non-fatal warnings the CLI surfaces to the user. Examples: the
   * `node` / `bun` intent was emitted but the corresponding Vercel
   * runtime is not yet usable for Mandu (see #248).
   */
  warnings: string[];
  /**
   * Per-route summary the CLI prints in `mandu deploy --target=vercel`
   * dry-run, so the operator can confirm the intent → vercel.json
   * mapping at a glance before pushing.
   */
  perRoute: Array<{
    routeId: string;
    pattern: string;
    runtime: DeployRuntime;
    functionEntry: string | null;
    cacheHeader: string | null;
  }>;
}

export class VercelCompileError extends Error {
  readonly code = "DEPLOY_VERCEL_COMPILE_FAILED";
  readonly routes: ReadonlyArray<{ routeId: string; reason: string }>;

  constructor(
    routes: ReadonlyArray<{ routeId: string; reason: string }>,
  ) {
    super(
      `Vercel compile failed:\n${routes.map((r) => `  - ${r.routeId}: ${r.reason}`).join("\n")}`,
    );
    this.routes = routes;
    this.name = "VercelCompileError";
  }
}

/**
 * Compile a manifest + intent cache into a `vercel.json`.
 *
 * Throws `VercelCompileError` when one or more routes have intents
 * the adapter cannot represent (missing entry, invalid `static`
 * declaration, etc). Non-fatal issues are returned in `warnings`.
 */
export function compileVercelJson(
  manifest: RoutesManifest,
  cache: DeployIntentCache,
  options: CompileVercelOptions,
): VercelCompileResult {
  validateProjectName(options.projectName);

  const warnings: string[] = [];
  const errors: Array<{ routeId: string; reason: string }> = [];
  const functions: Record<string, VercelFunctionConfig> = {};
  const headers: VercelHeader[] = [];
  const perRoute: VercelCompileResult["perRoute"] = [];

  // Long-cache directive for hashed bundles is the same in every
  // Mandu deploy — ship it unconditionally.
  headers.push({
    source: "/.mandu/client/(.*)",
    headers: [
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ],
  });

  for (const route of manifest.routes) {
    const entry = cache.intents[route.id];
    if (!entry) {
      errors.push({
        routeId: route.id,
        reason: "no DeployIntent in .mandu/deploy.intent.json — run `mandu deploy:plan` first",
      });
      continue;
    }
    const { intent } = entry;

    // Schema portability gate: `runtime: "static"` on a route that
    // can't actually be prerendered.
    const isDynamic = isPatternDynamic(route.pattern);
    const hasGenerateStaticParams =
      route.kind === "page" &&
      Array.isArray((route as { staticParams?: unknown[] }).staticParams) &&
      ((route as { staticParams?: unknown[] }).staticParams?.length ?? 0) > 0;
    const validation = isStaticIntentValidFor(intent, {
      isDynamic,
      hasGenerateStaticParams,
      kind: route.kind,
    });
    if (!validation.ok) {
      errors.push({ routeId: route.id, reason: validation.reason });
      continue;
    }

    // Per-route header (built from the intent cache directive).
    const cacheHeader = formatCacheControl(intent.cache);
    if (cacheHeader && intent.runtime === "static") {
      headers.push({
        source: route.pattern,
        headers: [{ key: "Cache-Control", value: cacheHeader }],
      });
    }

    // Function entry (skipped for static).
    let functionEntry: string | null = null;
    if (intent.runtime !== "static") {
      functionEntry = mapRouteToFunctionEntry(route);
      const fn: VercelFunctionConfig = {};

      if (intent.runtime === "edge") {
        fn.runtime = "edge";
      } else if (intent.runtime === "bun") {
        fn.runtime = "@vercel/bun@1.0.0";
        warnings.push(
          `${route.id}: runtime: "bun" emits @vercel/bun@1.0.0 in vercel.json, but the package is not published yet (Issue #248). Deploy will fail until @vercel/bun ships or the intent changes.`,
        );
      } else {
        // node — leave runtime unset so Vercel picks its built-in
        // Node runtime, but warn that Mandu's startServer is Bun-only.
        warnings.push(
          `${route.id}: runtime: "node" — Vercel will run this on its built-in Node runtime, but Mandu's startServer uses Bun-only globals. Switch to runtime: "edge" / "bun", or self-host this route.`,
        );
      }

      if (intent.regions && intent.regions.length > 0) fn.regions = intent.regions;
      if (intent.timeout !== undefined) {
        // Vercel `maxDuration` is in seconds; intent.timeout is in ms.
        fn.maxDuration = Math.max(1, Math.ceil(intent.timeout / 1000));
      }

      // Provider-specific overrides — last write wins.
      const overrides = (intent.overrides?.vercel ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(overrides)) {
        fn[k] = v;
      }

      // `node` intent leaves `runtime` undefined intentionally — only
      // strip the key when it never got set.
      if (fn.runtime === undefined) delete fn.runtime;

      functions[functionEntry] = fn;

      if (cacheHeader) {
        headers.push({
          source: route.pattern,
          headers: [{ key: "Cache-Control", value: cacheHeader }],
        });
      }
    }

    // Visibility on Vercel is owned by Project Settings (preview
    // protection / IP allowlist). Surface a hint when the user
    // declared `private` so they know to wire it up out of band.
    if (intent.visibility === "private") {
      warnings.push(
        `${route.id}: visibility: "private" — Vercel routes default to public. Configure preview protection / IP allowlist in Project Settings.`,
      );
    }

    perRoute.push({
      routeId: route.id,
      pattern: route.pattern,
      runtime: intent.runtime,
      functionEntry,
      cacheHeader,
    });
  }

  if (errors.length > 0) {
    throw new VercelCompileError(errors);
  }

  const config: VercelConfig = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    version: 2,
    framework: null,
    buildCommand: options.buildCommand ?? "bun run mandu build --static",
    installCommand: options.installCommand ?? "bun install --frozen-lockfile",
    outputDirectory: options.outputDirectory ?? "dist",
    headers,
  };
  if (Object.keys(functions).length > 0) {
    config.functions = functions;
  }

  return { config, warnings, perRoute };
}

/** Stable JSON output — trailing newline so editors don't fight us. */
export function renderVercelJsonFromCompile(result: VercelCompileResult): string {
  return `${JSON.stringify(result.config, null, 2)}\n`;
}

// ─── Internals ────────────────────────────────────────────────────────

function validateProjectName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-_]{0,99}$/i.test(name)) {
    throw new Error(`compileVercelJson: projectName "${name}" is invalid`);
  }
}

/**
 * Map a route's manifest entry to the vercel.json `functions[*]` key.
 *
 * Vercel keys functions by their on-disk path relative to the project
 * root (e.g., `api/embed.ts`). Mandu's manifest stores `module` in the
 * same shape, so we use that directly. For page routes the
 * `componentModule` is the canonical SSR entry.
 */
function mapRouteToFunctionEntry(route: RouteSpec): string {
  const entry =
    (route as { componentModule?: string }).componentModule ?? route.module;
  return entry.replace(/^\.?\//, "");
}

function formatCacheControl(cache: DeployIntent["cache"]): string | null {
  if (cache === "no-store") return "no-store";
  if (cache === "public") return "public";
  const bits: string[] = ["public"];
  if (cache.maxAge !== undefined) bits.push(`max-age=${cache.maxAge}`);
  if (cache.sMaxAge !== undefined) bits.push(`s-maxage=${cache.sMaxAge}`);
  if (cache.swr !== undefined) bits.push(`stale-while-revalidate=${cache.swr}`);
  return bits.length > 1 ? bits.join(", ") : null;
}

function isPatternDynamic(pattern: string): boolean {
  return (
    /\[(\.\.\.)?[^\]]+\]/.test(pattern) ||
    /\/:[^/]+/.test(pattern) ||
    /\*/.test(pattern)
  );
}
