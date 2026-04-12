import { describe, expect, it } from "bun:test";
import { buildFetchCacheKey } from "../../src/client/use-fetch";

describe("buildFetchCacheKey", () => {
  it("includes the HTTP method in the cache key", () => {
    const getKey = buildFetchCacheKey("/api/posts", {
      method: "GET",
      queryKey: '{"page":1}',
    });
    const postKey = buildFetchCacheKey("/api/posts", {
      method: "POST",
      queryKey: '{"page":1}',
    });

    expect(getKey).not.toBe(postKey);
  });

  it("distinguishes requests by headers and body", () => {
    const base = buildFetchCacheKey("/api/posts", {
      method: "POST",
      headersKey: '{"x-env":"a"}',
      bodyKey: '{"title":"one"}',
    });
    const differentHeaders = buildFetchCacheKey("/api/posts", {
      method: "POST",
      headersKey: '{"x-env":"b"}',
      bodyKey: '{"title":"one"}',
    });
    const differentBody = buildFetchCacheKey("/api/posts", {
      method: "POST",
      headersKey: '{"x-env":"a"}',
      bodyKey: '{"title":"two"}',
    });

    expect(base).not.toBe(differentHeaders);
    expect(base).not.toBe(differentBody);
  });
});
