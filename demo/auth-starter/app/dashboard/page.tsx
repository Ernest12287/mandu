/**
 * Protected dashboard. If the caller has no session, the loader short-
 * circuits via `redirect("/login")` — a 302 is emitted server-side with
 * no SSR render, no client-side bounce, no meta-refresh shell. Cookies
 * set earlier in the loader (e.g. the CSRF token) survive the redirect.
 *
 * Before DX-3 this page rendered a meta-refresh + script fallback for the
 * unauthenticated branch because loaders couldn't return Responses; that
 * workaround is no longer needed.
 *
 * Implements the `loadUser` bridge: `loginUser` persists `userId` in the
 * session; the loader reads it, resolves to a `User` via `userStore`, and
 * hands a public projection to the view.
 */
import { Mandu, redirect } from "@mandujs/core";
import { attachAuthContext } from "../../src/lib/auth";
import { userStore, type User } from "../../server/domain/users";

interface PublicUser {
  id: string;
  email: string;
  createdAt: number;
}

interface LoaderData {
  user: PublicUser;
  csrfToken: string;
}

function toPublicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, createdAt: u.createdAt };
}

function DashboardPage({ loaderData }: { loaderData?: LoaderData }) {
  // After DX-3, an unauthenticated caller never reaches this render path —
  // the loader returns a 302 before SSR runs. If loaderData is somehow
  // missing (shouldn't happen), fall back to a minimal safe view.
  const user = loaderData?.user;
  const csrfToken = loaderData?.csrfToken ?? "";

  if (!user) {
    // Defensive fallback — guarded by the redirect above, shouldn't render.
    return <div data-testid="dashboard-unauthed" />;
  }

  const createdDate = new Date(user.createdAt).toISOString().slice(0, 10);

  return (
    <div>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, marginBottom: "0.5rem" }}>
        Dashboard
      </h1>
      <p style={{ color: "var(--ink-muted)", fontSize: "0.875rem", marginBottom: "1.75rem" }}>
        You're logged in. This page is server-rendered behind a session check.
      </p>

      <section className="card" style={{ padding: "1.25rem", marginBottom: "1.5rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: "0.5rem", fontSize: "0.875rem" }}>
          <span style={{ color: "var(--ink-muted)" }}>Email</span>
          <span data-testid="dashboard-email" style={{ fontWeight: 500 }}>{user.email}</span>
          <span style={{ color: "var(--ink-muted)" }}>User ID</span>
          <code data-testid="dashboard-uid" style={{ fontSize: "0.8125rem" }}>{user.id}</code>
          <span style={{ color: "var(--ink-muted)" }}>Joined</span>
          <span>{createdDate}</span>
        </div>
      </section>

      <form method="POST" action="/api/logout">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <button type="submit" className="btn-secondary" data-testid="dashboard-logout">
          Log out
        </button>
      </form>
    </div>
  );
}

export const filling = Mandu.filling<LoaderData>().loader(async (ctx) => {
  const { userId, csrfToken } = await attachAuthContext(ctx);
  if (!userId) {
    // DX-3: loader-level redirect. attachAuthContext may have set a CSRF
    // cookie on ctx.cookies — it is merged into the 302 automatically.
    return redirect("/login");
  }
  const raw = userStore.findById(userId);
  if (!raw) {
    // Session points at a deleted user — log them out and bounce to /login.
    return redirect("/login");
  }
  return { user: toPublicUser(raw), csrfToken };
});

export default DashboardPage;
