/**
 * Render.com adapter.
 *
 * Emits a `render.yaml` Blueprint that Render's Git-watcher picks up on
 * push. No HTTP API calls — users commit the Blueprint and let Render
 * provision the service. This iteration covers:
 *
 *   - `web` service with Bun installed via curl inside Render's Node
 *     runtime (Render has no first-party Bun runtime yet).
 *   - Optional managed Postgres database block (`addons.postgres`).
 *   - User env vars surfaced as `sync: false` entries — values live in
 *     the Render dashboard, never on disk.
 *
 * Redis + worker service types are deferred to a follow-up; the current
 * Blueprint intentionally stays close to the shape documented in
 * `packages/mcp/src/resources/skills/mandu-deployment/rules/deploy-platform-render.md`.
 *
 * References:
 *   - https://render.com/docs/blueprint-spec
 *   - https://render.com/docs/yaml-spec
 *
 * @module cli/commands/deploy/adapters/render
 */
import path from "node:path";
import fs from "node:fs/promises";
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

const DEFAULT_REGION = "oregon";
const DEFAULT_PLAN = "starter";
const DEFAULT_HEALTHCHECK_PATH = "/health";
const MIN_RENDER_CLI_VERSION = "1.0.0";

// Render's published plan tiers. Keep the list small + loud — if Render
// adds a plan we want an explicit opt-in, not a silent pass-through.
export const RENDER_PLANS = ["starter", "standard", "pro"] as const;
export type RenderPlan = (typeof RENDER_PLANS)[number];

// Common regions — Render accepts a handful of slugs, the Blueprint
// only validates server-side, so we accept any lowercase slug but the
// defaults stay inside the published set.
const KNOWN_REGIONS: ReadonlySet<string> = new Set([
  "oregon",
  "ohio",
  "virginia",
  "frankfurt",
  "singapore",
]);

const RENDER_SECRETS: ReadonlyArray<SecretSpec> = [
  {
    name: "RENDER_API_KEY",
    required: false,
    description:
      "Render API key — optional (Blueprint deploys don't need it). " +
      "Used only by the Render CLI if the user chooses to run it manually.",
    docsUrl: "https://render.com/docs/api",
  },
];

// ---------------------------------------------------------------------
// render.yaml template
// ---------------------------------------------------------------------

export interface RenderEnvVarSpec {
  /** POSIX-style env var name. */
  key: string;
  /**
   * Inline value (non-secret config only). When omitted, the Blueprint
   * emits `sync: false` so Render surfaces the key in the dashboard for
   * the user to fill in — secrets never reach disk.
   */
  value?: string;
}

export interface RenderPostgresAddon {
  /** Database service name as referenced from `fromDatabase`. */
  name?: string;
  /** Plan tier for the managed Postgres. */
  plan?: RenderPlan;
  /** Logical database name created on provision. */
  databaseName?: string;
  /** Role name Render creates with full privileges. */
  user?: string;
}

export interface RenderAddons {
  /** Provision a managed Postgres and wire DATABASE_URL into the web service. */
  postgres?: boolean | RenderPostgresAddon;
}

export interface RenderConfig {
  /** Service name — matches `name:` in the Blueprint. */
  name: string;
  /** Render region slug (`oregon`, `singapore`, ...). */
  region?: string;
  /** Plan tier. */
  plan?: RenderPlan;
  /**
   * Build command override. Defaults to the Bun install-then-build
   * sequence; `renderBunDetector()` drives whether the install prelude
   * should be prepended.
   */
  buildCommand?: string;
  /** Start command override. Defaults to `bun run start`. */
  startCommand?: string;
  /** HTTP health check path. Default `/health`. */
  healthCheckPath?: string;
  /** Extra env vars (non-secret defaults + user-provided placeholders). */
  envVars?: ReadonlyArray<RenderEnvVarSpec>;
  /** Optional addon services (Postgres for now). */
  addons?: RenderAddons;
}

/**
 * Render the Blueprint YAML. Pure — no filesystem access.
 *
 * The generator does manual string building to keep the adapter free of
 * runtime deps (mirrors fly.toml / railway.json generation style).
 */
