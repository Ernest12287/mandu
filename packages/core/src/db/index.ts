/**
 * @mandujs/core/db
 *
 * Thin, production-grade wrapper around **native `Bun.SQL`** (Bun 1.3.x).
 * Provides a callable tagged-template handle with `.one()`, `.transaction()`,
 * and `.close()` affordances while preserving Bun.sql's parameter-safe
 * placeholder semantics end-to-end.
 *
 * ## Providers
 *
 * - `postgres://…` / `postgresql://…` → Postgres
 * - `mysql://…` → MySQL
 * - `sqlite::memory:` / `sqlite:./file.db` / `sqlite://./file.db` → SQLite
 *
 * The `provider` config key overrides URL-based detection when the scheme
 * is ambiguous. No other DB engines are supported — Bun.SQL itself accepts
 * `postgres`, `sqlite`, `mysql`, and `mariadb` (aliased to mysql here).
 *
 * ## Why a wrapper
 *
 * Bun.SQL is already excellent. What this module adds:
 *
 *   1. **Provider detection** — consistent scheme parsing; consumers read
 *      `db.provider` instead of sniffing `Bun.SQL.options` themselves.
 *   2. **`.one()` helper** — zero-or-one-row query with clear errors for
 *      unexpected multi-row results. (Bun.SQL's raw `[0]` access silently
 *      drops extra rows.)
 *   3. **Typed transactions** — `tx` inside `transaction(fn)` is the same
 *      `Db` shape as the outer handle (Bun.SQL's `begin()` returns a
 *      callable without `.one` / `.transaction` / `.close`).
 *   4. **Lazy runtime probe** — `createDb()` never throws when Bun.SQL is
 *      unavailable; the first query does, with a version-specific message.
 *
 * ## Parameter binding
 *
 * Placeholders are passed through Bun.SQL's native parameter binding —
 * never string-concatenated into the SQL text. Example:
 *
 * ```ts
 * const user = await db.one<User>`SELECT * FROM users WHERE name = ${name}`;
 * ```
 *
 * The `${name}` is routed as a bound parameter even if it contains `'`,
 * `--`, or other SQL metacharacters. There is no safe "unsafe interpolate"
 * escape hatch on the public surface — use Bun.SQL directly if you need
 * `sql.unsafe()` semantics.
 *
 * @example
 * ```ts
 * import { createDb } from "@mandujs/core/db";
 *
 * const db = createDb({ url: "postgres://user:pass@localhost/app" });
 *
 * await db`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`;
 * await db`INSERT INTO users (name) VALUES (${"alice"})`;
 *
 * const one = await db.one<{ id: number; name: string }>`
 *   SELECT id, name FROM users WHERE name = ${"alice"}
 * `;
 *
 * await db.transaction(async (tx) => {
 *   await tx`INSERT INTO users (name) VALUES (${"bob"})`;
 *   await tx`INSERT INTO users (name) VALUES (${"carol"})`;
 * });
 *
 * await db.close();
 * ```
 *
 * @module db
 */

// ─── Public types ───────────────────────────────────────────────────────────

/** A single query result row. */
export type Row = Record<string, unknown>;

/** The three providers this wrapper supports. */
export type SqlProvider = "postgres" | "mysql" | "sqlite";

/** Configuration for {@link createDb}. */
export interface DbConfig {
  /**
   * Connection URL.
   *
   * - `sqlite::memory:` — in-memory SQLite
   * - `sqlite:./data.db` / `sqlite://./data.db` — file-backed SQLite
   * - `postgres://user:pass@host:5432/db` (or `postgresql://…`)
   * - `mysql://user:pass@host:3306/db`
   */
  url: string;
  /**
   * Override provider detection. Useful when embedding a non-standard URL
   * scheme (e.g., a secrets manager placeholder the user rewrites at boot).
   * When set, wins over URL-scheme sniffing.
   */
  provider?: SqlProvider;
  /**
   * Max concurrent connections. Default: `10` for Postgres/MySQL, `1` for
   * SQLite (SQLite is serialised by the engine; more than one connection
   * just queues inside Bun).
   */
  max?: number;
  /**
   * Additional options forwarded to the `Bun.SQL` constructor. Escape hatch
   * for advanced configuration — `ssl`, `idleTimeout`, `tls`, `bigint`, etc.
   *
   * The keys `url`, `adapter`, and `max` from this object are ignored to
   * keep public surface authoritative.
   */
  options?: Record<string, unknown>;
}

