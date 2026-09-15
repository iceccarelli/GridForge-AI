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
  deck_html: string | null;
  working_files: Record<string, string> | null;
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

/**
 * The engagement already opened for a Stripe checkout session, if there is one.
 *
 * Stripe redelivers a webhook until it gets a 2xx, and the handler now returns a
 * 500 when it cannot open the engagement — which is the only way a four-figure payment
 * stops being silently orphaned. That makes a replay certain rather than unlikely,
 * so the insert has to be safe to repeat: without this lookup a retry would hand
 * one customer two intake links for one payment.
 */
export async function deliverableBySession(
  sessionId: string
): Promise<DeliverableRecord | null> {
  const c = creds();
  if (!c || !sessionId) return null;
  const res = await fetch(
    `${c.url}/rest/v1/deliverables?stripe_session_id=eq.${encodeURIComponent(sessionId)}` +
      `&select=*&limit=1`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) {
    console.error("[GridForge] deliverable by session failed:", res.status, await res.text());
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
  endpoint: "screen" | "study" | "spec"
): Promise<
  | {
      ok: true;
      title: string;
      html: string;
      md: string;
      deck: string | null;
      working: Record<string, string> | null;
      /** What binds the hall as found, straight from the engine's own payload. */
      binding: string | null;
    }
  | { ok: false; error: string }
> {
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

  const deck = async (): Promise<string | null> => {
    // The walkthrough is part of the Study engagement, not the Screen and not a
    // Specification. A failed deck must never fail the document: the document is
    // what was bought.
    if (endpoint !== "study") return null;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/deck`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ intake }),
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { document_full?: string };
      return body.document_full ?? null;
    } catch {
      return null;
    }
  };

  /**
   * The binding constraint, from the engine's structured answer.
   *
   * It used to be read only out of `scenarios.csv` in the working-file bundle —
   * and a Density Screen does not produce one. Its catalogue entry promises the
   * document, the ladder and the data request, and no working files; `/v1/screen`
   * has no csv format at all and is right not to.
   *
   * So for the Density Screen — the EUR 4,500 entry product whose whole commercial
   * purpose is to credit against the Envelope Study — the follow-on offer named a
   * generic constraint instead of the customer's own. That is the single most
   * valuable upsell in the business and it was running blind on every screen ever
   * sold. The figure was there the whole time, one field away, in the payload the
   * engine already returns.
   */
  const structured = async (): Promise<string | null> => {
    if (endpoint === "spec") return null;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ intake }),
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });
      if (!res.ok) {
        console.error("[GridForge] binding lookup failed:", res.status, await res.text());
        return null;
      }
      const body = (await res.json()) as {
        scenarios?: { as_found?: { binding_name?: string } }[];
      };
      return body.scenarios?.[0]?.as_found?.binding_name ?? null;
    } catch (err) {
      console.error("[GridForge] binding lookup error:", err);
      return null;
    }
  };

  const working = async (): Promise<Record<string, string> | null> => {
    // The tables behind the document, so the client's own engineers can check the
    // arithmetic. A failed bundle never fails the document.
    //
    // For a Specification the equivalent artefact is the response schedule: the
    // machine-readable template a supplier fills in, which is the half that makes
    // four quotations comparable. Same slot, same delivery route.
    try {
      if (endpoint === "spec") {
        const res = await fetch(`${base.replace(/\/$/, "")}/v1/spec`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": key },
          body: JSON.stringify({ intake, format: "md" }),
          signal: AbortSignal.timeout(120_000),
          cache: "no-store",
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { response_template?: unknown };
        if (!body.response_template) return null;
        return {
          "response_template.json": JSON.stringify(body.response_template, null, 2),
        };
      }
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": key },
        body: JSON.stringify({ intake, format: "csv" }),
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { files?: Record<string, string> };
      return body.files ?? null;
    } catch {
      return null;
    }
  };

  try {
    const [html, md, deckHtml, files, binding] = await Promise.all([
      call("html"),
      call("md"),
      deck(),
      working(),
      structured(),
    ]);
    return {
      ok: true,
      title: html.title,
      html: html.document,
      md: md.document,
      deck: deckHtml,
      working: files,
      binding,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "engine unreachable" };
  }
}
