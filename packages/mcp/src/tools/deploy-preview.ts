/**
 * MCP tool — `mandu.deploy.preview`
 *
 * Invokes `mandu deploy --target=<target> --dry-run` in a child process
 * and parses the stdout into a structured artifact list.
 *
 * Safety:
 *   • `--dry-run` is *always* passed. The tool cannot be coerced into
 *     triggering a real deployment.
 *   • Target is validated against the known adapter list; unknown values
 *     fail fast without spawning a process.
 *   • The child has a 5-minute ceiling; it's killed if it overruns.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "bun";
import path from "path";

// Mirror the adapter list from `packages/cli/src/commands/deploy/types.ts`.
// Keep this in sync manually — imports from @mandujs/cli would introduce a
// cross-package coupling for a single string-union.
const DEPLOY_TARGETS = [
  "docker",
  "fly",
  "vercel",
  "railway",
  "netlify",
  "cf-pages",
  "docker-compose",
] as const;
type DeployTarget = (typeof DEPLOY_TARGETS)[number];
const VALID_TARGET_SET = new Set<string>(DEPLOY_TARGETS);

interface DeployPreviewInput {
  target?: string;
}

interface ArtifactEntry {
  path: string;
  preserved: boolean;
  description?: string;
}

interface DeployPreviewResult {
  target: DeployTarget;
  mode: "dry-run";
  artifact_list: ArtifactEntry[];
  warnings: string[];
  /** Text diff extracted from the preview output, if present. */
  diff?: string;
  exit_code: number;
  /** Trailing 2000 chars of stdout for diagnostic context. */
  stdout_tail?: string;
  /** Trailing 2000 chars of stderr for diagnostic context. */
  stderr_tail?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 5 * 60_000;

function validateInput(raw: Record<string, unknown>): {
  ok: true;
  target: DeployTarget;
} | { ok: false; error: string; field: string; hint: string } {
  const target = raw.target;
  if (typeof target !== "string" || target.length === 0) {
    return {
      ok: false,
      error: "'target' is required",
      field: "target",
      hint: `Pass one of: ${DEPLOY_TARGETS.join(", ")}`,
    };
  }
  if (!VALID_TARGET_SET.has(target)) {
    return {
      ok: false,
      error: `Unknown deploy target: ${target}`,
      field: "target",
      hint: `Supported: ${DEPLOY_TARGETS.join(", ")}`,
    };
  }
  return { ok: true, target: target as DeployTarget };
}

// ─────────────────────────────────────────────────────────────────────────
// Output parsing
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse the CLI's artifact-rendering block:
 *
 *   📦 Adapter prepare: docker
 *     + .mandu/deploy/docker/Dockerfile — production image
 *     • .mandu/deploy/docker/.dockerignore
 *     + .mandu/deploy/docker/entrypoint.sh
 *
 * Returns `preserved=true` for `•` (existing) and `false` for `+` (new).
 */
