/**
 * Provider-CLI helper — version check + spawn wrapper.
 *
 * Used by deploy adapters that delegate execution to an external binary
 * (flyctl, vercel, wrangler, railway, netlify). The helper:
 *
 *   - probes the binary's version with a short `--version` spawn
 *   - compares it against a required minimum (semver-ish)
 *   - normalizes the "binary not found" error across platforms
 *
 * We deliberately avoid depending on a full semver library — deploy
 * adapters pin minimum versions at the major+minor level. The comparison
 * logic handles the subset of semver we encounter (`1.2.3`, `v1.2.3`,
 * and vendor-prefixed strings like `wrangler 3.78.0`).
 *
 * @module cli/commands/deploy/provider-cli
 */

// =====================================================================
// Version parsing + comparison
// =====================================================================

/**
 * Extract the first `major.minor[.patch]` triple from arbitrary CLI
 * `--version` output. Returns `null` when no version-like token is
 * present — callers should treat that as "CLI present but unreadable".
 */
export function extractVersion(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${patch ?? "0"}`;
}

/**
 * Compare two dotted-numeric versions. Returns `-1` if `a < b`, `0` if
 * equal, `1` if `a > b`. Extra components are treated as zeros.
 *
 * @example compareVersions("1.2.0", "1.2")   // 0
 * @example compareVersions("3.5.1", "3.6.0") // -1
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): number[] =>
    s
      .replace(/^v/, "")
      .split(".")
      .map((n) => {
        const v = Number.parseInt(n, 10);
        return Number.isFinite(v) ? v : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Convenience: `a >= b`.
 */
export function satisfiesMinimum(actual: string, minimum: string): boolean {
  return compareVersions(actual, minimum) >= 0;
}

// =====================================================================
// CLI detection
// =====================================================================

export interface ProviderCliStatus {
  /** Whether the binary is installed (anywhere on PATH). */
  installed: boolean;
  /** Parsed version (null if installed but unreadable). */
  version: string | null;
  /** Whether {@link version} meets `minimumVersion`. */
  meetsMinimum: boolean;
  /** Raw `--version` output (trimmed, first line). */
  raw: string;
}

/**
 * `Bun.spawn`-powered wrapper. Short-lived: returns after the binary
 * prints its version or after a 5-second timeout.
 *
 * Injected as a parameter so tests can stub the underlying subprocess
 * behaviour deterministically.
 */
export interface SpawnVersion {
  (binary: string, args?: readonly string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    /** `true` when the binary could not be found on PATH. */
    notFound: boolean;
  }>;
}

/**
 * Default spawn implementation using Bun.spawn. Tests can swap this via
 * {@link getProviderCliStatus}'s `spawnImpl` option.
 */
export const defaultSpawnVersion: SpawnVersion = async (binary, args = ["--version"]) => {
  try {
    const proc = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeoutMs = 5_000;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, timeoutMs)
    );
    await Promise.race([proc.exited, timeout]);
    if (typeof proc.kill === "function") {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { exitCode: proc.exitCode ?? 0, stdout, stderr, notFound: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Bun surfaces "executable not found" / "ENOENT" when the binary is
    // missing. Normalize to a friendly flag.
    const notFound =
      /ENOENT|not\s+found|No such file|command not found|cannot find/i.test(
        message
      );
    return { exitCode: 127, stdout: "", stderr: message, notFound };
  }
};

export interface GetProviderCliStatusOptions {
  /** Override the spawn implementation (tests). */
  spawnImpl?: SpawnVersion;
  /** Custom args to pass instead of `["--version"]`. */
  args?: readonly string[];
}

export async function getProviderCliStatus(
  binary: string,
  minimumVersion: string,
  options: GetProviderCliStatusOptions = {}
): Promise<ProviderCliStatus> {
  const spawn = options.spawnImpl ?? defaultSpawnVersion;
  const { exitCode, stdout, stderr, notFound } = await spawn(
    binary,
    options.args ?? ["--version"]
  );
  if (notFound) {
    return { installed: false, version: null, meetsMinimum: false, raw: "" };
  }
  const rawOutput = (stdout.trim() || stderr.trim()).split(/\r?\n/)[0] ?? "";
  if (exitCode !== 0 && rawOutput.length === 0) {
    return { installed: false, version: null, meetsMinimum: false, raw: "" };
  }
  const version = extractVersion(rawOutput);
  const meetsMinimum = version ? satisfiesMinimum(version, minimumVersion) : false;
  return { installed: true, version, meetsMinimum, raw: rawOutput };
}
