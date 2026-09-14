// Server-only data layer for Hall Watch.
//
// A watch holds a hall's inputs and the answer as last reported. Re-solving is
// cheap; the value is in the comparison, and in being the only party holding the
// model when the client asks "what moved?".
//
// Two things trigger a run: the client updates an input, or the schedule comes
// round and our own libraries have moved since. Both are real. Neither invents a
// finding — "nothing material changed" is a legitimate note and is sent as three
// lines rather than padded into a document.

import crypto from "node:crypto";

export type WatchStatus = "active" | "paused" | "cancelled";
export type Cadence = "monthly" | "quarterly";

export interface WatchRecord {
  id: string;
  created_at?: string;
  token: string;
  status: WatchStatus;
  cadence: Cadence;
  email: string | null;
  company: string | null;
  site_name: string | null;
  hall_id: string | null;
  intake: Record<string, unknown> | null;
  last_state: Record<string, unknown> | null;
  last_run_at: string | null;
  next_run_at: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
}

export interface WatchNote {
  id: string;
  created_at: string;
  watch_id: string;
  material: boolean;
  headline: string | null;
  racks_delta: number | null;
  weeks_delta: number | null;
  binding_moved: boolean | null;
  document_html: string | null;
  document_md: string | null;
  change: Record<string, unknown> | null;
  trigger: string;
}

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function nextRun(from: Date, cadence: Cadence): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + (cadence === "monthly" ? 1 : 3));
  return d.toISOString();
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

export async function createWatch(
  row: Partial<WatchRecord> & { email?: string | null }
): Promise<WatchRecord | null> {
  const token = row.token ?? newToken();
  const cadence: Cadence = row.cadence ?? "quarterly";
  const record = {
    status: "active" as WatchStatus,
    cadence,
    next_run_at: nextRun(new Date(), cadence),
    ...row,
    token,
  };
  const c = creds();
  if (!c) {
    console.log("[GridForge] watch (not persisted — Supabase unset):", JSON.stringify(record));
    return { ...(record as WatchRecord), id: "local" };
  }
  const res = await fetch(`${c.url}/rest/v1/watches`, {
    method: "POST",
    headers: { ...c.headers, Prefer: "return=representation" },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    console.error("[GridForge] watch insert failed:", await res.text());
    return null;
  }
  return ((await res.json()) as WatchRecord[])[0] ?? null;
}

export async function getWatch(token: string): Promise<WatchRecord | null> {
  const c = creds();
  if (!c || !token) return null;
  const res = await fetch(
    `${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) return null;
  return ((await res.json()) as WatchRecord[])[0] ?? null;
}

export async function dueWatches(limit = 25): Promise<WatchRecord[]> {
  const c = creds();
  if (!c) return [];
  const now = new Date().toISOString();
  const res = await fetch(
    `${c.url}/rest/v1/watches?status=eq.active&intake=not.is.null` +
      `&or=(next_run_at.is.null,next_run_at.lte.${now})&select=*&order=next_run_at.asc&limit=${limit}`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) {
    console.error("[GridForge] dueWatches failed:", await res.text());
    return [];
  }
  return (await res.json()) as WatchRecord[];
}

export async function updateWatch(token: string, patch: Partial<WatchRecord>): Promise<boolean> {
  const c = creds();
  if (!c) return false;
  const res = await fetch(`${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(token)}`, {
    method: "PATCH",
    headers: { ...c.headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) console.error("[GridForge] watch update failed:", await res.text());
  return res.ok;
}

export async function recordNote(row: Partial<WatchNote> & { watch_id: string }): Promise<boolean> {
  const c = creds();
  if (!c) {
    console.log("[GridForge] watch note (not persisted):", JSON.stringify(row).slice(0, 400));
    return false;
  }
  const res = await fetch(`${c.url}/rest/v1/watch_notes`, {
    method: "POST",
    headers: { ...c.headers, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) console.error("[GridForge] watch note insert failed:", await res.text());
  return res.ok;
}

export async function notesFor(watchId: string, limit = 12): Promise<WatchNote[]> {
  const c = creds();
  if (!c) return [];
  const res = await fetch(
    `${c.url}/rest/v1/watch_notes?watch_id=eq.${watchId}&select=*&order=created_at.desc&limit=${limit}`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) return [];
  return (await res.json()) as WatchNote[];
}

export interface DiffOutcome {
  headline: string;
  material: boolean;
  racks_delta: number;
  weeks_delta: number | null;
  binding_moved: boolean;
  after: Record<string, unknown>;
  document?: string;
  document_full?: string;
  markdown?: string;
  [k: string]: unknown;
}

/** Re-solve a watched hall and compare against the answer last reported.
 *  `previousState` absent means this is the first run: there is nothing to
 *  compare to, so the note records the baseline instead of inventing a change. */
export async function runWatch(
  intake: Record<string, unknown>,
  previousState: Record<string, unknown> | null,
  before?: Record<string, unknown> | null
): Promise<{ ok: true; diff: DiffOutcome } | { ok: false; error: string }> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base || !key) return { ok: false, error: "GRIDFORGE_API_URL / _API_KEY are not set" };

  const call = async (format: "html" | "md") => {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({
        after: intake,
        ...(before ? { before } : previousState ? { previous_state: previousState } : {}),
        format,
      }),
      signal: AbortSignal.timeout(180_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `engine ${res.status}`);
    return body as DiffOutcome;
  };

  if (!previousState && !before) {
    return { ok: false, error: "no baseline to compare against" };
  }

  try {
    const [html, md] = await Promise.all([call("html"), call("md")]);
    return { ok: true, diff: { ...html, markdown: md.document as string } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "engine unreachable" };
  }
}
