import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARKET_EVIDENCE, PUBLISHABLE_FIGURES, figureCitation, isPublishable, marketFigure, verificationLabel } from "@/lib/market-evidence";
import { MARKET_STATS, PROBLEM_CARDS } from "@/lib/site";

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === "node_modules" || e.name === ".next" ? [] : walk(p)) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

describe("the market-figure register", () => {
  it("records, for every figure, what was checked, and when", () => {
    expect(MARKET_EVIDENCE.length).toBeGreaterThanOrEqual(7);
    const ids = new Set<string>();
    for (const f of MARKET_EVIDENCE) {
      expect(ids.has(f.id), `duplicate ${f.id}`).toBe(false);
      ids.add(f.id);
      expect(f.statement.length, f.id).toBeGreaterThan(20);
      expect(f.caveat.length, `${f.id} must say what the check could not establish`).toBeGreaterThan(20);
      expect(f.checked, f.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["primary", "secondary", "qualified", "unverified"]).toContain(f.verification);
    }
  });

  it("a figure that may be shown names its publisher, date, period, geography, definition and a source URL", () => {
    expect(PUBLISHABLE_FIGURES.length).toBeGreaterThanOrEqual(4);
    for (const f of PUBLISHABLE_FIGURES) {
      for (const k of ["publisher", "published", "period", "geography", "definition"] as const) expect(f[k], `${f.id}.${k}`).not.toBe("");
      expect(f.url, f.id).toMatch(/^https:\/\//);
    }
  });

  it("an unverified figure carries no URL it could be mistaken for a source by", () => {
    for (const f of MARKET_EVIDENCE.filter((m) => !isPublishable(m))) expect(f.url, f.id).toBe("");
  });

  it("describes the strength of a check in words that do not claim more than was done", () => {
    expect(verificationLabel("secondary")).toMatch(/original was not opened/);
    expect(verificationLabel("primary")).toMatch(/Read at the publisher/);
    expect(verificationLabel("unverified")).toMatch(/No source/);
    expect(figureCitation(marketFigure("cbre-europe-ai-colo-2026"))).toContain("CBRE");
  });

  it("the earlier unsupported wording is recorded as withdrawn, not silently dropped", () => {
    expect(marketFigure("facilities-100kw").verification).toBe("unverified");
    expect(marketFigure("amsterdam-queue").verification).toBe("unverified");
    expect(marketFigure("transformer-lead-time").verification).toBe("unverified");
  });
});

describe("what the site states is what the register allows", () => {
  it("every homepage statistic is a register record that may be shown, with the register's own tile", () => {
    expect(MARKET_STATS.length).toBeGreaterThanOrEqual(3);
    for (const s of MARKET_STATS) {
      const f = marketFigure(s.figure);
      expect(isPublishable(f), s.figure).toBe(true);
      expect(s.value).toBe(f.tile);
      expect(s.source.length).toBeGreaterThan(5);
    }
  });

  it("no unverified wording survives in any page, component or library outside the register and the evidence page that lists withdrawals", () => {
    const banned = [/160\+\s*(weeks|wks)/i, /fewer than 4%/i, /Amsterdam'?s queue/i, /\b82%/, /Data Center Knowledge/i, /before 2030/i, /120 weeks in 2024/i];
    const allowed = new Set(["lib/market-evidence.ts", "app/evidence/page.tsx"].map((p) => path.resolve(p)));
    const offenders: string[] = [];
    for (const f of [...walk("app"), ...walk("components"), ...walk("lib")]) {
      if (allowed.has(path.resolve(f))) continue;
      const t = fs.readFileSync(f, "utf8");
      for (const re of banned) if (re.test(t)) offenders.push(`${f}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the problem cards do not repeat a withdrawn figure, and say whose forecast a forecast is", () => {
    const text = JSON.stringify(PROBLEM_CARDS);
    expect(text).not.toMatch(/before 2030|fewer than 4%|10 years|~10/);
    expect(text).toMatch(/utility itself expects|a utility forecast/);
  });

  it("the survey figure is stated as self-reported, never as a measurement of the market", () => {
    const f = marketFigure("uptime-density-2025");
    expect(f.kind).toBe("survey");
    expect(f.caveat).toMatch(/Self-reported/);
  });
});
