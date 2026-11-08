// Reference intake TEMPLATES for the scenario comparison: three archetypal brownfield halls, as input values only.
//
// What a template is: a starting set of hall figures so a visitor can see the comparison work before they have gathered their own. It is
// not a customer's hall, it is not a measurement, and it holds no result. Nothing here says what the engine will answer: the engine
// solves whatever is run (POST /v1/compare), and the answer is shown only after it has been produced. tests/site/hall-presets.test.ts
// validates every template against the real intake schema and runs each one through the real engine, asserting that it is solved or
// refused with a named field.
//
// Every numeric value in a template is ASSUMED. When one is sent, the request lists it in `assumed_fields` and lib/ttp-compare.ts marks it
// E0 (assumed) on the request: the marking is made by this site and recorded in the saved request. The comparison result itself carries no
// per-input classes (the Density Screen's basis text does, and shows "(E0)" for a marked figure), and the marking changes only the request
// digest, never an arithmetic result. A value the visitor changes is theirs from that moment and is no longer marked. The identity fields
// (site name, hall id) are labels, not values, and are not marked.
//
// Busway runs, LV voltage and site power factor are deliberately NOT template values. A template that carried "6 runs / 400 V / 0.97" would
// have to send them as E0 (assumed) figures, and a template that did not mark them would send them as the visitor's own. Leaving them out
// means a template run omits them, the engine uses its documented library defaults (lib/engagement-intake.ts ENGINE_LIBRARY_DEFAULTS) and names
// each as an assumption. If a template ever defines one, it must be added to PRESET_VALUE_KEYS and to ASSUMABLE_HALL_FIELDS so it is sent as E0.

import type { CompareObjective } from "@/lib/ttp-compare";

/** The disclosure shown with every template, and kept while any value is edited. */
export const PRESET_DISCLOSURE = "Reference template — synthetic, replace with your hall's figures";

/** The class the engine is told about every template value (the evidence class for "assumed"). */
export const PRESET_VALUE_CLASS = "E0";

/** The hall form's numeric fields a template sets, in the order the form shows them. */
export const PRESET_VALUE_KEYS = [
  "contractedMW",
  "currentPeakMW",
  "currentItLoadMW",
  "buswayAmpacityA",
  "tapoffMaxA",
  "positionsAvailable",
  "plantSupplyC",
  "firmCapacityMVA",
  "floorLoadingKPa",
  "plantCapacityKW",
  "pumpFlowLPerMin",
  "existingNonItHeatKW",
  "designDrybulbC",
  "residualAirKWPerRack",
] as const;
export type PresetValueKey = (typeof PRESET_VALUE_KEYS)[number];

export interface PresetSupplyOption {
  id: string;
  kind: "gas_engine" | "chp" | "fuel_cell" | "bess";
  capacity_MW: string;
  lead_time_weeks: string;
  capex_eur_per_kW: string;
  energy_MWh: string;
}

export interface HallPreset {
  id: string;
  /** What the visitor picks. */
  name: string;
  /** The shape of the inputs, in one sentence. A description of what was typed in, never a statement of what the engine will find. */
  shape: string;
  siteName: string;
  hallId: string;
  platform: "gb300_nvl72" | "gb200_nvl72" | "generic_dlc_50";
  objective: CompareObjective;
  values: Record<PresetValueKey, string>;
  /** On-site supply candidates. The engine already treats these as declared candidates (assumed), whatever the visitor types. */
  supply: PresetSupplyOption[];
}

