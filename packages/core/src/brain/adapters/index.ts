/**
 * Brain — LLM Adapters (resolver + factory).
 *
 * `createBrainAdapter(config)` picks the right adapter based on
 * declarative config + runtime signals. Resolution order when
 * `adapter: "auto"` (or `brain` config omitted entirely):
 *
 *   1. openai-oauth   — token (or ChatGPT session) present
 *   2. anthropic-oauth — token present in the keychain
 *   3. template        — final fallback (returns NoopAdapter; Brain
 *                        gracefully falls back to template analysis)
 *
 * The local-LLM (Ollama) tier was removed: Mandu standardised on
 * cloud OAuth providers so every dev has the same baseline quality
 * without managing a local daemon. CLI surfaces that *want* a brain
 * (`mandu brain doctor`, `mandu deploy:plan --use-brain`) detect the
 * `template` fallback and prompt the user to run
 * `mandu brain login --provider=openai` instead of degrading silently.
 *
 * `telemetryOptOut: true` disables every cloud tier — the resolver
 * skips straight to template regardless of stored tokens.
 *
 * Explicit `adapter: "openai"` / `"anthropic"` / `"template"` pins
 * the choice; the resolver still degrades to the NoopAdapter when
 * the chosen provider is unreachable, so the caller never explodes
 * on a missing dependency.
 */

export * from "./base";
export * from "./openai-oauth";
export * from "./anthropic-oauth";
export * from "./oauth-flow";
export * from "./chatgpt-auth";

import { type LLMAdapter, NoopAdapter } from "./base";
import {
  OpenAIOAuthAdapter,
  createOpenAIOAuthAdapter,
  type OpenAIOAuthAdapterOptions,
} from "./openai-oauth";
import { ChatGPTAuth } from "./chatgpt-auth";
import {
  AnthropicOAuthAdapter,
  createAnthropicOAuthAdapter,
  type AnthropicOAuthAdapterOptions,
} from "./anthropic-oauth";
import {
  getCredentialStore,
  type CredentialStore,
  type StoredToken,
} from "../credentials";

/**
 * Normalised Brain config shape consumed by the resolver. Mirrors
 * `ManduConfig.brain` but with every field required-or-explicitly
 * defaulted so downstream code does not repeat the same null checks.
 */
export interface BrainAdapterConfig {
  adapter: "auto" | "openai" | "anthropic" | "template";
  openai?: { model?: string };
  anthropic?: { model?: string };
  /**
   * When true, cloud adapters are disabled entirely. The resolver
   * falls to template regardless of stored tokens.
   */
  telemetryOptOut?: boolean;
  /**
   * Project root — required for consent scoping + redaction audit log.
   * Defaults to `process.cwd()` when omitted.
   */
  projectRoot?: string;
  /** Credential store override — tests inject an in-memory one. */
  credentialStore?: CredentialStore;
  /** Override OpenAI-specific adapter options (tests only). */
  openaiOptions?: OpenAIOAuthAdapterOptions;
  /** Override Anthropic-specific adapter options (tests only). */
  anthropicOptions?: AnthropicOAuthAdapterOptions;
  /**
   * Override the keychain probe used by the auto-resolver. Returns
   * the stored token or null. Tests inject a deterministic stub; the
   * default consults `credentialStore.load(provider)`.
   */
  probeToken?: (provider: "openai" | "anthropic") => Promise<StoredToken | null>;
  /**
   * Override the ChatGPT session-token probe. Default: instantiate
   * `new ChatGPTAuth()` and check its on-disk auth.json. Tests inject
   * a stub returning `false` so the developer's real `~/.codex/auth.json`
   * doesn't leak into unit-test expectations.
   */
  probeChatGPTAuth?: () => { authenticated: boolean; path: string | null };
}

/**
 * Result of the resolver — returned so callers can log which tier
 * won (surfaced in `mandu brain status`) and detect the
 * "needs-login" state.
 */
export interface BrainAdapterResolution {
  adapter: LLMAdapter;
  /** Which tier the resolver picked. */
  resolved: "openai" | "anthropic" | "template";
  /** Which tier the caller asked for (config value). */
  requested: BrainAdapterConfig["adapter"];
  /** Human-readable reason — useful for `mandu brain status`. */
  reason: string;
  /**
   * True when the resolver fell back to template ONLY because the
   * user has no cloud token. Interactive CLIs should prompt
   * `mandu brain login --provider=openai` instead of using the noop
   * adapter. False when the user explicitly opted out (`telemetryOptOut`)
   * or asked for `template` directly.
   */
  needsLogin: boolean;
}

/**
 * Resolve + construct a Brain adapter.
 *
 * Callers typically use the convenience re-export
 * `createBrainAdapter(config)`. The full `resolveBrainAdapter()`
 * surface returns the metadata record so CLI status commands can
 * explain which tier won.
 */
