// Review fixes: caption honesty against contract v2 data (passes, capexComplete, capexPricing, no city) and the cache-age rules of
// the context response. The scenario below is shaped like the generated hall data; it is a TEST FIXTURE, invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildJourney, capexSentence, constraintPasses, placeFreeName, shownConstraintName } from "@/lib/observatory/journey";
import { lintCaption } from "@/lib/observatory/captions";
import {
  MAX_RESPONSE_CACHE_SECONDS,
  createContextCache,
  getLiveContextWithValidity,
  reassessFreshness,
  resetContextCache,
  validForSeconds,
} from "@/lib/observatory/sources";
import type { ConstraintResult, ObservatoryScenario, PathNode, Quantity, ScenarioFile, ScenarioOutcome } from "@/lib/observatory/types";
import { FIXTURE_FILE } from "./observatory-fixtures";
import { H, MIN, T0, awattar, grid, hourly, interval, jsonResponse, routedFetch } from "./observatory-core-harness";

const q = (value: number | null, unit: string, evidence: Quantity["evidence"] = "E0", extra: Partial<Quantity> = {}): Quantity => ({
  value,
  low: value,
  high: value,
  unit,
  evidence,
  ...extra,
});
const node = (id: string, kind: PathNode["kind"], label: string, binds: boolean, constraintKey: string | null): PathNode => ({
  id,
  kind,
  label,
  capacity: q(10, "MW"),
  loadAsFound: q(4, "MW"),
  loadAfterPlan: q(8, "MW"),
  binds,
  constraintKey,
});
const con = (key: string, name: string, racksAllowed: number | null, binds = false, evidence: Quantity["evidence"] = "E0") =>
  ({ key, name, domain: "electrical", racksAllowed, binds, basis: "test", evidence, passes: racksAllowed === null }) as ConstraintResult;
const out = (id: string, name: string, found: number, after: number, binding: string | null, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name,
    racksAsFound: found,
    racksAfterPlan: after,
    bindingAfterPlan: binding,
    itLoadKwAfterPlan: q(after * 130, "kW"),
    weeksToCapacity: q(null, "weeks", "E0", { missingReason: "assumed lead time, not a date" }),
    dated: false,
    capexEur: q(null, "EUR"),
    unpricedComponents: [],
    evidence: "E0",
    capexComplete: true,
    capexPricing: "none",
    ...extra,
  }) as ScenarioOutcome;

/** TEST FIXTURE shaped like the generated halls: nine stages (one unmodelled), a supply constraint named with behind-the-meter. */
function hall(id: string, letter: string): ObservatoryScenario {
  return {
    id,
    title: `Synthetic Hall ${letter} — Frankfurt`,
    summary: "TEST FIXTURE.",
    synthetic: true,
    hall: { name: `Synthetic Hall ${letter} — Frankfurt`, platform: "NVIDIA GB300 NVL72", contractedMW: 12, currentItLoadMW: 4.9, positionsAvailable: 180, region: "Frankfurt, DE (informational)" },
    powerPath: [
      node("utility", "utility", "Utility connection (firm supply)", false, "grid_firm_capacity"),
      node("transformer", "transformer", "Transformers (usable after redundancy and derating)", false, "transformer_capacity"),
      node("switchgear", "switchgear", "Main switchgear (not modelled by the engine)", false, null),
      node("ups", "ups", "UPS (usable after redundancy)", false, "ups_capacity"),
      node("busway", "busway", "Busway runs", false, "busway_ampacity"),
      node("rack-feed", "rack_feed", "Rack feed / tap-off (current per rack)", true, "rack_feed_tapoff"),
      node("rack", "rack", "Rack positions", false, "floor_space"),
      node("cooling-plant", "cooling", "Chilled-water plant", false, "plant_capacity"),
      node("cooling-water", "cooling", "Facility water temperature", false, "tcs_supply_achievable"),
    ],
    constraints: [
      con("rack_feed_tapoff", "Rack feed / tap-off rating", 0, true),
      con("transformer_capacity", "Transformer capacity", 7),
      con("grid_firm_capacity", "Firm supply (grid import + behind-the-meter)", 26),
      con("floor_space", "Available rack positions", 180, false, "E3"),
      con("floor_loading", "Floor loading", null),
      con("architecture_capability", "Cooling architecture per-rack capability", null),
      con("tcs_supply_achievable", "Achievable facility water temperature", null),
    ],
    rackRows: [],
    outcomes: [
      out("retained_air", "Retained air, grid only", 0, 0, "architecture_capability"),
      out("hybrid", "Hybrid DLC on retained plant, grid only", 0, 26, "grid_firm_capacity", {
        capexEur: q(6_639_999, "EUR"),
        unpricedComponents: ["CDU hydraulic integration and controls", "CDU commissioning and flushing"],
        capexComplete: false,
        capexPricing: "placeholder",
      }),
      out("btm", "Full DLC plus behind-the-meter supply", 0, 62, "grid_firm_capacity", { capexEur: q(18_800_000, "EUR"), capexComplete: true, capexPricing: "supplied" }),
    ],
    headlineOutcome: "hybrid",
    limitations: [],
  };
}
const FILE = (...s: ObservatoryScenario[]): ScenarioFile => ({ ...FIXTURE_FILE, scenarios: s });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const cap = (f: ScenarioFile, id: string) => buildJourney(f).find((s) => s.id === id)!.caption;

