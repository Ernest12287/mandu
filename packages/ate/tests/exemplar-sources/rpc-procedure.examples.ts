/**
 * Phase C.5 — tagged exemplars for `rpc_procedure` prompt kind.
 */

// @ate-exemplar: kind=rpc_procedure depth=basic tags=happy-path,typed-client
test("signup RPC returns typed result", async () => {
  using server = await createTestServer({ rpc: { users: usersRpc } });
  const client = createRpcClient<typeof usersRpc>({ baseUrl: server.url, endpoint: "users" });
  const res = await client.signup({ email: "a@b.com", password: "valid123" });
  expect(typeof res.userId).toBe("string");
});

// @ate-exemplar: kind=rpc_procedure depth=basic tags=input-invalid,envelope
test("signup RPC rejects malformed input with INPUT_INVALID", async () => {
  using server = await createTestServer({ rpc: { users: usersRpc } });
  const raw = await fetch(`${server.url}/api/rpc/users/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nope", password: "short" }),
  });
  const env = await raw.json();
  expect(env.ok).toBe(false);
  expect(env.error.code).toBe("INPUT_INVALID");
});

// @ate-exemplar: kind=rpc_procedure depth=advanced tags=handler-error,retry
test("signup RPC surfaces structured handler error for duplicate email", async () => {
  using server = await createTestServer({ rpc: { users: usersRpc } });
  const client = createRpcClient<typeof usersRpc>({ baseUrl: server.url, endpoint: "users" });
  await client.signup({ email: "dup@b.com", password: "valid123" });
  await expect(
    client.signup({ email: "dup@b.com", password: "valid123" }),
  ).rejects.toThrow(/EMAIL_TAKEN/i);
});

// @ate-exemplar: kind=rpc_procedure depth=basic tags=output-validation
test("signup RPC validates handler output shape", async () => {
  using server = await createTestServer({ rpc: { users: usersRpc } });
  const raw = await fetch(`${server.url}/api/rpc/users/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@b.com", password: "valid123" }),
  });
  const env = await raw.json();
  if (env.ok) expect(typeof env.data.userId).toBe("string");
});
