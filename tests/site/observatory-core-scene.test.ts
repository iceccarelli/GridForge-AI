import { describe, expect, it } from "vitest";
import {
  basisBannerFor,
  bindingNodeAfterPlan,
  bindingNodeAsFound,
  buildSceneModel,
  evidenceClassesIn,
  formatNumber,
  formatQuantity,
  resolveOutcome,
} from "@/lib/observatory/scene-model";
import type { ObservatoryScenario } from "@/lib/observatory/types";
import { FIXTURE_FILE, FIXTURE_HALL_A, FIXTURE_HALL_B } from "./observatory-fixtures";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("buildSceneModel (hall A: fully specified)", () => {
  const m = buildSceneModel(FIXTURE_HALL_A);

  it("nodes in path order, rack rows, ids", () => {
    expect(m.scenarioId).toBe("fixture-hall-a");
    expect(m.outcomeId).toBe("plan-dated");
    expect(m.nodes.map((n) => n.id)).toEqual(["a-utility", "a-transformer", "a-ups", "a-cooling", "a-rack"]);
    expect(m.rackRows).toEqual(FIXTURE_HALL_A.rackRows);
  });

  it("binding stage as found and after the plan, mapped through constraintKey", () => {
    expect(m.bindingAsFound).toBe("a-transformer");
    expect(m.bindingAfterPlan).toBe("a-cooling");
    expect(buildSceneModel(FIXTURE_HALL_A, "plan-undated").bindingAfterPlan).toBe("a-ups");
    expect(buildSceneModel(FIXTURE_HALL_A, "plan-undated").outcomeId).toBe("plan-undated");
  });

  it("an unknown outcome id falls back to the headline outcome (and says so in outcomeId)", () => {
    const x = buildSceneModel(FIXTURE_HALL_A, "does-not-exist");
    expect(x.outcomeId).toBe("plan-dated");
    expect(resolveOutcome(FIXTURE_HALL_A, "nope")?.id).toBe("plan-dated");
    expect(resolveOutcome({ ...FIXTURE_HALL_A, headlineOutcome: "gone" })?.id).toBe("plan-dated");
    expect(resolveOutcome({ ...FIXTURE_HALL_A, outcomes: [] })).toBeNull();
  });

  it("is pure: same input, same output; the input is not mutated; nodes are copies", () => {
    const before = JSON.stringify(FIXTURE_HALL_A);
    const a = buildSceneModel(FIXTURE_HALL_A);
    const b = buildSceneModel(FIXTURE_HALL_A);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(FIXTURE_HALL_A)).toBe(before);
    a.nodes[0].label = "changed";
    expect(FIXTURE_HALL_A.powerPath[0].label).toBe("Utility connection");
  });

  it("the text alternative is complete: capacity vs load per stage, what binds, racks, outcome, evidence, not measured", () => {
    const t = m.textAlternative;
    expect(t).toContain("Fixture Hall A");
    expect(t).toContain("Synthetic demonstration hall");
    for (const n of FIXTURE_HALL_A.powerPath) expect(t).toContain(n.label);
    expect(t).toContain("2. Transformer: can carry 8 MW (evidence E1); asked to carry 6.5 MW (evidence E1) as found and 8 MW (evidence E1) after the plan; this stage binds as found.");
    expect(t).toContain("Binding stage as found: Transformer.");
    expect(t).toContain("Binding stage after the plan: Cooling plant.");
    expect(t).toContain("Row 1: 60 racks; 5 kW per rack as found, 8 kW per rack after the plan.");
    expect(t).toContain("Row 2: 40 racks; not stated as found, not stated after the plan.");
    expect(t).toContain("Racks: 100 as found, 128 after the plan");
    expect(t).toContain("Time to full capacity: 52 weeks, from supplied lead times (evidence E3).");
    expect(t).toContain("Unpriced components the capital cost omits: site works.");
    expect(t).toContain("Evidence class for this outcome: E3.");
    expect(t).toContain("range 2,000,000 to 3,100,000 EUR");
    expect(t).toMatch(/Modelled from invented inputs, not measured\./);
    expect(t).toContain("The calibration ledger is empty.");
  });

  it("an undated outcome says not dated and gives no date or weeks; a missing cost is not priced, never 0", () => {
    const t = buildSceneModel(FIXTURE_HALL_A, "plan-undated").textAlternative;
    expect(t).toContain("Time to full capacity: not dated (no supplied lead time); no date is given.");
    expect(t).toContain("Capital cost: not priced (no supplied cost).");
    expect(t).not.toMatch(/\b0 (weeks|EUR)/);
    expect(t).toContain("Unpriced components the capital cost omits: coolant distribution, commissioning.");
  });

  it("the banner carries exactly the evidence range present and the standing caveats", () => {
    expect(evidenceClassesIn(FIXTURE_HALL_A)).toEqual(["E0", "E1", "E2", "E3"]);
    expect(m.basisBanner).toBe(
      "Synthetic demonstration hall. Engine-modelled values (evidence E0–E3 as labelled), not measurements; calibration ledger empty.",
    );
  });
});

