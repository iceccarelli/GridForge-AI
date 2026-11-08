// "What did the change do to this hall's capacity envelope?" - the ENGINE's answer, asked of a hall's recorded figures at two points.
// Plain functions, no I/O and no server imports: the browser bundle uses the vocabulary, the server (lib/site-registry-engine-server.ts) builds and sends
// the documents, and the tests drive every rule below directly.
//
// WHAT THIS IS. The engine (POST /v1/diff) solves two intake documents and attributes the movement to the inputs that moved it. Here each document is
// built from the figures a hall's record held at a point in time. Origin and class are the RECORDER'S declaration; nothing here verifies them. The answer
// is a model result over declared figures, never a measurement.
//
// THREE RULES THE DOCUMENT BUILDER KEEPS (each is a test):
//   1. A class is never sent higher than the one declared, and never higher than the registry can stand behind: a figure whose file is not reviewed
//      and verified goes out as E3 at most; an assumed or modelled figure as E3 at most; nothing above E5 (the engine's own ceiling, E6/E7 are earned by
//      its calibration ledger). Every figure sent below its declared class is named in `classNotes`.
//   2. The engine fills anything it is not given from its own library, and in a diff answer it does not say which. So a figure the engine REQUIRES (its
//      own intake schema) or would invent silently (a transformer count, a redundancy scheme, the hall's positions) is never left out to make a run
//      succeed: the run does not happen and `missing` names exactly what is unrecorded. Optional figures that are left out are listed as `placeholders`.
//   3. Some figures the engine reads at a fixed class whatever class is sent (a transformer or UPS rating is read as customer data, E5), and counts and
//      names carry no class at all. A figure the engine would read ABOVE its declared class is not sent (it is missing, with that reason); a figure that
//      carries no class puts a `ceiling` on the class the answer may be given.

import { readDateBasis } from "@/lib/date-basis";
import { buildChains, stateAt } from "@/lib/site-registry-diff";
import { classRank, type RegistryInput } from "@/lib/site-registry-model";
import { EXPECTED_HALL_FIELDS } from "@/lib/site-registry-fields";
import { buildPreview, type RawRow, type WriteBody } from "@/lib/site-registry-import";

// --------------------------------------------------------------------------------------------------------------- the allowance and the cost

/** Billable units of one engine diff (gridforge/api/metering.py UNIT_COST["/v1/diff"]); a drift test reads the engine's own table. */
export const ENGINE_DIFF_UNITS = 2;
/** Runs per verified account per hour / per hall per day (lib/rate-limit.ts registry_diff, registry_diff_hall; a test pins them equal). */
export const ENGINE_DIFF_PER_HOUR = 10;
export const ENGINE_DIFF_PER_HALL_PER_DAY = 60;

export const ENGINE_DIFF_LABEL = "Modelled by the engine from the figures as recorded; origin and class are the recorder's declaration. Not a measurement.";

// --------------------------------------------------------------------------------------------------------------- the engine's intake, as far as a hall record can fill it

/** How the engine treats the class sent with a figure. declared: it uses it (capped at E5). fixed: it reads the figure at this class whatever is sent. none: a count or a name; no class is applied. */
export type ClassHandling = { how: "declared" } | { how: "fixed"; cls: number } | { how: "none" };
export type FieldKind = "number" | "count" | "text";
/** engine_required: the engine's own intake schema requires it. no_gap_default: the engine would default it without listing a gap. optional: left out, the engine uses a labelled library figure. */
export type Need = "engine_required" | "no_gap_default" | "optional";

export interface EngineField {
  /** The path as the registry stores it (lower case). For a list item `[]` stands for the item's index. */
  registry: string;
  /** The path as the engine spells it, `[]` for the index. */
  engine: string;
  label: string;
  /** true: the label is the engine's own (gridforge/intake/schema.py); a test compares it. */
  labelIsEngines: boolean;
  /** The unit the engine takes; "" for none. */
  unit: string;
  /** The recorded units this page accepts as that unit. It never converts. */
  units: readonly string[];
  kind: FieldKind;
  need: Need;
  handling: ClassHandling;
  /** What the engine does when the figure is not given (for the placeholders list). */
  fallback: string;
}

const NUMBER: ClassHandling = { how: "declared" };
const NONE: ClassHandling = { how: "none" };
const fixed = (cls: number): ClassHandling => ({ how: "fixed", cls });
const RATIO = ["", "-", "1"] as const;

const f = (registry: string, engine: string, label: string, unit: string, kind: FieldKind, need: Need, handling: ClassHandling, fallback: string, opts: { units?: readonly string[]; own?: boolean } = {}): EngineField => ({
  registry, engine, label, labelIsEngines: opts.own ?? true, unit, units: opts.units ?? (unit === "" || unit === "-" ? RATIO : [unit]), kind, need, handling, fallback,
});

