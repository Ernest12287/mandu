---
name: mandu-phase-auth
version: 1.0.0
audience: AI Agents working on authentication, CSRF, or sessions
last_verified: 2026-04-18
---

# Authentication / Session / CSRF Prompt

Mandu Phase 2 shipped a first-class auth module — use it instead of
rolling your own JWT or cookie code.

## Password Hashing

```typescript
import { hashPassword, verifyPassword } from "@mandujs/core/auth";

const hash = await hashPassword("user-secret");       // argon2id via Bun.password
const ok   = await verifyPassword("user-secret", hash);
```

- Never store plain-text passwords.
- Never export or log hashes.

## Login / Logout

```typescript
import { loginUser, logoutUser, currentUserId, loggedAt } from "@mandujs/core/auth";

// In a filling chain:
.post(async (ctx) => {
  const { email, password } = await ctx.body<{ email: string; password: string }>();
  const user = await verifyCredentials(email, password);
  if (!user) return ctx.error(401, "Invalid credentials");
  await loginUser(ctx, user.id);   // handles session + Set-Cookie ordering
  return ctx.ok({ user });
})
```

- `loginUser(ctx, userId)` handles the subtle Set-Cookie ordering — call
  it BEFORE creating the final response.
- `logoutUser(ctx)` clears the session cookie.
- `currentUserId(ctx)` reads the current session user.

## CSRF

```typescript
import { csrf } from "@mandujs/core/middleware/csrf";

export default Mandu.filling()
  .use(csrf({ mode: "double-submit" }))
  .post(handler);
```

- Double-submit uses a signed cookie + header pair.
- Tokens are HMAC-SHA256 by default, or Bun.CSRF when available.
- Forms: include `<input type="hidden" name="_csrf" value={token} />`.

## Sessions

```typescript
import { session } from "@mandujs/core/middleware/session";

export default Mandu.filling()
  .use(session({ storage: memoryStore() }))
  .get((ctx) => ctx.ok({ user: ctx.session.get("user") }));
```

- `ctx.session.set/get/delete` — marks session as dirty.
- `ctx.session.clear()` — reset.
- Session persistence via `SessionStorage` interface — memory / bun:sqlite / redis.

## Known Gotchas

- **Set-Cookie ordering**: If a middleware sets a cookie AND the handler
  mutates the session, ensure the final response includes both. Use
  `ctx.cookies.appendRawSetCookie(...)` for advanced escapes.
- **Layout-injected cookies** are currently NOT propagated to the
  response (known issue — use middleware or route handler instead).
- **Loader `redirect()`** is not supported — use meta-refresh shell as
  a workaround.

## Checklist Before Shipping Auth Code

- [ ] Passwords hashed with `hashPassword` (argon2id).
- [ ] CSRF middleware on all state-changing POST/PATCH/DELETE routes.
- [ ] Session cookie has `httpOnly`, `sameSite: "lax"`, `secure` in prod.
- [ ] `mandu guard arch` passes.
- [ ] Integration tests cover login → access protected route → logout.
