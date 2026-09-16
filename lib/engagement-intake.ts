// The intake a purchased engagement asks for.
//
// Mirrors gridforge/intake/schema.py. Anything left blank becomes a library
// default AND is named as an assumption in the delivered document, so an
// incomplete form degrades honestly rather than silently.
//
// THAT SENTENCE WAS NOT TRUE FOR THREE FIELDS, and it cost the flagship sale.
//
// The free qualifier answers on seven numbers. A customer who ran it, saw a real
// binding constraint, and paid EUR 4,500 for the Density Screen was then asked for
// three more that the free tier had never needed: the firm connection capacity
// (DSO connection agreement), the floor loading (structural record) and the plant
// capacity (mechanical schedule). None of those is on an operations engineer's
// desk. So the buyer most likely to convert was the one most likely to be blocked,
// after paying.
//
// The engine had already ruled on this. A missing required field is a GAP, not a
// rejection: `can_issue` goes false and `engagement_recommendation` reads "Sell
// the Density Screen instead: it produces the binding constraint and the
// data-request list". The Density Screen IS the product for thin data, and its
// form would not accept thin data.
//
// Asked directly, with those three removed, the engine returns the same binding
// constraint, the same basis and the same rack counts — on the customer's own E5
// figures — and moves from five named gaps to eight. The gaps are the deliverable.
//
// So there are two shapes, and the difference is the product, not a preference:
//
//   screenIntakeSchema  — the Density Screen. Requires what the free qualifier
//                         requires and no more. The three above become gaps.
//   engagementIntakeSchema — the Procurement Specification. Requires all of them,
//                         because that document states duties a supplier quotes
//                         against and a purchase order is raised from, and sizing
//                         plant from an assumed plant capacity is not a gap in a
//                         report, it is a number on an order.

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

/**
 * The three the free qualifier never asks for.
 *
 * Optional for a Density Screen, required for a Procurement Specification. Named
 * here so the form, the schema and the copy the customer reads cannot drift.
 */
export const ASSUMABLE_FOR_SCREEN = [
  "firmCapacityMVA",
  "floorLoadingKPa",
  "plantCapacityKW",
] as const;

export type AssumableField = (typeof ASSUMABLE_FOR_SCREEN)[number];

/** What each one is worth going to get, in the customer's own words. */
export const ASSUMABLE_SOURCE: Record<AssumableField, string> = {
  firmCapacityMVA: "your DSO connection agreement",
  floorLoadingKPa: "the structural record for the hall",
  plantCapacityKW: "the mechanical schedule for the chilled-water plant",
};

const baseShape = {
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
};

/**
 * Everything, required. The Procurement Specification, and the safe default for
 * any product that does not say otherwise.
 */
export const engagementIntakeSchema = z.object(baseShape);

/**
 * The Density Screen: the seven the free qualifier proves are enough to name what
 * binds, plus the identity of the hall. The three in ASSUMABLE_FOR_SCREEN become
 * library defaults, named as assumptions in the document, and listed in the data
 * request the customer sends to their own engineers — which is what they bought.
 *
 * Nothing below the free tier's own bar: a Screen built on fewer numbers than the
 * qualifier answers on would have no site-specific content to sell.
 */
export const screenIntakeSchema = z.object({
  ...baseShape,
  firmCapacityMVA: baseShape.firmCapacityMVA.optional(),
  floorLoadingKPa: baseShape.floorLoadingKPa.optional(),
  plantCapacityKW: baseShape.plantCapacityKW.optional(),
});

/**
 * The schema for a product kind.
 *
 * Unknown kinds get the strict one. A product added to the catalogue without a
 * decision here asks for everything, which is the failure that costs a form field
 * rather than a wrong number in a specification.
 */
export function intakeSchemaFor(kind: string) {
  return kind === "density_screen" ? screenIntakeSchema : engagementIntakeSchema;
}

/** Which of the assumable fields this submission left to us. */
export function assumedFields(input: Record<string, unknown>): AssumableField[] {
  return ASSUMABLE_FOR_SCREEN.filter(
    (f) => input[f] === undefined || input[f] === null || input[f] === ""
  );
}

export type EngagementIntake = z.infer<typeof engagementIntakeSchema>;
export type ScreenIntake = z.infer<typeof screenIntakeSchema>;

/** Drop keys whose value is undefined so the engine records them as gaps. */
function compact<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}

/**
 * Shape the form into the engine's intake document (gridforge/intake/loader.py).
 *
 * Typed against the looser shape on purpose: every strict intake satisfies it, and
 * `compact()` below drops anything undefined so the engine records it as a gap.
 * That was always the intent — it just had no caller that could reach it.
 */
export function toIntakeDocument(i: ScreenIntake, company?: string): Record<string, unknown> {
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
