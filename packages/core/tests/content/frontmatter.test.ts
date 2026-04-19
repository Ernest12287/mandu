/**
 * Frontmatter parser tests (Issue #199).
 *
 * These tests pin down the MVP YAML subset so we can safely grow the
 * parser later without silently changing semantics for existing
 * projects.
 */

import { describe, test, expect } from "bun:test";
import {
  parseFrontmatter,
  parseSimpleYaml,
  parseScalar,
} from "../../src/content/frontmatter";

describe("parseScalar", () => {
  test("parses booleans and null", () => {
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("false")).toBe(false);
    expect(parseScalar("null")).toBe(null);
    expect(parseScalar("~")).toBe(null);
    expect(parseScalar("")).toBe(null);
  });

  test("parses integers and floats", () => {
    expect(parseScalar("0")).toBe(0);
    expect(parseScalar("42")).toBe(42);
    expect(parseScalar("-7")).toBe(-7);
    expect(parseScalar("3.14")).toBe(3.14);
    expect(parseScalar("-0.5")).toBe(-0.5);
  });

  test("preserves leading-zero strings as strings (IDs like 007)", () => {
    expect(parseScalar("007")).toBe("007");
    expect(parseScalar("0123")).toBe("0123");
  });

  test("strips quotes from scalar strings", () => {
    expect(parseScalar('"hello"')).toBe("hello");
    expect(parseScalar("'world'")).toBe("world");
    expect(parseScalar('"42"')).toBe("42");
  });

  test("parses inline arrays", () => {
    expect(parseScalar("[]")).toEqual([]);
    expect(parseScalar("[a, b, c]")).toEqual(["a", "b", "c"]);
    expect(parseScalar("[1, 2, 3]")).toEqual([1, 2, 3]);
    expect(parseScalar('["a", "b"]')).toEqual(["a", "b"]);
  });

  test("keeps unknown strings unquoted", () => {
    expect(parseScalar("Hello World")).toBe("Hello World");
    expect(parseScalar("2024-01-15")).toBe("2024-01-15");
  });
});

describe("parseSimpleYaml", () => {
  test("parses basic key/value pairs", () => {
    const out = parseSimpleYaml("title: Hello\norder: 3\ndraft: false\n");
    expect(out).toEqual({ title: "Hello", order: 3, draft: false });
  });

  test("handles CRLF-normalized input", () => {
    // Normalization happens in parseFrontmatter; parseSimpleYaml sees LF.
    const out = parseSimpleYaml("a: 1\nb: 2\n");
    expect(out).toEqual({ a: 1, b: 2 });
  });

  test("parses block arrays", () => {
    const src = `tags:
  - alpha
  - beta
  - gamma
title: Story`;
    const out = parseSimpleYaml(src);
    expect(out).toEqual({ tags: ["alpha", "beta", "gamma"], title: "Story" });
  });

  test("parses inline arrays alongside block arrays", () => {
    const src = `inline: [a, b]
title: X
block:
  - x
  - y`;
    const out = parseSimpleYaml(src);
    expect(out).toEqual({ inline: ["a", "b"], title: "X", block: ["x", "y"] });
  });

  test("strips end-of-line comments outside quotes", () => {
    const out = parseSimpleYaml("title: Hello # comment\norder: 5 # rank");
    expect(out).toEqual({ title: "Hello", order: 5 });
  });

  test("preserves '#' inside quoted strings", () => {
    const out = parseSimpleYaml('title: "pricing # free"');
    expect(out.title).toBe("pricing # free");
  });

  test("ignores blank lines and full-line comments", () => {
    const src = `# header
title: A

# middle
order: 1`;
    const out = parseSimpleYaml(src);
    expect(out).toEqual({ title: "A", order: 1 });
  });

  test("empty value without block list becomes null", () => {
    const out = parseSimpleYaml("meta:\ntitle: Hi");
    expect(out).toEqual({ meta: null, title: "Hi" });
  });
});

describe("parseFrontmatter", () => {
  test("returns empty data + full body when no fences", () => {
    const src = "# just a heading\n\nhello";
    const out = parseFrontmatter(src);
    expect(out.data).toEqual({});
    expect(out.body).toBe(src);
    expect(out.raw).toBeUndefined();
  });

  test("parses fenced frontmatter + body", () => {
    const src = `---
title: Intro
order: 1
---

# Hello

Body text here.`;
    const out = parseFrontmatter(src);
    expect(out.data).toEqual({ title: "Intro", order: 1 });
    expect(out.body).toBe("# Hello\n\nBody text here.");
  });

  test("normalizes CRLF line endings", () => {
    const src = "---\r\ntitle: CRLF\r\norder: 2\r\n---\r\nbody";
    const out = parseFrontmatter(src);
    expect(out.data).toEqual({ title: "CRLF", order: 2 });
    expect(out.body).toBe("body");
  });

  test("handles empty body gracefully", () => {
    const src = `---
title: Only meta
---
`;
    const out = parseFrontmatter(src);
    expect(out.data).toEqual({ title: "Only meta" });
    expect(out.body).toBe("");
  });
});
