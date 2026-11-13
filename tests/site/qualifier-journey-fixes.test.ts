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
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { headline, qualifySchema, toEngineBody, type QualifyResult } from "@/lib/qualify";
import { CapacityQualifier, FIELDS, QualifyReadout, fieldProblem } from "@/components/CapacityQualifier";
import { resetMemoryLimiter } from "@/lib/rate-limit";

vi.mock("@/lib/funnel", async (orig) => ({ ...(await orig<typeof import("@/lib/funnel")>()), recordFunnelEvent: async () => true }));

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
