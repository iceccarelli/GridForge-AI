/**
 * The free capacity qualifier, as the journey audit read it: the page said things the engine's own answer contradicts, or left out what it said.
 *
 *   J1-11  zero free rack positions is an answer (the engine accepts 0 and says positions bind); the site refused it.
 *   J1-5   "about N racks" while the gaps say transformers and UPS are treated as no limit (so N is an upper bound).
 *   J1-3   the engine's warnings (a MW/MVA/kW slip, a peak below the IT load) were never rendered and the verdict read as settled.
 *   J1-4   the gap table cut the list at 8 rows with no "and N more", hiding required rows its own footer counted.
 *   J1-2   the engine's sentence to OUR salesperson ("Sell the Density Screen instead") was shown to the buyer.
 *
 * The fixtures below are the REAL engine's answers (python3 -m gridforge ... handle_qualify, captured 2026-11-13), cut down only in the long
 * prose; the suite at the bottom runs the engine itself and fails where its wording stops matching what these helpers read.
 */
import { SCREEN_CREDIT_SENTENCE } from "@/lib/credits-terms";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { siteUrl } from "@/lib/site";
import { headline, qualifySchema, toEngineBody, type QualifyResult } from "@/lib/qualify";
import { engagementAdvice } from "@/lib/qualify-engagement";
import { PRODUCTS } from "@/lib/products";
import { eur } from "@/lib/commerce";
import { studyOffer } from "@/lib/study-offer";
import { workingDays } from "@/lib/turnaround";
import { CapacityQualifier, FIELDS, QualifyReadout, fieldProblem } from "@/components/CapacityQualifier";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { engineAvailable } from "./_engine-guard";

vi.mock("@/lib/funnel", async (orig) => ({ ...(await orig<typeof import("@/lib/funnel")>()), recordFunnelEvent: async () => true }));

