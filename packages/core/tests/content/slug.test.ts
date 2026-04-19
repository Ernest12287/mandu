/**
 * Slug generator tests (Issue #199).
 */

import { describe, test, expect } from "bun:test";
import { slugFromPath } from "../../src/content/slug";

describe("slugFromPath", () => {
  test("strips common markdown extensions", () => {
    expect(slugFromPath("intro.md")).toBe("intro");
    expect(slugFromPath("intro.mdx")).toBe("intro");
    expect(slugFromPath("intro.markdown")).toBe("intro");
  });

  test("preserves non-markdown extensions", () => {
    // Only .md/.mdx/.markdown are stripped — callers wanting custom
    // behaviour must pass `stripExtensions`. Non-markdown files keep
    // their extension so the slug is still unique.
    expect(slugFromPath("page.html")).toBe("page.html");
  });

  test("normalizes Windows backslashes", () => {
    expect(slugFromPath("docs\\intro.md")).toBe("docs/intro");
    expect(slugFromPath("a\\b\\c.md")).toBe("a/b/c");
  });

  test("drops trailing /index", () => {
    expect(slugFromPath("docs/index.md")).toBe("docs");
    expect(slugFromPath("index.md")).toBe("");
    expect(slugFromPath("api/v1/index.md")).toBe("api/v1");
  });

  test("kebab-cases per segment by default", () => {
    expect(slugFromPath("GettingStarted.md")).toBe("getting-started");
    expect(slugFromPath("Under_Score.md")).toBe("under-score");
    expect(slugFromPath("docs/MyPage.md")).toBe("docs/my-page");
  });

  test("preserves casing when kebabCase is false", () => {
    expect(slugFromPath("API_v2.md", { kebabCase: false })).toBe("API_v2");
    expect(slugFromPath("docs/GettingStarted.md", { kebabCase: false })).toBe(
      "docs/GettingStarted"
    );
  });

  test("collapses duplicate slashes", () => {
    expect(slugFromPath("foo//bar.md")).toBe("foo/bar");
    expect(slugFromPath("/a/b.md")).toBe("a/b");
  });

  test("accepts extra extension overrides", () => {
    expect(
      slugFromPath("page.custom", { stripExtensions: [".custom"] })
    ).toBe("page");
  });

  test("honors dropIndex: false", () => {
    expect(slugFromPath("docs/index.md", { dropIndex: false })).toBe(
      "docs/index"
    );
  });
});
