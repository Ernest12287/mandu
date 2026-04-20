---
kind: rpc_procedure
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.38.0"
---

# Role

You are generating a test for a Mandu typed RPC procedure. RPC
procedures are declared with `defineRpc({ procedures: {...} })` and
mount at `POST /api/rpc/<endpoint>/<procedure>`. Each procedure pairs
a Zod `input` schema, a Zod `output` schema, and a handler — the
dispatcher validates the request body against `input` and the handler's
return against `output` before shipping the response envelope.

# Provided context

Agents receive this via `mandu_ate_context({ scope: "rpc", id: "<endpoint>.<procedure>" })`:

- `procedure`: `{ id, endpoint, procedure, mountPath, file, line }`
- `inputSchemaSource`: source text of the Zod input schema (may be null
  for no-arg procedures).
- `outputSchemaSource`: source text of the Zod output schema.
- `middleware`: active middleware chain at the RPC endpoint.
- `routeLike`: a synthetic REST-shaped view — `{ id, pattern, methods:
  ["POST"], kind: "api" }` — so existing route-idiomatic reasoning
  still works.

# MUST-USE primitives

- `createRpcClient<typeof <rpcDef>>()` — typed client proxy. Gives you
  end-to-end types without manually importing the Zod schemas on the
  test side.
- `testFilling(handler, ...)` — when you need to unit-test the raw
  procedure handler without booting an HTTP server, point
  `testFilling` at the RPC dispatcher route.
- `expectContract(res, <outputSchema>)` — when you fetch the wire
  envelope directly (`fetch("/api/rpc/users/signup", ...)`), validate
  `envelope.data` against the schema.

# NEVER

- Ship a test that calls `fetch("/api/rpc/...")` with a manually
  stringified body when the typed client is available — you lose the
  static contract guarantees.
- Assume the wire envelope shape is `{ data }` only. It's discriminated:
  `{ ok: true, data } | { ok: false, error: { code, message, issues? } }`.
  Always check `ok`.
- Assert on field order in the `error.issues` array. Zod's issue order
  is stable, but relying on it makes the test brittle to schema edits.

# Output format

- Single `*.test.ts` file.
- Imports: `bun:test`, `@mandujs/core/testing`, `@mandujs/core/client/rpc`
  (`createRpcClient`), and the RPC definition under test.
- Minimum 3 cases: (1) happy-path call through the typed client, (2)
  input-validation path (invalid shape → `INPUT_INVALID`), (3)
  handler-error path when the procedure can throw a known error class.

# Example shape

```ts
import { describe, test, expect } from "bun:test";
import { createTestServer } from "@mandujs/core/testing";
import { createRpcClient } from "@mandujs/core/client/rpc";
import { usersRpc } from "../../src/users.rpc";

describe("usersRpc.signup", () => {
  test("happy path — valid input returns userId", async () => {
    using server = await createTestServer({ rpc: { users: usersRpc } });
    const client = createRpcClient<typeof usersRpc>({
      baseUrl: server.url,
      endpoint: "users",
    });
    const res = await client.signup({ email: "a@b.com", password: "valid123" });
    expect(typeof res.userId).toBe("string");
  });

  test("invalid email → INPUT_INVALID envelope", async () => {
    using server = await createTestServer({ rpc: { users: usersRpc } });
    const raw = await fetch(`${server.url}/api/rpc/users/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "valid123" }),
    });
    const env = await raw.json();
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("INPUT_INVALID");
  });

  test("duplicate email bubbles a structured handler error", async () => {
    using server = await createTestServer({ rpc: { users: usersRpc } });
    const client = createRpcClient<typeof usersRpc>({
      baseUrl: server.url,
      endpoint: "users",
    });
    await client.signup({ email: "dup@b.com", password: "valid123" });
    await expect(
      client.signup({ email: "dup@b.com", password: "valid123" }),
    ).rejects.toThrow(/EMAIL_TAKEN|duplicate/i);
  });
});
```

# Exemplars

## Positive examples

From `packages/ate/tests/exemplar-sources/rpc-procedure.examples.ts:6-12` depth: basic tags: happy-path, typed-client

```ts
test("signup RPC returns typed result", async () => {
  using server = await createTestServer({ rpc: { users: usersRpc } });
  const client = createRpcClient<typeof usersRpc>({ baseUrl: server.url, endpoint: "users" });
  const res = await client.signup({ email: "a@b.com", password: "valid123" });
  expect(typeof res.userId).toBe("string");
})
```

# Provided context

```json
{
  "procedure": {
    "id": "users.signup",
    "endpoint": "users",
    "procedure": "signup",
    "mountPath": "/api/rpc/users/signup"
  },
  "inputSchemaSource": "z.object({ email: z.string().email(), password: z.string().min(8) })",
  "outputSchemaSource": "z.object({ userId: z.string().uuid() })"
}
```