export const SCALAR_FIELDS: readonly EngineField[] = [
  // ---- the engine's required list (gridforge/intake/schema.py REQUIRED_PATHS), scalars
  f("grid.firm_capacity_mva", "grid.firm_capacity_MVA", "Firm connection capacity", "MVA", "number", "engine_required", NUMBER, ""),
  f("grid.contracted_mw", "grid.contracted_MW", "Contracted capacity", "MW", "number", "engine_required", NUMBER, ""),
  f("grid.current_site_peak_mw", "grid.current_site_peak_MW", "Current site peak demand", "MW", "number", "engine_required", NUMBER, ""),
  f("grid.current_it_load_mw", "grid.current_it_load_MW", "Current protected IT load", "MW", "number", "engine_required", NUMBER, ""),
  f("lv.busway_ampacity_a", "lv.busway_ampacity_A", "Installed busway ampacity", "A", "number", "engine_required", NUMBER, ""),
  f("lv.tapoff_max_a", "lv.tapoff_max_A", "Installed tap-off rating", "A", "number", "engine_required", NUMBER, ""),
  f("hall.floor_loading_kpa", "hall.floor_loading_kPa", "Hall design floor loading", "kPa", "number", "engine_required", NUMBER, ""),
  f("hall.positions_available", "hall.positions_available", "Rack positions available", "", "count", "engine_required", NONE, "", { units: ["", "positions"] }),
  f("thermal.plant.chilled_water_capacity_kw", "thermal.plant.chilled_water_capacity_kW", "Chilled-water plant capacity", "kW", "number", "engine_required", NUMBER, ""),
  f("thermal.plant.design_supply_c", "thermal.plant.design_supply_C", "Plant supply temperature", "degC", "number", "engine_required", NUMBER, "", { units: ["degC", "°C"] }),
  f("compute.platform", "compute.platform", "Target platform", "", "text", "engine_required", NONE, ""),
  // ---- the engine defaults these without listing a gap, and each bounds the rack count
  f("hall.rack_positions", "hall.rack_positions", "Rack positions (total)", "", "count", "no_gap_default", NONE, "", { units: ["", "positions"], own: false }),
  // ---- optional: left out, the engine uses a labelled library figure
  f("grid.power_factor", "grid.power_factor", "Site power factor", "-", "number", "optional", NUMBER, "library placeholder 0.97 (E0)"),
  f("lv.voltage_v", "lv.voltage_V", "LV distribution voltage", "V", "number", "optional", NUMBER, "library placeholder 400 V (E0)"),
  f("lv.busway_runs", "lv.busway_runs", "Number of busway runs", "", "count", "optional", NONE, "library placeholder of 6 runs", { units: ["", "-", "runs"] }),
  f("lv.busway_utilisation_limit", "lv.busway_utilisation_limit", "Busway utilisation limit", "-", "number", "optional", NUMBER, "library placeholder 0.8 (E0)"),
  f("lv.existing_busway_load_kw", "lv.existing_busway_load_kW", "Load already on the busway", "kW", "number", "optional", NUMBER, "0 kW: nothing is subtracted from the installed busway"),
  f("hall.net_white_space_m2", "hall.net_white_space_m2", "Net white space", "m2", "number", "optional", NUMBER, "library placeholder 2,000 m2 (E0)", { units: ["m2", "m²"] }),
  f("hall.aisle_pitch_m", "hall.aisle_pitch_m", "Installed aisle pitch", "m", "number", "optional", NUMBER, "library placeholder 2.4 m (E0)"),
  f("hall.design_density_kw_per_rack", "hall.design_density_kW_per_rack", "Hall design density per rack", "kW", "number", "optional", NUMBER, "library placeholder 8 kW per rack (E0)", { units: ["kW", "kW/rack"], own: false }),
  f("thermal.plant.design_return_c", "thermal.plant.design_return_C", "Plant design return temperature", "degC", "number", "optional", NUMBER, "library placeholder 13 degC (E0)", { units: ["degC", "°C"] }),
  f("thermal.plant.pump_flow_capacity_l_per_min", "thermal.plant.pump_flow_capacity_l_per_min", "Available pumped flow", "l/min", "number", "optional", NUMBER, "library placeholder 7,000 l/min (E0)"),
  f("thermal.plant.existing_flow_l_per_min", "thermal.plant.existing_flow_l_per_min", "Flow the existing hall already draws on the plant", "l/min", "number", "optional", NUMBER, "0 l/min: nothing is subtracted from the pumped flow"),
  f("thermal.plant.existing_non_it_heat_kw", "thermal.plant.existing_non_it_heat_kW", "Other heat the existing hall already puts on the plant", "kW", "number", "optional", NUMBER, "0 kW: nothing is subtracted from the plant capacity"),
  f("thermal.residual_air_capacity_kw_per_rack", "thermal.residual_air_capacity_kW_per_rack", "Air removal per rack position", "kW", "number", "optional", NUMBER, "the engine's library figure for legacy air removal", { units: ["kW", "kW/rack"] }),
  f("thermal.tcs_target_supply_c", "thermal.tcs_target_supply_C", "TCS target supply temperature", "degC", "number", "optional", NUMBER, "the engine's library design value", { units: ["degC", "°C"] }),
  f("thermal.rdhx.capacity_kw_per_rack", "thermal.rdhx.capacity_kW_per_rack", "Rear-door heat exchanger capacity per rack", "kW", "number", "optional", NUMBER, "library default of 60 kW per rack (band 20-80)", { units: ["kW", "kW/rack"] }),
  f("site.design_drybulb_c", "site.design_drybulb_C", "Summer design dry bulb", "degC", "number", "optional", NUMBER, "library placeholder 32 degC (E0)", { units: ["degC", "°C"] }),
  f("compute.utilisation", "compute.utilisation", "Annual average rack utilisation", "-", "number", "optional", NUMBER, "library placeholder 0.75 (E0)"),
  f("economics.electricity_eur_per_mwh", "economics.electricity_eur_per_MWh", "All-in grid electricity price", "EUR/MWh", "number", "optional", NUMBER, "library placeholder of 140 EUR/MWh (E0)"),
  f("economics.horizon_years", "economics.horizon_years", "Lifecycle horizon", "years", "count", "optional", NONE, "none: no lifecycle value is computed", { units: ["years", "year", "yr"] }),
  f("economics.discount_rate", "economics.discount_rate", "Discount rate", "-", "number", "optional", fixed(5), "none: the lifecycle value is undiscounted"),
];

