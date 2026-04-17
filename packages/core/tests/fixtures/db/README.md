# DB Fixtures — Postgres + MySQL

Backing services for the `@mandujs/core/db` integration suite
(`packages/core/tests/db/db-postgres.test.ts`,
`packages/core/tests/db/db-mysql.test.ts`).

SQLite tests don't need this fixture — they run in-process via `bun:sqlite`.

## What's inside

| Service  | Image                | Host port | User | Pass | DB       |
| -------- | -------------------- | --------- | ---- | ---- | -------- |
| Postgres | `postgres:16.4-alpine` | `5433`    | `test` | `test` | `testdb` |
| MySQL    | `mysql:8.4.3`          | `3307`    | `test` | `test` | `testdb` |

Non-default ports (5433, 3307) are intentional — they avoid clashing with
a system-installed Postgres/MySQL on 5432/3306.

Credentials are **dev-fixture only**. Do not copy them into any real
environment.

## Start

```bash
docker compose -f packages/core/tests/fixtures/db/docker-compose.yml up -d
```

The first boot takes ~20 s for MySQL to complete its initial schema. Compose
will exit as soon as containers are created; use the ps command below to
wait for `healthy`.

```bash
docker compose -f packages/core/tests/fixtures/db/docker-compose.yml ps
# STATUS should read `healthy` for both services before running tests.
```

## Run integration tests

```bash
export DB_TEST_POSTGRES_URL=postgres://test:test@localhost:5433/testdb
export DB_TEST_MYSQL_URL=mysql://test:test@localhost:3307/testdb

bun test packages/core/tests/db
```

With those env vars **unset**, the suite self-skips — see the gate comment
at the top of each test file.

## Inspect

```bash
# Postgres psql
docker compose -f packages/core/tests/fixtures/db/docker-compose.yml exec postgres \
  psql -U test -d testdb

# MySQL client
docker compose -f packages/core/tests/fixtures/db/docker-compose.yml exec mysql \
  mysql -utest -ptest testdb
```

## Tear down

```bash
# Stop containers, keep volumes — restart is fast, data survives.
docker compose -f packages/core/tests/fixtures/db/docker-compose.yml down

# Stop AND destroy volumes — back to a clean slate on next up.
docker compose -f packages/core/tests/fixtures/db/docker-compose.yml down -v
```

`down -v` is what CI uses, and is what you want when a test leaves schema
behind that's confusing the next run.

## Troubleshooting

**Port already allocated (5433 or 3307).** You have another instance of this
fixture running, or you customized the mapping. Run `docker ps` to find the
offender, then `docker stop <id>`.

**`psql: could not connect`.** The container is up but not yet healthy. Wait
a few seconds and re-check `docker compose ... ps` — Postgres typically hits
`healthy` within 5 s, MySQL within 20 s.

**Tests hang on connect.** The Bun SQL driver can stall indefinitely against
an unreachable host. Confirm the port is exposed:
`docker compose ... port postgres 5432`.

**Windows / WSL note.** If Docker Desktop on Windows maps the ports to a
non-localhost address, set `DB_TEST_POSTGRES_URL` / `DB_TEST_MYSQL_URL` to
the Docker host IP instead of `localhost`.

## Resource limits

Each container is capped at **512 MiB** (`deploy.resources.limits.memory`).
Postgres ships with `fsync=off` and MySQL with a reduced 64 MiB buffer pool
so the stack remains laptop-friendly. Don't mirror these settings in prod.
