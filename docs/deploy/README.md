---
phase: 13.1
status: implemented
date: 2026-04-18
audience: end users + contributors adding new deploy targets
---

# `mandu deploy` — deployment adapters

`mandu deploy` is Mandu's single entry point for turning a
built project into the config files + pipeline each hosting
provider expects. Phase 13.1 ships seven adapters:

| Target | Invocation | Primary artifacts |
|---|---|---|
| Docker | `mandu deploy --target=docker` | `Dockerfile`, `.dockerignore` |
| Docker Compose | `mandu deploy --target=docker-compose` | `Dockerfile`, `docker-compose.yml`, `.env.example` |
| Fly.io | `mandu deploy --target=fly` | `Dockerfile`, `fly.toml` |
| Vercel | `mandu deploy --target=vercel` | `vercel.json`, `api/_mandu.ts` |
| Railway | `mandu deploy --target=railway` | `railway.json`, `nixpacks.toml` |
| Netlify | `mandu deploy --target=netlify` | `netlify.toml`, `netlify/functions/ssr.ts` |
| Cloudflare Pages | `mandu deploy --target=cf-pages` | `wrangler.toml`, `functions/_middleware.ts` |

## Pipeline

```
mandu deploy --target=<target> [flags]
  1. validate mandu.config            → fail fast on invalid config
  2. architecture guard               → skipped in --dry-run
  3. build                            → skipped in --dry-run
  4. adapter.check()                  → validate project + CLI toolchain
  5. adapter.prepare()                → emit artifacts (idempotent)
  6. adapter.deploy()                 → only when --execute is passed
```

## Flags

| Flag | Effect |
|---|---|
| `--target=<name>` | **Required.** Target platform (see table above). |
| `--env=<name>` | `production` (default), `staging`, `preview`. |
| `--project=<name>` | Override the project slug used by provider config. |
| `--dry-run` | Skip guard + build; run check + prepare only. |
| `--execute` | Invoke the provider CLI after prepare. |
| `--set-secret KEY=VALUE` | Store a secret in OS keychain (repeatable). |
| `--verbose` | Print extra diagnostics (secret values are always masked). |

## Secret handling

Mandu does **not** write secret values to any artifact file. The
primary secret store is [`Bun.secrets`] — a thin wrapper over the
OS keychain (macOS Keychain, Windows Credential Manager, Linux
libsecret). When `Bun.secrets` is unavailable (older Bun), Mandu
falls back to `.mandu/secrets.json` with `chmod 0600` and prints a
one-time warning.

```bash
# Store a secret for the Fly adapter.
mandu deploy --target=fly --set-secret FLY_API_TOKEN=fo1_...

# Later, execute the deploy. Missing required secrets abort the pipeline.
mandu deploy --target=fly --execute
```

Each adapter declares the secrets it needs. Running `mandu deploy
--target=<target> --dry-run` prints the adapter's secret inventory
with a present/absent marker for every required and optional
secret.

[`Bun.secrets`]: https://bun.com/docs/runtime/secrets

## Adapter capability matrix

| Target | `check` | `prepare` | `deploy()` (via `--execute`) | Notes |
|---|:---:|:---:|:---:|---|
| docker | yes | yes | no | Artifact-only — users run `docker build`/`push` themselves. |
| docker-compose | yes | yes | no | Scaffolds Postgres sidecar by default (Phase 4c DB integration). |
| fly | yes | yes | harness¹ | `flyctl` must be installed for `--execute`. |
| vercel | yes | yes | harness¹ | `vercel` CLI must be installed for `--execute`. |
| railway | yes | yes | harness¹ | `railway` CLI must be installed for `--execute`. |
| netlify | yes | yes | harness¹ | Node Functions (Edge Functions deferred to Phase 15.3). |
| cf-pages | yes | yes | harness¹ | Artifact-only in Phase 13 — runtime compat via Phase 15. |

¹ "harness" — the adapter exposes a `deploy()` primitive that a
hosting CI pipeline (or an integration test) can invoke via the
`DeployAdapter.deployImpl` injection point. Out of the box the
default returns a structured `CLI_E214 (not-implemented)` so the
user is nudged to run the provider CLI manually after `prepare`.

## Minimum provider CLI versions

| Target | Binary | Minimum version |
|---|---|---|
| fly | `flyctl` | 0.1.0 |
| vercel | `vercel` | 28.0.0 |
| railway | `railway` | 3.0.0 |
| netlify | `netlify` | 17.0.0 |
| cf-pages | `wrangler` | 3.0.0 |

`check()` only probes the provider CLI when `--execute` is set, so
`--dry-run` and the default prepare flow succeed even on clean CI
runners that don't have the CLI installed.

## Error codes

| Code | Meaning |
|---|---|
| `CLI_E200` | Unsupported target value. |
| `CLI_E201` | mandu.config invalid. |
| `CLI_E202` | Build failed during deploy. |
| `CLI_E203` | Architecture guard error count > 0. |
| `CLI_E204` | Artifact write failed (permission/disk). |
| `CLI_E205` | Required provider CLI is missing. |
| `CLI_E206` | Provider CLI is older than the required minimum. |
| `CLI_E207` | Required secret not present in the store. |
| `CLI_E208` | OS keychain unavailable + fallback disabled. |
| `CLI_E209` | `--set-secret` pair failed `KEY=VALUE` validation. |
| `CLI_E210` | Artifact refused write — secret value would leak. |
| `CLI_E211` | `--execute` required to invoke the provider CLI. |
| `CLI_E212` | Routes manifest not built. |
| `CLI_E213` | Edge-runtime compatibility warning (netlify / cf-pages). |
| `CLI_E214` | Adapter has no `deploy()` implementation. |

## Adding a new adapter

Adapters live in `packages/cli/src/commands/deploy/adapters/`.
Each adapter exports a `DeployAdapter` value conforming to
`packages/cli/src/commands/deploy/types.ts`:

```ts
export const myAdapter: DeployAdapter = {
  name: "MyProvider",
  target: "my-provider",        // must match types.ts union
  minimumCliVersion: null,
  secrets: [],
  async check(project, options) {...},
  async prepare(project, options) {...},
};
```

Register the adapter in `adapters/index.ts#createBuiltinRegistry`.
Tests go in `__tests__/adapters.test.ts` (mirror the structure of
the existing adapters: `check()` failure path + `prepare()` happy
path).

## Security invariants

1. **Secrets never touch artifact files.** The `writeArtifact`
   helper (see `artifact-writer.ts`) accepts a `forbiddenValues`
   map and throws `SecretLeakError` (`CLI_E210`) if the content
   includes any value verbatim.
2. **Secret values are never logged.** All log formatters route
   values through `maskSecret()` which returns a constant
   `"****"`.
3. **Provider tokens are sourced from env vars, not argv.** The
   adapter `deploy()` implementations read tokens from the
   environment so they don't surface in `ps` listings.
4. **Fallback-file path is mode-0600 + one-shot warning.** The
   plaintext-JSON fallback (`.mandu/secrets.json`) is only used
   when `Bun.secrets` is unavailable; it emits a single warning
   per process so the user is aware their secrets aren't
   encrypted at rest.
