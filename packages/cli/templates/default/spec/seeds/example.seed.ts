/**
 * Example seed — wire this up once you've generated resources with
 * `mandu generate resource user --fields="email:email!,name:string!"`.
 *
 * This file shows both supported seed shapes:
 *
 *   1. The declarative form (default export `{ resource, data }`) —
 *      easiest path for bulk fixture rows.
 *   2. The imperative form (export a function) — escape hatch for
 *      anything the declarative form can't express (e.g. hashing
 *      passwords before insert, reading from a CSV, computing
 *      derived columns).
 *
 * Run this seed with:
 *
 *   mandu db seed --env=dev
 *   mandu db seed --file=001_example --dry-run
 *   mandu db seed --reset          # truncate target tables first
 *
 * Exit codes:
 *   0 ok | 1 error | 2 usage | 3 tampered | 4 refused (prod without confirm)
 *
 * Environment whitelist:
 *   Seeds default to ["dev", "staging"]. To include production, opt in
 *   explicitly in the `env:` array below AND run the command with
 *   `MANDU_DB_SEED_PROD_CONFIRM=yes mandu db seed --env=prod`.
 */

// ---------------------------------------------------------------------
// Declarative form — uncomment and adapt once you have a resource.
// ---------------------------------------------------------------------
//
// export default {
//   resource: "user",
//   key: "email", // upsert conflict column (must be unique)
//   env: ["dev", "staging"],
//   data: [
//     { email: "admin@example.com", name: "Admin" },
//     { email: "alice@example.com", name: "Alice" },
//   ],
// };

// ---------------------------------------------------------------------
// Imperative form — function receives a SeedContext with db + helpers.
// ---------------------------------------------------------------------

export default async function seed(_ctx: unknown): Promise<void> {
  // Replace with real seed logic. The `_ctx` argument exposes:
  //
  //   ctx.db                          Raw Bun.SQL handle (parameter-safe)
  //   ctx.env                         "dev" | "staging" | "prod"
  //   ctx.insert(resource, rows)      Typed INSERT
  //   ctx.upsert(resource, rows, { by: "email" })
  //
  // Example:
  //   await ctx.upsert("user", [
  //     { email: "admin@example.com", name: "Admin" },
  //   ], { by: "email" });
}

/**
 * Override the environments this seed runs in. Default is
 * `["dev", "staging"]` — production is opt-in.
 */
export const env = ["dev", "staging"] as const;
