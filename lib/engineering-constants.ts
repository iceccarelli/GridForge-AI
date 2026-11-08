// The engine's reserved engineering constants, in one typed place, for every page and machine file that states them.
//
// Where each value comes from:
//   * the numbers are read from lib/engineering-constants.json, a description of the engine, never a second source of it:
//     tests/test_engineering_constants.py runs the real loader, library and constraints in gridforge/ and fails if a number, a band or an
//     evidence class there differs, or if the engine starts to do something the text below says it does not do (a derating on the tap-off
//     rating, a climate-responsive PUE, a lead time above E0);
//   * the platform figures (feed current, flow per rack, rack power, liquid share) and the catalogue's indicative lead-time range are
//     passed in from the engine's published files (public/reference/platforms.json, constraints.json), never retyped here;
//   * this file contains no figure of its own: tests/site/engineering-constants.test.ts fails if a numeric literal appears in it.
//
// What it says is what the code does, with the class the engine labels it with. Where the code and a stated intention differ, the text
// says what the code does. Pure: no React, no fetch.

import data from "./engineering-constants.json";
import type { PlatformEntry } from "./constraints";

export const ENGINEERING_CONSTANTS = data;


const n = (v: number) => v.toLocaleString("en-IE");
const range = (r: readonly number[]) => `${n(r[0])}–${n(r[1])}`;
const weeks = (v: number) => `${n(v)} weeks`;
const eur = (v: number) => `${n(v)} EUR`;
const pct = (v: number) => `${n(Math.round(v * 100))}%`;
/** "E0 (assumed)": the class and the engine's own word for it (gridforge/validation/evidence.py). */
const CLASS_WORD: Record<string, string> = { E0: "assumed", E1: "modelled", E2: "simulated", E3: "estimated", E5: "supplied by the client" };
export const classWithWord = (c: string) => `${c} (${CLASS_WORD[c] ?? "see /evidence"})`;

/** What the library says about its feed currents (gridforge/compute/library.py): where one is derived from the rack's power it says so, and asks for an OEM drawing. */
const FEED_CURRENT_DERIVATION = `the library notes where a figure is derived from the rack's power at ${n(data.rack_feed.library_feed_voltage_V)} V three-phase, and asks for it to be confirmed against an OEM drawing`;

export type AssumptionId = "transformer_lead_time" | "rack_feed_check" | "hydraulic_flow" | "heat_rejection_and_pue";

export interface EngineeringAssumption {
  id: AssumptionId;
  title: string;
  /** The constraint ids (public/reference/constraints.json) whose page carries this assumption. */
  constraintIds: string[];
  /** The value in a few words, for a definition sentence. */
  headline: string;
  /** The value or formula, as the code uses it. */
  value: string;
  /** The class the engine labels it with, as a code ("E0"). */
  classCode: string;
  /** The same, in words, with anything that qualifies it. */
  evidenceClass: string;
  appliesWhere: string;
  overriddenBy: string;
  /** What the engine does not do, and the known open points. */
  notes: string[];
}

/** The engine's published data a statement may be built from. Each is optional: with none, the statement is made without the figures that would come from it. */
export interface PublishedInputs {
  platforms?: Pick<PlatformEntry, "id" | "name" | "rack_kW" | "liquid_fraction" | "flow_l_per_min_per_rack" | "rack_feed_current_A">[] | null;
  /** The constraint reference's indicative relief lead time for transformer capacity (a separate, published range). */
  transformerIndicativeRange?: { low: number; high: number } | null;
}

/** dT = P x 60 / (Q x rho x cp), the heat balance behind a flow (gridforge/thermal/library.py implied_delta_T_K). */
export function impliedDeltaTK(heatKW: number, flowLPerMin: number): number {
  const h = data.hydraulic_flow;
  return flowLPerMin > 0 ? (heatKW * 60) / (flowLPerMin * h.water_density_kg_per_l * h.water_cp_kJ_per_kg_K) : 0;
}

/** The flow per kW that a heat balance gives at the reference temperature rise (the engine's reference constant is a rounded form of it). */
export function physicsFlowPerKW(): number {
  const h = data.hydraulic_flow;
  return 60 / (h.water_density_kg_per_l * h.water_cp_kJ_per_kg_K * h.screening_delta_T_K);
}