describe("caption honesty (a)-(i)", () => {
  const A = hall("a", "A");
  const f = FILE(A, hall("b", "B"), hall("c", "C"));

  it("(a) the context caption claims no moment and carries no figure", () => {
    const c = cap(f, "context");
    expect(c).toContain("a day-ahead auction price for an hour in Germany's market, a published result, not a live reading");
    expect(c).not.toMatch(/this hour|\bnow\b|right now|today|\d/i);
    expect(lintCaption("the price for this hour in Germany")).toContain("claims a moment (a recorded caption cannot say now)");
  });

  it("(b) the stage count is computed from the nodes and names what the path is", () => {
    const c = cap(f, "hall-1-path");
    expect(c).toContain("9 stages of the power and cooling path (7 power, 2 cooling); the engine does not model Main switchgear.");
    expect(c).not.toMatch(/through \d+ stages|power reaches/);
    const shorter = clone(f);
    shorter.scenarios[0].powerPath = shorter.scenarios[0].powerPath.filter((n) => n.kind !== "cooling" && n.kind !== "switchgear");
    expect(cap(shorter, "hall-1-path")).toContain("6 stages of the power and cooling path (6 power, 0 cooling).");
    expect(cap(shorter, "hall-1-path")).not.toContain("does not model");
    const none = clone(f);
    none.scenarios[0].powerPath = [];
    expect(cap(none, "hall-1-path")).toContain("no stages of the power and cooling path are given");
  });

  it("(c) outcome racks are NEW racks of the named platform and existing racks are separate", () => {
    expect(cap(f, "hall-1-plan")).toContain("26 new NVIDIA GB300 NVL72 racks after the plan, 0 as found; existing racks are separate.");
    expect(cap(f, "hall-1-plan")).not.toMatch(/takes .* from \d+ racks to/);
    expect(cap(f, "hall-2-outcome")).toContain("new NVIDIA GB300 NVL72 racks");
  });

  it("(d) a rack count 'allowing N' always carries its evidence class", () => {
    expect(cap(f, "hall-2-path")).toContain("the stage that binds as found is Rack feed / tap-off, allowing 0 new racks (evidence E0).");
    expect(cap(f, "hall-1-binding")).toContain("On its own it allows 0 new racks (evidence E0)");
    for (const s of buildJourney(f)) for (const m of s.caption.matchAll(/allow(?:ing|s) (\d[\d,]*) new racks(?! \(evidence E\d\))/g)) throw new Error(`${s.id}: ${m[0]}`);
  });

  it("(e) an option that deploys nothing says there is nothing to date, not that lead times are assumed", () => {
    const alt = cap(f, "hall-1-alternative");
    expect(alt).toContain("adds no new NVIDIA GB300 NVL72 racks");
    expect(alt).toContain("so nothing deploys and there is nothing to date.");
    expect(alt).not.toMatch(/Not dated|assumed|lead times/);
    expect(cap(f, "hall-1-plan")).toContain("Not dated: the lead times are assumed or missing.");
    const zero = clone(f);
    zero.scenarios[1].headlineOutcome = "retained_air";
    const c = cap(zero, "hall-2-outcome");
    expect(c).toContain("nothing to date");
    expect(c).not.toMatch(/Not dated|Modelled capital cost/);
  });

  it("(f) the supply constraint is named as the option states it: behind-the-meter only when the option says so", () => {
    expect(shownConstraintName("Firm supply (grid import + behind-the-meter)")).toBe("Firm supply (grid import)");
    expect(shownConstraintName("Firm supply (grid import + behind-the-meter)", { name: "Full DLC, grid only" } as ScenarioOutcome)).toBe("Firm supply (grid import)");
    expect(shownConstraintName("Firm supply (grid import + behind-the-meter)", { name: "Full DLC plus behind-the-meter supply" } as ScenarioOutcome)).toBe(
      "Firm supply (grid import + behind-the-meter)",
    );
    expect(shownConstraintName("Transformer capacity")).toBe("Transformer capacity");
    expect(cap(f, "hall-1-plan")).toContain("After the plan the limit is Firm supply (grid import).");
    expect(cap(f, "hall-1-plan")).not.toMatch(/behind-the-meter/);
    expect(cap(f, "hall-1-constraints")).toContain("Firm supply (grid import) 26 (E0)");
    expect(cap(f, "hall-1-constraints")).not.toMatch(/behind-the-meter/);
    const btm = clone(f);
    btm.scenarios[0].headlineOutcome = "btm";
    expect(cap(btm, "hall-1-plan")).toContain("After the plan the limit is Firm supply (grid import + behind-the-meter).");
  });

  it("(g) a constraint that passes 'does not limit the hall (passes)': never unlimited, never not-supported", () => {
    const c = cap(f, "hall-1-constraints");
    expect(c).toContain("Ranked by the new racks each allows as found (evidence class in brackets): Rack feed / tap-off rating 0 (E0), Transformer capacity 7 (E0) and Firm supply (grid import) 26 (E0).");
    expect(c).toContain("3 other constraints do not limit the hall (they pass).");
    expect(c).toContain("The limit is Rack feed / tap-off rating.");
    expect(c).not.toMatch(/Floor loading|Cooling architecture|unlimited|not supported by the inputs/);
    const two = clone(f);
    two.scenarios[0].constraints = two.scenarios[0].constraints.filter((x) => x.key !== "tcs_supply_achievable");
    expect(cap(two, "hall-1-constraints")).toContain("Floor loading and Cooling architecture per-rack capability do not limit the hall (pass).");
    const one = clone(f);
    one.scenarios[0].constraints = one.scenarios[0].constraints.filter((x) => !["tcs_supply_achievable", "architecture_capability"].includes(x.key));
    expect(cap(one, "hall-1-constraints")).toContain("Floor loading does not limit the hall (passes).");
    const allPass = clone(f);
    allPass.scenarios[0].constraints = allPass.scenarios[0].constraints.filter((x) => x.racksAllowed === null);
    expect(cap(allPass, "hall-1-constraints")).toContain("No constraint gives a finite rack limit as found. 3 other constraints do not limit the hall (they pass).");
  });

  it("(g) the passes flag decides when present; racksAllowed null decides on older data", () => {
    const c = con("x", "X", 50);
    expect(constraintPasses(c)).toBe(false);
    expect(constraintPasses({ ...c, passes: true } as ConstraintResult)).toBe(true);
    const old = { key: "y", name: "Y", domain: "electrical", racksAllowed: null, binds: false, basis: "", evidence: "E0" } as ConstraintResult;
    expect(constraintPasses(old)).toBe(true);
    const flagged = clone(f);
    (flagged.scenarios[0].constraints[1] as ConstraintResult & { passes: boolean }).passes = true; // transformer: 7 racks, flagged as passing
    expect(cap(flagged, "hall-1-constraints")).not.toContain("Transformer capacity 7");
  });

  it("(g) an after-plan limit the engine says has no finite limit is reported that way, not as 'binds'", () => {
    expect(cap(f, "hall-1-alternative")).toContain("After the plan the engine names Cooling architecture per-rack capability, though it reports no finite limit for it.");
  });

  it("(h) no caption names a city for a hall", () => {
    expect(placeFreeName("Synthetic Hall A — Frankfurt")).toBe("Synthetic Hall A");
    expect(placeFreeName("Synthetic Hall B – Dublin")).toBe("Synthetic Hall B");
    expect(placeFreeName("Synthetic Hall C")).toBe("Synthetic Hall C");
    for (const s of buildJourney(f)) expect(s.caption, s.id).not.toMatch(/Frankfurt|Dublin|Oslo|, DE\b/);
    expect(buildJourney(f)[0].caption).toContain("Synthetic Hall A, Synthetic Hall B and Synthetic Hall C");
  });

  it("(i) a partial capital cost is 'at least', priced lines only, rounded DOWN, and says what the prices are", () => {
    const hybrid = A.outcomes[1];
    expect(capexSentence(hybrid)).toBe("Modelled capital cost at least 6.6 million euros, priced lines only, at library placeholder prices.");
    expect(cap(f, "hall-1-plan")).toContain("Modelled capital cost at least 6.6 million euros, priced lines only, at library placeholder prices.");
    // complete and supplied: stated plainly, without 'at least'
    expect(capexSentence(A.outcomes[2])).toBe("Modelled capital cost 18.8 million euros, at supplied prices.");
    // capexComplete false alone, or unpriced components alone, each make it partial
    expect(capexSentence({ ...hybrid, unpricedComponents: [] } as ScenarioOutcome)).toContain("at least");
    expect(capexSentence({ ...hybrid, capexComplete: true } as ScenarioOutcome)).toContain("at least"); // still has unpriced components
    expect(capexSentence({ ...hybrid, unpricedComponents: [], capexComplete: true } as ScenarioOutcome)).toBe("Modelled capital cost 6.6 million euros, at library placeholder prices.");
    expect(capexSentence({ ...hybrid, capexPricing: "partly_supplied" } as ScenarioOutcome)).toContain("at partly supplied prices");
    // no prices -> no figure
    expect(capexSentence({ ...hybrid, capexPricing: "none" } as ScenarioOutcome)).toBe("No capital cost is given, because the inputs carry no prices.");
    expect(capexSentence({ ...hybrid, capexEur: q(null, "EUR") } as ScenarioOutcome)).toContain("No capital cost is given");
    // magnitudes
    expect(capexSentence({ ...hybrid, capexEur: q(480_900, "EUR") } as ScenarioOutcome)).toContain("at least 480 thousand euros");
    expect(capexSentence({ ...hybrid, capexEur: q(900, "EUR") } as ScenarioOutcome)).toContain("less than a thousand euros");
  });

  it("older data without the v2 fields: partial only when components are unpriced, and no pricing basis is invented", () => {
    const v1 = clone(A.outcomes[1]) as ScenarioOutcome & { capexComplete?: boolean; capexPricing?: string };
    delete v1.capexComplete;
    delete v1.capexPricing;
    expect(capexSentence(v1)).toBe("Modelled capital cost at least 6.6 million euros, priced lines only.");
    expect(capexSentence({ ...v1, unpricedComponents: [] })).toBe("Modelled capital cost 6.6 million euros.");
  });

  it("every caption of the v2-shaped tour passes the lint, and the lint only lets the modelled capital cost carry euros", () => {
    for (const s of buildJourney(f)) expect(lintCaption(s.caption), `${s.id}: ${s.caption}`).toEqual([]);
    expect(lintCaption("Modelled capital cost at least 6.6 million euros, priced lines only.")).toEqual([]);
    for (const bad of ["It costs 6.6 million euros", "from 1,200 euros", "Capital cost at least 6.6 million euros", "99 EUR", "€5", "unlimited headroom", "not supported by the inputs"]) {
      expect(lintCaption(bad), bad).not.toEqual([]);
    }
  });

  it("the tour stays about three to four minutes with the longer honest captions", () => {
    const total = buildJourney(f).reduce((a, s) => a + s.durationSec, 0);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(240);
  });
});