export type Section = "transformers" | "ups";
export const SECTIONS: readonly Section[] = ["transformers", "ups"];

/** The engine's own refusal for a list item without its rating: "the intake is missing a required field: unit_rating_MVA". Drift-tested against the real engine. */
export const ENGINE_ITEM_RATING: Record<Section, string> = { transformers: "unit_rating_MVA", ups: "unit_rating_kW" };

export const ITEM_FIELDS: Record<Section, readonly EngineField[]> = {
  transformers: [
    f("transformers[].unit_rating_mva", "transformers[].unit_rating_MVA", "Transformer unit rating", "MVA", "number", "engine_required", fixed(5), "", { own: false }),
    f("transformers[].units", "transformers[].units", "Transformer units", "", "count", "no_gap_default", NONE, "", { units: ["", "units"], own: false }),
    f("transformers[].redundancy", "transformers[].redundancy", "Transformer redundancy", "", "text", "no_gap_default", NONE, "", { own: false }),
    f("transformers[].derating_factor", "transformers[].derating_factor", "Transformer derating factor", "-", "number", "optional", fixed(3), "library placeholder 0.9 (E0)", { own: false }),
    f("transformers[].replacement_lead_time_weeks", "transformers[].replacement_lead_time_weeks", "Power transformer replacement lead time", "weeks", "number", "optional", fixed(0), "library placeholder of 160 weeks (band 80-210), not a manufacturer's quote", { units: ["weeks", "week", "wk"] }),
  ],
  ups: [
    f("ups[].unit_rating_kw", "ups[].unit_rating_kW", "UPS module rating", "kW", "number", "engine_required", fixed(5), "", { own: false }),
    f("ups[].units", "ups[].units", "UPS units", "", "count", "no_gap_default", NONE, "", { units: ["", "units"], own: false }),
    f("ups[].redundancy", "ups[].redundancy", "UPS redundancy", "", "text", "no_gap_default", NONE, "", { own: false }),
    f("ups[].step_load_capability", "ups[].step_load_capability", "UPS accepted instantaneous step load", "-", "number", "optional", fixed(0), "library placeholder 0.5 (E0)", { own: false }),
  ],
};

/** The engine's required list, by its own spelling (gridforge/intake/schema.py REQUIRED_PATHS). A drift test compares this with the engine. */
export const ENGINE_REQUIRED_PATHS: readonly string[] = [
  "grid.firm_capacity_MVA", "grid.contracted_MW", "grid.current_site_peak_MW", "grid.current_it_load_MW", "lv.busway_ampacity_A", "lv.tapoff_max_A",
  "hall.floor_loading_kPa", "hall.positions_available", "thermal.plant.chilled_water_capacity_kW", "thermal.plant.design_supply_C", "transformers", "ups", "compute.platform",
];

/**
 * THE MINIMUM a run needs, as the registry spells it: the engine's required figures, and the ones it would otherwise default without a word. One transformer
 * item and one UPS item are shown as item 0; every item a hall records must be complete. Nothing here is a default: it is the list of what must be recorded.
 */
export const RECORDED_MINIMUM: readonly string[] = [
  ...SCALAR_FIELDS.filter((x) => x.need !== "optional").map((x) => x.registry),
  ...SECTIONS.flatMap((s) => ITEM_FIELDS[s].filter((x) => x.need !== "optional").map((x) => x.registry.replace("[]", "[0]"))),
];

const ALL_FIELDS: readonly EngineField[] = [...SCALAR_FIELDS, ...SECTIONS.flatMap((s) => ITEM_FIELDS[s])];
const BY_REGISTRY = new Map(SCALAR_FIELDS.map((x) => [x.registry, x]));
const ITEM_PATH = /^(transformers|ups)\[(\d{1,3})\]\.([a-z_]+)$/;

export interface Matched { field: EngineField; section: Section | null; index: number | null }