export function renderRenderYaml(config: RenderConfig): string {
  validateServiceName(config.name);
  validatePlan(config.plan);
  const region = config.region ?? DEFAULT_REGION;
  const plan = config.plan ?? DEFAULT_PLAN;
  const healthCheckPath = config.healthCheckPath ?? DEFAULT_HEALTHCHECK_PATH;
  const buildCommand =
    config.buildCommand ?? defaultBuildCommand({ withBunInstall: renderBunDetector() });
  const startCommand = config.startCommand ?? defaultStartCommand();
  const envVars = config.envVars ?? [];
  const wantsPostgres = hasPostgres(config.addons);
  const postgresOpts: RenderPostgresAddon =
    typeof config.addons?.postgres === "object" ? config.addons.postgres : {};
  const postgresName = postgresOpts.name ?? `${config.name}-db`;
  const postgresDatabase = postgresOpts.databaseName ?? toDbIdent(config.name);
  const postgresUser = postgresOpts.user ?? toDbIdent(config.name);
  const postgresPlan = postgresOpts.plan ?? DEFAULT_PLAN;
  validatePlan(postgresPlan);

  const lines: string[] = [
    "# Generated by `mandu deploy --target=render`.",
    "# Docs: https://render.com/docs/blueprint-spec",
    "",
    "services:",
    "  - type: web",
    `    name: ${config.name}`,
    "    runtime: node",
    `    region: ${region}`,
    `    plan: ${plan}`,
    "",
    "    buildCommand: |",
    ...indent(buildCommand, "      "),
    "",
    "    startCommand: |",
    ...indent(startCommand, "      "),
    "",
    `    healthCheckPath: ${healthCheckPath}`,
    "",
    "    envVars:",
    "      - key: NODE_ENV",
    "        value: production",
    "      - key: PORT",
    "        fromService:",
    "          type: web",
    `          name: ${config.name}`,
    "          property: port",
  ];

  if (wantsPostgres) {
    lines.push(
      "      - key: DATABASE_URL",
      "        fromDatabase:",
      `          name: ${postgresName}`,
      "          property: connectionString"
    );
  }

  // User env vars appended last so dashboard-managed keys stay grouped.
  for (const spec of envVars) {
    validateEnvKey(spec.key);
    lines.push(`      - key: ${spec.key}`);
    if (typeof spec.value === "string") {
      // Quote the value so colons, quotes, or YAML-significant chars
      // survive round-tripping.
      lines.push(`        value: ${yamlQuote(spec.value)}`);
    } else {
      lines.push("        sync: false");
    }
  }

  if (wantsPostgres) {
    lines.push(
      "",
      "databases:",
      `  - name: ${postgresName}`,
      `    plan: ${postgresPlan}`,
      `    databaseName: ${postgresDatabase}`,
      `    user: ${postgresUser}`
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Returns `true` when the Blueprint's `buildCommand` should carry the
 * `curl -fsSL https://bun.sh/install | bash` prelude. Render's Node
 * runtime image does not ship Bun, so this defaults to `true`. Exposed
 * primarily for tests + potential future Bun-first Render runtime.
 */
export function renderBunDetector(): boolean {
  // Current reality: Render's `runtime: node` has no Bun binary on PATH.
  // We could detect `RENDER_BUN_NATIVE=1` or similar, but no such flag
  // exists yet — leave the detector honest and add a toggle later.
  return true;
}

function defaultBuildCommand(options: { withBunInstall: boolean }): string {
  const install = options.withBunInstall
    ? [
        "curl -fsSL https://bun.sh/install | bash",
        'export PATH="$HOME/.bun/bin:$PATH"',
      ]
    : [];
  return [
    ...install,
    "bun install --frozen-lockfile",
    "bun run build",
  ].join("\n");
}

function defaultStartCommand(): string {
  return [
    'export PATH="$HOME/.bun/bin:$PATH"',
    "bun run start",
  ].join("\n");
}

function hasPostgres(addons: RenderAddons | undefined): boolean {
  if (!addons) return false;
  if (addons.postgres === true) return true;
  if (typeof addons.postgres === "object" && addons.postgres !== null) return true;
  return false;
}

function validateServiceName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Render service name is required.`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/i.test(name)) {
    throw new Error(
      `Render service name "${name}" is invalid — must match /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/i.`
    );
  }
}

function validatePlan(plan: string | undefined): void {
  if (plan === undefined) return;
  if (!(RENDER_PLANS as readonly string[]).includes(plan)) {
    throw new Error(
      `Render plan "${plan}" is invalid — expected one of ${RENDER_PLANS.join(", ")}.`
    );
  }
}

function validateEnvKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(
      `renderRenderYaml: env var "${key}" must match /^[A-Z][A-Z0-9_]*$/`
    );
  }
}

function indent(block: string, prefix: string): string[] {
  return block.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

function yamlQuote(value: string): string {
  // Conservative quoting: single-quote the value and escape embedded
  // single quotes by doubling them (YAML 1.2 flow-scalar rule).
  return `'${value.replace(/'/g, "''")}'`;
}

function toDbIdent(projectName: string): string {
  // Render's managed Postgres forbids hyphens in logical names.
  return projectName.replace(/-/g, "_").toLowerCase();
}

// ---------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------

export interface RenderAdapterOptions {
  /** Override `render --version` spawn for tests. */
  spawnImpl?: SpawnVersion;
  /**
   * Test hook for the deploy step. Production path does not spawn a CLI
   * — Render picks up the Blueprint from git — so this is primarily a
   * seam for injecting a deterministic result in integration tests.
   */
  deployImpl?: (
    project: ProjectContext,
    options: DeployOptions
  ) => Promise<DeployResult>;
}

