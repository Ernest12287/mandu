/**
 * @mandujs/core/desktop — type contracts
 *
 * Shared types for Mandu's desktop integration. These intentionally mirror
 * but do NOT import `webview-bun`, so consumers that never touch desktop
 * features (e.g. web-only apps, CI type-checking without the optional peer
 * installed) don't pay the cost of loading the FFI module graph.
 *
 * The concrete runtime lives in `./window.ts` behind a lazy import.
 */

/**
 * Size hint applied to the window. Mirrors `webview-bun` `SizeHint` enum but
 * exposed here as a string union so callers don't need to import the FFI
 * module just to pass an option.
 *
 * - `"none"`     → window is freely resizable, no constraints.
 * - `"min"`      → the supplied width/height are treated as minimums.
 * - `"max"`      → the supplied width/height are treated as maximums.
 * - `"fixed"`    → window cannot be resized by the user.
 *
 * Default: `"none"`.
 */
export type WindowSizeHint = "none" | "min" | "max" | "fixed";

/**
 * Options passed to {@link createWindow}. Only `url` is required — everything
 * else has a sane default.
 */
export interface WindowOptions {
  /**
   * URL to navigate to. Mandu's recommended pattern is to start a local HTTP
   * server on `127.0.0.1:0` and pass `http://127.0.0.1:<port>`. Remote URLs
   * are technically possible but bypass the security boundary — don't.
   */
  url: string;
  /** Window title. Default: `"Mandu Desktop"`. */
  title?: string;
  /** Width in logical pixels. Default: `1024`. */
  width?: number;
  /** Height in logical pixels. Default: `768`. */
  height?: number;
  /**
   * Size hint — controls resizability. Default: `"none"` (freely resizable).
   * Pass `"fixed"` for kiosk-style windows.
   */
  hint?: WindowSizeHint;
  /**
   * Open DevTools / enable WebInspector. Default: `false`.
   *
   * Note: On macOS this requires an entitlement; on Linux GTK builds, DevTools
   * is baked into WebKitGTK. On Windows WebView2, pressing F12 inside the
   * running window also works.
   */
  debug?: boolean;
  /**
   * Pre-register request/response handlers exposed to the page's JavaScript
   * as global async functions. Equivalent to calling `handle.bind(name, fn)`
   * for each entry, but registered BEFORE the first navigation — safer
   * against race conditions where the page calls an unbound global.
   */
  handlers?: Record<string, (...args: unknown[]) => unknown>;
  /**
   * Invoked once after the window is shown and the first navigation begins.
   * Runs on the main thread (or Worker, whichever owns the Webview instance).
   * Exceptions bubble up to the caller's promise.
   */
  onReady?: () => void | Promise<void>;
  /**
   * Invoked when the user closes the window (title-bar X or Cmd+Q / Alt+F4).
   * Use this to tear down the HTTP server, flush caches, etc.
   */
  onClose?: () => void | Promise<void>;
}

/**
 * Opaque handle returned by {@link createWindow}. Provides a minimal, stable
 * surface over the underlying `webview-bun` instance. Consumers should not
 * cast this to `Webview` — future Mandu versions may wrap a different backend
 * (direct FFI, `Bun.WebView`, etc.).
 */
export interface WindowHandle {
  /**
   * Close the window and release native resources. Idempotent — calling
   * twice is safe.
   */
  close(): Promise<void>;
  /**
   * Register a callback for when the window is closed by the user or by
   * `close()`. Callback fires exactly once.
   */
  onClose(cb: () => void): void;
  /**
   * Inject JavaScript into the current page. Does NOT return a value — use
   * `bind()` for host↔page request/response.
   */
  eval(js: string): Promise<void>;
  /**
   * Expose a host function as a global async function on the page. The
   * returned value (or its JSON serialization) is resolved by the caller's
   * awaited `window.<name>(...)` in the page.
   *
   * Arguments from the page are JSON-deserialized before being passed in;
   * returns are JSON-serialized back. Non-serializable values (undefined,
   * functions, circular refs) will either be dropped or throw.
   */
  bind(name: string, fn: (...args: unknown[]) => unknown): void;
  /**
   * Resolves when the user closes the window (title-bar X or equivalent),
   * OR when `close()` is called. Does NOT reject on error — errors are
   * surfaced via the synchronous throw from `createWindow()` / `eval()`.
   *
   * Useful for the common pattern:
   *   ```ts
   *   const win = await createWindow(opts);
   *   await win.closed;
   *   await server.stop();
   *   ```
   */
  readonly closed: Promise<void>;
  /**
   * Start the platform event loop. **Blocking.** Returns when the window
   * closes. On the main thread, this will freeze the Bun server — launch
   * a Worker for the HTTP server or wrap the window in a Worker itself.
   *
   * Most callers should use {@link closed} instead of managing `run()`
   * manually; {@link createWindow} auto-invokes `run()` under the hood when
   * `autoRun: true` (the default).
   */
  run(): void;
}

/**
 * Messages flowing from the parent thread → Worker that hosts the window.
 * Exported so callers authoring custom Worker entries have a stable shape.
 */
export type WorkerInbound =
  | {
      type: "open";
      /** Serialized {@link WindowOptions}. Functions are stripped — bind handlers must be registered via worker code. */
      options: Omit<WindowOptions, "handlers" | "onReady" | "onClose">;
    }
  | {
      type: "close";
    }
  | {
      type: "eval";
      js: string;
    };

/**
 * Messages flowing from the Worker → parent thread.
 */
export type WorkerOutbound =
  | { type: "ready" }
  | { type: "closed" }
  | { type: "error"; message: string }
  | { type: "bind-call"; name: string; args: unknown[]; seq: string };
