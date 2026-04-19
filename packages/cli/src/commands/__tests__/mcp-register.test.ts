/**
 * Unit tests for `packages/cli/src/commands/mcp-register.ts`.
 *
 * The command writes into IDE config files. To keep tests hermetic we
 * point `homeDir` at an ephemeral `fs.mkdtemp` directory — the command
 * never touches the user's real `~/.claude/*` or `~/.cursor/*`.
 *
 * We cover the four providers (claude / cursor / continue / aider)
 * across register / remove / dry-run / merge-existing axes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mcpRegister, MANDU_ENTRY_NAME, EXIT_OK, EXIT_USAGE } from "../mcp-register";

const PREFIX = path.join(os.tmpdir(), "mandu-mcp-register-test-");

let tmpHome: string;
let tmpCwd: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(PREFIX + "home-");
  tmpCwd = await fs.mkdtemp(PREFIX + "cwd-");
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpCwd, { recursive: true, force: true });
});

function expectedJsonPath(provider: "claude" | "cursor" | "continue"): string {
  const name = provider === "continue" ? "config.json" : "mcp.json";
  return path.join(tmpHome, `.${provider}`, name);
}

describe("mcp register — claude (JSON)", () => {
  it("creates the config when none exists", async () => {
    const code = await mcpRegister({ ide: "claude", homeDir: tmpHome, cwd: tmpCwd });
    expect(code).toBe(EXIT_OK);
    const confPath = expectedJsonPath("claude");
    expect(existsSync(confPath)).toBe(true);
    const parsed = JSON.parse(await fs.readFile(confPath, "utf8"));
    expect(parsed.mcpServers?.[MANDU_ENTRY_NAME]).toBeDefined();
    expect(parsed.mcpServers[MANDU_ENTRY_NAME].command).toBe("mandu");
  });

  it("preserves unrelated existing config keys + other MCP servers", async () => {
    const confPath = expectedJsonPath("claude");
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(
      confPath,
      JSON.stringify({
        userPreference: "dark",
        mcpServers: { other: { command: "other-cli", args: [] } },
      }),
    );

    const code = await mcpRegister({ ide: "claude", homeDir: tmpHome, cwd: tmpCwd });
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(await fs.readFile(confPath, "utf8"));
    expect(parsed.userPreference).toBe("dark");
    expect(parsed.mcpServers.other).toBeDefined();
    expect(parsed.mcpServers[MANDU_ENTRY_NAME]).toBeDefined();
  });

  it("removes the entry when --remove is passed", async () => {
    // First register.
    await mcpRegister({ ide: "claude", homeDir: tmpHome, cwd: tmpCwd });
    // Then remove.
    const code = await mcpRegister({
      ide: "claude",
      homeDir: tmpHome,
      cwd: tmpCwd,
      remove: true,
    });
    expect(code).toBe(EXIT_OK);
    const confPath = expectedJsonPath("claude");
    const parsed = JSON.parse(await fs.readFile(confPath, "utf8"));
    expect(parsed.mcpServers?.[MANDU_ENTRY_NAME]).toBeUndefined();
  });
});

describe("mcp register — cursor (JSON)", () => {
  it("writes to ~/.cursor/mcp.json by default", async () => {
    const code = await mcpRegister({ ide: "cursor", homeDir: tmpHome, cwd: tmpCwd });
    expect(code).toBe(EXIT_OK);
    expect(existsSync(expectedJsonPath("cursor"))).toBe(true);
  });

  it("creates a .bak sibling when the file already exists", async () => {
    const confPath = expectedJsonPath("cursor");
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, `{"mcpServers": {}}`);

    await mcpRegister({ ide: "cursor", homeDir: tmpHome, cwd: tmpCwd });
    const siblings = await fs.readdir(path.dirname(confPath));
    expect(siblings.some((n) => n.startsWith("mcp.json.bak."))).toBe(true);
  });
});

describe("mcp register — continue (JSON)", () => {
  it("writes to ~/.continue/config.json", async () => {
    const code = await mcpRegister({ ide: "continue", homeDir: tmpHome, cwd: tmpCwd });
    expect(code).toBe(EXIT_OK);
    expect(existsSync(expectedJsonPath("continue"))).toBe(true);
  });

  it("tolerates JSON-C comments in the existing file", async () => {
    const confPath = expectedJsonPath("continue");
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(
      confPath,
      `{\n  // my favourite model\n  "theme": "dark",\n  "mcpServers": {}\n}`,
    );
    const code = await mcpRegister({ ide: "continue", homeDir: tmpHome, cwd: tmpCwd });
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(await fs.readFile(confPath, "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers[MANDU_ENTRY_NAME]).toBeDefined();
  });
});

describe("mcp register — aider (YAML)", () => {
  it("creates .aider.conf.yml in the project cwd", async () => {
    const code = await mcpRegister({ ide: "aider", homeDir: tmpHome, cwd: tmpCwd });
    expect(code).toBe(EXIT_OK);
    const confPath = path.join(tmpCwd, ".aider.conf.yml");
    expect(existsSync(confPath)).toBe(true);
    const body = await fs.readFile(confPath, "utf8");
    expect(body).toContain("mcp:");
    expect(body).toContain(MANDU_ENTRY_NAME);
  });

  it("preserves preamble lines when merging", async () => {
    const confPath = path.join(tmpCwd, ".aider.conf.yml");
    await fs.writeFile(confPath, "model: gpt-4\ntemperature: 0.1\n");
    await mcpRegister({ ide: "aider", homeDir: tmpHome, cwd: tmpCwd });
    const body = await fs.readFile(confPath, "utf8");
    expect(body).toContain("model: gpt-4");
    expect(body).toContain("temperature: 0.1");
    expect(body).toContain("mandu:");
  });

  it("removes the mandu block when --remove is passed", async () => {
    await mcpRegister({ ide: "aider", homeDir: tmpHome, cwd: tmpCwd });
    await mcpRegister({ ide: "aider", homeDir: tmpHome, cwd: tmpCwd, remove: true });
    const body = await fs.readFile(path.join(tmpCwd, ".aider.conf.yml"), "utf8");
    expect(body.includes("mandu:")).toBe(false);
  });
});

describe("mcp register — dry-run", () => {
  it("does not create files under dry-run", async () => {
    const code = await mcpRegister({
      ide: "claude",
      homeDir: tmpHome,
      cwd: tmpCwd,
      dryRun: true,
    });
    expect(code).toBe(EXIT_OK);
    expect(existsSync(expectedJsonPath("claude"))).toBe(false);
  });
});

describe("mcp register — validation", () => {
  it("rejects an unknown --ide value with usage exit code", async () => {
    const code = await mcpRegister({
      // @ts-expect-error — deliberate invalid value for test
      ide: "vim",
      homeDir: tmpHome,
      cwd: tmpCwd,
    });
    expect(code).toBe(EXIT_USAGE);
  });

  it("accepts --ide=all and writes to every provider", async () => {
    const code = await mcpRegister({ ide: "all", homeDir: tmpHome, cwd: tmpCwd });
    expect(code).toBe(EXIT_OK);
    expect(existsSync(expectedJsonPath("claude"))).toBe(true);
    expect(existsSync(expectedJsonPath("cursor"))).toBe(true);
    expect(existsSync(expectedJsonPath("continue"))).toBe(true);
    expect(existsSync(path.join(tmpCwd, ".aider.conf.yml"))).toBe(true);
  });
});

describe("mcp register — token options", () => {
  it("defaults to the ${localEnv:MANDU_MCP_TOKEN} placeholder", async () => {
    await mcpRegister({ ide: "claude", homeDir: tmpHome, cwd: tmpCwd });
    const parsed = JSON.parse(await fs.readFile(expectedJsonPath("claude"), "utf8"));
    expect(parsed.mcpServers[MANDU_ENTRY_NAME].env.MANDU_MCP_TOKEN).toContain("localEnv");
  });

  it("accepts --token=env:VAR and rewrites the placeholder variable", async () => {
    await mcpRegister({
      ide: "claude",
      homeDir: tmpHome,
      cwd: tmpCwd,
      token: "env:CUSTOM_TOKEN",
    });
    const parsed = JSON.parse(await fs.readFile(expectedJsonPath("claude"), "utf8"));
    expect(parsed.mcpServers[MANDU_ENTRY_NAME].env.MANDU_MCP_TOKEN).toContain("CUSTOM_TOKEN");
  });
});
