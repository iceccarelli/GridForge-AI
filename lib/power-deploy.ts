// Server-only data layer for the persistent BTM Power Deployment Case.
//
// gridforge/reporting/btm_assessment.py composes a real load profile and
// declared generation/BESS units into one architecture comparison, exposed
// over the CLI, REST (/v1/power/deploy/assess) and MCP — but every call there
// composes fresh. This is the layer that turns one compute into a case: a row
// per revision, a token that survives across sessions, and a change note
// computed by actually comparing this revision's request against the last
// one's, never invented.
//
// Follows lib/watches.ts's shape exactly: the same creds()/fetch-to-PostgREST
// pattern, the same "not persisted — Supabase unset" fallback so local
// development and the test suite work without live credentials, the same
// fail-closed-to-null on an unreachable store rather than a thrown exception.

import crypto from "node:crypto";
import { storeFault } from "@/lib/safe-log";
import { engineFetch } from "@/lib/rate-limit";

export interface PowerDeploymentCaseRow {
  id: string;
  created_at?: string;
  case_token: string;
  revision: number;
  email: string | null;
  company: string | null;
  project_name: string | null;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  changed_fields: string[];
  /**
   * The engine's /v1/version provenance (digest, report_date, ...) read right after the assessment that produced
   * `result`, with `read` saying whether an earlier read bracketed it ("bracketed") or not ("after_only"); null for
   * revisions written before migration 0038 or when the engine did not report one. Never inferred. A calibration
   * observation takes its engine digest from here.
   */
  engine_provenance?: Record<string, unknown> | null;
  /** Set only when the revision was written together with project history events. */
  project_events?: number;
}

export function newCaseToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Call the deployed engine's `/v1/power/deploy/assess` — the same
 * `deployment_request()` / `assess_deployment()` pair the CLI and MCP tool
 * call, over the same GRIDFORGE_API_URL/GRIDFORGE_API_KEY pair
 * `renderDeliverable` in lib/deliverables.ts already uses. No second
 * implementation of the physics on this side of the process boundary.
 */
export async function runDeploymentAssessment(
  request: Record<string, unknown>
): Promise<
  | { ok: true; result: Record<string, unknown>; provenance: Record<string, unknown> | null }
  | { ok: false; error: string; routeMissing?: true }
> {
  // The engine build is read once, immediately AFTER a successful assessment: the metered call is the only thing
  // that touches the engine when the caller's budget is spent, so nothing here may precede it. To bracket the
  // assessment the previous read this process made (if recent) is compared with the new one: if the build changed
  // in between, the answer cannot be attributed to either and no provenance is kept; with no recent read the new one
  // is kept and labelled `read: "after_only"`, so the record says how it was captured. If the engine will not say
  // what it is, the revision is stored without one (and its observations are not ledger-eligible); nothing is invented.
  const earlier = lastRead && Date.now() - lastRead.at < BRACKET_WINDOW_MS ? lastRead.p : null;
  const out = await callEngine("/v1/power/deploy/assess", request);
  if (!out.ok) return out.routeMissing ? { ok: false, error: out.error, routeMissing: true } : { ok: false, error: out.error };
  const after = await engineProvenance();
  if (after) lastRead = { p: after, at: Date.now() };
  let provenance: Record<string, unknown> | null = null;
  if (after && (!earlier || earlier.digest === after.digest)) {
    provenance = { ...after, read: earlier ? "bracketed" : "after_only" };
  }
  return { ok: true, result: out.body, provenance };
}

const BRACKET_WINDOW_MS = 120_000;
let lastRead: { p: Record<string, unknown>; at: number } | null = null;

