/**
 * OAuth 2.0 Authorization-Code + PKCE Middleware
 *
 * Single middleware that owns two request paths:
 *
 *   1. `/auth/:provider`          — initiates the OAuth flow by redirecting to
 *                                   the provider's authorization endpoint with
 *                                   a freshly generated `state` (and optional
 *                                   PKCE `code_challenge`) stashed in session.
 *   2. `/auth/:provider/callback` — completes the flow: verifies `state`,
 *                                   exchanges `code` for an access token,
 *                                   fetches userinfo, delegates to the
 *                                   caller's `resolveUser`, and finally calls
 *                                   `loginUser(ctx, userId)`.
 *
 * All other paths pass through unchanged (middleware returns `void`).
 *
 * Session dependency: the state/nonce for each in-flight auth is stored in
 * the session under `oauth:pending`. Install {@link session} upstream — we
 * throw a clear error when it is missing rather than silently failing.
 *
 * @example
 * ```ts
 * import { oauth, github, session } from "@mandujs/core/middleware";
 *
 * export default Mandu.filling()
 *   .use(session({ storage }))
 *   .use(oauth({
 *     provider: github(),
 *     clientId: process.env.GITHUB_CLIENT_ID!,
 *     clientSecret: process.env.GITHUB_CLIENT_SECRET!,
 *     redirectUri: "https://example.com/auth/github/callback",
 *     resolveUser: async (profile) => {
 *       const user = await db.users.upsertByOAuth("github", profile.id, {
 *         email: profile.email,
 *         name: profile.name,
 *       });
 *       return user.id;
 *     },
 *   }));
 * ```
 *
 * @module middleware/oauth
 */

import type { ManduContext } from "../../filling/context";
import type { Session } from "../../filling/session";
import { AuthenticationError } from "../../filling/auth";
import { saveSession } from "../session";
import { loginUser } from "../../auth/login";
import { newId } from "../../id";

// ========== Public Types ==========

/**
 * Provider preset describing the OAuth endpoints, default scopes, and profile
 * normalizer. Ship custom presets by constructing this struct directly.
 */
export interface OAuthProvider {
  /** Short identifier (e.g. `"github"`, `"google"`). Appears in the path and in the pending-state record. */
  name: string;
  /** Provider-side authorization URL the user is redirected to. */
  authorizationEndpoint: string;
  /** Provider-side token endpoint the middleware POSTs to for the code-for-token exchange. */
  tokenEndpoint: string;
  /** Provider-side userinfo endpoint the middleware GETs after obtaining an access token. */
  userinfoEndpoint: string;
  /** Default scopes requested when `options.scopes` is not supplied. */
  scopes: string[];
  /** Maps the raw userinfo JSON into Mandu's {@link OAuthProfile} shape. */
  normalizeProfile: (raw: unknown) => OAuthProfile;
  /** Enable PKCE (default: `true`). Both GitHub and Google support it. */
  pkce?: boolean;
}

/** Normalized profile produced by `provider.normalizeProfile`. */
export interface OAuthProfile {
  /** Provider-scoped user id. Always a string — presets coerce numeric IDs. */
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  /** Raw provider JSON — preserved for app-specific extraction beyond the common fields. */
  raw: unknown;
}

export interface OAuthOptions {
  /** Provider preset or custom {@link OAuthProvider}. */
  provider: OAuthProvider;
  /** OAuth app `client_id`. Public. */
  clientId: string;
  /** OAuth app `client_secret`. Treated as sensitive — never echoed to the user. */
  clientSecret: string;
  /** Absolute URL the user is redirected to after authorization. Must match the value registered with the provider. */
  redirectUri: string;
  /** Optional override for `provider.scopes`. */
  scopes?: string[];
  /**
   * Called after the provider returns a verified profile. Return either:
   *   - a local user id (`string`) → middleware calls `loginUser(ctx, id)` then redirects to `postLoginRedirect`
   *   - a full `Response`        → bubbled up unchanged (e.g. redirect to /signup for unknown users)
   */
  resolveUser: (profile: OAuthProfile, ctx: ManduContext) => Promise<string | Response>;
  /**
   * Paths owned by this middleware. Defaults:
   *   `{ start: "/auth/:provider", callback: "/auth/:provider/callback" }`
   *
   * The `:provider` placeholder is replaced with `provider.name` at factory time.
   */
  paths?: { start?: string; callback?: string };
  /** Where to redirect after a successful login. Default: `"/"`. */
  postLoginRedirect?: string;
}

/** Middleware signature shared with `csrf.ts` / `session.ts`. */
type Middleware = (ctx: ManduContext) => Promise<Response | void>;

/**
 * Fetch seam. Tests inject a recorder; production uses `globalThis.fetch`.
 * Kept as an internal type so only {@link _oauthWith} exposes it.
 */
type FetchFn = typeof globalThis.fetch;

// ========== Constants ==========

const SESSION_PENDING_KEY = "oauth:pending";
const DEFAULT_START_PATH = "/auth/:provider";
const DEFAULT_CALLBACK_PATH = "/auth/:provider/callback";
const DEFAULT_POST_LOGIN_REDIRECT = "/";
/** Guard against oversized state values coming back from providers. */
const MAX_STATE_LENGTH = 256;

