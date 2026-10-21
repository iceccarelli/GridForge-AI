// Server-only: the free allowance's account, and the lookups the pay-as-you-go routes share.
//
// A free account is an ordinary `api_accounts` row (plan `api_free`), reached the same way every API account is: by its portal
// token, which only ever leaves the server inside the emailed link. That link IS the email verification: a key is minted from the
// portal page and nowhere else, so typing somebody else's address gets them nothing and gets us a (rate-limited, daily-capped)
// email to that address.
//
// Bounded, in the database and atomically (gf_free_account_create, 0028): one account per normalised email, and at most
// freeAccountsMax() new free accounts per UTC month site-wide.

import { accountIdFor, newToken, type ApiAccount } from "@/lib/api-access";
import { ensureNotification } from "@/lib/notifications";
import { PAYG, accountRef, freeAccountsMax, normaliseFreeEmail } from "@/lib/payg";
import { recordFunnelEvent } from "@/lib/funnel";
import { enc, pg, rpc } from "@/lib/payg-store";

export async function accountByToken(token: string): Promise<ApiAccount | null | "error"> {
  if (!token || token.length > 200) return null;
  const r = await pg<ApiAccount[]>("GET", `api_accounts?token=eq.${enc(token)}&limit=1`);
  if (!r.ok) return "error";
  return r.data?.[0] ?? null;
}

export type FreeAccountResult =
  | { ok: true; created: boolean; delivery: "queued" | "retry" }
  | { ok: false; reason: "invalid_email" | "capacity" | "store" };

const cleanCompany = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const c = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return c || null;
};

/**
 * Create (or find) the free account for an email and make the access email a durable obligation. The caller answers the visitor
 * with the SAME words whichever happened, so the response cannot be used to learn whether an address already has an account.
 */
export async function createFreeAccount(rawEmail: unknown, rawCompany: unknown, now: Date = new Date()): Promise<FreeAccountResult> {
  const norm = normaliseFreeEmail(rawEmail);
  if (!norm) return { ok: false, reason: "invalid_email" };
  const email = String(rawEmail).trim().toLowerCase();
  const r = await rpc<{ created: boolean; id?: string; reason?: string }>("gf_free_account_create", {
    p_email_norm: norm,
    p_email: email,
    p_company: cleanCompany(rawCompany),
    p_token: newToken(),
    p_account: accountIdFor(norm, "", null),
    p_units: PAYG.freeAllowanceUnits,
    p_max: freeAccountsMax(),
  });
  if (!r.ok || !r.data) return { ok: false, reason: "store" };
  if (!r.data.created && r.data.reason === "capacity") return { ok: false, reason: "capacity" };
  if (!r.data.id) return { ok: false, reason: "store" };
  const id = r.data.id;

  if (r.data.created) {
    await recordFunnelEvent("free_account_created", { plan: "api_free", account_ref: accountRef(accountIdFor(norm, "", null)) }, { dedupeKey: `free_account_created:${accountRef(accountIdFor(norm, "", null))}` });
    const o = await ensureNotification("api_access_link", id);
    return o.state === "unavailable" && o.reason === "store_error" ? { ok: true, created: true, delivery: "retry" } : { ok: true, created: true, delivery: "queued" };
  }

  // An address that already has an account: finish the first email if it is still outstanding; otherwise (it was accepted, or
  // abandoned) send the link again, at most once per UTC day, which is what a visitor who lost it needs and bounds what anyone
  // can make us send to an address that is not theirs.
  const first = await ensureNotification("api_access_link", id);
  if (first.state === "accepted" || first.state === "pending" || first.state === "accepted_unrecorded") return { ok: true, created: false, delivery: "queued" };
  if (first.state === "unavailable" && first.reason === "store_error") return { ok: true, created: false, delivery: "retry" };
  const again = await ensureNotification("api_access_link", id, `resend:${now.toISOString().slice(0, 10)}`);
  return again.state === "unavailable" && again.reason === "store_error" ? { ok: true, created: false, delivery: "retry" } : { ok: true, created: false, delivery: "queued" };
}
