/**
 * Tests for the `test` block added to `ManduConfigSchema` in Phase 12.1.
 *
 * Covers: defaults, valid / invalid inputs, strict-mode rejection of
 * misspelt keys, and the exported `resolveTestConfig` helper.
 */
import { describe, it, expect } from "bun:test";
import {
  ManduConfigSchema,
  resolveTestConfig,
  type ValidatedTestConfig,
} from "../../src/config/validate";

describe("test block — defaults", () => {
  it("fills in all four sub-blocks when `test` is omitted", () => {
    const cfg = ManduConfigSchema.parse({});
    expect(cfg.test).toBeDefined();
    expect(cfg.test.unit).toBeDefined();
    expect(cfg.test.integration).toBeDefined();
    expect(cfg.test.e2e).toBeDefined();
    expect(cfg.test.coverage).toBeDefined();
  });

  it("applies unit defaults: *.test.ts glob + 30s timeout", () => {
    const cfg = ManduConfigSchema.parse({});
    expect(cfg.test.unit.include).toContain("**/*.test.ts");
    expect(cfg.test.unit.include).toContain("**/*.test.tsx");
    expect(cfg.test.unit.timeout).toBe(30_000);
    expect(cfg.test.unit.exclude).toContain("node_modules/**");
  });

  it("applies integration defaults: in-memory sqlite + memory session", () => {
    const cfg = ManduConfigSchema.parse({});
    expect(cfg.test.integration.dbUrl).toBe("sqlite::memory:");
    expect(cfg.test.integration.sessionStore).toBe("memory");
    expect(cfg.test.integration.timeout).toBe(60_000);
  });
});

describe("test block — valid overrides", () => {
  it("accepts fully-customised unit block", () => {
    const cfg = ManduConfigSchema.parse({
      test: {
        unit: {
          include: ["src/**/*.spec.ts"],
          exclude: ["src/generated/**"],
          timeout: 5000,
        },
      },
    });
    expect(cfg.test.unit.include).toEqual(["src/**/*.spec.ts"]);
    expect(cfg.test.unit.exclude).toEqual(["src/generated/**"]);
    expect(cfg.test.unit.timeout).toBe(5000);
  });

  it("accepts alternate sqlite session store", () => {
    const cfg = ManduConfigSchema.parse({
      test: { integration: { sessionStore: "sqlite" } },
    });
    expect(cfg.test.integration.sessionStore).toBe("sqlite");
  });

  it("accepts coverage thresholds", () => {
    const cfg = ManduConfigSchema.parse({
      test: { coverage: { lines: 80, branches: 70 } },
    });
    expect(cfg.test.coverage.lines).toBe(80);
    expect(cfg.test.coverage.branches).toBe(70);
  });
});

describe("test block — validation errors", () => {
  it("rejects negative unit timeout", () => {
    const result = ManduConfigSchema.safeParse({
      test: { unit: { timeout: -1 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty include array elements", () => {
    const result = ManduConfigSchema.safeParse({
      test: { unit: { include: [""] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown sessionStore", () => {
    const result = ManduConfigSchema.safeParse({
      test: { integration: { sessionStore: "redis" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects coverage threshold outside 0-100", () => {
    const result = ManduConfigSchema.safeParse({
      test: { coverage: { lines: 150 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects misspelt top-level test key under strict mode", () => {
    // `.strict()` on TestConfigSchema means unknown keys fail.
    const result = ManduConfigSchema.safeParse({
      test: { units: { timeout: 1000 } }, // typo
    });
    expect(result.success).toBe(false);
  });
});

describe("resolveTestConfig helper", () => {
  it("returns a fully-populated ValidatedTestConfig", () => {
    const resolved: ValidatedTestConfig = resolveTestConfig();
    expect(resolved.unit.timeout).toBe(30_000);
    expect(resolved.integration.dbUrl).toBe("sqlite::memory:");
  });

  it("accepts partial overrides", () => {
    const resolved = resolveTestConfig({ unit: { timeout: 1000 } });
    expect(resolved.unit.timeout).toBe(1000);
    // Other defaults still flow through.
    expect(resolved.integration.sessionStore).toBe("memory");
  });

  it("throws on invalid input instead of returning {}", () => {
    expect(() => resolveTestConfig({ integration: { sessionStore: "nope" } })).toThrow();
  });
});
