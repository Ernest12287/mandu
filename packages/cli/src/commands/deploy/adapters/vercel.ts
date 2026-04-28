/**
 * Vercel adapter — static-only.
 *
 * # Why static-only (Issue #248)
 *
 * Vercel's function-runtime story is misaligned with Mandu in three ways:
 *
 *   1. The built-in Node runtime crashes on Mandu's `startServer` because
 *      core uses Bun-only globals (`Bun.serve`, `Bun.file`, `Bun.env`).
 *   2. The Edge runtime supports a Web-API subset that does not cover
 *      every code path `startServer` reaches at request time.
 *   3. There is no published `@vercel/bun` community runtime — the npm
 *      registry returns 404 for the package as of 2026-04-28. (Vercel
 *      ships build-time Bun support via `bun install`/`bun run build`,
 *      not a function runtime.)
 *
 * Until one of those gaps closes, the adapter cannot generate a working
 * SSR function. So the default scaffold pivots to the deploy shape that
 * actually works today: emit a flat static directory (`mandu build
 * --static`) and let Vercel serve it from its CDN. No functions, no
 * runtime field, no dotfile-routed rewrites.
 *
 * Projects with API routes or non-prerenderable pages are not supported
 * on Vercel via this adapter today — `check()` warns when the manifest
 * contains routes the static build will drop on the floor.
 *
 * # vercel.json caveats
 *
 *   - The top-level `name` field is deprecated; project naming is owned
 *     by Vercel project settings.
 *   - `functions[*].runtime` requires an npm package spec (e.g.
 *     `@vercel/python@4.0.0`). Bare identifiers like `nodejs20.x` are
 *     rejected. The static scaffold avoids the field entirely.
 *
 * References:
 *   - https://vercel.com/docs/projects/project-configuration
 *   - https://vercel.com/docs/functions/runtimes
 *
 * @module cli/commands/deploy/adapters/vercel
 */
import path from "node:path";
import { CLI_ERROR_CODES } from "../../../errors/codes";
import { writeArtifact } from "../artifact-writer";
import {
  getProviderCliStatus,
  type SpawnVersion,
} from "../provider-cli";
import type {
  AdapterArtifact,
  AdapterCheckResult,
  AdapterIssue,
  DeployAdapter,
  DeployOptions,
  DeployResult,
  ProjectContext,
  SecretSpec,
} from "../types";

const MIN_VERCEL_VERSION = "28.0.0";

/**
 * Default static-export directory that the scaffolded `vercel.json`
 * points Vercel at. Matches `mandu build --static`'s default outDir.
 */
const DEFAULT_STATIC_OUTPUT_DIR = "dist";

const VERCEL_SECRETS: ReadonlyArray<SecretSpec> = [
  {
    name: "VERCEL_TOKEN",
    required: true,
    description: "Vercel access token — used by the vercel CLI for deploys.",
    docsUrl: "https://vercel.com/account/tokens",
  },
];

// ---------------------------------------------------------------------
// vercel.json template
// ---------------------------------------------------------------------

export interface VercelJsonOptions {
  /**
   * Project name. Retained for adapter bookkeeping (artifact descriptions,
   * `mandu deploy` logs) but no longer emitted into `vercel.json` —
   * Vercel's top-level `name` field is deprecated and is owned by
   * Project Settings.
   */
  projectName: string;
  /**
   * Build command. Defaults to `bun run mandu build --static`, which
   * produces the flat static directory `vercel.json` points at.
   */
  buildCommand?: string;
  /**
   * Output directory Vercel should serve. Defaults to `dist`, matching
   * `mandu build --static`'s default. Must point at a flat tree shaped
   * like the URL space — Mandu's `--static` export does this for you.
   */
  outputDirectory?: string;
  /** Install command hint for Vercel. */
  installCommand?: string;
  /**
   * Non-secret env vars to inject at runtime. Secrets must be declared
   * via `vercel env add`, not embedded here.
   */
  env?: Record<string, string>;
}

