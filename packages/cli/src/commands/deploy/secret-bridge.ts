/**
 * Secret bridge — OS-keychain wrapper with a plaintext-file fallback.
 *
 * Primary path: {@link https://bun.com/docs/runtime/secrets | Bun.secrets}
 * ({ get, set, delete }) — stored in the platform keychain (Keychain on
 * macOS, Credential Manager on Windows, libsecret on Linux).
 *
 * Fallback: `.mandu/secrets.json` written with `chmod 0600`. Used only
 * when `Bun.secrets` is unavailable (older Bun). The fallback prints a
 * prominent warning exactly once per process — secrets stored this way
 * are NOT encrypted at rest.
 *
 * ## Invariants
 *
 * - Secret **values** never cross the log or artifact boundary.
 *   {@link maskSecret} returns the only permitted stringification.
 * - A `KEY=VALUE` input with whitespace trimmed is strictly validated by
 *   {@link parseSecretPair} before being handed to any backend.
 * - The service name is always `mandu/<adapter>` so cross-adapter leaks
 *   are impossible.
 *
 * @module cli/commands/deploy/secret-bridge
 */
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/** Service prefix — prevents accidental collisions with other Mandu keychain uses. */
const SERVICE_PREFIX = "mandu-deploy";

/** File-based fallback location, relative to rootDir. */
const FALLBACK_FILE = path.join(".mandu", "secrets.json");

// =====================================================================
// Errors
// =====================================================================

export class SecretStoreUnavailableError extends Error {
  readonly code = "DEPLOY_SECRET_STORE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}

export class SecretFormatError extends Error {
  readonly code = "DEPLOY_SECRET_FORMAT_INVALID";
  readonly pair: string;
  constructor(pair: string, detail: string) {
    super(`Invalid secret pair "${pair}": ${detail}`);
    this.name = "SecretFormatError";
    this.pair = pair;
  }
}

// =====================================================================
// Bun.secrets capability detection
// =====================================================================

interface BunSecretsShape {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(
    options: { service: string; name: string },
    value: string
  ): Promise<void>;
  delete(options: { service: string; name: string }): Promise<void>;
}

function getBunSecrets(): BunSecretsShape | null {
  const g = globalThis as unknown as { Bun?: { secrets?: unknown } };
  const bun = g.Bun;
  if (!bun || typeof bun !== "object") return null;
  const secrets = (bun as { secrets?: unknown }).secrets;
  if (!secrets || typeof secrets !== "object") return null;
  const s = secrets as Record<string, unknown>;
  if (
    typeof s.get !== "function" ||
    typeof s.set !== "function" ||
    typeof s.delete !== "function"
  ) {
    return null;
  }
  return s as unknown as BunSecretsShape;
}

// =====================================================================
// Public API
// =====================================================================

/**
 * Configuration for a bridge instance. We keep the target adapter
 * embedded in the service name so a leaky adapter implementation cannot
 * read another adapter's secrets.
 */
export interface SecretBridgeOptions {
  /** Adapter target (e.g. `"vercel"`, `"fly"`). */
  readonly target: string;
  /** Project root directory — used for the fallback file path. */
  readonly rootDir: string;
  /**
   * Force the plaintext-file fallback regardless of `Bun.secrets`
   * availability. Intended for tests only.
   */
  readonly forceFallback?: boolean;
  /**
   * Optional sink for the one-shot fallback warning. Defaults to
   * `console.warn`. Tests override this to avoid noise.
   */
  readonly onWarning?: (message: string) => void;
}

export interface SecretBridge {
  readonly backend: "bun.secrets" | "fallback-file";
  /** Persist a single secret. */
  set(name: string, value: string): Promise<void>;
  /** Read a single secret. Returns `null` when absent. */
  get(name: string): Promise<string | null>;
  /** Remove a secret. No-op if absent. */
  delete(name: string): Promise<void>;
  /**
   * Return only the names (not values) currently stored. Cheap enough
   * to call from `--dry-run` so we can render "missing" vs "present".
   */
  listStoredNames(): Promise<string[]>;
}

export function createSecretBridge(
  options: SecretBridgeOptions
): SecretBridge {
  const bunSecrets = options.forceFallback ? null : getBunSecrets();
  if (bunSecrets) {
    return new BunKeychainBridge(options.target, bunSecrets);
  }
  return new FallbackFileBridge(options.target, options.rootDir, options.onWarning);
}

/**
 * Safe stringification for logging secret values. Returns a constant so
 * the value itself is never observable via console/file output.
 */
export function maskSecret(_value: string | null | undefined): string {
  return "****";
}

/**
 * Strict `KEY=VALUE` parser.
 *
 * - Keys must match `/^[A-Z][A-Z0-9_]*$/` (POSIX env-var conventions).
 * - Values may contain any character except a newline.
 * - Wrapping single or double quotes are stripped once.
 */
export function parseSecretPair(raw: string): { name: string; value: string } {
  if (typeof raw !== "string") {
    throw new SecretFormatError(String(raw), "expected a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SecretFormatError(raw, "empty input");
  }
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx < 1) {
    throw new SecretFormatError(raw, "missing '=' separator");
  }
  const name = trimmed.slice(0, eqIdx).trim();
  let value = trimmed.slice(eqIdx + 1);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new SecretFormatError(
      raw,
      `invalid key "${name}" — must match /^[A-Z][A-Z0-9_]*$/`
    );
  }
  if (/\r|\n/.test(value)) {
    throw new SecretFormatError(raw, "value may not contain line terminators");
  }
  // Strip a single layer of matching quotes if present: `KEY="v a l u e"`.
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    value = value.slice(1, -1);
  }
  return { name, value };
}

