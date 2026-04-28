/**
 * Vercel adapter.
 *
 * Emits `vercel.json` with a custom build/output configuration suitable
 * for Mandu's SSR pipeline. Vercel's "Other" framework preset is used so
 * Vercel doesn't rewrite routes based on its built-in detectors; the
 * adapter owns the entire mapping.
 *
 * ## Runtime: @vercel/bun
 *
 * Mandu core relies on Bun-only APIs (Bun.serve, Bun.file, …), so the
 * SSR function targets the `@vercel/bun` community runtime. The entry
 * exports a Bun-style `fetch` handler that delegates to the same
 * `startServer` path used in dev/build.
 *
 * ## vercel.json caveats
 *
 *   - `functions[*].runtime` is an npm package spec for community
 *     runtimes (e.g. `@vercel/bun@1.0.0`). For the built-in Node
 *     runtime the field must be omitted entirely — `nodejs20.x` is
 *     not a valid value here.
 *   - The top-level `name` field is deprecated; project naming is
 *     owned by Vercel project settings.
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
 * Default Vercel community runtime spec for Mandu's SSR function.
 * `@vercel/bun` provides a Bun runtime on Vercel, matching Mandu's
 * dev/build environment so `Bun.serve`/`Bun.file` paths work as-is.
 */
const DEFAULT_VERCEL_RUNTIME = "@vercel/bun@1.0.0";

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
  /** Build command — defaults to `mandu build` (Bun must be available in builder). */
  buildCommand?: string;
  /** Output directory Vercel should serve (relative to project root). */
  outputDirectory?: string;
  /** Install command hint for Vercel. */
  installCommand?: string;
  /**
   * Non-secret env vars to inject at runtime. Secrets must be declared
   * via `vercel env add`, not embedded here.
   */
  env?: Record<string, string>;
  /**
   * Vercel community runtime spec for the SSR function. Must be an npm
   * package identifier (e.g. `@vercel/bun@1.0.0`, `@vercel/python@4.0.0`).
   * Defaults to `@vercel/bun@1.0.0` because Mandu core depends on Bun
   * APIs. To target a different community runtime, override here; the
   * built-in Node runtime is not supported by Mandu's SSR entry today.
   */
  runtime?: string;
}

export function renderVercelJson(options: VercelJsonOptions): string {
  if (!/^[a-z0-9][a-z0-9-_]{0,99}$/i.test(options.projectName)) {
    throw new Error(
      `renderVercelJson: projectName "${options.projectName}" is invalid`
    );
  }

  const runtime = options.runtime ?? DEFAULT_VERCEL_RUNTIME;
  if (!/^@?[a-z0-9][a-z0-9._/-]*@[0-9]+\.[0-9]+\.[0-9]+/i.test(runtime)) {
    throw new Error(
      `renderVercelJson: runtime "${runtime}" must be an npm package spec ` +
        `like "@vercel/bun@1.0.0" — Vercel rejects bare identifiers ` +
        `such as "nodejs20.x" in functions[*].runtime.`
    );
  }

  const config: Record<string, unknown> = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    version: 2,
    framework: null,
    buildCommand: options.buildCommand ?? "bun run mandu build",
    installCommand: options.installCommand ?? "bun install --frozen-lockfile",
    outputDirectory: options.outputDirectory ?? ".mandu/client",
    functions: {
      "api/_mandu.ts": {
        runtime,
        includeFiles: ".mandu/**",
      },
    },
    rewrites: [
      // Static assets pass through first (output directory), everything
      // else hits the SSR function.
      { source: "/assets/(.*)", destination: "/assets/$1" },
      { source: "/(.*)", destination: "/api/_mandu" },
    ],
    headers: [
      {
        source: "/assets/(.*)",
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
// SSR function entry template — `api/_mandu.ts`
// ---------------------------------------------------------------------

export function renderVercelFunctionEntry(): string {
  return `// Generated by \`mandu deploy --target=vercel\`.
// Vercel SSR function entry for the @vercel/bun runtime.
// Exports a Bun-style fetch handler — Vercel adapts it automatically.
import { startServer, generateManifest } from "@mandujs/core";
import { registerManifestHandlers } from "@mandujs/cli/util/handlers";

let serverPromise: Promise<{ fetch: (req: Request) => Response | Promise<Response> }> | null = null;

async function getServer(): Promise<{ fetch: (req: Request) => Response | Promise<Response> }> {
  if (serverPromise) return serverPromise;
  serverPromise = (async () => {
    const rootDir = process.cwd();
    const { manifest } = await generateManifest(rootDir);
    await registerManifestHandlers(manifest, rootDir, {
      importFn: (p: string) => import(p),
      registeredLayouts: new Set(),
    });
    const { server } = startServer(manifest, {
      port: 0,
      rootDir,
      isDev: false,
    });
    return server;
  })();
  return serverPromise;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const server = await getServer();
    return server.fetch(req);
  },
};
`;
}

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

      // 2. Node SSR function entry.
      const apiDir = path.join(rootDir, "api");
      const functionResult = await writeArtifact({
        forbiddenValues: options.forbiddenSecrets,
        path: path.join(apiDir, "_mandu.ts"),
        content: renderVercelFunctionEntry(),
      });
      artifacts.push({
        path: functionResult.path,
        description: "Vercel @vercel/node SSR entry",
      });

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