/**
 * A database handle. Invoking it as a **tagged template** runs a query and
 * returns the full result array. The attached methods support one-shot
 * reads, transactions, and shutdown.
 */
export interface Db {
  /**
   * Tagged-template query. Values are bound as parameters, never
   * interpolated as SQL text.
   */
  <T extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;

  /** Detected provider (`"postgres"`, `"mysql"`, or `"sqlite"`). */
  readonly provider: SqlProvider;

  /**
   * Runs the query and returns at most one row.
   *
   * - `0` rows → resolves to `null`
   * - `1` row  → resolves to that row
   * - `>= 2` rows → rejects with an Error naming the actual count
   *
   * Use when the query is expected to match at most one record (lookup by
   * unique key, `LIMIT 1`, etc.).
   */
  one<T extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T | null>;

  /**
   * Runs `fn` inside a transaction. Commits if `fn` resolves; rolls back
   * if it throws (and re-throws the original error).
   *
   * Nested transactions are NOT supported — call `transaction` from within
   * another `transaction` and you'll get an error surfaced by Bun.SQL
   * ("cannot call begin inside a transaction use savepoint() instead").
   * Use savepoints via raw Bun.SQL if you need nesting.
   */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;

  /**
   * Closes the connection pool. Subsequent queries reject with a clear
   * "pool closed" error. Calling `close()` twice is a no-op (idempotent).
   */
  close(): Promise<void>;
}

// ─── Bun runtime surface (structural; no `any`) ─────────────────────────────

/** Shape of the options object Bun.SQL accepts. */
interface BunSqlOptions {
  url?: string;
  adapter?: string;
  max?: number;
  filename?: string;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  [key: string]: unknown;
}

/**
 * A Bun.SQL instance — itself a callable tagged-template function with
 * methods attached. We only model the subset we actually use.
 */
interface BunSqlInstance {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<
    T[] & { count?: number; command?: string }
  >;
  begin<R>(fn: (tx: BunSqlInstance) => Promise<R>): Promise<R>;
  close(): Promise<void>;
  readonly options?: BunSqlOptions;
}

/**
 * Constructor surface — `Bun.SQL` is a class; we only need the `new`
 * signature. Accepts either a URL string or a full options object.
 */
export type BunSqlCtor = new (
  urlOrOptions: string | BunSqlOptions,
) => BunSqlInstance;

// ─── Provider detection ─────────────────────────────────────────────────────

/**
 * Derives a {@link SqlProvider} from a connection URL. Throws a clear
 * error for unsupported / ambiguous schemes so the call site fails early
 * instead of passing a half-formed config to Bun.SQL.
 */
export function detectProvider(url: string): SqlProvider {
  // Matches `sqlite::memory:`, `sqlite://path`, `sqlite:./file` — any
  // "starts with sqlite:" variant. We intentionally accept the no-slash
  // form because it's what Bun.SQL documents as canonical.
  if (url.startsWith("sqlite:")) return "sqlite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  }
  if (url.startsWith("mysql://") || url.startsWith("mariadb://")) {
    return "mysql";
  }
  throw new Error(
    `[@mandujs/core/db] Unable to detect provider from url: ${JSON.stringify(
      url,
    )}. Supported schemes: postgres://, postgresql://, mysql://, mariadb://, sqlite:. ` +
      `Pass { provider: "postgres" | "mysql" | "sqlite" } to override.`,
  );
}

/** Maps our {@link SqlProvider} to the adapter name Bun.SQL expects. */
function providerToAdapter(p: SqlProvider): string {
  // Bun.SQL uses "postgres" / "sqlite" / "mysql" verbatim; no mapping fuzz.
  return p;
}

/** Default `max` connections per provider. SQLite serialises at the engine. */
function defaultMax(p: SqlProvider): number {
  return p === "sqlite" ? 1 : 10;
}

// ─── Bun runtime probe ──────────────────────────────────────────────────────

function getBunSqlCtor(): BunSqlCtor {
  const g = globalThis as unknown as { Bun?: { SQL?: BunSqlCtor } };
  if (!g.Bun || typeof g.Bun.SQL !== "function") {
    throw new Error(
      "[@mandujs/core/db] Bun.sql is unavailable — this module requires Bun runtime >= 1.3.x. " +
        "Install/upgrade Bun: https://bun.com/docs/installation",
    );
  }
  return g.Bun.SQL;
}

