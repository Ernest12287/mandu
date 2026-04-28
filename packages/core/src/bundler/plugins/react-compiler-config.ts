/**
 * React Compiler config resolver (#240 Phase 2 — auto-detect).
 *
 * The `experimental.reactCompiler` block in `mandu.config.ts` has three
 * meaningful states for the `enabled` field:
 *
 *   - `true`  — user explicitly opts in. The transform plugin runs and
 *     warns if peer deps (`@babel/core`, `babel-plugin-react-compiler`)
 *     are missing.
 *   - `false` — user explicitly opts out. Plugin never runs.
 *   - `undefined` (the default) — Phase 2: probe whether the peer deps
 *     are installed in the project. If both resolve, treat as enabled
 *     so installing `babel-plugin-react-compiler` is the only step
 *     needed to turn auto-memoization on (zero-config goal of #240).
 *     If either is missing, stay disabled silently — no warning, no
 *     surface change for projects that haven't asked for the Compiler.
 *
 * The probe is synchronous (`Bun.resolveSync`) so it composes with the
 * non-async `manduClientPlugins()` gate. Resolutions are cached per
 * `(rootDir, enabled)` pair because the bundler asks for plugins many
 * times during a single build (one for each entry / shim / island).
 *
 * @module core/bundler/plugins/react-compiler-config
 */

export interface RawReactCompilerConfig {
  enabled?: boolean;
  compilerConfig?: Record<string, unknown>;
}

export interface ResolvedReactCompilerConfig {
  /**
   * Final on/off decision after applying auto-detect. Always a concrete
   * boolean — callers do not need to repeat the probe.
   */
  enabled: boolean;
  /** Forwarded to `babel-plugin-react-compiler`. */
  compilerConfig?: Record<string, unknown>;
  /**
   * `true` when `enabled` was implicitly resolved from peer-dep probe
   * (vs. set explicitly by the user). Surfaced so the bundler's plugin
   * can suppress the "peer dep missing" warning — the implicit path
   * already short-circuits before the plugin runs, but a future caller
   * that bypasses this resolver would otherwise spam the warning.
   */
  autoDetected: boolean;
}

const cache = new Map<string, ResolvedReactCompilerConfig>();

/**
 * Probe whether `@babel/core` and `babel-plugin-react-compiler` resolve
 * from `rootDir`. Both must be present — the transform plugin loads
 * them as a pair. Returns `false` on any resolution failure (missing
 * dep, broken symlink, weird workspace layout) so the failure mode is
 * "stay off" rather than "blow up boot".
 */
function peerDepsInstalled(rootDir: string): boolean {
  try {
    Bun.resolveSync("@babel/core", rootDir);
    Bun.resolveSync("babel-plugin-react-compiler", rootDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the user's `experimental.reactCompiler` block into a final
 * on/off decision plus carried-over compiler options.
 *
 * Cache key includes `rootDir` and the explicit-enabled value so we
 * can have, in tests, two projects in the same process with different
 * enablement states.
 */
export function resolveReactCompilerConfig(
  raw: RawReactCompilerConfig | undefined,
  rootDir: string,
): ResolvedReactCompilerConfig {
  const explicit = raw?.enabled;
  const cacheKey = `${rootDir}::${explicit ?? "auto"}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  let enabled: boolean;
  let autoDetected = false;
  if (explicit === true) {
    enabled = true;
  } else if (explicit === false) {
    enabled = false;
  } else {
    enabled = peerDepsInstalled(rootDir);
    autoDetected = enabled;
  }

  const result: ResolvedReactCompilerConfig = {
    enabled,
    compilerConfig: raw?.compilerConfig,
    autoDetected,
  };
  cache.set(cacheKey, result);
  return result;
}

/** Test-only — drop cached probes between fixture setups. */
export function _resetReactCompilerConfigCache(): void {
  cache.clear();
}