const ROOT = path.resolve(__dirname, "../..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
/** Rendered markup as the words a reader sees. */
const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const SEVEN = {
  siteName: "North Hall", platform: "gb300_nvl72", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400,
  tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180,
};
const post = (body: unknown) =>
  new Request(siteUrl("/api/qualify"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const q = (value: number, unit: string) => ({ value, low: value, high: value, unit, evidence: "E0_ASSUMPTION", label: "deployable IT load" });
const gap = (input: string, required: boolean, assumed: string): QualifyResult["intake"]["gaps"][number] => ({
  input, unit: "-", required, assumed, why_it_binds: `Why ${input} binds.`, how_to_get_it: `Where to get ${input}.`,
});
const resultOf = (over: { as_found?: Partial<QualifyResult["as_found"]>; after_relief?: Partial<QualifyResult["after_relief"]>; intake?: Partial<QualifyResult["intake"]> }): QualifyResult => ({
  platform: { id: "gb300_nvl72", name: "NVIDIA GB300 NVL72", rack_kW: { value: 135, low: 120, high: 150, unit: "kW", evidence: "E3", label: "rack", }, gpus_per_rack: 72 },
  as_found: { racks: 0, it_load_kW: q(0, "kW"), binding_constraint: "Rack feed / tap-off rating", domain: "electrical", basis: "platform needs 205 A per rack; installed tap-offs rated 63 A", ...over.as_found },
  after_relief: { racks: 28, architecture: "Full DLC, grid only", then_binds_on: null, sets_the_date: "Transformer capacity", date_basis: "assumed", date_evidence_class: "E0", date_binding_item: "Transformer capacity", date_label: "assumed lead time", ...over.after_relief },
  first_three_constraints: [{ name: "Rack feed / tap-off rating", domain: "electrical", relief: "Higher-rated tap-off units" }],
  intake: { completeness: 0.258, required_inputs_missing: 5, can_issue_a_study: false, gaps: [], warnings: [], recommended_engagement: "Intake too thin for a full study. Sell the Density Screen instead.", ...over.intake },
  notice: "A free directional read.",
});
const readout = (result: QualifyResult, head: string = headline(result)) =>
  renderToStaticMarkup(
    React.createElement(QualifyReadout, { result, headline: head, share: null, qualificationId: null, qualificationToken: null, template: null })
  );

// ================================================================================================ J1-11: zero free positions
/** The real engine's answer for 0 free positions on a hall whose only limit is positions (contracted 100 MW, 4000 A busway, 800 A tap-offs). */
const ZERO_POSITIONS = resultOf({
  as_found: { racks: 0, binding_constraint: "Available rack positions", domain: "physical", basis: "0 of 400 positions available in HALL-1" },
  after_relief: { racks: 0, architecture: "Hybrid DLC on retained plant, grid only", then_binds_on: "Available rack positions", sets_the_date: "—", date_basis: "none", date_evidence_class: null, date_binding_item: null, date_label: "no date: nothing is deployable or a lead time on the path is missing" },
});
ZERO_POSITIONS.first_three_constraints = [{ name: "Available rack positions", domain: "physical", relief: "De-tenant further positions / release white space" }];

describe("J1-11: zero free rack positions is a real answer, not a form error", () => {
  const positions = FIELDS.find((f) => f.key === "positionsAvailable")!;

  it("the schema accepts 0 and still refuses a negative, a fraction and a figure above the bound", () => {
    expect(qualifySchema.safeParse({ ...SEVEN, positionsAvailable: 0 }).success).toBe(true);
    expect(qualifySchema.safeParse({ ...SEVEN, positionsAvailable: "0" }).success).toBe(true);
    for (const bad of [-1, 1.5, 20001, "x"]) expect(qualifySchema.safeParse({ ...SEVEN, positionsAvailable: bad }).success, String(bad)).toBe(false);
    // the engine receives the zero as a zero, not as a missing figure
    expect(toEngineBody(qualifySchema.parse({ ...SEVEN, positionsAvailable: 0 })).positions_available).toBe(0);
  });

  it("the form takes 0 (non-negative integer) and says what is wrong with anything else", () => {
    expect(fieldProblem(positions, "0")).toBeNull();
    expect(fieldProblem(positions, "180")).toBeNull();
    expect(fieldProblem(positions, "")).toBe("Enter a value.");
    expect(fieldProblem(positions, "-1")).toBe("Enter 0 or more.");
    expect(fieldProblem(positions, "1.5")).toBe("Enter a whole number.");
    expect(fieldProblem(positions, "20001")).toBe("Enter 20,000 or less.");
    // the fields that are positive in the engine stay positive: zero contracted power is not a hall
    expect(fieldProblem(FIELDS.find((f) => f.key === "contractedMW")!, "0")).toBe("Enter a number greater than zero.");
    expect(fieldProblem(FIELDS.find((f) => f.key === "tapoffMaxA")!, "0")).toBe("Enter a number greater than zero.");
  });

  it("the input accepts 0 in the browser too, and its hint says what zero means", () => {
    const html = renderToStaticMarkup(React.createElement(CapacityQualifier));
    expect(html).toMatch(/id="qualify-positionsAvailable"[^>]*min="0"/);
    expect(text(html)).toContain("Enter 0 if none are free");
  });

  describe("the route", () => {
    beforeEach(() => {
      process.env.GRIDFORGE_API_URL = "http://engine.test";
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      resetMemoryLimiter();
    });
    let previous: typeof fetch;
    beforeEach(() => { previous = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = previous; delete process.env.GRIDFORGE_API_URL; });

    it("passes 0 to the engine and returns the engine's answer with its headline", async () => {
      let sent: Record<string, unknown> = {};
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(ZERO_POSITIONS), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const { POST } = await import("@/app/api/qualify/route");
      const res = await POST(post({ ...SEVEN, positionsAvailable: 0 }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(sent.positions_available).toBe(0);
      expect(body.headline).toContain("Available rack positions");
      expect(body.headline).not.toMatch(/NaN|undefined|Infinity/);
    });

    it("still refuses a negative count with a 422 that names the field", async () => {
      const { POST } = await import("@/app/api/qualify/route");
      const res = await POST(post({ ...SEVEN, positionsAvailable: -3 }));
      expect(res.status).toBe(422);
      expect((await res.json()).issues.fieldErrors).toHaveProperty("positionsAvailable");
    });
  });

  it("the page renders the zero-positions verdict: positions named as the limit, no NaN, no division by zero", () => {
    const html = readout(ZERO_POSITIONS);
    const t = text(html);
    expect(t).toContain("This hall cannot host NVIDIA GB300 NVL72 racks on these inputs. Available rack positions is what stops it.");
    expect(t).toContain("Binding constraint · physical");
    expect(t).toContain("0 of 400 positions available in HALL-1");
    expect(t).toMatch(/Deployable today 0 racks/);
    expect(t).toMatch(/After the ladder 0 racks/);
    expect(t).toContain("No date");
    expect(t).not.toMatch(/NaN|Infinity|undefined|null/);
  });
});

// ================================================================================================ the shipped example, as the real engine answers it
/** [input, required, assumed text] for the 29 gaps the engine returns for the page's example (12 MW, 7.4 MW peak, 4.9 MW IT, 400 A, 63 A, 6 C, 180 positions), in its order. */
const EXAMPLE_GAPS: [string, boolean, string][] = [
  ["Net white space", false, "2,000 [1,400–2,600] m2 (E0)"],
  ["Hall design floor loading", true, "12 [8–15] kPa (E0)"],
  ["Installed aisle pitch", false, "2.4 [2.04–2.76] m (E0)"],
  ["Summer design dry bulb", false, "32 [30–36] degC (E0)"],
  ["Transformer schedule", true, "not evaluated: treated as no limit, so the rack count is an upper bound (E0)"],
  ["UPS schedule", true, "not evaluated: treated as no limit, so the rack count is an upper bound (E0)"],
  ["Firm connection capacity", true, "12.37 MVA, derived as contracted_MW / 0.97 (E0): nobody gave the connection's firm capacity"],
  ["Site power factor", false, "0.97 [0.95–0.99] (E0)"],
  ["LV distribution voltage", false, "400 V (E0)"],
  ["LV distribution phases", false, "three-phase distribution assumed (E0)"],
  ["Number of busway runs", false, "6"],
  ["Busway utilisation limit", false, "0.8 (E0)"],
  ["Installed CDU schedule", false, "three 1,350 kW N+1 CDUs (2,700 kW usable) assumed as the starting point (E0)"],
  ["Flow the existing hall already draws on the plant", false, "0 l/min, nothing subtracted"],
  ["Other heat the existing hall already puts on the plant", false, "0 kW, nothing subtracted"],
  ["Chilled-water plant capacity", true, "5,000 [3,250–6,750] kW (E0)"],
  ["Plant design return temperature", false, "13 [12–18] degC (E0)"],
  ["Available pumped flow", false, "7,000 [4,900–9,100] l/min (E0)"],
  ["TCS target supply temperature", false, "30 [27–32] degC (E0)"],
  ["Air removal per rack position", false, "8 [6–12] kW (E0)"],
  ["Annual average rack utilisation", false, "0.75 [0.6–0.9] (E0)"],
  ["Rear-door heat exchanger capacity per rack", false, "60 [20–80] kW (E0)"],
  ["Load already on the busway", false, "0 kW, nothing subtracted"],
  ["Rack positions occupied", false, "no occupied count; every position not free is read as occupied for the busway check only"],
  ["Year the hall was built", false, "2015 assumed (library, E0)"],
  ["Floor type", false, "raised floor assumed (library, E0)"],
  ["Aisle containment", false, "cold aisle assumed (library, E0)"],
  ["Available pump head", false, "250 kPa assumed (library, E0)"],
  ["Free-cooling hours per year", false, "2,500 h assumed (library, E0)"],
];
const EXAMPLE_ROUTINE_WARNINGS = [
  "Busway: neither hall.occupied_positions nor hall.rack_positions was supplied, so the occupied positions are an assumption (E0) from the library default total of 400 positions, not a count of anything in your hall.",
  "No transformer schedule supplied: transformer capacity is not evaluated and may be the true binding constraint.",
  "No UPS schedule supplied: the load is treated as unprotected.",
  "No behind-the-meter options declared: where the grid binds, the study can only report that it binds.",
];
const EXAMPLE = resultOf({
  intake: { gaps: EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a)), warnings: EXAMPLE_ROUTINE_WARNINGS, required_inputs_missing: 5 },
});

// ================================================================================================ J1-5: "about N" while the engine says N is an upper bound
describe("J1-5: a rack count the engine marks as an upper bound is said as 'at most'", () => {
  it("the example: the headline no longer says 'about 28 racks' while transformers and UPS are treated as no limit", () => {
    const h = headline(EXAMPLE);
    expect(h).toBe("Nothing deployable today — rack feed / tap-off rating stops it. Clear the ladder and the hall carries at most 28 NVIDIA GB300 NVL72 racks.");
    expect(h).not.toMatch(/about|roughly/i);
  });

  it("with racks today, both figures are upper bounds", () => {
    const h = headline(resultOf({ as_found: { racks: 12 }, after_relief: { racks: 28 }, intake: { gaps: EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a)) } }));
    expect(h).toBe("At most 12 NVIDIA GB300 NVL72 racks today, rising to at most 28 once rack feed / tap-off rating is relieved.");
  });

  it("a read with no input treated as no limit keeps its 'about' wording", () => {
    const bounded = resultOf({ as_found: { racks: 12 }, after_relief: { racks: 28 }, intake: { gaps: [gap("Site power factor", false, "0.97 [0.95–0.99] (E0)")] } });
    expect(headline(bounded)).toBe("About 12 NVIDIA GB300 NVL72 racks today, rising to roughly 28 once rack feed / tap-off rating is relieved.");
    const none = resultOf({ as_found: { racks: 0 }, after_relief: { racks: 28 }, intake: { gaps: [] } });
    expect(headline(none)).toContain("carries about 28 NVIDIA GB300 NVL72 racks");
  });

  it("one bank alone (UPS) is enough, and the engine's own wording is what decides it", () => {
    const ups = resultOf({ after_relief: { racks: 8 }, intake: { gaps: [gap("UPS schedule", true, "not evaluated: treated as no limit, so the rack count is an upper bound (E0)")] } });
    expect(headline(ups)).toContain("at most 8 NVIDIA GB300 NVL72 racks");
  });

  it("says rack, not racks, for one; and says nothing about a count where there is none", () => {
    const one = headline(resultOf({ as_found: { racks: 1 }, after_relief: { racks: 1 }, intake: { gaps: EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a)) } }));
    expect(one).toContain("At most 1 NVIDIA GB300 NVL72 rack today, rising to at most 1 once");
    const zero = headline(resultOf({ as_found: { racks: 0 }, after_relief: { racks: 0 }, intake: { gaps: EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a)) } }));
    expect(zero).toBe("This hall cannot host NVIDIA GB300 NVL72 racks on these inputs. Rack feed / tap-off rating is what stops it.");
  });

  it("an engine answer without gaps or warnings (an older engine, a stub) still gets a headline", () => {
    const bare = resultOf({});
    delete (bare.intake as Partial<QualifyResult["intake"]>).gaps;
    delete (bare.intake as Partial<QualifyResult["intake"]>).warnings;
    expect(headline(bare)).toContain("carries about 28 NVIDIA GB300 NVL72 racks");
  });

  it("the page marks both rack tiles as upper bounds and names the inputs that were not evaluated", () => {
    const t = text(readout(EXAMPLE));
    expect(t).toMatch(/Deployable today · upper bound 0 racks/);
    expect(t).toMatch(/After the ladder · upper bound 28 racks/);
    expect(t).toContain("Upper bound: Transformer schedule and UPS schedule were not evaluated (treated as no limit), so the hall may carry fewer racks than this.");
  });

  it("the page does not call a read an upper bound when nothing was treated as no limit", () => {
    const t = text(readout(resultOf({ intake: { gaps: [gap("Site power factor", false, "0.97 [0.95–0.99] (E0)")] } })));
    expect(t).not.toMatch(/upper bound/i);
    expect(t).toMatch(/Deployable today 0 racks/);
  });
});

