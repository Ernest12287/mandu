// Smoke-test seed — dev only, two fixture posts. Note: the underlying
// table is `posts` (DDL pluralises) but the resource name is `post`.
// The seed runner maps resource → table via the resource definition;
// we reference the resource name, not the table name.
export default {
  resource: "post",
  key: "id",
  env: ["dev"] as const,
  data: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-00000000000a",
      title: "Welcome",
      body: "First seeded post.",
      createdAt: "2026-04-18T00:00:00.000Z",
    },
  ],
};
