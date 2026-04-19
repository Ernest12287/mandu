/**
 * Stack analyzer — inspects package.json to discover what libraries the
 * project actually depends on. Used to tailor skill templates (e.g. drop
 * Playwright tips if Playwright isn't installed).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StackAnalysis } from "../types";

const EXTRA_KEYS_OF_INTEREST = [
  "zod",
  "drizzle-orm",
  "prisma",
  "@auth/core",
  "next-auth",
  "trpc",
  "@trpc/server",
  "shadcn-ui",
];

export function analyzeStack(repoRoot: string): StackAnalysis {
  const result: StackAnalysis = {
    hasReact: false,
    hasTailwind: false,
    hasPlaywright: false,
    bunRuntime: false,
    extras: [],
  };

  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return result;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return result;
  }

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
    ...(pkg.peerDependencies as Record<string, string> | undefined),
  };

  result.manduCore = deps["@mandujs/core"];
  result.hasReact = "react" in deps || "react-dom" in deps;
  result.hasTailwind = "tailwindcss" in deps;
  result.hasPlaywright = "@playwright/test" in deps || "playwright" in deps;

  // Bun runtime — engines.bun or packageManager starts with "bun"
  const engines = pkg.engines as Record<string, string> | undefined;
  const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  result.bunRuntime =
    !!(engines && "bun" in engines) || packageManager.startsWith("bun@");

  for (const key of EXTRA_KEYS_OF_INTEREST) {
    if (key in deps) result.extras.push(key);
  }

  return result;
}