// ================================================================================================ J1-3: the engine's warnings, and a verdict that is not settled while they stand
/** The warnings the real engine returned for current_it_load_MW = 40 against contracted_MW = 12 and a 7.4 MW peak (gridforge/power/plausibility.py), in its order. */
const UNIT_WARNINGS = [
  "The firm supply ceiling (12.00 MW: the lesser of the firm connection 12.37 MVA x 0.97 and the contracted 12.00 MW) cannot cover the current IT load (40.00 MW). No hall can run on that supply, so the zero headroom below says the inputs disagree with each other, not that the hall is full. Check the units (MW, MVA, kW) before relying on this result.",
  "The current site peak (7.40 MW) is below the current IT load (40.00 MW), but the IT load is part of the site peak, so one of the two figures is wrong or in the wrong unit (MW, MVA, kW), or one is a design value and the other a metered one. Supply headroom is taken from the peak, so a peak that is too low frees supply that does not exist and overstates the racks the grid can carry. Confirm both figures from the same metering period before relying on this result.",
];
const UNIT_SLIP = resultOf({
  intake: { gaps: EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a)), warnings: [...EXAMPLE_ROUTINE_WARNINGS, ...UNIT_WARNINGS], required_inputs_missing: 5 },
  after_relief: { racks: 0 },
});

