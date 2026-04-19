/**
 * createTestDb — integration DB fixture tests.
 *
 * Uses in-memory SQLite end-to-end (requires Bun 1.3+ with Bun.SQL).
 * Verifies schema bootstrap, seeding callback, transaction helper, and
 * idempotent close.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDb } from "../../src/testing/index";

describe("createTestDb — sqlite::memory:", () => {
  let handle: TestDb | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it("applies a schema string and supports CRUD", async () => {
    handle = await createTestDb({
      schema: `
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL
        );
      `,
    });

    await handle.db`INSERT INTO users (id, email) VALUES (${"u1"}, ${"a@b.c"})`;
    const rows = await handle.db<{
      id: string;
      email: string;
    }>`SELECT id, email FROM users ORDER BY id`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("u1");
    expect(rows[0].email).toBe("a@b.c");
  });

  it("supports array-form schema statements", async () => {
    handle = await createTestDb({
      schema: [
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)",
        "CREATE INDEX posts_title ON posts(title)",
      ],
    });
    await handle.db`INSERT INTO posts (id, title) VALUES (${1}, ${"hello"})`;
    const rows = await handle.db<{ id: number; title: string }>`SELECT * FROM posts`;
    expect(rows[0].title).toBe("hello");
  });

  it("runs a seed callback after schema is applied", async () => {
    handle = await createTestDb({
      schema: "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)",
      seed: async (db) => {
        await db`INSERT INTO kv (k, v) VALUES (${"env"}, ${"test"})`;
      },
    });

    const row = await handle.db.one<{ k: string; v: string }>`SELECT * FROM kv WHERE k = ${"env"}`;
    expect(row?.v).toBe("test");
  });

  it("transaction() commits on success", async () => {
    handle = await createTestDb({
      schema: "CREATE TABLE counters (id INTEGER PRIMARY KEY, n INTEGER)",
    });
    await handle.db`INSERT INTO counters (id, n) VALUES (${1}, ${0})`;

    await handle.transaction(async (tx) => {
      await tx`UPDATE counters SET n = n + 5 WHERE id = ${1}`;
    });

    const row = await handle.db.one<{ n: number }>`SELECT n FROM counters WHERE id = ${1}`;
    expect(row?.n).toBe(5);
  });

  it("transaction() rolls back on error", async () => {
    handle = await createTestDb({
      schema: "CREATE TABLE tx_log (id INTEGER PRIMARY KEY, note TEXT)",
    });

    await expect(
      handle.transaction(async (tx) => {
        await tx`INSERT INTO tx_log (id, note) VALUES (${1}, ${"inserted"})`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await handle.db<{ id: number }>`SELECT * FROM tx_log`;
    expect(rows).toHaveLength(0);
  });

  it("apply() runs extra DDL post-construction", async () => {
    handle = await createTestDb();
    await handle.apply("CREATE TABLE later (id INTEGER PRIMARY KEY)");
    await handle.db`INSERT INTO later (id) VALUES (${9})`;
    const rows = await handle.db<{ id: number }>`SELECT id FROM later`;
    expect(rows[0].id).toBe(9);
  });

  it("close() is idempotent", async () => {
    const local = await createTestDb();
    await local.close();
    // Second close resolves without throwing.
    await expect(local.close()).resolves.toBeUndefined();
  });
});
