---
"@mandujs/core": minor
"@mandujs/cli": minor
"@mandujs/mcp": minor
---

Require Bun 1.4 across the stable Mandu product packages, generated projects, CI, deployment artifacts, and container images. Preserve UTC as the default scheduler timezone despite Bun 1.4's new local-time default, make atomic client-build publication resilient to Windows build-output handle races, validate Windows lock consistency without a nested package-manager process, bound Windows reference-app subprocess shutdown, enforce Bun 1.4's Argon2 minimum memory cost with a clear configuration error, keep percent-encoded cookie names stable across runtime versions, isolate optional desktop peers from Bun 1.4 FFI type changes until runtime loading, and use bounded Bun 1.4 file-level parallelism for the CLI test suite.