describe("J1-3: the engine's warnings are shown above the verdict, and a unit warning stops the verdict reading as settled", () => {
  it("a unit slip's own warning reaches the reader beside a 'cannot host' headline, even if the headline string is the bare one", () => {
    const t = text(readout(UNIT_SLIP, "This hall cannot host NVIDIA GB300 NVL72 racks on these inputs. Rack feed / tap-off rating is what stops it."));
    expect(t).toContain("Check the units (MW, MVA, kW) before relying on this result.");
  });

  it("every warning is rendered, the unit and inconsistency ones before the routine ones, each once", () => {
    const html = readout(UNIT_SLIP);
    const t = text(html);
    for (const w of [...UNIT_WARNINGS, ...EXAMPLE_ROUTINE_WARNINGS]) expect(t.split(w).length - 1, w.slice(0, 40)).toBe(1);
    const at = (w: string) => t.indexOf(w);
    expect(at(UNIT_WARNINGS[0])).toBeLessThan(at(UNIT_WARNINGS[1]));
    expect(at(UNIT_WARNINGS[1])).toBeLessThan(at(EXAMPLE_ROUTINE_WARNINGS[0]));
    // the routine ones keep the engine's order after them
    const routine = EXAMPLE_ROUTINE_WARNINGS.map(at);
    expect([...routine].sort((a, b) => a - b)).toEqual(routine);
  });

  it("the warnings are a note above the verdict, not below it", () => {
    const html = readout(UNIT_SLIP);
    const note = html.indexOf('role="note"');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf("Check your inputs first:"));
    expect(note).toBeLessThan(html.indexOf("Deployable today"));
    expect(html.indexOf("Check the units (MW, MVA, kW)")).toBeLessThan(html.indexOf("This hall cannot host"));
  });

  it("a read with only routine warnings shows them too, still as a note, and does not claim an input problem", () => {
    const html = readout(EXAMPLE);
    expect(html).toContain('role="note"');
    const t = text(html);
    for (const w of EXAMPLE_ROUTINE_WARNINGS) expect(t).toContain(w);
    expect(t).not.toContain("Check your inputs first:");
    expect(headline(EXAMPLE)).not.toContain("Check your inputs first");
  });

  it("a read with no warnings has no note", () => {
    expect(readout(resultOf({ intake: { warnings: [] } }))).not.toContain('role="note"');
    const bare = resultOf({});
    delete (bare.intake as Partial<QualifyResult["intake"]>).warnings;
    expect(readout(bare)).not.toContain('role="note"');
  });

  it("warnings are plain text: markup in one is shown as characters, never interpreted", () => {
    const evil = 'Check the units (MW, MVA, kW) <img src=x onerror="alert(1)"> <b>bold</b> & more';
    const html = readout(resultOf({ intake: { warnings: [evil] } }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;img src=x");
    expect(text(html)).toContain(evil);
  });

  it("while a unit or consistency warning stands the headline opens with 'Check your inputs first:' and then still gives the verdict", () => {
    const h = headline(UNIT_SLIP);
    expect(h.startsWith("Check your inputs first:")).toBe(true);
    expect(h).toContain("the warning shown with this result");
    expect(h).toContain("provisional");
    expect(h).toContain("This hall cannot host NVIDIA GB300 NVL72 racks on these inputs. Rack feed / tap-off rating is what stops it.");
    // the prefix is one line: it does not run into the verdict's own sentences
    expect(h.split(/(?<=\.) /)[0]).toContain("Check your inputs first:");
    // the visitor reads it in the page, above the tiles
    const t = text(readout(UNIT_SLIP));
    expect(t.indexOf("Check your inputs first:")).toBeLessThan(t.indexOf("Deployable today"));
  });

  it("every verdict shape gets the prefix, and only the unit and consistency warnings cause it", () => {
    const gaps = EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a));
    for (const over of [{ as_found: { racks: 0 }, after_relief: { racks: 0 } }, { as_found: { racks: 0 }, after_relief: { racks: 12 } }, { as_found: { racks: 4 }, after_relief: { racks: 12 } }]) {
      expect(headline(resultOf({ ...over, intake: { gaps, warnings: UNIT_WARNINGS } })).startsWith("Check your inputs first:")).toBe(true);
      expect(headline(resultOf({ ...over, intake: { gaps, warnings: EXAMPLE_ROUTINE_WARNINGS } })).startsWith("Check your inputs first:")).toBe(false);
    }
    // each of the engine's three kinds of finding (plausibility.py) is a unit or consistency warning on its own
    for (const w of [
      "The contracted capacity (12.00 MW) is more than the firm connection can deliver (5.00 MVA x 0.97 = 4.85 MW). One of the two figures may be wrong or in the wrong unit (MW, MVA, kW), or the contract may include capacity that is not firm.",
      "The firm supply ceiling (12.00 MW) cannot cover the current site peak (13.00 MW). The connection is already overdrawn on the inputs given, so the zero headroom below says the inputs disagree with each other.",
      UNIT_WARNINGS[1],
    ]) {
      expect(headline(resultOf({ intake: { warnings: [w] } })).startsWith("Check your inputs first:"), w.slice(0, 50)).toBe(true);
    }
  });

  describe("through the route", () => {
    let previous: typeof fetch;
    beforeEach(() => {
      previous = globalThis.fetch;
      process.env.GRIDFORGE_API_URL = "http://engine.test";
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      resetMemoryLimiter();
    });
    afterEach(() => { globalThis.fetch = previous; delete process.env.GRIDFORGE_API_URL; });

    it("a unit slip answered by the engine comes back with the prefixed headline and every warning in the result", async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify(UNIT_SLIP), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      const { POST } = await import("@/app/api/qualify/route");
      const body = await (await POST(post({ ...SEVEN, currentItLoadMW: 40 }))).json();
      expect(body.ok).toBe(true);
      expect(body.headline.startsWith("Check your inputs first:")).toBe(true);
      expect(body.result.intake.warnings).toEqual([...EXAMPLE_ROUTINE_WARNINGS, ...UNIT_WARNINGS]);
    });
  });
});