/** The engine field a recorded path stands for, or null when the engine's intake has no such field. */
export function matchField(path: string): Matched | null {
  const scalar = BY_REGISTRY.get(path);
  if (scalar) return { field: scalar, section: null, index: null };
  const m = ITEM_PATH.exec(path);
  if (!m) return null;
  const section = m[1] as Section;
  const field = ITEM_FIELDS[section].find((x) => x.registry === `${section}[].${m[3]}`);
  const index = Number(m[2]);
  return field && index < 100 ? { field, section, index } : null;
}

const itemPath = (field: EngineField, i: number) => field.registry.replace("[]", `[${i}]`);
const itemEnginePath = (field: EngineField, k: number) => field.engine.replace("[]", `[${k}]`);

// --------------------------------------------------------------------------------------------------------------- the recorded state at a point

export type Recorded = Map<string, { input: RegistryInput } | { unknown: true }>;

/** The hall's current figures (the latest, not replaced, claim of each field). */
export function recordedNow(current: RegistryInput[]): Recorded {
  return new Map(current.map((i) => [i.fieldPath, { input: i }]));
}

/** What the record said at the END of that UTC day: the latest claim recorded by then. A field whose older history was not loaded is "unknown", never "not recorded". */
export function recordedAsOf(claims: RegistryInput[], day: string): Recorded {
  const at = Date.parse(`${day}T23:59:59.999Z`);
  const out: Recorded = new Map();
  for (const [path, chain] of buildChains(claims)) {
    const s = stateAt(chain, at);
    if (s.kind === "claim") out.set(path, { input: s.claim });
    else if (s.kind === "unknown") out.set(path, { unknown: true });
  }
  return out;
}

export interface ProposedPlan { recorded: Recorded; used: number; unchanged: number; excluded: { n: number; fieldPath: string; reason: string }[] }

/**
 * The hall's current figures with the rows of a pending import laid over them, judged by the IMPORT'S OWN rules (buildPreview): a row the import would reject is
 * left out and listed, never adjusted. Nothing is written. A row's file is looked up among the files the hall's current figures cite; any other is "not yet reviewed".
 */
export function recordedWithProposed(current: RegistryInput[], rows: RawRow[], today: string): ProposedPlan {
  const preview = buildPreview(rows, { current, today });
  const out = recordedNow(current);
  const known = new Map<string, { kind: string; filename: string | null; reviewStatus: string | null }>();
  for (const i of current) if (i.source) known.set(i.source.id.toLowerCase(), { kind: i.source.kind, filename: i.source.filename, reviewStatus: i.source.reviewStatus });
  let used = 0;
  const excluded: ProposedPlan["excluded"] = [];
  for (const p of preview.rows) {
    if (p.status === "rejected") { excluded.push({ n: p.n, fieldPath: p.fieldPath, reason: p.reasons[0] ?? "rejected" }); continue; }
    if (p.status === "unchanged" || !p.body) continue;
    out.set(p.body.fieldPath, { input: proposedInput(p.body, p.n, known) });
    used++;
  }
  return { recorded: out, used, unchanged: preview.counts.unchanged, excluded: excluded.slice(0, 20) };
}

function proposedInput(b: WriteBody, n: number, known: Map<string, { kind: string; filename: string | null; reviewStatus: string | null }>): RegistryInput {
  const sid = (b.projectEvidenceId ?? b.intakeEvidenceFileId)?.toLowerCase() ?? null;
  const k = sid ? known.get(sid) : undefined;
  return {
    id: `proposed-${n}`, fieldPath: b.fieldPath, value: b.value, unit: b.unit, evidenceClass: b.evidenceClass, origin: b.origin, asOf: b.asOf, recordedBy: "",
    source: sid ? { kind: b.projectEvidenceId ? "project_evidence" : "intake_evidence", id: sid, filename: null, reviewStatus: b.projectEvidenceId ? (k?.reviewStatus ?? null) : null } : null,
  };
}

// --------------------------------------------------------------------------------------------------------------- the class that may be sent

export interface Sendable { declared: number; sent: number; why: string | null }

const code = (n: number) => `E${n}`;

function fileStatus(i: RegistryInput): string {
  if (!i.source) return "no file cited";
  if (i.source.kind === "intake_evidence") return "file not reviewable";
  return i.source.reviewStatus === "verified" ? "file reviewed and verified" : i.source.reviewStatus === "rejected" ? "file rejected" : "file not yet reviewed";
}

/**
 * The class that may go to the engine with a figure: the declared one, held down to what the registry can stand behind. NEVER higher than declared.
 *   assumed / modelled                          E3 at most (the registry's own rule)
 *   a project file reviewed and verified (now)  up to E5
 *   anything else (no file, an unreviewed or rejected file, a purchased engagement's file)   E3 at most
 *   whatever is declared above E5               E5 (the engine's ceiling; E6 and E7 are earned through its calibration ledger)
 */
