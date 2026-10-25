import { storeFault } from "@/lib/safe-log";
import { pauseDue } from "@/lib/billing-pause-due";
import { pauseAllowsAccess, type PauseRow } from "@/lib/pause-reconcile";
// Server-only data layer for GridForge Intelligence subscriptions and the
// scenarios a subscriber saves.
//
// This file exists because three routes were each talking to `subscriptions`
// inline, with three different error handlings, against a table that had no
// migration. PostgREST answers a missing table with 404; `fetch` does not throw
// on 404; every one of those call sites caught only thrown errors. So the write
// failed silently and every read resolved to "not subscribed" — a customer paid a
// real monthly Stripe subscription and was shown the unsubscribed view forever,
// with nothing in any log saying why.
//
// Two rules follow, and they are the reason this is one module rather than three
// call sites:
//
//   1. A request that did not succeed is never reported as an empty result. Every
//      fetch here checks `res.ok` and says so out loud. Callers get `null` for
//      "could not answer" and a value for "answered", and the gate functions fail
//      CLOSED — but loudly, so a missing table looks like a missing table.
//   2. Stripe delivers a webhook more than once. recordSubscription() is keyed on
//      the checkout session id and is safe to replay.

export type SubscriptionStatus = "active" | "past_due" | "cancelled" | "superseded";

export interface SubscriptionRecord {
  id: string;
  created_at?: string;
  updated_at?: string;
  email: string;
  plan: string;
  status: SubscriptionStatus;
  stripe_session_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** Stripe event.created of the newest invoice event applied to this subscription (migration 0039). */
  last_billing_event_ts?: number | null;
  /** A pause scheduled for the end of the paid period (migration 0043): see lib/billing-pause.ts. */
  billing_pause_from?: string | null;
  billing_pause_resumes_at?: string | null;
  billing_pause_event_ts?: number | null;
}

export interface ScenarioRecord {
  id: string;
  created_at?: string;
  email: string;
  name: string;
  mw: number;
  region_id: string | null;
  value_per_mw_month: number;
  months_saved: number;
  avoided_eur: number;
}

/** Same shape as lib/watches.ts — one place that knows how the key is presented. */
function rest(path: string): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return {
    url: `${url}/rest/v1/${path}`,
    headers: { ...auth, "Content-Type": "application/json", Accept: "application/json" },
  };
}

/** Configured at all? Callers distinguish "no store" from "store said no". */
export function subscriptionsConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function normaliseEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

// --- subscriptions ---------------------------------------------------------

/**
 * The statuses that entitle somebody to the paid view.
 *
 * `past_due` is in here deliberately. Stripe retries a failed payment for days
 * before it gives up and sends customer.subscription.deleted; cutting access off
 * at the first failure would lock out a customer whose card clears on Thursday,
 * which is the exact mirror of the bug this module exists to fix. The repository
 * already made this call for Hall Watch — "a card that fails on Tuesday and
 * clears on Thursday should not cost the client a quarter" — and the reasoning is
 * no different here.
 */
const ENTITLING = "in.(active,past_due)";

/**
 * What a new purchase supersedes: everything that entitles, AND a row suspended by a refund, dispute or pause hold (lib/billing-holds.ts).
 * A suspended row entitles nothing today, but lifting its hold would bring it back next to the purchase that replaced it (and the
 * partial unique index on status = 'active' would refuse the lift), so a replaced suspended row is superseded for good.
 */
const SUPERSEDABLE = "in.(active,past_due,suspended)";

/**
 * The result of asking the store about somebody.
 *
 * "No subscription" and "could not ask" are different answers and collapsing them
 * into one `null` is the whole defect: a 404 from a missing table became a claim
 * about the CUSTOMER — that they had not subscribed — rather than a claim about
 * US. Callers that gate access still treat both as a denial, because failing
 * closed is correct; callers that report status to a human must be able to tell
 * the customer which one it was.
 */
export type SubscriptionLookup =
  | { reachable: true; subscription: SubscriptionRecord | null }
  | { reachable: false; subscription: null };