// ================================================================================================ J1-4: the gap table
/** The first cell of each body row of the assumed-inputs tables in this markup, "Name" or "Name *" for a required one. */
const rowsIn = (html: string): string[] =>
  [...html.matchAll(/<tr class="border-t[^"]*"[^>]*><td[^>]*>(.*?)<\/td>/g)].map((m) => m[1].replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
/** What a visitor sees without opening anything: the markup before the disclosure. */
const beforeDisclosure = (html: string) => (html.includes("<details") ? html.slice(0, html.indexOf("<details")) : html);
const insideDisclosure = (html: string) => (html.includes("<details") ? html.slice(html.indexOf("<details"), html.indexOf("</details>")) : "");
const required = EXAMPLE_GAPS.filter(([, r]) => r).map(([i]) => i);
const optional = EXAMPLE_GAPS.filter(([, r]) => !r).map(([i]) => i);

describe("J1-4: every required gap is on the page, with an honest count of the rest", () => {
  it("the example has five required gaps, and the chilled-water plant is not among the first eight the engine lists", () => {
    // the arithmetic of the defect: it showed gaps.slice(0, 8)
    const firstEight = EXAMPLE_GAPS.slice(0, 8);
    expect(required).toHaveLength(5);
    expect(firstEight.filter(([, r]) => r)).toHaveLength(4);
    expect(firstEight.map(([i]) => i)).not.toContain("Chilled-water plant capacity");
  });

  it("all five starred rows are visible without a click, and the footer's count is the stars on screen", () => {
    const html = readout(EXAMPLE);
    const shown = rowsIn(beforeDisclosure(html));
    const stars = shown.filter((r) => r.endsWith("*"));
    expect(stars.map((r) => r.replace(/ \*$/, ""))).toEqual(required);
    expect(stars).toHaveLength(5);
    expect(text(html)).toContain("5 required inputs assumed.");
    // required first, in the engine's order; then optional ones in the engine's order, eight rows in all
    expect(shown.map((r) => r.replace(/ \*$/, ""))).toEqual([...required, ...optional.slice(0, 3)]);
    expect(shown).toHaveLength(8);
  });

  it("the rest is behind a native disclosure that says how many, and holds exactly the rest, none twice", () => {
    const html = readout(EXAMPLE);
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>[^<]*\+21 more optional inputs/);
    const rest = rowsIn(insideDisclosure(html));
    expect(rest).toEqual(optional.slice(3));
    expect(rest).toHaveLength(21);
    expect(rest.some((r) => r.endsWith("*"))).toBe(false);
    expect(new Set([...rowsIn(beforeDisclosure(html)), ...rest].map((r) => r.replace(/ \*$/, ""))).size).toBe(EXAMPLE_GAPS.length);
    // it starts closed: nothing is revealed that the visitor did not ask for
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("more required gaps than the cap are all shown, and the disclosure then holds only optional ones", () => {
    const many = Array.from({ length: 11 }, (_, i) => gap(`Required ${i + 1}`, true, "x")).concat(Array.from({ length: 4 }, (_, i) => gap(`Optional ${i + 1}`, false, "y")));
    const html = readout(resultOf({ intake: { gaps: many, required_inputs_missing: 11 } }));
    expect(rowsIn(beforeDisclosure(html))).toEqual(Array.from({ length: 11 }, (_, i) => `Required ${i + 1} *`));
    expect(rowsIn(insideDisclosure(html))).toEqual(["Optional 1", "Optional 2", "Optional 3", "Optional 4"]);
    expect(text(html)).toContain("+4 more optional inputs");
    expect(text(html)).toContain("11 required inputs assumed.");
  });

  it("with nothing to hide there is no disclosure, and the counts agree for one and for none", () => {
    const few = resultOf({ intake: { gaps: [gap("Hall design floor loading", true, "12 kPa"), gap("Site power factor", false, "0.97")], required_inputs_missing: 1 } });
    const html = readout(few);
    expect(html).not.toContain("<details");
    expect(rowsIn(html)).toEqual(["Hall design floor loading *", "Site power factor"]);
    expect(text(html)).toContain("1 required input assumed.");
    expect(text(html)).not.toContain("1 required inputs");
    const none = readout(resultOf({ intake: { gaps: [gap("Site power factor", false, "0.97")], required_inputs_missing: 0 } }));
    expect(text(none)).toContain("No required inputs assumed.");
    // one optional input hidden: singular
    const one = readout(resultOf({ intake: { gaps: Array.from({ length: 9 }, (_, i) => gap(`Optional ${i + 1}`, false, "y")) } }));
    expect(text(one)).toContain("+1 more optional input");
    expect(text(one)).not.toContain("+1 more optional inputs");
  });

  it("the footer counts the starred rows even when the engine's own counter disagrees with them", () => {
    const html = readout(resultOf({ intake: { gaps: EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a)), required_inputs_missing: 9 } }));
    expect(text(html)).toContain("5 required inputs assumed.");
    expect(text(html)).not.toContain("9 required inputs");
  });

  it("each row keeps what it said: why it binds and where to find it, in both tables", () => {
    const html = readout(EXAMPLE);
    expect(text(html)).toContain("Where to find it: Where to get Chilled-water plant capacity.");
    expect(text(insideDisclosure(html))).toContain("Where to find it: Where to get Free-cooling hours per year.");
    expect(html).toContain('aria-label="Inputs the engine assumed"');
    expect(html).toContain('aria-label="More optional inputs the engine assumed"');
  });
});

