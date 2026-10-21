/**
 * The pure pricing helpers behind /developers, /pricing and the API portal. Every expectation is derived from the
 * registries (PAYG, the API plans, public/reference/tools.json) rather than retyped, so these tests fail when the
 * helpers stop reading the registry, not when someone legitimately reprices.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_PRODUCTS, PAYG, PRODUCTS, eurFromCents, paygCapUnits } from "@/lib/products";
import {
  PER_HALL_ENDPOINTS,
  billingRuleText,
  breakEven,
  breakEvens,
  callsInFreeAllowance,
  capPresets,
  compareMonthly,
  enableStatement,
  estimateOperation,
  eurExact,
  formatUtc,
  isPerHall,
  normaliseHalls,
  parseToolRates,
  unitSummary,
  unitsFor,
  validateCapEur,
  type ToolRate,
} from "@/lib/payg-pricing";

const ROOT = path.resolve(__dirname, "../..");
const toolsJson = JSON.parse(fs.readFileSync(path.join(ROOT, "public/reference/tools.json"), "utf8"));
const rates = parseToolRates(toolsJson);
const byEndpoint = (e: string) => rates.find((r) => r.endpoint === e)!;

describe("the rate rows come from the engine's own catalogue", () => {
  it("parses every tool in tools.json and keeps the published units", () => {
    expect(rates.length).toBe(toolsJson.tools.length);
    for (const t of toolsJson.tools) expect(byEndpoint(t.endpoint).units).toBe(t.units);
  });
  it("the free qualifier is zero units and nothing else is free", () => {
    expect(byEndpoint("/v1/qualify").units).toBe(0);
    expect(rates.filter((r) => r.units === 0).map((r) => r.endpoint)).toEqual(["/v1/qualify"]);
  });
  it("drops malformed rows instead of repairing them", () => {
    const parsed = parseToolRates({ tools: [{ name: "a", endpoint: "/x", units: 2 }, { name: "b" }, { name: "c", endpoint: "/c", units: -1 }, null, "x"] });
    expect(parsed.map((r) => r.name)).toEqual(["a"]);
    expect(parseToolRates(null)).toEqual([]);
    expect(parseToolRates({ tools: "nope" })).toEqual([]);
  });
  it("the per-hall list mirrors what the catalogue says in words", () => {
    for (const r of rates) {
      const saysPerHall = /per hall/i.test(`${r.returns ?? ""} ${r.description ?? ""}`);
      expect(isPerHall(r), r.endpoint).toBe(saysPerHall);
    }
    expect(PER_HALL_ENDPOINTS).toContain("/v1/portfolio");
  });
});

describe("cost of an operation", () => {
  it("a portfolio is billed per hall, everything else per call", () => {
    const portfolio = byEndpoint("/v1/portfolio");
    expect(unitsFor(portfolio, 12)).toBe(portfolio.units * 12);
    const study = byEndpoint("/v1/study");
    expect(unitsFor(study, 12)).toBe(study.units);
  });
  it("euros are units times the registry's unit price", () => {
    const portfolio = byEndpoint("/v1/portfolio");
    const e = estimateOperation(portfolio, 40);
    expect(e.units).toBe(portfolio.units * 40);
    expect(e.cents).toBe(e.units * PAYG.unitPriceCents);
    expect(e.basis).toMatch(/per hall/);
    expect(e.free).toBe(false);
  });
  it("a free endpoint costs nothing and says so", () => {
    const e = estimateOperation(byEndpoint("/v1/qualify"));
    expect(e).toMatchObject({ units: 0, cents: 0, free: true });
    expect(e.basis).toMatch(/free/i);
    expect(callsInFreeAllowance(0)).toBeNull();
  });
  it("normalises hall counts: whole, at least one, bounded", () => {
    expect(normaliseHalls("7.9")).toBe(7);
    expect(normaliseHalls(0)).toBe(1);
    expect(normaliseHalls(-4)).toBe(1);
    expect(normaliseHalls("abc")).toBe(1);
    expect(normaliseHalls(10 ** 9)).toBeLessThanOrEqual(10_000);
  });
  it("counts how many calls the free allowance covers", () => {
    expect(callsInFreeAllowance(1)).toBe(PAYG.freeAllowanceUnits);
    expect(callsInFreeAllowance(PAYG.freeAllowanceUnits + 1)).toBe(0);
  });
  it("formats euros exactly: whole stays whole, anything else has cents", () => {
    expect(eurExact(200)).toBe(eurFromCents(200));
    expect(eurExact(50)).toMatch(/0[.,]50/);
    expect(eurExact(0)).toMatch(/0/);
  });
  it("summarises units from the rows", () => {
    const text = unitSummary(rates);
    expect(text).toContain(`${byEndpoint("/v1/study").units} unit`);
    expect(text).toMatch(/per hall\.$/);
    expect(unitSummary([])).toBe("");
  });
  it("formats timestamps in UTC whatever the zone", () => {
    expect(formatUtc("2026-03-05T23:30:00+02:00")).toBe("2026-03-05 21:30 UTC");
    expect(formatUtc("garbage")).toBe("garbage");
  });
});

describe("cap validation uses the registry's bounds", () => {
  it("accepts the bounds and the default, as text or number", () => {
    for (const eur of [PAYG.minCapEur, PAYG.defaultCapEur, PAYG.maxCapEur]) {
      for (const v of [eur, String(eur), ` ${eur} `]) {
        const c = validateCapEur(v);
        expect(c.ok).toBe(true);
        expect(c.capEur).toBe(eur);
        expect(c.units).toBe(paygCapUnits(eur));
      }
    }
  });
  it("refuses out of range, fractional, empty and non-numeric input with a reason", () => {
    for (const v of [PAYG.minCapEur - 1, PAYG.maxCapEur + 1, 0, -5, "12.5", "", "   ", "abc", NaN, null, undefined, "1e3x"]) {
      const c = validateCapEur(v);
      expect(c.ok, String(v)).toBe(false);
      expect(c.error).toBeTruthy();
      expect(c.capEur).toBeNull();
    }
    expect(validateCapEur(PAYG.maxCapEur + 1).error).toContain(eurExact(PAYG.maxCapEur * 100));
  });
  it("presets are inside the bounds, ordered and unique", () => {
    const p = capPresets();
    expect([...p].sort((a, b) => a - b)).toEqual(p);
    expect(new Set(p).size).toBe(p.length);
    for (const x of p) expect(validateCapEur(x).ok).toBe(true);
    expect(p).toContain(PAYG.defaultCapEur);
  });
});

describe("break-even is computed from the plans and the unit price", () => {
  it("is ceil(plan price / unit price) for every API plan", () => {
    for (const plan of API_PRODUCTS) {
      const b = breakEven(plan);
      expect(b.breakEvenUnits).toBe(Math.ceil(plan.amountCents / PAYG.unitPriceCents));
      expect(b.everCheaper).toBe(b.breakEvenUnits <= (plan.apiUnits ?? 0));
      expect(b.text).toContain(plan.name);
      expect(b.text).toContain(eurFromCents(plan.amountCents));
      if (b.everCheaper) expect(b.text).toContain(b.breakEvenUnits.toLocaleString("en-IE"));
    }
  });
  it("is ordered by price and flags a break-even above the highest cap", () => {
    const all = breakEvens();
    expect(all.map((b) => b.planCents)).toEqual([...all.map((b) => b.planCents)].sort((a, b) => a - b));
    for (const b of all) {
      expect(b.beyondCap).toBe(b.breakEvenUnits > paygCapUnits(PAYG.maxCapEur));
      if (b.beyondCap && b.everCheaper) expect(b.text).toMatch(/cap-limited account cannot reach/);
    }
  });
  it("says so when a plan never undercuts metering inside its own allowance", () => {
    const b = breakEven(PRODUCTS.api_triage, 1); // a unit price so low no plan can beat it
    expect(b.everCheaper).toBe(false);
    expect(b.text).toMatch(/does not undercut/);
  });
});

describe("monthly comparison", () => {
  it("a month inside the free allowance is free and needs no card", () => {
    const m = compareMonthly(PAYG.freeAllowanceUnits);
    expect(m.withinFree).toBe(true);
    expect(m.cheapest).toMatchObject({ kind: "free", cents: 0 });
  });
  it("above the allowance it prices at the unit price and names the cap that covers it", () => {
    const units = PAYG.freeAllowanceUnits + 10;
    const m = compareMonthly(units);
    expect(m.paygCents).toBe(units * PAYG.unitPriceCents);
    expect(m.capNeededEur).toBe(Math.max(PAYG.minCapEur, Math.ceil(m.paygCents / 100)));
    expect(validateCapEur(m.capNeededEur).ok).toBe(true);
  });
  it("picks a plan only when its included units cover the volume and it costs less", () => {
    for (const units of [10, 100, 450, 451, 600, 601, 2000, 5000, 20_000]) {
      const m = compareMonthly(units);
      for (const c of m.plansCovering) expect(c.plan.apiUnits ?? 0).toBeGreaterThanOrEqual(units);
      if (m.cheapest.kind === "plan") expect(m.cheapest.cents).toBeLessThan(m.paygCents);
      if (m.cheapest.kind === "payg") {
        for (const c of m.plansCovering) expect(c.cents).toBeGreaterThanOrEqual(m.paygCents);
      }
    }
  });
  it("beyond the highest cap and every plan allowance it is not offered a checkout", () => {
    const biggest = Math.max(...API_PRODUCTS.map((p) => p.apiUnits ?? 0));
    const m = compareMonthly(Math.max(biggest, paygCapUnits(PAYG.maxCapEur)) + 1);
    expect(m.beyondEverything).toBe(true);
    expect(m.capNeededEur).toBeNull();
  });
  it("flags a month the minimum invoice would carry forward, exactly when that rule applies", () => {
    for (let u = 0; u < 40; u++) {
      const m = compareMonthly(u);
      expect(m.carried).toBe(!m.withinFree && m.paygCents > 0 && m.paygCents < PAYG.minInvoiceCents);
    }
  });
  it("tolerates garbage volumes", () => {
    expect(compareMonthly(NaN).units).toBe(0);
    expect(compareMonthly(-3).units).toBe(0);
  });
});

describe("the sentences customers read", () => {
  it("the billing rule states the registry's price and minimum invoice, arrears, and no double charge", () => {
    const t = billingRuleText();
    expect(t).toContain(eurExact(PAYG.unitPriceCents));
    expect(t).toContain(eurExact(PAYG.minInvoiceCents));
    expect(t).toMatch(/in arrears/);
    expect(t).toMatch(/refunded and never charged/);
    expect(t).toMatch(/Idempotency-Key is never charged twice/);
  });
  it("the enable statement carries the three promises explicitly", () => {
    const t = enableStatement(PAYG.defaultCapEur);
    expect(t).toMatch(/No charge is made now/);
    expect(t).toMatch(/invoiced monthly in arrears/);
    expect(t).toMatch(/hard stop at/);
    expect(t).toContain(eurExact(PAYG.defaultCapEur * 100));
    expect(enableStatement(null)).toMatch(/hard stop at your cap/);
  });
});

describe("no euro figure is typed outside the catalogue", () => {
  it("the new library files carry no € amount and no cents-priced literal", () => {
    for (const f of ["lib/payg-pricing.ts", "lib/payg-client.ts", "lib/tool-rates.ts"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/€\s?\d/);
      expect(src, f).not.toMatch(/[Pp]rice[A-Za-z]*\s*:\s*\d{3,}/);
    }
  });
});

// Keep the type exported and used: a ToolRate literal must satisfy the helpers.
const sample: ToolRate = { name: "x", endpoint: "/v1/screen", units: 1, tier: "client" };
describe("a hand-built row works the same as a parsed one", () => {
  it("prices it", () => expect(estimateOperation(sample).cents).toBe(PAYG.unitPriceCents));
});
