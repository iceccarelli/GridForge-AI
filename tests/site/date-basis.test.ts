/**
 * Rule D on the website: a time-to-power figure built from an assumed (E0) lead time never reads as a date.
 * Every expectation is an explicit string, so a reworded label fails here rather than quietly shipping.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DateFigure } from "@/components/DateFigure";
import { TimeToPowerCard } from "@/components/ai/TimeToPowerCard";
import {
  NO_DATE_LABEL,
  UNVERIFIED_LABEL,
  describeDate,
  formatLeadTime,
  formatRankingValue,
  formatSetsTheDate,
  formatWeeks,
  formatWeeksDelta,
  readDateBasis,
} from "@/lib/date-basis";

const ROOT = path.resolve(__dirname, "../..");
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const ASSUMED = {
  date_basis: "assumed",
  date_evidence_class: "E0",
  date_binding_item: "Transformer capacity",
  date_label: "assumed lead time, not a date (E0; set by transformer capacity)",
};
const NONE = {
  date_basis: "none",
  date_evidence_class: null,
  date_binding_item: null,
  date_label: "no date: nothing is deployable or a lead time on the path is missing",
};
const SUPPORTED = {
  date_basis: "supported",
  date_evidence_class: "E5",
  date_binding_item: "Busway ampacity",
  date_label: "lead times of class E5 at best; set by busway ampacity",
};

describe("assumed: the number never travels without the label", () => {
  it("formats the figure with the engine's label", () => {
    expect(formatWeeks(160, ASSUMED)).toBe("160 wk (assumed lead time, not a date (E0; set by transformer capacity))");
  });
  it("describes it as a number that must be labelled", () => {
    const f = describeDate(160, ASSUMED);
    expect(f.number).toBe("160 wk");
    expect(f.label).toBe("assumed lead time, not a date (E0; set by transformer capacity)");
    expect(f.info).toMatchObject({ basis: "assumed", evidenceClass: "E0", bindingItem: "Transformer capacity", showsNumber: true, needsLabel: true });
  });
  it("supplies the label itself if the engine sent the basis but not the sentence", () => {
    expect(readDateBasis({ date_basis: "assumed", date_evidence_class: "E0" }).label).toBe("assumed lead time, not a date (E0)");
  });
  it("a difference between scenarios takes the weaker basis and says so", () => {
    expect(formatWeeksDelta(-12, SUPPORTED, ASSUMED)).toBe("-12 wk (assumed lead time, not a date (E0; set by transformer capacity))");
    expect(formatWeeksDelta(8.5, ASSUMED, ASSUMED)).toBe("+8.5 wk (assumed lead time, not a date (E0; set by transformer capacity))");
  });
  it("a ranking by weeks is labelled by the leader's basis; other metrics are plain numbers", () => {
    expect(formatRankingValue("weeks to full capacity", 160, ASSUMED)).toBe("160 wk (assumed lead time, not a date (E0; set by transformer capacity))");
    expect(formatRankingValue("deployable racks", 1234, ASSUMED)).toBe("1,234");
    expect(formatRankingValue("EUR capex per deployable rack", 52000, undefined)).toBe("52,000");
  });
  it("the qualifier's 'sets the date' keeps the item and the assumption together", () => {
    expect(formatSetsTheDate("Transformer capacity", ASSUMED)).toMatchObject({
      value: "Transformer capacity",
      label: "assumed lead time, not a date (E0; set by transformer capacity)",
    });
  });
});

describe("none: no number at all", () => {
  it("shows the label alone, even if a stray number arrives", () => {
    expect(formatWeeks(null, NONE)).toBe("no date: nothing is deployable or a lead time on the path is missing");
    expect(formatWeeks(42, NONE)).toBe("no date: nothing is deployable or a lead time on the path is missing");
    expect(describeDate(42, NONE).number).toBeNull();
  });
  it("a delta and a ranking value against a no-date scenario carry no number", () => {
    expect(formatWeeksDelta(10, NONE, SUPPORTED)).toBe(NONE.date_label);
    expect(formatRankingValue("weeks to full capacity", 10, NONE)).toBe(NONE.date_label);
  });
  it("the qualifier says 'No date'", () => {
    expect(formatSetsTheDate("—", NONE).value).toBe("No date");
  });
});

describe("supported: the number with its evidence class", () => {
  it("is shown with the engine's label, which names the class", () => {
    expect(formatWeeks(30, SUPPORTED)).toBe("30 wk (lead times of class E5 at best; set by busway ampacity)");
    expect(describeDate(30, SUPPORTED).info).toMatchObject({ basis: "supported", showsNumber: true, needsLabel: false });
  });
});

describe("an engine older than the keys: 'lead time unverified' and no number", () => {
  it("missing, empty and unrecognised keys all read as unverified", () => {
    for (const src of [undefined, null, {}, { date_basis: "mystery" }, { date_basis: 5 }]) {
      expect(formatWeeks(160, src as never)).toBe("lead time unverified");
      expect(describeDate(160, src as never).number).toBeNull();
      expect(readDateBasis(src as never).basis).toBe("unverified");
    }
    expect(UNVERIFIED_LABEL).toBe("lead time unverified");
  });
  it("a delta, a ranking value and a qualifier readout degrade the same way", () => {
    expect(formatWeeksDelta(5, {}, SUPPORTED)).toBe("lead time unverified");
    expect(formatWeeksDelta(5, SUPPORTED, {})).toBe("lead time unverified");
    expect(formatRankingValue("weeks to full capacity", 9, {})).toBe("lead time unverified");
    expect(formatSetsTheDate("Transformer capacity", {}).label).toBe("lead time unverified");
  });
  it("never infers a basis from the figure or from an evidence class on its own", () => {
    expect(readDateBasis({ date_evidence_class: "E5" } as never).basis).toBe("unverified");
  });
});

describe("a single item's lead time keeps its evidence class", () => {
  it("says an E0 one is assumed", () => {
    expect(formatLeadTime(160, "E0")).toBe("160 wk lead (E0, assumed)");
    expect(formatLeadTime(30, "E5")).toBe("30 wk lead (E5)");
    expect(formatLeadTime(30, null)).toBe("30 wk lead (evidence class not stated)");
  });
});

describe("DateFigure renders the rule", () => {
  const html = (t: Record<string, unknown>, evidenceText?: string) =>
    text(renderToStaticMarkup(React.createElement(DateFigure, { t, evidenceText })));
  it("assumed", () => {
    const h = html({ status: "dated", weeks: 160, low: 120, high: 200, evidence: "E0", sets_the_date: "Transformer capacity", ...ASSUMED }, "E0");
    expect(h).toContain("160 wk");
    expect(h).toContain("(120–200)");
    expect(h).toContain("E0");
    expect(h).toContain("assumed lead time, not a date (E0; set by transformer capacity)");
    expect(h).toContain("set by Transformer capacity");
  });
  it("none", () => {
    const h = html({ status: "no_deployable_racks", weeks: null, reason: "No rack is deployable in this scenario, so there is nothing to date.", ...NONE });
    expect(h).toContain("No date.");
    expect(h).toContain("No rack is deployable in this scenario, so there is nothing to date.");
    expect(h).toContain("no date: nothing is deployable or a lead time on the path is missing");
    expect(h).not.toMatch(/\d+ wk/);
  });
  it("supported", () => {
    const h = html({ status: "dated", weeks: 30, low: 28, high: 34, evidence: "E5", ...SUPPORTED }, "E5");
    expect(h).toContain("30 wk");
    expect(h).toContain("lead times of class E5 at best; set by busway ampacity");
  });
  it("old-engine payload without the keys shows no number", () => {
    const h = html({ status: "dated", weeks: 160, low: 120, high: 200, evidence: "E0", sets_the_date: "Transformer capacity" }, "E0");
    expect(h).toContain("Lead time unverified.");
    expect(h).not.toMatch(/\d+ wk/);
    expect(h).not.toContain("160");
  });
  it("a dated status with no weeks shows no number either", () => {
    expect(html({ status: "dated", weeks: null, ...ASSUMED })).toContain("No date.");
  });
});

describe("the workspace time-to-power card", () => {
  const q = (value: number, unit: string) => ({ value, unit, evidenceClass: "E0", provenance: { source: "test", digest: "d", tool: "t", generatedAt: "now" } });
  const block = (extra: Record<string, unknown>) =>
    ({
      type: "metric",
      metricKind: "timeToPower",
      hallLabel: "Hall A",
      queueMonths: q(60, "months"),
      onSiteMonths: q(36, "months"),
      monthsRecovered: q(24, "months"),
      ...extra,
    }) as never;
  it("labels an assumed figure and keeps the number", () => {
    const h = text(renderToStaticMarkup(React.createElement(TimeToPowerCard, { block: block({ dateBasis: "assumed", dateEvidenceClass: "E0", dateLabel: ASSUMED.date_label }) })));
    expect(h).toContain("36");
    expect(h).toContain(ASSUMED.date_label);
  });
  it("hides the on-site figure when the block says nothing about its basis", () => {
    const h = text(renderToStaticMarkup(React.createElement(TimeToPowerCard, { block: block({}) })));
    expect(h).toContain("lead time unverified");
    expect(h).toContain("no figure shown");
    expect(h).not.toMatch(/\b36\b/);
  });
});

describe("the committed worked example carries the keys", () => {
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "public/reference/model_pack.json"), "utf8"));
  it("the dated scenario is an assumed lead time and the undeployable one has no date", () => {
    const by = Object.fromEntries(pack.scenarios.map((s: { id: string }) => [s.id, s]));
    expect(readDateBasis(by.full_dlc.time_to_power).basis).toBe("assumed");
    expect(formatWeeks(by.full_dlc.time_to_power.weeks_to_full, by.full_dlc.time_to_power)).toBe(
      "160 wk (assumed lead time, not a date (E0; set by transformer capacity))"
    );
    expect(readDateBasis(by.retained_air.time_to_power).basis).toBe("none");
    expect(NO_DATE_LABEL).toBe(by.retained_air.time_to_power.date_label);
  });
  it("the reference page prints the weeks with the label", async () => {
    const { default: Reference } = await import("@/app/reference/page");
    const h = text(renderToStaticMarkup(await Reference()));
    expect(h).toContain("160 wk (assumed lead time, not a date (E0; set by transformer capacity))");
    expect(h).not.toMatch(/160 weeks, set by/);
  });
});

describe("source guard: no surface prints a time-to-power figure outside the shared formatter", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "api") walk(p);
      } else if (/\.tsx$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "components"));
  const rel = (f: string) => path.relative(ROOT, f);
  const read = (f: string) => fs.readFileSync(f, "utf8");
  // Anything that reads the engine's time-to-power fields.
  const READS = /\.weeks\b|weeks_delta|weeks_to_full|weeks_to_first_rack|first_rack_weeks|\.sets_the_date|time_to_power/;
  const USES_FORMATTER = /from "@\/lib\/date-basis"|from "@\/components\/DateFigure"/;

  it("every component or page that reads those fields goes through lib/date-basis.ts", () => {
    // Not time-to-power: the admin funnel panel's retention table counts weeks of customer activity, not an engine lead time.
    const NOT_TIME_TO_POWER = new Set(["components/AdminFunnelPanel.tsx"]);
    const offenders = files.filter((f) => READS.test(read(f)) && !USES_FORMATTER.test(read(f))).map(rel).filter((f) => !NOT_TIME_TO_POWER.has(f));
    expect(offenders).toEqual([]);
  });
  it("no component formats a weeks figure by hand", () => {
    const HAND = /\.weeks\s*\.\s*toLocaleString|\.weeks\}\s*wk|weeks_to_full[^\n]*toFixed|\$\{[^}]*\.weeks\}|\$\{[^}]*weeks_delta[^}]*\}\s*weeks/;
    const offenders = files.filter((f) => HAND.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it("the surfaces the audit named all use it", () => {
    for (const f of [
      "components/CapacityQualifier.tsx",
      "components/TtpCompare.tsx",
      "components/DateFigure.tsx",
      "app/p/[shareToken]/page.tsx",
      "app/power/deploy/[token]/page.tsx",
      "app/reference/page.tsx",
      "components/ai/TimeToPowerCard.tsx",
      "components/ai/HeadroomLadderCard.tsx",
      "components/ai/BindingConstraintCard.tsx",
    ]) {
      expect(read(path.join(ROOT, f)), f).toMatch(USES_FORMATTER);
    }
  });
  it("the planning-model hero says its months are assumptions, not engine results", () => {
    const hero = read(path.join(ROOT, "components/TimeToPower.tsx"));
    expect(hero).toContain("unlocked · month ${Math.round(onsiteMo)} (assumed)");
    expect(hero).not.toContain("modelled by the engine");
    expect(read(path.join(ROOT, "components/TimeToPowerComparator.tsx"))).toContain("unlocked · month ${m.onSite} (assumed)");
  });
  it("the agent is told the same rule", () => {
    const prompt = read(path.join(ROOT, "lib/ai/prompts/system.ts"));
    expect(prompt).toContain("assumed lead time, not a date");
    expect(prompt).toContain("lead time unverified");
  });
});
