/**
 * Which relief a Procurement Specification is written for.
 *
 * The engine (`POST /v1/spec`, gridforge/procurement/build.py `build_spec`) takes an optional `constraint`: the id of the
 * constraint whose relief the specification tenders. Left out, the engine picks one itself (`default_step`). The buyer
 * could not choose; this is the vocabulary they choose from.
 *
 * The ids and names are the engine's own constraint registry (gridforge/reference/catalogue.py), mirrored here as a literal
 * because the intake form is a client component and cannot read the filesystem. tests/site/spec-relief.test.ts fails if this
 * list drifts from public/reference/constraints.json, which `gridforge reference` generates from that registry and CI guards.
 *
 * Whether a given hall HAS a purchasable relief for a given id is the engine's call (it answers 422 naming what is
 * available for that hall); this list only says which ids exist.
 */

export const SPEC_RELIEF_CONSTRAINTS = [
  { id: "rack_feed_tapoff", name: "Rack feed / tap-off rating" },
  { id: "busway_ampacity", name: "Busway ampacity" },
  { id: "transformer_capacity", name: "Transformer capacity" },
  { id: "ups_capacity", name: "UPS capacity (protected load)" },
  { id: "grid_firm_capacity", name: "Firm supply (grid import and behind-the-meter)" },
  { id: "plant_capacity", name: "Chilled-water plant capacity" },
  { id: "cdu_capacity", name: "CDU capacity at site conditions" },
  { id: "hydraulic_flow", name: "Hydraulic flow capacity" },
  { id: "tcs_supply_achievable", name: "Achievable facility water temperature" },
  { id: "residual_air_removal", name: "Residual air load removal per rack" },
  { id: "architecture_capability", name: "Cooling architecture per-rack capability" },
  { id: "floor_space", name: "Available rack positions" },
  { id: "floor_loading", name: "Floor loading" },
] as const;

export type SpecReliefId = (typeof SPEC_RELIEF_CONSTRAINTS)[number]["id"];

export const SPEC_RELIEF_IDS: readonly string[] = SPEC_RELIEF_CONSTRAINTS.map((c) => c.id);

/** The only product a relief choice applies to. */
export const SPEC_RELIEF_KIND = "procurement_spec";

export type ParsedRelief = { ok: true; constraint: SpecReliefId | null } | { ok: false; error: string };

/**
 * Validate the buyer's optional choice. Absent (undefined, null or an empty string) is "let the engine choose", which is
 * exactly what the product did before the choice existed. Anything else must be one of the engine's constraint ids, exactly;
 * an unknown value is refused, naming the valid ones, and is never passed through.
 */
export function parseSpecRelief(value: unknown): ParsedRelief {
  if (value === undefined || value === null) return { ok: true, constraint: null };
  if (typeof value !== "string") {
    return { ok: false, error: `The relief must be one of: ${SPEC_RELIEF_IDS.join(", ")}.` };
  }
  const v = value.trim();
  if (v === "") return { ok: true, constraint: null };
  if ((SPEC_RELIEF_IDS as readonly string[]).includes(v)) return { ok: true, constraint: v as SpecReliefId };
  return {
    ok: false,
    error: `Unknown relief ${JSON.stringify(v.slice(0, 60))}. Valid reliefs: ${SPEC_RELIEF_IDS.join(", ")}.`,
  };
}