export function sendableClass(i: Pick<RegistryInput, "origin" | "evidenceClass" | "source">): Sendable {
  const declaredRaw = classRank(i.evidenceClass);
  const declared = Number.isNaN(declaredRaw) ? 0 : declaredRaw;
  const verified = i.source?.kind === "project_evidence" && i.source.reviewStatus === "verified";
  const capped = i.origin === "assumed" || i.origin === "modelled";
  const cap = capped ? 3 : verified ? 5 : 3;
  const sent = Math.max(0, Math.min(declared, cap, 5));
  let why: string | null = null;
  if (sent < declared) {
    if (declared > 5 && cap === 5) why = "The engine takes a declared class up to E5; E6 and E7 are earned through its calibration ledger, not declared.";
    else if (capped) why = `A figure declared ${i.origin} is carried at E3 at most.`;
    else why = `The ${i.source ? "file it cites is not reviewed and verified now" : "figure cites no file"}, so it is carried at E3 at most.`;
  }
  return { declared, sent, why };
}

// --------------------------------------------------------------------------------------------------------------- one document

export type Side = "from" | "to";

export interface ClassNote { path: string; declared: string; sent: string; why: string }
export interface Absent { path: string; field: EngineField; reason: string }
export interface Placeholder { path: string; label: string; fallback: string }
export interface NotUsed { path: string; reason: string }
export interface Uncarried { path: string; cls: number }

export interface Built {
  /** The intake document for the engine. Meaningful only when `absent` is empty. */
  doc: Record<string, unknown>;
  classNotes: ClassNote[];
  /** Required (or silently-defaulted) figures this side does not have in a usable form, each with the reason. */
  absent: Absent[];
  placeholders: Placeholder[];
  notUsed: NotUsed[];
  /** Figures sent with no class applied by the engine (counts, names): the answer's class cannot be stronger than the weakest of these. */
  uncarried: Uncarried[];
  /** The engine's path (with the compacted list index it was sent at) -> the path as recorded. */
  pathMap: Map<string, string>;
  /** Paths sent, by engine path: the class code they went with (or null when sent plain). */
  sentClass: Map<string, string | null>;
}

type Prepared = { ok: true; value: number | string; cls: number; plain: boolean; note: string; declared: number; why: string | null } | { ok: false; reason: string };

