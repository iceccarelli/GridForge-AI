// Server-only data layer for purchased deliverables.
//
// The lifecycle is deliberate. Paying does not produce a document by itself —
// the client still has to supply the hall's numbers, and a human still releases
// the result. Automating generation is leverage; automating the release would be
// selling an unreviewed engineering opinion, which is the one thing this whole
// codebase exists to refuse.
//
//   awaiting_intake -> generating -> draft -> released
//                                 \-> engine_unavailable
//
// Access is by unguessable token in the URL. That is appropriate for a document
// the holder paid for and was emailed a link to; it is not an identity system,
// and the page says so.

import crypto from "node:crypto";

export const DELIVERABLE_STATUSES = [
  "awaiting_intake",
  "generating",
  "draft",
  "released",
  "engine_unavailable",
] as const;

export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export interface DeliverableRecord {
  id: string;
  token: string;
  kind: string;
  status: DeliverableStatus;
  email: string | null;
  company: string | null;
  qualification_id: string | null;
  stripe_session_id: string | null;
  amount_cents: number | null;
  intake: Record<string, unknown> | null;
  document_html: string | null;
  document_md: string | null;
  title: string | null;
  created_at?: string;
  released_at?: string | null;
}

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
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

export async function createDeliverable(
  row: Partial<DeliverableRecord> & { kind: string }
): Promise<DeliverableRecord | null> {
  const token = row.token ?? newToken();
  const record = { status: "awaiting_intake" as DeliverableStatus, ...row, token };
  const c = creds();
  if (!c) {
    console.log("[GridForge] deliverable (not persisted — Supabase unset):", JSON.stringify(record));
    return { ...(record as DeliverableRecord), id: "local" };
  }
  const res = await fetch(`${c.url}/rest/v1/deliverables`, {
    method: "POST",
    headers: { ...c.headers, Prefer: "return=representation" },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    console.error("[GridForge] deliverable insert failed:", await res.text());
    return null;
  }
  const rows = (await res.json()) as DeliverableRecord[];
  return rows[0] ?? null;
}

export async function getByToken(token: string): Promise<DeliverableRecord | null> {
  const c = creds();
  if (!c || !token) return null;
  const res = await fetch(
    `${c.url}/rest/v1/deliverables?token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as DeliverableRecord[];
  return rows[0] ?? null;
}

export async function updateByToken(
  token: string,
  patch: Partial<DeliverableRecord>
): Promise<boolean> {
  const c = creds();
  if (!c) return false;
  const res = await fetch(
    `${c.url}/rest/v1/deliverables?token=eq.${encodeURIComponent(token)}`,
    { method: "PATCH", headers: { ...c.headers, Prefer: "return=minimal" }, body: JSON.stringify(patch) }
  );
  if (!res.ok) console.error("[GridForge] deliverable update failed:", await res.text());
  return res.ok;
}

/** Ask the engine for the rendered deliverable. Client tier: needs the API key. */
export async function renderDeliverable(
  intake: Record<string, unknown>,
  endpoint: "screen" | "study"
): Promise<{ ok: true; title: string; html: string; md: string } | { ok: false; error: string }> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base) return { ok: false, error: "GRIDFORGE_API_URL is not set" };
  if (!key) return { ok: false, error: "GRIDFORGE_API_KEY is not set — paid endpoints need it" };

  const call = async (format: "html" | "md") => {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({ intake, format }),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `engine ${res.status}`);
    return body as { title: string; document: string; document_full?: string };
  };

  try {
    const [html, md] = await Promise.all([call("html"), call("md")]);
    return { ok: true, title: html.title, html: html.document, md: md.document };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "engine unreachable" };
  }
}