describe("buildSceneModel never guesses (hall B: awkward data)", () => {
  const m = buildSceneModel(FIXTURE_HALL_B);

  it("nothing flagged as binding -> null; a post-plan constraint no stage maps to -> null", () => {
    expect(bindingNodeAsFound(FIXTURE_HALL_B)).toBeNull();
    expect(m.bindingAsFound).toBeNull();
    expect(m.bindingAfterPlan).toBeNull();
    expect(m.textAlternative).toContain("Binding stage as found: the engine output does not identify one, so none is named.");
    expect(m.textAlternative).toContain("Binding stage after the plan: the engine output does not identify one, so none is named.");
  });

  it("a missing capacity is stated as not available, never 0", () => {
    expect(m.textAlternative).toContain("Busway: capacity not available");
    expect(m.textAlternative).not.toMatch(/can carry 0 /);
    expect(m.textAlternative).toContain("Racks: no rack rows are given.");
  });

  it("falls back to the constraint flagged binding when no node is flagged, and null when it maps to no node", () => {
    const sc = clone(FIXTURE_HALL_A);
    sc.powerPath.forEach((n) => (n.binds = false));
    expect(bindingNodeAsFound(sc)?.id).toBe("a-transformer"); // constraint "transformer" binds
    sc.constraints.forEach((c) => (c.binds = false));
    expect(bindingNodeAsFound(sc)).toBeNull();
    const orphan = clone(FIXTURE_HALL_A);
    orphan.powerPath.forEach((n) => (n.binds = false));
    orphan.powerPath.forEach((n) => (n.constraintKey = null));
    expect(bindingNodeAsFound(orphan)).toBeNull();
  });

  it("no outcomes at all: still a model, with an empty outcomeId and no after-plan claim", () => {
    const sc: ObservatoryScenario = { ...clone(FIXTURE_HALL_A), outcomes: [] };
    const x = buildSceneModel(sc);
    expect(x.outcomeId).toBe("");
    expect(x.bindingAfterPlan).toBeNull();
    expect(bindingNodeAfterPlan(sc, null)).toBeNull();
    expect(x.textAlternative).toContain("No outcome is given for this hall.");
    expect(x.textAlternative).not.toContain("Binding stage after the plan");
  });

  it("the banner never claims a stronger basis than the data: one class, higher classes, none", () => {
    const one = clone(FIXTURE_HALL_B);
    expect(basisBannerFor(one)).toContain("evidence E0–E1 as labelled");
    const high = clone(FIXTURE_HALL_A);
    high.outcomes[0].evidence = "E5";
    expect(basisBannerFor(high)).toContain("evidence E0–E5 as labelled");
    expect(basisBannerFor(high)).toContain("not measurements");
    const single = clone(FIXTURE_HALL_A);
    single.powerPath.forEach((n) => { n.capacity.evidence = "E1"; if (n.loadAsFound) n.loadAsFound.evidence = "E1"; if (n.loadAfterPlan) n.loadAfterPlan.evidence = "E1"; });
    single.constraints.forEach((c) => (c.evidence = "E1"));
    single.outcomes.forEach((o) => { o.evidence = "E1"; o.itLoadKwAfterPlan.evidence = "E1"; o.weeksToCapacity.evidence = "E1"; o.capexEur.evidence = "E1"; });
    expect(basisBannerFor(single)).toBe("Synthetic demonstration hall. Engine-modelled values (evidence E1 as labelled), not measurements; calibration ledger empty.");
    const none = { ...clone(FIXTURE_HALL_A), powerPath: [], constraints: [], outcomes: [] };
    expect(basisBannerFor(none)).toContain("evidence class not stated");
  });
});

describe("formatting is deterministic and locale-free", () => {
  it("formatNumber", () => {
    expect(formatNumber(12)).toBe("12");
    expect(formatNumber(12.5)).toBe("12.5");
    expect(formatNumber(1234567.891)).toBe("1,234,567.89");
    expect(formatNumber(-1234.5)).toBe("-1,234.5");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(Number.NaN)).toBe("n/a");
  });
  it("formatQuantity", () => {
    expect(formatQuantity(null)).toBe("no figure supplied");
    expect(formatQuantity({ value: null, low: null, high: null, unit: "MW", evidence: "E0" })).toBe("not available");
    expect(formatQuantity({ value: 5, low: 4, high: 6, unit: "MW", evidence: "E2" })).toBe("5 MW (evidence E2, range 4 to 6 MW)");
    expect(formatQuantity({ value: 5, low: 5, high: 5, unit: "MW", evidence: "E2" })).toBe("5 MW (evidence E2)");
  });
  it("the fixture file has two scenarios", () => {
    expect(FIXTURE_FILE.scenarios).toHaveLength(2);
  });
});