const oneDecimal = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-IE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const threeDecimals = (v: number) => v.toLocaleString("en-IE", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const twoDecimals = (v: number) => v.toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// --- 1. the transformer lead-time default -------------------------------------------------------------------------------------------------
function transformerLeadTime(p: PublishedInputs): EngineeringAssumption {
  const t = data.transformer_lead_time;
  const published = p.transformerIndicativeRange;
  return {
    id: "transformer_lead_time",
    title: "The transformer replacement lead time",
    constraintIds: ["transformer_capacity"],
    headline: `${weeks(t.default_weeks)}, band ${range(t.default_band_weeks)} weeks, when no lead time is supplied`,
    value: `${weeks(t.default_weeks)}, band ${range(t.default_band_weeks)} weeks`,
    classCode: t.default_class,
    evidenceClass: classWithWord(t.default_class),
    appliesWhere:
      "The library placeholder for the lead time of replacing or uprating the HV/MV transformer bank, used when the intake gives no transformer replacement lead time. " +
      "The loader records it as a gap, not as something the client said, and the slowest bank sets the date. The same figure is the fallback inside the transformer constraint when no bank is declared.",
    overriddenBy:
      `A lead time typed into the intake replaces it. It is used as typed, with a band of ±${pct(t.supplied_band_fraction)} around the typed value, and is labelled customer-supplied (unverified). ` +
      `It stays class ${t.supplied_class}: the engine has no way to check a figure against a written manufacturer or DSO quotation, so neither a typed lead time nor a quotation raises a lead time above ${t.supplied_class} today.`,
    notes: [
      `A time-to-power figure that rests on this lead time is labelled "assumed lead time, not a date" with class ${t.default_class}, and is never shown without that label.`,
      "This is a library assumption. It is not a market figure and not derived from press or analyst reporting; the market-evidence register keeps its own, separate entry for reported transformer lead times, which is unverified and is not shown on any page.",
      published
        ? `The constraint reference publishes a different, indicative relief lead time for transformer capacity (${published.low}–${published.high} weeks, European retrofits). It is a catalogue range; the engine's own default carries the band above.`
        : "The constraint reference publishes a separate indicative relief lead time range for transformer capacity; it is a catalogue range, not this default.",
    ],
  };
}

// --- 2. the rack-feed (tap-off) check ------------------------------------------------------------------------------------------------------
function rackFeed(p: PublishedInputs): EngineeringAssumption {
  const r = data.rack_feed;
  const withFeed = (p.platforms ?? []).filter((x) => typeof x.rack_feed_current_A === "number");
  const library = withFeed.length
    ? ` Library feed current per rack: ${withFeed.map((x) => `${x.name}: ${n(x.rack_feed_current_A as number)} A`).join("; ")} (each class ${r.library_feed_current_class}, band ±${pct(r.library_feed_current_band_fraction)}, ${FEED_CURRENT_DERIVATION}).`
    : "";
  return {
    id: "rack_feed_check",
    title: "The tap-off rating check",
    constraintIds: ["rack_feed_tapoff"],
    headline: `a comparison of the rack's required current with the stated rating at ${pct(r.rating_fraction_compared)}, with no continuous-load derating`,
    value:
      `A current comparison, not a power formula: required current (A) = the platform's library feed current at ${n(r.library_feed_voltage_V)} V three-phase × (${n(r.library_feed_voltage_V)} V ÷ the hall's busway voltage), ` +
      `times √3 again when the feed is single-phase. The rack can be fed when the required current is no more than the installed tap-off rating (A), compared at ${pct(r.rating_fraction_compared)} of the rating.` +
      library,
    classCode: r.library_feed_current_class,
    evidenceClass: classWithWord(r.library_feed_current_class),
    appliesWhere:
      "The rack feed gate: a hall whose installed tap-offs are rated below what one rack draws fits no rack, whatever else is true. It binds at the first rack, not at scale.",
    overriddenBy:
      `The installed tap-off rating, the busway voltage and the phase count come from the intake and carry class ${r.installed_tapoff_supplied_class} as supplied (the client's figure, not checked by us). ` +
      `When they are absent the library assumes a ${n(r.installed_tapoff_default_A)} A tap-off (band ${range(r.installed_tapoff_default_band_A)} A) and ${n(r.voltage_default_V)} V, both class E0, and records each as a gap. ` +
      "The platform's feed current has no intake field: it is the library figure for the platform chosen. A relief that buys higher-rated tap-offs is priced from the cost library, and an accepted supplier quotation for that line replaces the library price.",
    notes: [
      `No continuous-load derating factor is applied to the tap-off rating: the engine uses the stated rating, at ${pct(r.rating_fraction_compared)}, without a derating for continuous load, ambient temperature or grouping. This is a known open point, not a settled position.`,
      `The only derating in the electrical chain is the busway's own utilisation limit (default ${r.busway_utilisation_default}, class E0, or the figure the client gives), which scales busway capacity, not tap-off ratings. Busway capacity per run is (√3 for three-phase, 1 for single-phase) × voltage × installed ampacity × that utilisation limit × the site power factor ÷ 1,000 kW.`,
      `The site power factor (default ${r.site_power_factor_default}, band ${range(r.site_power_factor_default_band)}, class E0 when absent; ${r.site_power_factor_supplied_class} when supplied) enters the busway capacity, the transformer capacity and the grid conversion from MVA to MW. It does not enter the tap-off check.`,
      `The relief assumes tap-offs of ${n(r.relief_tapoff_A)} A (kept as declared where the installed rating is already at least that), at ${eur(r.relief_cost_eur_per_rack)} per rack and ${weeks(r.relief_lead_weeks)} (band ${range(r.relief_lead_band_weeks)} weeks), all class ${r.relief_tapoff_class}.`,
    ],
  };
}

// --- 3. hydraulic flow ----------------------------------------------------------------------------------------------------------------------
function hydraulicFlow(p: PublishedInputs): EngineeringAssumption {
  const h = data.hydraulic_flow;
  const plats = (p.platforms ?? []).filter((x) => x.rack_kW > 0 && x.flow_l_per_min_per_rack > 0);
  const perKw = plats.length
    ? ` Library flow per rack: ${plats
        .map((x) => `${x.name}: ${n(x.flow_l_per_min_per_rack)} l/min (${threeDecimals(x.flow_l_per_min_per_rack / x.rack_kW)} l/min per kW of rack power, implying a ${oneDecimal(impliedDeltaTK(x.rack_kW * x.liquid_fraction, x.flow_l_per_min_per_rack))} K rise on the liquid-captured heat)`)
        .join("; ")}.`
    : "";
  return {
    id: "hydraulic_flow",
    title: "The pumped-flow limit on liquid-cooled racks",
    constraintIds: ["hydraulic_flow"],
    headline: "whole racks of pumped flow divided by the platform's library flow per rack, with no pipework or pump-head model",
    value:
      "Racks permitted = whole racks of (the plant's pumped flow, less the flow the existing hall already draws when that is given) ÷ the platform's library flow per rack, in l/min. The retained-air architecture has no liquid circuit and is not limited by it." +
      perKw,
    classCode: h.result_class,
    evidenceClass: `${classWithWord(h.result_class)} for the rack count; the step itself is capped at ${h.step_class_cap}`,
    appliesWhere:
      "Every architecture with a liquid circuit, rear-door heat exchangers included, as one of the engine's constraints. It is a comparison of two flows: it does not model pipework resistance, pump head or the plant's own temperature rise.",
    overriddenBy:
      `The pumped flow is the client's figure (${h.pump_flow_supplied_class} as supplied: pump curves and a pipe schedule are the evidence asked for); when absent the library assumes ${n(h.pump_flow_default_l_per_min)} l/min at class E0. ` +
      `The flow per rack is the library's for the platform chosen, with a band, and has no intake field, so the rack count is ${h.result_class} whatever the pumped-flow evidence is. ` +
      `Even with every input at a firmer class, the code caps this step at ${h.step_class_cap}, and no pipework or pump-head model sits behind it.`,
    notes: [
      "A pump curve without the pipework resistance does not establish how much flow the loop delivers. The engine does not model pressure drop, pipe size or available head at screening level, and says a hydraulic model is required before design.",
      `The ${twoDecimals(h.screening_flow_l_per_min_per_kW)} l/min per kW constant (a ${n(h.screening_delta_T_K)} K rise, band ${range(h.screening_flow_band_l_per_min_per_kW)}, class E0) is a documented reference only: no constraint uses it. A heat balance at ${n(h.screening_delta_T_K)} K gives ${twoDecimals(physicsFlowPerKW())} l/min per kW.`,
      "The library's own descriptions of liquid flow do not agree: the platform figures above imply a larger temperature rise than the reference constant, and the constraint follows the platform figures. They are held as assumptions with bands, and should be read that way.",
      `The relief uprates pumps and secondary pipework by a factor of ${h.pump_uprate_factor} on the pumped flow, priced per l/min added from a library placeholder (${eur(h.relief_cost_reference_eur)} for ${n(h.relief_cost_reference_l_per_min)} l/min added), at ${weeks(h.relief_lead_weeks)} (band ${range(h.relief_lead_band_weeks)} weeks), class E0.`,
    ],
  };
}

// --- 4. trim chillers, dry coolers, adiabatic assist and PUE ---------------------------------------------------------------------------------
function heatRejection(): EngineeringAssumption {
  const x = data.heat_rejection;
  const pue = x.pue_by_architecture;
  const arch: [string, keyof typeof pue][] = [
    ["retained air", "retained_air"],
    ["rear-door heat exchanger", "rdhx"],
    ["hybrid direct-to-chip", "hybrid_dlc"],
    ["full direct-to-chip", "full_dlc"],
  ];
  const cb = data.cost_basis_classes;
  const lump = data.cost_band_factor_by_class[x.trim_chiller_class as "E0"];
  return {
    id: "heat_rejection_and_pue",
    title: "The trim-chiller and PUE treatment",
    constraintIds: ["tcs_supply_achievable", "plant_capacity"],
    headline: `a flat ${eur(x.trim_chiller_eur)} trim-chiller lump and a fixed PUE for each cooling architecture, neither responding to the climate`,
    value:
      `Adiabatic assist plus trim chiller: one fixed lump of ${eur(x.trim_chiller_eur)} per hall (band ${range([lump[0] * x.trim_chiller_eur, lump[1] * x.trim_chiller_eur])} EUR), ${weeks(x.trim_chiller_lead_weeks)} (band ${range(x.trim_chiller_lead_band_weeks)} weeks). ` +
      `Taking it sets a dry-cooler approach of ${n(x.dry_cooler_approach_K)} K (band ${range(x.dry_cooler_approach_band_K)} K), unless the hall's is already lower. ` +
      `Chilled-water plant uprate: +${pct(x.plant_uprate_factor - 1)} of capacity, priced at ${eur(x.plant_uprate_cost_reference_eur)} for ${n(x.plant_uprate_cost_reference_kW)} kW added, ${weeks(x.plant_uprate_lead_weeks)} (band ${range(x.plant_uprate_lead_band_weeks)} weeks). ` +
      `PUE by architecture: ${arch.map(([label, k]) => `${label} ${twoDecimals(pue[k].value)} (band ${twoDecimals(pue[k].band[0])}–${twoDecimals(pue[k].band[1])})`).join("; ")}.`,
    classCode: x.trim_chiller_class,
    evidenceClass: `${classWithWord(x.trim_chiller_class)}: a library default (a published benchmark would be ${cb.published_benchmark}; none is in the bundled library)`,
    appliesWhere:
      "The achievable-water-temperature gate: when the facility water the plant or the dry coolers can supply is warmer than the cold-plate loop needs, this relief is the one that clears it. The design dry-bulb decides whether the gate passes; it does not change the relief's price, lead time or the PUE.",
    overriddenBy:
      `A supplier quotation entered as accepted cost evidence (a firm_quote, class ${cb.firm_quote}) replaces the library price for that line when it carries a validity date and has not expired; without a validity date it is held at ${data.firm_quote_without_validity_class}, and an expired quotation is ignored. ` +
      `A budgetary quote is class ${cb.budgetary_quote}. The quotation changes the cost, not the PUE: no intake field overrides the PUE, which is the library figure for the architecture (the sensitivity analysis varies it).`,
    notes: [
      "The trim chiller is a flat lump: the price is not scaled with hall size or with the heat it must reject, and no trim-chiller power is added. Dry coolers have no cost line of their own; they enter only as the approach temperature used for the achievable water temperature.",
      "PUE is a fixed library figure for the cooling architecture. It is not recomputed for the site's climate, free-cooling hours, the achievable water temperature or any chiller's power, so the IT headroom it divides into is not climate-adjusted. The bands are the only allowance for climate.",
      "Water use by adiabatic assist is not modelled; the relief carries a note to check permits and water-use targets.",
    ],
  };
}

/** Every reserved engineering assumption, in the order a reader meets them. */
export function engineeringAssumptions(published: PublishedInputs = {}): EngineeringAssumption[] {
  return [transformerLeadTime(published), rackFeed(published), hydraulicFlow(published), heatRejection()];
}

/** The assumptions whose constraint is this one. */
export function assumptionsForConstraint(constraintId: string, published: PublishedInputs = {}): EngineeringAssumption[] {
  return engineeringAssumptions(published).filter((a) => a.constraintIds.includes(constraintId));
}

/** The one sentence that keeps the engine's labelled library assumption apart from reported market figures. Read by the market-evidence register. */
export function transformerDefaultIsNotMarketEvidence(): string {
  const t = data.transformer_lead_time;
  return (
    `The engine's own default of ${weeks(t.default_weeks)} (band ${range(t.default_band_weeks)} weeks, class ${t.default_class}) is a labelled library assumption. ` +
    "It is not derived from this reporting and is not supported by it, and this reporting is not shown on any page."
  );
}

/** The engine's evidence classes for a lead time that a reader might take for a stronger one. */
export const LEAD_TIME_SOURCE_LABELS = {
  customer_supplied_unverified: "customer-supplied (unverified)",
  library_placeholder: "library placeholder",
  missing: "missing",
  not_determined: "source not determined",
} as const;
