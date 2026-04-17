/**
 * @mandujs/core/middleware/rate-limit/sqlite-store
 *
 * SQLite-backed {@link RateLimitStore} for same-host multi-process rate
 * limiting. Follows the Appendix D normative layer for Phase 4a:
 *
 *   - Goes through {@link createDb} (D.5) — never `new Bun.SQL` directly.
 *   - Enables WAL journaling at init (D.4) so concurrent writers don't
 *     block readers.
 *   - Runs the per-key `SELECT → compute → INSERT OR REPLACE` inside a
 *     single transaction so two processes racing on the same key observe
 *     a strictly-increasing count (no lost updates).
 *
 * GC cron is OPTIONAL and OPT-IN. Callers who don't want a cron (or who run
 * on pre-Bun-1.3.12 where `Bun.cron` is absent) can set `gcSchedule: false`
 * and call `gcNow()` manually — identical pattern to
 * `filling/session-sqlite.ts`.
 *
 * Not a distributed limiter: the limiter state is in the SQLite file, which
 * only reaches processes that share that file. Multi-host deployments need
 * a network-accessible store (future Redis backend).
 *
 * @module middleware/rate-limit/sqlite-store
 */

import { createDb, type Db } from "../../db";
import { defineCron, type CronRegistration } from "../../scheduler";
import type { RateLimitResult, RateLimitStore } from "./index";

// ─── Public options ─────────────────────────────────────────────────────────

export interface SqliteRateLimitStoreOptions {
  /**
   * SQLite database path. Accepts `":memory:"` for transient tests or a
   * filesystem path. Default: `".mandu/rate-limits.db"`.
   */
  dbPath?: string;
  /**
   * Table name. Must match `[A-Za-z_][A-Za-z0-9_]*` — SQLite does not bind
   * identifiers, so the name is interpolated into DDL/DML. Default:
   * `"mandu_rate_limits"`.
   */
  table?: string;
  /**
   * Cron schedule for background GC of stale rows. The sweep deletes rows
   * whose window is older than ~2 × the largest window used — we don't know
   * per-key windows at GC time, so the cron caller passes the threshold
   * explicitly via `gcNow(olderThanMs)`. Set to `false` to disable the cron
   * entirely; callers can still invoke `gcNow()` manually.
   *
   * Default: `"0 * * * *"` (hourly).
   */
  gcSchedule?: string | false;
  /**
   * `olderThanMs` passed to the cron sweep. Defaults to 24 h — entries
   * untouched for a full day are certainly safe to drop regardless of the
   * actual window size. Callers with huge windows should override.
   */
  gcOlderThanMs?: number;
}

// ─── Internal constants ────────────────────────────────────────────────────

const DEFAULT_DB_PATH = ".mandu/rate-limits.db";
const DEFAULT_TABLE = "mandu_rate_limits";
const DEFAULT_GC_SCHEDULE = "0 * * * *";
const DEFAULT_GC_OLDER_THAN_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Safe identifier pattern — same validation shape as `session-sqlite.ts`.
 * SQLite doesn't bind identifiers, so the name is string-interpolated into
 * DDL/DML; we constrain it to eliminate any injection surface.
 */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ─── Row shape ──────────────────────────────────────────────────────────────

