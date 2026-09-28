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
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base) return { ok: false, error: "GRIDFORGE_API_URL is not set" };
  if (!key) return { ok: false, error: "GRIDFORGE_API_KEY is not set — paid endpoints need it" };
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/power/deploy/assess`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: typeof body?.error === "string" ? body.error : `engine ${res.status}` };
    }
    return { ok: true, result: body as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "engine unreachable" };
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
  };
  const c = creds();
  if (!c) {
    console.log("[GridForge] power deployment case (not persisted — Supabase unset)");
    return { ...(record as PowerDeploymentCaseRow), id: "local" };
  }
  try {
    const res = await fetch(`${c.url}/rest/v1/power_deployment_cases`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify(record),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[GridForge] power deployment case insert failed:", await res.text());
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
  const c = creds();
  if (!c || !case_token) return null;
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

/** Every revision of a case, oldest first — the case's own history, for a
 * "what changed since I last looked" view across more than one step back. */
export async function deploymentCaseHistory(
  case_token: string
): Promise<PowerDeploymentCaseRow[]> {
  const c = creds();
  if (!c || !case_token) return [];
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
  result: Record<string, unknown>
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
  };
  const c = creds();
  if (!c) {
    console.log("[GridForge] power deployment revision (not persisted — Supabase unset)");
    return { ...(record as PowerDeploymentCaseRow), id: "local" };
  }
  try {
    const res = await fetch(`${c.url}/rest/v1/power_deployment_cases`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify(record),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[GridForge] power deployment revision insert failed:", await res.text());
      return null;
    }
    return ((await res.json()) as PowerDeploymentCaseRow[])[0] ?? null;
  } catch (err) {
    console.error("[GridForge] power deployment revision insert unreachable:", err);
    return null;
  }
}
