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
import { PRODUCT_BY_KIND } from "@/lib/products";

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

/**
 * The three figures the engine falls back to when an intake leaves them out (gridforge/intake/loader.py: `lv.busway_runs`, `lv.voltage_V`,
 * `grid.power_factor`). They are shown to the visitor as placeholder/hint text ONLY. They are never a form value and never a schema default:
 * a value the visitor did not give must not reach the engine as if they had (the engine then classes it as supplied customer data, E5 or E3,
 * counts the field as supplied in `intake_completeness`, and drops it from the named-assumptions list). Left out, the engine uses its own
 * default AND names it as an assumption in the document. tests/site/honest-intake-defaults.test.ts pins these numbers to the engine's source
 * and to a real engine run, so this table cannot drift from what the engine actually assumes.
 *
 * SAVED REQUESTS. A project or comparison saved before this change stored the request that was sent, and that request carries 6 runs, 400 V
 * and 0.97 as plain numbers. Nothing here rewrites or migrates it: the evidence ladder (lib/project-spec-relief.ts) reads a saved request as
 * it is and shows those three as SUPPLIED, because they were sent to the engine as supplied and the engine treated them so. That reading is
 * true of what was sent; it is not a claim that the visitor measured them.
 */
export const ENGINE_LIBRARY_DEFAULTS = {
  buswayRuns: 6,
  voltageV: 400,
  powerFactor: 0.97,
} as const;

/** The form's hint for one of the three, in the visitor's words. */
export const LIBRARY_DEFAULT_HINT = `the engine assumes ${ENGINE_LIBRARY_DEFAULTS.buswayRuns} runs / ${ENGINE_LIBRARY_DEFAULTS.voltageV} V / ${ENGINE_LIBRARY_DEFAULTS.powerFactor} until you give yours`;

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
  // powerFactor, voltageV and buswayRuns are OPTIONAL with no schema default: see ENGINE_LIBRARY_DEFAULTS below. A value the
  // visitor did not give is not parsed into 0.97 / 400 / 6 and sent as if it were theirs.
  powerFactor: z.coerce.number().min(0.7).max(1).optional(),
  queueNote: z.string().trim().max(1200).optional(),

  // LV distribution — usually what actually binds
  buswayAmpacityA: num(6300),
  buswayRuns: z.coerce.number().int().min(1).max(64).optional(),
  tapoffMaxA: num(1600),
  voltageV: num(1000).optional(),

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
  /** Flow the existing hall already draws on the plant (l/min). Optional: when given, the engine subtracts it from the pumped flow. */
  existingFlowLPerMin: num(200000).optional(),
  /**
   * Other heat the chilled-water plant already carries in the existing hall beyond the IT load (UPS and distribution losses, fan-wall and
   * pump power rejected to the plant, lighting), kW. Optional: when given, the engine subtracts it from the plant headroom as well.
   */
  existingNonItHeatKW: num(200000).optional(),
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
 * The engine refuses an existing-hall flow larger than the pumped flow it is subtracted from (the figure would leave less than nothing for
 * the new load), naming both numbers. The same rule here lets the form say so before anything is sent, with the same two numbers.
 * Only checked when BOTH are given: with the pumped flow absent the engine applies its own placeholder and says so.
 */
function existingFlowRule(v: { pumpFlowLPerMin?: number; existingFlowLPerMin?: number }, ctx: z.RefinementCtx) {
  if (v.existingFlowLPerMin !== undefined && v.pumpFlowLPerMin !== undefined && v.existingFlowLPerMin > v.pumpFlowLPerMin) {
    ctx.addIssue({
      code: "custom",
      path: ["existingFlowLPerMin"],
      message: `the existing hall's flow (${v.existingFlowLPerMin} l/min) is larger than the pumped flow (${v.pumpFlowLPerMin} l/min) it is taken from; give the flow the existing hall draws on this plant, which cannot exceed the plant's pumped flow`,
    });
  }
}

