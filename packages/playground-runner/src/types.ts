/**
 * Shared types for the playground runner.
 *
 * These types are consumed by the Worker entry (`worker.ts`), the Durable
 * Object (`durable-object.ts`), the adapter implementations (`adapter.ts`),
 * and the mandujs.com front-end (out of scope for this package — see
 * Phase 16.2 front-end work).
 *
 * **Design note**: The SSE event shape here is the public API contract
 * with the front-end. Do not break-change without a major version bump
 * and a front-end migration plan.
 */

/** Opaque identifier for a single playground run. Minted by the DO. */
export type RunId = string;

/** Slug identifying one of the built-in starter examples. */
export type ExampleSlug =
  | "hello-mandu"
  | "filling-loader"
  | "island-hydration"
  | "api-zod"
  | "auth-filling"
  | "custom";

/**
 * SSE event wire shape. Each event is serialized as:
 *
 *   event: <type>\n
 *   data: <JSON payload>\n\n
 *
 * Consumers MUST handle unknown event types gracefully (forward-compat).
 */
export type SSEEvent =
  | { type: "sandbox-url"; data: { url: string; runId: RunId } }
  | { type: "stdout"; data: { chunk: string } }
  | { type: "stderr"; data: { chunk: string } }
  | { type: "exit"; data: { code: number; durationMs: number } }
  | {
      type: "error";
      data: {
        reason:
          | "timeout"
          | "oom"
          | "compile"
          | "egress-denied"
          | "output-cap"
          | "internal";
        message?: string;
      };
    };

/** Input payload for `POST /api/playground/run`. */
export interface RunRequestBody {
  /** Source code for the user's single `page.tsx` file. */
  code: string;
  /** Which starter example the user based their code on. */
  example: ExampleSlug;
  /** Turnstile token from front-end widget. Required after 5 runs/15min/IP. */
  turnstileToken?: string;
}

/** Options passed from the Worker to the Durable Object. */
export interface RunOptions {
  code: string;
  example: ExampleSlug;
  runId: RunId;
  /** Client IP for audit + rate-limit bookkeeping. Never logged with code. */
  clientIp: string;
}

/**
 * Abstract contract for executing user code. Implementations swap the
 * execution backend:
 *  - {@link CloudflareSandboxAdapter} — production, uses Containers API
 *  - {@link FlyMachineAdapter}        — fallback, TODO
 *  - {@link MockAdapter}              — local dev + CI, uses Bun.spawn
 *
 * The Worker + DO talk to this interface only — they never import the
 * Cloudflare-specific SDK directly. This keeps CF-specific imports behind
 * a boundary so tests can run without a CF account.
 */
export interface PlaygroundAdapter {
  /**
   * Start a new sandbox for the given run. Returns a stream of SSE events
   * in wire order. The stream MUST end with either `exit` or `error`.
   *
   * Implementations MUST enforce `SECURITY_POLICY.wallClockMs` internally —
   * the DO adds an additional `alarm()` as belt-and-suspenders, but the
   * adapter is the first line of defense.
   */
  run(opts: RunOptions): AsyncIterable<SSEEvent>;

  /** Graceful shutdown hook (for pooled sandboxes). */
  dispose?(): Promise<void>;

  /** Adapter identity for logs + metrics. */
  readonly name: "cloudflare-sandbox" | "fly-machine" | "mock" | "docker-sandbox";
}

/**
 * Per-environment bindings available to the Worker. Populated via
 * `wrangler.toml` bindings block. The actual names are placeholders —
 * operators customize via `wrangler.toml.template`.
 */
export interface WorkerBindings {
  /** Durable Object namespace for `PlaygroundRunner`. */
  PLAYGROUND_DO: DurableObjectNamespace;
  /** Rate-limit counter storage. */
  RATE_LIMIT: KVNamespace;
  /** Cloudflare Sandbox container binding. */
  SANDBOX?: unknown;
  /** Secret — Turnstile server-side verification key. */
  TURNSTILE_SECRET?: string;
  /** Feature flag — set to `"mock"` in dev to force MockAdapter. */
  ADAPTER_MODE?: "cloudflare" | "fly" | "mock" | "docker";
}

// -----------------------------------------------------------------------------
// Ambient types we re-declare to avoid a hard dep on
// `@cloudflare/workers-types` for unit tests (it's in devDependencies only).
// The real thing is structurally compatible.
// -----------------------------------------------------------------------------

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Minimal execution-ctx shape. Matches Workers `ExecutionContext`. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
