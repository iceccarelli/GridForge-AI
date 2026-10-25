// GridForge Observatory: the contract between the three things that make it up, so each can be built and tested alone.
//
//   data       lib/observatory/sources.ts (live context, each value with its provenance and freshness) and
//              public/observatory/scenarios.json (engine output for APPROVED SYNTHETIC halls, generated at build time by
//              scripts/build-observatory.py from the repository's own engine and diffed in CI like public/reference)
//   scene      lib/observatory/scene-model.ts turns a scenario into ONE SceneModel; the 3D view, the 2D fallback, the text
//              alternative and the presenter all render that same model, so they cannot disagree
//   journey    lib/observatory/journey.ts: a pure function of time over the approved scenarios (deterministic: same t, same frame)
//
// Honesty rules the types enforce by shape (a renderer cannot show a number without its label):
//   - nothing is "live" unless basis === "observed" AND its freshness is "fresh"; a cached, published or derived value says what it is
//   - a figure from the engine carries its evidence class (E0..E7) and is never presented as measured or calibrated; the calibration
//     ledger is empty and every surface says so
//   - a missing value is null with a reason, never 0 and never a guess; a date without a lead time is null ("not dated")

/** What kind of thing a value is. Only "observed" may ever be called live, and only while fresh. */
export type Basis =
  | "observed" // a reading of the real world with its own observation time (e.g. a generation mix at a stated interval)
  | "day_ahead_auction" // a published auction result for a stated delivery period: a price, not an observation of now
  | "published_report" // a figure from a dated public report (an interconnection-queue snapshot): current as of that date only
  | "engine_modelled" // computed by the GridForge engine from the stated inputs
  | "synthetic_input" // an invented demonstration input
  | "assumed"; // a library default or assumption (evidence class E0)

export type Freshness = "fresh" | "stale" | "unavailable" | "not_applicable";

export interface Provenance {
  /** Who published or computed it, in words a reader can check ("Fraunhofer ISE · Energy-Charts"). */
  source: string;
  basis: Basis;
  /** The instant the value DESCRIBES (observation time, delivery period start, report date), ISO 8601; null when it has none. */
  observedAt: string | null;
  /** When this site obtained it, ISO 8601; null for build-time data that has no retrieval (use engine.generatedAt instead). */
  retrievedAt: string | null;
  /** How old observedAt (or retrievedAt when there is no observedAt) may be before the value is called stale; null = no limit. */
  maxAgeSeconds: number | null;
  /** One honest sentence about what this is NOT, when a reader could mistake it. */
  caveat?: string;
}

export interface Observed<T> {
  /** null when unavailable: never a placeholder number. */
  value: T | null;
  provenance: Provenance;
  freshness: Freshness;
}

export type EvidenceClass = "E0" | "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7";

/** A quantity with its range and evidence, as the engine reports it. */
export interface Quantity {
  value: number | null;
  low: number | null;
  high: number | null;
  unit: string;
  evidence: EvidenceClass;
  /** Why value is null, when it is. */
  missingReason?: string;
}

export type PathKind = "utility" | "transformer" | "switchgear" | "ups" | "busway" | "rack_feed" | "rack" | "cooling";

/** One stage of the data-centre power path, from the utility connection to the rack. */
export interface PathNode {
  id: string;
  kind: PathKind;
  label: string;
  /** What the stage can carry, and what it is asked to carry as found and after the plan; units are per the quantity. */
  capacity: Quantity;
  loadAsFound: Quantity | null;
  loadAfterPlan: Quantity | null;
  /** True for the stage that limits deployable racks in this scenario (as found). */
  binds: boolean;
  /** The engine constraint key this stage corresponds to, or null for a stage the engine does not model. */
  constraintKey: string | null;
}

export interface ConstraintResult {
  key: string;
  name: string;
  domain: "electrical" | "thermal" | "physical" | string;
  /**
   * Racks this constraint alone allows (as found). null means the engine reports NO finite limit: the constraint does not limit the
   * hall (a passing gate, or a ceiling above every other limit). It says nothing about whether inputs were supplied; `evidence` says that.
   */
  racksAllowed: number | null;
  /** True iff racksAllowed === null (the constraint passes). Redundant by design: a renderer must not infer "unknown" from a null. */
  passes: boolean;
  binds: boolean;
  basis: string;
  evidence: EvidenceClass;
}

export interface RackRow {
  id: string;
  label: string;
  racks: number;
  /** Per-rack density as found and after the plan, kW; null when not supported. */
  kwPerRackAsFound: number | null;
  kwPerRackAfterPlan: number | null;
}