export function renderVercelJson(options: VercelJsonOptions): string {
  if (!/^[a-z0-9][a-z0-9-_]{0,99}$/i.test(options.projectName)) {
    throw new Error(
      `renderVercelJson: projectName "${options.projectName}" is invalid`
    );
  }

  const config: Record<string, unknown> = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    version: 2,
    framework: null,
    buildCommand: options.buildCommand ?? "bun run mandu build --static",
    installCommand: options.installCommand ?? "bun install --frozen-lockfile",
    outputDirectory: options.outputDirectory ?? DEFAULT_STATIC_OUTPUT_DIR,
    headers: [
      // Long-lived cache for hashed JS/CSS bundles. The static export
      // preserves their on-disk path under `<outDir>/.mandu/client/...`
      // so the URLs the prerendered HTML already references resolve.
      {
        source: "/.mandu/client/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ],
  };

  if (options.env && Object.keys(options.env).length > 0) {
    for (const [key, value] of Object.entries(options.env)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        throw new Error(
          `renderVercelJson: env var "${key}" must match /^[A-Z][A-Z0-9_]*$/`
        );
      }
      if (/^sk_|^Bearer |^ghp_|^[A-Fa-f0-9]{32,}$/.test(value)) {
        // Heuristic: looks like a credential; force caller through the
        // secret flow rather than embedding it.
        throw new Error(
          `renderVercelJson: env "${key}" appears to contain a secret — ` +
            `declare it via \`vercel env add\` and reference it at runtime instead.`
        );
      }
    }
    (config as { env?: Record<string, string> }).env = options.env;
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---------------------------------------------------------------------
// SSR function entry — intentionally not generated.
// ---------------------------------------------------------------------
//
// The previous version of this adapter wrote `api/mandu.ts` and pointed
// `vercel.json#functions` at a Bun-style runtime. None of the published
// Vercel function runtimes (Node, Edge, Python) can host Mandu's
// `startServer` today (see module-level docstring), so emitting an SSR
// entry created an artifact that 500'd at cold start. Removed in favour
// of the static deploy shape which actually works.
//
// If/when an official Vercel Bun function runtime ships, restore this
// path with a runtime spec that resolves on npm.

// ---------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------

interface VercelAdapterOptions {
  spawnImpl?: SpawnVersion;
  deployImpl?: (
    project: ProjectContext,
    options: DeployOptions
  ) => Promise<DeployResult>;
}

export function createVercelAdapter(
  internal: VercelAdapterOptions = {}
): DeployAdapter {
  return {
    name: "Vercel",
    target: "vercel",
    minimumCliVersion: { binary: "vercel", semver: MIN_VERCEL_VERSION },
    secrets: VERCEL_SECRETS,

    async check(project, options): Promise<AdapterCheckResult> {
      const errors: AdapterIssue[] = [];
      const warnings: AdapterIssue[] = [];

      if (!project.manifest && !options.dryRun) {
        warnings.push({
          code: CLI_ERROR_CODES.DEPLOY_MANIFEST_MISSING,
          message: "Routes manifest is not built — `prepare()` will still emit vercel.json.",
        });
      }

      // Issue #248 — Vercel adapter is currently static-only. Surface
      // a warning when the manifest contains routes that the static
      // build will drop on the floor (API endpoints, non-prerendered
      // pages). Don't fail the check — the user may know their site
      // is fully prerenderable but still have a placeholder API route.
      const apiRoutes =
        project.manifest?.routes.filter((r) => r.kind === "api") ?? [];
      if (apiRoutes.length > 0) {
        warnings.push({
          code: CLI_ERROR_CODES.DEPLOY_UNSUPPORTED_ROUTE,
          message:
            `Vercel adapter is static-only (Issue #248): ${apiRoutes.length} API route(s) will not be served. ` +
            `No published Vercel function runtime can currently host Mandu's startServer.`,
          hint: "Move API logic to Workers (`mandu build --target=workers`) or self-host with `mandu start`.",
        });
      }

      if (options.execute) {
        const status = await getProviderCliStatus(
          "vercel",
          MIN_VERCEL_VERSION,
          { spawnImpl: internal.spawnImpl }
        );
        if (!status.installed) {
          errors.push({
            code: CLI_ERROR_CODES.DEPLOY_PROVIDER_CLI_MISSING,
            message: "vercel CLI is not installed.",
            hint: "Install with `bun add -g vercel` or `npm i -g vercel`.",
          });
        } else if (!status.meetsMinimum && status.version) {
          errors.push({
            code: CLI_ERROR_CODES.DEPLOY_PROVIDER_CLI_OUTDATED,
            message: `vercel ${status.version} is older than required ${MIN_VERCEL_VERSION}.`,
            hint: "Upgrade with `bun add -g vercel@latest`.",
          });
        }
      }

      return { ok: errors.length === 0, errors, warnings };
    },

    async prepare(project, options): Promise<AdapterArtifact[]> {
      const artifacts: AdapterArtifact[] = [];
      const rootDir = project.rootDir;
      const projectName = options.projectName ?? project.projectName;

      // 1. vercel.json — preserved if user has already customized one.
      const vercelJsonResult = await writeArtifact({
        forbiddenValues: options.forbiddenSecrets,
        path: path.join(rootDir, "vercel.json"),
        content: renderVercelJson({ projectName }),
        preserveIfExists: true,
      });
      artifacts.push({
        path: vercelJsonResult.path,
        preserved: vercelJsonResult.preserved,
        description: vercelJsonResult.preserved
          ? "Existing vercel.json preserved"
          : `Scaffolded vercel.json (project=${projectName})`,
      });

      // No SSR function entry. The static deploy shape serves the
      // flat tree from `mandu build --static` directly. See module
      // docstring for the runtime gap that drove this decision.

      return artifacts;
    },

    async deploy(project, options): Promise<DeployResult> {
      if (internal.deployImpl) {
        return internal.deployImpl(project, options);
      }
      return {
        ok: false,
        errors: [
          {
            code: CLI_ERROR_CODES.DEPLOY_NOT_IMPLEMENTED,
            message: "vercel CLI spawn harness is provided only via DeployAdapter.deployImpl.",
            hint: "Run `vercel deploy --prod` manually after `mandu deploy --target=vercel`.",
          },
        ],
      };
    },
  };
}

export const vercelAdapter: DeployAdapter = createVercelAdapter();
