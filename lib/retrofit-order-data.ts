// The data behind "the order of limits in a 100-150 kW retrofit" (app/guides/retrofit-order-of-limits).
//
// Nothing the guide prints is typed here. Every figure is read, at render time, from the files the engine publishes under public/reference:
//   - model_pack.json   the engine's solve of the SYNTHETIC reference hall in five cooling architectures (constraints, headroom ladder, schedule)
//   - platforms.json    the rack library (rack power, liquid share, residual air, feed current), with its sources and their [V] vendor marks
//   - constraints.json  the thirteen constraint pages (name, slug, what each limits, what relieves it)
//   - calibration.json  how far the model has been checked against real halls
// so a regenerated pack changes the page and nothing about it can drift from the engine (CI rebuilds the pack and fails on a difference).
// tests/site/retrofit-order-guide.test.ts holds the page to that: it injects marker values into a copy of each file and requires the page to print them.
//
// Two derived views are computed here and only here, each from published inputs and each labelled on the page for what it is:
//   - the ORDER: the constraints in the sequence the engine's own headroom ladder relieves them (the pack's `ladder`), then the rest by their ceiling;
//   - the BAND ARITHMETIC: the two per-position relations (residual air = rack power x (1 - liquid share); feed current is proportional to rack
//     power) applied to the rack powers at which the library's practical-capability ranges for the liquid architectures start and stand. It is
//     arithmetic on the published relations with the library's own ratios, NOT an engine solve, and the page says so.

import fs from "node:fs/promises";
import path from "node:path";
import { constraintReference, platformLibrary, type ConstraintDoc, type PlatformEntry } from "@/lib/constraints";
import type { QA } from "@/lib/qa";