/** One alternative the engine compared for a hall (cooling/supply architectures). */
export interface ScenarioOutcome {
  id: string;
  name: string;
  racksAsFound: number;
  racksAfterPlan: number;
  /** The constraint that binds after the plan (a key present in ConstraintResult). */
  bindingAfterPlan: string | null;
  itLoadKwAfterPlan: Quantity;
  /** Programme weeks to full capacity; value null (with missingReason) unless every step has a supplied lead time. Never a date. */
  weeksToCapacity: Quantity;
  /** True only when every lead time behind weeksToCapacity was supplied; assumed lead times stay labelled E0 and "not a date". */
  dated: boolean;
  capexEur: Quantity;
  /** The engine's capex_complete: false when any component is unpriced, or when nothing is deployable. A capex that is not complete is a LOWER BOUND. */
  capexComplete: boolean;
  /**
   * What the priced lines behind capexEur rest on, from the engine's own cost basis: "placeholder" = every line is a library placeholder
   * (not a price); "partly_supplied" = some lines are placeholders and some are a supplied figure (an intake figure or a non-placeholder
   * library line); "supplied" = no line is a placeholder; "none" = there is no capex figure (capexEur.value is null).
   */
  capexPricing: "placeholder" | "partly_supplied" | "supplied" | "none";
  /** Unpriced components the capex omits; a total with any is a LOWER BOUND, not a complete price. */
  unpricedComponents: string[];
  evidence: EvidenceClass;
}

export interface ObservatoryScenario {
  id: string;
  title: string;
  /** Two sentences a presenter can read aloud; says what is being shown and what it is not. */
  summary: string;
  /** Always true for the Observatory: only approved synthetic halls are shown; there is no customer data in this contract. */
  synthetic: true;
  hall: {
    name: string;
    platform: string;
    contractedMW: number;
    currentItLoadMW: number;
    positionsAvailable: number;
    /** Where the invented hall is pretended to be; informational only, it does not select live data. */
    region: string;
  };
  powerPath: PathNode[];
  constraints: ConstraintResult[];
  rackRows: RackRow[];
  outcomes: ScenarioOutcome[];
  /** The id of the outcome shown first. */
  headlineOutcome: string;
  limitations: string[];
}

/** Written to public/observatory/scenarios.json by scripts/build-observatory.py. */
export interface ScenarioFile {
  schema: "gridforge/observatory-scenarios/1";
  engine: { version: string; codeSha256: string; routes: string[] };
  /** Build-time provenance: the date the engine output was generated and the fact that it is synthetic. */
  generatedAt: string;
  synthetic: true;
  calibration: { state: "empty"; statement: string };
  /**
   * SHA-256 (hex) of every leaf of this file except this field, written by scripts/build-observatory.py and verified by the loader
   * (lib/observatory/scenario-data.ts, contentFingerprint): a schema-valid hand edit of any figure no longer verifies.
   */
  contentSha256: string;
  scenarios: ObservatoryScenario[];
}

/** Live context shown beside the scenarios; every field says what it is and how old it is. */
export interface LiveContext {
  generatedAt: string;
  /** The market/grid shown belongs to the named reference region, NOT to the invented hall. */
  referenceRegion: string;
  /** min/max/avg are over the published window windowStart..windowEnd (about the next 24 hours), not a calendar day. */
  dayAheadPrice: Observed<{ eurPerMWh: number; deliveryStart: string; min: number; max: number; avg: number; windowStart: string; windowEnd: string }>;
  generationMix: Observed<{ totalMW: number; renewablePct: number; mix: { name: string; mw: number; renewable: boolean }[] }>;
  queue: Observed<{ market: string; activeProjectsGW: number; typicalWaitMonths: number }[]>;
  /** The EIA national demand overlay, only when the key is configured and the read succeeded. */
  usDemand: Observed<{ mw: number; period: string }>;
}

/** What every renderer draws. Derived from one scenario and one selected outcome; pure. */
export interface SceneModel {
  scenarioId: string;
  outcomeId: string;
  nodes: PathNode[];
  rackRows: RackRow[];
  /** Node id of the binding stage as found, and after the plan (null when nothing binds or it is unknown). */
  bindingAsFound: string | null;
  bindingAfterPlan: string | null;
  /** A complete plain-text description of the scene for assistive technology and the 2D fallback. */
  textAlternative: string;
  /** The standing reminder shown on every frame. */
  basisBanner: string;
}

/** One beat of the deterministic presenter journey. */
export interface JourneyStep {
  id: string;
  /** Seconds this beat lasts; the whole journey is the sum, so frame(t) is a pure function of t. */
  durationSec: number;
  scenarioId: string;
  outcomeId: string;
  /** Node id (or constraint key) to emphasise; null for an overview. */
  focus: string | null;
  /** Which panel leads: the power path, the constraints, the live context or the scenario outcomes. */
  panel: "path" | "constraints" | "context" | "outcomes";
  /** The caption: also the source of the WebVTT track. One or two short sentences; states the basis where numbers appear. */
  caption: string;
}

export interface JourneyFrame {
  t: number;
  stepIndex: number;
  step: JourneyStep;
  /** 0..1 progress within the step, for eased camera moves. */
  progress: number;
  done: boolean;
}