/** The engine's own provenance record (GET /v1/version), or null when it cannot be read or is malformed. */
async function engineProvenance(): Promise<Record<string, unknown> | null> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base || !key) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/version`, {
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const p = ((await res.json().catch(() => null)) as { provenance?: Record<string, unknown> } | null)?.provenance;
    if (!p || typeof p.digest !== "string" || !/^[0-9a-f]{64}$/.test(p.digest)) return null;
    return p;
  } catch {
    return null;
  }
}

/** Insert a revision row directly. If the store predates migration 0038 (no engine_provenance column) retry once
 * without it, so a deployment that has not applied the migration yet keeps saving cases. */
async function insertRevisionRow(
  c: { url: string; headers: Record<string, string> },
  record: Record<string, unknown>
): Promise<Response> {
  const post = (body: Record<string, unknown>) =>
    fetch(`${c.url}/rest/v1/power_deployment_cases`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  const res = await post(record);
  if (res.ok || !("engine_provenance" in record)) return res;
  const text = await res.clone().text().catch(() => "");
  if (!text.includes("engine_provenance")) return res;
  const { engine_provenance: _drop, ...rest } = record;
  void _drop;
  return post(rest);
}

/**
 * What a visitor is told, with HTTP 503, when the engine they would be calling does not serve the route yet. Said the same
 * way by every surface (cases, case revisions, RFQ package, supplier responses, comparison) so none of them reports "try
 * again later" or a generic outage for what is an engine release that has not happened, and so each states that no
 * charge was made.
 */
export const ROUTE_NOT_DEPLOYED_MESSAGE =
  "This capability is not deployed yet: the engine release that serves it is not live. Nothing was calculated, saved or charged.";

/**
 * One authenticated POST to the deployed engine. The single place the site talks to
 * `GRIDFORGE_API_URL`/`GRIDFORGE_API_KEY` for BTM routes, so the assessment, the
 * tender package and the bid comparison all fail the same way. `status` is the
 * engine's own HTTP status (0 when it was never reached) and `body` its JSON, so a
 * caller can pass an engine refusal through rather than flatten it.
 */
export async function callEngine(
  path: string,
  request: Record<string, unknown>
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string; status: number; body: Record<string, unknown>; routeMissing?: true }
> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base) return { ok: false, status: 0, body: {}, error: "GRIDFORGE_API_URL is not set" };
  if (!key) {
    return { ok: false, status: 0, body: {}, error: "GRIDFORGE_API_KEY is not set — paid endpoints need it" };
  }
  try {
    const res = await engineFetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (!res.ok) {
      // The engine's own answer to a path it does not serve lists the paths it does. That is an engine release that
      // predates this site, not a bad request and not an outage: say so, so no one is told to "try again later".
      if (res.status === 404 && body.error === "not found" && Array.isArray(body.endpoints)) {
        return {
          ok: false,
          status: 503,
          routeMissing: true,
          body,
          error: `the deployed engine does not serve ${path} yet; this capability is unavailable until the engine is redeployed`,
        };
      }
      return {
        ok: false,
        status: res.status,
        body,
        error: typeof body?.error === "string" ? body.error : `engine ${res.status}`,
      };
    }
    return { ok: true, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {},
      error: err instanceof Error ? err.message : "engine unreachable",
    };
  }
}

function creds(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers: { ...auth, "Content-Type": "application/json" } };
}

// Without Supabase configured, createDeploymentCase used to hand back a
// case_token as if the case were durably saved, while latestDeploymentCase
// unconditionally returned null for the same token — a customer could create
// a case, get redirected to /power/deploy/{token}, and find nothing there.
//
// This in-memory store makes local development coherent instead: a case
// created without Supabase configured can actually be read back and revised
// within the life of this process. It is explicitly NOT a durability
// guarantee — cleared on restart, never shared across processes or serverless
// instances — which is why every write through it still logs "not persisted
// — Supabase unset" rather than pretending to be a database.
//
// A deployed environment is not allowed to rely on it: isProductionRuntime()
// makes creating or revising a case fail explicitly there when Supabase is
// missing, rather than silently degrade to a per-instance store that would
// make retrieval succeed or fail depending on which instance happens to
// serve the next request.
const localCases = new Map<string, PowerDeploymentCaseRow[]>();

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

/**
 * The names of top-level `request` fields that differ between two revisions —
 * the actual "what changed" a customer or a Watch note reads. Deliberately
 * shallow (top-level keys, not a deep diff): `load_profile`, `generation`,
 * `bess`, `grid_firm_MW`, `target_MW`, `ride_through_hours` and `redundancy`
 * are the fields a real update touches, and naming "generation changed"
 * is more useful to a human than a line-by-line array diff would be. A deeper
 * diff belongs in the engine's own change-analysis tooling if this ever needs
 * it, not reimplemented here in TypeScript against a JSON blob.
 */
export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): string[] {
  if (!before) return []; // revision 1: nothing to compare against
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out.sort();
}

export async function createDeploymentCase(row: {
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  email?: string | null;
  company?: string | null;
  project_name?: string | null;
  engine_provenance?: Record<string, unknown> | null;
}): Promise<PowerDeploymentCaseRow | null> {
  const case_token = newCaseToken();
  const record = {
    case_token,
    revision: 1,
    email: row.email ?? null,
    company: row.company ?? null,
    project_name: row.project_name ?? null,
    request: row.request,
    result: row.result,
    changed_fields: [] as string[],
    ...(row.engine_provenance ? { engine_provenance: row.engine_provenance } : {}),
  };
  const c = creds();
  if (!c) {
    if (isProductionRuntime()) {
      console.error("[GridForge] power deployment case NOT created — Supabase is unset in production");
      return null;
    }
    console.log("[GridForge] power deployment case (not persisted — Supabase unset)");
    const row = { ...(record as PowerDeploymentCaseRow), id: "local" };
    localCases.set(case_token, [row]);
    return row;
  }
  try {
    const res = await insertRevisionRow(c, record);
    if (!res.ok) {
      console.error("[GridForge] power deployment case insert failed:", await storeFault(res));
      return null;
    }
    return ((await res.json()) as PowerDeploymentCaseRow[])[0] ?? null;
  } catch (err) {
    console.error("[GridForge] power deployment case insert unreachable:", err);
    return null;
  }
}

/** The latest revision of a case, or null if the token is unknown or the
 * store is unreachable — never throws into a page render. */
export async function latestDeploymentCase(
  case_token: string
): Promise<PowerDeploymentCaseRow | null> {
  if (!case_token) return null;
  const c = creds();
  if (!c) {
    const revisions = localCases.get(case_token);
    return revisions?.[revisions.length - 1] ?? null;
  }
  try {
    const res = await fetch(
      `${c.url}/rest/v1/power_deployment_cases?case_token=eq.${encodeURIComponent(case_token)}` +
        `&select=*&order=revision.desc&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) return null;
    return ((await res.json()) as PowerDeploymentCaseRow[])[0] ?? null;
  } catch (err) {
    console.error("[GridForge] power deployment case lookup unreachable:", err);
    return null;
  }
}