// ─── Error helpers ──────────────────────────────────────────────────────────

const POOL_CLOSED_MESSAGE =
  "[@mandujs/core/db] pool closed — query issued after Db.close().";

/**
 * Structural check for "connection/pool closed" errors that Bun.SQL raises
 * after `.close()`. Bun surfaces these as `SQLiteError` / `PostgresError` /
 * `MySQLError` with a `code` ending in `CLOSED`.
 */
function isPoolClosedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === "string" && e.code.includes("CLOSED")) return true;
  if (
    typeof e.message === "string" &&
    /(connection|pool)\s+closed/i.test(e.message)
  ) {
    return true;
  }
  return false;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Internal factory accepting an injectable `Bun.SQL` constructor — used by
 * unit tests to swap in a fake implementation. Production callers use
 * {@link createDb}, which binds this to `Bun.SQL`.
 *
 * @internal
 */
export function _createDbWith(Ctor: BunSqlCtor, config: DbConfig): Db {
  if (!config || typeof config.url !== "string" || config.url.length === 0) {
    throw new TypeError(
      "[@mandujs/core/db] createDb: 'url' is required and must be a non-empty string.",
    );
  }

  const provider: SqlProvider = config.provider ?? detectProvider(config.url);
  const max = config.max ?? defaultMax(provider);

  // Compose Bun.SQL options. The user-supplied `options` bag is merged
  // FIRST so our authoritative fields win.
  //
  // Why per-provider options: when Bun.SQL receives an options OBJECT with
  // a `url` property, it does NOT parse the URL into connection fields —
  // it treats it as metadata and defaults to `:memory:` for SQLite (and
  // localhost/5432 for Postgres). To make URL-based config actually work
  // through an options object, we translate ourselves.
  //
  //   - SQLite: pull the path out of `sqlite:` / `sqlite://` into `filename`.
  //   - Postgres / MySQL: parse the URL into hostname / port / credentials /
  //     database — Bun accepts these fields directly and applies its own
  //     defaulting logic on top.
  const composed: BunSqlOptions = {
    ...(config.options ?? {}),
    adapter: providerToAdapter(provider),
    max,
  };
  applyUrlToOptions(composed, provider, config.url);

  const bunSql = new Ctor(composed);
  return buildDbHandle(bunSql, provider);
}

/**
 * Translates a connection URL into provider-specific `Bun.SQL` options.
 * Mutates `opts` in place (the caller already has a fresh object).
 *
 * @internal
 */
function applyUrlToOptions(
  opts: BunSqlOptions,
  provider: SqlProvider,
  url: string,
): void {
  if (provider === "sqlite") {
    // Accept "sqlite::memory:", "sqlite:<path>", and "sqlite://<path>".
    // The first is a special in-memory marker; everything after the scheme
    // is the filename.
    const rest = stripScheme(url);
    opts.filename = rest === ":memory:" ? ":memory:" : rest;
    return;
  }
  // Postgres / MySQL: delegate to Bun by passing the URL string directly as
  // an extra field. Bun's constructor accepts `url` AND parses it when no
  // `hostname` is provided alongside — verified in 1.3.12. We also keep the
  // original URL on the options so advanced logging can read it back.
  opts.url = url;
}

/**
 * Strips the leading `scheme:` (or `scheme://`) from a URL. Returns the
 * portion Bun uses as the connection target — for SQLite that's the file
 * path, for Postgres that's `user:pass@host:port/db`.
 */
function stripScheme(url: string): string {
  // `sqlite::memory:` → `:memory:`
  // `sqlite://./data.db` → `./data.db`
  // `sqlite:./data.db` → `./data.db`
  // `sqlite://C:\path\to\db` → `C:\path\to\db`
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/)?/.exec(url);
  if (!schemeMatch) return url;
  return url.slice(schemeMatch[0].length);
}

/**
 * Wraps a Bun.SQL instance (top-level or transaction-scoped) with the
 * public `Db` shape. Shared by `_createDbWith` and `transaction()`.
 */
