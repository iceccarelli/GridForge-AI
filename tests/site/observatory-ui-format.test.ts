/**
 * The pure formatting rules: provenance wording ("live" only for a fresh observation), units that cannot be compared are not
 * divided, a missing value stays missing, and time/cost never turn into a date or a zero.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveFreshness,
  fmtUtc,
  isLive,
  utilisation,
  viewCapex,
  viewProvenance,
  viewQuantity,
  viewTimeToCapacity,
  weakestOf,
} from "@/components/observatory/format";
import { rankConstraints } from "@/components/observatory/ConstraintsPanel";
import { rackSquares, snakeSlots, splitLabel, wrapLabel, rackRowVisuals } from "@/components/observatory/scene-visuals";
import type { Basis, Freshness, Observed } from "@/lib/observatory/types";
import { FIXTURE_NOW, SCENARIO_A, q } from "./observatory-ui-fixtures";

function o(basis: Basis, freshness: Freshness, over: Partial<Observed<number>["provenance"]> = {}, value: number | null = 1): Observed<number> {
  return { value, freshness, provenance: { source: "S", basis, observedAt: "2026-10-25T12:00:00Z", retrievedAt: "2026-10-25T12:05:00Z", maxAgeSeconds: 7200, ...over } };
}

describe("provenance wording", () => {
  it("only an observed, fresh value is live", () => {
    expect(isLive(o("observed", "fresh"), FIXTURE_NOW)).toBe(true);
    for (const basis of ["day_ahead_auction", "published_report", "engine_modelled", "synthetic_input", "assumed"] as Basis[]) {
      expect(isLive(o(basis, "fresh"), FIXTURE_NOW), basis).toBe(false);
      expect(viewProvenance(o(basis, "fresh"), FIXTURE_NOW).headline, basis).not.toMatch(/\blive\b/i);
    }
    for (const f of ["stale", "unavailable", "not_applicable"] as Freshness[]) {
      expect(isLive(o("observed", f), FIXTURE_NOW), f).toBe(false);
      expect(viewProvenance(o("observed", f), FIXTURE_NOW).headline, f).not.toMatch(/\blive\b/i);
    }
  });
  it("a value marked fresh but older than its own limit is stale at the time of rendering", () => {
    const old = o("observed", "fresh", { observedAt: "2026-10-25T08:00:00Z", maxAgeSeconds: 3600 });
    expect(effectiveFreshness(old, FIXTURE_NOW)).toBe("stale");
    expect(isLive(old, FIXTURE_NOW)).toBe(false);
    expect(viewProvenance(old, FIXTURE_NOW).headline).toBe("Observed reading, stale");
  });
  it("falls back to the retrieval time when there is no observation time, and to stale when the time is unreadable", () => {
    expect(effectiveFreshness(o("observed", "fresh", { observedAt: null, retrievedAt: "2026-10-25T05:00:00Z", maxAgeSeconds: 600 }), FIXTURE_NOW)).toBe("stale");
    expect(effectiveFreshness(o("observed", "fresh", { observedAt: "not a date" }), FIXTURE_NOW)).toBe("stale");
    expect(effectiveFreshness(o("observed", "fresh", { maxAgeSeconds: null, observedAt: "2020-01-01T00:00:00Z" }), FIXTURE_NOW)).toBe("fresh");
  });
  it("no value is unavailable, whatever the feed claims", () => {
    expect(effectiveFreshness(o("observed", "fresh", {}, null), FIXTURE_NOW)).toBe("unavailable");
    expect(viewProvenance(o("observed", "fresh", {}, null), FIXTURE_NOW).headline).toBe("Unavailable");
  });
  it("the day-ahead price and the queue say what they are", () => {
    expect(viewProvenance(o("day_ahead_auction", "fresh"), FIXTURE_NOW).headline).toBe("Published auction price for this delivery hour");
    expect(viewProvenance(o("published_report", "fresh", { observedAt: "2026-09-30T00:00:00Z" }), FIXTURE_NOW).headline).toBe("Published report as of 2026-09-30");
  });
  it("times are shown in UTC and a missing time says so", () => {
    expect(fmtUtc("2026-10-25T12:05:00Z")).toBe("2026-10-25 12:05 UTC");
    expect(fmtUtc(null)).toBe("not stated");
    expect(fmtUtc("garbage")).toBe("not stated");
  });
});

describe("quantities", () => {
  it("a value with a range shows the range; a missing value shows why and no number", () => {
    expect(viewQuantity(q(1_800_000, "EUR", "E0", { low: 1_500_000, high: 2_300_000 }))).toMatchObject({ text: "€1,800,000", known: true, evidence: "E0" });
    expect(viewQuantity(q(1_800_000, "EUR", "E0", { low: 1_500_000, high: 2_300_000 })).range).toBe("range €1,500,000 to €2,300,000");
    const missing = viewQuantity(q(null, "weeks", "E0", { missingReason: "no lead time" }));
    expect(missing).toMatchObject({ known: false, text: "not available", missing: "no lead time", evidence: null });
    expect(viewQuantity(null).text).toBe("not modelled");
  });
  it("utilisation compares like with like and refuses MW against MVA", () => {
    expect(utilisation(q(12, "MW", "E1"), q(6, "MW", "E1"))).toBeCloseTo(0.5);
    expect(utilisation(q(2, "MW", "E1"), q(500, "kW", "E1"))).toBeCloseTo(0.25);
    expect(utilisation(q(15, "MVA", "E1"), q(4.9, "MW", "E1"))).toBeNull();
    expect(utilisation(q(0, "MW", "E1"), q(1, "MW", "E1"))).toBeNull();
    expect(utilisation(q(10, "MW", "E1"), q(null, "MW", "E1"))).toBeNull();
    expect(utilisation(q(10, "MW", "E1"), null)).toBeNull();
  });
  it("never expresses a temperature against its limit as 'how full' a stage is", () => {
    expect(utilisation(q(25, "degC", "E0"), q(6, "degC", "E3"))).toBeNull();
    expect(utilisation(q(180, "racks", "E3"), q(26, "racks", "E0"))).toBeCloseTo(26 / 180);
  });
  it("splits a long stage label into a short title and the detail the model put in brackets", () => {
    expect(splitLabel("Transformers (usable after redundancy and derating)")).toEqual({ title: "Transformers", detail: "usable after redundancy and derating" });
    expect(splitLabel("Main switchgear")).toEqual({ title: "Main switchgear", detail: null });
    expect(splitLabel("(odd)")).toEqual({ title: "(odd)", detail: null });
  });
  it("a derived ratio carries the weakest class of its inputs", () => {
    expect(weakestOf([q(1, "MW", "E3"), q(1, "MW", "E0"), null, q(null, "MW", "E0")])).toBe("E0");
    expect(weakestOf([q(1, "MW", "E3"), q(1, "MW", "E2")])).toBe("E2");
    expect(weakestOf([null])).toBeNull();
  });
});

describe("time and cost never become a date or a zero", () => {
  const [tapoff, busway, liquid] = SCENARIO_A.outcomes;
  it("not dated, no value: names the reason", () => {
    expect(viewTimeToCapacity(tapoff)).toMatchObject({ kind: "undated", text: "Not dated — lead times assumed", note: "No supplied lead time for the tap-off units.", evidence: null });
  });
  it("not dated, assumed weeks: shown as a programme length on assumed lead times, class E0, 'not a date'", () => {
    const t = viewTimeToCapacity(busway);
    expect(t.kind).toBe("undated");
    expect(t.text).toMatch(/Not dated/);
    expect(t.note).toMatch(/38 weeks/);
    expect(t.note).toMatch(/not a date/i);
    expect(t.evidence).toBe("E0");
  });
  it("dated: weeks, still not a calendar date", () => {
    const t = viewTimeToCapacity(liquid);
    expect(t).toMatchObject({ kind: "weeks", text: "30 weeks", evidence: "E3" });
    expect(t.note).toMatch(/not a calendar date/i);
    for (const x of [viewTimeToCapacity(tapoff), viewTimeToCapacity(busway), t]) expect(`${x.text} ${x.note}`).not.toMatch(/\b20\d\d\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  });
  it("no cost value is 'not priced' with the unpriced components; a partial total is flagged partial; never zero", () => {
    expect(viewCapex(tapoff)).toMatchObject({ kind: "unpriced", text: "Not priced", note: "Unpriced: tap-off units, installation labour." });
    expect(viewCapex(busway)).toMatchObject({ kind: "partial", text: "€1,800,000" });
    expect(viewCapex(busway).note).toMatch(/excludes commissioning/);
    expect(viewCapex(liquid)).toMatchObject({ kind: "priced", text: "€2,340,000", note: null });
  });
});

describe("scene helpers", () => {
  it("ranks constraints by racks allowed, ties share a rank, unknown last and unranked", () => {
    const ranked = rankConstraints(SCENARIO_A.constraints);
    expect(ranked).toHaveLength(13);
    expect(ranked[0]).toMatchObject({ key: "busway_ampacity", rank: 1, binds: true });
    expect(ranked[ranked.length - 1]).toMatchObject({ key: "fault_level", rank: null, racksAllowed: null });
    const racks = ranked.filter((c) => c.racksAllowed !== null).map((c) => c.racksAllowed as number);
    expect(racks).toEqual([...racks].sort((a, b) => a - b));
    const tie = rankConstraints([
      { ...SCENARIO_A.constraints[0], key: "a", name: "A", racksAllowed: 10 },
      { ...SCENARIO_A.constraints[0], key: "b", name: "B", racksAllowed: 10 },
      { ...SCENARIO_A.constraints[0], key: "c", name: "C", racksAllowed: 20 },
    ]);
    expect(tie.map((c) => c.rank)).toEqual([1, 1, 3]);
  });
  it("lays stages out as a snake so consecutive stages are always adjacent", () => {
    const slots = snakeSlots(8, 4);
    expect(slots.map((s) => [s.row, s.col])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [1, 2], [1, 1], [1, 0]]);
    expect(snakeSlots(5, 2).map((s) => [s.row, s.col])).toEqual([[0, 0], [0, 1], [1, 1], [1, 0], [2, 0]]);
  });
  it("wraps labels to two lines and ends with an ellipsis rather than overflowing", () => {
    expect(wrapLabel("Main transformer T1", 21)).toEqual(["Main transformer T1"]);
    expect(wrapLabel("Busway, hall A east wing", 14)).toHaveLength(2);
    const long = wrapLabel("An extraordinarily long stage label that cannot possibly fit", 14);
    expect(long).toHaveLength(2);
    expect(long.every((l) => l.length <= 14)).toBe(true);
    expect(long[1].endsWith("…")).toBe(true);
  });
  it("draws at most the allowed squares and says how many racks each stands for", () => {
    expect(rackSquares(24, 54)).toEqual({ squares: 24, perSquare: 1 });
    expect(rackSquares(130, 54)).toEqual({ squares: 44, perSquare: 3 });
    expect(rackSquares(0, 54)).toEqual({ squares: 0, perSquare: 1 });
  });
  it("shades unknown density as unknown (null), never as zero", () => {
    const rows = rackRowVisuals(SCENARIO_A.rackRows);
    expect(rows[1].heatFound).toBeNull();
    expect(rows[1].heatAfter).toBe(1);
    expect(rows[0].heatFound).toBeGreaterThan(0);
  });
});