function prepare(field: EngineField, i: RegistryInput): Prepared {
  const v = i.value;
  if (field.kind === "text") {
    if (typeof v !== "string" || v.trim() === "") return { ok: false, reason: `It is recorded as ${typeof v === "number" ? "a number" : "something other than text"}; the engine takes a name here.` };
  } else {
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, reason: `It is recorded as ${typeof v === "string" ? "text" : "something other than a number"}; the engine takes a number.` };
    if (field.kind === "count" && (!Number.isInteger(v) || v < 0)) return { ok: false, reason: "It is not a whole number of zero or more." };
  }
  if (field.kind !== "text") {
    const u = (i.unit ?? "").trim();
    if (!field.units.includes(u)) {
      return { ok: false, reason: `It is recorded in ${u ? `“${u.slice(0, 24)}”` : "no unit"}; the engine takes ${field.unit ? field.unit : "a plain number"}. This page does not convert.` };
    }
  }
  const c = sendableClass(i);
  if (field.handling.how === "fixed" && c.sent < field.handling.cls) {
    return {
      ok: false,
      reason: `The engine reads this figure as ${code(field.handling.cls)} whatever class is sent, and it is recorded as ${code(c.declared)}${c.sent < c.declared ? ` (carried at ${code(c.sent)})` : ""}. Sending it would raise its class, so it is not sent.`,
    };
  }
  return { ok: true, value: field.kind === "text" ? (v as string).trim() : (v as number), cls: c.sent, plain: false, note: `declared ${i.origin} by the recorder; ${fileStatus(i)}`, declared: c.declared, why: c.why };
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = doc;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Build one intake document from the figures recorded at a point. See the header for the rules. */
export function buildEngineDocument(rec: Recorded): Built {
  const built: Built = { doc: {}, classNotes: [], absent: [], placeholders: [], notUsed: [], uncarried: [], pathMap: new Map(), sentClass: new Map() };
  const reasons = new Map<string, string>();               // recorded path -> why it is not usable
  const ready = new Map<string, Extract<Prepared, { ok: true }>>();
  const seenIndexes: Record<Section, Set<number>> = { transformers: new Set(), ups: new Set() };

  for (const [path, r] of [...rec].sort(([a], [b]) => a.localeCompare(b))) {
    const m = matchField(path);
    if (!m) {
      if ("unknown" in r || r.input.origin !== "missing") built.notUsed.push({ path, reason: "The engine's intake has no such input, so it takes no part in the run." });
      continue;
    }
    if (m.section) seenIndexes[m.section].add(m.index!);
    if ("unknown" in r) { reasons.set(path, "Its older history was not loaded, so what it said at this point cannot be told."); continue; }
    const i = r.input;
    if (i.origin === "missing" || i.value === null) { reasons.set(path, "It is recorded as missing."); continue; }
    const p = prepare(m.field, i);
    if (!p.ok) { reasons.set(path, p.reason); built.notUsed.push({ path, reason: p.reason }); continue; }
    ready.set(path, p);
  }


  // ---- scalars
  for (const field of SCALAR_FIELDS) {
    const p = ready.get(field.registry);
    if (p) {
      const value = field.handling.how === "fixed" ? p.value : { value: p.value, evidence: code(p.cls), note: p.note };
      setPath(built.doc, field.engine, value);
      built.pathMap.set(field.engine, field.registry);
      built.sentClass.set(field.engine, field.handling.how === "fixed" ? null : code(p.cls));
      if (p.why) built.classNotes.push({ path: field.registry, declared: code(p.declared), sent: code(p.cls), why: p.why });
      if (field.handling.how === "none") built.uncarried.push({ path: field.registry, cls: p.cls });
    } else if (field.need === "optional") {
      built.placeholders.push({ path: field.registry, label: field.label, fallback: field.fallback });
    } else {
      built.absent.push({ path: field.registry, field, reason: reasons.get(field.registry) ?? "It is not recorded." });
    }
  }

  // ---- the equipment lists: every item the record holds must be complete; at least one of each is needed
  for (const section of SECTIONS) {
    const fields = ITEM_FIELDS[section];
    const indexes = [...seenIndexes[section]].sort((a, b) => a - b);
    const wanted = indexes.length ? indexes : [0];
    const items: Record<string, unknown>[] = [];
    for (const idx of wanted) {
      const complete = fields.filter((x) => x.need !== "optional").every((x) => ready.has(itemPath(x, idx)));
      if (!complete) {
        for (const x of fields.filter((y) => y.need !== "optional" && !ready.has(itemPath(y, idx)))) {
          built.absent.push({ path: itemPath(x, idx), field: x, reason: reasons.get(itemPath(x, idx)) ?? "It is not recorded." });
        }
        // The rest of an incomplete item is not sent: an item without its rating cannot be read by the engine at all.
        for (const x of fields.filter((y) => y.need === "optional" && ready.has(itemPath(y, idx)))) {
          built.notUsed.push({ path: itemPath(x, idx), reason: "The item it belongs to is not complete, so none of the item is sent." });
        }
        continue;
      }
      const k = items.length;
      const item: Record<string, unknown> = {};
      for (const x of fields) {
        const path = itemPath(x, idx);
        const p = ready.get(path);
        if (p) {
          const key = x.engine.split(".")[1]!;
          item[key] = p.value;                                        // the engine takes a plain value in a list item
          built.pathMap.set(itemEnginePath(x, k), path);
          built.sentClass.set(itemEnginePath(x, k), null);
          if (p.why) built.classNotes.push({ path, declared: code(p.declared), sent: code(p.cls), why: p.why });
          if (x.handling.how === "none") built.uncarried.push({ path, cls: p.cls });
        } else if (x.need === "optional") {
          built.placeholders.push({ path, label: x.label, fallback: x.fallback });
        }
      }
      items.push(item);
    }
    if (items.length) built.doc[section] = items;
  }
  return built;
}

// --------------------------------------------------------------------------------------------------------------- two documents

export type PointSpec = { kind: "now" } | { kind: "asOf"; day: string } | { kind: "proposed"; used: number; unchanged: number; excluded: ProposedPlan["excluded"] };

export interface MissingField {
  path: string;
  label: string;
  unit: string;
  /** Which side(s) lack it. */
  sides: Side[];
  reason: string;
  /** engine_required: the engine's intake requires it. no_gap_default: the engine would fill it from a library default without listing a gap. */
  need: Exclude<Need, "optional">;
  /** true when the import template carries this field (otherwise it is recorded one at a time). */
  inTemplate: boolean;
}

export interface Merged<T> { item: T; sides: Side[] }

export interface Comparison {
  /** Required figures that one or both sides lack. Non-empty: the engine is not run. */
  missing: MissingField[];
  classNotes: (ClassNote & { side: Side })[];
  placeholders: (Placeholder & { sides: Side[] })[];
  notUsed: (NotUsed & { sides: Side[] })[];
  /** The weakest class among the figures sent with no class applied by the engine (counts, names), both sides together. null: there is none. */
  ceiling: { cls: string; paths: string[] } | null;
  /** Paths whose value is the same on both sides but sent at a different class. */
  classChanges: { path: string; from: string; to: string }[];
  /** true: the two documents are the same, so there is nothing to ask the engine. */
  identical: boolean;
}

const IMPORTABLE = new Set(EXPECTED_HALL_FIELDS.map((x) => x.path));

function mergeSides<T extends { path: string }>(a: T[], b: T[], same: (x: T, y: T) => boolean): (T & { sides: Side[] })[] {
  const out: (T & { sides: Side[] })[] = [];
  for (const [side, list] of [["from", a], ["to", b]] as const) {
    for (const x of list) {
      const hit = out.find((o) => o.path === x.path && same(o, x));
      if (hit) hit.sides.push(side); else out.push({ ...x, sides: [side] });
    }
  }
  return out;
}

