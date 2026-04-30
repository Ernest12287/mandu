/**
 * Tests for `resolveBrainAdapter()` in `adapters/index.ts`.
 *
 * Priority order under `adapter: "auto"`:
 *   1. openai-oauth when token present
 *   2. anthropic-oauth when token present
 *   3. template otherwise — with `needsLogin: true` so interactive
 *      CLIs prompt `mandu brain login --provider=openai` instead of
 *      degrading silently.
 *
 * `telemetryOptOut: true` disables every cloud tier and clears
 * `needsLogin` (the user opted out, so prompting login would be
 * incorrect).
 */

import { describe, it, expect } from "bun:test";
import { resolveBrainAdapter } from "../index";
import { makeMemoryStore } from "./_helpers";
import type { StoredToken } from "../../credentials";

function openaiToken(): StoredToken {
  return { access_token: "oa", provider: "openai" };
}
function anthropicToken(): StoredToken {
  return { access_token: "an", provider: "anthropic" };
}

describe("resolveBrainAdapter — priority order", () => {
  it("picks openai first when both cloud tokens are available", async () => {
    const store = makeMemoryStore({
      openai: openaiToken(),
      anthropic: anthropicToken(),
    });
    const res = await resolveBrainAdapter({
      adapter: "auto",
      credentialStore: store,
      probeChatGPTAuth: () => ({ authenticated: false, path: null }),
    });
    expect(res.resolved).toBe("openai");
    expect(res.adapter.name).toBe("openai-oauth");
    expect(res.needsLogin).toBe(false);
  });

  it("falls to anthropic when only anthropic token present", async () => {
    const store = makeMemoryStore({ anthropic: anthropicToken() });
    const res = await resolveBrainAdapter({
      adapter: "auto",
      credentialStore: store,
      probeChatGPTAuth: () => ({ authenticated: false, path: null }),
    });
    expect(res.resolved).toBe("anthropic");
    expect(res.adapter.name).toBe("anthropic-oauth");
    expect(res.needsLogin).toBe(false);
  });

  it("falls to template with needsLogin=true when no cloud tokens", async () => {
    const store = makeMemoryStore();
    const res = await resolveBrainAdapter({
      adapter: "auto",
      credentialStore: store,
      probeChatGPTAuth: () => ({ authenticated: false, path: null }),
    });
    expect(res.resolved).toBe("template");
    expect(res.adapter.name).toBe("noop");
    expect(res.needsLogin).toBe(true);
    expect(res.reason).toContain("mandu brain login");
  });

  it("picks openai via ChatGPT session token when keychain is empty", async () => {
    const store = makeMemoryStore();
    const res = await resolveBrainAdapter({
      adapter: "auto",
      credentialStore: store,
      probeChatGPTAuth: () => ({ authenticated: true, path: "/tmp/auth.json" }),
    });
    expect(res.resolved).toBe("openai");
    expect(res.needsLogin).toBe(false);
  });
});

describe("resolveBrainAdapter — telemetryOptOut", () => {
  it("skips cloud tiers even when tokens exist", async () => {
    const store = makeMemoryStore({
      openai: openaiToken(),
      anthropic: anthropicToken(),
    });
    const res = await resolveBrainAdapter({
      adapter: "auto",
      telemetryOptOut: true,
      credentialStore: store,
    });
    expect(res.resolved).toBe("template");
    expect(res.needsLogin).toBe(false);
    expect(res.reason).toContain("telemetryOptOut");
  });

  it("falls to template without prompting login (needsLogin=false)", async () => {
    const store = makeMemoryStore();
    const res = await resolveBrainAdapter({
      adapter: "auto",
      telemetryOptOut: true,
      credentialStore: store,
    });
    expect(res.resolved).toBe("template");
    expect(res.needsLogin).toBe(false);
  });
});

describe("resolveBrainAdapter — explicit pins degrade gracefully", () => {
  it("explicit 'openai' without a token degrades to template + needsLogin=true", async () => {
    const store = makeMemoryStore();
    const res = await resolveBrainAdapter({
      adapter: "openai",
      credentialStore: store,
      probeChatGPTAuth: () => ({ authenticated: false, path: null }),
    });
    expect(res.resolved).toBe("template");
    expect(res.needsLogin).toBe(true);
    expect(res.reason).toContain("no token");
  });

  it("explicit 'anthropic' with telemetryOptOut forces template", async () => {
    const store = makeMemoryStore({ anthropic: anthropicToken() });
    const res = await resolveBrainAdapter({
      adapter: "anthropic",
      telemetryOptOut: true,
      credentialStore: store,
    });
    expect(res.resolved).toBe("template");
    expect(res.needsLogin).toBe(false);
    expect(res.reason).toContain("telemetryOptOut");
  });

  it("explicit 'template' is the only no-prompt zero-cost path", async () => {
    const store = makeMemoryStore({ openai: openaiToken() });
    const res = await resolveBrainAdapter({
      adapter: "template",
      credentialStore: store,
    });
    expect(res.resolved).toBe("template");
    expect(res.needsLogin).toBe(false);
  });
});
