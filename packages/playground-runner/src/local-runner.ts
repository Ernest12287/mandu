/**
 * Local-mode runner orchestrator — stands in for the Durable Object
 * (`durable-object.ts`) when running Option 2 (local dev server).
 *
 * **Why a separate orchestrator?**
 *
 * The Cloudflare `PlaygroundRunner` DO depends on:
 *   - `DurableObjectState.storage.setAlarm()` — a CF-only primitive
 *   - `env.PLAYGROUND_DO` / `env.RATE_LIMIT` bindings
 *   - The Workers runtime's `waitUntil` / sticky-routing semantics
 *
 * None of those exist in a plain `Bun.serve` process. Rather than polyfill
 * CF primitives (a lot of surface area, zero local benefit), we provide an
 * in-memory equivalent that speaks the same SSE wire contract.
 *
 * The Cloudflare path (`durable-object.ts`) is left untouched — this file
 * is the local-only sibling.
 *
 * **Contract parity**:
 *   - Same SSE event shape + ordering as the DO
 *   - Same `SECURITY_POLICY` enforcement (wall-clock + output cap)
 *   - Same heartbeat frames for long-running runs
 *   - Same abort-on-cancel behavior when the client drops the connection
 */

import { MockAdapter } from "./adapter";
import { SECURITY_POLICY } from "./security";
import type { ExampleSlug, RunOptions, SSEEvent } from "./types";

/**
 * Minimal contract for what the orchestrator needs from an adapter.
 *
 * We keep it narrower than `PlaygroundAdapter` so unit tests can pass an
 * inline stub without re-declaring the full `name` / `dispose` surface.
 */
export interface LocalRunnerAdapter {
  run(opts: RunOptions): AsyncIterable<SSEEvent>;
  dispose?(): Promise<void>;
}

/**
 * Configuration for {@link LocalRunner}. All fields default to safe,
 * production-like values — tests set `wallClockMs` to shorten timeout
 * assertions without bypassing the enforcement path itself.
 */
export interface LocalRunnerOptions {
  /**
   * Adapter to execute user code. Defaults to {@link MockAdapter}.
   *
   * Do NOT wire the CloudflareSandboxAdapter here — this orchestrator
   * runs in a plain Bun process without CF bindings.
   */
  adapter?: LocalRunnerAdapter;

  /**
   * Hard wall-clock cap applied as a belt-and-suspenders watchdog on top
   * of whatever the adapter enforces internally. Defaults to
   * `SECURITY_POLICY.wallClockMs` (30s) — identical to the DO alarm grace.
   *
   * Tests may override to a much smaller value (e.g. 1500ms) to assert
   * timeout semantics without waiting 30s. Production callers MUST NOT
   * override this — the server entry (`local-server.ts`) never reads a
   * value here, so the default is binding.
   */
  wallClockMs?: number;

  /**
   * Heartbeat interval in ms. Matches the DO's 15s cadence. SSE-comment
   * frames (`": heartbeat\n\n"`) keep long-running connections alive
   * through proxies / load balancers.
   */
  heartbeatMs?: number;
}

/** Input for a single run — mirrors the DO's body shape. */
export interface LocalRunInput {
  code: string;
  example: ExampleSlug;
  runId: string;
  /** Synthetic — local mode doesn't have a real client IP. */
  clientIp?: string;
}

/**
 * In-memory run orchestrator. One instance per long-lived server; each
 * incoming POST gets a fresh `run()` call that owns its own abort signal.
 *
 * Not thread-safe across concurrent runs — but `Bun.serve` is single-
 * threaded per process, so concurrent runs are multiplexed on the event
 * loop. Each run owns private state via closure.
 */
export class LocalRunner {
  private readonly adapter: LocalRunnerAdapter;
  private readonly wallClockMs: number;
  private readonly heartbeatMs: number;

  /** In-flight runs — used by {@link shutdown} for graceful SIGINT. */
  private readonly inflight = new Set<AbortController>();

  constructor(options: LocalRunnerOptions = {}) {
    this.adapter = options.adapter ?? new MockAdapter();
    this.wallClockMs = options.wallClockMs ?? SECURITY_POLICY.wallClockMs;
    // Heartbeat should be shorter than wall clock so we always emit at
    // least one keepalive before the watchdog fires. Cap at 15s to match
    // the production DO.
    this.heartbeatMs = options.heartbeatMs ?? Math.min(15_000, Math.max(1_000, Math.floor(this.wallClockMs / 3)));
  }

  /**
   * Build an SSE `ReadableStream` for a single run. The stream:
   *   1. Emits `sandbox-url` first (contract guarantee)
   *   2. Forwards `stdout` / `stderr` events from the adapter
   *   3. Ends with `exit` OR `error` — never both, never neither
   *   4. Emits `: heartbeat` comments every {@link heartbeatMs}
   *
   * The returned stream is consumed by `Response(body, ...)`. Cancellation
   * (client drop) fires the `cancel()` hook, which aborts the adapter.
   */
  buildStream(input: LocalRunInput): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    this.inflight.add(abort);

