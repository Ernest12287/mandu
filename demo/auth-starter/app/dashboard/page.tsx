/**
 * Protected dashboard. If `currentUserId(ctx)` returns null we render a
 * redirect shell (meta-refresh + anchor fallback) that sends the browser
 * to /login. This is the pattern for "redirect from a page loader" in
 * Mandu: loaders can't throw Responses, but rendering is fully under
 * our control.
 *
 * Implements the `loadUser` bridge: `loginUser` persists `userId` in the
 * session; the loader reads it, resolves to a `User` via `userStore`, and
 * hands a public projection to the view.
 */
import { Mandu } from "@mandujs/core";
import { attachAuthContext } from "../../src/lib/auth";
import { userStore, type User } from "../../server/domain/users";

interface PublicUser {
  id: string;
  email: string;
  createdAt: number;
}

interface LoaderData {
  user: PublicUser | null;
  csrfToken: string;
}

function toPublicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, createdAt: u.createdAt };
}

function DashboardPage({ loaderData }: { loaderData?: LoaderData }) {
  const user = loaderData?.user ?? null;
  const csrfToken = loaderData?.csrfToken ?? "";

  if (!user) {
    return (
      <div data-testid="dashboard-unauthed" style={{ textAlign: "center", padding: "2rem 0" }}>
        {/* meta-refresh: works without JS, and Playwright follows it */}
        <meta httpEquiv="refresh" content="0; url=/login" />
        <p>
          You need to <a href="/login" style={{ color: "var(--accent)" }}>log in</a> to view this page.
        </p>
        {/* Script fallback for faster redirect when JS is enabled */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.location.replace("/login");`,
          }}
        />
      </div>
    );
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

const filling = Mandu.filling<LoaderData>().loader(async (ctx) => {
  const { userId, csrfToken } = await attachAuthContext(ctx);
  if (!userId) return { user: null, csrfToken };
  const raw = userStore.findById(userId);
  return { user: raw ? toPublicUser(raw) : null, csrfToken };
});

export default { component: DashboardPage, filling };
