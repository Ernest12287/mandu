---
"@mandujs/cli": minor
---

feat(cli/deploy): render.com adapter

Seventh deploy adapter. Generates a render.yaml Blueprint matching
the layout in mcp/resources/skills/mandu-deployment/rules/
deploy-platform-render.md — curl-installs Bun inside Render's node
runtime, pipes PORT via fromService, surfaces user env vars as
sync:false entries for dashboard config.

Scope — web service + optional Postgres database block. Redis and
worker services deferred. No API-key workflow yet; users push to Git
and Render picks up the Blueprint.

`mandu deploy --target=render` wires through the same adapter
registry as fly/railway/vercel. 17 new tests.
