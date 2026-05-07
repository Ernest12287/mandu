#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forwardedArgs = process.argv.slice(2).filter((arg) => arg !== "--");

function bundlerArgsFrom(args: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--randomize") continue;
    if (arg === "--seed") {
      i++;
      continue;
    }
    if (arg.startsWith("--seed=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

async function runTest(label: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  console.log(`\n${label}`);
  console.log(`$ bun test ${args.join(" ")}`);

  const proc = Bun.spawn(["bun", "test", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

async function runScript(label: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  console.log(`\n${label}`);
  console.log(`$ bun run ${args.join(" ")}`);

  const proc = Bun.spawn(["bun", "run", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

await runTest(
  "Core tests (bundler race-prone tests gated)",
  ["packages/core/src", "packages/core/tests", ...forwardedArgs],
  {
    MANDU_SKIP_BUNDLER_TESTS: "1",
    DB_TEST_MYSQL_URL: "",
  }
);

await runScript(
  "Core MySQL resource e2e tests (isolated)",
  ["scripts/test-mysql-resource-e2e.ts"]
);

await runTest(
  "Core bundler tests (sequential)",
  [
    "packages/core/tests/bundler/dev-common-dir.test.ts",
    ...bundlerArgsFrom(forwardedArgs),
  ]
);