// ========== Shape of the pending state record we stash in session ==========

interface OAuthPending {
  state: string;
  codeVerifier: string | null;
  provider: string;
}

// ========== Public Factory ==========

/**
 * Construct an OAuth middleware bound to `globalThis.fetch`.
 *
 * See {@link _oauthWith} for the testable variant that accepts an injected
 * fetch implementation — tests use it to record/mock provider HTTP round-trips
 * without hitting the network.
 */
export function oauth(options: OAuthOptions): Middleware {
  return _oauthWith(globalThis.fetch.bind(globalThis), options);
}

/**
 * Testing seam — identical behavior to {@link oauth} except the HTTP client is
 * injected. Exported under an underscore prefix to signal "public API for
 * tests only"; not part of the framework's semver surface.
 *
 * @internal
 */
export function _oauthWith(fetchImpl: FetchFn, options: OAuthOptions): Middleware {
  validateOptions(options);

  const startPath = resolveOwnedPath(
    options.paths?.start ?? DEFAULT_START_PATH,
    options.provider.name,
  );
  const callbackPath = resolveOwnedPath(
    options.paths?.callback ?? DEFAULT_CALLBACK_PATH,
    options.provider.name,
  );
  const pkceEnabled = options.provider.pkce ?? true;
  const scopes = options.scopes ?? options.provider.scopes;
  const postLoginRedirect = options.postLoginRedirect ?? DEFAULT_POST_LOGIN_REDIRECT;

  return async (ctx: ManduContext): Promise<Response | void> => {
    const url = new URL(ctx.request.url);
    const pathname = url.pathname;

    if (pathname === startPath) {
      return handleStart(ctx, {
        provider: options.provider,
        clientId: options.clientId,
        redirectUri: options.redirectUri,
        scopes,
        pkceEnabled,
      });
    }

    if (pathname === callbackPath) {
      return handleCallback(ctx, url, {
        fetchImpl,
        provider: options.provider,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        redirectUri: options.redirectUri,
        pkceEnabled,
        resolveUser: options.resolveUser,
        postLoginRedirect,
      });
    }

    // Any other path: pass through. Other middleware / handlers will take over.
    return;
  };
}

// ========== Start Flow ==========

interface StartParams {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  pkceEnabled: boolean;
}

