# Mandu Desktop Starter

Minimal desktop app built with Mandu + [webview-bun](https://github.com/tr1ckydev/webview-bun). Phase 9c prototype.

## Architecture

```
+------------------+            +--------------------+
|   Main thread    |            |       Worker       |
|  (Bun.serve)     | <- IPC ->  | (Webview owner)    |
|  127.0.0.1:0     |            | @mandujs/core/     |
|                  |            |  desktop/worker    |
+------------------+            +--------------------+
         |                                |
         |      HTTP over loopback        |
         +--------------------------------+
```

The main thread runs `startServer()` on `127.0.0.1` with an ephemeral port. A Worker owns the native Webview — its blocking `run()` loop cannot starve the HTTP server's event loop.

## Prerequisites

- Bun 1.3.12 or newer
- Platform-specific system WebView:
  - **Windows 10/11**: [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (preinstalled on Windows 11)
  - **macOS 11+**: WKWebView (system-provided)
  - **Linux**: `libgtk-4-1 libwebkitgtk-6.0-4` (Debian 24.04+ / Ubuntu with PPA)

## Run

```bash
bun install              # installs @mandujs/core + webview-bun peer
mandu build              # generates .mandu/manifest.json + client bundles
bun run src/desktop/main.ts
```

## Build a single binary

```bash
bun build --compile src/desktop/main.ts --outfile mandu-desktop-app
```

The resulting binary (~112 MB on Windows) is fully self-contained: the Bun runtime, your Mandu app, and `libwebview.dll` / `.dylib` / `.so` are all embedded.

## Environment variables

| Variable            | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `MANDU_APP_TITLE`   | Override the window title (default: "Mandu Desktop Starter") |

## File layout

- `app/` — Mandu FS routes (`layout.tsx`, `page.tsx`)
- `src/desktop/main.ts` — desktop entry (server + Worker + window)
- `mandu.config.ts` — Mandu configuration
- `.mandu/` — generated at build time (gitignored)

## Customize

- **Window dimensions / chrome** — edit the `options` object in `src/desktop/main.ts` (fields match `WindowOptions` in `@mandujs/core/desktop`).
- **Native IPC** — register `bind()` handlers inside the Worker. The current entry exposes none; see `@mandujs/core/desktop/worker` for the protocol.
- **Multiple windows** — spawn additional Workers, each `postMessage({ type: "open", ... })`.

## Notes

- `bun run src/desktop/main.ts` requires `mandu build` to have succeeded (routes + optional bundles).
- For HMR during development of UI (not the window shell), use `mandu dev` to open the routes in a regular browser. The window shell is decoupled from HMR — it's a thin WebView wrapper.