/** One specific revision of a case, or null. Revision rows are never mutated, so
 * (case_token, revision) reproduces a past input and result exactly. */
export async function deploymentCaseRevision(
  case_token: string,
  revision: number
): Promise<PowerDeploymentCaseRow | null> {
  const all = await deploymentCaseHistory(case_token);
  return all.find((r) => r.revision === revision) ?? null;
}

/** Every revision of a case, oldest first — the case's own history, for a
 * "what changed since I last looked" view across more than one step back. */
export async function deploymentCaseHistory(
  case_token: string
): Promise<PowerDeploymentCaseRow[]> {
  if (!case_token) return [];
  const c = creds();
  if (!c) return localCases.get(case_token) ?? [];
  try {
    const res = await fetch(
      `${c.url}/rest/v1/power_deployment_cases?case_token=eq.${encodeURIComponent(case_token)}` +
        `&select=*&order=revision.asc`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) return [];
    return (await res.json()) as PowerDeploymentCaseRow[];
  } catch (err) {
    console.error("[GridForge] power deployment case history unreachable:", err);
    return [];
  }
}

/**
 * Add a new revision to an existing case: re-solved request/result, and the
 * field-level change note against the immediately preceding revision. Returns
 * null if the case does not exist yet — a revision cannot be appended to a
 * case that was never created, and guessing one into existence would let a
 * typo'd token silently start a new, disconnected history.
 */
export async function appendDeploymentRevision(
  case_token: string,
  request: Record<string, unknown>,
  result: Record<string, unknown>,
  engine_provenance?: Record<string, unknown> | null
): Promise<PowerDeploymentCaseRow | null> {
  const previous = await latestDeploymentCase(case_token);
  if (!previous) return null;
  const record = {
    case_token,
    revision: previous.revision + 1,
    email: previous.email,
    company: previous.company,
    project_name: previous.project_name,
    request,
    result,
    changed_fields: changedFields(previous.request, request),
    ...(engine_provenance ? { engine_provenance } : {}),
  };
  const c = creds();
  if (!c) {
    if (isProductionRuntime()) {
      console.error("[GridForge] power deployment revision NOT saved — Supabase is unset in production");
      return null;
    }
    console.log("[GridForge] power deployment revision (not persisted — Supabase unset)");
    const row = { ...(record as PowerDeploymentCaseRow), id: "local" };
    const revisions = localCases.get(case_token) ?? [];
    revisions.push(row);
    localCases.set(case_token, revisions);
    return row;
  }
  try {
    // A case that belongs to a project writes its revision AND the project's
    // btm_case_revised event in one database transaction. A case with no project (or a
    // store without the project tables) takes the original single-insert path.
    if (await caseIsInAProject(c, case_token)) {
      const res = await fetch(`${c.url}/rest/v1/rpc/gf_append_case_revision`, {
        method: "POST",
        headers: c.headers,
        body: JSON.stringify({
          p: record,
          p_event: {
            event_type: "btm_case_revised",
            actor: "case_token_holder",
            occurred_at: new Date().toISOString(),
            payload: {},
          },
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        console.error("[GridForge] power deployment revision (with project history) failed:", await storeFault(res));
        return null;
      }
      const out = (await res.json()) as { row: PowerDeploymentCaseRow; events: number };
      return { ...out.row, project_events: out.events };
    }
    const res = await insertRevisionRow(c, record);
    if (!res.ok) {
      console.error("[GridForge] power deployment revision insert failed:", await storeFault(res));
      return null;
    }
    return ((await res.json()) as PowerDeploymentCaseRow[])[0] ?? null;
  } catch (err) {
    console.error("[GridForge] power deployment revision insert unreachable:", err);
    return null;
  }
}

async function caseIsInAProject(
  c: { url: string; headers: Record<string, string> },
  case_token: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `${c.url}/rest/v1/project_links?object_type=eq.power_deployment_case` +
        `&object_id=eq.${encodeURIComponent(case_token)}&select=id&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    // 404 = the project tables are not deployed yet: no project can own this case.
    if (!res.ok) return false;
    return ((await res.json()) as unknown[]).length > 0;
  } catch {
    return false;
  }
}
