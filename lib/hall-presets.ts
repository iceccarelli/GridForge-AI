// Reference intake TEMPLATES for the scenario comparison: three archetypal brownfield halls, as input values only.
//
// What a template is: a starting set of hall figures so a visitor can see the comparison work before they have gathered their own. It is
// not a customer's hall, it is not a measurement, and it holds no result. Nothing here says what the engine will answer: the engine
// solves whatever is run (POST /v1/compare), and the answer is shown only after it has been produced. tests/site/hall-presets.test.ts
// validates every template against the real intake schema and runs each one through the real engine, asserting that it is solved or
// refused with a named field.
//
// Every numeric value in a template is ASSUMED. When one is sent, the request lists it in `assumed_fields` and lib/ttp-compare.ts declares
// it to the engine as evidence class E0 (assumed), so the engine's own basis text reads "(E0)" instead of "(E5)", the class it gives a
// figure a client supplies. A value the visitor changes is theirs from that moment and is no longer declared assumed. The identity fields
// (site name, hall id) are labels, not values, and are not declared.

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
