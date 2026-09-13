// Capacity qualifier — the bridge between the website and the engine.
//
// The physics lives in ONE place: the Python envelope engine (gridforge/). This
// module validates the form, calls the engine over HTTP and shapes the answer for
// the UI. There is deliberately no TypeScript reimplementation of the constraints;
// two versions of the truth is exactly what a provenance-first product cannot
// survive.
//
// If GRIDFORGE_API_URL is unset the route degrades to lead capture and says so
// plainly, rather than inventing a number.

import { z } from "zod";

export const qualifySchema = z.object({
  // --- the seven questions that decide the answer for almost any hall --------
  contractedMW: z.coerce.number().positive().max(2000),
  currentPeakMW: z.coerce.number().nonnegative().max(2000),
  currentItLoadMW: z.coerce.number().nonnegative().max(2000),
  buswayAmpacityA: z.coerce.number().positive().max(6300),
  tapoffMaxA: z.coerce.number().positive().max(1600),
  plantSupplyC: z.coerce.number().min(-5).max(45),
  positionsAvailable: z.coerce.number().int().positive().max(20000),
  // --- context --------------------------------------------------------------
  siteName: z.string().trim().max(120).optional(),
  hallId: z.string().trim().max(60).optional(),
  metro: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  platform: z.enum(["gb300_nvl72", "gb200_nvl72", "generic_dlc_50"]).default("gb300_nvl72"),
  // --- optional contact, so a good read can become a conversation -----------
  name: z.string().trim().max(120).optional(),
  company: z.string().trim().max(160).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
});

export type QualifyInput = z.infer<typeof qualifySchema>;

export interface QuantityDTO {
  value: number;
  low: number;
  high: number;
  unit: string;
  evidence: string;
  label: string;
}

export interface QualifyResult {
  platform: { id: string; name: string; rack_kW: QuantityDTO; gpus_per_rack: number };
  as_found: {
    racks: number;
    it_load_kW: QuantityDTO;
    binding_constraint: string;
    domain: string;
    basis: string;
  };
  after_relief: {
    racks: number;
    architecture: string;
    then_binds_on: string | null;
    sets_the_date: string;
  };
  first_three_constraints: { name: string; domain: string; relief: string | null }[];
  intake: {
    completeness: number;
    required_inputs_missing: number;
    can_issue_a_study: boolean;
    gaps: {
      input: string;
      unit: string;
      required: boolean;
      assumed: string;
      why_it_binds: string;
      how_to_get_it: string;
    }[];
    warnings: string[];
    recommended_engagement: string;
  };
  notice: string;
}

/** Map the form to the engine's /v1/qualify body. */
export function toEngineBody(input: QualifyInput) {
  return {
    client: input.company || "Website qualifier",
    site_name: input.siteName,
    hall_id: input.hallId,
    metro: input.metro,
    country: input.country,
    platform: input.platform,
    contracted_MW: input.contractedMW,
    current_site_peak_MW: input.currentPeakMW,
    current_it_load_MW: input.currentItLoadMW,
    busway_ampacity_A: input.buswayAmpacityA,
    tapoff_max_A: input.tapoffMaxA,
    plant_supply_C: input.plantSupplyC,
    positions_available: input.positionsAvailable,
  };
}

export type EngineOutcome =
  | { ok: true; result: QualifyResult }
  | { ok: false; reason: "unconfigured" | "unreachable" | "rejected"; detail: string };

/** Server-side only. Never expose GRIDFORGE_API_URL or the key to the browser. */
export async function callEngine(input: QualifyInput): Promise<EngineOutcome> {
  const base = process.env.GRIDFORGE_API_URL;
  if (!base) {
    return {
      ok: false,
      reason: "unconfigured",
      detail: "The capacity engine is not connected to this deployment.",
    };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.GRIDFORGE_API_KEY) headers["X-API-Key"] = process.env.GRIDFORGE_API_KEY;

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/qualify`, {
      method: "POST",
      headers,
      body: JSON.stringify(toEngineBody(input)),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        reason: "rejected",
        detail: typeof body?.error === "string" ? body.error : `engine returned ${res.status}`,
      };
    }
    return { ok: true, result: body as QualifyResult };
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : "engine unreachable",
    };
  }
}

/** One sentence a salesperson can say out loud. Built from the engine's answer,
 *  never from the form, so it cannot drift from the model. */
export function headline(r: QualifyResult): string {
  const { as_found: found, after_relief: after } = r;
  if (found.racks === 0 && after.racks === 0) {
    return `This hall cannot host ${r.platform.name} racks on these inputs. ${found.binding_constraint} is what stops it.`;
  }
  if (found.racks === 0) {
    return `Nothing deployable today — ${found.binding_constraint.toLowerCase()} stops it. Clear the ladder and the hall carries about ${after.racks} ${r.platform.name} racks.`;
  }
  return `About ${found.racks} ${r.platform.name} racks today, rising to roughly ${after.racks} once ${found.binding_constraint.toLowerCase()} is relieved.`;
}
