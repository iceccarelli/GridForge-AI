/**
 * SYNTHETIC reference hall, in the form a hall record holds it. Not a customer asset and not a measurement: the values are the ones in the engine's own synthetic
 * example (examples/intake/reference_hall.json, "SYNTHETIC REFERENCE DATA"), re-expressed as recorded figures with a declared origin and class so the engine-backed diff
 * (lib/site-registry-engine.ts) can be tested against the REAL engine. A test pins every value here to that file, so the fixture cannot drift from the engine's example.
 *
 * `file: "verified"` marks a figure the recorder cites a reviewed and verified project file for (the registry only lets a declared class above E3 stand on one).
 * The transformer and UPS ratings are read by the engine as customer data (E5), so they must be declared E5 with such a file to be sent at all.
 */
import type { RegistryInput } from "@/lib/site-registry-model";

export interface RefFigure {
  fieldPath: string;
  value: number | string;
  unit: string | null;
  origin: "assumed" | "modelled" | "vendor" | "measured" | "observed" | "quotation";
  evidenceClass: string;
  file?: "verified";
  /** The engine's path in examples/intake/reference_hall.json, for the drift test. */
  engine: string;
}

const a = (fieldPath: string, value: number | string, unit: string | null, engine: string, evidenceClass = "E1"): RefFigure => ({ fieldPath, value, unit, origin: "assumed", evidenceClass, engine });

export const REFERENCE_HALL: readonly RefFigure[] = [
  { fieldPath: "grid.firm_capacity_mva", value: 14, unit: "MVA", origin: "measured", evidenceClass: "E5", file: "verified", engine: "grid.firm_capacity_MVA" },
  a("grid.contracted_mw", 12, "MW", "grid.contracted_MW", "E3"),
  a("grid.current_site_peak_mw", 7.4, "MW", "grid.current_site_peak_MW"),
  a("grid.current_it_load_mw", 4.9, "MW", "grid.current_it_load_MW"),
  a("grid.power_factor", 0.97, null, "grid.power_factor"),
  a("lv.busway_ampacity_a", 400, "A", "lv.busway_ampacity_A", "E3"),
  a("lv.tapoff_max_a", 63, "A", "lv.tapoff_max_A", "E3"),
  a("lv.voltage_v", 400, "V", "lv.voltage_V"),
  a("lv.busway_runs", 8, null, "lv.busway_runs"),
  a("lv.busway_utilisation_limit", 0.8, null, "lv.busway_utilisation_limit"),
  a("hall.floor_loading_kpa", 12, "kPa", "hall.floor_loading_kPa"),
  a("hall.positions_available", 180, null, "hall.positions_available"),
  a("hall.rack_positions", 560, null, "hall.rack_positions"),
  a("hall.net_white_space_m2", 2400, "m2", "hall.net_white_space_m2"),
  a("hall.design_density_kw_per_rack", 8, "kW/rack", "hall.design_density_kW_per_rack"),
  a("thermal.plant.chilled_water_capacity_kw", 6800, "kW", "thermal.plant.chilled_water_capacity_kW"),
  a("thermal.plant.design_supply_c", 6, "degC", "thermal.plant.design_supply_C"),
  a("thermal.plant.design_return_c", 12, "degC", "thermal.plant.design_return_C"),
  a("thermal.plant.pump_flow_capacity_l_per_min", 9000, "l/min", "thermal.plant.pump_flow_capacity_l_per_min"),
  { fieldPath: "compute.platform", value: "gb300_nvl72", unit: null, origin: "vendor", evidenceClass: "E3", engine: "compute.platform" },
  { fieldPath: "transformers[0].unit_rating_mva", value: 5, unit: "MVA", origin: "measured", evidenceClass: "E5", file: "verified", engine: "transformers[0].unit_rating_MVA" },
  a("transformers[0].units", 3, null, "transformers[0].units"),
  a("transformers[0].redundancy", "N+1", null, "transformers[0].redundancy"),
  a("transformers[0].derating_factor", 0.9, null, "transformers[0].derating_factor", "E3"),
  a("transformers[0].replacement_lead_time_weeks", 160, "weeks", "transformers[0].replacement_lead_time_weeks"),
  { fieldPath: "ups[0].unit_rating_kw", value: 1200, unit: "kW", origin: "measured", evidenceClass: "E5", file: "verified", engine: "ups[0].unit_rating_kW" },
  a("ups[0].units", 6, null, "ups[0].units"),
  a("ups[0].redundancy", "N+1", null, "ups[0].redundancy"),
  a("ups[0].step_load_capability", 0.5, null, "ups[0].step_load_capability"),
];

/** The fixture as recorded claims (what the registry's read API returns), the file cited on a figure marked `file` being a reviewed and verified project file. */
export function referenceInputs(over: { drop?: string[]; set?: Record<string, Partial<RegistryInput>>; fileStatus?: string } = {}): RegistryInput[] {
  return REFERENCE_HALL.filter((f) => !over.drop?.includes(f.fieldPath)).map((f, n) => ({
    id: `ref-${n}`, fieldPath: f.fieldPath, value: f.value, unit: f.unit, evidenceClass: f.evidenceClass, origin: f.origin, asOf: "2026-01-15", recordedBy: "recorder@registry.example",
    recordedAt: "2026-01-15T10:00:00Z", supersedesId: null, superseded: false,
    source: f.file ? { kind: "project_evidence", id: `file-${n}`, filename: "nameplate.pdf", reviewStatus: over.fileStatus ?? "verified" } : null,
    ...(over.set?.[f.fieldPath] ?? {}),
  }));
}