export function parseDeployPreviewOutput(raw: string): {
  artifacts: ArtifactEntry[];
  warnings: string[];
  diff?: string;
} {
  const lines = raw.split(/\r?\n/);
  const artifacts: ArtifactEntry[] = [];
  const warnings: string[] = [];
  const diffLines: string[] = [];

  let inDiff = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();

    // Diff mode gates the other regexes: inside a fenced block we don't
    // re-interpret `+` / `•` as artifact markers.
    if (inDiff) {
      if (/^```$/.test(trimmed)) {
        inDiff = false;
      } else {
        diffLines.push(line);
      }
      continue;
    }

    if (!trimmed) continue;

    // Opening of a diff block: triple-backtick (optionally language-tagged)
    // or an unfenced `diff --git` header.
    if (/^```\S*$/.test(trimmed)) {
      inDiff = true;
      continue;
    }
    if (/^diff\s+--git\s/.test(trimmed)) {
      inDiff = true;
      diffLines.push(trimmed);
      continue;
    }

    // Artifact: prefix `+` or `•` after leading whitespace.
    const artifactMatch = /^([+•])\s+(.+)$/.exec(trimmed);
    if (artifactMatch) {
      const marker = artifactMatch[1];
      const rest = artifactMatch[2];
      const emDashIdx = rest.indexOf(" — ");
      const p = emDashIdx >= 0 ? rest.slice(0, emDashIdx).trim() : rest.trim();
      const desc = emDashIdx >= 0 ? rest.slice(emDashIdx + 3).trim() : undefined;
      artifacts.push({
        path: p,
        preserved: marker === "•",
        ...(desc ? { description: desc } : {}),
      });
      continue;
    }

    // Warning: lines that start with ⚠️ or "Warning:"
    if (/^\s*(?:⚠️|warning:)/i.test(trimmed)) {
      warnings.push(trimmed.replace(/^⚠️\s*/u, "").replace(/^warning:\s*/i, "").trim());
      continue;
    }
  }

  const result: { artifacts: ArtifactEntry[]; warnings: string[]; diff?: string } = {
    artifacts,
    warnings,
  };
  if (diffLines.length > 0) {
    result.diff = diffLines.join("\n").trim();
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Child process invocation
// ─────────────────────────────────────────────────────────────────────────

function tailString(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return s.slice(-max);
}

async function resolveManduCommand(projectRoot: string): Promise<string[]> {
  const localBin = path.join(projectRoot, "node_modules", ".bin", "mandu");
  try {
    const f = Bun.file(localBin);
    if (await f.exists()) {
      return ["bun", "run", localBin];
    }
  } catch {}

  const monorepoCli = path.resolve(projectRoot, "packages", "cli", "src", "main.ts");
  try {
    const f = Bun.file(monorepoCli);
    if (await f.exists()) {
      return ["bun", "run", monorepoCli];
    }
  } catch {}

  return ["mandu"];
}

async function runProcess(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const handle = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode: exitCode ?? 1, timedOut };
  } finally {
    clearTimeout(handle);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────

async function deployPreview(
  projectRoot: string,
  input: DeployPreviewInput,
): Promise<DeployPreviewResult | { error: string; field?: string; hint?: string }> {
  const validated = validateInput(input as Record<string, unknown>);
  if (!validated.ok) {
    return {
      error: validated.error,
      field: validated.field,
      hint: validated.hint,
    };
  }

  const { target } = validated;
  const base = await resolveManduCommand(projectRoot);
  const cmd = [...base, "deploy", `--target=${target}`, "--dry-run"];

  let proc: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
  try {
    proc = await runProcess(cmd, projectRoot, COMMAND_TIMEOUT_MS);
  } catch (err) {
    return {
      error: `Failed to spawn deploy preview: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Verify that @mandujs/cli is installed and accessible",
    };
  }

  const parsed = parseDeployPreviewOutput(`${proc.stdout}\n${proc.stderr}`);

  const result: DeployPreviewResult = {
    target,
    mode: "dry-run",
    artifact_list: parsed.artifacts,
    warnings: parsed.warnings,
    exit_code: proc.exitCode,
    stdout_tail: tailString(proc.stdout),
    stderr_tail: tailString(proc.stderr),
  };
  if (parsed.diff) result.diff = parsed.diff;
  if (proc.timedOut) result.warnings.push("deploy preview timed out");
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool definition + handler map
// ─────────────────────────────────────────────────────────────────────────

export const deployPreviewToolDefinitions: Tool[] = [
  {
    name: "mandu.deploy.preview",
    description:
      "Preview a deployment by running `mandu deploy --target=<t> --dry-run`. Returns the structured artifact list, parsed warnings, and any diff the adapter emits. Always dry-run — this tool cannot trigger a real deployment.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: [...DEPLOY_TARGETS],
          description:
            "Deployment adapter target. Each adapter controls the artifact set — see `mandu deploy --help` for details.",
        },
      },
      required: ["target"],
    },
  },
];

export function deployPreviewTools(projectRoot: string) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    "mandu.deploy.preview": async (args) =>
      deployPreview(projectRoot, args as DeployPreviewInput),
  };
  return handlers;
}