/** The buyer-facing name of a constraint id, or null when it is not one of the engine's. */
export function specReliefName(id: string | null | undefined): string | null {
  return SPEC_RELIEF_CONSTRAINTS.find((c) => c.id === id)?.name ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What evidence could move the binding limit.
//
// For a project whose saved Time-to-Power comparison names a binding limit, this says which inputs that limit rests on, what class the
// engine gave each, which document would back it, the review steps the product really has, and what the document would not prove.
//
// It is deterministic and derived from what the project already stores: the saved request (which inputs were supplied, and whether any was
// declared assumed) and the saved result (which limit binds as found and after relief). No network call, no model, no estimate of a gain.
// It never says a better-evidenced figure WILL raise capacity: the engine decides, and a documented figure can be worse than the assumed one.
//
// Each input's document is the engine's own text for it (`how_to_get_it` in gridforge/intake/schema.py), and its supplied class is the
// engine's (`supplied_evidence` there); tests/site/evidence-ladder.test.ts fails if either drifts.
// ---------------------------------------------------------------------------------------------------------------------------------

import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { EVIDENCE_MAX_BYTES } from "@/lib/project-evidence-upload";

export interface LadderInputDef {
  /** The dotted path in the engine's intake document. */
  path: string;
  label: string;
  /** The class the engine gives a figure supplied for this input: E5 (customer data) or E3 (an estimate-class figure). */
  suppliedClass: "E3" | "E5";
  /** The document that would back the figure, in the engine's own words. */
  document: string;
  /** What that document would not establish. */
  notProved: string;
}

const D = (path: string, label: string, suppliedClass: "E3" | "E5", document: string, notProved: string): LadderInputDef => ({
  path, label, suppliedClass, document, notProved,
});

/**
 * The inputs behind each constraint family, limited to the ones a saved comparison can carry (lib/ttp-compare.ts toIntakeDocument).
 * The number of busway runs, the LV voltage and the power factor are left out on purpose: the site sends 6 runs, 400 V and 0.97 for every
 * request whether or not the visitor knows them, so a saved request cannot say whether they were supplied. The CDU schedule and the
 * architecture's own capability have no input a saved comparison carries.
 */
export const LADDER_FAMILIES: Partial<Record<SpecReliefId, readonly LadderInputDef[]>> = {
  rack_feed_tapoff: [
    D("lv.tapoff_max_A", "Installed tap-off rating", "E5", "Tap-off unit nameplate.",
      "the rack-side cord or PDU rating, or that every installed unit matches the nameplate read. The current the platform needs per rack is the engine's library figure for that platform, not a reading from this hall"),
  ],
  busway_ampacity: [
    D("lv.busway_ampacity_A", "Installed busway ampacity", "E5", "Busway nameplate or the electrical record drawings.",
      "how much of the busway is already loaded (the engine subtracts that only when it is declared), or that the nameplate rating holds at the hall's ambient and grouping"),
  ],
  transformer_capacity: [
    D("transformers", "Transformer schedule", "E5", "Single-line diagram and transformer nameplates.",
      "the transformers' condition or loading history, or a replacement lead time (a lead time needs the manufacturer's or utility's written figure)"),
  ],
  ups_capacity: [
    D("ups", "UPS schedule", "E5", "UPS nameplate, topology and remaining design life.",
      "how the UPS blocks respond to the step loads of GPU racks"),
  ],
  grid_firm_capacity: [
    D("grid.firm_capacity_MVA", "Firm connection capacity", "E5", "Connection agreement with the DSO.",
      "that the capacity is free for new load today, or when any reinforcement could be energised (the engine does not date grid reinforcement)"),
    D("grid.contracted_MW", "Contracted capacity", "E5", "Supply contract.",
      "the connection's physical headroom or the site's future demand"),
    D("grid.current_site_peak_MW", "Current site peak demand", "E5", "12 months of half-hourly metered data.",
      "next year's peak, or the hall's own share of the site's load"),
  ],
  plant_capacity: [
    D("thermal.plant.chilled_water_capacity_kW", "Chilled-water plant capacity", "E5", "Chiller schedule; derate to the actual condensing conditions.",
      "the capacity the plant delivers at the hall's real condensing conditions, or its redundancy"),
    D("thermal.plant.existing_non_it_heat_kW", "Other heat the existing hall already puts on the plant", "E3",
      "BMS plant load trend less the metered IT load, or the electrical single-line losses and the mechanical schedule's fan and pump power.",
      "the plant's worst case or its future load: a trend covers only the period it was taken over"),
  ],
  hydraulic_flow: [
    D("thermal.plant.pump_flow_capacity_l_per_min", "Available pumped flow", "E3", "Pump curves and pipe schedule; a hydraulic model before design.",
      "the flow at the system's real resistance after the retrofit: pump curves show what a pump can move, not what the pipework passes"),
    D("thermal.plant.existing_flow_l_per_min", "Flow the existing hall already draws on the plant", "E3",
      "Commissioning flow readings or the BMS flow trend for the existing hall's loops; pump curves at the operating point.",
      "the flow the existing loops need at full load: readings show the flow at the times they were taken"),
  ],
  tcs_supply_achievable: [
    D("thermal.plant.design_supply_C", "Plant supply temperature", "E5", "BMS setpoint and 12 months of trend.",
      "that the plant can hold the setpoint in the site's hottest hours: a setpoint is what the plant is told to hold"),
    D("site.design_drybulb_C", "Summer design dry bulb", "E3", "Nearest TMY station.",
      "conditions at this site: a weather-station value is a climate basis, and it says nothing about how the heat-rejection plant performs"),
  ],
  residual_air_removal: [
    D("thermal.residual_air_capacity_kW_per_rack", "Air removal per rack position", "E3", "Measured per-tile airflow, or CFD.",
      "that the figure holds as the hall fills: a measurement covers the tiles measured and CFD is a model"),
  ],
  floor_space: [
    D("hall.positions_available", "Rack positions available", "E5", "Floor plan plus the tenancy schedule.",
      "that tenants will release the positions"),
  ],
  floor_loading: [
    D("hall.floor_loading_kPa", "Hall design floor loading", "E5", "Structural record drawings; a survey if the building changed hands.",
      "the floor as it stands today: a design value from drawings is not a survey"),
  ],
};

/** Every path the ladder reads from a saved request. */
export const LADDER_PATHS: readonly string[] = Object.values(LADDER_FAMILIES).flatMap((defs) => (defs ?? []).map((d) => d.path));

/** What a saved request says about one input. */
export interface LadderInputState {
  path: string;
  /** The request carries a figure for it. */
  supplied: boolean;
  /** The class the request declared for it (for example E0 for a reference-template value), or null when it declared none. */
  declared: string | null;
}

/** What the project's latest saved comparison says, reduced to what the ladder needs. */
export interface LadderBasis {
  /** The scenario the ladder speaks about: the one the comparison ranked first, else its baseline, else its first. */
  scenario: string;
  /** The constraint that binds as found, and the one that binds after the engine's relief steps; null when the engine named none. */
  bindsNow: string | null;
  bindsNext: string | null;
  inputs: LadderInputState[];
}

const EVIDENCE_CODE = /^E([0-7])(?![0-9])/;

function readPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function inputState(intake: unknown, path: string): LadderInputState {
  const raw = readPath(intake, path);
  if (path === "transformers" || path === "ups") return { path, supplied: Array.isArray(raw) && raw.length > 0, declared: null };
  if (typeof raw === "number") return { path, supplied: Number.isFinite(raw), declared: null };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const declared = typeof o.evidence === "string" ? (EVIDENCE_CODE.exec(o.evidence.trim().toUpperCase())?.[0] ?? null) : null;
    return { path, supplied: typeof o.value === "number" && Number.isFinite(o.value), declared };
  }
  return { path, supplied: false, declared: null };
}

