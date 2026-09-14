// The full intake a purchased engagement asks for.
//
// Mirrors gridforge/intake/schema.py — 13 required fields and a handful of
// optional ones. Anything left blank becomes a library default AND is named as an
// assumption in the delivered document, so an incomplete form degrades honestly
// rather than silently.

import { z } from "zod";

const num = (max: number) => z.coerce.number().nonnegative().max(max);

export const transformerSchema = z.object({
  id: z.string().trim().max(40).default("TX"),
  unit_rating_MVA: num(500),
  units: z.coerce.number().int().min(1).max(40),
  redundancy: z.enum(["N", "N+1", "N+2", "2N"]).default("N+1"),
  replacement_lead_time_weeks: num(520).optional(),
});

export const upsSchema = z.object({
  id: z.string().trim().max(40).default("UPS"),
  unit_rating_kW: num(5000),
  units: z.coerce.number().int().min(1).max(60),
  redundancy: z.enum(["N", "N+1", "N+2", "2N"]).default("N+1"),
});

export const engagementIntakeSchema = z.object({
  // identity
  siteName: z.string().trim().min(1).max(120),
  hallId: z.string().trim().min(1).max(60),
  metro: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  buildYear: z.coerce.number().int().min(1960).max(2035).optional(),
  floorType: z.enum(["raised_floor", "slab"]).default("raised_floor"),

  // grid — the ceiling on everything downstream
  dso: z.string().trim().max(80).optional(),
  firmCapacityMVA: num(2000),
  contractedMW: num(2000),
  currentPeakMW: num(2000),
  currentItLoadMW: num(2000),
  powerFactor: z.coerce.number().min(0.7).max(1).default(0.97),
  queueNote: z.string().trim().max(1200).optional(),

  // LV distribution — usually what actually binds
  buswayAmpacityA: num(6300),
  buswayRuns: z.coerce.number().int().min(1).max(64).default(6),
  tapoffMaxA: num(1600),
  voltageV: num(1000).default(400),

  // hall
  floorLoadingKPa: num(100),
  positionsAvailable: z.coerce.number().int().min(1).max(20000),
  rackPositions: z.coerce.number().int().min(1).max(20000).optional(),
  netWhiteSpaceM2: num(200000).optional(),
  clearHeightM: num(20).optional(),
  aislePitchM: num(10).optional(),
  designDensityKWPerRack: num(400).optional(),

  // thermal
  plantCapacityKW: num(200000),
  plantSupplyC: z.coerce.number().min(-5).max(45),
  plantReturnC: z.coerce.number().min(-5).max(60).optional(),
  pumpFlowLPerMin: num(200000).optional(),
  residualAirKWPerRack: num(200).optional(),

  // site conditions
  designDrybulbC: z.coerce.number().min(-10).max(55).optional(),

  // compute
  platform: z.enum(["gb300_nvl72", "gb200_nvl72", "generic_dlc_50"]).default("gb300_nvl72"),
  utilisation: z.coerce.number().min(0.1).max(1).default(0.75),

  // schedules
  transformers: z.array(transformerSchema).max(20).default([]),
  ups: z.array(upsSchema).max(20).default([]),
});

export type EngagementIntake = z.infer<typeof engagementIntakeSchema>;

/** Drop keys whose value is undefined so the engine records them as gaps. */
function compact<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}

/** Shape the form into the engine's intake document (gridforge/intake/loader.py). */
export function toIntakeDocument(i: EngagementIntake, company?: string): Record<string, unknown> {
  return compact({
    project: compact({ client: company ?? i.siteName, reference: `${i.siteName}/${i.hallId}` }),
    site: compact({
      name: i.siteName,
      metro: i.metro,
      country: i.country,
      design_drybulb_C: i.designDrybulbC,
    }),
    hall: compact({
      id: i.hallId,
      build_year: i.buildYear,
      floor_type: i.floorType,
      floor_loading_kPa: i.floorLoadingKPa,
      positions_available: i.positionsAvailable,
      rack_positions: i.rackPositions ?? i.positionsAvailable,
      net_white_space_m2: i.netWhiteSpaceM2,
      clear_height_m: i.clearHeightM,
      aisle_pitch_m: i.aislePitchM,
      design_density_kW_per_rack: i.designDensityKWPerRack,
    }),
    grid: compact({
      dso: i.dso,
      firm_capacity_MVA: i.firmCapacityMVA,
      contracted_MW: i.contractedMW,
      current_site_peak_MW: i.currentPeakMW,
      current_it_load_MW: i.currentItLoadMW,
      power_factor: i.powerFactor,
      queue_note: i.queueNote,
    }),
    lv: compact({
      voltage_V: i.voltageV,
      busway_ampacity_A: i.buswayAmpacityA,
      busway_runs: i.buswayRuns,
      tapoff_max_A: i.tapoffMaxA,
    }),
    thermal: {
      plant: compact({
        chilled_water_capacity_kW: i.plantCapacityKW,
        design_supply_C: i.plantSupplyC,
        design_return_C: i.plantReturnC,
        pump_flow_capacity_l_per_min: i.pumpFlowLPerMin,
      }),
      ...(i.residualAirKWPerRack !== undefined
        ? { residual_air_capacity_kW_per_rack: i.residualAirKWPerRack }
        : {}),
    },
    compute: { platform: i.platform, utilisation: i.utilisation },
    transformers: i.transformers,
    ups: i.ups,
    scenarios: ["retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm"],
  });
}