export function createRenderAdapter(
  internal: RenderAdapterOptions = {}
): DeployAdapter {
  return {
    name: "Render",
    target: "render",
    minimumCliVersion: { binary: "render", semver: MIN_RENDER_CLI_VERSION },
    secrets: RENDER_SECRETS,

    async check(project, options): Promise<AdapterCheckResult> {
      const errors: AdapterIssue[] = [];
      const warnings: AdapterIssue[] = [];

      // Project name must survive Render's slug rules.
      const serviceName = options.projectName ?? project.projectName;
      if (!serviceName || serviceName.length === 0) {
        errors.push({
          code: CLI_ERROR_CODES.DEPLOY_CONFIG_INVALID,
          message: "Render service name missing.",
          hint:
            "Set `name` in package.json, or pass --project=<slug> (lowercase, hyphens only).",
        });
      } else {
        try {
          validateServiceName(serviceName);
        } catch (err) {
          errors.push({
            code: CLI_ERROR_CODES.DEPLOY_CONFIG_INVALID,
            message: err instanceof Error ? err.message : String(err),
            hint:
              "Render requires a lowercase alphanumeric slug with optional hyphens.",
          });
        }
      }

      // Warn on uncommon regions — not fatal, Render may add new ones.
      const region = DEFAULT_REGION;
      if (!KNOWN_REGIONS.has(region)) {
        warnings.push({
          code: CLI_ERROR_CODES.DEPLOY_CONFIG_INVALID,
          message: `Region "${region}" is not in the built-in list; verify with Render before deploy.`,
        });
      }

      // The Render CLI is optional — Blueprint deploys work without it.
      // On `--execute` we still probe so power users get a friendly
      // "CLI missing" message matching the rest of the adapters.
      if (options.execute) {
        const status = await getProviderCliStatus(
          "render",
          MIN_RENDER_CLI_VERSION,
          { spawnImpl: internal.spawnImpl }
        );
        if (!status.installed) {
          warnings.push({
            code: CLI_ERROR_CODES.DEPLOY_PROVIDER_CLI_MISSING,
            message:
              "Render CLI not found (optional — Blueprint deploys trigger via git push).",
            hint: "Install with `npm install -g @render/cli` if you want manual control.",
          });
        } else if (!status.meetsMinimum && status.version) {
          warnings.push({
            code: CLI_ERROR_CODES.DEPLOY_PROVIDER_CLI_OUTDATED,
            message: `render ${status.version} is older than ${MIN_RENDER_CLI_VERSION}.`,
            hint: "Upgrade via `npm install -g @render/cli@latest`.",
          });
        }
      }

      return { ok: errors.length === 0, errors, warnings };
    },

    async prepare(project, options): Promise<AdapterArtifact[]> {
      const artifacts: AdapterArtifact[] = [];
      const rootDir = project.rootDir;
      const serviceName = options.projectName ?? project.projectName;

      // Surface any env vars the user already keeps in `.env.example` as
      // sync: false placeholders — saves them a trip back to the
      // dashboard. We DO NOT read `.env` (plaintext secrets) here.
      const envExamplePath = path.join(rootDir, ".env.example");
      const placeholders = await readEnvExampleKeys(envExamplePath);
      const envVars: RenderEnvVarSpec[] = placeholders
        .filter((key) => key !== "NODE_ENV" && key !== "PORT" && key !== "DATABASE_URL")
        .map((key) => ({ key }));

      const yaml = renderRenderYaml({
        name: serviceName,
        region: DEFAULT_REGION,
        plan: DEFAULT_PLAN,
        envVars,
        // Postgres addon is opt-in — keep prepare() conservative; the
        // user can flip it on by editing render.yaml.
      });

      const result = await writeArtifact({
        forbiddenValues: options.forbiddenSecrets,
        path: path.join(rootDir, "render.yaml"),
        content: yaml,
        preserveIfExists: true,
      });
      artifacts.push({
        path: result.path,
        preserved: result.preserved,
        description: result.preserved
          ? "Existing render.yaml preserved"
          : `Scaffolded render.yaml (service=${serviceName}, region=${DEFAULT_REGION})`,
      });

      return artifacts;
    },

    async deploy(project, options): Promise<DeployResult> {
      if (internal.deployImpl) {
        return internal.deployImpl(project, options);
      }
      // Render deploys are git-driven. We surface actionable next steps
      // rather than attempt a REST call (gated behind a future OAuth
      // milestone — see skill doc's API-key workflow).
      const serviceName = options.projectName ?? project.projectName;
      return {
        ok: true,
        url: undefined,
        warnings: [
          {
            code: CLI_ERROR_CODES.DEPLOY_NOT_IMPLEMENTED,
            message:
              "Render adapter does not spawn a provider CLI — Blueprint deploys trigger on git push.",
            hint:
              "Next steps:\n" +
              "   1. git add render.yaml && git commit -m \"chore: render blueprint\"\n" +
              "   2. git push to the branch Render watches (default: main)\n" +
              `   3. Visit https://dashboard.render.com/blueprints and link the repo as "${serviceName}"\n` +
              "   4. Set dashboard env vars for any `sync: false` keys",
          },
        ],
      };
    },
  };
}

export const renderAdapter: DeployAdapter = createRenderAdapter();

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function readEnvExampleKeys(file: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const keys: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(key) && !keys.includes(key)) {
        keys.push(key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}