interface RateLimitRow {
  key: string;
  window_start: number;
  count: number;
  [column: string]: unknown;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a SQLite-backed rate-limit store. Initialisation is lazy — the DB
 * handle is created up-front but no connection is opened until the first
 * `hit()` / `gcNow()` call, matching the laziness contract of
 * `@mandujs/core/db`.
 *
 * @throws {Error} Synchronously when `table` fails the safe-identifier
 *   check. Bad schedules surface at cron-registration time via the
 *   scheduler's own validator.
 */
export function createSqliteStore(
  options: SqliteRateLimitStoreOptions = {},
): RateLimitStore {
  const {
    dbPath = DEFAULT_DB_PATH,
    table = DEFAULT_TABLE,
    gcSchedule = DEFAULT_GC_SCHEDULE,
    gcOlderThanMs = DEFAULT_GC_OLDER_THAN_MS,
  } = options;

  if (!SAFE_IDENT_RE.test(table)) {
    throw new Error(
      `[@mandujs/core/middleware/rate-limit] Invalid table name ${JSON.stringify(
        table,
      )}. Must match ${SAFE_IDENT_RE}.`,
    );
  }

  const db: Db = createDb({ url: `sqlite:${dbPath}` });

  // At-most-once init. Each public method awaits this promise to guarantee
  // the schema + PRAGMAs are in place before any other query.
  let initPromise: Promise<void> | null = null;
  let closed = false;

  // ─── Transaction mutex ────────────────────────────────────────────────────
  //
  // Bun.SQL's SQLite adapter (as of 1.3.12) does NOT queue concurrent
  // `begin()` calls on a single-connection pool — two parallel transactions
  // surface "cannot start a transaction within a transaction" from the
  // native driver. We serialise tx calls in-process via a Promise chain so
  // that two `hit()` callers racing on the same key (or on different keys)
  // still produce correct counts.
  //
  // Within a single process this mutex is sufficient: the event loop can't
  // preempt synchronous code, and every yield point inside the critical
  // section is `await tx(...)` which keeps the chain intact.
  //
  // Across processes (same host, shared SQLite file), SQLite's own
  // file-level locking under WAL handles serialisation — the mutex only
  // prevents the in-process race.
  let txChain: Promise<unknown> = Promise.resolve();
  async function serialise<R>(fn: () => Promise<R>): Promise<R> {
    // Chain a new link; each link awaits the previous to settle (regardless
    // of rejection) before running. We capture the new link's result
    // separately so a rejection here doesn't poison the chain for the
    // next caller.
    const next = txChain.then(fn, fn);
    txChain = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  function ensureInit(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      // D.4: enable WAL. Safe on `:memory:` (silently stays in memory
      // journal mode) — we don't assert the return value so tests with
      // `:memory:` still pass.
      await db`PRAGMA journal_mode = WAL`;

      // Identifier validated above — safe to interpolate.
      await execRaw(
        db,
        `CREATE TABLE IF NOT EXISTS ${table} (
          key TEXT PRIMARY KEY,
          window_start INTEGER NOT NULL,
          count INTEGER NOT NULL
        )`,
      );
      await execRaw(
        db,
        `CREATE INDEX IF NOT EXISTS ${table}_window_start ON ${table}(window_start)`,
      );
    })();
    return initPromise;
  }

  // ─── Cron (optional) ──────────────────────────────────────────────────────

