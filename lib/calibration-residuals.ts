// Reads the deployed engine's public GET /v1/calibration/residuals and keeps only what it actually said.
//
// The page that shows this must render without the network at build time and must never put a number on screen that was not just read:
// a failed read, a non-200 and a body that does not have the documented shape are all "could not be read", with no figure carried
// over from anywhere else. A pure parser (parseResiduals) is kept apart from the fetch so the shape rules are tested without a network.

import { RESIDUALS_PATH, RESIDUALS_SCHEMA } from "@/lib/calibration-gates";

export type ResidualState = "uncalibrated" | "indicative" | "calibrated";

export interface ResidualCell {
  n: number;
  sites: number;
  /** Present only when the engine published the statistics (three or more sites behind the cell). */
  mean_abs_error: number | null;
  median_abs_error: number | null;
  mean_signed_error: number | null;
  median_pct_error: number | null;
  /** The engine withheld the statistics of a cell resting on fewer than PUBLIC_MIN_SITES sites (lib/calibration-gates.ts). */
  suppressed: boolean;
}

export interface ResidualVariable {
  name: string;
  unit: string;
  state: string;
  approved_observations: number;
  distinct_sites: number;
  still_needed: { observations: number; sites: number } | null;
  residuals: ResidualCell | null;
}

export interface ResidualSubsystem {
  name: string;
  state: string;
  approved_observations: number;
  distinct_sites: number;
  variables: ResidualVariable[];
}

export interface ResidualReport {
  schema: string;
  state: ResidualState;
  n_records: number;
  n_sites: number;
  subsystems: ResidualSubsystem[];
  withheld_variables: string[];
  /** The thresholds the body itself states under `requirements`; null when it does not state both. */
  requirements: { min_approved_observations_per_variable: number; min_distinct_sites_per_variable: number } | null;
}

export type ResidualRead =
  | { status: "read"; report: ResidualReport; readAt: string }
  | { status: "unreadable"; reason: "unreachable" | "not_served" | "http_error" | "malformed" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The largest count taken at face value: far above anything real, far below a magnitude that is a unit error or an attack. */
export const COUNT_MAX = 1_000_000_000;
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= COUNT_MAX ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function cell(v: unknown): ResidualCell | null {
  if (!isObj(v)) return null;
  const n = count(v.n);
  const sites = count(v.sites);
  if (n === null || sites === null) return null;
  return {
    n,
    sites,
    mean_abs_error: num(v.mean_abs_error),
    median_abs_error: num(v.median_abs_error),
    mean_signed_error: num(v.mean_signed_error),
    median_pct_error: num(v.median_pct_error),
    suppressed: typeof v.suppressed === "string",
  };
}

/**
 * The documented body (schema gridforge.calibration.residuals.public/1), or null when it is not that. Strict on what is shown: a count
 * must be a non-negative integer, a statistic a finite number. A body that claims records but whose state is "uncalibrated" (or the
 * reverse) is refused rather than reconciled.
 */
export function parseResiduals(body: unknown): ResidualReport | null {
  if (!isObj(body) || body.schema !== RESIDUALS_SCHEMA) return null;
  const state = body.state;
  if (state !== "uncalibrated" && state !== "indicative" && state !== "calibrated") return null;
  const n_records = count(body.n_records);
  const n_sites = count(body.n_sites);
  if (n_records === null || n_sites === null) return null;
  if ((n_records === 0) !== (state === "uncalibrated")) return null;
  if (!isObj(body.subsystems)) return null;

  const subsystems: ResidualSubsystem[] = [];
  for (const [name, raw] of Object.entries(body.subsystems)) {
    if (!isObj(raw) || typeof raw.state !== "string" || !isObj(raw.variables)) return null;
    const approved = count(raw.approved_observations);
    const sites = count(raw.distinct_sites);
    if (approved === null || sites === null) return null;
    const variables: ResidualVariable[] = [];
    for (const [vname, vraw] of Object.entries(raw.variables)) {
      if (!isObj(vraw) || typeof vraw.unit !== "string" || typeof vraw.state !== "string") return null;
      const vApproved = count(vraw.approved_observations);
      const vSites = count(vraw.distinct_sites);
      if (vApproved === null || vSites === null) return null;
      const need = isObj(vraw.still_needed) ? vraw.still_needed : null;
      const needObs = need ? count(need.observations) : null;
      const needSites = need ? count(need.sites) : null;
      variables.push({
        name: vname,
        unit: vraw.unit,
        state: vraw.state,
        approved_observations: vApproved,
        distinct_sites: vSites,
        still_needed: needObs !== null && needSites !== null ? { observations: needObs, sites: needSites } : null,
        residuals: cell(vraw.residuals),
      });
    }
    subsystems.push({ name, state: raw.state, approved_observations: approved, distinct_sites: sites, variables });
  }
  const withheld = Array.isArray(body.withheld_variables) && body.withheld_variables.every((x) => typeof x === "string")
    ? (body.withheld_variables as string[])
    : [];
  const req = isObj(body.requirements) ? body.requirements : null;
  const minObs = req ? count(req.min_approved_observations_per_variable) : null;
  const minSites = req ? count(req.min_distinct_sites_per_variable) : null;
  const requirements = minObs !== null && minSites !== null ? { min_approved_observations_per_variable: minObs, min_distinct_sites_per_variable: minSites } : null;
  return { schema: RESIDUALS_SCHEMA, state, n_records, n_sites, subsystems, withheld_variables: withheld, requirements };
}

export const RESIDUALS_TIMEOUT_MS = 6_000;
/** The most of the response body that is read. The real report is a few kilobytes; a larger answer is not the documented one. */
export const RESIDUALS_MAX_BYTES = 64 * 1024;

/** The body as text, or null when it is larger than `max` bytes (the rest is cancelled unread). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function engineBase(env: Record<string, string | undefined> = process.env): string {
  return (env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev").replace(/\/$/, "");
}

/** One read of the engine's residual report. Never throws; never returns a number it did not read. */
export async function readLiveResiduals(): Promise<ResidualRead> {
  let res: Response;
  try {
    res = await fetch(`${engineBase()}${RESIDUALS_PATH}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(RESIDUALS_TIMEOUT_MS),
      next: { revalidate: 300 },
    });
  } catch {
    return { status: "unreadable", reason: "unreachable" };
  }
  if (res.status === 404) return { status: "unreadable", reason: "not_served" };
  if (!res.ok) return { status: "unreadable", reason: "http_error" };
  let body: unknown;
  try {
    const raw = await readCapped(res, RESIDUALS_MAX_BYTES);
    if (raw === null) return { status: "unreadable", reason: "malformed" };
    body = JSON.parse(raw);
  } catch {
    return { status: "unreadable", reason: "malformed" };
  }
  const report = parseResiduals(body);
  return report ? { status: "read", report, readAt: new Date().toISOString() } : { status: "unreadable", reason: "malformed" };
}
