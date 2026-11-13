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
