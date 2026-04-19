import type { ManduConfig } from "@mandujs/core";

/**
 * Mandu Desktop Starter — Phase 9c prototype.
 *
 * The desktop entry (`src/desktop/main.ts`) binds Bun.serve() to
 * 127.0.0.1 with an ephemeral port and opens a native WebView. No public
 * port is exposed; loopback-only by design.
 */
export default {
  server: {
    // host-only by default; src/desktop/main.ts overrides with port:0 when
    // launching the window.
    port: 3333,
    hostname: "127.0.0.1",
  },
  guard: {
    realtime: false,
  },
} satisfies ManduConfig;