/** The retrofit the guide walks through: direct liquid cooling added to the hall, keeping the existing plant for the residual air. Chosen by id so a reordering of the pack cannot change it. */
export const SCENARIO_ID = "hybrid_dlc";
/** The scenario it is set beside: a dedicated warm-water loop for the chip load. */
export const COMPARISON_ID = "full_dlc";
/** The two per-position limits the guide is about. Named by id because the guide is about them; whether they hold the count at zero is read from the pack. */
export const TAPOFF_ID = "rack_feed_tapoff";
export const RESIDUAL_AIR_ID = "residual_air_removal";
/** The architectures whose practical per-rack range sets the 100-150 kW band the guide examines. */
export const LIQUID_ARCHITECTURES = ["hybrid_dlc", "full_dlc"] as const;
const ARCHITECTURE_LABEL: Record<(typeof LIQUID_ARCHITECTURES)[number], string> = {
  hybrid_dlc: "hybrid direct liquid cooling",
  full_dlc: "full direct liquid cooling",
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Types: only what the guide reads. A pack that does not have them is refused (parseRetrofitPack returns null) and the page says so.
// ---------------------------------------------------------------------------------------------------------------------------------

export interface Qty {
  value: number;
  low: number | null;
  high: number | null;
  unit: string;
  /** The engine's name for the class, e.g. "E0_ASSUMPTION". */
  evidence: string;
}

export interface PackConstraint {
  id: string;
  name: string;
  domain: string;
  /** A pass-or-fail gate (true) or a capacity ceiling (false). */
  gate: boolean;
  /** Racks this constraint permits; null where the pack attaches no count (a gate that passes, or a constraint the architecture does not use). */
  racks: number | null;
  basis: string;
}

export interface LadderStep {
  step: number;
  constraint: string;
  name: string;
  domain: string;
  racksBefore: number;
  racksAfter: number;
  taken: boolean;
  relief: string;
  risk: string;
  scope: string | null;
  leadTime: Qty | null;
  notTakenReason: string | null;
}

export interface CurvePoint {
  weeks: number;
  racks: number;
  unlockedBy: string;
}

export interface Scenario {
  id: string;
  name: string;
  architecture: string;
  rationale: string;
  asFound: { racks: number; binding: string; bindingName: string; basis: string };
  afterLadder: { racks: number; binding: string; digest: string | null; model: string | null };
  ladder: LadderStep[];
  constraints: PackConstraint[];
  time: {
    weeksToFirstRack: number | null;
    weeksToFull: number | null;
    setsTheDate: string | null;
    dateLabel: string | null;
    dateClass: string | null;
    limitation: string | null;
    calculationVersion: string | null;
    curve: CurvePoint[];
  };
}

export interface HallInputs {
  id: string;
  buildYear: number;
  contractedMW: number;
  firmCapacityMVA: number;
  sitePeakMW: number;
  itLoadMW: number;
  queueNote: string;
  rackPositions: number;
  positionsAvailable: number;
  designDensityKw: number;
  containment: string;
  floorType: string;
  floorLoadingNote: string;
  tapoffA: number;
  voltageV: number;
  buswayA: number;
  buswayRuns: number;
  buswayUtilisation: number;
  transformer: { units: number; ratingMVA: number; redundancy: string; derating: number };
  ups: { units: number; ratingKW: number; redundancy: string };
  plant: { capacityKW: number; supplyC: number; pumpFlowLpm: number };
  residualAirKw: { value: number; evidence: string; note: string };
  platformId: string;
}

export interface RetrofitPack {
  schema: string;
  generated: string;
  synthetic: true;
  notice: string;
  hall: HallInputs;
  scenarios: Scenario[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading the pack. Every field is checked; a missing one makes the whole pack unusable rather than printing a guess.
// ---------------------------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strOr = (v: unknown, d: string): string => (typeof v === "string" ? v : d);

function parseQty(v: unknown): Qty | null {
  if (!isObj(v)) return null;
  const value = num(v.value);
  if (value === null) return null;
  return { value, low: num(v.low), high: num(v.high), unit: strOr(v.unit, ""), evidence: strOr(v.evidence, "") };
}

function parseConstraint(v: unknown): PackConstraint | null {
  if (!isObj(v)) return null;
  const id = str(v.id), name = str(v.name), domain = str(v.domain), basis = str(v.basis);
  if (id === null || name === null || domain === null || basis === null || typeof v.gate !== "boolean") return null;
  const racks = v.racks_permitted === null ? null : num(v.racks_permitted);
  if (v.racks_permitted !== null && racks === null) return null;
  return { id, name, domain, gate: v.gate, racks, basis };
}

function parseStep(v: unknown): LadderStep | null {
  if (!isObj(v)) return null;
  const step = num(v.step), before = num(v.racks_before), after = num(v.racks_after);
  const constraint = str(v.constraint), name = str(v.name), domain = str(v.domain), relief = str(v.relief);
  if (step === null || before === null || after === null || constraint === null || name === null || domain === null || relief === null || typeof v.taken !== "boolean") return null;
  return {
    step, constraint, name, domain, racksBefore: before, racksAfter: after, taken: v.taken, relief,
    risk: strOr(v.risk, ""), scope: str(v.scope), leadTime: parseQty(v.lead_time_weeks), notTakenReason: str(v.not_taken_reason),
  };
}

function parseScenario(v: unknown): Scenario | null {
  if (!isObj(v) || !isObj(v.as_found) || !isObj(v.after_ladder) || !isObj(v.time_to_power)) return null;
  const id = str(v.id), name = str(v.name), architecture = str(v.architecture);
  const af = v.as_found, al = v.after_ladder, t = v.time_to_power;
  const afRacks = num(af.racks), alRacks = num(al.racks), binding = str(af.binding), bindingName = str(af.binding_name), afBasis = str(af.basis), alBinding = str(al.binding);
  if (id === null || name === null || architecture === null || afRacks === null || alRacks === null || binding === null || bindingName === null || afBasis === null || alBinding === null) return null;
  if (!Array.isArray(v.ladder) || !Array.isArray(v.constraints)) return null;
  const ladder = v.ladder.map(parseStep);
  const constraints = v.constraints.map(parseConstraint);
  if (ladder.some((s) => s === null) || constraints.some((c) => c === null)) return null;
  const load = isObj(al.it_load_kW) ? al.it_load_kW : null;
  const rec = isObj(t.date_record) ? t.date_record : null;
  const curve: CurvePoint[] = [];
  if (Array.isArray(t.curve)) {
    for (const p of t.curve) {
      if (!isObj(p)) continue;
      const weeks = num(p.weeks), racks = num(p.racks), by = str(p.unlocked_by);
      if (weeks !== null && racks !== null && by !== null) curve.push({ weeks, racks, unlockedBy: by });
    }
  }
  return {
    id, name, architecture, rationale: strOr(v.rationale, ""),
    asFound: { racks: afRacks, binding, bindingName, basis: afBasis },
    afterLadder: { racks: alRacks, binding: alBinding, digest: str(load?.digest), model: str(load?.model) },
    ladder: ladder as LadderStep[],
    constraints: constraints as PackConstraint[],
    time: {
      weeksToFirstRack: num(t.weeks_to_first_rack),
      weeksToFull: num(t.weeks_to_full),
      setsTheDate: str(t.sets_the_date),
      dateLabel: str(t.date_label),
      dateClass: str(t.date_evidence_class),
      limitation: str(rec?.limitation),
      calculationVersion: str(rec?.calculation_version),
      curve,
    },
  };
}

function parseHall(doc: unknown): HallInputs | null {
  if (!isObj(doc)) return null;
  const hall = doc.hall, grid = doc.grid, lv = doc.lv, thermal = doc.thermal, compute = doc.compute;
  if (!isObj(hall) || !isObj(grid) || !isObj(lv) || !isObj(thermal) || !isObj(compute)) return null;
  const tx = Array.isArray(doc.transformers) && isObj(doc.transformers[0]) ? doc.transformers[0] : null;
  const ups = Array.isArray(doc.ups) && isObj(doc.ups[0]) ? doc.ups[0] : null;
  const plant = isObj(thermal.plant) ? thermal.plant : null;
  const air = isObj(thermal.residual_air_capacity_kW_per_rack) ? thermal.residual_air_capacity_kW_per_rack : null;
  const peak = isObj(grid.current_site_peak_MW) ? grid.current_site_peak_MW : null;
  const busway = isObj(lv.busway_ampacity_A) ? lv.busway_ampacity_A : null;
  const supply = plant && isObj(plant.design_supply_C) ? plant.design_supply_C : null;
  const floor = isObj(hall.floor_loading_kPa) ? hall.floor_loading_kPa : null;
  if (!tx || !ups || !plant || !air || !peak || !busway || !supply) return null;
  const f = {
    id: str(hall.id), buildYear: num(hall.build_year), contractedMW: num(grid.contracted_MW), firmCapacityMVA: num(grid.firm_capacity_MVA),
    sitePeakMW: num(peak.value), itLoadMW: num(grid.current_it_load_MW), queueNote: str(grid.queue_note),
    rackPositions: num(hall.rack_positions), positionsAvailable: num(hall.positions_available), designDensityKw: num(hall.design_density_kW_per_rack),
    containment: str(hall.containment), floorType: str(hall.floor_type), floorLoadingNote: str(floor?.note),
    tapoffA: num(lv.tapoff_max_A), voltageV: num(lv.voltage_V), buswayA: num(busway.value), buswayRuns: num(lv.busway_runs), buswayUtilisation: num(lv.busway_utilisation_limit),
    txUnits: num(tx.units), txRating: num(tx.unit_rating_MVA), txRedundancy: str(tx.redundancy), txDerating: num(tx.derating_factor),
    upsUnits: num(ups.units), upsRating: num(ups.unit_rating_kW), upsRedundancy: str(ups.redundancy),
    plantCapacity: num(plant.chilled_water_capacity_kW), plantSupply: num(supply.value), pumpFlow: num(plant.pump_flow_capacity_l_per_min),
    airValue: num(air.value), airEvidence: str(air.evidence), airNote: str(air.note), platformId: str(compute.platform),
  };
  if (Object.values(f).some((x) => x === null)) return null;
  return {
    id: f.id!, buildYear: f.buildYear!, contractedMW: f.contractedMW!, firmCapacityMVA: f.firmCapacityMVA!, sitePeakMW: f.sitePeakMW!, itLoadMW: f.itLoadMW!,
    queueNote: f.queueNote!, rackPositions: f.rackPositions!, positionsAvailable: f.positionsAvailable!, designDensityKw: f.designDensityKw!,
    containment: f.containment!, floorType: f.floorType!, floorLoadingNote: f.floorLoadingNote!, tapoffA: f.tapoffA!, voltageV: f.voltageV!,
    buswayA: f.buswayA!, buswayRuns: f.buswayRuns!, buswayUtilisation: f.buswayUtilisation!,
    transformer: { units: f.txUnits!, ratingMVA: f.txRating!, redundancy: f.txRedundancy!, derating: f.txDerating! },
    ups: { units: f.upsUnits!, ratingKW: f.upsRating!, redundancy: f.upsRedundancy! },
    plant: { capacityKW: f.plantCapacity!, supplyC: f.plantSupply!, pumpFlowLpm: f.pumpFlow! },
    residualAirKw: { value: f.airValue!, evidence: f.airEvidence!, note: f.airNote! },
    platformId: f.platformId!,
  };
}

/** The pack as the guide needs it, or null if it is not the synthetic model pack the guide was written against. */
export function parseRetrofitPack(raw: unknown): RetrofitPack | null {
  if (!isObj(raw)) return null;
  const schema = str(raw.schema), generated = str(raw.generated), notice = str(raw.notice);
  // A pack that does not call itself synthetic is never presented as the guide's worked example.
  if (!schema || !/^gridforge\/model-pack\/\d+$/.test(schema) || !generated || !notice || raw.synthetic !== true) return null;
  if (!isObj(raw.intake)) return null;
  const hall = parseHall(raw.intake.document);
  if (!hall || !Array.isArray(raw.scenarios)) return null;
  const scenarios = raw.scenarios.map(parseScenario);
  if (scenarios.some((s) => s === null)) return null;
  const list = scenarios as Scenario[];
  if (!list.some((s) => s.id === SCENARIO_ID)) return null;
  return { schema, generated, synthetic: true, notice, hall, scenarios: list };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "reference", file), "utf8")) as T;
  } catch {
    return null;
  }
}

