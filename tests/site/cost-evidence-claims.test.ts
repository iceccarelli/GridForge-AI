/**
 * The rules of a supplier-quotation claim that need no database and no engine process: what is accepted from a project holder, how the
 * catalogue of quotable items is held to the engine's own source, how the engine's answer is arranged for a reader, and when the admin screen
 * offers to accept. Every supplier, price and date is a SYNTHETIC fixture.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BAD_CHARS,
  BAD_RANGES,
  ENGINE_BASIS_LABEL,
  LIMITS,
  QUOTABLE_ITEMS,
  QUOTABLE_KEYS,
  basisLabel,
  checkClaim,
  claimComparability,
  claimSchema,
  itemFor,
} from "@/lib/cost-evidence-claims";
import { claimDigest } from "@/lib/project-quotation-claims";
import { claimBody } from "@/components/QuotationClaims";
import { acceptGate } from "@/components/QuotationReview";
import { effectView } from "@/lib/quotation-effect";
import type { CompareResult } from "@/lib/ttp-compare";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const TODAY = "2026-11-08";
const FILE = "11111111-1111-4111-8111-111111111111";
const good = (over: Record<string, unknown> = {}) => ({
  file_id: FILE, cost_key: "cdu.addition", unit: "EUR", price_eur: 317450, quote_type: "firm_quote", supplier: "SYNTHETIC-SUPPLIER-A",
  quoted_on: "2026-11-01", valid_until: "2027-03-31", scope: "supply and mechanical install", submitted_by: "A. Holder", ...over,
});
const parse = (over: Record<string, unknown> = {}) => claimSchema.safeParse(good(over));

describe("what a project holder may claim", () => {
  it("accepts a well-formed claim and trims the text", () => {
    const r = parse({ supplier: "  SYNTHETIC-SUPPLIER-A  ", lead_time_weeks: 26, notes: "excludes civils\ncommissioning separate", reference: "REF-1" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.supplier).toBe("SYNTHETIC-SUPPLIER-A");
  });

  it.each([
    ["a right-to-left override in the supplier", { supplier: "ACME" + String.fromCharCode(0x202e) + "SYN" }],
    ["a zero-width space in the supplier", { supplier: "ACME" + String.fromCharCode(0x200b) + "SYN" }],
    ["a newline in the scope", { scope: "a\nb" }],
    ["a NUL in the reference", { reference: "a" + String.fromCharCode(0) + "b" }],
    ["a bidi isolate in the notes", { notes: "x" + String.fromCharCode(0x2066) + "y" }],
    ["an empty supplier", { supplier: "   " }],
    ["a supplier over the bound", { supplier: "x".repeat(LIMITS.supplier + 1) }],
    ["notes over the bound", { notes: "x".repeat(LIMITS.notes + 1) }],
    ["a price of zero", { price_eur: 0 }],
    ["a price below a cent", { price_eur: 0.001 }],
    ["a quantity that would make the engine's capex infinite", { quoted_quantity: 1e-320 }],
    ["a quantity below the bound", { quoted_quantity: 0.0001 }],
    ["a soft hyphen in the supplier", { supplier: "ACME" + String.fromCodePoint(0xad) + "SYN" }],
    ["a Mongolian vowel separator in the supplier", { supplier: "ACME" + String.fromCodePoint(0x180e) + "SYN" }],
    ["a tag character in the scope", { scope: "x" + String.fromCodePoint(0xe0041) }],
    ["a variation selector in the reference", { reference: "x" + String.fromCodePoint(0xfe0f) }],
    ["a variation selector from the supplement in the supplier", { supplier: "x" + String.fromCodePoint(0xe0100) }],
    ["an escape character in the notes", { notes: "x" + String.fromCodePoint(0x1b) + "[31m" }],
    ["a unit with a character outside the alphabet", { unit: "EUR/m2;--" }],
    ["a negative price", { price_eur: -1 }],
    ["a price over the ceiling", { price_eur: LIMITS.maxPriceEur + 1 }],
    ["a non-finite price", { price_eur: Infinity }],
    ["a price that is text", { price_eur: "5" }],
    ["a lead time of zero", { lead_time_weeks: 0 }],
    ["a lead time beyond the bound", { lead_time_weeks: LIMITS.maxLeadWeeks + 1 }],
    ["an impossible date", { quoted_on: "2026-02-30" }],
    ["a date that is not ISO", { valid_until: "31/03/2027" }],
    ["a key outside the catalogue", { cost_key: "made.up" }],
    ["a missing quote type", { quote_type: undefined }],
    ["a quote type the engine has no word for", { quote_type: "contracted" }],
    ["a field the caller has no business setting", { state: "accepted" }],
    ["a basis the reviewer alone decides", { basis: "firm_quote" }],
    ["a file id that is not a uuid", { file_id: "q.pdf" }],
  ])("refuses %s", (_name, over) => {
    expect(parse(over).success).toBe(false);
  });

  it("checks the calendar with the server's today: the validity date must be in the future and not before the quotation", () => {
    const c = (over: Record<string, unknown>) => {
      const r = parse(over);
      if (!r.success) throw new Error("fixture should parse");
      return checkClaim(r.data, TODAY).map((p) => p.path);
    };
    expect(c({})).toEqual([]);
    expect(c({ valid_until: "2026-11-08" })).toContain("valid_until");        // today is not "in the future"
    expect(c({ valid_until: "2026-11-09" })).toEqual([]);
    expect(c({ valid_until: "2026-10-01" })).toContain("valid_until");
    expect(c({ quoted_on: "2026-11-20", valid_until: "2026-11-15" })).toContain("valid_until");
    expect(c({ quoted_on: "2026-12-15" })).toContain("quoted_on");            // a quotation dated in the future
    expect(c({ quoted_on: "2026-11-09" })).toContain("quoted_on");            // tomorrow: the engine keeps the NEWEST date, so a project claim may not lead
    expect(c({ quoted_on: "2026-11-08" })).toEqual([]);                       // today is fine
    expect(c({ quoted_on: "2020-01-01" })).toContain("quoted_on");            // older than five years
  });

  it("holds the unit and the quantity to the line the engine prices", () => {
    const c = (over: Record<string, unknown>) => {
      const r = parse(over);
      if (!r.success) throw new Error("fixture should parse");
      return checkClaim(r.data, TODAY).map((p) => p.path);
    };
    expect(c({ cost_key: "plant.uprate", unit: "EUR/kW" })).toEqual([]);
    expect(c({ cost_key: "plant.uprate", unit: "EUR/MVA" })).toContain("unit");
    expect(c({ cost_key: "tapoff.unit", unit: "EUR" })).toContain("unit");        // the engine prices a tap-off per rack, not as a lump
    expect(c({ cost_key: "grid.reinforcement", unit: "EUR/kW" })).toContain("unit");
    expect(c({ cost_key: "cdu.addition", unit: "EUR", quoted_quantity: 4 })).toEqual([]);
    expect(c({ cost_key: "cdu.addition", unit: "EUR/unit", quoted_quantity: 4 })).toContain("quoted_quantity");   // a quantity belongs to a lump
    expect(c({ cost_key: "trim_chiller.adiabatic", unit: "EUR", quoted_quantity: 1 })).toContain("quoted_quantity");
  });

  it("says a lump with no stated quantity is of limited comparability, and a stated one or a per-unit price is not", () => {
    const k = (over: Record<string, unknown>) => {
      const r = parse(over);
      if (!r.success) throw new Error("fixture should parse");
      return claimComparability(r.data);
    };
    expect(k({}).comparability).toBe("limited");
    expect(k({}).limitations[0]).toMatch(/once per step, unscaled/);
    expect(k({ quoted_quantity: 4 }).comparability).toBe("exact");
    expect(k({ unit: "EUR/unit" }).comparability).toBe("exact");
    expect(k({ cost_key: "grid.reinforcement" }).comparability).toBe("exact");     // the engine does not scale this lump
  });

  it("gives the same claim the same digest and a changed price, date, file or project another", () => {
    const base = parse({ lead_time_weeks: 26 });
    if (!base.success) throw new Error("fixture should parse");
    const d = claimDigest("p1", base.data);
    expect(claimDigest("p1", base.data)).toBe(d);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    for (const over of [{ price_eur: 317451 }, { valid_until: "2027-04-01" }, { supplier: "SYNTHETIC-SUPPLIER-B" }, { lead_time_weeks: 27 }, { file_id: "22222222-2222-4222-8222-222222222222" }]) {
      const o = parse({ lead_time_weeks: 26, ...over });
      if (!o.success) throw new Error("fixture should parse");
      expect(claimDigest("p1", o.data), JSON.stringify(over)).not.toBe(d);
    }
    expect(claimDigest("p2", base.data)).not.toBe(d);
  });
});

describe("hostile text", () => {
  it("refuses the first and the last code point of every range in a line of text, and in notes (apart from tab, LF and CR)", () => {
    for (const [a, b] of BAD_RANGES) {
      for (const cp of new Set([a, b])) {
        const ch = String.fromCodePoint(cp);
        expect(BAD_CHARS.test(ch), `U+${cp.toString(16)}`).toBe(true);
        expect(parse({ scope: `x${ch}y` }).success, `scope U+${cp.toString(16)}`).toBe(false);
        if (cp !== 0) expect(parse({ notes: `x${ch}y` }).success, `notes U+${cp.toString(16)}`).toBe(false);
      }
    }
  });
  it("lets ordinary text through, including accents, CJK and emoji, and line breaks in notes only", () => {
    expect(parse({ supplier: "Soci\u00e9t\u00e9 \u00c9lectrique \u682a\u5f0f\u4f1a\u793e" }).success).toBe(true);
    expect(parse({ notes: "line one\nline two\r\n\tindented" }).success).toBe(true);
    expect(parse({ scope: "line one\nline two" }).success).toBe(false);
    expect(parse({ scope: "tab\there" }).success).toBe(false);
  });
});

describe("the identity of a claim", () => {
  it("changes when the notes, the reference or the submitter change, so an edited resubmission is a new line and never silently 'recorded'", () => {
    const base = parse({ notes: "excludes civils", reference: "R1" });
    if (!base.success) throw new Error("fixture should parse");
    const d = claimDigest("p1", base.data);
    for (const over of [{ notes: "includes civils" }, { reference: "R2" }, { submitted_by: "B. Holder" }]) {
      const o = parse({ notes: "excludes civils", reference: "R1", ...over });
      if (!o.success) throw new Error("fixture should parse");
      expect(claimDigest("p1", o.data), JSON.stringify(over)).not.toBe(d);
    }
    const same = parse({ notes: "excludes civils", reference: "R1" });
    if (!same.success) throw new Error("fixture should parse");
    expect(claimDigest("p1", same.data)).toBe(d);
  });
});

describe("the form's body is what the schema accepts, and nothing is defaulted", () => {
  const form = { file_id: FILE, cost_key: "cdu.addition", unit: "EUR", price: "317450", quantity: "", quote_type: "firm_quote" as const, supplier: "S", quoted_on: "2026-11-01", valid_until: "2027-03-31", lead: "", scope: "s", notes: "", reference: "", by: "A" };
  it("builds a body the schema accepts", () => {
    const b = claimBody(form);
    expect(b.ok).toBe(true);
    expect(b.ok && claimSchema.safeParse(b.body).success).toBe(true);
    expect(b.ok && Object.keys(b.body)).not.toContain("lead_time_weeks");        // an empty lead time is absent, not zero
  });
  it.each([["file_id", ""], ["cost_key", ""], ["unit", ""], ["price", ""], ["price", "abc"], ["price", "-3"], ["quote_type", ""]])("refuses an empty or invalid %s", (k, v) => {
    expect(claimBody({ ...form, [k]: v }).ok).toBe(false);
  });
});

describe("the catalogue of quotable items is held to the engine's own source", () => {
  const ENGINE_FILES = ["gridforge/costs.py", "gridforge/power/constraints.py", "gridforge/thermal/constraints.py", "gridforge/site/constraints.py"];
  const src = ENGINE_FILES.map(read).join("\n");

  it("lists exactly the keys the ladder prices from a single quotation", () => {
    const keys = new Set<string>();
    for (const m of src.matchAll(/(?:scaled_cost|cost)\(\s*"([A-Za-z_]+\.[A-Za-z_.]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/cost_key="([A-Za-z_]+\.[A-Za-z_.]+)"/g)) keys.add(m[1]);
    // cdu.integration and cdu.commissioning are components of a CDU purchase a reviewer lists under `includes_keys`, not items a claim prices.
    expect([...keys].filter((k) => k !== "cdu.integration" && k !== "cdu.commissioning").sort()).toEqual([...QUOTABLE_KEYS].sort());
  });

  it.each(QUOTABLE_ITEMS.map((i) => [i.key, i] as const))("%s: the unit and the quantity unit are the ones the engine prices it in", (key, item) => {
    // The call that prices the line (not the set of capacity-scaled keys in costs.py, which names it too).
    const at = src.search(new RegExp(`(?:scaled_cost|\\bcost)\\(\\s*"${key.replace(/\./g, "\\.")}"`));
    expect(at, `${key} not found in the engine source`).toBeGreaterThan(-1);
    const near = src.slice(at, at + 260);
    const perUnit = item.units.find((u) => u !== "EUR");
    if (perUnit) expect(near, `${key} per-unit price ${perUnit}`).toContain(`"${perUnit}"`);
    else expect(near).toContain('"EUR"');
    if (item.quantityUnit) expect(near, `${key} quantity unit`).toContain(`"${item.quantityUnit}"`);
    expect(itemFor(key)).toBe(item);
  });

  it("words every cost basis exactly as the engine does", () => {
    const block = read("gridforge/costs.py").match(/BASIS_LABEL: dict\[str, str\] = \{([^}]*)\}/)![1];
    const engine = Object.fromEntries([...block.matchAll(/"([a-z_]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(ENGINE_BASIS_LABEL).toEqual(engine);
    expect(basisLabel("firm_quote")).toBe("firm supplier quote");
    expect(basisLabel("budgetary_quote")).toBe("budgetary supplier quote");
    expect(basisLabel("something_new")).toBe("something new");                       // an unknown key is shown as it came, never guessed
  });
});

describe("the engine's answer, arranged for a reader", () => {
  const q = (value: number) => ({ value, low: value, high: value, unit: "weeks", evidence: "E0", label: "x" });
  const scenario = (id: string, weeks: number | null, basis: "assumed" | "none") => ({
    id, name: `Scenario ${id}`,
    time_to_power: { status: weeks === null ? "lead_time_missing" : "dated", weeks, low: weeks, high: weeks, evidence: "E0", date_basis: basis, date_evidence_class: "E0", lead_times: [{ constraint: "cooling_plant", name: "Chilled-water plant uprate", domain: "thermal", lead_time_weeks: q(30), missing: false, capex_eur: null }] },
  });
  const base = { scenarios: [scenario("a", 52, "assumed"), scenario("b", null, "none")] } as unknown as CompareResult;
  const withQ = (weeksA: number | null) => ({
    scenarios: [scenario("a", weeksA, "assumed"), scenario("b", null, "none")],
    cost_evidence: {
      used: [{ evidence_id: "E1", key: "plant.uprate", unit: "EUR", value: 1, currency: "EUR", basis: "firm_quote", supplier: "SYNTHETIC-SUPPLIER-A", quoted_on: "2026-11-01", valid_until: "2027-03-31", quoted_quantity: null, quoted_quantity_unit: null, scope: "s", comparability: "limited", response_ref: null, reviewer: "R", reviewed_on: "2026-11-02", synthetic: false }],
      ignored: [{ key: "cdu.addition", evidence_id: "E2", reason: "the quotation expired on 2020-01-01" }],
      effect: {
        used: ["E1"],
        scenarios: [
          { scenario: "a", racks_before: 10, racks_after: 10, capex_before_eur: 900000, capex_after_eur: 1100000, capex_delta_eur: 200000, capex_complete_before: false, capex_complete_after: true, decision_grade_before: false, decision_grade_after: true, placeholder_lines_before: 2, placeholder_lines_after: 1,
            steps_changed: [{ step: 1, constraint: "cooling_plant", basis_before: "library_default", basis_after: "firm_quote", capex_before_eur: 400000, capex_after_eur: 600000, price_kind_after: "quoted_scaled", cost_keys: ["plant.uprate"] }] },
          { scenario: "b", capex_before_eur: 1, capex_after_eur: 1, capex_complete_after: false, steps_changed: [] },
          { scenario: "not_compared", capex_before_eur: 1, capex_after_eur: 1, capex_complete_after: false, steps_changed: [] },
        ],
      },
    },
  }) as unknown as CompareResult;

  it("reports the engine's before and after, whether capex is complete, and the steps in the engine's words", () => {
    const v = effectView(base, withQ(52))!;
    expect(v.scenarios.map((s) => s.id)).toEqual(["a", "b"]);                       // only the scenarios compared
    const a = v.scenarios[0];
    expect(a).toMatchObject({ capex_before_eur: 900000, capex_after_eur: 1100000, capex_delta_eur: 200000, complete_before: false, complete_after: true, decision_grade_after: true });
    expect(a.steps).toEqual([{ step: 1, name: "Chilled-water plant uprate", from: "library placeholder (not a price)", to: "firm supplier quote", capex_before_eur: 400000, capex_after_eur: 600000, price_kind: "quoted_scaled", cost_keys: ["plant.uprate"] }]);
    expect(v.ignored).toEqual([{ key: "cdu.addition", evidence_id: "E2", reason: "the quotation expired on 2020-01-01" }]);   // the engine's exact reason
    expect(v.used[0]).toMatchObject({ basis_label: "firm supplier quote", comparability: "limited", reviewer: "R" });
  });

  it("says the date did not move when the engine gave the same weeks, and that it did when it did not", () => {
    expect(effectView(base, withQ(52))!.scenarios[0].date_unchanged).toBe(true);
    expect(effectView(base, withQ(48))!.scenarios[0]).toMatchObject({ date_unchanged: false, weeks_without: 52, weeks_with: 48 });
    expect(effectView(base, withQ(52))!.scenarios[1].date_unchanged).toBe(true);     // undated either way
  });

  it("returns nothing when the engine gave no cost-evidence account, rather than an invented one", () => {
    expect(effectView(base, base)).toBeNull();
  });
});

describe("when the admin screen offers to accept a quotation", () => {
  const verified = { review_status: "verified" as const, hash_confirmed: true };
  const unverified = { review_status: "unverified" as const, hash_confirmed: false };
  const c = (over: Record<string, unknown> = {}) => ({ state: "validated", valid_until: "2099-01-01", file: verified, ...over }) as Parameters<typeof acceptGate>[0];
  it("offers it only for a validated, in-date quotation on a file whose digest a person confirmed", () => {
    expect(acceptGate(c(), undefined, TODAY).accept).toBe(true);
    expect(acceptGate(c({ file: unverified }), undefined, TODAY)).toMatchObject({ accept: false, reason: expect.stringMatching(/not been verified/) });
    expect(acceptGate(c({ file: { review_status: "verified", hash_confirmed: false } }), undefined, TODAY).accept).toBe(false);   // verified without a confirmed digest does not count
    expect(acceptGate(c({ valid_until: "2026-01-01" }), undefined, TODAY)).toMatchObject({ accept: false, reason: expect.stringMatching(/Expired/) });
    expect(acceptGate(c({ state: "accepted" }), undefined, TODAY)).toEqual({ accept: false, reason: null });
    expect(acceptGate(c({ file: { review_status: "rejected", hash_confirmed: false } }), undefined, TODAY).accept).toBe(false);
  });
  it("follows a file decision made in this session, and never a rejected one", () => {
    expect(acceptGate(c({ file: unverified }), "verified", TODAY).accept).toBe(true);
    expect(acceptGate(c({ file: verified }), "rejected", TODAY).accept).toBe(false);
  });
});