// ================================================================================================ J1-2: the engine's note to our salesperson is not shown to a buyer
/** The three sentences the engine writes into intake.recommended_engagement (gridforge/intake/schema.py), for 'complete', '1-3 required missing' and 'too thin'. */
const ENGINE_NOTES_TO_SALES = [
  "The intake is complete. This supports a full Capacity & Density Envelope Study with site-specific conclusions.",
  "3 required inputs missing. Request them before starting; the study can proceed in parallel on everything else.",
  "1 required inputs missing. Request them before starting; the study can proceed in parallel on everything else.",
  "Intake too thin for a full study. Sell the Density Screen instead: it produces the binding constraint and the data-request list, and its fee credits against the study when the data arrives.",
  "No required inputs are missing, so this supports a full Capacity & Density Envelope Study, but the intake is not complete: 1 optional input is still an assumption (listed in the data request), and the study names each one.",
];
const screen = PRODUCTS.density_screen;
const withNote = (note: string, gaps: QualifyResult["intake"]["gaps"] = EXAMPLE_GAPS.map(([i, r, a]) => gap(i, r, a))) => resultOf({ intake: { gaps, recommended_engagement: note } });

describe("J1-2: the paid step is described to the buyer from the catalogue, never from the engine's note to sales", () => {
  it.each(ENGINE_NOTES_TO_SALES)("the engine's sentence is not on the page: %s", (note) => {
    const t = text(readout(withNote(note)));
    expect(t).not.toContain(note);
    expect(t).not.toMatch(/Sell the Density Screen|Request them before starting|Intake too thin|supports a full/i);
    // and the button it used to sit above is still there
    expect(t).toContain(`Commission the ${screen.name} · ${eur(screen.amountCents)}`);
  });

  it("no component or page renders the engine's recommended_engagement (the only place it is named is the answer's type and the OpenAPI text)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx$/.test(e.name) && /recommended_engagement|engagement_recommendation/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(path.resolve(__dirname, "../.."), p));
      }
    };
    for (const d of ["components", "app"]) walk(path.resolve(__dirname, "../..", d));
    expect(offenders).toEqual([]);
  });

  it("states what this read leaves open, counted from the gaps the page shows, right for one, many, none", () => {
    const g = (n: number, req: boolean) => Array.from({ length: n }, (_, i) => gap(`${req ? "Req" : "Opt"} ${i}`, req, "x"));
    expect(engagementAdvice(withNote("x", [...g(1, true), ...g(4, false)])).situation).toBe("1 required input is still assumed in this read (marked * above).");
    expect(engagementAdvice(withNote("x", [...g(5, true), ...g(4, false)])).situation).toBe("5 required inputs are still assumed in this read (marked * above).");
    expect(engagementAdvice(withNote("x", g(1, false))).situation).toBe("No required input is missing from this read; 1 optional input is still assumed.");
    expect(engagementAdvice(withNote("x", g(3, false))).situation).toBe("No required input is missing from this read; 3 optional inputs are still assumed.");
    expect(engagementAdvice(withNote("x", [])).situation).toBe("No input in this read is assumed.");
    // an answer with no gap list says nothing about counts, rather than "none"
    const bare = resultOf({});
    delete (bare.intake as Partial<QualifyResult["intake"]>).gaps;
    expect(engagementAdvice(bare).situation).toBeNull();
  });

  it("the offer is the catalogue's own: its description (with the turnaround), its deliverable, and the step it credits against", () => {
    const a = engagementAdvice(withNote("x"));
    expect(a.offer).toContain(screen.description);
    expect(a.offer).toContain(screen.deliverable);
    expect(a.offer).toContain(workingDays(screen.turnaroundDays));
    const study = studyOffer(screen.kind)!;
    expect(a.next).toBe(`If the Screen shows the hall is worth a full study, the next step is the ${study.studyName}: ${study.price}. ${SCREEN_CREDIT_SENTENCE}`);
    // the page shows exactly these words, and the button carries the catalogue's name and price
    const t = text(readout(withNote("x")));
    expect(t).toContain("5 required inputs are still assumed in this read (marked * above).");
    expect(t).toContain(text(screen.description));
    expect(t).toContain(text(SCREEN_CREDIT_SENTENCE));
    expect(t).toContain(`Commission the ${screen.name} · ${eur(screen.amountCents)}`);
  });

  it("types no price, duration or credit of its own: the module that writes the sentences holds none", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../lib/qualify-engagement.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/€|EUR|\d[\d,.]*\s*(working )?days?|credits? in full|fixed fee/i);
  });

  it("a read taken from a reference template still shows no commission step and no engine note", () => {
    const t = text(
      renderToStaticMarkup(
        React.createElement(QualifyReadout, {
          result: withNote(ENGINE_NOTES_TO_SALES[3]), headline: "x", share: null, qualificationId: null, qualificationToken: null,
          template: { name: "T", assumed: 7, total: 7, untouched: true, fields: [] },
        })
      )
    );
    expect(t).not.toContain(ENGINE_NOTES_TO_SALES[3]);
    expect(t).not.toContain("Commission the");
  });
});