export interface Calibration {
  state: string;
  observations: number;
  sites: number;
  keysAsserted: number;
  keysWithSiteObservations: number;
}

export async function readCalibration(): Promise<Calibration | null> {
  const c = await readJson<Obj>("calibration.json");
  if (!c) return null;
  const state = str(c.state), observations = num(c.observations), sites = num(c.sites), asserted = num(c.keys_asserted), withSite = num(c.keys_with_site_observations);
  if (state === null || observations === null || sites === null || asserted === null || withSite === null) return null;
  return { state, observations, sites, keysAsserted: asserted, keysWithSiteObservations: withSite };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The derived views
// ---------------------------------------------------------------------------------------------------------------------------------

export type LimitState = "fails" | "passes" | "ceiling" | "not_assessed" | "not_applicable";

/**
 * What the pack's row means. The engine gives a gate that passes no rack count (unlimited) and one that fails zero (gridforge/constraints.py:
 * gate_racks); a constraint the architecture does not use has no count and is not a gate. A constraint the engine says it did NOT assess
 * (for example a CDU limit when the hall declares no CDU schedule) also has no count, and is not shown adequate: it is never read as "does not apply".
 */
export function limitState(c: PackConstraint): LimitState {
  if (c.racks === null) return c.gate ? "passes" : /not assessed/i.test(c.basis) ? "not_assessed" : "not_applicable";
  if (c.gate && c.racks === 0) return "fails";
  return "ceiling";
}

const CLASS_RE = /\bE[0-7]\b/g;

/** The evidence classes a basis sentence names, in the order it names them, each once. */
export function classesIn(basis: string): string[] {
  return [...new Set(basis.match(CLASS_RE) ?? [])];
}

/** The weakest of them: the engine states a result at the weakest class that went into it. */
export function weakestClass(classes: string[]): string | null {
  if (!classes.length) return null;
  return classes.reduce((a, b) => (Number(b.slice(1)) < Number(a.slice(1)) ? b : a));
}

/** The first n sentences of a text, unchanged. A sentence ends at a full stop followed by a space and a capital. */
export function firstSentences(text: string, n: number): string {
  const parts = text.split(/(?<=\.)\s+(?=[A-Z])/);
  return parts.slice(0, n).join(" ");
}

/**
 * A basis as the guide prints it: the engine's sentence up to the point where its note turns to modelling limits (" Modelling limit:" or " Flow basis:").
 * Those notes are long, repeat across rows and are in the pack in full; the evidence classes the guide lists for a row are read from what it prints.
 */
export function displayBasis(basis: string): string {
  const cuts = [" Modelling limit:", " Flow basis:"].map((m) => basis.indexOf(m)).filter((i) => i >= 0);
  return (cuts.length ? basis.slice(0, Math.min(...cuts)) : basis).trim();
}

export interface OrderedLimit {
  /** 1-based place in the order the limits bind. */
  position: number;
  id: string;
  name: string;
  domain: string;
  gate: boolean;
  state: LimitState;
  racks: number | null;
  /** As printed (displayBasis of the pack's sentence). */
  basis: string;
  classes: string[];
  weakest: string | null;
  /** Every step of the ladder that relieves it, in order. */
  rungs: LadderStep[];
}

/**
 * The thirteen constraints in the order they bind: first those the engine's headroom ladder relieves, in the order it relieves them (the ladder
 * relieves the binding limit and solves again, so this IS the sequence); then the rest, ceilings by their rack count, then gates that pass, then
 * any the architecture does not use. The ladder can name a limit twice; it appears once, at its first step.
 */
export function bindingOrder(s: Scenario): OrderedLimit[] {
  const byId = new Map(s.constraints.map((c) => [c.id, c]));
  const seen: string[] = [];
  for (const step of s.ladder) if (byId.has(step.constraint) && !seen.includes(step.constraint)) seen.push(step.constraint);
  const rest = s.constraints.filter((c) => !seen.includes(c.id));
  const rank = (c: PackConstraint) => ({ ceiling: 0, fails: 0, not_assessed: 1, passes: 2, not_applicable: 3 })[limitState(c)];
  rest.sort((a, b) => rank(a) - rank(b) || (a.racks ?? Infinity) - (b.racks ?? Infinity));
  const all = [...seen.map((id) => byId.get(id)!), ...rest];
  return all.map((c, i) => {
    const shown = displayBasis(c.basis);
    const classes = classesIn(shown);
    return {
      position: i + 1, id: c.id, name: c.name, domain: c.domain, gate: c.gate, state: limitState(c), racks: c.racks, basis: shown, classes,
      weakest: weakestClass(classes), rungs: s.ladder.filter((l) => l.constraint === c.id),
    };
  });
}

export interface ReliefLead {
  id: string;
  name: string;
  steps: number[];
  /** The longest lead time among its taken steps. */
  lead: Qty;
}

/** The reliefs the ladder takes, longest lead time first: the order in which to START them, which is not the order in which the limits bind. */
export function startOrder(s: Scenario): ReliefLead[] {
  const out = new Map<string, ReliefLead>();
  for (const step of s.ladder) {
    if (!step.taken || !step.leadTime) continue;
    const cur = out.get(step.constraint);
    if (!cur) out.set(step.constraint, { id: step.constraint, name: step.name, steps: [step.step], lead: step.leadTime });
    else {
      cur.steps.push(step.step);
      if (step.leadTime.value > cur.lead.value) cur.lead = step.leadTime;
    }
  }
  return [...out.values()].sort((a, b) => b.lead.value - a.lead.value || a.steps[0] - b.steps[0]);
}

export interface CapabilityRange {
  nominal: number;
  low: number;
  high: number;
}

const CAPABILITY_RE = /practically capable of ([\d,.]+) \[([\d,.]+)–([\d,.]+)\] kW/;
const plain = (s: string) => Number(s.replace(/,/g, ""));

/** The practical per-rack range the engine's library holds for the scenario's architecture, as its architecture-capability row states it. */
export function capabilityRange(s: Scenario): CapabilityRange | null {
  const c = s.constraints.find((x) => x.id === "architecture_capability");
  const m = c ? CAPABILITY_RE.exec(c.basis) : null;
  if (!m) return null;
  const r = { nominal: plain(m[1]), low: plain(m[2]), high: plain(m[3]) };
  return [r.nominal, r.low, r.high].every(Number.isFinite) ? r : null;
}

export interface BandRow {
  kw: number;
  /** Why this rack power is a point of the band, in the library's terms. */
  from: string[];
  feedA: number;
  tapoffShortfallA: number;
  /** Air-side load at each library platform's liquid share. */
  air: { platformId: string; platformName: string; liquidShare: number; kw: number; overBy: number }[];
}

export interface BandArithmetic {
  rows: BandRow[];
  /** The largest rack the installed tap-off can feed, at the library's feed current per kW. */
  maxRackOnTapoffKw: number;
  /** The largest rack whose residual air the position can remove, at each library platform's liquid share. */
  maxRackOnAir: { platformId: string; platformName: string; liquidShare: number; kw: number }[];
  /** The reference platform's own figures reproduced by the same arithmetic (a check, not a result). */
  check: { feedA: number; airKw: number; feedMatches: boolean; airMatches: boolean };
}

/**
 * The two per-position relations applied to the rack powers that bound the liquid architectures' practical ranges:
 *   feed current  = the library's feed current per kW of the reference platform x rack kW   (current is proportional to power at a fixed supply)
 *   residual air  = rack kW x (1 - liquid share)                                           (the constraint reference's own relation)
 * compared with the hall's installed tap-off and the hall's per-position air capability. The liquid share of each library platform is used as given;
 * a rack of another power is not a library platform, so its share is an assumption and the page says so.
 */
export function bandArithmetic(pack: RetrofitPack, platform: PlatformEntry, libraryPlatforms: PlatformEntry[]): BandArithmetic | null {
  if (!platform.rack_feed_current_A || platform.rack_kW <= 0) return null;
  const labels = new Map<number, string[]>();
  const add = (kw: number, label: string) => labels.set(kw, [...(labels.get(kw) ?? []), label]);
  for (const arch of LIQUID_ARCHITECTURES) {
    const s = pack.scenarios.find((x) => x.architecture === arch);
    const r = s ? capabilityRange(s) : null;
    if (!s || !r) continue;
    const label = ARCHITECTURE_LABEL[arch];
    add(r.low, `lower end of the library's practical range for ${label}`);
    add(r.nominal, `the library's stated value for ${label}`);
  }
  const kws = [...labels.keys()].sort((a, b) => a - b);
  if (!kws.length || !libraryPlatforms.length) return null;
  const feedPerKw = platform.rack_feed_current_A / platform.rack_kW;
  const air = (kw: number, p: PlatformEntry) => {
    const load = kw * (1 - p.liquid_fraction);
    return { platformId: p.id, platformName: p.name, liquidShare: p.liquid_fraction, kw: load, overBy: load - pack.hall.residualAirKw.value };
  };
  const rows: BandRow[] = kws.map((kw) => ({
    kw, from: labels.get(kw)!, feedA: feedPerKw * kw, tapoffShortfallA: feedPerKw * kw - pack.hall.tapoffA, air: libraryPlatforms.map((p) => air(kw, p)),
  }));
  const own = air(platform.rack_kW, platform);
  return {
    rows,
    maxRackOnTapoffKw: pack.hall.tapoffA / feedPerKw,
    maxRackOnAir: libraryPlatforms.map((p) => ({ platformId: p.id, platformName: p.name, liquidShare: p.liquid_fraction, kw: pack.hall.residualAirKw.value / (1 - p.liquid_fraction) })),
    check: {
      feedA: feedPerKw * platform.rack_kW,
      airKw: own.kw,
      feedMatches: Math.abs(feedPerKw * platform.rack_kW - platform.rack_feed_current_A) < 1e-9,
      airMatches: Math.abs(own.kw - platform.residual_air_kW) < 0.05,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The model the page renders
// ---------------------------------------------------------------------------------------------------------------------------------

export interface GuideModel {
  pack: RetrofitPack;
  scenario: Scenario;
  comparison: Scenario | null;
  platform: PlatformEntry;
  /** The sourced, non-generic platforms of the library, in the library's order. */
  libraryPlatforms: PlatformEntry[];
  docs: Map<string, ConstraintDoc>;
  order: OrderedLimit[];
  /** The limits at zero racks as found. */
  zero: OrderedLimit[];
  starts: ReliefLead[];
  band: BandArithmetic | null;
  /** How many of the limits name an E0 figure in their basis. */
  withE0: number;
  calibration: Calibration | null;
}

/** Everything the page needs, or null if the published files are not what the guide was written against (the page then says so and prints nothing from memory). */
export async function loadGuideModel(): Promise<GuideModel | null> {
  const [raw, ref, lib, calibration] = await Promise.all([readJson<unknown>("model_pack.json"), constraintReference(), platformLibrary(), readCalibration()]);
  const pack = parseRetrofitPack(raw);
  if (!pack || !ref || !lib) return null;
  const scenario = pack.scenarios.find((s) => s.id === SCENARIO_ID)!;
  const platform = lib.platforms.find((p) => p.id === pack.hall.platformId);
  if (!platform) return null;
  const docs = new Map(ref.constraints.map((c) => [c.id, c]));
  const order = bindingOrder(scenario);
  if (order.some((o) => !docs.has(o.id))) return null;
  const libraryPlatforms = lib.platforms.filter((p) => !p.generic && p.sources.length > 0);
  return {
    pack, scenario, comparison: pack.scenarios.find((s) => s.id === COMPARISON_ID) ?? null, platform, libraryPlatforms, docs, order,
    zero: order.filter((o) => o.racks === 0), starts: startOrder(scenario), band: bandArithmetic(pack, platform, libraryPlatforms),
    withE0: order.filter((o) => o.classes.includes("E0")).length, calibration,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Text built from the model
// ---------------------------------------------------------------------------------------------------------------------------------

export const fmt = (v: number): string => v.toLocaleString("en-IE");
/** A name in running text: its first letter lowercased, unless it opens with an acronym (UPS, CDU) or a number. */
export const lc = (name: string): string => (/^[A-Z]{2,}|^[^A-Za-z]/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1));
/** One decimal, or none when the value is whole: 13.5 stays 13.5, 9 stays 9. */
export const d1 = (v: number): string => (Number.isInteger(v) ? fmt(v) : v.toLocaleString("en-IE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
/** One decimal always, rounded first so that 9.999999999999998 reads 10.0. */
export const f1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"];
/** A small count in words; larger ones as digits. */
export const words = (v: number): string => (Number.isInteger(v) && v >= 0 && v < WORDS.length ? WORDS[v] : fmt(v));
export const ucfirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const fmtQty = (q: Qty): string => (q.low !== null && q.high !== null ? `${fmt(q.value)} [${fmt(q.low)}–${fmt(q.high)}]` : fmt(q.value));
/** A lead time in a sentence: the value, its band and its class. */
export const fmtLead = (q: Qty): string =>
  `${fmt(q.value)} weeks${q.low !== null && q.high !== null ? ` (band ${fmt(q.low)}–${fmt(q.high)}, ${q.evidence.slice(0, 2)})` : ` (${q.evidence.slice(0, 2)})`}`;

/** The questions a reader types, answered from the model. The page shows these and marks them up from this same array (components/QuestionList.tsx). */
export function faqItems(m: GuideModel): QA[] {
  const t = m.scenario.time;
  const air = m.order.find((o) => o.id === RESIDUAL_AIR_ID);
  const transformer = m.starts[0];
  const items: QA[] = [];
  // Each answer is offered only while the pack still shows what it says: a regenerated pack that no longer does makes the question disappear
  // (and the test that pins the guide's argument to the pack fail) rather than leave an answer the data contradicts.
  if (air && air.racks === 0 && m.platform.residual_air_kW > m.pack.hall.residualAirKw.value) {
    items.push({
      q: "Does liquid cooling remove the residual air limit?",
      a: `No. It shrinks the air-side load, it does not remove it. In the synthetic hall a rack of the ${m.platform.name} leaves ${d1(m.platform.residual_air_kW)} kW in the air (${Math.round(m.platform.liquid_fraction * 100)}% of its ${d1(m.platform.rack_kW)} kW is captured by liquid), against ${d1(m.pack.hall.residualAirKw.value)} kW that one position can remove, so the limit holds the count at zero racks until it is relieved.`,
    });
  }
  if (m.zero.length) {
    items.push({
      q: "Which limit binds first when a hall built for lower density takes 100-150 kW racks?",
      a: `In the synthetic hall it is not a capacity limit. ${ucfirst(words(m.zero.length))} ${m.zero.length === 1 ? "limit holds" : "limits hold"} the count at zero racks as found: ${m.zero.map((z) => lc(z.name)).join(" and ")}. The engine names ${lc(m.scenario.asFound.bindingName)} as binding${m.zero.length > 1 ? "; the rest are still at zero, and the ladder shows them in turn" : ""}. The order is a property of this hall's ratings, not a rule for every hall.`,
    });
  }
  if (transformer && t.dateLabel && m.zero.length) {
    items.push({
      q: "Which relief should be started first?",
      a: `The one with the longest lead time, which is not the limit that binds first. In the example that is ${lc(transformer.name)} at ${fmtLead(transformer.lead)}, an assumed library figure and not a quotation. It adds no racks while a gate is still at zero, so starting it early shortens the programme without changing the order. The model dates the whole programme as "${t.dateLabel}".`,
    });
  }
  items.push({
    q: "Is the order the same for every hall?",
    a: "No. It follows from one synthetic hall's ratings. A different tap-off rating, per-position air capability, transformer schedule or plant changes which limit binds and in what order. The free qualifier and the Density Screen run it on your own numbers.",
  });
  items.push({
    q: "Are these figures measured?",
    a: `No. The hall is invented, the platform figures are held in the library as assumptions from cited sources, and every lead time is an assumption (E0). The calibration record reports ${m.calibration ? `${fmt(m.calibration.observations)} reconciled observations across ${fmt(m.calibration.sites)} sites` : "its state on the evidence page"}.`,
  });
  return items;
}