/**
 * The engine refuses other plant heat larger than the plant capacity it is carried by, naming both numbers. The same rule here lets the form
 * say so before anything is sent. Only checked when BOTH are given: with the capacity absent the engine applies its own placeholder and says so.
 */
function existingNonItHeatRule(v: { plantCapacityKW?: number; existingNonItHeatKW?: number }, ctx: z.RefinementCtx) {
  if (v.existingNonItHeatKW !== undefined && v.plantCapacityKW !== undefined && v.existingNonItHeatKW > v.plantCapacityKW) {
    ctx.addIssue({
      code: "custom",
      path: ["existingNonItHeatKW"],
      message: `the other heat on the plant (${v.existingNonItHeatKW} kW) is larger than the chilled-water plant capacity (${v.plantCapacityKW} kW) that carries it; give the heat the existing hall puts on this plant beyond its IT load, which cannot exceed the plant's capacity`,
    });
  }
}

/** The cross-field rules for the optional plant figures, in one refinement so each schema applies them all. */
function plantFigureRules(
  v: { pumpFlowLPerMin?: number; existingFlowLPerMin?: number; plantCapacityKW?: number; existingNonItHeatKW?: number },
  ctx: z.RefinementCtx,
) {
  existingFlowRule(v, ctx);
  existingNonItHeatRule(v, ctx);
}

/**
 * Everything, required. The Procurement Specification, and the safe default for
 * any product that does not say otherwise.
 */
const engagementObject = z.object(baseShape);

// Ensure .shape is accessible both at runtime and in TypeScript when wrapped in ZodEffects
function withShape<S extends z.ZodRawShape, T extends z.ZodTypeAny = z.ZodTypeAny>(schema: T): T & { shape: S } {
  let cur: any = schema;
  while (cur && !cur.shape && cur._def?.schema) cur = cur._def.schema;
  if (cur?.shape && !(schema as any).shape) {
    Object.defineProperty(schema, "shape", { value: cur.shape, enumerable: false, configurable: true });
  }
  return schema as any;
}

export const engagementIntakeSchema = withShape<typeof baseShape, ReturnType<typeof engagementObject.superRefine>>(engagementObject.superRefine(plantFigureRules));

/**
 * The Density Screen: the seven the free qualifier proves are enough to name what
 * binds, plus the identity of the hall. The three in ASSUMABLE_FOR_SCREEN become
 * library defaults, named as assumptions in the document, and listed in the data
 * request the customer sends to their own engineers — which is what they bought.
 *
 * Nothing below the free tier's own bar: a Screen built on fewer numbers than the
 * qualifier answers on would have no site-specific content to sell.
 */
const screenShape = {
  ...baseShape,
  firmCapacityMVA: baseShape.firmCapacityMVA.optional(),
  floorLoadingKPa: baseShape.floorLoadingKPa.optional(),
  plantCapacityKW: baseShape.plantCapacityKW.optional(),
};
const screenObject = z.object(screenShape);
export const screenIntakeSchema = withShape<typeof screenShape, ReturnType<typeof screenObject.superRefine>>(screenObject.superRefine(plantFigureRules));

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

/**
 * The Portfolio Screen: several halls ranked under one methodology. Each hall is a Density Screen's intake (what the free qualifier
 * proves is enough to rank on), so the same three optional figures per hall become named assumptions, hall by hall. Sold for five to
 * fifteen halls; two is the least a ranking means anything for, and fifteen is the most one engagement is scoped for.
 */
export const PORTFOLIO_MIN_HALLS = 2;
export const PORTFOLIO_MAX_HALLS = 15;
export const OBJECTIVES = ["max_compute", "min_cost", "fastest"] as const;

export const portfolioIntakeSchema = z
  .object({
    client: z.string().trim().min(1).max(120).optional(),
    objective: z.enum(OBJECTIVES).default("max_compute"),
    halls: z.array(screenIntakeSchema).min(PORTFOLIO_MIN_HALLS).max(PORTFOLIO_MAX_HALLS),
  })
  .superRefine((v, ctx) => {
    // Two halls with the same site and hall id would be one row in the ranking and one pack name: refuse, naming both.
    const seen = new Map<string, number>();
    v.halls.forEach((h, i) => {
      const k = `${h.siteName.toLowerCase()}/${h.hallId.toLowerCase()}`;
      const first = seen.get(k);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["halls", i, "hallId"], message: `hall ${i + 1} repeats site "${h.siteName}" hall "${h.hallId}" (hall ${first + 1}); each hall needs its own site and hall id` });
      else seen.set(k, i);
    });
  });
