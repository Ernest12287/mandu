/**
 * @mandujs/core/testing/session
 *
 * Pre-baked login state for integration tests.
 *
 * Most test scenarios start with "given a logged-in user, when...". This
 * module returns a ready-to-use set of request headers (specifically,
 * a `Cookie` header bearing a signed session payload) without going
 * through the live `/login` flow — which would couple the test to the
 * app's password, CSRF, and rate-limit policies.
 *
 * ```ts
 * import { createTestSession } from "@mandujs/core/testing";
 *
 * const authed = await createTestSession({ userId: "u_42", roles: ["admin"] });
 *
 * const res = await server.fetch("/dashboard", {
 *   headers: authed.headers,
 * });
 * expect(res.status).toBe(200);
 * ```
 *
 * ## Contract
 *
 * - **Storage compatibility**: the cookie produced here is consumable by the
 *   same `createCookieSessionStorage()` the app uses in production, as long
 *   as the shared `secret` matches. Tests typically pass the app's real
 *   storage instance via `{ storage }`; otherwise the fixture spins up a
 *   fresh one with a deterministic test secret.
 * - **No network**: everything happens in-process — no HTTP roundtrip, no
 *   CSRF token generation, no rate-limit counters incremented.
 * - **Fully typed**: `userId` is required, `extras` carries arbitrary
 *   JSON-serializable payload. Cookie attributes (name, path, secure) come
 *   from the provided storage's options.
 *
 * @module testing/session
 */

import {
  Session,
  createCookieSessionStorage,
  type SessionStorage,
  type CookieSessionOptions,
} from "../filling/session";
import { CookieManager } from "../filling/context";

/** Key under which login helpers persist the user id. Mirrors `auth/login.ts`. */
const USER_ID_KEY = "userId";
/** Key under which login helpers persist the login timestamp. Mirrors `auth/login.ts`. */
const LOGGED_AT_KEY = "loginAt";

/** Default session secret used when the caller does not pass a storage instance. */
const DEFAULT_TEST_SECRET = "mandu-test-secret-do-not-use-in-production";

/** Options for {@link createTestSession}. */
export interface CreateTestSessionOptions {
  /** User id persisted in the session. Required. */
  userId: string;
  /** Arbitrary additional session data (JSON-serializable). */
  extras?: Record<string, unknown>;
  /**
   * Login timestamp to persist. Default: `Date.now()` at call time.
   * Useful for age-sensitive flows (e.g., re-auth prompts).
   */
  loggedAt?: number;
  /**
   * Storage instance to commit against. When omitted, the fixture spins up
   * a fresh in-memory cookie-backed storage with {@link DEFAULT_TEST_SECRET}.
   * Pass your app's real storage (same `secret`) to make the cookie
   * round-trippable by the server under test.
   */
  storage?: SessionStorage;
  /**
   * Overrides for the fixture-created storage. Ignored when `storage` is
   * passed directly.
   */
  cookieOptions?: Partial<CookieSessionOptions["cookie"]>;
}

/** The return shape. */
export interface TestSession {
  /** Raw `Set-Cookie` header string produced by committing the session. */
  readonly setCookie: string;
  /** `Cookie: ...` value suitable for outbound requests. */
  readonly cookieHeader: string;
  /** Headers object with `Cookie` pre-set — spread into `fetch()` directly. */
  readonly headers: Record<string, string>;
  /** The storage instance used to commit — re-use for subsequent setup steps. */
  readonly storage: SessionStorage;
  /** The `Session` instance that was committed (read-only snapshot view). */
  readonly session: Session;
  /** Convenience: the `userId` the fixture was created for. */
  readonly userId: string;
}

/**
 * Build a ready-to-use authenticated session.
 *
 * **Why not just POST `/login`?** Because the login endpoint can be behind
 * CSRF, rate limit, captcha, 2FA, etc. The testing need is to assert
 * behaviour *given* a logged-in user — not to re-validate the login path.
 * For login-path tests, call the route directly with `server.fetch("/login", …)`.
 */
export async function createTestSession(
  options: CreateTestSessionOptions,
): Promise<TestSession> {
  const { userId, extras, loggedAt, cookieOptions } = options;

  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError(
      "[testing/session] createTestSession: 'userId' must be a non-empty string.",
    );
  }

  const storage =
    options.storage ??
    createCookieSessionStorage({
      cookie: {
        name: cookieOptions?.name ?? "__session",
        secrets: cookieOptions?.secrets ?? [DEFAULT_TEST_SECRET],
        httpOnly: cookieOptions?.httpOnly ?? true,
        // Tests run over plain HTTP — forcing Secure would make the cookie
        // invisible to the server under test. Explicit `false` overrides the
        // production-env default in `createCookieSessionStorage`.
        secure: cookieOptions?.secure ?? false,
        sameSite: cookieOptions?.sameSite ?? "lax",
        maxAge: cookieOptions?.maxAge ?? 86_400,
        path: cookieOptions?.path ?? "/",
        domain: cookieOptions?.domain,
      },
    });

  const session = new Session();
  session.set(USER_ID_KEY, userId);
  session.set(LOGGED_AT_KEY, typeof loggedAt === "number" ? loggedAt : Date.now());

  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      session.set(key, value);
    }
  }

  const setCookie = await storage.commitSession(session);
  const cookieHeader = extractCookieValuePair(setCookie);

  return {
    setCookie,
    cookieHeader,
    headers: { Cookie: cookieHeader },
    storage,
    session,
    userId,
  };
}

/**
 * Given a Set-Cookie string, return the `name=value` segment suitable for
 * an outgoing `Cookie` request header. Attribute fields (Path, Max-Age,
 * HttpOnly, SameSite, ...) are stripped.
 *
 * The value MUST NOT be URL-decoded — the server-side cookie parser expects
 * the same encoding that was produced by `commitSession`.
 *
 * Exported so tests that build their own Set-Cookie (custom storage) can
 * share the parsing logic.
 */
export function extractCookieValuePair(setCookie: string): string {
  const end = setCookie.indexOf(";");
  return end === -1 ? setCookie : setCookie.slice(0, end);
}

/**
 * Read the session that `storage.getSession()` would yield for the given
 * `Cookie:` header. Useful in tests that install their own middleware and
 * want to assert what the handler would see.
 *
 * Thin wrapper that constructs a throwaway `Request` (the form the
 * production `CookieManager` expects) and delegates to `getSession` —
 * so tests never have to thread the plumbing themselves.
 */
export async function readSession(
  storage: SessionStorage,
  cookieHeader: string,
): Promise<Session> {
  const request = new Request("http://localhost/__testing/readSession", {
    headers: { cookie: cookieHeader },
  });
  const cookies = new CookieManager(request);
  return storage.getSession(cookies);
}
