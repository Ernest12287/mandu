/**
 * Provider presets for the OAuth middleware.
 *
 * Each factory returns a fresh {@link OAuthProvider} — callers should treat
 * the returned object as immutable, but constructing a new one per `oauth()`
 * invocation means mutations by one consumer never leak across another.
 *
 * Only GitHub and Google ship here. Twitter, Discord, Microsoft etc. are
 * user-contribution territory — the {@link OAuthProvider} shape is stable
 * and narrow on purpose.
 *
 * @module middleware/oauth/providers
 */

import type { OAuthProfile, OAuthProvider } from "./index";

// ========== GitHub ==========

/** Raw shape of `GET https://api.github.com/user`. Fields we consume + passthrough. */
interface GitHubRawUser {
  id: number | string;
  email?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  [key: string]: unknown;
}

/**
 * GitHub OAuth preset.
 *
 * Docs: https://docs.github.com/en/developers/apps/building-oauth-apps/authorizing-oauth-apps
 *
 * Notes:
 *   - The token endpoint defaults to urlencoded responses; the middleware
 *     sets `Accept: application/json` on the POST so we always parse JSON.
 *   - `user:email` scope covers the case where the user's primary email is
 *     private — without it, `raw.email` comes back as `null`.
 *   - PKCE is supported and enabled by default.
 */
export function github(): OAuthProvider {
  return {
    name: "github",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userinfoEndpoint: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    pkce: true,
    normalizeProfile: (raw: unknown): OAuthProfile => {
      if (!raw || typeof raw !== "object") {
        throw new Error("[Mandu OAuth/github] userinfo payload is not an object");
      }
      const r = raw as GitHubRawUser;
      if (r.id === undefined || r.id === null) {
        throw new Error("[Mandu OAuth/github] userinfo payload missing `id`");
      }
      return {
        id: String(r.id),
        email: typeof r.email === "string" ? r.email : undefined,
        name: typeof r.name === "string" ? r.name : undefined,
        avatarUrl: typeof r.avatar_url === "string" ? r.avatar_url : undefined,
        raw,
      };
    },
  };
}

// ========== Google ==========

/** Raw shape of Google's OIDC `userinfo` endpoint. */
interface GoogleRawUser {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  [key: string]: unknown;
}

/**
 * Google OAuth preset (OpenID Connect flavor).
 *
 * Docs: https://developers.google.com/identity/protocols/oauth2/openid-connect
 *
 * Notes:
 *   - Uses the static OIDC userinfo endpoint (no discovery at runtime).
 *   - `sub` is the stable provider-scoped user id; `email` may still change
 *     if the user renames their account, so consumers keying user records
 *     should prefer `profile.id` over `profile.email`.
 *   - PKCE is supported and enabled by default.
 */
export function google(): OAuthProvider {
  return {
    name: "google",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    pkce: true,
    normalizeProfile: (raw: unknown): OAuthProfile => {
      if (!raw || typeof raw !== "object") {
        throw new Error("[Mandu OAuth/google] userinfo payload is not an object");
      }
      const r = raw as GoogleRawUser;
      if (typeof r.sub !== "string" || r.sub.length === 0) {
        throw new Error("[Mandu OAuth/google] userinfo payload missing `sub`");
      }
      return {
        id: r.sub,
        email: typeof r.email === "string" ? r.email : undefined,
        name: typeof r.name === "string" ? r.name : undefined,
        avatarUrl: typeof r.picture === "string" ? r.picture : undefined,
        raw,
      };
    },
  };
}
