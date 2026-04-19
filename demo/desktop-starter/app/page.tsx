/**
 * Desktop starter — home page.
 *
 * Rendered server-side by Mandu; the native WebView shell loads this URL
 * via `src/desktop/main.ts`. No client JS required — the page is purely
 * SSR to keep the binary small. Add islands (via `.island.tsx` suffix)
 * when you need interactivity.
 */
export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto" }}>
      <header style={{ marginBottom: 48 }}>
        <h1
          style={{
            fontSize: 48,
            fontWeight: 700,
            letterSpacing: "-0.025em",
            marginBottom: 16,
          }}
        >
          Hello, Desktop
        </h1>
        <p style={{ fontSize: 18, color: "#94a3b8", lineHeight: 1.6 }}>
          This window is rendered by{" "}
          <code style={{ color: "#fbbf24" }}>WebView2</code> /{" "}
          <code style={{ color: "#fbbf24" }}>WKWebView</code> /{" "}
          <code style={{ color: "#fbbf24" }}>WebKitGTK 6</code> and served by
          a local <code style={{ color: "#fbbf24" }}>Bun.serve()</code>{" "}
          instance on 127.0.0.1.
        </p>
      </header>

      <section
        style={{
          padding: 24,
          borderRadius: 16,
          background: "rgba(30, 41, 59, 0.5)",
          border: "1px solid rgba(148, 163, 184, 0.15)",
        }}
      >
        <h2
          style={{
            fontSize: 20,
            fontWeight: 600,
            marginBottom: 16,
            color: "#f1f5f9",
          }}
        >
          Architecture
        </h2>
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            lineHeight: 1.8,
            color: "#cbd5e1",
          }}
        >
          <li>
            <strong style={{ color: "#f1f5f9" }}>Main thread:</strong>{" "}
            <code>Bun.serve()</code> on <code>127.0.0.1:0</code> (ephemeral)
          </li>
          <li>
            <strong style={{ color: "#f1f5f9" }}>Worker:</strong>{" "}
            <code>@mandujs/core/desktop/worker</code> owns the blocking
            WebView event loop
          </li>
          <li>
            <strong style={{ color: "#f1f5f9" }}>IPC:</strong> JSON
            messages between threads; page↔Bun via{" "}
            <code>bind()</code> RPC
          </li>
        </ul>
      </section>

      <footer style={{ marginTop: 48, fontSize: 14, color: "#64748b" }}>
        Phase 9c — webview-bun FFI prototype
      </footer>
    </main>
  );
}
