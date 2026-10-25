/**
 * FIXTURE ONLY. Nothing in this file is engine output, a measurement, or a real market reading. It exists so the Observatory
 * UI can be rendered and tested without the generated scenarios.json or the network. Every hall, number, price and queue figure
 * here is invented; the evidence classes are chosen to exercise the UI (assumed, modelled, estimated), not to describe anything.
 * A fixture is not calibration.
 *
 * (tests/site/observatory-fixtures.ts belongs to another workstream; this file is the UI workstream's own.)
 */
import type {
  ConstraintResult,
  EvidenceClass,
  LiveContext,
  Observed,
  ObservatoryScenario,
  PathNode,
  Quantity,
  RackRow,
  ScenarioFile,
  ScenarioOutcome,
  SceneModel,
} from "@/lib/observatory/types";

export const FIXTURE_NOW = new Date("2026-10-25T12:20:00Z");

export const q = (value: number | null, unit: string, evidence: EvidenceClass, extra: Partial<Quantity> = {}): Quantity => ({
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
  capacity: Quantity,
  found: Quantity | null,
  after: Quantity | null,
  binds = false,
  constraintKey: string | null = null,
): PathNode {
  return { id, kind, label, capacity, loadAsFound: found, loadAfterPlan: after, binds, constraintKey };
}

const POWER_PATH_A: PathNode[] = [
  node("utility", "utility", "Utility connection", q(12, "MW", "E1"), q(4.9, "MW", "E1"), q(9.1, "MW", "E1"), false, "grid_connection"),
  // Capacity in MVA, load in MW: the UI must say "not comparable" rather than divide them.
  node("transformer", "transformer", "Main transformer T1 (usable after derating)", q(15, "MVA", "E1"), q(4.9, "MW", "E1"), q(9.1, "MW", "E1"), false, "transformer_capacity"),
  node("switchgear", "switchgear", "LV switchgear", q(4000, "A", "E0"), q(2100, "A", "E0"), q(3200, "A", "E0"), false, null),
  node("ups", "ups", "UPS modules", q(8, "MW", "E1"), q(4.4, "MW", "E1"), q(7.2, "MW", "E1"), false, "ups_capacity"),
  node("busway", "busway", "Busway, hall A", q(400, "A", "E1"), q(388, "A", "E1"), q(392, "A", "E1"), true, "busway_ampacity"),
  node("rack_feed", "rack_feed", "Tap-off to rack, 63 A", q(63, "A", "E0"), q(58, "A", "E0"), q(40, "A", "E0"), false, "tapoff_rating"),
  node("rack", "rack", "Rack positions", q(180, "positions", "E1"), q(24, "positions", "E1"), q(61, "positions", "E1"), false, "rack_positions"),
  node("cooling", "cooling", "Chilled-water plant", q(6000, "kW", "E1"), q(3800, "kW", "E1"), q(5200, "kW", "E1"), false, "cooling_capacity"),
];

const KEYS: [string, string, string, number | null, boolean, EvidenceClass][] = [
  ["busway_ampacity", "Busway ampacity", "electrical", 24, true, "E1"],
  ["tapoff_rating", "Tap-off rating", "electrical", 31, false, "E0"],
  ["grid_connection", "Grid connection", "electrical", 78, false, "E1"],
  ["transformer_capacity", "Transformer capacity", "electrical", 84, false, "E1"],
  ["ups_capacity", "UPS capacity", "electrical", 62, false, "E1"],
  ["cooling_capacity", "Cooling plant capacity", "thermal", 70, false, "E1"],
  ["supply_temperature", "Chilled-water supply temperature", "thermal", 88, false, "E1"],
  ["rack_positions", "Free rack positions", "physical", 180, false, "E1"],
  ["floor_loading", "Floor loading", "physical", 140, false, "E0"],
  ["pdu_breakers", "PDU breaker rating", "electrical", 52, false, "E0"],
  ["fault_level", "Fault level", "electrical", null, false, "E0"],
  ["liquid_loop", "Liquid loop capacity", "thermal", 96, false, "E1"],
  ["generator_capacity", "Generator capacity", "electrical", 104, false, "E1"],
];
const CONSTRAINTS_A: ConstraintResult[] = KEYS.map(([key, name, domain, racksAllowed, binds, evidence]) => ({
  key,
  name,
  domain,
  racksAllowed,
  passes: racksAllowed === null,
  binds,
  basis: racksAllowed === null ? "inputs do not support a figure" : `${name.toLowerCase()} divided by the platform's per-rack draw`,
  evidence,
}));

const RACKS_A: RackRow[] = [
  { id: "row-a", label: "Row A, existing air-cooled", racks: 24, kwPerRackAsFound: 12, kwPerRackAfterPlan: 18 },
  { id: "row-b", label: "Row B, new high-density", racks: 37, kwPerRackAsFound: null, kwPerRackAfterPlan: 54 },
  { id: "row-c", label: "Row C, reserved", racks: 130, kwPerRackAsFound: 8, kwPerRackAfterPlan: 8 },
];

export const OUTCOMES_A: ScenarioOutcome[] = [
  {
    id: "tapoff",
    name: "Replace the tap-offs, keep air cooling",
    racksAsFound: 24,
    racksAfterPlan: 61,
    bindingAfterPlan: "busway_ampacity",
    itLoadKwAfterPlan: q(3600, "kW", "E1"),
    weeksToCapacity: q(null, "weeks", "E0", { missingReason: "No supplied lead time for the tap-off units." }),
    dated: false,
    capexEur: q(null, "EUR", "E0", { missingReason: "No cost evidence supplied." }),
    unpricedComponents: ["tap-off units", "installation labour"],
    capexComplete: false,
    capexPricing: "none",
    evidence: "E0",
  },
  {
    id: "busway",
    name: "Upgrade busway and tap-offs",
    racksAsFound: 24,
    racksAfterPlan: 96,
    bindingAfterPlan: "ups_capacity",
    itLoadKwAfterPlan: q(5800, "kW", "E1"),
    weeksToCapacity: q(38, "weeks", "E0"),
    dated: false,
    capexEur: q(1_800_000, "EUR", "E0", { low: 1_500_000, high: 2_300_000 }),
    unpricedComponents: ["commissioning"],
    capexComplete: false,
    capexPricing: "placeholder",
    evidence: "E0",
  },
  {
    id: "liquid",
    name: "Add rear-door liquid cooling",
    racksAsFound: 24,
    racksAfterPlan: 88,
    bindingAfterPlan: "cooling_capacity",
    itLoadKwAfterPlan: q(5300, "kW", "E3"),
    weeksToCapacity: q(30, "weeks", "E3"),
    dated: true,
    capexEur: q(2_340_000, "EUR", "E3"),
    unpricedComponents: [],
    capexComplete: true,
    capexPricing: "placeholder",
    evidence: "E3",
  },
];

export const SCENARIO_A: ObservatoryScenario = {
  id: "colo-12mw",
  title: "Colocation hall, 12 MW",
  summary: "FIXTURE: an invented colocation hall that is full on a busway before it is full on power. It shows what the engine says binds and what each fix does; it is not any real site.",
  synthetic: true,
  hall: { name: "FIXTURE Hall A", platform: "gb300_nvl72", contractedMW: 12, currentItLoadMW: 4.9, positionsAvailable: 180, region: "Ireland (invented)" },
  powerPath: POWER_PATH_A,
  constraints: CONSTRAINTS_A,
  rackRows: RACKS_A,
  outcomes: OUTCOMES_A,
  headlineOutcome: "busway",
  limitations: ["FIXTURE limitation: the hall is invented.", "FIXTURE limitation: lead times are assumed unless marked supplied."],
};

export const SCENARIO_B: ObservatoryScenario = {
  id: "enterprise-4mw",
  title: "Enterprise hall, 4 MW",
  summary: "FIXTURE: a second invented hall, to prove the switcher swaps every panel together.",
  synthetic: true,
  hall: { name: "FIXTURE Hall B", platform: "gb200_nvl72", contractedMW: 4, currentItLoadMW: 2.2, positionsAvailable: 60, region: "Netherlands (invented)" },
  powerPath: [
    node("utility", "utility", "Utility connection", q(4, "MW", "E1"), q(2.2, "MW", "E1"), q(3.4, "MW", "E1"), true, "grid_connection"),
    node("ups", "ups", "UPS", q(3, "MW", "E1"), q(2, "MW", "E1"), q(2.8, "MW", "E1"), false, "ups_capacity"),
    node("rack", "rack", "Rack positions", q(60, "positions", "E1"), q(10, "positions", "E1"), q(30, "positions", "E1"), false, "rack_positions"),
  ],
  constraints: [
    { key: "grid_connection", name: "Grid connection", domain: "electrical", racksAllowed: 18, passes: false, binds: true, basis: "contracted MW over per-rack draw", evidence: "E1" },
    { key: "ups_capacity", name: "UPS capacity", domain: "electrical", racksAllowed: 27, passes: false, binds: false, basis: "UPS MW over per-rack draw", evidence: "E1" },
    { key: "rack_positions", name: "Free rack positions", domain: "physical", racksAllowed: 60, passes: false, binds: false, basis: "counted positions", evidence: "E1" },
  ],
  rackRows: [{ id: "row-1", label: "Row 1", racks: 10, kwPerRackAsFound: 15, kwPerRackAfterPlan: 40 }],
  outcomes: [
    {
      id: "grid",
      name: "Request a larger connection",
      racksAsFound: 18,
      racksAfterPlan: 27,
      bindingAfterPlan: "ups_capacity",
      itLoadKwAfterPlan: q(2800, "kW", "E1"),
      weeksToCapacity: q(null, "weeks", "E0", { missingReason: "The utility's lead time is not stated." }),
      dated: false,
      capexEur: q(null, "EUR", "E0"),
      unpricedComponents: ["connection charge"],
      capexComplete: false,
      capexPricing: "none",
      evidence: "E0",
    },
  ],
  headlineOutcome: "grid",
  limitations: ["FIXTURE limitation: second hall."],
};

export const FIXTURE_SCENARIO_FILE: ScenarioFile = {
  schema: "gridforge/observatory-scenarios/1",
  engine: { version: "0.0.0-fixture", codeSha256: "f".repeat(64), routes: ["/v1/compare"] },
  generatedAt: "2026-10-20T09:00:00Z",
  synthetic: true,
  calibration: {
    state: "empty",
    statement: "FIXTURE calibration statement: the calibration ledger is empty; no figure here has been reconciled against a measured site.",
  },
  contentSha256: "f".repeat(64),
  scenarios: [SCENARIO_A, SCENARIO_B],
};

/**
 * A TEST DOUBLE for lib/observatory/scene-model.buildSceneModel (the real one belongs to another workstream). It follows the
 * SceneModel contract only as far as the UI needs: binding ids from the nodes and the chosen outcome.
 */
export function fixtureBuildSceneModel(scenario: ObservatoryScenario, outcomeId?: string): SceneModel {
  const outcome = scenario.outcomes.find((o) => o.id === outcomeId) ?? scenario.outcomes.find((o) => o.id === scenario.headlineOutcome) ?? scenario.outcomes[0];
  const bindingAsFound = scenario.powerPath.find((n) => n.binds)?.id ?? null;
  const bindingAfterPlan = scenario.powerPath.find((n) => n.constraintKey !== null && n.constraintKey === outcome.bindingAfterPlan)?.id ?? null;
  return {
    scenarioId: scenario.id,
    outcomeId: outcome.id,
    nodes: scenario.powerPath,
    rackRows: scenario.rackRows,
    bindingAsFound,
    bindingAfterPlan,
    textAlternative: `FIXTURE scene text for ${scenario.title}, alternative ${outcome.name}: ${scenario.powerPath.length} stages from the utility to the racks; ${bindingAsFound ?? "no stage"} binds as found.`,
    basisBanner: "FIXTURE BANNER: synthetic hall, engine-modelled, not measured. The calibration ledger is empty.",
  };
}

// ---- live context ----------------------------------------------------------------------------------------------------

function obs<T>(value: T | null, over: Partial<Observed<T>["provenance"]> = {}, freshness: Observed<T>["freshness"] = "fresh"): Observed<T> {
  return {
    value,
    freshness,
    provenance: {
      source: "FIXTURE source",
      basis: "observed",
      observedAt: "2026-10-25T12:00:00Z",
      retrievedAt: "2026-10-25T12:05:00Z",
      maxAgeSeconds: 7200,
      ...over,
    },
  };
}

export const REFERENCE_REGION_SENTENCE =
  "FIXTURE reference region: the market and grid below are Germany's, shown for context. They are not the grid of any hall on this page.";

export function fixtureContext(over: Partial<LiveContext> = {}): LiveContext {
  return {
    generatedAt: "2026-10-25T12:06:00Z",
    referenceRegion: REFERENCE_REGION_SENTENCE,
    dayAheadPrice: obs(
      { eurPerMWh: 87.4, deliveryStart: "2026-10-25T13:00:00Z", min: 31.2, max: 142.8, avg: 84.1, windowStart: "2026-10-25T12:00:00Z", windowEnd: "2026-10-26T12:00:00Z" },
      { source: "FIXTURE day-ahead auction", basis: "day_ahead_auction", observedAt: "2026-10-25T13:00:00Z", maxAgeSeconds: 86400 },
    ),
    generationMix: obs(
      {
        totalMW: 52000,
        renewablePct: 61.5,
        mix: [
          { name: "Wind onshore", mw: 21000, renewable: true },
          { name: "Solar", mw: 9000, renewable: true },
          { name: "Gas", mw: 11000, renewable: false },
          { name: "Lignite", mw: 11000, renewable: false },
        ],
      },
      { source: "FIXTURE generation feed" },
    ),
    queue: obs(
      [
        { market: "FIXTURE market X", activeProjectsGW: 120.5, typicalWaitMonths: 54 },
        { market: "FIXTURE market Y", activeProjectsGW: 40, typicalWaitMonths: 30 },
      ],
      { source: "FIXTURE queue report", basis: "published_report", observedAt: "2026-09-30T00:00:00Z", retrievedAt: "2026-10-25T12:05:00Z", maxAgeSeconds: 90 * 86400 },
    ),
    usDemand: obs<{ mw: number; period: string }>(null, { source: "FIXTURE demand overlay", observedAt: null, retrievedAt: null, caveat: "FIXTURE: no data key is configured." }, "unavailable"),
    ...over,
  };
}