// ================================================================================================ the real engine
/**
 * The helpers above read the engine's WORDING (the "(MW, MVA, kW)" hint, "treated as no limit", the order of its gaps). These run the engine in this
 * repository (gridforge.api.server.handle_qualify, the function POST /v1/qualify calls) and fail where its wording or counts stop matching them.
 * Without python3 they are skipped, except where GRIDFORGE_REQUIRE_ENGINE=1 or CI=true says they must run (the last test).
 */
function realEngineAnswers(): Record<string, QualifyResult> {
  const code = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    "from gridforge.api.server import Tier, handle_qualify",
    "base = {'busway_ampacity_A': 400, 'contracted_MW': 12, 'current_it_load_MW': 4.9, 'current_site_peak_MW': 7.4, 'plant_supply_C': 6, 'positions_available': 180, 'tapoff_max_A': 63, 'platform': 'gb300_nvl72'}",
    "cases = {'example': {}, 'unit_slip': {'current_it_load_MW': 40}, 'zero_positions': {'positions_available': 0, 'contracted_MW': 100, 'current_site_peak_MW': 20, 'current_it_load_MW': 10, 'busway_ampacity_A': 4000, 'tapoff_max_A': 800, 'plant_supply_C': 20}}",
    "print(json.dumps({k: handle_qualify({**base, **v}, Tier.PUBLIC) for k, v in cases.items()}))",
  ].join("\n");
  const run = spawnSync("python3", ["-c", code], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`the engine did not answer: ${run.stderr}`);
  return JSON.parse(run.stdout.split("\n").filter((l) => l.startsWith("{")).pop()!);
}

