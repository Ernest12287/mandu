import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { plainFallback, renderMarkdown } from "../markdown";

const ANSI_ESC = /\x1b\[/;

describe("renderMarkdown", () => {
  const envSnapshot = {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    CI: process.env.CI,
    TERM: process.env.TERM,
  };

  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    (process.stdout as { isTTY?: boolean }).isTTY = true;
  });

  afterEach(() => {
    for (const key of ["NO_COLOR", "FORCE_COLOR", "CI", "TERM"] as const) {
      const prev = envSnapshot[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    (process.stdout as { isTTY?: boolean }).isTTY = originalIsTTY;
  });

  it("emits ANSI escape codes when rich output is supported", () => {
    const out = renderMarkdown("# Hello\n**bold** text");
    expect(out).toMatch(ANSI_ESC);
    expect(out).toContain("Hello");
    expect(out).toContain("bold");
  });

  it("returns plain text when rich output is not supported (non-TTY)", () => {
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    const out = renderMarkdown("# Hello\n**bold** text");
    expect(out).not.toMatch(ANSI_ESC);
    expect(out).toContain("Hello");
    expect(out).toContain("bold");
  });

  it("respects NO_COLOR environment variable", () => {
    process.env.NO_COLOR = "1";
    const out = renderMarkdown("# Hello\n`code` here");
    expect(out).not.toMatch(ANSI_ESC);
    expect(out).toContain("Hello");
    expect(out).toContain("code");
  });

  it("uses plain output when opts.plain overrides", () => {
    const out = renderMarkdown("# Title\n**bold**", { plain: true });
    expect(out).not.toMatch(ANSI_ESC);
    expect(out).toContain("Title");
    expect(out).toContain("bold");
  });

  it("respects CI environment variable", () => {
    process.env.CI = "true";
    const out = renderMarkdown("# CI run\n**build**");
    expect(out).not.toMatch(ANSI_ESC);
    expect(out).toContain("CI run");
  });

  it("handles TERM=dumb", () => {
    process.env.TERM = "dumb";
    const out = renderMarkdown("# Simple");
    expect(out).not.toMatch(ANSI_ESC);
    expect(out).toContain("Simple");
  });

  it("returns empty string for non-string input", () => {
    // @ts-expect-error — intentional misuse
    expect(renderMarkdown(undefined)).toBe("");
    // @ts-expect-error — intentional misuse
    expect(renderMarkdown(null)).toBe("");
  });

  it("accepts custom column width", () => {
    const out = renderMarkdown("hello world", { columns: 40 });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("renders the same content consistently across calls", () => {
    const input = "# Heading\n\n- one\n- two";
    const a = renderMarkdown(input, { plain: true });
    const b = renderMarkdown(input, { plain: true });
    expect(a).toBe(b);
  });
});

describe("plainFallback", () => {
  it("removes fenced code block markers but keeps the body", () => {
    const input = "```ts\nconst x = 1;\n```";
    const out = plainFallback(input);
    expect(out).not.toContain("```");
    expect(out).toContain("const x = 1;");
  });

  it("removes inline code markers", () => {
    expect(plainFallback("use `bun run dev`")).toBe("use bun run dev");
  });

  it("removes bold markers", () => {
    expect(plainFallback("**bold** text")).toBe("bold text");
  });

  it("replaces links with their label", () => {
    expect(plainFallback("[docs](https://mandu.dev/docs)")).toBe("docs");
  });

  it("handles empty input", () => {
    expect(plainFallback("")).toBe("");
  });

  it("leaves headings and lists intact", () => {
    const input = "# Title\n\n- one\n- two";
    expect(plainFallback(input)).toBe(input);
  });
});