async function handleStart(ctx: ManduContext, params: StartParams): Promise<Response> {
  const session = requireSession(ctx);

  // 1. Generate state + optional PKCE pair.
  const state = newId();
  const codeVerifier = params.pkceEnabled ? generateCodeVerifier() : null;
  const codeChallenge = codeVerifier ? await sha256Base64Url(codeVerifier) : null;

  // 2. Stash { state, codeVerifier, provider } under "oauth:pending" so the
  //    callback can later verify and consume it. Storing `codeVerifier` in
  //    session (server-signed cookie) never exposes it to the browser URL.
  const pending: OAuthPending = {
    state,
    codeVerifier,
    provider: params.provider.name,
  };
  session.set(SESSION_PENDING_KEY, pending);

  // 3. Commit the session BEFORE building the redirect Response so the
  //    Set-Cookie lands on this response. (Redirects snapshot cookies at
  //    build time — same ordering hazard as loginUser.)
  await saveSession(ctx);

  // 4. Build authorization URL and redirect.
  const authUrl = new URL(params.provider.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", params.clientId);
  authUrl.searchParams.set("redirect_uri", params.redirectUri);
  authUrl.searchParams.set("scope", params.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  if (codeChallenge) {
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
  }

  return ctx.redirect(authUrl.toString());
}

// ========== Callback Flow ==========

interface CallbackParams {
  fetchImpl: FetchFn;
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  pkceEnabled: boolean;
  resolveUser: OAuthOptions["resolveUser"];
  postLoginRedirect: string;
}

async function handleCallback(
  ctx: ManduContext,
  url: URL,
  params: CallbackParams,
): Promise<Response> {
  const session = requireSession(ctx);

  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  // Pull pending state regardless of later outcome so a failed callback can't
  // be retried against the same captured state (replay defense).
  const pending = session.get<OAuthPending>(SESSION_PENDING_KEY) ?? null;
  if (pending) {
    session.unset(SESSION_PENDING_KEY);
    // Flush the session so the cleared pending record persists even if this
    // callback ultimately returns 403 — without this, a second callback hit
    // would still see the pending record and succeed on a replayed state.
    await saveSession(ctx);
  }

  if (
    !pending ||
    pending.provider !== params.provider.name ||
    typeof returnedState !== "string" ||
    returnedState.length === 0 ||
    returnedState.length > MAX_STATE_LENGTH ||
    typeof pending.state !== "string" ||
    !safeEqual(returnedState, pending.state)
  ) {
    return ctx.forbidden("OAuth state mismatch");
  }

  if (typeof code !== "string" || code.length === 0) {
    return ctx.forbidden("OAuth state mismatch");
  }

  // --- Token exchange ---
  let accessToken: string;
  try {
    accessToken = await exchangeCode(params, code, pending.codeVerifier);
  } catch {
    return ctx.json(
      { error: "oauth_failed", provider: params.provider.name },
      502,
    );
  }

  // --- Userinfo ---
  let rawProfile: unknown;
  try {
    rawProfile = await fetchUserinfo(params, accessToken);
  } catch {
    return ctx.json(
      { error: "oauth_failed", provider: params.provider.name },
      502,
    );
  }

  // --- Normalize + delegate to caller ---
  const profile = params.provider.normalizeProfile(rawProfile);
  const resolved = await params.resolveUser(profile, ctx);

  if (resolved instanceof Response) {
    // Caller took control (e.g. redirect to /signup). Bubble up unchanged —
    // they did NOT opt into loginUser, so we honor that.
    return resolved;
  }

  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new AuthenticationError(
      "OAuth resolveUser must return a non-empty user id string or a Response",
    );
  }

  await loginUser(ctx, resolved);
  return ctx.redirect(params.postLoginRedirect);
}

// ========== Token exchange helpers ==========

async function exchangeCode(
  params: CallbackParams,
  code: string,
  codeVerifier: string | null,
): Promise<string> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", params.redirectUri);
  body.set("client_id", params.clientId);
  body.set("client_secret", params.clientSecret);
  if (params.pkceEnabled && codeVerifier) {
    body.set("code_verifier", codeVerifier);
  }

  // `Accept: application/json` asks GitHub to return JSON instead of its
  // default urlencoded response. Google + most modern providers already
  // default to JSON — the extra header is harmless for them.
  const response = await params.fetchImpl(params.provider.tokenEndpoint, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`token endpoint returned ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const token = extractAccessToken(payload);
  if (!token) {
    throw new Error("token endpoint returned no access_token");
  }
  return token;
}

async function fetchUserinfo(params: CallbackParams, accessToken: string): Promise<unknown> {
  const response = await params.fetchImpl(params.provider.userinfoEndpoint, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      // GitHub requires a User-Agent — harmless for other providers.
      "User-Agent": "mandu-oauth-middleware",
    },
  });

  if (!response.ok) {
    throw new Error(`userinfo endpoint returned ${response.status}`);
  }

  return (await response.json()) as unknown;
}

function extractAccessToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  const token = rec["access_token"];
  return typeof token === "string" && token.length > 0 ? token : null;
}

// ========== Internal utilities ==========

function validateOptions(options: OAuthOptions): void {
  if (!options || typeof options !== "object") {
    throw new Error("[Mandu OAuth] options is required");
  }
  if (!options.provider || typeof options.provider !== "object") {
    throw new Error("[Mandu OAuth] `provider` is required");
  }
  if (typeof options.provider.name !== "string" || options.provider.name.length === 0) {
    throw new Error("[Mandu OAuth] `provider.name` must be a non-empty string");
  }
  if (typeof options.clientId !== "string" || options.clientId.length === 0) {
    throw new Error("[Mandu OAuth] `clientId` must be a non-empty string");
  }
  if (typeof options.clientSecret !== "string" || options.clientSecret.length === 0) {
    throw new Error("[Mandu OAuth] `clientSecret` must be a non-empty string");
  }
  if (typeof options.redirectUri !== "string" || options.redirectUri.length === 0) {
    throw new Error("[Mandu OAuth] `redirectUri` must be a non-empty string");
  }
  if (typeof options.resolveUser !== "function") {
    throw new Error("[Mandu OAuth] `resolveUser` must be a function");
  }
}

/**
 * Replace a `:provider` placeholder in the configured path with the actual
 * provider name. We do NOT try to reuse the router — middleware runs inline
 * for every request, so path matching here is simple string equality.
 */
function resolveOwnedPath(template: string, providerName: string): string {
  return template.replace(/:provider\b/g, providerName);
}

/** Require an installed session or throw a 500-class wiring error. */
function requireSession(ctx: ManduContext): Session {
  const session = ctx.get<Session>("session");
  if (!session) {
    throw new AuthenticationError(
      "OAuth middleware requires session middleware upstream — add `.use(session({ storage }))` before `.use(oauth(...))`.",
    );
  }
  return session;
}

/**
 * Constant-time comparison shared with {@link "../csrf".safeEqual}. Kept as a
 * local copy (rather than importing) to avoid creating a public export from
 * csrf.ts just for this — the logic is four lines and identical behavior.
 *
 * IMPORTANT: we still return `false` on length mismatch because our state
 * values are fixed-format UUIDs; the length itself is not secret.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * RFC 7636 §4.1 code_verifier: 43-128 character high-entropy string. We emit
 * the 43-character lower bound (32 random bytes → 43 base64url chars) which
 * is well above the RFC's 256-bit entropy minimum.
 */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** RFC 7636 §4.2 S256: BASE64URL(SHA-256(ASCII(code_verifier))). */
async function sha256Base64Url(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ========== Provider presets ==========

export { github, google } from "./providers";
