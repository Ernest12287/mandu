/**
 * MCP tool — `mandu.deploy.preview` tests.
 */

import { describe, it, expect } from "bun:test";
import {
  deployPreviewToolDefinitions,
  deployPreviewTools,
  parseDeployPreviewOutput,
} from "../../src/tools/deploy-preview";

describe("deployPreviewToolDefinitions", () => {
  it("declares the `mandu.deploy.preview` tool", () => {
    expect(deployPreviewToolDefinitions).toHaveLength(1);
    const def = deployPreviewToolDefinitions[0];
    expect(def.name).toBe("mandu.deploy.preview");
    expect(def.annotations?.readOnlyHint).toBe(true);
  });

  it("requires a target and constrains the enum", () => {
    const def = deployPreviewToolDefinitions[0];
    const schema = def.inputSchema as {
      properties?: { target?: { enum?: string[] } };
      required?: string[];
    };
    expect(schema.required).toContain("target");
    expect(schema.properties?.target?.enum).toContain("docker");
    expect(schema.properties?.target?.enum).toContain("fly");
    expect(schema.properties?.target?.enum).toContain("vercel");
    expect(schema.properties?.target?.enum).toContain("docker-compose");
  });
});

describe("deployPreviewTools handler map", () => {
  it("returns a handler", () => {
    const h = deployPreviewTools("/fake/root");
    expect(typeof h["mandu.deploy.preview"]).toBe("function");
  });

  it("rejects missing target", async () => {
    const h = deployPreviewTools("/fake/root");
    const result = (await h["mandu.deploy.preview"]({})) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("target");
  });

  it("rejects unknown target", async () => {
    const h = deployPreviewTools("/fake/root");
    const result = (await h["mandu.deploy.preview"]({ target: "s3" })) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("target");
  });

  it("rejects non-string target", async () => {
    const h = deployPreviewTools("/fake/root");
    const result = (await h["mandu.deploy.preview"]({ target: 42 })) as {
      error?: string;
    };
    expect(result.error).toBeDefined();
  });
});

describe("parseDeployPreviewOutput", () => {
  it("parses `+` and `•` artifact markers with descriptions", () => {
    const raw = [
      "📦 Adapter prepare: docker",
      "  + .mandu/deploy/docker/Dockerfile — production image",
      "  • .mandu/deploy/docker/.dockerignore",
      "  + .mandu/deploy/docker/entrypoint.sh — startup script",
      "",
      "✅ Dry-run complete. No provider CLI invoked.",
    ].join("\n");

    const parsed = parseDeployPreviewOutput(raw);
    expect(parsed.artifacts).toHaveLength(3);
    expect(parsed.artifacts[0].path).toBe(".mandu/deploy/docker/Dockerfile");
    expect(parsed.artifacts[0].preserved).toBe(false);
    expect(parsed.artifacts[0].description).toBe("production image");
    expect(parsed.artifacts[1].preserved).toBe(true);
    expect(parsed.artifacts[1].description).toBeUndefined();
    expect(parsed.artifacts[2].description).toBe("startup script");
  });

  it("collects warnings from ⚠️ lines", () => {
    const raw = [
      "⚠️  Missing required secret: FLY_API_TOKEN",
      "+ artifact.json",
      "warning: check passed with warnings",
    ].join("\n");
    const parsed = parseDeployPreviewOutput(raw);
    expect(parsed.warnings.length).toBe(2);
    expect(parsed.warnings[0]).toContain("FLY_API_TOKEN");
  });

  it("returns an empty artifact list on clean output", () => {
    const parsed = parseDeployPreviewOutput("Nothing to see here");
    expect(parsed.artifacts).toEqual([]);
  });

  it("captures a fenced diff block when present", () => {
    const raw = [
      "Changes:",
      "```",
      "- old line",
      "+ new line",
      "```",
    ].join("\n");
    const parsed = parseDeployPreviewOutput(raw);
    expect(parsed.diff).toBeDefined();
    expect(parsed.diff).toContain("new line");
  });

  it("is deterministic", () => {
    const raw = "  + a.json\n  • b.json";
    expect(parseDeployPreviewOutput(raw)).toEqual(parseDeployPreviewOutput(raw));
  });
});
