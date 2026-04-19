/**
 * Artifact writer with secret-leak guard.
 *
 * Every adapter that emits config files goes through {@link writeArtifact}.
 * The guard inspects the proposed content for any secret value the
 * dispatcher has stashed for this deploy and refuses the write if one
 * leaks, raising {@link SecretLeakError}.
 *
 * This lets adapters compose templates without memorizing which fields
 * are secret — if a developer accidentally interpolates a token, the
 * write fails at the boundary rather than shipping plaintext to git.
 *
 * @module cli/commands/deploy/artifact-writer
 */
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

export class SecretLeakError extends Error {
  readonly code = "DEPLOY_SECRET_LEAKED_IN_ARTIFACT";
  readonly secretName: string;
  readonly artifactPath: string;
  constructor(secretName: string, artifactPath: string) {
    super(
      `Refusing to write ${artifactPath}: contains plaintext value of secret ${secretName}`
    );
    this.name = "SecretLeakError";
    this.secretName = secretName;
    this.artifactPath = artifactPath;
  }
}

export interface WriteArtifactOptions {
  /** Absolute path to the artifact. */
  readonly path: string;
  /** File content (text). */
  readonly content: string;
  /**
   * Map of `{ secretName: value }` that MUST NOT appear verbatim in the
   * content. An empty map disables the check.
   */
  readonly forbiddenValues?: ReadonlyMap<string, string>;
  /**
   * If `true` and the target file already exists, skip the write and
   * return `preserved: true`. Used for files we offer to scaffold once
   * but never want to overwrite (e.g. `vercel.json`, `fly.toml`).
   */
  readonly preserveIfExists?: boolean;
}

export interface WriteArtifactResult {
  /** Absolute path written (or preserved). */
  readonly path: string;
  /** Whether an existing file was kept. */
  readonly preserved: boolean;
}

export async function writeArtifact(
  options: WriteArtifactOptions
): Promise<WriteArtifactResult> {
  if (options.preserveIfExists && existsSync(options.path)) {
    return { path: options.path, preserved: true };
  }
  if (options.forbiddenValues && options.forbiddenValues.size > 0) {
    for (const [name, value] of options.forbiddenValues) {
      // Empty or very short values are skipped to avoid false positives
      // on common placeholders like "1" or "on".
      if (typeof value !== "string" || value.length < 8) continue;
      if (options.content.includes(value)) {
        throw new SecretLeakError(name, options.path);
      }
    }
  }
  await fs.mkdir(path.dirname(options.path), { recursive: true });
  await fs.writeFile(options.path, options.content, "utf8");
  return { path: options.path, preserved: false };
}

/**
 * Merge a key-value map into an existing `.dockerignore`-style file. Keeps
 * existing entries; appends new ones that aren't already present. Useful
 * for `.dockerignore`, `.gitignore` augmentation without stomping user
 * lines.
 */
export async function appendUniqueLines(
  targetPath: string,
  newLines: ReadonlyArray<string>
): Promise<void> {
  const lines = new Set<string>();
  if (existsSync(targetPath)) {
    const existing = await fs.readFile(targetPath, "utf8");
    for (const line of existing.split(/\r?\n/)) {
      lines.add(line);
    }
  }
  const before = lines.size;
  for (const line of newLines) {
    lines.add(line);
  }
  if (lines.size === before) return;
  const content = [...lines].filter((l) => l.length > 0).join("\n") + "\n";
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}
