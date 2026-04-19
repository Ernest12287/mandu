import { Mandu } from "@mandujs/core";

/**
 * Home page. Also used by the Phase 7.3 HDR E2E suite
 * (`tests/e2e/fast-refresh.spec.ts`):
 *
 *   - `loaderData.counter` — a fresh timestamp every time the filling
 *     loader runs. Mutating `spec/slots/index.slot.ts` in dev mode
 *     triggers Mandu's HDR pipeline (slot-refetch WS event) and the
 *     loader re-runs, so this value changes visibly. The test asserts
 *     both (a) the counter updates AND (b) a typed-into `<input>` on
 *     the same page keeps its value — proving HDR doesn't remount.
 *
 *   - `data-testid="hdr-counter"` + `data-testid="hdr-probe-input"` —
 *     stable hooks for Playwright. They're the only additions this
 *     commit makes beyond the original marketing copy.
 *
 * The inline `filling` export is deliberate: the filesystem auto-link
 * only sets `route.slotModule` when `spec/slots/{id}.slot.ts` exists
 * (see `packages/core/src/router/fs-routes.ts`). The page module itself
 * still supplies the loader; the slot file's presence is what gates
 * the dev-bundler into the HDR broadcast path.
 */
interface HomeLoaderData {
  counter: number;
  renderedAt: string;
}

export const filling = Mandu.filling<HomeLoaderData>().loader(async () => {
  // Fresh on every invocation — makes HDR observable from the browser.
  const counter = Date.now();
  return {
    counter,
    renderedAt: new Date(counter).toISOString(),
  };
});

export default function HomePage({ loaderData }: { loaderData?: HomeLoaderData }) {
  const counter = loaderData?.counter ?? 0;
  const renderedAt = loaderData?.renderedAt ?? "";

  return (
    <div>
      <h1
        style={{
          fontSize: "2.25rem",
          fontWeight: 700,
          lineHeight: 1.15,
          marginBottom: "0.75rem",
        }}
      >
        Mandu Auth Starter
      </h1>
      <p
        data-testid="home-tagline"
        style={{
          color: "var(--ink-muted)",
          fontSize: "1rem",
          lineHeight: 1.55,
          marginBottom: "2rem",
          maxWidth: "34rem",
        }}
      >
        A runnable demo of Phase 2 primitives: sessions, CSRF, argon2id password hashing,
        and the `loginUser` / `logoutUser` helpers — wired into a real signup / login /
        dashboard flow.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem" }}>
        <a data-testid="cta-signup" href="/signup" className="btn-primary">Sign up</a>
        <a data-testid="cta-login" href="/login" className="btn-secondary">Log in</a>
      </div>

      {/* Phase 7.3 HDR probe. Both markers are test-only; the UX is
          identical to "a debug timestamp in small text". */}
      <div
        style={{
          marginBottom: "2rem",
          padding: "0.75rem 1rem",
          border: "1px solid var(--border)",
          borderRadius: "0.375rem",
          background: "var(--surface)",
          fontSize: "0.8125rem",
          color: "var(--ink-muted)",
        }}
      >
        <div>
          HDR counter:{" "}
          <code data-testid="hdr-counter">{counter}</code>
        </div>
        <div>
          rendered at:{" "}
          <code data-testid="hdr-rendered-at">{renderedAt}</code>
        </div>
        <div style={{ marginTop: "0.5rem" }}>
          <label
            htmlFor="hdr-probe-input"
            style={{ display: "block", marginBottom: "0.25rem" }}
          >
            Probe input (preserved across HDR):
          </label>
          <input
            id="hdr-probe-input"
            data-testid="hdr-probe-input"
            type="text"
            className="input"
            placeholder="type here, then edit spec/slots/index.slot.ts"
            style={{ width: "100%" }}
          />
        </div>
      </div>

      <section>
        <h2 style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--ink-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "0.75rem" }}>
          What's exercised
        </h2>
        <ul className="card" style={{ padding: "1rem 1.25rem", listStyle: "disc", paddingInlineStart: "2.25rem" }}>
          <li style={{ marginBottom: "0.25rem" }}>
            <code>session()</code> middleware — cookie-backed, HMAC-signed
          </li>
          <li style={{ marginBottom: "0.25rem" }}>
            <code>csrf()</code> middleware — double-submit cookie on form POSTs
          </li>
          <li style={{ marginBottom: "0.25rem" }}>
            <code>hashPassword</code> / <code>verifyPassword</code> — argon2id via Bun.password
          </li>
          <li>
            <code>loginUser</code> / <code>logoutUser</code> / <code>currentUserId</code> — session bridge helpers
          </li>
        </ul>
      </section>
    </div>
  );
}