describe("context response cache rules (items 2 and 3)", () => {
  const HOURS_10 = Date.UTC(2026, 9, 25, 10, 0, 0);
  const routes = (rows = hourly(HOURS_10 - 2 * H, 8)) => ({ market: awattar(rows), grid: grid(Math.floor((HOURS_10 + 2 * H) / 1000)) });
  const at = async (ms: number, rs = routes()) => {
    const r = routedFetch(rs);
    return getLiveContextWithValidity({ fetch: r.fn, now: () => new Date(ms), env: {}, cache: createContextCache() });
  };

  it("never more than 300 s; otherwise the seconds until the shown price interval ends", async () => {
    expect(MAX_RESPONSE_CACHE_SECONDS).toBe(300);
    expect((await at(T0)).validForSeconds).toBe(300); // 10:30, interval ends 11:00 (1800 s)
    expect((await at(HOURS_10 + 55 * MIN)).validForSeconds).toBe(300); // exactly 300 s left
    expect((await at(HOURS_10 + 58 * MIN)).validForSeconds).toBe(120);
    expect((await at(HOURS_10 + H - 500)).validForSeconds).toBe(0); // half a second left: floor, do not cache
    expect((await at(HOURS_10)).validForSeconds).toBe(300);
  });

  it("15-minute intervals clamp to the 15-minute boundary, and the price's age limit is its interval", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => interval(HOURS_10 + i * 15 * MIN, 15 * MIN, 40 + i));
    const r = await at(HOURS_10 + 44 * MIN, routes(rows));
    expect(r.validForSeconds).toBe(60);
    expect(r.context.dayAheadPrice.provenance.maxAgeSeconds).toBe(900);
    expect(r.context.dayAheadPrice.value).toMatchObject({ windowStart: "2026-10-25T10:00:00.000Z", windowEnd: "2026-10-25T12:00:00.000Z" });
  });

  it("property: a response is never valid beyond the end of the price interval it shows, at any second of the hour", async () => {
    for (let s = 0; s < 3600; s += 7) {
      const now = HOURS_10 + s * 1000;
      const { context, validForSeconds: v } = await at(now);
      expect(context.dayAheadPrice.freshness).toBe("fresh");
      expect(now + v * 1000, `at +${s}s`).toBeLessThanOrEqual(HOURS_10 + H);
      expect(v).toBeLessThanOrEqual(300);
    }
  });

  it("also clamps to the moment the grid mix would pass its 3-hour age limit", async () => {
    const lastSecs = Math.floor(T0 / 1000) - (3 * 3600 - 10); // 10 s before it goes stale
    const r = await at(T0, { market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(lastSecs) });
    expect(r.context.generationMix.freshness).toBe("fresh");
    expect(r.validForSeconds).toBe(10);
  });

  it("values that are not fresh, and a day with no price, do not shorten the cache", async () => {
    const stale = await at(T0, { market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(T0 / 1000) - 4 * 3600) });
    expect(stale.context.generationMix.freshness).toBe("stale");
    expect(stale.validForSeconds).toBe(300);
    const noPrice = await at(T0, { market: () => jsonResponse({}, 500), grid: grid(Math.floor(T0 / 1000)) });
    expect(noPrice.validForSeconds).toBe(300);
  });

  it("validForSeconds is pure and fails safe on garbage", () => {
    const ctx = { dayAheadPrice: { freshness: "fresh", value: {}, provenance: { observedAt: "garbage", maxAgeSeconds: 10 } } } as never;
    expect(validForSeconds({ ...(ctx as object), generationMix: { freshness: "unavailable", provenance: {} }, queue: { freshness: "stale", provenance: {} }, usDemand: { freshness: "not_applicable", provenance: {} } } as never, null, new Date(T0))).toBe(0);
  });

  it("consumers can re-assess a held response with the same single rule", async () => {
    const now = HOURS_10 + 58 * MIN;
    const { context } = await at(now, { market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(now / 1000)) });
    const p = context.dayAheadPrice;
    expect(reassessFreshness(p, new Date(HOURS_10 + 59 * MIN))).toBe("fresh");
    expect(reassessFreshness(p, new Date(HOURS_10 + H + 1))).toBe("stale"); // the previous hour's price, later
    expect(reassessFreshness(p, new Date(HOURS_10 + 3 * H))).toBe("stale");
    expect(reassessFreshness(context.usDemand, new Date(T0))).toBe("not_applicable");
    expect(reassessFreshness({ ...p, value: null }, new Date(T0))).toBe("unavailable");
    expect(reassessFreshness(context.generationMix, new Date(HOURS_10 + 10 * H))).toBe("stale");
  });

  it("the window min/max/avg are over carries its own start and end, from the intervals actually used", async () => {
    const rows = [interval(HOURS_10 - 5 * H, H, 10), interval(HOURS_10, H, 30), interval(HOURS_10 + 20 * H, H, 90)];
    const p = (await at(T0, routes(rows))).context.dayAheadPrice.value!;
    expect(p).toMatchObject({ eurPerMWh: 30, min: 10, max: 90, avg: 43.33, windowStart: "2026-10-25T05:00:00.000Z", windowEnd: "2026-10-26T07:00:00.000Z" });
  });
});