const UNREACHABLE: SubscriptionLookup = { reachable: false, subscription: null };

export type EntitlementRole = "owner" | "member";

/**
 * What a verified address is entitled to, and by what right.
 *
 * `owner` is the billing owner of the subscription (subscriptions.email). `member` holds a seat on somebody else's: the
 * subscription is theirs, the access is the same, and it ends the moment the owner's subscription stops entitling or the seat
 * is removed (migration 0027). There is no second copy of "is this plan paid" for a member: it is the owner's row, read now.
 */
export interface Entitlement {
  subscription: SubscriptionRecord;
  role: EntitlementRole;
  /** The billing owner's address: the caller's own for an owner. */
  ownerEmail: string;
}

export type EntitlementLookup =
  | { reachable: true; entitlement: Entitlement | null }
  | { reachable: false; entitlement: null };

const ENTITLEMENT_UNREACHABLE: EntitlementLookup = { reachable: false, entitlement: null };

const ENTITLING_STATUSES: ReadonlySet<string> = new Set(["active", "past_due"]);

/**
 * The seat a non-owner holds, asked of the database in one snapshot (gf_member_entitlement).
 *
 * A database that does not have the function yet answers 404 PGRST202. Memberships cannot exist before migration 0027 created
 * their table, so that is an accurate "this address has no seat", not a guess, and it keeps the deploy window harmless for
 * every non-subscriber (the repository's rule: make the deploy order not matter). Anything else that is not a clean answer is
 * "could not ask", which denies and is reported as our fault.
 */
let warnedNoMembership = false;

async function lookupMembership(email: string): Promise<EntitlementLookup> {
  const r = rest("rpc/gf_member_entitlement");
  if (!r) return ENTITLEMENT_UNREACHABLE;
  let res: Response;
  try {
    res = await fetch(r.url, {
      method: "POST",
      headers: r.headers,
      body: JSON.stringify({ p_email: email }),
      cache: "no-store",
    });
  } catch (err) {
    console.error("[GridForge] membership lookup unreachable:", err);
    return ENTITLEMENT_UNREACHABLE;
  }
  if (!res.ok) {
    if (res.status === 404) {
      const code = ((await res.clone().json().catch(() => ({}))) as { code?: unknown }).code;
      if (code === "PGRST202") {
        if (!warnedNoMembership) {
          warnedNoMembership = true;
          console.error("[GridForge] gf_member_entitlement not found (migration 0027 not applied, or PostgREST's schema cache is stale): no seats are honoured until it is");
        }
        return { reachable: true, entitlement: null };
      }
    }
    console.error("[GridForge] membership lookup failed:", await storeFault(res));
    return ENTITLEMENT_UNREACHABLE;
  }
  const found = (await res.json().catch(() => undefined)) as
    | { owner_email?: unknown; subscription?: SubscriptionRecord }
    | null
    | undefined;
  if (found === undefined) return ENTITLEMENT_UNREACHABLE;
  if (found === null) return { reachable: true, entitlement: null };
  const sub = found.subscription;
  // Belt and braces: whatever the database said, a row that is not an entitling subscription of that owner grants nothing.
  if (
    !sub || typeof sub.id !== "string" || !ENTITLING_STATUSES.has(sub.status) ||
    typeof found.owner_email !== "string" || normaliseEmail(sub.email) !== found.owner_email
  ) {
    return { reachable: true, entitlement: null };
  }
  // A seat inherits the owner's decision, including a pause whose paid period is over (one rule: lib/pause-reconcile.ts).
  if (pauseDue(sub)) {
    if (!(await pauseAllowsAccess("subscriptions", sub as unknown as PauseRow))) return { reachable: true, entitlement: null };
    sub.billing_pause_from = null;
    sub.billing_pause_resumes_at = null;
  }
  return { reachable: true, entitlement: { subscription: sub, role: "member", ownerEmail: found.owner_email } };
}

