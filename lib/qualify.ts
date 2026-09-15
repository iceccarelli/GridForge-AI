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


// --- the shareable result --------------------------------------------------

/**
 * A qualification, addressed by its token.
 *
 * The result page exists because an answer that cannot leave the browser tab does
 * not reach the person who can act on it. The engineer who types seven numbers in
 * is rarely the one who signs off a study; the link is what crosses that gap, and
 * it carries the engineering rather than a summary of it.
 */
export interface StoredQualification {
  id: string;
  created_at: string;
  token: string;
  site_name: string | null;
  hall_id: string | null;
  metro: string | null;
  country: string | null;
  platform: string | null;
  inputs: Record<string, unknown>;
  racks_as_found: number | null;
  racks_after_relief: number | null;
  binding_constraint: string | null;
  intake_completeness: number | null;
  company: string | null;
  status: string;
}

function sbAuth(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const headers: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key, "Content-Type": "application/json" }
    : { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return { url, headers };
}

export function newQualificationToken(): string {
  // Node's webcrypto, available in the Next runtime without an import.
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function getQualification(token: string): Promise<StoredQualification | null> {
  const c = sbAuth();
  if (!c || !token) return null;
  const cols =
    "id,created_at,token,site_name,hall_id,metro,country,platform,inputs," +
    "racks_as_found,racks_after_relief,binding_constraint,intake_completeness,company,status";
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?select=${cols}&token=eq.${encodeURIComponent(token)}&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as StoredQualification[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * How this hall compares with every other hall the engine has seen.
 *
 * The only thing on the page a competitor cannot write, and the reason the link
 * gets forwarded. Respects the same privacy floor as /api/insights: below it, a
 * distribution is noise dressed as evidence and a small sample can point at
 * whoever filled it in.
 */
export const BENCHMARK_MIN_HALLS = 8;

export interface Benchmark {
  published: boolean;
  halls: number;
  sameConstraint: number;
  sharePct: number | null;
  blockedAsFound: number | null;
}

export async function benchmark(constraint: string | null): Promise<Benchmark> {
  const c = sbAuth();
  if (!c || !constraint) {
    return { published: false, halls: 0, sameConstraint: 0, sharePct: null, blockedAsFound: null };
  }
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?select=binding_constraint,racks_as_found&binding_constraint=not.is.null&limit=2000`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) throw new Error("unreachable");
    const rows = (await res.json()) as {
      binding_constraint: string;
      racks_as_found: number | null;
    }[];
    const halls = rows.length;
    if (halls < BENCHMARK_MIN_HALLS) {
      return { published: false, halls, sameConstraint: 0, sharePct: null, blockedAsFound: null };
    }
    const same = rows.filter((r) => r.binding_constraint === constraint).length;
    return {
      published: true,
      halls,
      sameConstraint: same,
      sharePct: Math.round((same / halls) * 100),
      blockedAsFound: rows.filter((r) => (r.racks_as_found ?? 0) === 0).length,
    };
  } catch {
    return { published: false, halls: 0, sameConstraint: 0, sharePct: null, blockedAsFound: null };
  }
}