describe("route Cache-Control follows the validity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetContextCache();
    vi.stubEnv("EIA_API_KEY", "");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetContextCache();
  });
  const HOURS_10 = Date.UTC(2026, 9, 25, 10, 0, 0);

  async function headerAt(ms: number, ok = true) {
    vi.setSystemTime(ms);
    resetContextCache();
    const r = routedFetch(ok ? { market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(ms / 1000)) } : { market: () => jsonResponse({}, 500), grid: () => jsonResponse({}, 500) });
    vi.stubGlobal("fetch", r.fn);
    const { GET } = await import("@/app/api/observatory/context/route");
    const res = await GET();
    return res.headers.get("cache-control");
  }

  it("is clamped to the end of the price interval and has no stale-while-revalidate", async () => {
    expect(await headerAt(HOURS_10 + 30 * MIN)).toBe("public, max-age=0, s-maxage=300");
    expect(await headerAt(HOURS_10 + 58 * MIN)).toBe("public, max-age=0, s-maxage=120");
    expect(await headerAt(HOURS_10 + H - 500)).toBe("public, max-age=0, s-maxage=0");
    for (const t of [HOURS_10 + 30 * MIN, HOURS_10 + 58 * MIN]) expect(await headerAt(t)).not.toMatch(/stale-while-revalidate/);
  });

  it("an outage is capped at 30 s, and never above the validity", async () => {
    expect(await headerAt(HOURS_10 + 30 * MIN, false)).toBe("public, max-age=0, s-maxage=30");
  });

  it("the route documents that consumers recompute age from generatedAt", async () => {
    const src = (await import("node:fs")).readFileSync("app/api/observatory/context/route.ts", "utf8");
    expect(src).toMatch(/recompute age from `generatedAt`/);
    expect(src).toMatch(/reassessFreshness/);
  });
});