export function compareBuilt(from: Built, to: Built): Comparison {
  const miss = new Map<string, MissingField>();
  const reasonBy = new Map<string, Partial<Record<Side, string>>>();
  for (const [side, b] of [["from", from], ["to", to]] as const) {
    for (const a of b.absent) {
      const have = miss.get(a.path);
      if (have) have.sides.push(side);
      else miss.set(a.path, { path: a.path, label: a.field.label, unit: a.field.unit, sides: [side], reason: "", need: a.field.need as MissingField["need"], inTemplate: IMPORTABLE.has(a.path) });
      reasonBy.set(a.path, { ...(reasonBy.get(a.path) ?? {}), [side]: a.reason });
    }
  }
  for (const m of miss.values()) {
    const r = reasonBy.get(m.path)!;
    m.reason = r.from && r.to && r.from !== r.to ? `Earlier point: ${r.from} Later point: ${r.to}` : (r.from ?? r.to)!;
  }
  const classNotes = [...from.classNotes.map((n) => ({ ...n, side: "from" as Side })), ...to.classNotes.map((n) => ({ ...n, side: "to" as Side }))];
  const unc = [...from.uncarried, ...to.uncarried];
  const lowest = unc.length ? Math.min(...unc.map((u) => u.cls)) : null;
  const classChanges: Comparison["classChanges"] = [];
  for (const [ep, a] of from.sentClass) {
    const b = to.sentClass.get(ep);
    if (b !== undefined && a !== null && b !== null && a !== b && JSON.stringify(valueAt(from.doc, ep)) === JSON.stringify(valueAt(to.doc, ep))) {
      classChanges.push({ path: to.pathMap.get(ep) ?? from.pathMap.get(ep) ?? ep, from: a, to: b });
    }
  }
  return {
    missing: [...miss.values()].sort((a, b) => a.path.localeCompare(b.path)),
    classNotes,
    placeholders: mergeSides(from.placeholders, to.placeholders, () => true).map(({ sides, ...p }) => ({ ...p, sides })),
    notUsed: mergeSides(from.notUsed, to.notUsed, (x, y) => x.reason === y.reason).map(({ sides, ...p }) => ({ ...p, sides })),
    ceiling: lowest === null ? null : { cls: code(lowest), paths: [...new Set(unc.filter((u) => u.cls === lowest).map((u) => u.path))].sort() },
    classChanges: classChanges.sort((a, b) => a.path.localeCompare(b.path)),
    identical: stable(from.doc) === stable(to.doc),
  };
}

/** The value (or {value, evidence}'s value) at an engine path of a document. */
function valueAt(doc: unknown, enginePath: string): unknown {
  let cur: unknown = doc;
  for (const part of enginePath.split(".")) {
    const m = /^([A-Za-z_0-9]+)(?:\[(\d+)\])?$/.exec(part);
    if (!m || typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]!];
    if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  return typeof cur === "object" && cur !== null && "value" in cur ? (cur as { value: unknown }).value : cur;
}

/** A key-sorted JSON text, so two documents compare by content. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The field a driver path (the engine's spelling, possibly an indexed list item) stands for, with the recorded path it was sent from. */
export function labelFor(enginePath: string): string | null {
  const generic = enginePath.replace(/\[\d+\]/, "[]");
  return ALL_FIELDS.find((x) => x.engine === generic)?.label ?? null;
}

// --------------------------------------------------------------------------------------------------------------- the engine's answer, whitelisted

export type Direction = "raises" | "lowers" | "no change";

export interface DriverView {
  /** The input as recorded (null if the engine named one this page did not send). */
  path: string | null;
  enginePath: string;
  label: string | null;
  before: number | string | boolean | null;
  after: number | string | boolean | null;
  /** What moving only this input does to the rack count. */
  direction: Direction;
  racksDelta: number;
  flipsBindingTo: string | null;
  racksClass: string | null;
}

export interface WeeksView {
  /** null when the engine gave no number, or said nothing about what it rests on (a number is never shown alone). */
  delta: number | null;
  basis: "none" | "assumed" | "supported" | "unverified";
  evidenceClass: string | null;
  bindingItem: string | null;
  label: string;
}

export interface EnvelopeView { racksAsFound: number; racksAfterLadder: number; bindingName: string; bindingBasis: string; scenario: string }

export interface EngineDiffView {
  headline: string;
  material: boolean;
  racksDelta: number;
  explainedRacks: number;
  unexplainedRacks: number;
  before: EnvelopeView;
  after: EnvelopeView;
  bindingMoved: boolean;
  /** The weakest rack-count class the engine reports on either side, e.g. "E0". */
  racksClass: string | null;
  drivers: DriverView[];
  weeks: WeeksView;
  inputs: string;
  /** Inputs the engine did not attribute (beyond its probe cap, or that cannot stand alone), by recorded path. */
  notAttributed: string[];
}

