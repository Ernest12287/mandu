/**
 * Tests for the Phase 18.χ accessibility audit runner.
 *
 * Philosophy: we never actually install axe-core/jsdom in the test
 * environment — that would both contradict the "optional peerDep"
 * contract and slow every `bun test` run by a full second. Instead
 * each test injects `axeLoader` + `domLoader` fakes and asserts on the
 * report shape. A single "no deps installed" case exercises the real
 * resolution path by leaving both loaders undefined.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { runAudit, formatAuditReport } from "../run-audit";
import type { AuditImpact } from "../types";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mandu-a11y-"));
}

async function writeHtml(dir: string, name: string, html: string): Promise<string> {
  const full = path.join(dir, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, html, "utf-8");
  return full;
}

/**
 * Fake axe-core handle. Returns the violations that the test preloads
 * into `queued` for the next `.run()` call. Enables multi-file
 * scenarios where each file yields a different result.
 */
function createFakeAxe(queued: Array<unknown>) {
  let i = 0;
  return {
    default: {
      async run() {
        const next = queued[i] ?? { violations: [] };
        i += 1;
        return next;
      },
    },
  };
}

/** A DOM provider stub that returns a no-op window. axe never touches
 *  it because the fake axe above ignores its `context` argument. */
const fakeDom = {
  kind: "jsdom" as const,
  async fromHtml() {
    return {
      window: { document: {} },
      dispose() { /* no-op */ },
    };
  },
};

describe("runAudit — dependency resolution", () => {
  it("returns axe-missing when axeLoader rejects (graceful degradation)", async () => {
    const report = await runAudit([], {
      axeLoader: async () => { throw new Error("Cannot find module 'axe-core'"); },
    });
    expect(report.outcome).toBe("axe-missing");
    expect(report.filesScanned).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.note).toMatch(/axe-core not installed/);
    expect(report.durationMs).toBe(0);
  });

  it("returns axe-missing when no DOM provider is available", async () => {
    const report = await runAudit([], {
      axeLoader: async () => createFakeAxe([]),
      domLoader: async () => null,
    });
    expect(report.outcome).toBe("axe-missing");
    expect(report.note).toMatch(/DOM provider/);
  });

  it("treats loader returning non-axe-shape as missing", async () => {
    const report = await runAudit([], {
      axeLoader: async () => ({ notAxe: true }),
    });
    expect(report.outcome).toBe("axe-missing");
  });
});

