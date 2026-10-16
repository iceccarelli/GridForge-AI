// Time-to-Power scenario comparison: the site's contract with POST /v1/compare.
//
// The engine owns every number (gridforge/api/compare_payload.py, schema gridforge/ttp-compare/1). This file owns
// only what the site must agree on with it: the request a person can make, the response shape the page renders,
// (The function that asks lives in lib/ttp-compare-server.ts: this file is imported by the browser bundle and must
// stay free of server-only modules.) It reuses the Density Screen intake schema and its intake-document mapping
// (lib/engagement-intake.ts), so a hall described here is the same hall the Screen, the Study and the API see.

import { z } from "zod";
import { screenIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";

export const TTP_COMPARE_SCHEMA = "gridforge/ttp-compare/1";

export const SCENARIO_IDS = ["retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** Engine objective names, as `Objective` defines them. */
export const OBJECTIVES = ["max_compute", "min_cost", "fastest"] as const;
export type CompareObjective = (typeof OBJECTIVES)[number];

export const OBJECTIVE_LABEL: Record<CompareObjective, string> = {
  max_compute: "Most racks",
  min_cost: "Lowest capex per rack",
  fastest: "Earliest full energisation",
};

/** Supply kinds the engine models with firm-capacity defaults (gridforge/power/btm.py). PV and wind are not firm. */
export const BTM_KINDS = ["gas_engine", "chp", "fuel_cell", "bess"] as const;

export const btmOptionSchema = z.object({
  id: z.string().trim().min(1).max(40),
  kind: z.enum(BTM_KINDS),
  capacity_MW: z.coerce.number().positive().max(2000),
  lead_time_weeks: z.coerce.number().positive().max(520),
  capex_eur_per_kW: z.coerce.number().positive().max(100_000).optional(),
  energy_MWh: z.coerce.number().positive().max(100_000).optional(),
});

export const compareRequestSchema = z
  .object({
    hall: screenIntakeSchema,
    btm_options: z.array(btmOptionSchema).max(10).default([]),
    objective: z.enum(OBJECTIVES).default("max_compute"),
    scenarios: z.array(z.enum(SCENARIO_IDS)).min(2).max(5).optional(),
    baseline: z.enum(SCENARIO_IDS).optional(),
  })
  .superRefine((r, ctx) => {
    for (const [i, o] of r.btm_options.entries()) {
      if (o.kind === "bess" && o.energy_MWh === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["btm_options", i, "energy_MWh"],
          message: "A battery needs its energy (MWh): a power rating alone does not say how long it can carry the hall.",
        });
      }
    }
    if (r.scenarios?.includes("full_dlc_btm") && r.btm_options.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["btm_options"],
        message: "full_dlc_btm compares on-site supply: declare at least one supply option, or drop that scenario.",
      });
    }
    if (r.baseline && r.scenarios && !r.scenarios.includes(r.baseline)) {
      ctx.addIssue({ code: "custom", path: ["baseline"], message: "The baseline must be one of the compared scenarios." });
    }
  });

export type CompareRequest = z.infer<typeof compareRequestSchema>;

/** The exact body POSTed to /v1/compare for a request: what a CLI or API user would send to reproduce the page. */
export function toEngineBody(r: CompareRequest): Record<string, unknown> {
  const intake = toIntakeDocument(r.hall) as Record<string, unknown>;
  if (r.btm_options.length) intake.btm_options = r.btm_options;
  return {
    intake,
    objective: r.objective,
    ...(r.scenarios ? { scenarios: r.scenarios } : {}),
    ...(r.baseline ? { baseline: r.baseline } : {}),
  };
}

export interface Q {
  value: number;
  low: number;
  high: number;
  unit: string;
  evidence: string;
  label: string;
}

export interface AppliedEvidence {
  evidence_id: string | null;
  key: string;
  unit: string;
  value: number;
  basis: string;
  quoted_on: string | null;
  synthetic: boolean;
}

export interface CompareScenario {
  id: string;
  name: string;
  architecture: string;
  rationale: string;
  as_found: { racks: number; binding: string; binding_name: string };
  after_ladder: { racks: number; binding: string | null; binding_name: string | null; it_load_kW: Q | null };
  time_to_power: {
    status: "dated" | "no_deployable_racks" | "lead_time_missing" | "no_date";
    weeks: number | null;
    low: number | null;
    high: number | null;
    evidence: string | null;
    first_rack_weeks: number | null;
    sets_the_date: string | null;
    reason: string | null;
    lead_times: { constraint: string; name: string; domain: string; lead_time_weeks: Q | null; missing: boolean; capex_eur: Q | null }[];
  };
  economics: {
    capex_total_eur: Q | null;
    capex_complete: boolean;
    unpriced_components: { component?: string; key?: string }[];
    /** How many priced lines rest on which basis (library placeholder, budgetary quote, firm quote ...), engine-labelled. */
    cost_basis_mix: Record<string, { lines: number; label: string }>;
    decision_grade: boolean;
    basis: string;
    limitations: string[];
  };
  weakest_lead_time_evidence: string | null;
  grade: "indicative" | "screening" | "undated";
  missing_inputs: string[];
  vs_baseline: null | {
    racks_delta: number;
    weeks_delta: number | null;
    weeks_delta_unknown_reason: string | null;
    capex_delta_eur: number | null;
    capex_delta_unknown_reason: string | null;
    why: string[];
  };
}

export interface CompareResult {
  schema: typeof TTP_COMPARE_SCHEMA;
  objective: CompareObjective;
  baseline: string;
  scenarios: CompareScenario[];
  ranking: {
    objective: string;
    metric: string;
    order: string[];
    values: Record<string, number>;
    racks: Record<string, number>;
    excluded: { id: string; reason: string }[];
    leader: string | null;
    tie: boolean;
    note: string | null;
  };
  grade: "indicative" | "screening";
  caveats: string[];
  /** The accepted quotations whose prices this answer rests on; empty when the capex is the cost library throughout. */
  evidence_applied: AppliedEvidence[];
  /** Present only when quotations were offered: what the engine used and what it ignored, with the reason. */
  cost_evidence?: {
    used: { evidence_id: string | null; key: string; unit: string; value: number; basis: string; supplier: string | null; quoted_on: string | null; reviewer: string | null; synthetic: boolean; scope: string | null }[];
    ignored: { key: string; evidence_id: string | null; reason: string }[];
    effect: unknown;
  };
  request_digest: string;
  intake_completeness: number;
  provenance: { digest: string; engine_version: string; code_sha256: string; report_date: string };
}
