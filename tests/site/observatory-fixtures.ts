// TEST FIXTURE. Every number, name and date below is INVENTED for tests. It is not engine output, not a customer, not a measurement,
// and it must never be shown by the site. It exists so the core logic can be tested without depending on the generated
// public/observatory/scenarios.json. (Canonical fixture for the Observatory core tests; keep it small and valid.)
import type { ObservatoryScenario, PathNode, Quantity, ScenarioFile } from "@/lib/observatory/types";

const q = (value: number | null, unit: string, evidence: Quantity["evidence"] = "E1", extra: Partial<Quantity> = {}): Quantity => ({
  value,
  low: value,
  high: value,
  unit,
  evidence,
  ...extra,
});

function node(
  id: string,
  kind: PathNode["kind"],
  label: string,
  cap: number | null,
  asFound: number | null,
  afterPlan: number | null,
  binds: boolean,
  constraintKey: string | null,
): PathNode {
  return {
    id,
    kind,
    label,
    capacity: q(cap, "MW"),
    loadAsFound: asFound === null ? null : q(asFound, "MW"),
    loadAfterPlan: afterPlan === null ? null : q(afterPlan, "MW"),
    binds,
    constraintKey,
  };
}

/** Hall A: a fully specified hall. The transformer binds as found; after the plan the cooling binds. One dated, one undated outcome. */
export const FIXTURE_HALL_A: ObservatoryScenario = {
  id: "fixture-hall-a",
  title: "Fixture Hall A",
  summary: "TEST FIXTURE. An invented hall used only by tests. It is not a real site.",
  synthetic: true,
  hall: { name: "Fixture Hall A", platform: "air-cooled, 2N", contractedMW: 12, currentItLoadMW: 6.5, positionsAvailable: 120, region: "Nowhere (invented)" },
  powerPath: [
    node("a-utility", "utility", "Utility connection", 12, 6.5, 9, false, "utility"),
    node("a-transformer", "transformer", "Transformer", 8, 6.5, 8, true, "transformer"),
    node("a-ups", "ups", "UPS", 10, 6.5, 9, false, "ups"),
    node("a-cooling", "cooling", "Cooling plant", 9, 6.5, 9, false, "cooling"),
    node("a-rack", "rack", "Rack", 0.12, 0.05, 0.08, false, null),
  ],
  constraints: [
    { key: "utility", name: "Utility connection", domain: "electrical", racksAllowed: 160, binds: false, basis: "contracted MW / kW per rack", evidence: "E1" },
    { key: "transformer", name: "Transformer", domain: "electrical", racksAllowed: 100, binds: true, basis: "transformer rating / kW per rack", evidence: "E1" },
    { key: "cooling", name: "Cooling plant", domain: "thermal", racksAllowed: 128, binds: false, basis: "heat rejection / kW per rack", evidence: "E2" },
    { key: "ups", name: "UPS", domain: "electrical", racksAllowed: 110, binds: false, basis: "UPS rating / kW per rack", evidence: "E1" },
    { key: "floor", name: "Floor loading", domain: "physical", racksAllowed: null, binds: false, basis: "no floor data supplied", evidence: "E0" },
  ],
  rackRows: [
    { id: "row-1", label: "Row 1", racks: 60, kwPerRackAsFound: 5, kwPerRackAfterPlan: 8 },
    { id: "row-2", label: "Row 2", racks: 40, kwPerRackAsFound: null, kwPerRackAfterPlan: null },
  ],
  outcomes: [
    {
      id: "plan-dated",
      name: "Transformer upgrade",
      racksAsFound: 100,
      racksAfterPlan: 128,
      bindingAfterPlan: "cooling",
      itLoadKwAfterPlan: q(9000, "kW"),
      weeksToCapacity: q(52, "weeks", "E3"),
      dated: true,
      capexEur: q(2_400_000, "EUR", "E1", { low: 2_000_000, high: 3_100_000 }),
      unpricedComponents: ["site works"],
      evidence: "E3",
    },
    {
      id: "plan-undated",
      name: "Liquid cooling retrofit",
      racksAsFound: 100,
      racksAfterPlan: 140,
      bindingAfterPlan: "ups",
      itLoadKwAfterPlan: q(10000, "kW"),
      weeksToCapacity: q(null, "weeks", "E0", { missingReason: "no supplied lead time" }),
      dated: false,
      capexEur: q(null, "EUR", "E0", { missingReason: "no supplied cost" }),
      unpricedComponents: ["coolant distribution", "commissioning"],
      evidence: "E0",
    },
  ],
  headlineOutcome: "plan-dated",
  limitations: ["TEST FIXTURE: invented values."],
};

/** Hall B: the awkward one. Nothing flagged as binding, a post-plan constraint no stage maps to, a missing capacity. */
export const FIXTURE_HALL_B: ObservatoryScenario = {
  id: "fixture-hall-b",
  title: "Fixture Hall B",
  summary: "TEST FIXTURE. A second invented hall with missing data, used only by tests.",
  synthetic: true,
  hall: { name: "Fixture Hall B", platform: "liquid-cooled", contractedMW: 30, currentItLoadMW: 2, positionsAvailable: 400, region: "Nowhere else (invented)" },
  powerPath: [
    node("b-utility", "utility", "Utility connection", 30, 2, 20, false, "utility"),
    node("b-busway", "busway", "Busway", null, 2, 20, false, "busway"),
  ],
  constraints: [
    { key: "utility", name: "Utility connection", domain: "electrical", racksAllowed: 300, binds: false, basis: "contracted MW / kW per rack", evidence: "E1" },
    { key: "busway", name: "Busway", domain: "electrical", racksAllowed: null, binds: false, basis: "no busway rating supplied", evidence: "E0" },
  ],
  rackRows: [],
  outcomes: [
    {
      id: "plan-b",
      name: "Add a second feed",
      racksAsFound: 300,
      racksAfterPlan: 380,
      bindingAfterPlan: "grid-queue-position",
      itLoadKwAfterPlan: q(null, "kW", "E0", { missingReason: "no per-rack figure" }),
      weeksToCapacity: q(null, "weeks", "E0", { missingReason: "no supplied lead time" }),
      dated: false,
      capexEur: q(null, "EUR", "E0"),
      unpricedComponents: [],
      evidence: "E1",
    },
  ],
  headlineOutcome: "plan-b",
  limitations: ["TEST FIXTURE: invented values."],
};

export const FIXTURE_FILE: ScenarioFile = {
  schema: "gridforge/observatory-scenarios/1",
  engine: { version: "0.0.0-test-fixture", codeSha256: "0".repeat(64), routes: ["/v1/qualify"] },
  generatedAt: "2026-01-01T00:00:00Z",
  synthetic: true,
  calibration: { state: "empty", statement: "TEST FIXTURE: the calibration ledger is empty." },
  scenarios: [FIXTURE_HALL_A, FIXTURE_HALL_B],
};
