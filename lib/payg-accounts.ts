// Server-only: the free allowance's account, and the lookups the pay-as-you-go routes share.
//
// A free account is an ordinary `api_accounts` row (plan `api_free`), reached the same way every API account is: by its portal
// token, which only ever leaves the server inside the emailed link. That link IS the email verification: a key is minted from the
// portal page and nowhere else, so typing somebody else's address gets them nothing and gets us a (rate-limited, cooled-down) email
// to that address.
//
// Bounded in the database: one account per normalised email (gf_free_account_create, 0033), and at most freeAccountsMax() VERIFIED
// accounts per UTC month, counted atomically at the moment the owner first mints a key (gf_free_account_verify). The ceiling is NOT
// applied at sign-up: counting unverified addresses let anyone use the allowance up without owning an inbox, and answering "full" to
// a new address only was an oracle for which addresses already have an account. Sign-up always answers the same words.

import crypto from "node:crypto";
import { newToken, type ApiAccount } from "@/lib/api-access";
import { ensureNotification } from "@/lib/notifications";
import { PAYG, accountRef, cleanEmail, freeAccountsMax, normaliseFreeEmail } from "@/lib/payg";
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
  | { ok: false; reason: "invalid_email" | "store" };

const cleanCompany = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const c = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return c || null;
};

/**
 * A readable account id with an UNGUESSABLE suffix (40 random bits). The old id was a stem plus six hex digits of a hash of the
 * email: guessable, and short enough that an attacker could pre-register a colliding id for somebody else's address and lock them
 * out. Existing accounts keep the ids they have.
 */
export function freeAccountId(norm: string): string {
  const stem = norm.split("@")[0].replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "account";
  return `${stem}-${crypto.randomBytes(5).toString("hex")}`;
}

/** Minimum time between two emails of the portal link to the same address, however often it is asked for. */
export const FREE_RESEND_COOLDOWN_MS = 6 * 3_600_000;

/**
 * Create (or find) the free account for an email and make the access email a durable obligation. The caller answers the visitor
 * with the SAME words whichever happened, so the response cannot be used to learn whether an address already has an account.
 */
export async function createFreeAccount(rawEmail: unknown, rawCompany: unknown, now: Date = new Date()): Promise<FreeAccountResult> {
  const norm = normaliseFreeEmail(rawEmail);
  const email = cleanEmail(rawEmail);
  if (!norm || !email) return { ok: false, reason: "invalid_email" };

  // A colliding account id or token (unique_violation) is retried with fresh random values; it cannot be steered by an attacker.
  let created: { created: boolean; id?: string } | null = null;
  let account = "";
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    account = freeAccountId(norm);
    const r = await rpc<{ created: boolean; id?: string }>("gf_free_account_create", {
      p_email_norm: norm, p_email: email, p_company: cleanCompany(rawCompany), p_token: newToken(), p_account: account, p_units: PAYG.freeAllowanceUnits,
    });
    if (r.ok && r.data) {
      created = r.data;
    } else if (!(!r.ok && r.code === "23505")) {
      return { ok: false, reason: "store" };
    }
  }
  if (!created?.id) return { ok: false, reason: "store" };
  const id = created.id;

  if (created.created) {
    // The account NAME, so the same account carries the same reference at every later step (key, first use, pay-as-you-go, first charge).
    const ref = accountRef(account);
    await recordFunnelEvent("free_account_created", { plan: "api_free", account_ref: ref }, { dedupeKey: `free_account_created:${ref}` });
    const o = await ensureNotification("api_access_link", id);
    return o.state === "unavailable" && o.reason === "store_error" ? { ok: true, created: true, delivery: "retry" } : { ok: true, created: true, delivery: "queued" };
  }

  // An address that already has an account: finish the first email if it is still outstanding; otherwise (it was accepted, or
  // abandoned) send the link again, but NEVER within the cooldown of the last one, which is what a visitor who lost it needs and
  // bounds what anyone can make us send to an address that is not theirs.
  const first = await ensureNotification("api_access_link", id);
  if (first.state === "accepted" || first.state === "pending" || first.state === "accepted_unrecorded") return { ok: true, created: false, delivery: "queued" };
  if (first.state === "unavailable" && first.reason === "store_error") return { ok: true, created: false, delivery: "retry" };

  const cutoff = new Date(now.getTime() - FREE_RESEND_COOLDOWN_MS).toISOString();
  const recent = await pg<{ id: string }[]>("GET", `customer_notifications?kind=eq.api_access_link&subject_id=eq.${enc(id)}&created_at=gte.${enc(cutoff)}&select=id&limit=2`);
  if (!recent.ok) return { ok: true, created: false, delivery: "retry" };
  // The very first notification is older than the cooldown only if it was created more than 6 h ago; `recent` holds any link email
  // queued inside the window (the first one counts), so a resend needs the window to be clear.
  if ((recent.data?.length ?? 0) > 0) return { ok: true, created: false, delivery: "queued" };
  const again = await ensureNotification("api_access_link", id, `resend:${now.toISOString().slice(0, 13)}`);
  return again.state === "unavailable" && again.reason === "store_error" ? { ok: true, created: false, delivery: "retry" } : { ok: true, created: false, delivery: "queued" };
}

/**
 * First use of the emailed link to mint a key: count this account against the month's VERIFIED ceiling, atomically. Idempotent for
 * an account already verified. `capacity` means the month's allowance for new verified accounts is used up.
 */
export async function verifyFreeAccount(token: string, max: number = freeAccountsMax()): Promise<"ok" | "capacity" | "unknown" | "error"> {
  const r = await rpc<{ ok: boolean; reason?: string }>("gf_free_account_verify", { p_token: token, p_max: max });
  if (!r.ok || !r.data) return "error";
  if (r.data.ok) return "ok";
  return r.data.reason === "capacity" ? "capacity" : "unknown";
}