interface SavedScenario {
  id?: unknown;
  name?: unknown;
  as_found?: { binding?: unknown };
  after_ladder?: { binding?: unknown };
}

/**
 * Reduce a stored comparison (the request the engine was sent, and the engine's answer) to a LadderBasis, or null when the stored shape
 * is not one this reads. Reads only; never throws on a malformed row.
 */
export function ladderBasisFromComparison(request: unknown, result: unknown): LadderBasis | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { scenarios?: unknown; ranking?: { leader?: unknown }; baseline?: unknown };
  const scenarios = Array.isArray(r.scenarios) ? (r.scenarios as SavedScenario[]) : [];
  if (scenarios.length === 0) return null;
  const pick =
    scenarios.find((s) => s.id === r.ranking?.leader) ?? scenarios.find((s) => s.id === r.baseline) ?? scenarios[0];
  const id = (v: unknown) => (typeof v === "string" && v ? v : null);
  const intake = request && typeof request === "object" ? (request as { intake?: unknown }).intake : undefined;
  return {
    scenario: id(pick.name) ?? id(pick.id) ?? "the first scenario",
    bindsNow: id(pick.as_found?.binding),
    bindsNext: id(pick.after_ladder?.binding),
    inputs: LADDER_PATHS.map((p) => inputState(intake, p)),
  };
}