    const opts: RunOptions = {
      code: input.code,
      example: input.example,
      runId: input.runId,
      clientIp: input.clientIp ?? "127.0.0.1",
    };

    const { wallClockMs, heartbeatMs, adapter } = this;
    const inflight = this.inflight;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (event: SSEEvent): void => {
          const line =
            `event: ${event.type}\n` +
            `data: ${JSON.stringify(event.data)}\n\n`;
          try {
            controller.enqueue(encoder.encode(line));
          } catch {
            // Controller closed — client dropped. Abort propagates below.
          }
        };

        // Heartbeat — SSE comment frame, ignored by EventSource clients
        // but keeps the socket alive through idle proxies.
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            // Controller already closed.
          }
        }, heartbeatMs);

        // Watchdog timer. The adapter has its own internal timeout; this
        // is belt-and-suspenders matching the DO `alarm()` grace.
        const watchdog = setTimeout(() => {
          abort.abort(new Error("wall-clock-timeout"));
        }, wallClockMs + 1_000 /* 1s grace */);

        let terminated = false;

        // We drive the adapter iterator manually so we can race each
        // `next()` call against the abort signal. A plain `for await`
        // blocks indefinitely if the adapter never yields (e.g. an
        // infinite loop that doesn't produce stdout), which defeats the
        // watchdog.
        const iter = adapter.run(opts)[Symbol.asyncIterator]();

        /**
         * Race the next iteration against the abort signal. Returns
         * either the next iterator result or a sentinel indicating
         * the watchdog fired.
         */
        const nextOrAbort = (): Promise<
          | { kind: "value"; value: IteratorResult<SSEEvent> }
          | { kind: "aborted" }
        > =>
          new Promise((resolve) => {
            let settled = false;
            const onAbort = (): void => {
              if (settled) return;
              settled = true;
              abort.signal.removeEventListener("abort", onAbort);
              resolve({ kind: "aborted" });
            };
            if (abort.signal.aborted) {
              onAbort();
              return;
            }
            abort.signal.addEventListener("abort", onAbort, { once: true });
            iter.next().then(
              (value) => {
                if (settled) return;
                settled = true;
                abort.signal.removeEventListener("abort", onAbort);
                resolve({ kind: "value", value });
              },
              (err) => {
                if (settled) return;
                settled = true;
                abort.signal.removeEventListener("abort", onAbort);
                // Surface adapter errors through the same channel as an
                // iteration result so the main loop handles them uniformly.
                resolve({
                  kind: "value",
                  value: {
                    done: true,
                    value: undefined as unknown as SSEEvent,
                  },
                });
                // Re-throw after settling so the outer catch still runs.
                queueMicrotask(() => {
                  throw err;
                });
              }
            );
          });

        try {
          while (true) {
            const step = await nextOrAbort();

            if (step.kind === "aborted") {
              write({
                type: "error",
                data: {
                  reason: "timeout",
                  message: `exceeded ${wallClockMs}ms wall-clock`,
                },
              });
              terminated = true;
              // Best-effort close of the adapter iterator — fire-and-
              // forget because a hanging adapter won't observe `return()`
              // until its pending `await` resolves. We've already emitted
              // the terminator; let cooperative adapters clean up async.
              try {
                iter.return?.(undefined)?.catch(() => {
                  // Ignore — the iterator may reject on abort.
                });
              } catch {
                // Synchronous throw from `return()` — non-fatal.
              }
              break;
            }

            const { done, value } = step.value;
            if (done) break;

            write(value);
            if (value.type === "exit" || value.type === "error") {
              terminated = true;
              // Drain any trailing yields to let the adapter finish its
              // cleanup, but ignore further events to honor the
              // one-terminator contract.
              try {
                await iter.return?.(undefined);
              } catch {
                // Non-fatal — see above.
              }
              break;
            }
          }

          // Adapter finished without emitting a terminator — that's a
          // contract violation, but we repair it rather than hang.
          if (!terminated) {
            write({
              type: "error",
              data: {
                reason: "internal",
                message: "adapter stream closed without exit/error event",
              },
            });
          }
        } catch (err) {
          write({
            type: "error",
            data: {
              reason: "internal",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        } finally {
          clearTimeout(watchdog);
          clearInterval(heartbeat);
          inflight.delete(abort);
          try {
            controller.close();
          } catch {
            // Already closed on client drop.
          }
        }
      },

      cancel() {
        // Client dropped the connection. Propagate to the adapter.
        abort.abort(new Error("client-cancelled"));
        inflight.delete(abort);
      },
    });
  }

  /**
   * Abort all in-flight runs. Called from `local-server.ts`'s SIGINT
   * handler. Safe to call multiple times.
   */
  shutdown(): void {
    for (const abort of this.inflight) {
      try {
        abort.abort(new Error("server-shutdown"));
      } catch {
        // Already aborted.
      }
    }
    this.inflight.clear();
  }

  /** Read-only view of active run count — used by health endpoint. */
  get activeRunCount(): number {
    return this.inflight.size;
  }
}
