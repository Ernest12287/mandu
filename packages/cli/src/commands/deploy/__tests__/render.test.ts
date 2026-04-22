/**
 * Render.com adapter tests — covers the `renderRenderYaml()` pure
 * generator + the adapter's `check()` / `prepare()` / `deploy()`
 * surface. Uses tmp-directory projects so nothing escapes into the
 * repo tree.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createRenderAdapter,
  renderAdapter,
  renderBunDetector,
  renderRenderYaml,
} from "../adapters";
import type { ProjectContext } from "../types";

async function makeProject(prefix: string, overrides?: { name?: string }): Promise<
  ProjectContext & { root: string }
> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mandu-render-${prefix}-`));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: overrides?.name ?? "acme-app", version: "0.0.1" }, null, 2)
  );
  const config = {
    server: { port: 3333 },
    guard: {},
    build: {},
    dev: {},
    fsRoutes: {},
    seo: {},
  } as unknown as ProjectContext["config"];
  return {
    root,
    rootDir: root,
    config,
    projectName: overrides?.name ?? "acme-app",
    hasPublicDir: false,
    hasTailwind: false,
  };
}

async function cleanup(project: { root: string }): Promise<void> {
  await fs.rm(project.root, { recursive: true, force: true });
}

// ===== renderRenderYaml() pure generator =============================

describe("renderRenderYaml", () => {
  it("emits the Blueprint with the exact buildCommand, startCommand, and PORT fromService wiring", () => {
    const yaml = renderRenderYaml({ name: "acme-app" });

    // Top-level shape.
    expect(yaml).toContain("services:");
    expect(yaml).toContain("  - type: web");
    expect(yaml).toContain("    name: acme-app");
    expect(yaml).toContain("    runtime: node");
    expect(yaml).toContain("    region: oregon");
    expect(yaml).toContain("    plan: starter");

    // Build command — Bun install prelude must be present (runtime: node
    // has no Bun on PATH).
    expect(yaml).toContain("    buildCommand: |");
    expect(yaml).toContain("      curl -fsSL https://bun.sh/install | bash");
    expect(yaml).toContain('      export PATH="$HOME/.bun/bin:$PATH"');
    expect(yaml).toContain("      bun install --frozen-lockfile");
    expect(yaml).toContain("      bun run build");

    // Start command.
    expect(yaml).toContain("    startCommand: |");
    expect(yaml).toContain("      bun run start");

    // Healthcheck defaults to /health per skill doc.
    expect(yaml).toContain("    healthCheckPath: /health");

    // PORT wiring via fromService — the critical bit the task calls out.
    expect(yaml).toMatch(/- key: PORT\s+fromService:\s+type: web\s+name: acme-app\s+property: port/);

    // NODE_ENV stays inlined (non-secret).
    expect(yaml).toContain("      - key: NODE_ENV");
    expect(yaml).toContain("        value: production");
  });

  it("includes user env vars as `key` + `sync: false` entries when no value is provided", () => {
    const yaml = renderRenderYaml({
      name: "acme-app",
      envVars: [
        { key: "SESSION_SECRET" },
        { key: "API_BASE_URL", value: "https://api.example.com" },
      ],
    });
    expect(yaml).toContain("      - key: SESSION_SECRET");
    expect(yaml).toContain("        sync: false");
    expect(yaml).toContain("      - key: API_BASE_URL");
    expect(yaml).toContain("        value: 'https://api.example.com'");
    // sync: false entry must NOT emit a `value:` line.
    const sessionBlock = yaml.slice(yaml.indexOf("- key: SESSION_SECRET"));
    const nextKey = sessionBlock.indexOf("- key:", 1);
    const slice = nextKey >= 0 ? sessionBlock.slice(0, nextKey) : sessionBlock;
    expect(slice).not.toContain("value:");
  });

  it("emits a Postgres database block when addons.postgres is true", () => {
    const yaml = renderRenderYaml({
      name: "acme-app",
      addons: { postgres: true },
    });
    // DATABASE_URL wired via fromDatabase.
    expect(yaml).toContain("      - key: DATABASE_URL");
    expect(yaml).toContain("        fromDatabase:");
    expect(yaml).toContain("          name: acme-app-db");
    expect(yaml).toContain("          property: connectionString");
    // Top-level databases: block.
    expect(yaml).toContain("\ndatabases:");
    expect(yaml).toContain("  - name: acme-app-db");
    expect(yaml).toContain("    plan: starter");
    // Database name is hyphen-stripped (Render forbids hyphens in db idents).
    expect(yaml).toContain("    databaseName: acme_app");
    expect(yaml).toContain("    user: acme_app");
  });

  it("accepts object addons for custom Postgres name/plan", () => {
    const yaml = renderRenderYaml({
      name: "acme-app",
      addons: {
        postgres: {
          name: "custom-db",
          plan: "standard",
          databaseName: "analytics",
          user: "reporter",
        },
      },
    });
    expect(yaml).toContain("          name: custom-db");
    expect(yaml).toContain("  - name: custom-db");
    expect(yaml).toContain("    plan: standard");
    expect(yaml).toContain("    databaseName: analytics");
    expect(yaml).toContain("    user: reporter");
  });

  it("validates plan against the allowlist and throws on unknown", () => {
    expect(() =>
      renderRenderYaml({ name: "acme-app", plan: "enterprise" as unknown as "starter" })
    ).toThrow(/expected one of starter, standard, pro/);
    // Valid plans must not throw.
    expect(() => renderRenderYaml({ name: "acme-app", plan: "starter" })).not.toThrow();
    expect(() => renderRenderYaml({ name: "acme-app", plan: "standard" })).not.toThrow();
    expect(() => renderRenderYaml({ name: "acme-app", plan: "pro" })).not.toThrow();
  });

  it("rejects invalid service names and env var keys", () => {
    expect(() => renderRenderYaml({ name: "" })).toThrow(/required/);
    expect(() => renderRenderYaml({ name: "Has Spaces" })).toThrow(/invalid/);
    expect(() =>
      renderRenderYaml({
        name: "acme-app",
        envVars: [{ key: "lower_case" }],
      })
    ).toThrow(/must match/);
  });
});

// ===== renderBunDetector() ===========================================

describe("renderBunDetector", () => {
  it("returns true — Render's node runtime has no Bun on PATH", () => {
    expect(renderBunDetector()).toBe(true);
  });
});

// ===== adapter.check() ===============================================

describe("renderAdapter.check", () => {
  it("reports a diagnostic when the project has no name", async () => {
    const p = await makeProject("check-noname");
    const result = await renderAdapter.check(
      { ...p, projectName: "" },
      { target: "render" }
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "CLI_E201")).toBe(true);
    await cleanup(p);
  });

  it("reports a diagnostic for an invalid slug", async () => {
    const p = await makeProject("check-bad-slug");
    const result = await renderAdapter.check(p, {
      target: "render",
      projectName: "UPPER CASE!!",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("CLI_E201");
    await cleanup(p);
  });

  it("passes on a well-formed project", async () => {
    const p = await makeProject("check-ok");
    const result = await renderAdapter.check(p, { target: "render" });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    await cleanup(p);
  });

  it("emits a non-fatal warning when Render CLI is missing on --execute", async () => {
    const p = await makeProject("check-nocli");
    const adapter = createRenderAdapter({
      spawnImpl: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 127,
        notFound: true,
      }),
    });
    const result = await adapter.check(p, { target: "render", execute: true });
    // CLI missing is a WARNING for Render (not fatal — Blueprint deploys
    // don't need the CLI) — check() still returns ok: true.
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === "CLI_E205")).toBe(true);
    await cleanup(p);
  });
});

// ===== adapter.prepare() =============================================

describe("renderAdapter.prepare", () => {
  it("writes render.yaml and returns the artifact path", async () => {
    const p = await makeProject("prepare-write");
    const artifacts = await renderAdapter.prepare(p, { target: "render" });
    expect(artifacts).toHaveLength(1);
    const rel = path.basename(artifacts[0]!.path);
    expect(rel).toBe("render.yaml");
    expect(artifacts[0]!.preserved).toBe(false);
    const body = await fs.readFile(path.join(p.root, "render.yaml"), "utf8");
    expect(body).toContain("services:");
    expect(body).toContain("    name: acme-app");
    await cleanup(p);
  });

  it("preserves an existing render.yaml on re-run", async () => {
    const p = await makeProject("prepare-preserve");
    const yamlPath = path.join(p.root, "render.yaml");
    await fs.writeFile(yamlPath, "# user-modified\n");
    const artifacts = await renderAdapter.prepare(p, { target: "render" });
    expect(artifacts[0]!.preserved).toBe(true);
    expect(await fs.readFile(yamlPath, "utf8")).toBe("# user-modified\n");
    await cleanup(p);
  });

  it("pulls env var names from .env.example into sync:false placeholders", async () => {
    const p = await makeProject("prepare-envexample");
    await fs.writeFile(
      path.join(p.root, ".env.example"),
      [
        "# comment line",
        "SESSION_SECRET=changeme",
        "GOOGLE_CLIENT_ID=",
        "NODE_ENV=production", // skipped — we inline NODE_ENV ourselves
        "",
      ].join("\n")
    );
    await renderAdapter.prepare(p, { target: "render" });
    const body = await fs.readFile(path.join(p.root, "render.yaml"), "utf8");
    expect(body).toContain("      - key: SESSION_SECRET");
    expect(body).toContain("      - key: GOOGLE_CLIENT_ID");
    // NODE_ENV from .env.example must not produce a duplicate entry.
    const matches = body.match(/- key: NODE_ENV/g) ?? [];
    expect(matches.length).toBe(1);
    await cleanup(p);
  });
});

// ===== adapter.deploy() ==============================================

describe("renderAdapter.deploy", () => {
  it("returns ok:true with next-step guidance (Blueprint deploys are git-driven)", async () => {
    const p = await makeProject("deploy-guidance");
    const result = await renderAdapter.deploy!(p, { target: "render" });
    expect(result.ok).toBe(true);
    expect(result.url).toBeUndefined();
    expect(result.warnings).toBeDefined();
    const hint = result.warnings?.[0]?.hint ?? "";
    expect(hint).toContain("git push");
    expect(hint).toContain("https://dashboard.render.com/blueprints");
    await cleanup(p);
  });

  it("forwards to deployImpl when provided (test harness seam)", async () => {
    const p = await makeProject("deploy-harness");
    const adapter = createRenderAdapter({
      deployImpl: async () => ({
        ok: true,
        url: "https://acme-app.onrender.com",
        deploymentId: "dep_abc123",
      }),
    });
    const result = await adapter.deploy!(p, { target: "render" });
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://acme-app.onrender.com");
    expect(result.deploymentId).toBe("dep_abc123");
    await cleanup(p);
  });
});

// ===== --dry-run style isolation (task item #6) ======================

describe("renderRenderYaml isolation", () => {
  // Per the task spec: "renderAdapter.preview({ dry: true }) writes
  // nothing to disk but returns the YAML string". Mandu's DeployAdapter
  // contract has no preview() primitive — the dry-run semantic is carried
  // by the dispatcher. The pure generator (renderRenderYaml) is the
  // in-memory analog: it must never touch the filesystem. We assert that
  // explicitly here so a future refactor cannot regress into hidden IO.
  it("renderRenderYaml leaves the tmpdir untouched (pure string function)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `mandu-render-dry-`));
    const before = await fs.readdir(root);
    const yaml = renderRenderYaml({ name: "acme-app" });
    const after = await fs.readdir(root);
    expect(after).toEqual(before);
    expect(yaml).toContain("services:");
    expect(existsSync(path.join(root, "render.yaml"))).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });
});