// =====================================================================
// Bun keychain backend
// =====================================================================

class BunKeychainBridge implements SecretBridge {
  readonly backend = "bun.secrets" as const;

  private readonly service: string;
  // NOTE: prefix name is captured on each call via serviceName(); stored
  // names are maintained in an auxiliary "index" secret so we can list.
  private readonly indexKey = "__mandu_deploy_index__";

  constructor(
    _target: string,
    private readonly api: BunSecretsShape
  ) {
    this.service = `${SERVICE_PREFIX}/${_target}`;
  }

  async set(name: string, value: string): Promise<void> {
    await this.api.set({ service: this.service, name }, value);
    await this.updateIndex((names) => names.add(name));
  }

  async get(name: string): Promise<string | null> {
    return this.api.get({ service: this.service, name });
  }

  async delete(name: string): Promise<void> {
    try {
      await this.api.delete({ service: this.service, name });
    } catch {
      // Absent keys are non-fatal.
    }
    await this.updateIndex((names) => {
      names.delete(name);
      return names;
    });
  }

  async listStoredNames(): Promise<string[]> {
    const raw = await this.api.get({ service: this.service, name: this.indexKey });
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === "string")) {
        return [...new Set<string>(parsed)].sort();
      }
    } catch {
      // corrupt index — drop it.
    }
    return [];
  }

  private async updateIndex(mutator: (names: Set<string>) => Set<string> | void): Promise<void> {
    const current = await this.listStoredNames();
    const next = new Set<string>(current);
    const mutated = mutator(next);
    const final = mutated instanceof Set ? mutated : next;
    await this.api.set(
      { service: this.service, name: this.indexKey },
      JSON.stringify([...final].sort())
    );
  }
}

// =====================================================================
// Fallback file backend
// =====================================================================

interface FallbackFileShape {
  version: 1;
  secrets: Record<string, Record<string, string>>;
}

let fallbackWarned = false;

class FallbackFileBridge implements SecretBridge {
  readonly backend = "fallback-file" as const;

  constructor(
    private readonly target: string,
    private readonly rootDir: string,
    private readonly onWarning?: (message: string) => void
  ) {
    if (!fallbackWarned) {
      fallbackWarned = true;
      const warn =
        this.onWarning ?? ((m: string) => console.warn(m));
      warn(
        "⚠️  Bun.secrets unavailable — falling back to .mandu/secrets.json " +
          "(PLAINTEXT, NOT ENCRYPTED). Upgrade to Bun >= 1.3.12 for OS keychain support."
      );
    }
  }

  private get file(): string {
    return path.join(this.rootDir, FALLBACK_FILE);
  }

  private async load(): Promise<FallbackFileShape> {
    if (!existsSync(this.file)) {
      return { version: 1, secrets: {} };
    }
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === 1 &&
        typeof parsed.secrets === "object" &&
        parsed.secrets !== null
      ) {
        return parsed as FallbackFileShape;
      }
    } catch {
      // Corrupt file — treat as empty to avoid blocking deploys.
    }
    return { version: 1, secrets: {} };
  }

  private async save(state: FallbackFileShape): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(state, null, 2), { encoding: "utf8" });
    // Best-effort: tighten perms to 0600 on Unix. Windows ignores chmod
    // but we keep the call — it's cheap and the fallback has a warning.
    try {
      await fs.chmod(this.file, 0o600);
    } catch {
      // ignore
    }
  }

  async set(name: string, value: string): Promise<void> {
    const state = await this.load();
    const bucket = state.secrets[this.target] ?? {};
    bucket[name] = value;
    state.secrets[this.target] = bucket;
    await this.save(state);
  }

  async get(name: string): Promise<string | null> {
    const state = await this.load();
    return state.secrets[this.target]?.[name] ?? null;
  }

  async delete(name: string): Promise<void> {
    const state = await this.load();
    if (state.secrets[this.target]) {
      delete state.secrets[this.target][name];
      await this.save(state);
    }
  }

  async listStoredNames(): Promise<string[]> {
    const state = await this.load();
    return Object.keys(state.secrets[this.target] ?? {}).sort();
  }
}

// =====================================================================
// Test hooks
// =====================================================================

/**
 * Reset the one-shot fallback warning flag. Tests call this when they
 * instantiate multiple fallback bridges and want each one to fire the
 * warning independently.
 */
export function __resetFallbackWarningForTests(): void {
  fallbackWarned = false;
}