/**
 * The caller's entitlement and whether we managed to ask at all. Every subscriber-only route gates on this (directly or through
 * lookupSubscription), so a seat is honoured on the server for the web page and a direct API call alike.
 *
 * The owner's own subscription is read first and exactly as before; only an address with none of its own is checked for a seat.
 */
export async function lookupEntitlement(email: string): Promise<EntitlementLookup> {
  const e = normaliseEmail(email);
  if (!e) return { reachable: true, entitlement: null };
  const r = rest(
    `subscriptions?email=eq.${encodeURIComponent(e)}&status=${ENTITLING}` +
      `&select=*&order=created_at.desc&limit=1`
  );
  if (!r) return ENTITLEMENT_UNREACHABLE;
  let res: Response;
  try {
    res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
  } catch (err) {
    console.error("[GridForge] subscription lookup unreachable:", err);
    return ENTITLEMENT_UNREACHABLE;
  }
  if (!res.ok) {
    console.error("[GridForge] subscription lookup failed:", await storeFault(res));
    return ENTITLEMENT_UNREACHABLE;
  }
  const rows = (await res.json()) as SubscriptionRecord[];
  // A pause scheduled for the end of the paid period (lib/billing-pause.ts) entitles nothing once that instant has passed, even before the
  // daily job writes the hold: the subscriber has had the period they paid for, and the free view follows it. UNLESS Stripe says billing is
  // running again (a resume event that was lost or is late): lib/pause-reconcile.ts asks once, clears the stale schedule and grants; a Stripe
  // that is still paused, silent or unconfigured denies.
  if (rows[0]) {
    if (!pauseDue(rows[0])) return { reachable: true, entitlement: { subscription: rows[0], role: "owner", ownerEmail: e } };
    if (await pauseAllowsAccess("subscriptions", rows[0] as unknown as PauseRow)) {
      return { reachable: true, entitlement: { subscription: { ...rows[0], billing_pause_from: null, billing_pause_resumes_at: null }, role: "owner", ownerEmail: e } };
    }
  }
  return lookupMembership(e);
}

/** The caller's entitling subscription (their own, or the one they hold a seat on), and whether we managed to ask at all. */
export async function lookupSubscription(email: string): Promise<SubscriptionLookup> {
  const found = await lookupEntitlement(email);
  if (!found.reachable) return UNREACHABLE;
  return { reachable: true, subscription: found.entitlement?.subscription ?? null };
}

/** Convenience for gates. Fails closed — a store we cannot reach grants nothing. */
export async function activeSubscription(email: string): Promise<SubscriptionRecord | null> {
  return (await lookupSubscription(email)).subscription;
}

export async function hasActiveSubscription(email: string): Promise<boolean> {
  return (await activeSubscription(email)) !== null;
}

/**
 * Resolve a Stripe lifecycle event back to the row it belongs to, keeping "the store could not be
 * read" apart from "no such subscription" (acknowledging a cancellation that was never applied is
 * the failure this distinction exists to prevent).
 */
export async function lookupSubscriptionByStripeId(
  subscriptionId: string
): Promise<{ ok: true; row: SubscriptionRecord | null } | { ok: false }> {
  if (!subscriptionId) return { ok: true, row: null };
  const r = rest(
    `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}` +
      `&select=*&order=created_at.desc&limit=1`
  );
  if (!r) return { ok: false };
  try {
    const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
    if (!res.ok) {
      console.error("[GridForge] subscription by stripe id failed:", await storeFault(res));
      return { ok: false };
    }
    return { ok: true, row: ((await res.json()) as SubscriptionRecord[])[0] ?? null };
  } catch (err) {
    console.error("[GridForge] subscription by stripe id unreachable:", err);
    return { ok: false };
  }
}

export async function subscriptionByStripeId(
  subscriptionId: string
): Promise<SubscriptionRecord | null> {
  const found = await lookupSubscriptionByStripeId(subscriptionId);
  return found.ok ? found.row : null;
}

