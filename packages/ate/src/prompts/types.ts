/**
 * ATE Prompt Library — Types
 *
 * Standard prompt interface shared across Claude / OpenAI / Gemini / local
 * providers. All prompts are XML-tagged for structural clarity (Anthropic
 * best practice) and versioned for upgrade safety.
 */

/** LLM provider identifier. */
export type PromptProvider = "claude" | "openai" | "gemini" | "local";

/** Category of prompt. */
export type PromptKind =
  | "unit-test"
  | "integration-test"
  | "e2e-test"
  | "heal"
  | "impact";

/** A single message in the LLM conversation. */
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Token / context budget for smart truncation. */
export interface PromptBudget {
  /** Max total prompt tokens (rough char → token heuristic: 4 chars / token). */
  maxTokens?: number;
  /** Max characters for the user portion of the prompt. */
  maxUserChars?: number;
}

/** Structured context payload. */
export interface PromptContext {
  /** Path to the repository root. */
  repoRoot?: string;
  /** Optional project manifest (routes / spec). */
  manifest?: {
    version?: number;
    routes?: Array<{
      id: string;
      pattern?: string;
      kind?: string;
      methods?: string[];
      file?: string;
    }>;
  };
  /** Optional parsed resources. */
  resources?: Array<{
    name: string;
    fields?: Array<{ name: string; type: string; required?: boolean }>;
  }>;
  /** Optional guard preset name. */
  guardPreset?: string;
  /** Optional guard violations (for heal / review context). */
  guardViolations?: Array<{
    ruleId: string;
    file: string;
    message: string;
    severity?: "error" | "warning";
  }>;
  /** Optional system-level documents injected into the system prompt. */
  systemDocs?: Array<{ name: string; content: string }>;
  /** Arbitrary string-valued metadata to surface to the model. */
  meta?: Record<string, string | number | boolean>;
}

/** Input to `promptFor`. */
export interface PromptSpecInput {
  /** Category of generation to perform. */
  kind: PromptKind;
  /** Target LLM provider. */
  provider: PromptProvider;
  /** Structured context merged into the prompt. */
  context?: PromptContext;
  /** Specific target (a route, file, failure ID, etc.). */
  target?: {
    id?: string;
    file?: string;
    path?: string;
    methods?: string[];
    snippet?: string;
  };
  /** Optional per-prompt overrides. */
  overrides?: {
    system?: string;
    user?: string;
  };
  /** Token / char budget for truncation. */
  budget?: PromptBudget;
}

/** Output of `promptFor` — messages + metadata. */
export interface PromptSpec {
  /** Semantic version of the underlying template. */
  version: string;
  /** The prompt kind echoed back. */
  kind: PromptKind;
  /** Target provider. */
  provider: PromptProvider;
  /** Final messages, in provider-native order. */
  messages: PromptMessage[];
  /** System prompt convenience field. */
  system: string;
  /** Total approx char count (for budgeting / logs). */
  charCount: number;
  /** Template identifier (e.g. "unit-test@1.0.0"). */
  templateId: string;
}

/** Raw template emitted by a kind module — provider-agnostic. */
export interface PromptTemplate {
  /** Prompt kind. */
  kind: PromptKind;
  /** Template version. Breaking changes must bump MAJOR. */
  version: string;
  /** System prompt — goals, constraints, XML structure rules. */
  buildSystem(ctx: PromptContext): string;
  /** User prompt — concrete request with target + context slices. */
  buildUser(input: PromptSpecInput): string;
}

/** Options for streaming generation. */
export interface PromptStreamOptions {
  /** Canonical conversation messages (system + user/assistant turns). */
  messages: PromptMessage[];
  /** Optional model override (provider-specific default otherwise). */
  model?: string;
  /** API key override. If absent, adapter reads from env. */
  apiKey?: string;
  /** Abort signal for Ctrl+C / timeout cancellation. */
  signal?: AbortSignal;
  /** Optional base URL override (useful for local runtimes). */
  baseUrl?: string;
  /** Cap on output tokens (provider may truncate). */
  maxTokens?: number;
}

/** Terminal chunk payload emitted at stream end (token / cost telemetry). */
export interface PromptStreamTerminal {
  /** Best-effort token estimate when the provider does not expose one. */
  tokensEstimated: number;
  /** Provider-reported output token count when available. */
  tokensOut?: number;
  /** Provider-reported input token count when available. */
  tokensIn?: number;
}

/** Provider-specific message rendering. */
export interface PromptAdapter {
  name: PromptProvider;
  /** Return the default max-char budget for the user prompt. */
  getDefaultUserCharBudget(): number;
  /**
   * Convert generic messages into provider-preferred form. Most providers
   * accept OpenAI-style [{role, content}] but Claude / Gemini have nuances:
   * - Claude: system goes into its own top-level field, not a message.
   * - Gemini: uses roles "user" / "model" and merges system into the first
   *   user turn.
   */
  render(messages: PromptMessage[]): PromptMessage[];
  /**
   * Stream a model response chunk-by-chunk. Yields text deltas (`string`)
   * until the underlying request completes, then yields one terminal
   * {@link PromptStreamTerminal} record with token accounting.
   *
   * Implementations MUST:
   *   - Respect `options.signal` (abort early when tripped).
   *   - Never log `apiKey` or any token.
   *   - Convert network / auth failures into typed `Error` with a safe
   *     (non-secret-bearing) `message`.
   */
  stream(options: PromptStreamOptions): AsyncIterable<string | PromptStreamTerminal>;
}