  let cronReg: CronRegistration | null = null;
  function startCronIfEnabled(): void {
    if (gcSchedule === false) return;
    if (cronReg) return;
    try {
      const reg = defineCron({
        [`${table}:gc`]: {
          schedule: gcSchedule,
          run: async () => {
            await gcNow(gcOlderThanMs);
          },
        },
      });
      reg.start();
      cronReg = reg;
    } catch (err) {
      // Bun < 1.3.12 or a malformed schedule. Warn once — manual gcNow()
      // is still available — then keep serving traffic.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[@mandujs/core/middleware/rate-limit] GC cron disabled: ${msg}. ` +
          `Call store.gcNow() manually.`,
      );
    }
  }

  // Schedule cron after first init succeeds — same pattern as session-sqlite.
  void ensureInit().then(startCronIfEnabled);

  // ─── Store methods ────────────────────────────────────────────────────────

  /**
   * Atomic `SELECT → compute → INSERT OR REPLACE` inside a transaction.
   * Two concurrent callers on the same key will serialise on the row's
   * write lock — SQLite under WAL guarantees no lost updates.
   */
  async function hit(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    if (closed) {
      throw new Error(
        "[@mandujs/core/middleware/rate-limit] SQLite store is closed.",
      );
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError(
        "[@mandujs/core/middleware/rate-limit] hit: key must be a non-empty string.",
      );
    }
    await ensureInit();

    const now = Date.now();

    const result = await serialise(() =>
      db.transaction(async (tx) => {
        const row = await queryOne<RateLimitRow>(
          tx,
          `SELECT key, window_start, count FROM ${table} WHERE key = $1`,
          [key],
        );

        let windowStart: number;
        let count: number;
        if (!row || now - Number(row.window_start) >= windowMs) {
          // Fresh window.
          windowStart = now;
          count = 1;
        } else {
          windowStart = Number(row.window_start);
          count = Number(row.count) + 1;
        }

        await execWithParams(
          tx,
          `INSERT OR REPLACE INTO ${table} (key, window_start, count) VALUES ($1, $2, $3)`,
          [key, windowStart, count],
        );

        return { windowStart, count };
      }),
    );

    const resetAt = result.windowStart + windowMs;
    const allowed = result.count <= limit;
    const remaining = Math.max(0, limit - result.count);
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((resetAt - now) / 1000));
    return { allowed, remaining, resetAt, retryAfterSeconds };
  }

  async function gcNow(olderThanMs: number): Promise<number> {
    if (closed) {
      throw new Error(
        "[@mandujs/core/middleware/rate-limit] SQLite store is closed.",
      );
    }
    if (typeof olderThanMs !== "number" || olderThanMs < 0) {
      throw new TypeError(
        "[@mandujs/core/middleware/rate-limit] gcNow: olderThanMs must be a non-negative number.",
      );
    }
    await ensureInit();

    const cutoff = Date.now() - olderThanMs;

    // Count + delete inside one transaction so the returned number reflects
    // what THIS call deleted (concurrent writers can't inflate it). Routed
    // through the serialise mutex so it doesn't race with in-flight hits.
    let deleted = 0;
    await serialise(() =>
      db.transaction(async (tx) => {
        const row = await queryOne<{ n: number | bigint }>(
          tx,
          `SELECT COUNT(*) AS n FROM ${table} WHERE window_start < $1`,
          [cutoff],
        );
        deleted = row ? Number(row.n) : 0;
        await execWithParams(
          tx,
          `DELETE FROM ${table} WHERE window_start < $1`,
          [cutoff],
        );
      }),
    );
    return deleted;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (cronReg) {
      try {
        await cronReg.stop();
      } catch {
        // Best-effort shutdown — don't mask the caller's shutdown flow.
      }
      cronReg = null;
    }
    await db.close();
  }

  return { hit, gcNow, close };
}

// ─── DB helpers ─────────────────────────────────────────────────────────────
//
// Same `$N`-placeholder-to-TemplateStringsArray trick used in
// `filling/session-sqlite.ts`. We need dynamic SQL (the table name is
// interpolated) and Bun.SQL's only public API is tagged-template, so we
// synthesise a TSA at call time.

async function execWithParams(
  dbOrTx: Db,
  sql: string,
  params: unknown[],
): Promise<void> {
  const parts = splitPlaceholders(sql, params.length);
  const strings = Object.assign(parts.slice(), {
    raw: parts.slice(),
  }) as unknown as TemplateStringsArray;
  await dbOrTx(strings, ...params);
}

async function queryOne<T extends Record<string, unknown>>(
  dbOrTx: Db,
  sql: string,
  params: unknown[],
): Promise<T | null> {
  const parts = splitPlaceholders(sql, params.length);
  const strings = Object.assign(parts.slice(), {
    raw: parts.slice(),
  }) as unknown as TemplateStringsArray;
  const rows = await dbOrTx<T>(strings, ...params);
  if (!rows || rows.length === 0) return null;
  return rows[0] as T;
}

async function execRaw(dbOrTx: Db, sql: string): Promise<void> {
  const strings = Object.assign([sql], {
    raw: [sql],
  }) as unknown as TemplateStringsArray;
  await dbOrTx(strings);
}

function splitPlaceholders(sql: string, expected: number): string[] {
  const parts: string[] = [];
  let rest = sql;
  for (let i = 1; i <= expected; i++) {
    const marker = `$${i}`;
    const idx = rest.indexOf(marker);
    if (idx === -1) {
      throw new Error(
        `[@mandujs/core/middleware/rate-limit] placeholder ${marker} missing in SQL: ${sql}`,
      );
    }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + marker.length);
  }
  parts.push(rest);
  return parts;
}
