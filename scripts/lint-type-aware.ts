#!/usr/bin/env bun

/**
 * Focused type-aware lint gate.
 *
 * Oxlint's type-aware mode enables a broad advisory surface by default. In this
 * codebase those broad rules are tracked as debt, while this gate keeps the
 * high-signal runtime checks active.
 */

const SOURCE_PATHS = [
  "packages/core/src",
  "packages/cli/src",
  "packages/mcp/src",
  "packages/ate/src",
  "packages/edge/src",
  "packages/skills/src",
  "packages/playground-runner/src",
];

const IGNORE_PATTERNS = [
  "**/__tests__/**",
  "**/*.test.ts",
  "**/*.test.tsx",
];

const DEBT_RULES = [
  "eslint/no-unused-vars",
  "typescript/no-unsafe-type-assertion",
  "typescript/no-unnecessary-type-assertion",
  "typescript/no-redundant-type-constituents",
  "typescript/no-base-to-string",
  "typescript/restrict-template-expressions",
  "typescript/no-unnecessary-type-parameters",
  "typescript/consistent-type-imports",
  "typescript/no-unnecessary-type-arguments",
  "typescript/consistent-return",
  "typescript/no-unnecessary-boolean-literal-compare",
  "typescript/no-unnecessary-type-conversion",
  "typescript/unbound-method",
  "typescript/no-unsafe-enum-comparison",
  "typescript/no-misused-spread",
  "typescript/no-unnecessary-template-expression",
  "typescript/require-array-sort-compare",
  "unicorn/no-array-reverse",
  "unicorn/prefer-add-event-listener",
  "unicorn/require-module-specifiers",
];

const args = [
  "--type-aware",
  ...SOURCE_PATHS,
  ...IGNORE_PATTERNS.flatMap((pattern) => ["--ignore-pattern", pattern]),
  ...DEBT_RULES.flatMap((rule) => ["--allow", rule]),
];

console.log("Type-aware lint gate: focused high-signal rules");

const proc = Bun.spawn(["oxlint", ...args], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);