describe.runIf(hasPython)("through the real engine", () => {
  let real: Record<string, QualifyResult>;
  beforeAll(() => { real = realEngineAnswers(); }, 60_000);

  it("the shipped example: five required gaps, all of them on the page, counted once; the engine's note to sales is not", () => {
    const r = real.example;
    const starred = r.intake.gaps.filter((g) => g.required);
    expect(starred.length).toBeGreaterThanOrEqual(5);
    expect(r.intake.gaps.length).toBeGreaterThan(8);
    const html = readout(r);
    const visible = rowsIn(beforeDisclosure(html)).filter((row) => row.endsWith("*")).map((row) => row.replace(/ \*$/, ""));
    expect(visible).toEqual(starred.map((g) => g.input));
    expect(text(html)).toContain(`${starred.length} required inputs assumed.`);
    // the defect: the engine's order put the chilled-water plant outside the first eight rows
    const plant = r.intake.gaps.findIndex((g) => g.input === "Chilled-water plant capacity");
    expect(plant).toBeGreaterThanOrEqual(8);
    expect(visible).toContain("Chilled-water plant capacity");
    expect(r.intake.recommended_engagement.length).toBeGreaterThan(20);
    expect(text(html)).not.toContain(r.intake.recommended_engagement);
  });

  it("the shipped example: transformers and UPS are 'treated as no limit', so the count is said as an upper bound, and the page names them", () => {
    const r = real.example;
    expect(r.intake.gaps.some((g) => /treated as no limit/.test(g.assumed))).toBe(true);
    expect(r.after_relief.racks).toBeGreaterThan(0);
    const h = headline(r);
    expect(h).toMatch(/at most \d+ NVIDIA GB300 NVL72 racks/i);
    expect(h).not.toMatch(/\babout\b/i);
    expect(text(readout(r))).toMatch(/Upper bound: .*(Transformer|UPS).* not evaluated \(treated as no limit\)/);
    // routine warnings are not input problems: the example does not start with a check-your-inputs line
    expect(h).not.toContain("Check your inputs first");
    expect(r.intake.warnings.length).toBeGreaterThan(0);
    for (const w of r.intake.warnings) expect(text(readout(r))).toContain(text(w));
  });

  it("a unit slip: the engine says so in its own words, the page puts that first and the verdict is provisional", () => {
    const r = real.unit_slip;
    expect(r.as_found.racks).toBe(0);
    const problems = r.intake.warnings.filter((w) => /Check the units \(MW, MVA, kW\)|wrong unit/.test(w));
    expect(problems.length).toBeGreaterThanOrEqual(1);
    const h = headline(r);
    expect(h.startsWith("Check your inputs first:")).toBe(true);
    const t = text(readout(r));
    for (const w of r.intake.warnings) expect(t).toContain(text(w));
    expect(t.indexOf(text(problems[0]))).toBeLessThan(t.indexOf(text(r.intake.warnings.find((w) => !problems.includes(w))!)));
    expect(t.indexOf(text(problems[0]))).toBeLessThan(t.indexOf("Deployable today"));
  });

  it("zero free positions: the engine answers (it does not refuse), says positions bind, and the page renders it without NaN", () => {
    const r = real.zero_positions;
    expect(r.as_found.racks).toBe(0);
    expect(r.as_found.binding_constraint).toBe("Available rack positions");
    const t = text(readout(r));
    expect(t).toContain("Available rack positions is what stops it.");
    expect(t).not.toMatch(/NaN|Infinity|undefined|null/);
  });
});

describe("the real-engine suite cannot be skipped silently where it is required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
});