export const HALL_PRESETS: readonly HallPreset[] = [
  {
    id: "legacy_air_to_dlc",
    name: "Legacy air-cooled enterprise hall → liquid-cooled AI retrofit",
    shape:
      "Inputs of an older raised-floor hall built for air-cooled racks: 400 A busway, 32 A tap-offs, a cold-water plant, about 2 MW of IT load on a 6 MW contract.",
    siteName: "Reference template: legacy air-cooled hall",
    hallId: "TEMPLATE-LEGACY",
    platform: "gb300_nvl72",
    objective: "max_compute",
    values: {
      contractedMW: "6",
      currentPeakMW: "3.8",
      currentItLoadMW: "2.1",
      buswayAmpacityA: "400",
      tapoffMaxA: "32",
      positionsAvailable: "120",
      plantSupplyC: "7",
      firmCapacityMVA: "7",
      floorLoadingKPa: "8",
      plantCapacityKW: "3200",
      pumpFlowLPerMin: "4500",
      existingNonItHeatKW: "300",
      designDrybulbC: "32",
      residualAirKWPerRack: "9",
    },
    supply: [],
  },
  {
    id: "busway_colocation",
    name: "Busway-constrained colocation hall",
    shape:
      "Inputs of a large colocation hall with a 24 MW contract and a 9 MW cooling plant, but a 400 A busway (with 250 A tap-offs).",
    siteName: "Reference template: busway colocation hall",
    hallId: "TEMPLATE-BUSWAY",
    platform: "gb300_nvl72",
    objective: "max_compute",
    values: {
      contractedMW: "24",
      currentPeakMW: "9.5",
      currentItLoadMW: "6.5",
      buswayAmpacityA: "400",
      tapoffMaxA: "250",
      positionsAvailable: "240",
      plantSupplyC: "12",
      firmCapacityMVA: "28",
      floorLoadingKPa: "15",
      plantCapacityKW: "9000",
      pumpFlowLPerMin: "12000",
      existingNonItHeatKW: "600",
      designDrybulbC: "30",
      residualAirKWPerRack: "16",
    },
    supply: [],
  },
  {
    id: "grid_capped_onsite",
    name: "Grid-capped campus with on-site supply",
    shape:
      "Inputs of a campus whose contracted import is almost all drawn already (8 MW contract, 7.6 MW peak), with a battery and a gas engine as on-site supply candidates.",
    siteName: "Reference template: grid-capped campus",
    hallId: "TEMPLATE-GRID",
    platform: "gb300_nvl72",
    objective: "max_compute",
    values: {
      contractedMW: "8",
      currentPeakMW: "7.6",
      currentItLoadMW: "5.2",
      buswayAmpacityA: "1000",
      tapoffMaxA: "250",
      positionsAvailable: "300",
      plantSupplyC: "12",
      firmCapacityMVA: "8.5",
      floorLoadingKPa: "15",
      plantCapacityKW: "12000",
      pumpFlowLPerMin: "15000",
      existingNonItHeatKW: "800",
      designDrybulbC: "28",
      residualAirKWPerRack: "16",
    },
    supply: [
      { id: "bess1", kind: "bess", capacity_MW: "2", lead_time_weeks: "30", capex_eur_per_kW: "", energy_MWh: "8" },
      { id: "gas1", kind: "gas_engine", capacity_MW: "5", lead_time_weeks: "44", capex_eur_per_kW: "", energy_MWh: "" },
    ],
  },
];

/**
 * The seven numbers the free qualifier (/qualify, POST /v1/qualify) takes, by form key: the subset of a template's values it can use. Each one
 * is a PRESET_VALUE_KEY, so a template defines all seven. The qualifier does not take the other template values (firm capacity, floor loading,
 * plant capacity, flows, dry-bulb, air removal) or the supply options, and they are not sent.
 */
export const QUALIFY_PRESET_KEYS = [
  "contractedMW",
  "currentPeakMW",
  "currentItLoadMW",
  "buswayAmpacityA",
  "tapoffMaxA",
  "plantSupplyC",
  "positionsAvailable",
] as const satisfies readonly PresetValueKey[];
export type QualifyPresetKey = (typeof QUALIFY_PRESET_KEYS)[number];

/** What a template puts into the qualifier's form: its seven values as text, and its platform. Site name and metro are the visitor's. */
export function qualifyTemplateState(preset: HallPreset): { raw: Record<QualifyPresetKey, string>; platform: HallPreset["platform"] } {
  const raw = Object.fromEntries(QUALIFY_PRESET_KEYS.map((k) => [k, preset.values[k]])) as Record<QualifyPresetKey, string>;
  return { raw, platform: preset.platform };
}

/**
 * What choosing a template (or none) does to the qualifier's fields. A field the visitor typed (non-empty and not the CURRENT template's value) is
 * KEPT; every other field takes the new template's value, or is emptied when no template is chosen. Nothing the visitor typed is overwritten.
 */