const TEXT_MAX = 400;
const clean = (v: unknown, max = TEXT_MAX): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return s ? (s.length > max ? s.slice(0, max - 1) + "…" : s) : null;
};
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 1e6 ? v : null);
const scalar = (v: unknown): number | string | boolean | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? clean(v, 80) : typeof v === "boolean" ? v : null);
const classCode = (v: unknown): string | null => (typeof v === "string" && /^E[0-7](?:_|$)/.test(v) ? v.slice(0, 2) : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function envelope(v: unknown): EnvelopeView | null {
  if (!isObj(v)) return null;
  const as = int(v.racks_as_found), after = int(v.racks_after_ladder);
  const name = clean(v.binding_name, 120);
  if (as === null || after === null || !name) return null;
  return { racksAsFound: as, racksAfterLadder: after, bindingName: name, bindingBasis: clean(v.binding_basis) ?? "", scenario: clean(v.scenario_name, 120) ?? "" };
}

const rackWeaker = (a: string | null, b: string | null): string | null => (a && b ? (a < b ? a : b) : (a ?? b));

/**
 * The engine's /v1/diff answer reduced to what a reader is shown, field by field. Anything not named here (the engine's digests, prices, capex, its recorded
 * states beyond the figures below) is dropped. null: the answer is not in a form this page understands, and nothing is shown.
 */
export function shapeEngineDiff(raw: unknown, pathMaps: { from: Map<string, string>; to: Map<string, string> }): EngineDiffView | null {
  if (!isObj(raw)) return null;
  const headline = clean(raw.headline, 600);
  const racksDelta = int(raw.racks_delta), explained = int(raw.explained_racks), unexplained = int(raw.unexplained_racks);
  const before = envelope(raw.before), after = envelope(raw.after);
  if (!headline || racksDelta === null || explained === null || unexplained === null || !before || !after || !Array.isArray(raw.drivers) || typeof raw.binding_moved !== "boolean") return null;
  const recorded = (ep: string): string | null => pathMaps.to.get(ep) ?? pathMaps.from.get(ep) ?? null;
  const drivers: DriverView[] = [];
  for (const d of raw.drivers.slice(0, 60)) {
    if (!isObj(d)) return null;
    const ep = clean(d.path, 160), delta = int(d.racks_delta);
    if (!ep || delta === null) return null;
    drivers.push({
      path: recorded(ep), enginePath: ep, label: labelFor(ep), before: scalar(d.before), after: scalar(d.after),
      direction: delta > 0 ? "raises" : delta < 0 ? "lowers" : "no change", racksDelta: delta, flipsBindingTo: clean(d.flips_binding_to, 120), racksClass: classCode(d.racks_class),
    });
  }
  const bd = raw as Record<string, unknown>;
  const info = readDateBasis({ date_basis: bd.date_basis, date_evidence_class: bd.date_evidence_class, date_binding_item: bd.date_binding_item, date_label: bd.date_label });
  const weeksDelta = typeof bd.weeks_delta === "number" && Number.isFinite(bd.weeks_delta) ? bd.weeks_delta : null;
  const notAttributed = [...(Array.isArray(bd.unprobed_inputs) ? bd.unprobed_inputs : []), ...(Array.isArray(bd.unprobeable_inputs) ? bd.unprobeable_inputs : [])]
    .map((p) => clean(p, 160)).filter((p): p is string => p !== null).slice(0, 60).map((p) => recorded(p) ?? p);
  return {
    headline, material: raw.material === true, racksDelta, explainedRacks: explained, unexplainedRacks: unexplained, before, after, bindingMoved: raw.binding_moved,
    racksClass: rackWeaker(classCode(isObj(raw.before) ? raw.before.racks_class : null), classCode(isObj(raw.after) ? raw.after.racks_class : null)),
    drivers,
    weeks: { delta: info.showsNumber ? weeksDelta : null, basis: info.basis, evidenceClass: info.evidenceClass, bindingItem: info.bindingItem, label: info.label },
    inputs: clean(raw.inputs, 24) ?? "unknown",
    notAttributed,
  };
}

/** The class an answer may be given: the engine's, held down by any figure that carries no class. */
export function carryingClass(engineClass: string | null, ceiling: Comparison["ceiling"]): string | null {
  return ceiling ? (engineClass ? (engineClass < ceiling.cls ? engineClass : ceiling.cls) : ceiling.cls) : engineClass;
}

/** "raises the rack count by 4 (from 20 to 24)": a count is raised or lowered by a number, and no movement is graded. */
export function racksSentence(d: { racksDelta: number; before: { racksAfterLadder: number }; after: { racksAfterLadder: number } }, cls: string | null): string {
  const tail = cls ? `, carried by class ${cls}` : ", with no class stated by the engine";
  if (d.racksDelta === 0) return `Does not change the rack count (${d.after.racksAfterLadder})${tail}.`;
  return `${d.racksDelta > 0 ? "Raises" : "Lowers"} the rack count by ${Math.abs(d.racksDelta)} (from ${d.before.racksAfterLadder} to ${d.after.racksAfterLadder})${tail}.`;
}

/** What a point is called in an answer. */
export function pointLabel(p: PointSpec): string {
  return p.kind === "now" ? "the figures now" : p.kind === "asOf" ? `the record at the end of ${p.day} (UTC)` : "the figures with the pending import applied";
}
