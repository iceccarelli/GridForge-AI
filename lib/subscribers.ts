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

/** The caller's entitling subscription, and whether we managed to ask at all. */
export async function lookupSubscription(email: string): Promise<SubscriptionLookup> {
  const e = normaliseEmail(email);
  if (!e) return { reachable: true, subscription: null };
  const r = rest(
    `subscriptions?email=eq.${encodeURIComponent(e)}&status=${ENTITLING}` +
      `&select=*&order=created_at.desc&limit=1`
  );
  if (!r) return UNREACHABLE;
  let res: Response;
  try {
    res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
  } catch (err) {
    console.error("[GridForge] subscription lookup unreachable:", err);
    return UNREACHABLE;
  }
  if (!res.ok) {
    console.error("[GridForge] subscription lookup failed:", res.status, await res.text());
    return UNREACHABLE;
  }
  const rows = (await res.json()) as SubscriptionRecord[];
  return { reachable: true, subscription: rows[0] ?? null };
}

/** Convenience for gates. Fails closed — a store we cannot reach grants nothing. */
export async function activeSubscription(email: string): Promise<SubscriptionRecord | null> {
  return (await lookupSubscription(email)).subscription;
}

export async function hasActiveSubscription(email: string): Promise<boolean> {
  return (await activeSubscription(email)) !== null;
}

/** Resolve a Stripe lifecycle event back to the row it belongs to. */
export async function subscriptionByStripeId(
  subscriptionId: string
): Promise<SubscriptionRecord | null> {
  if (!subscriptionId) return null;
  const r = rest(
    `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}` +
      `&select=*&order=created_at.desc&limit=1`
  );
  if (!r) return null;
  const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
  if (!res.ok) {
    console.error("[GridForge] subscription by stripe id failed:", res.status, await res.text());
    return null;
  }
  const rows = (await res.json()) as SubscriptionRecord[];
  return rows[0] ?? null;
}

async function subscriptionBySession(sessionId: string): Promise<SubscriptionRecord | null> {
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
    console.error("[GridForge] subscription update failed:", res.status, await res.text());
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
      "[GridForge] subscription NOT persisted — Supabase unset. Paid subscription for",
      email,
      "plan",
      p.plan,
      "session",
      p.sessionId
    );
    return null;
  }

  const existing = await subscriptionBySession(p.sessionId);
  if (existing) return existing; // replayed webhook

  // Supersede everything that still entitles this email, so the partial unique
  // index cannot reject the insert below AND an abandoned past_due row cannot go
  // on granting access after the subscription that replaced it is cancelled.
  const sup = rest(`subscriptions?email=eq.${encodeURIComponent(email)}&status=${ENTITLING}`);
  if (sup) {
    const res = await fetch(sup.url, {
      method: "PATCH",
      headers: { ...sup.headers, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "superseded", updated_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.error("[GridForge] could not supersede prior subscription:", res.status, await res.text());
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
      "[GridForge] subscription insert FAILED for a paying customer:",
      email,
      res.status,
      await res.text()
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
    console.error("[GridForge] scenario list failed:", res.status, await res.text());
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
    console.error("[GridForge] scenario insert failed:", res.status, await res.text());
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
    console.error("[GridForge] scenario delete failed:", res.status, await res.text());
    return false;
  }
  const rows = (await res.json()) as ScenarioRecord[];
  return rows.length > 0;
}
