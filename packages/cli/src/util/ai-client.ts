/**
 * Thin wrapper around ATE prompt adapters for the CLI chat/eval commands.
 *
 * Phase 14.2 — Agent F. Responsibilities:
 *
 *   1. **Secret resolution** — read `MANDU_*_API_KEY` from env, optionally
 *      fall back to `Bun.secrets` (best-effort, never fatal).
 *   2. **Provider normalization** — accept the 4 supported providers and
 *      reject anything else with a typed {@link InvalidProviderError}.
 *   3. **Timeout + abort** — merge caller-supplied `AbortSignal` with a
 *      default 60s budget. Aborting mid-stream tears down the underlying
 *      HTTP connection via the adapter's `signal` propagation.
 *   4. **Mask secrets** — wrap the adapter's `stream()` so downstream
 *      error output never carries the full API key (only `sk-***`).
 *
 * The wrapper is intentionally thin: it does NOT own conversation state,
 * UI, or history — those are in `commands/ai/chat.ts` and
 * `util/ai-history.ts` respectively.
 */

import type {
  PromptMessage,
  PromptProvider,
  PromptStreamTerminal,
} from "@mandujs/ate/prompts";
import { getAdapter } from "@mandujs/ate/prompts";

export const SUPPORTED_PROVIDERS: readonly PromptProvider[] = [
  "claude",
  "openai",
  "gemini",
  "local",
] as const;

/** Environment variable names (KEY = env var) per provider. */
export const PROVIDER_ENV_VARS: Record<Exclude<PromptProvider, "local">, string> = {
  claude: "MANDU_CLAUDE_API_KEY",
  openai: "MANDU_OPENAI_API_KEY",
  gemini: "MANDU_GEMINI_API_KEY",
};

/** Default models — advertised by `--help` and eval output. */
export const PROVIDER_DEFAULT_MODEL: Record<PromptProvider, string> = {
  claude: "claude-sonnet-4-20250514",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  local: "local-model",
};

