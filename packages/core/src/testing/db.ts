/**
 * @mandujs/core/testing/db
 *
 * In-memory / file-backed SQLite fixture for integration tests.
 *
 * Wraps `@mandujs/core/db` so callers do not have to learn Bun.SQL's URL
 * conventions just to stand up a throwaway database. The default is
 * `sqlite::memory:` — fully isolated, survives exactly one test, zero
 * filesystem footprint.
 *
 * ```ts
 * import { createTestDb } from "@mandujs/core/testing";
 *
 * const db = await createTestDb({
 *   schema: `
 *     CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
 *     CREATE INDEX users_email ON users(email);
 *   `,
 * });
 * afterEach(async () => await db.close());
 *
 * await db.db`INSERT INTO users (id, email) VALUES (${"u1"}, ${"a@b.c"})`;
 * const rows = await db.db<{ id: string; email: string }>`SELECT * FROM users`;
 * expect(rows).toHaveLength(1);
 * ```
 *
 * ## Design
 *
 * - **Isolation first**: each call to `createTestDb()` returns a fresh
 *   `Db` handle. SQLite in-memory dbs are scoped to the connection, so
 *   there is no cross-fixture leakage.
 * - **DDL delivered as plain SQL**: callers pass schema as a string (or an
 *   array of statements). No dependency on the resource migration runner —
 *   that's a Phase 12.3 concern.
 * - **Transaction helper**: `transaction(fn)` is just a re-export of the
 *   underlying `Db.transaction` — convenient to avoid threading `db.db.*`.
 * - **Async-dispose**: `using db = await createTestDb(...)` works via
 *   `Symbol.asyncDispose` (ES2023 Explicit Resource Management). Pair with
 *   Bun.test's per-test cleanup for maximum terseness.
 *
 * ## SQLite caveats
 *
 * Bun.SQL's SQLite adapter requires non-null columns to be typed.
 * Tests that want rich schemas should use `TEXT`, `INTEGER`, `REAL`,
 * `BLOB`. Higher-level typed schemas come with the Phase 12.3 resource
 * migration fixture.
 *
 * @module testing/db
 */

import { createDb, type Db } from "../db/index";

/** Options for {@link createTestDb}. */
export interface CreateTestDbOptions {
  /**
   * Connection URL. Default: `"sqlite::memory:"`.
   *
   * Any `sqlite:` URL is accepted — `sqlite:./fixture.db` for a file-backed
   * fixture that survives across fixture instances, for example. Non-sqlite
   * providers are accepted but not recommended for unit tests (you lose
   * isolation across fixtures).
   */
  url?: string;
  /**
   * DDL to apply on open. Accepts a multi-statement SQL string or an array
   * of pre-split statements. Statements are run sequentially — if any
   * fails, subsequent ones are skipped and the error re-throws.
   */
  schema?: string | string[];
  /** Optional seed block to run after `schema` — convenient for row-level setup. */
  seed?: (db: Db) => Promise<void> | void;
}

/** Handle returned by {@link createTestDb}. */
export interface TestDb {
  /** The underlying Db handle — use as a tagged-template query function. */
  readonly db: Db;
  /** Re-export of `db.transaction`. */
  transaction: Db["transaction"];
  /**
   * Apply additional DDL after the fixture has been created. Useful when the
   * schema depends on per-test parameters (e.g., random suffixes to avoid
   * SQLite's reserved-words).
   */
  apply(ddl: string | string[]): Promise<void>;
  /** Idempotent cleanup — safe to call multiple times. */
  close(): Promise<void>;
  /** `using db = await createTestDb(...)` support. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Split a multi-statement SQL string into individual statements. */
function splitSql(source: string): string[] {
  // Naïve splitter: works for vanilla DDL without embedded `;` inside quoted
  // strings — the realistic shape of test fixtures. A full lexer lives in
  // `db/migrations/runner.ts`; we intentionally do not re-use it here to
  // avoid coupling the testing fixture to migration-runner internals.
  return source
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyDdl(db: Db, ddl: string | string[]): Promise<void> {
  const statements = Array.isArray(ddl) ? ddl : splitSql(ddl);
  for (const stmt of statements) {
    // Bun.SQL's tagged-template form does not support raw DDL composition —
    // but a 1-argument template with no placeholders is safe. The value
    // inside `strings.raw[0]` is the literal SQL, never an interpolated value.
    const raw = stmt.trim();
    if (raw.length === 0) continue;
    const strings = Object.assign([raw], { raw: [raw] }) as TemplateStringsArray;
    await db(strings);
  }
}

/**
 * Boot a fixture-scoped database handle.
 *
 * The default URL (`sqlite::memory:`) creates a per-connection in-memory
 * database — ideal for per-test isolation.
 *
 * @throws if `url` is non-empty but Bun.SQL rejects it on the first query.
 *   Validation is lazy — construction never throws on unreachable targets.
 */
export async function createTestDb(
  options: CreateTestDbOptions = {},
): Promise<TestDb> {
  const url = options.url ?? "sqlite::memory:";
  const db = createDb({ url });

  if (options.schema !== undefined) {
    await applyDdl(db, options.schema);
  }
  if (options.seed) {
    await options.seed(db);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await db.close();
  };

  return {
    db,
    transaction: db.transaction.bind(db),
    async apply(ddl) {
      await applyDdl(db, ddl);
    },
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}
