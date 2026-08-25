# Bun 1.4 migration

Mandu requires Bun `>=1.4.0`. The repository, generated projects, CI jobs,
standalone binaries, and official container images are pinned to `1.4.0`.

## Upgrade a Mandu project

1. Install Bun 1.4 and confirm the active binary:

   ```bash
   bun upgrade
   bun --version
   ```

2. Align the project contract:

   ```json
   {
     "packageManager": "bun@1.4.0",
     "engines": { "bun": ">=1.4.0" },
     "devDependencies": { "@types/bun": "^1.4.0" }
   }
   ```

   Use `"types": ["bun"]` in `tsconfig.json`; do not depend on the deprecated
   `bun-types` package directly.

3. Refresh and verify dependencies:

   ```bash
   bun install
   bun install --frozen-lockfile
   bun run typecheck
   bun test
   bun run build
   ```

Existing text lockfiles remain readable by Bun 1.4. Commit the lockfile emitted
by the package manager and do not edit its version or integrity fields by hand.

## Mandu compatibility decisions

- Bun 1.4 interprets in-process cron schedules in the process's local timezone.
  Mandu explicitly passes `UTC` when `timezone` is omitted, preserving the Bun
  1.3 behavior and matching Workers cron. Set an IANA timezone on the job when
  local civil time is intended.
- Bun 1.4 on Windows can temporarily retain handles to `Bun.build()` output.
  Mandu retries the atomic directory move, then uses a validated copy before
  changing the active-generation pointer. A partial copy is never published.
- The publish gate compares every workspace manifest and catalog directly with
  the text lockfile on Windows because nested Bun 1.4 package-manager processes
  can stall there. Non-Windows release environments additionally retain Bun's
  native frozen-lockfile check.
- Mandu keeps the isolated workspace linker explicit in `bunfig.toml`, so Bun
  1.4's workspace linker default does not change dependency visibility.
- Bun 1.4 enforces Argon2's minimum `memoryCost` of 8. Mandu validates that
  boundary before calling the runtime and reports a configuration error instead
  of exposing Bun's lower-level failure.
- Cookie names are decoded consistently across Bun 1.3 and 1.4, preserving
  Mandu's cookie-codec behavior when a name contains percent-encoded bytes.
- The optional `webview-bun` desktop peer remains runtime-loaded, preventing
  its source-only FFI declarations from leaking into Bun 1.4 application
  type-checks.
- Reference-app verification bounds server shutdown and uses a Windows process
  tree fallback when Bun 1.4 does not finish closing a killed subprocess or its
  inherited output handles.
- CLI tests use Bun 1.4's file-level test parallelism with two workers. The
  bounded worker count keeps cross-platform resource use predictable while
  preserving `--randomize` coverage in CI. Core and MCP tests remain on their
  existing execution paths because they include intentional isolation or
  shared-state constraints.

Review the upstream [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4) for
application-specific changes such as strict TOML parsing, local cron defaults,
MySQL date decoding, stricter Request/Response cloning, and compiled-binary
configuration loading.

## Release verification

Before publishing, run:

```bash
bun run typecheck:product
bun run test:product
bun run check:product-release
bun run mandu agent verify --changed --json --write
```
