---
"@mandujs/core": minor
"@mandujs/cli": minor
---

feat(brain): delegate OpenAI login to `@openai/codex` — real OAuth flow works today

Earlier the OpenAI adapter shipped with placeholder OAuth endpoints
(`https://platform.openai.com/oauth/authorize` + a `mandu-brain-cli`
client id) that were never registered with OpenAI. Nobody could
actually sign in.

Fix — piggy-back on the OpenAI-official Codex CLI:

- `mandu brain login --provider=openai` now shells out to
  `npx @openai/codex login`. OpenAI handles the browser OAuth flow with
  its real app (`app_EMoamEEZ73f0CkXaXp7hrann`) and writes the token
  into `~/.codex/auth.json`. Mandu never has its own OAuth app.
- New `ChatGPTAuth` helper at `@mandujs/core` reads whatever auth.json
  `codex login` produced (`CHATGPT_LOCAL_HOME` / `CODEX_HOME` /
  `~/.chatgpt-local/auth.json` / `~/.codex/auth.json`, in order), auto-
  refreshes the access token against `auth.openai.com/oauth/token`
  5 minutes before JWT `exp`, and rewrites auth.json atomically with
  mode 0600.
- `OpenAIOAuthAdapter` now calls `ChatGPTAuth` first; the legacy
  keychain path is preserved as a fallback for enterprise OpenAI
  proxies that wire their own OAuth app.
- 401 from the Chat Completions endpoint triggers one `ChatGPTAuth
  .getAuth()` re-read (which refreshes if needed); persistent 401 on
  the ChatGPT path intentionally does NOT scrub auth.json (we must
  not race the user's codex session). The keychain fallback keeps its
  scrub-on-persistent-401 behavior.

Ported from the same pattern kakao-bot-sdk uses in
`src/auth/chatgpt.ts` — the approach is proven in production there.

8 new tests covering JWT parsing, expiry-driven refresh, missing-token
error shapes, and disk persistence.