describe("runAudit — real audit flow", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkTmp(); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("reports outcome=ok when no violations fire", async () => {
    const file = await writeHtml(tmp, "clean.html", "<html><body><h1>Hi</h1></body></html>");
    const report = await runAudit([file], {
      axeLoader: async () => createFakeAxe([{ violations: [] }]),
      domLoader: async () => fakeDom,
    });
    expect(report.outcome).toBe("ok");
    expect(report.filesScanned).toBe(1);
    expect(report.violations).toEqual([]);
  });

  it("aggregates violations across multiple files with per-file attribution", async () => {
    const a = await writeHtml(tmp, "a.html", "<html></html>");
    const b = await writeHtml(tmp, "b.html", "<html></html>");
    const violationA = {
      id: "image-alt",
      impact: "serious" as AuditImpact,
      help: "Images must have alternate text",
      helpUrl: "https://axe.dev/image-alt",
      nodes: [{ target: ["html > body > img"], failureSummary: "missing alt" }],
    };
    const violationB = {
      id: "color-contrast",
      impact: "critical" as AuditImpact,
      help: "Elements must have sufficient contrast",
      nodes: [{ target: "html > body > p", failureSummary: "1.2:1 ratio" }],
    };
    const report = await runAudit([a, b], {
      axeLoader: async () =>
        createFakeAxe([
          { violations: [violationA] },
          { violations: [violationB] },
        ]),
      domLoader: async () => fakeDom,
    });
    expect(report.outcome).toBe("violations");
    expect(report.filesScanned).toBe(2);
    expect(report.violations.length).toBe(2);
    expect(report.violations[0].file).toBe(path.resolve(a));
    expect(report.violations[1].file).toBe(path.resolve(b));
    expect(report.impactCounts.serious).toBe(1);
    expect(report.impactCounts.critical).toBe(1);
    expect(report.impactCounts.minor).toBe(0);
  });

  it("drops violations below minImpact threshold", async () => {
    const file = await writeHtml(tmp, "page.html", "<html></html>");
    const report = await runAudit([file], {
      minImpact: "serious",
      axeLoader: async () =>
        createFakeAxe([
          {
            violations: [
              { id: "minor-rule", impact: "minor", help: "x", nodes: [] },
              { id: "moderate-rule", impact: "moderate", help: "y", nodes: [] },
              { id: "serious-rule", impact: "serious", help: "z", nodes: [{ target: "x" }] },
              { id: "critical-rule", impact: "critical", help: "w", nodes: [{ target: "y" }] },
            ],
          },
        ]),
      domLoader: async () => fakeDom,
    });
    expect(report.violations.map((v) => v.rule)).toEqual([
      "serious-rule",
      "critical-rule",
    ]);
    expect(report.impactCounts.minor).toBe(0);
    expect(report.impactCounts.moderate).toBe(0);
  });

  it("attaches fixHint for recognised rule ids", async () => {
    const file = await writeHtml(tmp, "form.html", "<html></html>");
    const report = await runAudit([file], {
      axeLoader: async () =>
        createFakeAxe([
          {
            violations: [
              { id: "label", impact: "serious", help: "Labels", nodes: [{ target: "input" }] },
              { id: "unknown-rule-xyz", impact: "critical", help: "?", nodes: [{ target: "div" }] },
            ],
          },
        ]),
      domLoader: async () => fakeDom,
    });
    const labelV = report.violations.find((v) => v.rule === "label")!;
    const unknownV = report.violations.find((v) => v.rule === "unknown-rule-xyz")!;
    expect(labelV.fixHint).toMatch(/label/i);
    expect(unknownV.fixHint).toBeUndefined();
  });

  it("caps node list at 10 per violation and truncates long HTML snippets", async () => {
    const file = await writeHtml(tmp, "big.html", "<html></html>");
    const manyNodes = Array.from({ length: 25 }, (_, i) => ({
      target: [`#node${i}`],
      failureSummary: "x",
      html: "<div>" + "a".repeat(500) + "</div>",
    }));
    const report = await runAudit([file], {
      axeLoader: async () =>
        createFakeAxe([
          { violations: [{ id: "landmark-one-main", impact: "moderate", help: "m", nodes: manyNodes }] },
        ]),
      domLoader: async () => fakeDom,
    });
    const v = report.violations[0];
    expect(v.nodes.length).toBe(10);
    for (const n of v.nodes) {
      expect(n.html!.length).toBeLessThanOrEqual(300);
      expect(n.html!.endsWith("...")).toBe(true);
    }
  });

  it("skips unreadable files without failing the whole run", async () => {
    const good = await writeHtml(tmp, "good.html", "<html></html>");
    const missing = path.join(tmp, "does-not-exist.html");
    const report = await runAudit([missing, good], {
      axeLoader: async () =>
        createFakeAxe([
          { violations: [] },
        ]),
      domLoader: async () => fakeDom,
    });
    expect(report.filesScanned).toBe(1);
    expect(report.outcome).toBe("ok");
  });

  it("honours maxFiles cap", async () => {
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(await writeHtml(tmp, `p${i}.html`, "<html></html>"));
    }
    const report = await runAudit(files, {
      maxFiles: 2,
      axeLoader: async () =>
        createFakeAxe([
          { violations: [] },
          { violations: [] },
          { violations: [] },
          { violations: [] },
          { violations: [] },
        ]),
      domLoader: async () => fakeDom,
    });
    expect(report.filesScanned).toBe(2);
  });

  it("produces a JSON-serialisable report (stable shape contract)", async () => {
    const file = await writeHtml(tmp, "x.html", "<html></html>");
    const report = await runAudit([file], {
      axeLoader: async () =>
        createFakeAxe([
          {
            violations: [
              {
                id: "image-alt",
                impact: "serious",
                help: "Images",
                helpUrl: "https://x",
                nodes: [{ target: ["img"], failureSummary: "s" }],
              },
            ],
          },
        ]),
      domLoader: async () => fakeDom,
    });
    const roundtrip = JSON.parse(JSON.stringify(report));
    expect(roundtrip).toMatchObject({
      outcome: "violations",
      filesScanned: 1,
      minImpact: "minor",
    });
    expect(roundtrip.violations[0]).toMatchObject({
      rule: "image-alt",
      impact: "serious",
      help: "Images",
      fixHint: expect.any(String),
    });
    expect(Array.isArray(roundtrip.violations[0].nodes)).toBe(true);
  });
});

describe("formatAuditReport", () => {
  it("renders an actionable message when deps are missing", () => {
    const text = formatAuditReport({
      outcome: "axe-missing",
      filesScanned: 0,
      violations: [],
      impactCounts: { minor: 0, moderate: 0, serious: 0, critical: 0 },
      minImpact: "minor",
      durationMs: 0,
      note: "axe-core not installed — skipping audit",
    });
    expect(text).toMatch(/bun add -d axe-core jsdom/);
  });

  it("prints a PASS summary when there are zero violations", () => {
    const text = formatAuditReport({
      outcome: "ok",
      filesScanned: 4,
      violations: [],
      impactCounts: { minor: 0, moderate: 0, serious: 0, critical: 0 },
      minImpact: "minor",
      durationMs: 12,
    });
    expect(text).toMatch(/PASS/);
    expect(text).toMatch(/Files scanned: 4/);
  });

  it("groups violations by rule and surfaces fix hints + doc links", () => {
    const text = formatAuditReport({
      outcome: "violations",
      filesScanned: 2,
      violations: [
        {
          file: "a.html",
          rule: "image-alt",
          impact: "serious",
          help: "Images must have alt",
          helpUrl: "https://example/image-alt",
          nodes: [{ target: "img", failureSummary: "x" }],
          fixHint: "Add alt attribute",
        },
        {
          file: "b.html",
          rule: "image-alt",
          impact: "serious",
          help: "Images must have alt",
          nodes: [{ target: "img", failureSummary: "x" }],
        },
      ],
      impactCounts: { minor: 0, moderate: 0, serious: 2, critical: 0 },
      minImpact: "minor",
      durationMs: 45,
    });
    expect(text).toMatch(/\[SERIOUS\] image-alt/);
    expect(text).toMatch(/Fix: Add alt attribute/);
    expect(text).toMatch(/Docs: https:\/\/example\/image-alt/);
    expect(text).toMatch(/2 file\(s\)/);
  });
});