/** The files the project holds, as ProjectState counts them. */
export interface LadderFiles {
  total: number;
  verified: number;
  unverified: number;
  rejected: number;
}

export type LadderRowState = "not_supplied" | "assumed" | "estimated" | "stated";

export interface LadderRow {
  path: string;
  label: string;
  /** The class the engine has for it in the saved comparison. */
  classNow: string;
  state: LadderRowState;
  stateText: string;
  /** What the engine would class a figure you enter for it. */
  classIfEntered: { code: string; verb: string };
  document: string;
  notProved: string;
}

export interface LadderRung {
  constraint: string;
  constraintName: string;
  role: "binds_now" | "binds_next";
  rows: LadderRow[];
}

export interface LadderUnevaluated {
  path: string;
  label: string;
  text: string;
}

export type LadderStatus = "no_comparison" | "no_limit" | "no_inputs" | "all_stated" | "has_assumed";

export interface EvidenceLadder {
  status: LadderStatus;
  scenario: string | null;
  /** The limits the saved comparison names for this scenario, with or without inputs this page can speak to. */
  named: { constraint: string; constraintName: string; role: LadderRung["role"] }[];
  rungs: LadderRung[];
  /** Limits the engine could not evaluate for want of a schedule; they cannot be named as binding, and may be. */
  unevaluated: LadderUnevaluated[];
  /** Review steps the product really has, in order. */
  steps: string[];
  /** What the project's files say, in words. */
  fileLine: string;
  /** What no document on this ladder establishes. */
  limits: string[];
}

const verbOf = (code: string) => EVIDENCE_CLASSES.find((c) => c.code === code)?.verb ?? code;
const mb = EVIDENCE_MAX_BYTES / (1024 * 1024);

/** The review steps that exist in the product today (components/ai/EvidenceUpload.tsx, lib/project-evidence-review.ts, migration 0048). */
export const LADDER_STEPS: readonly string[] = [
  `Attach the document to this project with "Attach file" in the Evidence card (PDF, CSV or JSON, up to ${mb} MB, with a category). It is stored unverified and unclassified.`,
  "A GridForge administrator reviews the file. The server reads the stored file back and computes its SHA-256; the database refuses a verification if that differs from the digest recorded at upload. The decision (verified or rejected, with the reviewer's name and a reason) is recorded once and cannot be changed. The reviewer's name is typed text under a shared admin password, not an authenticated identity, and the reviewer judges provenance and relevance, which the server does not inspect.",
  "Enter the figure from the document in the hall form and run the comparison again, then save it to this project. The project record does not link a file to an individual input, and a verified file does not rewrite a saved comparison.",
];

export const LADDER_LIMITS: readonly string[] = [
  "A verified file means the stored bytes are unchanged since upload and that a reviewer judged them relevant. It does not make the engine's output calibrated: the calibration ledger holds no approved production records.",
  "A figure from a document may relax the limit, leave it as it is, or tighten it. The engine decides; this page does not estimate a gain.",
];

function fileLine(f: LadderFiles): string {
  if (f.total === 0) return "No file is attached to this project yet.";
  const parts: string[] = [];
  if (f.verified > 0) parts.push(`${f.verified} verified`);
  if (f.unverified > 0) parts.push(`${f.unverified} awaiting review`);
  if (f.rejected > 0) parts.push(`${f.rejected} rejected`);
  const lead = `Files on this project: ${parts.join(", ")}.`;
  return f.verified > 0
    ? `${lead} The record does not say which input a file supports, so a verified file changes no class on this page by itself.`
    : lead;
}

