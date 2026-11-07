// Server-only: the one place a lead row is written to the `leads` table for the scoping assistant (app/api/chat) and the contact form
// (app/api/contact).
//
// A lead is a person's name, work address, company and the words they wrote. Nothing here may put any of that in a log: a failure is
// reported as a status-level category plus a short random reference (a correlation id that carries no data), so the operator can see THAT
// a lead was lost and when, and the visitor-facing route can say so honestly. The row itself is never logged, and neither is the error a
// transport throws (its message can quote the URL and the request).

import { storeFault } from "@/lib/safe-log";
import { notifyOperatorOnce } from "@/lib/payg-operator";

export type LeadOrigin = "scoping-agent" | "contact-form";

export type LeadStoreResult =
  | { ok: true; ref: string }
  | { ok: false; category: "not_configured" | "store_rejected" | "unreachable"; ref: string };

/** A correlation id with no meaning: eight hex characters. */
function newRef(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Insert one lead row through PostgREST. Never throws; never logs the row. */
export async function storeLead(record: Record<string, unknown>, origin: LeadOrigin): Promise<LeadStoreResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ref = newRef();
  if (!url || !key) return { ok: false, category: "not_configured", ref };
  // New secret keys (sb_secret_…) go on apikey only; legacy service_role JWTs also need the Bearer header to elevate past RLS.
  const auth: Record<string, string> = key.startsWith("sb_secret_") ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
  let fault: string;
  let category: "store_rejected" | "unreachable";
  try {
    const res = await fetch(`${url}/rest/v1/leads`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(record),
    });
    // PostgREST rejects with a status, not a throw. Without this check a lead is dropped in silence — the most expensive kind of failure
    // this site has, because nothing downstream knows the person existed.
    if (res.ok) return { ok: true, ref };
    fault = await storeFault(res);
    category = "store_rejected";
  } catch (err) {
    fault = `unreachable ${err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error"}`;
    category = "unreachable";
  }
  console.error(`[GridForge] ${origin} lead NOT persisted (ref ${ref}): ${fault}`);
  return { ok: false, category, ref };
}

/**
 * Tell the operator a lead could not be stored: once per origin, category and day, so an outage is one mail and not one per visitor.
 * The notice carries the category and the correlation reference only; the lead's own words are not in it and not recoverable from it.
 */
export async function noticeLeadLost(origin: LeadOrigin, result: Extract<LeadStoreResult, { ok: false }>): Promise<void> {
  if (result.category === "not_configured") return;
  const day = new Date().toISOString().slice(0, 10);
  await notifyOperatorOnce(
    `lead_store_fault:${origin}:${result.category}:${day}`,
    "A lead could not be stored",
    `A ${origin} lead was NOT saved (${result.category}, reference ${result.ref}). The visitor's details are not in this notice or in the logs. ` +
      "Check that the Supabase store is reachable and that the leads table accepts the service role. This notice is sent once per origin, category and day."
  ).catch(() => "unsent");
}

/**
 * Tell the operator an enquiry was stored, so a lead is never silent. Goes through the same once-per-day helper (it dedupes on the key, so the
 * first enquiry of a UTC day mails the operator and later ones that day are deduplicated there). The text names no visitor, address, company or
 * message: only that something was stored, where to look, and an opaque reference. Mail goes to LEAD_TO_EMAIL (the operator's own address) and
 * nowhere else. Best effort: a failure here is swallowed and never logs anything about the enquiry.
 */
export async function noticeLeadStored(category: "contact_enquiry", ref: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await notifyOperatorOnce(
      `${category}:${day}`,
      "A contact enquiry was stored",
      `A contact enquiry was stored (reference ${ref}); see the admin leads view. This notice carries no details of the enquiry and is sent once per day.`
    );
  } catch {
    /* the lead is already stored; a notice that cannot be sent must not change the response */
  }
}