export type PortfolioIntake = z.infer<typeof portfolioIntakeSchema>;

export const PORTFOLIO_NO_EVIDENCE =
  "Documents are attached to one hall at a time, so the Portfolio Screen does not take them. Supply each hall's figures in the portfolio form; anything you leave blank is named as an assumption for that hall.";

export function isPortfolioKind(kind: string): boolean {
  return PRODUCT_BY_KIND[kind]?.endpoint === "portfolio";
}

/** What the engine's /v1/portfolio takes: one intake document per hall, plus the objective and the name printed on the document. */
export function toPortfolioDocument(i: PortfolioIntake, company?: string): Record<string, unknown> {
  return {
    client: i.client ?? company ?? "Portfolio",
    objective: i.objective,
    intakes: i.halls.map((h) => {
      const doc = toIntakeDocument(h, i.client ?? company) as { site?: Record<string, unknown> };
      // The engine names a pack after the site and hall ids. Left alone every site is "SITE-1", so two halls both called H1 at different
      // sites would share a name. The id is derived from the site's own name, only here: a single-hall document is unchanged.
      const slug = h.siteName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "SITE";
      return { ...doc, site: { ...(doc.site ?? {}), id: slug } };
    }),
  };
}

/** The figures each hall left to us, hall by hall (the portfolio form's version of assumedFields). */
export function portfolioAssumed(i: PortfolioIntake): { hall: string; field: AssumableField; source: string }[] {
  return i.halls.flatMap((h) =>
    assumedFields(h as unknown as Record<string, unknown>).map((field) => ({ hall: `${h.siteName} / ${h.hallId}`, field, source: ASSUMABLE_SOURCE[field] }))
  );
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
        existing_flow_l_per_min: i.existingFlowLPerMin,
        existing_non_it_heat_kW: i.existingNonItHeatKW,
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

/**
 * What a scoping call needs from the buyer, keyed by the engagement intake's own fields (a test checks every key is a real
 * field of the schema, so this list cannot drift from the form). Used by the deposit receipt: a deposit opens no intake
 * form, so the buyer is told up front which numbers to have to hand. Anything not available is not a blocker: it becomes a
 * named assumption, exactly as in an intake.
 */
export const SCOPING_PREPARATION: { field: keyof typeof baseShape; label: string; from: string }[] = [
  { field: "firmCapacityMVA", label: "Firm connection capacity (MVA)", from: ASSUMABLE_SOURCE.firmCapacityMVA },
  { field: "contractedMW", label: "Contracted capacity (MW)", from: "your supply contract" },
  { field: "currentPeakMW", label: "Current site peak demand (MW) and current IT load (MW)", from: "your metering or operations team" },
  { field: "buswayAmpacityA", label: "Busway ampacity (A) and tap-off rating (A)", from: "the LV distribution schedule" },
  { field: "floorLoadingKPa", label: "Floor loading (kPa)", from: ASSUMABLE_SOURCE.floorLoadingKPa },
  { field: "plantCapacityKW", label: "Chilled-water plant capacity (kW) and design supply temperature (C)", from: ASSUMABLE_SOURCE.plantCapacityKW },
  { field: "positionsAvailable", label: "Rack positions available in the hall", from: "the hall layout" },
  { field: "transformers", label: "Transformer and UPS schedules (rating, units, redundancy)", from: "the electrical single-line diagram" },
  { field: "designDrybulbC", label: "Site summer design dry-bulb temperature (C)", from: "the site's climate basis of design" },
  { field: "platform", label: "The compute platform you intend to deploy, and the utilisation you expect", from: "your own plan" },
];