export function switchQualifyTemplate(
  raw: Record<QualifyPresetKey, string>,
  from: HallPreset | null,
  to: HallPreset | null
): { raw: Record<QualifyPresetKey, string>; kept: QualifyPresetKey[] } {
  const theirs = (k: QualifyPresetKey) => raw[k].trim() !== "" && !(from && raw[k].trim() === from.values[k]);
  const kept = QUALIFY_PRESET_KEYS.filter(theirs);
  const next = Object.fromEntries(QUALIFY_PRESET_KEYS.map((k) => [k, theirs(k) ? raw[k] : to ? to.values[k] : ""])) as Record<QualifyPresetKey, string>;
  return { raw: next, kept: [...kept] };
}

/**
 * The qualifier fields that still hold the template's own value: the ones sent as assumed (E0). A field the visitor changed or cleared is
 * theirs. Compared as trimmed text, as stillTemplateValues does: retyping the same figure keeps it the template's number.
 */
export function stillTemplateQualifyValues(preset: HallPreset, raw: Record<string, string | undefined>): QualifyPresetKey[] {
  return QUALIFY_PRESET_KEYS.filter((k) => (raw[k] ?? "").trim() === preset.values[k]);
}

/** True while all seven qualifier figures are still exactly the template's: the read is for the template, not for any hall. */
export function isUntouchedQualifyTemplate(preset: HallPreset, raw: Record<string, string | undefined>): boolean {
  return stillTemplateQualifyValues(preset, raw).length === QUALIFY_PRESET_KEYS.length;
}

export function presetById(id: string | null | undefined): HallPreset | null {
  return HALL_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * The form fields that still hold the template's own value, which are the ones sent as assumed (E0). A field the visitor has changed,
 * cleared or replaced is theirs and is not in the list. Comparison is on the trimmed text, so retyping the same figure keeps it assumed:
 * it is still the template's number.
 */
export function stillTemplateValues(preset: HallPreset, form: Record<string, string | undefined>): PresetValueKey[] {
  return PRESET_VALUE_KEYS.filter((k) => (form[k] ?? "").trim() === preset.values[k]);
}

/** The values the visitor has replaced or removed, as form keys. */
export function editedTemplateValues(preset: HallPreset, form: Record<string, string | undefined>): PresetValueKey[] {
  const still = new Set(stillTemplateValues(preset, form));
  return PRESET_VALUE_KEYS.filter((k) => !still.has(k));
}

/** The form state a template loads: every value as text, the platform, and the identity labels. */
export function presetFormState(preset: HallPreset): Record<string, string> {
  return { ...preset.values, siteName: preset.siteName, hallId: preset.hallId, platform: preset.platform };
}

/** A supply option as the form holds it: every field is text. */
export type SupplyText = Record<keyof PresetSupplyOption, string>;

/** Whether the supply options are still exactly the template's (every field, compared as trimmed text). */
export function templateSupplyUnchanged(preset: HallPreset, btm: readonly SupplyText[]): boolean {
  if (btm.length !== preset.supply.length) return false;
  const keys = ["id", "kind", "capacity_MW", "lead_time_weeks", "capex_eur_per_kW", "energy_MWh"] as const;
  return preset.supply.every((o, i) => keys.every((k) => String(btm[i][k] ?? "").trim() === o[k]));
}

/**
 * True while the form is still exactly the template: every template VALUE is the template's and the supply options are unchanged. Labels (site
 * name, hall id, platform, metro) are not the hall's figures and do not count: renaming a template does not make it a hall, so it still cannot be saved.
 */
export function isUntouchedTemplate(preset: HallPreset, form: Record<string, string | undefined>, btm: readonly SupplyText[]): boolean {
  return stillTemplateValues(preset, form).length === PRESET_VALUE_KEYS.length && templateSupplyUnchanged(preset, btm);
}

/** Everything a template click puts into the form, in one place the component and the tests share. An untouched template is a synthetic example. */
export function templateLoadState(preset: HallPreset) {
  return {
    form: presetFormState(preset),
    btm: preset.supply.map((o) => ({ ...o })),
    objective: preset.objective,
    templateId: preset.id,
    synthetic: true,
  };
}

/**
 * Whether a result is a synthetic example (and so cannot be saved or shared): an untouched template always is, whatever its labels say; a form
 * that did not start from a template is one only while the plain synthetic example is loaded unedited (`syntheticExample`).
 */
export function resultIsSynthetic(
  preset: HallPreset | null, syntheticExample: boolean, form: Record<string, string | undefined>, btm: readonly SupplyText[]
): boolean {
  return preset ? isUntouchedTemplate(preset, form, btm) : syntheticExample;
}