function rowFor(def: LadderInputDef, st: LadderInputState | undefined): LadderRow {
  const ifEntered = { code: def.suppliedClass, verb: verbOf(def.suppliedClass) };
  const base = { path: def.path, label: def.label, classIfEntered: ifEntered, document: def.document, notProved: def.notProved };
  if (!st || !st.supplied) {
    return { ...base, classNow: "E0", state: "not_supplied", stateText: "Not supplied: the engine used its own library placeholder (E0, assumed)." };
  }
  if (st.declared !== null) {
    const n = Number(st.declared.slice(1));
    if (n <= 3) return { ...base, classNow: st.declared, state: "assumed", stateText: `Supplied and declared ${st.declared} (${verbOf(st.declared)}).` };
    return { ...base, classNow: st.declared, state: "stated", stateText: `Supplied and declared ${st.declared} (${verbOf(st.declared)}).` };
  }
  if (def.suppliedClass === "E3") {
    return { ...base, classNow: "E3", state: "estimated", stateText: "Supplied; the engine classes this kind of figure E3 (estimated) even when supplied." };
  }
  return {
    ...base,
    classNow: "E5",
    state: "stated",
    stateText: "Supplied as customer data (E5): stated, not measured or surveyed by us, and no document is linked to it in this record.",
  };
}

const UNEVALUATED: Record<string, string> = {
  transformers:
    "No transformer schedule was supplied, so the engine did not evaluate transformer capacity. Its own warning: it \"may be the true binding constraint\".",
  ups: "No UPS schedule was supplied, so the engine treated the load as unprotected and had no UPS limit to evaluate.",
};

/**
 * The ladder for one project. Pure: the same basis and files always give the same ladder.
 *
 * `basis` is null when the project has no saved comparison. A row is "assumed" when its class is E3 or lower (not supplied, declared
 * E0..E3, or an estimate-class figure) and "stated" when the engine holds it as customer data or better; only the first kind asks for a
 * document before the limit can be read as firm. Nothing here is computed from a number: it reads classes, never values.
 */
export function evidenceLadder(basis: LadderBasis | null, files: LadderFiles): EvidenceLadder {
  const common = { steps: [...LADDER_STEPS], fileLine: fileLine(files), limits: [...LADDER_LIMITS] };
  if (!basis) return { status: "no_comparison", scenario: null, named: [], rungs: [], unevaluated: [], ...common };
  const byPath = new Map(basis.inputs.map((i) => [i.path, i]));

  const unevaluated: LadderUnevaluated[] = (["transformers", "ups"] as const).flatMap((path) => {
    const def = Object.values(LADDER_FAMILIES).flatMap((d) => d ?? []).find((d) => d.path === path)!;
    return byPath.get(path)?.supplied ? [] : [{ path, label: def.label, text: UNEVALUATED[path] }];
  });

  const wanted: [string | null, LadderRung["role"]][] = [[basis.bindsNow, "binds_now"], [basis.bindsNext, "binds_next"]];
  const rungs: LadderRung[] = [];
  const named: EvidenceLadder["named"] = [];
  for (const [id, role] of wanted) {
    if (!id) continue;
    // The same limit can bind now and after relief; it is listed once, as the one binding now.
    if (named.some((n) => n.constraint === id)) continue;
    named.push({ constraint: id, constraintName: specReliefName(id) ?? id, role });
    const defs = LADDER_FAMILIES[id as SpecReliefId];
    if (!defs) continue;
    const rows = defs.map((d) => rowFor(d, byPath.get(d.path)));
    // Inputs that still need a document come first.
    rows.sort((a, b) => Number(a.state === "stated") - Number(b.state === "stated"));
    rungs.push({ constraint: id, constraintName: specReliefName(id) ?? id, role, rows });
  }

  let status: LadderStatus;
  if (!basis.bindsNow && !basis.bindsNext) status = "no_limit";
  else if (rungs.length === 0) status = "no_inputs";
  else status = rungs.some((r) => r.rows.some((x) => x.state !== "stated")) ? "has_assumed" : "all_stated";
  return { status, scenario: basis.scenario, named, rungs, unevaluated, ...common };
}
