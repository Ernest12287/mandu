import { describe, expect, it } from "bun:test";
import { ManduConfigSchema } from "../../src/config/validate";

describe("ManduConfigSchema", () => {
  it("accepts adapter instances in config files", () => {
    const result = ManduConfigSchema.safeParse({
      adapter: {
        name: "test-adapter",
        createServer() {
          return {
            fetch: async () => new Response("ok"),
            listen: async () => ({ port: 3000, hostname: "localhost" }),
            close: async () => {},
          };
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid adapter objects", () => {
    const result = ManduConfigSchema.safeParse({
      adapter: {
        name: "broken-adapter",
      },
    });

    expect(result.success).toBe(false);
  });
});
