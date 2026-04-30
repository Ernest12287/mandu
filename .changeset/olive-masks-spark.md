---
"@mandujs/core": patch
---

Fix resource DB generation and migration edge cases: generated repos now insert caller-supplied primary keys unless the key has a DB default, indexed added columns emit their auto index, and concurrent migration apply re-checks history after acquiring the lock while serializing same-process MySQL lock attempts.