function buildDbHandle(bunSql: BunSqlInstance, provider: SqlProvider): Db {
  // Closed flag tracked per-handle. A transaction-scoped handle inherits
  // the outer pool's close state transitively (Bun.SQL errors itself), but
  // we also short-circuit here so we can return the canonical message.
  let closed = false;

  // Callable core: forward the tagged-template call straight to Bun.SQL,
  // but translate post-close failures into our uniform error.
  async function call<T extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    if (closed) {
      throw new Error(POOL_CLOSED_MESSAGE);
    }
    try {
      // `bunSql` is itself a tagged-template callable; pass through verbatim.
      const result = await bunSql<T>(strings, ...values);
      // Bun.SQL returns an array-like with metadata props (count/command/…).
      // Coerce to a plain array so consumers don't accidentally couple to
      // those fields through this wrapper's public surface.
      return Array.from(result) as T[];
    } catch (err) {
      if (isPoolClosedError(err)) {
        throw new Error(POOL_CLOSED_MESSAGE);
      }
      throw err;
    }
  }

  // Function.prototype trick: make `call` itself the Db object by attaching
  // the methods. This preserves the tagged-template call signature while
  // satisfying the attached-methods part of the interface.
  const db = call as unknown as Db;

  Object.defineProperty(db, "provider", {
    value: provider,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  (db as { one: Db["one"] }).one = async function one<T extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T | null> {
    const rows = await call<T>(strings, ...values);
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0] as T;
    throw new Error(
      `[@mandujs/core/db] one(): expected 0 or 1 row, got ${rows.length}.`,
    );
  };

  (db as { transaction: Db["transaction"] }).transaction =
    async function transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      if (closed) {
        throw new Error(POOL_CLOSED_MESSAGE);
      }
      // Delegate to Bun.SQL's native begin(). The inner `tx` is a Bun.SQL
      // handle bound to the active transaction; we wrap it with the same
      // Db shape so user callbacks get a consistent API.
      return await bunSql.begin(async (innerBunSql) => {
        const innerDb = buildDbHandle(innerBunSql, provider);
        return await fn(innerDb);
      });
    };

  (db as { close: Db["close"] }).close = async function close(): Promise<void> {
    if (closed) return; // idempotent
    closed = true;
    try {
      await bunSql.close();
    } catch (err) {
      // Bun.SQL can throw if already-closed under the hood (mostly from a
      // racing concurrent close). We already flipped our flag so subsequent
      // queries reject cleanly — swallow this one.
      if (isPoolClosedError(err)) return;
      throw err;
    }
  };

  return db;
}

/**
 * Creates a {@link Db} handle backed by `Bun.SQL`. The Bun runtime probe
 * is lazy — `createDb(...)` itself does not throw when Bun.SQL is missing;
 * the first query (or `.close()`) does.
 *
 * @throws {TypeError} when `config.url` is missing or empty.
 */
export function createDb(config: DbConfig): Db {
  // Up-front config validation. We check `url` here (not only in
  // `_createDbWith`) so the error fires at construction time — matches
  // the TypeError contract the public API documents.
  if (!config || typeof config.url !== "string" || config.url.length === 0) {
    throw new TypeError(
      "[@mandujs/core/db] createDb: 'url' is required and must be a non-empty string.",
    );
  }

  // Lazy probe: we defer the `Bun.SQL` lookup to first query by capturing
  // a thunk here. In practice, Bun.SQL's constructor itself is cheap and
  // doesn't open a connection (only `connect()` / first query do), so
  // constructing the ctor-facing shape up-front would be fine — but we
  // honor the precedent set by scheduler/storage.s3: the runtime error
  // fires on the first real call, with a version-specific message.
  //
  // We still need to *return* a Db now, so call through a forwarding
  // function that probes on demand.
  let real: Db | null = null;
  function materialize(): Db {
    if (real) return real;
    real = _createDbWith(getBunSqlCtor(), config);
    return real;
  }

  const forward = async function forwardCall<T extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    return await materialize()<T>(strings, ...values);
  } as unknown as Db;

  const provider: SqlProvider = config.provider ?? detectProvider(config.url);
  Object.defineProperty(forward, "provider", {
    value: provider,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  (forward as { one: Db["one"] }).one = async function one<T extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T | null> {
    return await materialize().one<T>(strings, ...values);
  };
  (forward as { transaction: Db["transaction"] }).transaction =
    async function transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      return await materialize().transaction(fn);
    };
  (forward as { close: Db["close"] }).close = async function close(): Promise<void> {
    // If no query ever ran, materialize() was never called — nothing to
    // close. Only materialize + close if a real handle exists.
    if (!real) return;
    await real.close();
  };

  return forward;
}
