import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConstraintChain, CHAIN } from "@/components/diagrams/ConstraintChain";
import { EvidenceBoundary } from "@/components/diagrams/EvidenceBoundary";
import { RackDensityChart } from "@/components/diagrams/RackDensityChart";
import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { EVIDENCE_BANDS, bandOf, unbandedCodes } from "@/lib/evidence-bands";
import {
  SYNTHETIC_HALL,
  TAP_OFF_AFTER_A,
  TAP_OFF_BEFORE_A,
  densitySeries,
  maxRackKw,
  rackCurrentA,
  racksByPowerOnly,
  racksFeedable,
} from "@/lib/rack-math";

const constraintSlugs = new Set(
  (JSON.parse(fs.readFileSync("public/reference/constraints.json", "utf8")) as { constraints: { slug: string }[] }).constraints.map((c) => c.slug)
);

describe("the rack-feed relation", () => {
  it("reproduces the worked figure the constraint reference publishes (a 132 kW rack at 400 V, pf 0.95: on the order of 200 A)", () => {
    expect(rackCurrentA(132, 400, 0.95)).toBeCloseTo(200.6, 0);
  });

  it("is its own inverse: the largest rack a tap-off feeds draws exactly the tap-off's rating", () => {
    for (const a of [32, 63, 125, 250, 400]) expect(rackCurrentA(maxRackKw(a, 400, 0.95), 400, 0.95)).toBeCloseTo(a, 9);
  });

  it("a 63 A tap-off feeds about 41 kW at 400 V and 0.95, and a 250 A one about 164 kW", () => {
    expect(maxRackKw(TAP_OFF_BEFORE_A, 400, 0.95)).toBeCloseTo(41.46, 1);
    expect(maxRackKw(TAP_OFF_AFTER_A, 400, 0.95)).toBeCloseTo(164.5, 0);
  });

  it("rejects values that are not physical rather than returning a number", () => {
    for (const bad of [0, -5, NaN, Infinity === 1 ? 1 : -Infinity]) expect(() => rackCurrentA(bad, 400, 0.95)).toThrow(RangeError);
    expect(() => rackCurrentA(100, 0, 0.95)).toThrow(RangeError);
    expect(() => rackCurrentA(100, 400, 0)).toThrow(RangeError);
    expect(() => rackCurrentA(100, 400, 1.2)).toThrow(RangeError);
    expect(() => maxRackKw(0, 400, 0.95)).toThrow(RangeError);
    expect(() => densitySeries(SYNTHETIC_HALL, 10, 5, 5)).toThrow(RangeError);
    expect(() => densitySeries(SYNTHETIC_HALL, 10, 50, 0)).toThrow(RangeError);
  });
});

describe("the density series (the figure's data)", () => {
  const series = densitySeries();

  it("is deterministic and covers 10 to 150 kW in 5 kW steps", () => {
    expect(series.map((p) => p.rackKw)).toEqual(Array.from({ length: 29 }, (_, i) => 10 + 5 * i));
    expect(densitySeries()).toEqual(series);
  });

  it("never places more racks than power, positions or a feedable rack allow, whatever the density", () => {
    for (const p of series) {
      expect(p.powerOnly * p.rackKw, `${p.rackKw} kW`).toBeLessThanOrEqual(SYNTHETIC_HALL.usableItKw);
      expect(p.before).toBeLessThanOrEqual(p.powerOnly);
      expect(p.after).toBeLessThanOrEqual(p.powerOnly);
      expect(p.before).toBeLessThanOrEqual(SYNTHETIC_HALL.positions);
      expect(p.after).toBeGreaterThanOrEqual(p.before);
    }
  });

  it("the power-only count never rises with density, and the positions cap binds at low density", () => {
    for (let i = 1; i < series.length; i++) expect(series[i].powerOnly).toBeLessThanOrEqual(series[i - 1].powerOnly);
    expect(series[0].powerOnly).toBeGreaterThan(SYNTHETIC_HALL.positions);
    expect(series[0].before).toBe(SYNTHETIC_HALL.positions);
  });

  it("the 63 A hall places no rack above its tap-off limit although power alone would place dozens: the figure's whole point", () => {
    const at60 = series.find((p) => p.rackKw === 60)!;
    expect(at60.powerOnly).toBe(40);
    expect(at60.before).toBe(0);
    expect(at60.after).toBe(40);
  });

  it("is exact at the boundary: a rack exactly at the limit can be fed, one watt above cannot", () => {
    const cap = maxRackKw(63, 400, 0.95);
    expect(racksFeedable(SYNTHETIC_HALL, cap, 63)).toBe(racksByPowerOnly(SYNTHETIC_HALL, cap));
    expect(racksFeedable(SYNTHETIC_HALL, cap + 0.001, 63)).toBe(0);
  });
});

describe("the rendered figures", () => {
  it("the chart is labelled synthetic, titled for assistive technology, and every plotted value is in a table", () => {
    const out = renderToStaticMarkup(React.createElement(RackDensityChart));
    expect(out).toContain('role="img"');
    expect(out).toMatch(/<title id="rdc-t">/);
    expect(out).toMatch(/SYNTHETIC HALL/);
    expect(out).toContain("describe no real hall");
    expect(out).toMatch(/Modelled \(E1\)/);
    expect(out.match(/<tr /g)!.length).toBe(1 + 29);
    expect(out).not.toMatch(/customer|measured at|observed at/i);
  });

  it("the chain's every stage names a real public constraint, in sequence, ending in useful compute", () => {
    for (const s of CHAIN) if (s.slug) expect(constraintSlugs.has(s.slug), s.slug ?? "").toBe(true);
    expect(CHAIN[CHAIN.length - 1].label).toBe("Useful AI compute");
    expect(CHAIN[0].label).toBe("Utility connection");
    const out = renderToStaticMarkup(React.createElement(ConstraintChain));
    expect(out).toContain("<ol");
    expect(out).toContain("/constraints/rack-feed-tapoff-rating");
  });
});

describe("the evidence boundary", () => {
  it("places every engine class in exactly one band, in order, with none left out", () => {
    expect(unbandedCodes()).toEqual([]);
    expect(EVIDENCE_BANDS.flatMap((b) => b.codes)).toEqual(EVIDENCE_CLASSES.map((c) => c.code));
    expect(bandOf("E5")!.id).toBe("measured");
    expect(bandOf("E9")).toBeUndefined();
  });

  it("says plainly that nothing field-validated or observed exists today, and that the client's data is carried as supplied", () => {
    const observed = EVIDENCE_BANDS.find((b) => b.id === "observed")!;
    expect(observed.today).toMatch(/None\. The calibration ledger is empty/);
    expect(EVIDENCE_BANDS.find((b) => b.id === "measured")!.reading).toMatch(/as supplied; it was not surveyed by us/);
    const out = renderToStaticMarkup(React.createElement(EvidenceBoundary));
    expect(out).toContain("The weakest link sets the label");
    for (const c of EVIDENCE_CLASSES) expect(out).toContain(c.verb);
  });

  it("agrees with the calibration record the evidence page reads", () => {
    const cal = JSON.parse(fs.readFileSync("public/reference/calibration.json", "utf8")) as { sites: number; observations: number };
    expect(cal.sites).toBe(0);
    expect(cal.observations).toBe(0);
  });
});