export async function resolveBrainAdapter(
  config: Partial<BrainAdapterConfig> = {},
): Promise<BrainAdapterResolution> {
  const requested = config.adapter ?? "auto";
  const telemetryOptOut = config.telemetryOptOut ?? false;

  const store = config.credentialStore ?? getCredentialStore();
  const projectRoot = config.projectRoot ?? process.cwd();

  const probeToken =
    config.probeToken ?? ((provider) => store.load(provider));

  const probeChatGPTAuth =
    config.probeChatGPTAuth ??
    (() => {
      const c = new ChatGPTAuth();
      return { authenticated: c.isAuthenticated(), path: c.locateAuthFile() };
    });

  // Explicit template — skip every other check.
  if (requested === "template") {
    return {
      adapter: new NoopAdapter(),
      resolved: "template",
      requested,
      reason: "Explicit adapter: 'template' in config",
      needsLogin: false,
    };
  }

  // Explicit openai — only honored when telemetry is allowed AND a
  // token exists. Falls back to template otherwise so Core does not
  // explode.
  if (requested === "openai") {
    if (telemetryOptOut) {
      return {
        adapter: new NoopAdapter(),
        resolved: "template",
        requested,
        reason:
          "adapter: 'openai' requested but telemetryOptOut=true — forcing template",
        needsLogin: false,
      };
    }
    // Primary: ChatGPT session token (written by `@openai/codex login`).
    const cg = probeChatGPTAuth();
    const hasChatGPT = cg.authenticated;
    const token = hasChatGPT ? null : await probeToken("openai");
    if (!hasChatGPT && !token) {
      return {
        adapter: new NoopAdapter(),
        resolved: "template",
        requested,
        reason:
          "adapter: 'openai' requested but no token found — run `mandu brain login --provider=openai`",
        needsLogin: true,
      };
    }
    return {
      adapter: createOpenAIOAuthAdapter({
        ...(config.openaiOptions ?? {}),
        model: config.openai?.model ?? config.openaiOptions?.model,
        credentialStore: store,
        projectRoot,
      }),
      resolved: "openai",
      requested,
      reason: hasChatGPT
        ? "Explicit adapter: 'openai' + ChatGPT session token present"
        : "Explicit adapter: 'openai' + keychain token present",
      needsLogin: false,
    };
  }

  if (requested === "anthropic") {
    if (telemetryOptOut) {
      return {
        adapter: new NoopAdapter(),
        resolved: "template",
        requested,
        reason:
          "adapter: 'anthropic' requested but telemetryOptOut=true — forcing template",
        needsLogin: false,
      };
    }
    const token = await probeToken("anthropic");
    if (!token) {
      return {
        adapter: new NoopAdapter(),
        resolved: "template",
        requested,
        reason:
          "adapter: 'anthropic' requested but no token in keychain — run `mandu brain login --provider=anthropic`",
        needsLogin: true,
      };
    }
    return {
      adapter: createAnthropicOAuthAdapter({
        ...(config.anthropicOptions ?? {}),
        model: config.anthropic?.model ?? config.anthropicOptions?.model,
        credentialStore: store,
        projectRoot,
      }),
      resolved: "anthropic",
      requested,
      reason: "Explicit adapter: 'anthropic' + token present",
      needsLogin: false,
    };
  }

  // Auto — try cloud providers first (when allowed), then template.
  if (!telemetryOptOut) {
    // Primary: ChatGPT session token (managed by `@openai/codex`).
    const cg2 = probeChatGPTAuth();
    if (cg2.authenticated) {
      return {
        adapter: createOpenAIOAuthAdapter({
          ...(config.openaiOptions ?? {}),
          model: config.openai?.model ?? config.openaiOptions?.model,
          credentialStore: store,
          projectRoot,
        }),
        resolved: "openai",
        requested,
        reason: `auto: ChatGPT session token at ${cg2.path ?? "(unknown)"}`,
        needsLogin: false,
      };
    }
    const openaiToken = await probeToken("openai");
    if (openaiToken) {
      return {
        adapter: createOpenAIOAuthAdapter({
          ...(config.openaiOptions ?? {}),
          model: config.openai?.model ?? config.openaiOptions?.model,
          credentialStore: store,
          projectRoot,
        }),
        resolved: "openai",
        requested,
        reason: "auto: OpenAI token found in keychain",
        needsLogin: false,
      };
    }
    const anthropicToken = await probeToken("anthropic");
    if (anthropicToken) {
      return {
        adapter: createAnthropicOAuthAdapter({
          ...(config.anthropicOptions ?? {}),
          model: config.anthropic?.model ?? config.anthropicOptions?.model,
          credentialStore: store,
          projectRoot,
        }),
        resolved: "anthropic",
        requested,
        reason: "auto: Anthropic token found in keychain",
        needsLogin: false,
      };
    }
  }

  // Final fallback. `needsLogin` distinguishes "user opted out" from
  // "user has no token" so interactive CLIs can prompt login only in
  // the latter case.
  return {
    adapter: new NoopAdapter(),
    resolved: "template",
    requested,
    reason: telemetryOptOut
      ? "auto: telemetryOptOut=true — using template"
      : "auto: no cloud token — run `mandu brain login --provider=openai`",
    needsLogin: !telemetryOptOut,
  };
}

/**
 * Convenience factory — returns just the adapter. Use
 * `resolveBrainAdapter()` when you also need the resolution metadata
 * (e.g. for `mandu brain status`).
 */
export async function createBrainAdapter(
  config: Partial<BrainAdapterConfig> = {},
): Promise<LLMAdapter> {
  const res = await resolveBrainAdapter(config);
  return res.adapter;
}

/**
 * Runtime guard — is the adapter a cloud connector? Used by CLI
 * status to flag "may transmit data" lines.
 */
export function isCloudAdapter(adapter: LLMAdapter): boolean {
  return (
    adapter instanceof OpenAIOAuthAdapter ||
    adapter instanceof AnthropicOAuthAdapter
  );
}
