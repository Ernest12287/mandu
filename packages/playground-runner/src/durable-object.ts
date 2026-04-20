/**
 * `PlaygroundRunner` — the Durable Object that hosts a single playground run.
 *
 * **Lifecycle**:
 *   1. Worker receives POST /api/playground/run
 *   2. Worker creates a new DO id (`idFromName(runId)`) and forwards the request
 *   3. DO's `fetch()` accepts the POST, starts the adapter, returns an SSE stream
 *   4. DO sets `alarm(wallClockMs)` as belt-and-suspenders — even if the adapter's
 *      internal abort fails, the alarm fires and the DO terminates the run
 *   5. DO emits final `exit` or `error` event, closes the stream
 *
 * **Why DO rather than a bare Worker?**
 *   - Per-run state: we track `runId → adapter` so `alarm()` can kill the
 *     specific run without touching siblings.
 *   - SSE backpressure: the DO holds the connection open; a bare Worker
 *     would fit but we need sticky routing for `proxyToSandbox` anyway.
 *   - Future: pool warm sandboxes inside the DO (P16.3+).
 *
 * **Isolation**: one DO per runId. Do NOT share a DO between runs — user
 * code in run A could otherwise observe state from run B.
 */

import { selectAdapter } from "./adapter";
import type {
  PlaygroundAdapter,
  RunOptions,
  SSEEvent,
  WorkerBindings,
} from "./types";
import { SECURITY_POLICY } from "./security";

/** Internal run state tracked by a single DO instance. */
interface ActiveRun {
  opts: RunOptions;
  adapter: PlaygroundAdapter;
  startedAt: number;
  /** Abort controller linked to the DO's alarm + manual aborts. */
  abort: AbortController;
}

/**
 * Cloudflare `DurableObjectState` type surface we rely on. Declared
 * locally to avoid a hard `@cloudflare/workers-types` dep in consumers.
 */
export interface DurableObjectState {
  id: { toString(): string };
  storage: {
    setAlarm(scheduledTime: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
  waitUntil?(promise: Promise<unknown>): void;
}

/**
 * Durable Object implementation. Exported as a class — the Worker's
 * `export { PlaygroundRunner }` at the bottom of `worker.ts` binds it
 * to the `PLAYGROUND_DO` namespace per `wrangler.toml`.
 */
export class PlaygroundRunner {
  private activeRun: ActiveRun | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerBindings
  ) {}

  /**
   * HTTP entry point. The Worker forwards POST /api/playground/run to us
   * via `stub.fetch(request)`. We accept only that path + method.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }

    if (this.activeRun) {
      // A DO id is minted per runId — if we receive a second POST for the
      // same id, that's a client retry after the stream failed. We refuse
      // rather than race: the client should request a new runId.
      return new Response(
        JSON.stringify({
          error: "run-already-active",
          runId: this.activeRun.opts.runId,
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    let body: RunOptions;
    try {
      body = (await request.json()) as RunOptions;
    } catch {
      return new Response(
        JSON.stringify({ error: "invalid-json" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return this.startRun(body);
  }

  /**
   * Start a run and return the SSE response. Separated from `fetch` so
   * unit tests can exercise it without constructing a full Request.
   */
  async startRun(opts: RunOptions): Promise<Response> {
    const adapter = selectAdapter(this.env);
    const abort = new AbortController();

    this.activeRun = {
      opts,
      adapter,
      startedAt: Date.now(),
      abort,
    };

    // Schedule the watchdog alarm. Even if the adapter's internal timeout
    // misfires (SDK bug, dropped signal), this alarm triggers `alarm()`
    // below and cleans up.
    await this.state.storage.setAlarm(
      Date.now() + SECURITY_POLICY.wallClockMs + 1_000 /* 1s grace */
    );

    const body = this.buildSSEBody(opts, adapter, abort.signal);

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // nginx/Cloudflare hint
      },
    });
  }

  /**
   * Fires when the DO alarm elapses. Kills the active run (if any) and
   * resets state. Called by the Workers runtime — no need to invoke
   * manually from user code.
   */
  async alarm(): Promise<void> {
    if (!this.activeRun) return;

    this.activeRun.abort.abort(new Error("wall-clock-timeout"));

    try {
      await this.activeRun.adapter.dispose?.();
    } catch {
      // Dispose failures are logged by the adapter; we've already aborted.
    }

    this.activeRun = null;
  }

  // ---------------------------------------------------------------------------
  // SSE streaming body
  // ---------------------------------------------------------------------------

  private buildSSEBody(
    opts: RunOptions,
    adapter: PlaygroundAdapter,
    abortSignal: AbortSignal
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const runner = this;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (event: SSEEvent) => {
          const line =
            `event: ${event.type}\n` +
            `data: ${JSON.stringify(event.data)}\n\n`;
          controller.enqueue(encoder.encode(line));
        };

        // Heartbeat — keeps the connection alive through proxies that
        // drop idle sockets. Sent as an SSE comment (starts with `:`).
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            // Controller closed.
          }
        }, 15_000);

        try {
          for await (const event of adapter.run(opts)) {
            if (abortSignal.aborted) {
              write({
                type: "error",
                data: { reason: "timeout", message: "aborted by watchdog" },
              });
              break;
            }
            write(event);
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
          clearInterval(heartbeat);
          runner.activeRun = null;
          try {
            await runner.state.storage.deleteAlarm();
          } catch {
            // Alarm may have already fired.
          }
          controller.close();
        }
      },

      cancel() {
        abortSignal.dispatchEvent(new Event("abort"));
      },
    });
  }
}
