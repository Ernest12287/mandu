---
"@mandujs/core": minor
"@mandujs/cli": patch
---

fix(core,cli): #223 dual-stack default + #225 truthful startup banner

**#223 — Default `server.hostname` is now `"::"` (IPv6 wildcard,
dual-stack) instead of `"0.0.0.0"` (IPv4-only).** Bun leaves
`IPV6_V6ONLY` off, so a single socket accepts both IPv4 (as
IPv4-mapped IPv6) and IPv6 clients — effectively covering what users
expected `"0.0.0.0"` to do. This silently fixes the Windows trap where
Node 17+ `fetch("http://localhost:PORT")` resolves `localhost` to
`::1` first and hit `ECONNREFUSED ::1:PORT` against an IPv4-only
bind. `curl` and browsers silently fell back to IPv4, hiding the bug
until a Node client (Playwright test runner, ATE-generated specs)
tried to reach the server.

Explicit `"0.0.0.0"` is still honored — users who need IPv4-only
binds for container/firewall reasons keep that option. On Windows
only, Mandu emits a one-line warning so the IPv6-localhost trap is
discoverable:

```
⚠️  hostname="0.0.0.0" binds IPv4 only; Node fetch('localhost:PORT')
   may fail on Windows (prefers ::1). Consider hostname="::" for
   dual-stack.
```

**#225 — The startup banner no longer lies about reachability.** The
old code unconditionally printed

```
🥟 Mandu server listening at http://localhost:3333
   (also reachable at http://127.0.0.1:3333, http://[::1]:3333)
```

regardless of the actual bind address. When bound to `"0.0.0.0"` the
`[::1]` URL never answered. The new `reachableHosts(hostname)` helper
(exported from `@mandujs/core`) derives the URL list deterministically
from the bind address:

- `"0.0.0.0"` → `["127.0.0.1"]` only.
- `"::"` / `"::0"` / `"[::]"` / `"0:0:0:0:0:0:0:0"` →
  `["127.0.0.1", "[::1]"]`.
- `"::1"` / `"127.0.0.1"` / a specific IP → just that address.
- DNS name → just that name.

`formatServerAddresses()` consumes `reachableHosts()` so both the
`startServer` banner and the `mandu start` / `mandu dev` CLI banners
only promise addresses that actually answer.

No new dependencies. Docker setups that pin `hostname: "0.0.0.0"`
(explicit) are not silently upgraded.
