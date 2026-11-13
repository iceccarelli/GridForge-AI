/**
 * The two approved TYPE changes of the engine API (review E6): `rank` is null for a row that is not ranked, and `after_relief.sets_the_date` is null when
 * there is no date. Every consumer in the site that assumed a string or a number is fed a null here.
 *
 *   app/reference/page.tsx  called `.toLowerCase()` on `time_to_power.sets_the_date`, so a null threw while the page rendered.
 *   lib/qualify.ts          typed `after_relief.sets_the_date` as `string`.
 *   components/PowerDeployProcurement.tsx  printed `r.rank` raw, so an unranked bid was an empty cell.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSetsTheDate } from "@/lib/date-basis";
import { headline, type QualifyResult } from "@/lib/qualify";
import { rankLabel } from "@/lib/rank-label";

const ROOT = process.cwd();

function packWith(bestOverrides: Record<string, unknown>) {
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "reference", "model_pack.json"), "utf8"));
  const best = pack.scenarios.reduce((a: any, b: any) => (b.after_ladder.racks > a.after_ladder.racks ? b : a));
  best.time_to_power = { ...best.time_to_power, weeks_to_full: 120, ...bestOverrides };
  return pack;
}

async function renderReference(pack: unknown): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reference-null-"));
  fs.mkdirSync(path.join(tmp, "public", "reference"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "public", "reference", "model_pack.json"), JSON.stringify(pack));
  vi.spyOn(process, "cwd").mockReturnValue(tmp);
  try {
    const mod = await import("@/app/reference/page");
    return renderToStaticMarkup(await mod.default()).replace(/<!-- -->/g, "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("/reference reads a model pack whose date has no item that sets it", () => {
  it("renders with a null sets_the_date (it used to throw on .toLowerCase of null) and says nothing about what sets the date", async () => {
    const html = await renderReference(packWith({ sets_the_date: null }));
    expect(html).toContain("With behind-the-meter supply");
    expect(html).toMatch(/racks · /);
    expect(html).not.toMatch(/\), set by /);                     // the page's own ", set by <item>" suffix (the date label may name an item itself)
    expect(html).not.toMatch(/set by (null|undefined)/i);
    expect(html).not.toMatch(/\bnull\b|undefined|NaN/);
  });

  it("an absent or empty sets_the_date is treated the same way", async () => {
    for (const over of [{ sets_the_date: undefined }, { sets_the_date: "" }]) {
      const html = await renderReference(packWith(over));
      expect(html).toContain("racks · ");
      expect(html).not.toMatch(/\), set by /);
    }
  });

  it("control: a date with its item still names it, in lower case", async () => {
    const html = await renderReference(packWith({ sets_the_date: "Transformer capacity" }));
    expect(html).toMatch(/\), set by transformer capacity/);
  });
});

describe("the qualifier's result type and readout accept a null sets_the_date", () => {
  const result = (afterRelief: Partial<QualifyResult["after_relief"]>): QualifyResult => ({
    platform: { id: "gb300_nvl72", name: "GB300 NVL72", rack_kW: { value: 135, low: 120, high: 140, unit: "kW", evidence: "E0", label: "rack" }, gpus_per_rack: 72 },
    as_found: { racks: 0, it_load_kW: { value: 0, low: 0, high: 0, unit: "kW", evidence: "E0", label: "load" }, binding_constraint: "UPS capacity", domain: "electrical", basis: "x" },
    after_relief: { racks: 28, architecture: "Full DLC", then_binds_on: null, sets_the_date: null, sets_the_date_reason: "No defensible date: not declared: transformers, UPS.", ...afterRelief },
    first_three_constraints: [],
    intake: { completeness: 0.5, required_inputs_missing: 2, can_issue_a_study: false, gaps: [], warnings: [], recommended_engagement: "x" },
    notice: "x",
  });

  it("types null (this file fails `tsc --noEmit` if QualifyResult says string) and reads it without throwing", () => {
    const r = result({});
    const null_date: string | null = r.after_relief.sets_the_date;
    expect(null_date).toBeNull();
    expect(() => headline(r)).not.toThrow();
    expect(headline(r)).toContain("Nothing deployable today");
    expect(r.after_relief.sets_the_date_reason).toContain("No defensible date");
  });

  it("the readout says there is no date and does not print the null", () => {
    const f = formatSetsTheDate(null, { date_basis: "none", date_label: "no date: a lead time on the path is missing" });
    expect(f.value).toBe("No date");
    expect(`${f.value} ${f.label}`).not.toMatch(/null|undefined/);
    expect(formatSetsTheDate(null, { date_basis: "assumed", date_evidence_class: "E0" }).value).toBe("Not stated");
  });
});

describe("a rank of null is an unranked row, shown as a dash", () => {
  it("rankLabel", () => {
    expect(rankLabel(1)).toBe("1");
    expect(rankLabel(12)).toBe("12");
    expect(rankLabel(0)).toBe("0");
    for (const unranked of [null, undefined, NaN, Infinity, "2", {}, []]) expect(rankLabel(unranked)).toBe("—");
  });

  it("the procurement table prints the label, not the raw field (an unranked bid was an empty cell)", () => {
    const src = fs.readFileSync(path.join(ROOT, "components", "PowerDeployProcurement.tsx"), "utf8");
    expect(src).toContain("{rankLabel(r.rank)}");
    expect(src).not.toMatch(/\{r\.rank\}/);
  });
});
