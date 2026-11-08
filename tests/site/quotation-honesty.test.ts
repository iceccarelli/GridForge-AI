/**
 * Zero hardware margin, in words. GridForge evaluates and applies the CUSTOMER'S OWN supplier quotations and compares bids against the engine's
 * specification. It sells no equipment, takes no margin and quotes no equipment itself. This fails if any rendered quotation surface says or
 * implies otherwise: that GridForge supplies, quotes, brokers, sources or installs equipment, that it has suppliers or partners, or that it
 * names a manufacturer. It scans the rendered markup of every surface and the source text of the files that hold the copy.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NO_EQUIPMENT_STATEMENT, LEAD_TIME_NOTE, NOT_COUNTED_REASON, QUOTE_TYPE_LABEL } from "@/lib/cost-evidence-claims";
import { QuotationSection, ClaimsList } from "@/components/QuotationClaims";
import { QuotationEffectPanel, EffectBody, type Answer } from "@/components/QuotationEffectPanel";
import { QuotationReview, type QueuedClaim } from "@/components/QuotationReview";
import type { CompareResult } from "@/lib/ttp-compare";

const ROOT = path.resolve(__dirname, "../..");

/** Language that implies GridForge supplies, quotes or brokers equipment, or has suppliers, partners or a marketplace. */
export const IMPLIES_EQUIPMENT_SUPPLY: RegExp[] = [
  /\b(?:we|GridForge(?:'s)?)\s+(?:will\s+|can\s+|also\s+)?(?:supply|supplies|sell|sells|quote|quotes|broker|brokers|source|sources|procure|procures|resell|install|installs|deliver|delivers|provide|provides|offer|offers|arrange|arranges|negotiate|negotiates)\b/i,
  /\bour\s+(?:suppliers?|vendors?|partners?|manufacturers?|supplier network|marketplace|catalogue|catalog|equipment|preferred|trusted|approved)\b/i,
  /\b(?:preferred|trusted|approved|certified|recommended|vetted|vetted)\s+(?:suppliers?|vendors?|manufacturers?|partners?)\b/i,
  /\b(?:partner(?:ed|s)?\s+with|in\s+partnership\s+with|authori[sz]ed\s+(?:dealer|reseller|distributor))\b/i,
  /\b(?:get|request|order|buy|compare|receive)\s+(?:a\s+|your\s+)?(?:equipment\s+)?(?:quotes?|quotations?|prices?)\s+(?:from|via|through)\s+(?:us|gridforge)\b/i,
  /\b(?:margin|markup|mark-up|commission|rebate|referral fee)\b/i,
];
/** Manufacturers and equipment brands: none may be named on a quotation surface (no partner implied, no invented supplier list). */
export const MANUFACTURERS = /\b(?:Schneider|Vertiv|Eaton|ABB|Siemens|Caterpillar|Cummins|Jenbacher|Wartsila|Wärtsilä|Rolls-Royce|Bloom Energy|Tesla|Fluence|Motivair|CoolIT|Stulz|Trane|Carrier|Hitachi|Mitsubishi|Legrand|Rittal|Munters|Daikin|Johnson Controls|Nvidia|Dell|HPE|Lenovo|Supermicro|Vantage|Equinix)\b/i;

/** What a scan finds in a text once the one sentence that DENIES the practice is taken out. */
export function offences(text: string): string[] {
  const decoded = text.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const stripped = decoded.split(NO_EQUIPMENT_STATEMENT).join(" ").replace(/<[^>]*>/g, " ");
  const found: string[] = [];
  for (const re of IMPLIES_EQUIPMENT_SUPPLY) {
    const m = stripped.match(re);
    if (m) found.push(m[0]);
  }
  const brand = stripped.match(MANUFACTURERS);
  if (brand) found.push(brand[0]);
  return found;
}

const claim = (over: Partial<QueuedClaim> = {}): QueuedClaim => ({
  id: "c1", project_id: "p1", cost_key: "cdu.addition", item: "Coolant distribution units (CDU)", unit: "EUR", price_eur: 317450, quoted_quantity: null, quoted_quantity_unit: null,
  quote_type: "firm_quote", supplier: "SYNTHETIC-SUPPLIER-A", quoted_on: "2026-11-01", valid_until: "2099-01-01", reference: null, scope: "supply and install", lead_time_weeks: 26,
  notes: "excludes civils", submitted_by: "A. Holder", submitted_at: "2026-11-02T00:00:00Z", comparability: "limited", limitations: [], state: "validated", counted: false,
  reason: NOT_COUNTED_REASON.validated, suggested_basis: "firm_quote", review: null, retired: null,
  file: { id: "f1", filename: "quotation.pdf", media_type: "application/pdf", byte_size: 1024, sha256: "a".repeat(64), review_status: "unverified", status_text: "file not yet verified", hash_confirmed: false, decided_by: null },
  ...over,
});

const t = (n: number) => ({ value: n, low: n, high: n, unit: "weeks", evidence: "E0", label: "x" });
const scenario = { id: "a", name: "Scenario A", time_to_power: { status: "lead_time_missing", weeks: null, low: null, high: null, evidence: null, reason: "No defensible date", date_basis: "none", date_evidence_class: null, lead_times: [{ constraint: "cooling_plant", name: "Chilled-water plant uprate", domain: "thermal", lead_time_weeks: t(30), missing: false, capex_eur: null }] } };
const base = { scenarios: [scenario] } as unknown as CompareResult;
const withQ = {
  scenarios: [scenario],
  cost_evidence: {
    used: [{ evidence_id: "c1", key: "cdu.addition", unit: "EUR", value: 1, currency: "EUR", basis: "firm_quote", supplier: "SYNTHETIC-SUPPLIER-A", quoted_on: "2026-11-01", valid_until: "2099-01-01", quoted_quantity: null, quoted_quantity_unit: null, scope: "s", comparability: "limited", response_ref: null, reviewer: "R", reviewed_on: "2026-11-02", synthetic: false }],
    ignored: [{ key: "plant.uprate", evidence_id: "c2", reason: "the quotation expired on 2020-01-01" }],
    effect: { used: ["c1"], scenarios: [{ scenario: "a", capex_before_eur: 1000, capex_after_eur: 1200, capex_complete_before: false, capex_complete_after: false, steps_changed: [{ step: 1, constraint: "cooling_plant", basis_before: "library_default", basis_after: "firm_quote", cost_keys: ["cdu.addition"] }] }] },
  },
} as unknown as CompareResult;
const answer: Answer = { offered: 1, applied: ["c1"], result: withQ, claims: [claim({ state: "accepted", counted: true, reason: null, file: { ...claim().file, review_status: "verified", status_text: "file verified", hash_confirmed: true } }), claim({ id: "c3" })], excluded: [] };

const SURFACES: [string, () => string][] = [
  ["the project's quotation section", () => renderToStaticMarkup(h(QuotationSection, { projectToken: "t", files: [{ id: "f1", filename: "q.pdf", review_status: "unverified" }] }))],
  ["the quotation list", () => renderToStaticMarkup(h(ClaimsList, { claims: [claim(), claim({ id: "c2", state: "rejected", reason: NOT_COUNTED_REASON.rejected })] }))],
  ["the effect panel before it is asked", () => renderToStaticMarkup(h(QuotationEffectPanel, { compare: {}, base, initialToken: "t" }))],
  ["the effect panel with the engine's answer", () => renderToStaticMarkup(h(EffectBody, { answer, base }))],
  ["the effect panel with nothing counted", () => renderToStaticMarkup(h(EffectBody, { answer: { ...answer, offered: 0, result: null, claims: [claim()] }, base }))],
  ["the administrator's quotation gate", () => renderToStaticMarkup(h(QuotationReview, { items: [claim()] }))],
];

describe("zero hardware margin: no quotation surface implies GridForge supplies, quotes or brokers equipment", () => {
  it.each(SURFACES)("%s", (_name, render) => {
    const html = render();
    expect(html.length).toBeGreaterThan(100);
    expect(offences(html)).toEqual([]);
  });

  it.each([["the project's quotation section"], ["the effect panel before it is asked"], ["the administrator's quotation gate"]])(
    "%s carries the statement that we sell no equipment, take no margin and quote none",
    (name) => {
      const html = SURFACES.find(([n]) => n === name)![1]().replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
      expect(html).toContain(NO_EQUIPMENT_STATEMENT);
    }
  );

  it("states it plainly, and the statement itself is pinned so it cannot drift into the language it denies", () => {
    // The statement is the one sentence every scan lets through, so it is pinned word for word and its remainder is scanned.
    expect(NO_EQUIPMENT_STATEMENT).toBe(
      "GridForge sells no equipment, takes no margin on any purchase and quotes no equipment itself. These are your own supplier's quotations: we " +
        "record them, have a named person check the document and the record, and apply them to the engine's comparison for your project."
    );
    const remainder = NO_EQUIPMENT_STATEMENT.replace("GridForge sells no equipment, takes no margin on any purchase and quotes no equipment itself.", "");
    expect(offences(remainder)).toEqual([]);
  });

  it("scans the copy in the source files too, not only what happens to render", () => {
    for (const rel of ["components/QuotationClaims.tsx", "components/QuotationEffectPanel.tsx", "components/QuotationReview.tsx", "lib/cost-evidence-claims.ts"]) {
      // The one sentence that DENIES the practice is declared once, in pieces; it is checked whole above and left out here.
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/export const NO_EQUIPMENT_STATEMENT =[\s\S]*?;\n/, "");
      // Code identifiers and comments may name the thing they refuse; only string literals and JSX text are copy.
      const copy = [...text.matchAll(/"([^"\n]{12,})"|`([^`\n]{12,})`|>([^<>{}\n]{12,})</g)].map((m) => m[1] ?? m[2] ?? m[3]).join("\n");
      expect(offences(copy), rel).toEqual([]);
    }
    expect(offences(`${LEAD_TIME_NOTE} ${Object.values(QUOTE_TYPE_LABEL).join(" ")} ${Object.values(NOT_COUNTED_REASON).join(" ")}`)).toEqual([]);
  });

  it("would catch the language it exists to forbid (the guard bites)", () => {
    for (const bad of [
      "We supply and install the equipment at a fixed price.",
      "GridForge quotes the CDUs for you.",
      "Get a quotation from GridForge in minutes.",
      "Our trusted suppliers will contact you.",
      "Our supplier network covers every major manufacturer.",
      "A preferred supplier list.",
      "GridForge sources the transformer on your behalf.",
      "We take a small margin on every order.",
      "In partnership with leading manufacturers.",
      "Quotes from Schneider and Vertiv.",
      "GridForge brokers the best price.",
    ]) {
      expect(offences(bad), bad).not.toEqual([]);
    }
    // ...and lets through the sentence that denies the practice, and plain statements about the customer's own quotations
    expect(offences(NO_EQUIPMENT_STATEMENT)).toEqual([]);
    expect(offences("Your supplier's quotation is applied to the engine's comparison. A reviewer accepts the record.")).toEqual([]);
  });
});