/** Default timeout — `MANDU_AI_TIMEOUT_MS` env override. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export class InvalidProviderError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(`Unknown provider: ${provider}`);
    this.name = "InvalidProviderError";
    this.provider = provider;
  }
}

export class MissingApiKeyError extends Error {
  readonly provider: PromptProvider;
  readonly envVar: string;
  constructor(provider: PromptProvider, envVar: string) {
    super(`${envVar} is not set (provider=${provider})`);
    this.name = "MissingApiKeyError";
    this.provider = provider;
    this.envVar = envVar;
  }
}

export class StreamTimeoutError extends Error {
  readonly provider: PromptProvider;
  readonly timeoutMs: number;
  constructor(provider: PromptProvider, timeoutMs: number) {
    super(`stream from ${provider} exceeded ${timeoutMs}ms`);
    this.name = "StreamTimeoutError";
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

/** Mask an API key for logging. */
export function maskSecret(key: string | undefined): string {
  if (!key || key.length < 6) return "sk-***";
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

/**
 * Normalize a provider string from CLI flags. Returns the canonical
 * {@link PromptProvider} or throws {@link InvalidProviderError}.
 */
export function resolveProvider(raw: string | undefined): PromptProvider {
  const value = (raw ?? "local").toLowerCase();
  if (SUPPORTED_PROVIDERS.includes(value as PromptProvider)) {
    return value as PromptProvider;
  }
  throw new InvalidProviderError(value);
}

/**
 * Fetch an API key from env, with optional best-effort `Bun.secrets`
 * fallback. Returns `undefined` when nothing matches — `local` provider
 * callers can tolerate that.
 *
 * Never logs the returned key or surfaces it in error messages.
 */
export async function resolveApiKey(
  provider: PromptProvider,
  envGetter: (name: string) => string | undefined = (n) => process.env[n],
): Promise<string | undefined> {
  if (provider === "local") return undefined;
  const envVar = PROVIDER_ENV_VARS[provider];
  const envValue = envGetter(envVar);
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  // Best-effort Bun.secrets fallback. Wrapped in try/catch because the API
  // is not guaranteed across Bun versions / platforms.
  try {
    const bunGlobal = globalThis as { Bun?: { secrets?: unknown } };
    const secrets = bunGlobal.Bun?.secrets as
      | { get?: (args: { service: string; name: string }) => Promise<string | null> }
      | undefined;
    if (secrets && typeof secrets.get === "function") {
      const value = await secrets.get({ service: "mandu-cli", name: envVar });
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  } catch {
    /* non-fatal — no keychain available */
  }
  return undefined;
}

export interface AIStreamEvent {
  type: "chunk" | "done";
  /** Textual delta when type=chunk. */
  delta?: string;
  /** Aggregate response when type=done. */
  response?: string;
  /** Elapsed ms (from stream start to `done`). */
  latencyMs?: number;
  /** Token accounting (best-effort, populated on `done`). */
  tokens?: PromptStreamTerminal;
}

export interface AIStreamOptions {
  provider: PromptProvider;
  messages: PromptMessage[];
  model?: string;
  apiKey?: string;
  signal?: AbortSignal;
  /** Base URL override (primarily for tests / OpenAI-compatible local runtimes). */
  baseUrl?: string;
  /** Wall-clock budget. Defaults to `MANDU_AI_TIMEOUT_MS` or 60000ms. */
  timeoutMs?: number;
  /** Output token cap. */
  maxTokens?: number;
}

/**
 * Resolve the effective timeout budget in milliseconds.
 *
 * Precedence: explicit option > `MANDU_AI_TIMEOUT_MS` env > default 60s.
 */
export function resolveTimeoutMs(optionMs?: number): number {
  if (typeof optionMs === "number" && Number.isFinite(optionMs) && optionMs > 0) {
    return optionMs;
  }
  const raw = process.env.MANDU_AI_TIMEOUT_MS;
  if (raw && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Stream chat completions for the given provider and yield
 * {@link AIStreamEvent} objects until completion.
 *
 * Throws {@link MissingApiKeyError} if the needed env var isn't set for
 * non-local providers, {@link StreamTimeoutError} on wall-clock timeout,
 * or an `AbortError` DOMException if the caller's signal aborts.
 *
 * The returned response + tokens on the `done` event are deterministic
 * (no mutation of intermediate chunk strings).
 */
export async function* streamChat(
  options: AIStreamOptions,
): AsyncGenerator<AIStreamEvent, void, void> {
  const adapter = getAdapter(options.provider);
  if (adapter.name !== options.provider) {
    // getAdapter falls back to local on unknown — we guard separately via
    // resolveProvider, but double-check here so tests fail loud rather
    // than silently echoing local.
    throw new InvalidProviderError(options.provider);
  }

  // Resolve the key unless caller explicitly passed one (used in tests).
  const apiKey = options.apiKey ?? (await resolveApiKey(options.provider));
  if (options.provider !== "local" && !apiKey) {
    throw new MissingApiKeyError(options.provider, PROVIDER_ENV_VARS[options.provider]);
  }

  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Merge caller signal + timeout signal. Node 20+ has AbortSignal.any but
  // Bun's runtime may not — roll our own for portability.
  const mergedController = new AbortController();
  const onAbortFromCaller = () => mergedController.abort();
  const onAbortFromTimeout = () => mergedController.abort();
  if (options.signal) {
    if (options.signal.aborted) mergedController.abort();
    else options.signal.addEventListener("abort", onAbortFromCaller, { once: true });
  }
  timeoutController.signal.addEventListener("abort", onAbortFromTimeout, { once: true });

  const startedAt = Date.now();
  const parts: string[] = [];
  let terminal: PromptStreamTerminal | undefined;

  try {
    for await (const chunk of adapter.stream({
      messages: options.messages,
      model: options.model,
      apiKey,
      baseUrl: options.baseUrl,
      maxTokens: options.maxTokens,
      signal: mergedController.signal,
    })) {
      if (typeof chunk === "string") {
        parts.push(chunk);
        yield { type: "chunk", delta: chunk };
      } else {
        terminal = chunk;
      }
    }
  } catch (err) {
    if (timeoutController.signal.aborted) {
      throw new StreamTimeoutError(options.provider, timeoutMs);
    }
    // Normalize abort → DOMException AbortError
    if ((err as Error).name === "AbortError") {
      throw err;
    }
    // Strip the API key if it somehow slipped into the message.
    const safe = new Error(
      (err as Error).message.replace(apiKey ?? "\u0000", maskSecret(apiKey)),
    );
    safe.name = (err as Error).name;
    throw safe;
  } finally {
    clearTimeout(timeoutHandle);
    if (options.signal) options.signal.removeEventListener("abort", onAbortFromCaller);
    timeoutController.signal.removeEventListener("abort", onAbortFromTimeout);
  }

  const latencyMs = Date.now() - startedAt;
  yield {
    type: "done",
    response: parts.join(""),
    latencyMs,
    tokens: terminal ?? {
      tokensEstimated: Math.max(1, Math.ceil(parts.join("").length / 4)),
    },
  };
}

/**
 * Collect the full response (non-streaming caller convenience). Aborts
 * still propagate; the returned promise rejects instead of resolving
 * with a partial response.
 */
export async function collectChat(
  options: AIStreamOptions,
): Promise<{ response: string; latencyMs: number; tokens: PromptStreamTerminal }> {
  let response = "";
  let latencyMs = 0;
  let tokens: PromptStreamTerminal = { tokensEstimated: 0 };
  for await (const event of streamChat(options)) {
    if (event.type === "chunk" && event.delta) response += event.delta;
    else if (event.type === "done") {
      latencyMs = event.latencyMs ?? 0;
      if (event.tokens) tokens = event.tokens;
      response = event.response ?? response;
    }
  }
  return { response, latencyMs, tokens };
}

/**
 * Validate that a string is clean printable UTF-8. Rejects strings
 * containing NUL bytes or other C0 control characters (except \t \n \r).
 *
 * Used by the chat loop to keep rogue paste / non-UTF8 input from
 * crashing downstream JSON serialization or adapter HTTP payloads.
 */
export function sanitizeUtf8Input(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("input must be a string");
  }
  let cleaned = raw;
  // Strip BOM.
  if (cleaned.charCodeAt(0) === 0xfeff) cleaned = cleaned.slice(1);
  // Reject embedded NULs — they break JSON + SSE framing.
  if (cleaned.indexOf("\u0000") >= 0) {
    throw new Error("contains NUL byte (non-UTF8 binary input)");
  }
  // Strip other C0 control chars except tab/newline/CR.
  cleaned = cleaned.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  // Strip U+FFFD REPLACEMENT CHARACTER (signals decode failure upstream).
  if (cleaned.indexOf("\ufffd") >= 0) {
    throw new Error("contains invalid UTF-8 byte sequences");
  }
  return cleaned;
}