export async function subscriptionBySession(sessionId: string): Promise<SubscriptionRecord | null> {
  if (!sessionId) return null;
  const r = rest(
    `subscriptions?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=*&limit=1`
  );
  if (!r) return null;
  const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
  if (!res.ok) return null;
  const rows = (await res.json()) as SubscriptionRecord[];
  return rows[0] ?? null;
}

export async function updateSubscription(
  id: string,
  patch: Partial<SubscriptionRecord>
): Promise<boolean> {
  const r = rest(`subscriptions?id=eq.${encodeURIComponent(id)}`);
  if (!r) return false;
  const res = await fetch(r.url, {
    method: "PATCH",
    headers: { ...r.headers, Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    console.error("[GridForge] subscription update failed:", await storeFault(res));
    return false;
  }
  return true;
}

/**
 * Record a completed Intelligence checkout.
 *
 * Idempotent on the checkout session id, because Stripe retries a webhook until
 * it gets a 2xx and a retry must not create a second entitlement.
 *
 * A new subscription supersedes any earlier active one for the same email. The
 * database enforces this too (one partial unique index on status = 'active'), so
 * the two cannot drift: if the supersede ever fails, the insert fails as well
 * rather than quietly leaving two active rows for one payer.
 *
 * Returns the row, or null if it could not be written — and a null here is a
 * customer who has paid and has nothing, so it is logged as an error and the
 * caller must not report success.
 */
export async function recordSubscription(p: {
  email: string;
  plan: string;
  sessionId: string;
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<SubscriptionRecord | null> {
  const email = normaliseEmail(p.email);
  if (!email) {
    console.error("[GridForge] subscription record skipped: no email on session", p.sessionId);
    return null;
  }
  if (!subscriptionsConfigured()) {
    console.error(
      "[GridForge] subscription NOT persisted — Supabase unset. Paid subscription, plan",
      p.plan,
      "session",
      p.sessionId
    );
    return null;
  }

  const existing = await subscriptionBySession(p.sessionId);
  if (existing) return existing; // replayed webhook

  // WHO may supersede an existing entitlement. The email on a checkout session is typed by whoever pays (Checkout's own field, or
  // a client-supplied customer_email), so it proves nothing about who owns it. Superseding on the email alone let a stranger pay
  // for the cheapest plan with a victim's address and strip the victim's seats. A new purchase replaces an existing entitling
  // subscription ONLY when it is the same Stripe customer (the same payer, e.g. an upgrade started from the signed-in portal, which
  // reuses the customer). Any other payer's purchase is recorded as `superseded` from the start: it entitles nothing, the existing
  // subscription and its seats are untouched, and the webhook tells the operator (who refunds or merges deliberately).
  const prior = rest(`subscriptions?email=eq.${encodeURIComponent(email)}&status=${SUPERSEDABLE}&select=id,stripe_customer_id`);
  if (!prior) return null;
  const priorRes = await fetch(prior.url, { headers: prior.headers, cache: "no-store" });
  if (!priorRes.ok) {
    console.error("[GridForge] could not read prior subscriptions:", await storeFault(priorRes));
    return null;
  }
  const priorRows = (await priorRes.json()) as { id: string; stripe_customer_id: string | null }[];
  // (A checkout always names its customer in production; two records that BOTH carry none cannot be told apart and are not
  // treated as different payers, which is what keeps record-level callers that never had a customer id working.)
  const foreign = priorRows.some((r) => (r.stripe_customer_id ?? null) !== (p.customerId ?? null));
  if (foreign) {
    const r = rest("subscriptions");
    if (!r) return null;
    const res = await fetch(r.url, {
      method: "POST",
      headers: { ...r.headers, Prefer: "return=representation" },
      body: JSON.stringify({
        email,
        plan: p.plan,
        status: "superseded",
        stripe_session_id: p.sessionId,
        stripe_customer_id: p.customerId ?? null,
        stripe_subscription_id: p.subscriptionId ?? null,
      }),
    });
    if (!res.ok) {
      console.error("[GridForge] unentitled subscription record FAILED: session", p.sessionId, await storeFault(res));
      return null;
    }
    return ((await res.json()) as SubscriptionRecord[])[0] ?? null;
  }

  // Supersede everything that still entitles this email (all of it the same payer's), so the partial unique
  // index cannot reject the insert below AND an abandoned past_due row cannot go
  // on granting access after the subscription that replaced it is cancelled.
  const sup = rest(`subscriptions?email=eq.${encodeURIComponent(email)}&status=${SUPERSEDABLE}`);
  if (sup) {
    const res = await fetch(sup.url, {
      method: "PATCH",
      headers: { ...sup.headers, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "superseded", updated_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.error("[GridForge] could not supersede prior subscription:", await storeFault(res));
      return null;
    }
  }

  const r = rest("subscriptions");
  if (!r) return null;
  const res = await fetch(r.url, {
    method: "POST",
    headers: { ...r.headers, Prefer: "return=representation" },
    body: JSON.stringify({
      email,
      plan: p.plan,
      status: "active",
      stripe_session_id: p.sessionId,
      stripe_customer_id: p.customerId ?? null,
      stripe_subscription_id: p.subscriptionId ?? null,
    }),
  });
  if (!res.ok) {
    console.error(
      "[GridForge] subscription insert FAILED for a paying customer: session",
      p.sessionId,
      await storeFault(res)
    );
    return null;
  }
  const rows = (await res.json()) as SubscriptionRecord[];
  return rows[0] ?? null;
}

// --- saved scenarios -------------------------------------------------------

export async function listScenarios(email: string): Promise<ScenarioRecord[] | null> {
  const e = normaliseEmail(email);
  if (!e) return [];
  const r = rest(
    `scenarios?email=eq.${encodeURIComponent(e)}&select=*&order=created_at.desc&limit=200`
  );
  if (!r) return null;
  const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
  if (!res.ok) {
    console.error("[GridForge] scenario list failed:", await storeFault(res));
    return null;
  }
  return (await res.json()) as ScenarioRecord[];
}

export async function createScenario(row: {
  email: string;
  name: string;
  mw: number;
  regionId: string;
  valuePerMwMonth: number;
  monthsSaved: number;
  avoidedEur: number;
}): Promise<ScenarioRecord | null> {
  const r = rest("scenarios");
  if (!r) return null;
  const res = await fetch(r.url, {
    method: "POST",
    headers: { ...r.headers, Prefer: "return=representation" },
    body: JSON.stringify({
      email: normaliseEmail(row.email),
      name: row.name,
      mw: row.mw,
      region_id: row.regionId,
      value_per_mw_month: row.valuePerMwMonth,
      months_saved: row.monthsSaved,
      avoided_eur: row.avoidedEur,
    }),
  });
  if (!res.ok) {
    console.error("[GridForge] scenario insert failed:", await storeFault(res));
    return null;
  }
  const rows = (await res.json()) as ScenarioRecord[];
  return rows[0] ?? null;
}

/**
 * Delete one scenario belonging to this caller.
 *
 * Scoped on id AND email in a single statement, so one subscriber cannot delete
 * another's row by guessing a uuid — the filter, not a prior read, is what makes
 * that impossible. `return=representation` tells us whether anything matched, so
 * a cross-tenant attempt is reported as a miss rather than as a success.
 */
export async function deleteScenario(email: string, id: string): Promise<boolean> {
  const e = normaliseEmail(email);
  if (!e || !id) return false;
  const r = rest(
    `scenarios?id=eq.${encodeURIComponent(id)}&email=eq.${encodeURIComponent(e)}`
  );
  if (!r) return false;
  const res = await fetch(r.url, {
    method: "DELETE",
    headers: { ...r.headers, Prefer: "return=representation" },
  });
  if (!res.ok) {
    console.error("[GridForge] scenario delete failed:", await storeFault(res));
    return false;
  }
  const rows = (await res.json()) as ScenarioRecord[];
  return rows.length > 0;
}
