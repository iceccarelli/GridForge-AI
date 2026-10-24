// Detects the gap between what the Stripe webhook handler depends on and what
// the actual Stripe account is configured to deliver.
//
// app/api/stripe/webhook/route.ts already handles checkout.session.completed,
// invoice.paid, invoice.payment_failed, customer.subscription.deleted and
// customer.subscription.updated correctly -- but correct handler code is worthless if the Stripe Dashboard's
// webhook endpoint was never told to send those events, sends them to the
// wrong URL, or is disabled. That mismatch is invisible from the code alone:
// `next build` is green, the route 200s on any signed request it does
// receive, and nothing in this repository would ever say otherwise. This is
// the check that says otherwise, honestly, instead of assuming health from
// the presence of the handler.
//
// This never claims "healthy" without asking Stripe directly. If the account
// cannot be reached (no key, bad key, network failure), the result says so
// explicitly rather than defaulting to "ok".

import { overlapHeld, probeEngineRevokeRoute, type ApiAccount } from "@/lib/api-access";
import { pg } from "@/lib/payg-store";

export const REQUIRED_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "invoice.paid",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  // A plan switch, a pause or a cancellation made in the Stripe Billing Portal reaches the site only as this event; without it the
  // entitlement silently stays what it was while Stripe bills something else.
  "customer.subscription.updated",
] as const;

/**
 * Events the handlers act on beyond the five required ones. A missing one does not make the endpoint unhealthy (nothing here is needed to
 * sell or renew), but it is reported because a customer-visible outcome depends on it:
 *   charge.refunded, charge.dispute.created, charge.dispute.closed
 *       the refund and dispute counts and operator mails, AND the suspension of paid access: a subscription payment refunded in full or
 *       disputed suspends the API key / Hall Watch / Intelligence entitlement, and a dispute won restores it. Without them a refunded
 *       or charged-back customer keeps paid access until the subscription is cancelled.
 *   checkout.session.async_payment_succeeded, checkout.session.async_payment_failed
 *       a delayed payment method (a bank debit or transfer) completes a checkout unpaid; the sale is fulfilled when the first arrives and
 *       never when the second does. Needed only if such a payment method is ever enabled on Checkout (today it is card only).
 * The handler really handles each of these (tests/site/billing-holds.test.ts).
 */
export const RECOMMENDED_WEBHOOK_EVENTS = [
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
] as const;

export interface StripeWebhookHealth {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  expectedUrl: string;
  endpoint: {
    id: string;
    url: string;
    status: "enabled" | "disabled";
    enabledEvents: string[];
  } | null;
  missingEvents: string[];
  /** Events that only feed measurement (see RECOMMENDED_WEBHOOK_EVENTS); never part of `healthy`. */
  missingRecommended: string[];
  urlMismatch: boolean;
  healthy: boolean;
  checkedAt: string;
}

function unhealthy(
  expectedUrl: string,
  patch: Partial<StripeWebhookHealth>
): StripeWebhookHealth {
  return {
    configured: false,
    reachable: false,
    error: null,
    expectedUrl,
    endpoint: null,
    missingEvents: [...REQUIRED_WEBHOOK_EVENTS],
    missingRecommended: [...RECOMMENDED_WEBHOOK_EVENTS],
    urlMismatch: false,
    healthy: false,
    checkedAt: new Date().toISOString(),
    ...patch,
  };
}

/**
 * Compares the live Stripe account's webhook endpoint configuration against
 * what app/api/stripe/webhook/route.ts actually needs. Takes the Stripe
 * client as a dependency (rather than constructing it here) so this is
 * testable against a fake without a real Stripe SDK instance or network call.
 */
export async function checkStripeWebhookHealth(
  stripeClient: {
    webhookEndpoints: {
      list(params: { limit: number }): Promise<{ data: unknown[] }>;
    };
  } | null,
  expectedUrl: string
): Promise<StripeWebhookHealth> {
  if (!stripeClient) {
    return unhealthy(expectedUrl, {
      configured: false,
      error: "STRIPE_SECRET_KEY is not set — cannot verify webhook configuration.",
    });
  }

  let endpoints: unknown[];
  try {
    const res = await stripeClient.webhookEndpoints.list({ limit: 100 });
    endpoints = res.data;
  } catch (err) {
    return unhealthy(expectedUrl, {
      configured: true,
      error: `Could not reach Stripe to list webhook endpoints: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const matches = endpoints.filter((e): e is {
    id: string;
    url: string;
    status: string;
    enabled_events: string[];
  } => {
    const rec = e as { url?: unknown };
    return typeof rec.url === "string" && rec.url.replace(/\/$/, "") === expectedUrl.replace(/\/$/, "");
  });

  if (matches.length === 0) {
    return unhealthy(expectedUrl, {
      configured: true,
      reachable: true,
      error: `No Stripe webhook endpoint is registered for ${expectedUrl}. ` +
        `Subscription renewals, cancellations and payment failures will never reach this app.`,
      urlMismatch: endpoints.length > 0,
    });
  }

  // Prefer an enabled endpoint over a disabled one if both exist for the URL.
  const endpoint = matches.find((e) => e.status === "enabled") ?? matches[0];
  const enabledEvents = endpoint.enabled_events.includes("*")
    ? [...REQUIRED_WEBHOOK_EVENTS]
    : endpoint.enabled_events;
  const missingEvents = REQUIRED_WEBHOOK_EVENTS.filter((e) => !enabledEvents.includes(e));
  const wildcard = endpoint.enabled_events.includes("*");
  const missingRecommended = wildcard ? [] : RECOMMENDED_WEBHOOK_EVENTS.filter((e) => !endpoint.enabled_events.includes(e));

  const healthy = endpoint.status === "enabled" && missingEvents.length === 0;

  return {
    configured: true,
    reachable: true,
    error: healthy
      ? null
      : endpoint.status !== "enabled"
        ? `The webhook endpoint for ${expectedUrl} is disabled in Stripe.`
        : `The webhook endpoint for ${expectedUrl} is missing required event(s): ${missingEvents.join(", ")}.`,
    expectedUrl,
    endpoint: {
      id: endpoint.id,
      url: endpoint.url,
      status: endpoint.status === "enabled" ? "enabled" : "disabled",
      enabledEvents,
    },
    missingEvents,
    missingRecommended,
    urlMismatch: false,
    healthy,
    checkedAt: new Date().toISOString(),
  };
}


/**
 * Whether the Stripe Billing Portal can do what the site tells customers it can: cancel a subscription, replace a payment
 * method and show invoices. /api/billing/portal creates a portal session; Stripe refuses it (and the customer sees "not
 * available") until a portal configuration exists in the dashboard with those features on. Asked of Stripe directly; an account
 * that cannot be reached is reported as unreachable, never as fine.
 */
export interface BillingPortalHealth {
  configured: boolean;
  reachable: boolean;
  ok: boolean;
  /** Features the customer is promised that no active configuration enables. */
  missing: string[];
  /**
   * Portal features that are ENABLED and that the site does not handle (a plan switch, a pause): reported, never a failure of `ok`.
   * A customer who uses one changes what Stripe bills while the site's entitlement stays as it was (a plan switch is reported to the
   * operator by the webhook; a pause holds paid delivery until billing resumes, see lib/billing-holds.ts).
   */
  warnings: string[];
  error: string | null;
  checkedAt: string;
}

/** Portal features a customer can switch on for themselves that this site does not implement. */
const UNHANDLED_PORTAL_FEATURES: Record<string, string> = {
  subscription_update: "subscription_update is enabled: customers can switch plans in the portal, which changes what Stripe bills but not what the site entitles (the operator is mailed once per subscription, nothing is changed automatically). Turn it off in the portal configuration.",
  subscription_pause: "subscription_pause is enabled: customers can pause billing in the portal. The site holds paid delivery while billing is paused (API key revoked, Hall Watch paused, Intelligence not entitled) and restores it on resume, but only if customer.subscription.updated is delivered; a pause is a customer choosing not to pay, so most operators turn it off in the portal configuration.",
};

/**
 * Key revocations the ENGINE has not confirmed. Every revocation is recorded on the account first (revoked_key_ids) and confirmed only
 * when the engine answers 2xx (revoked_confirmed_ids); the difference is `revocation_pending`, a durable obligation the daily job and the
 * next billing event push again. This lists it, so a revocation that cannot reach the engine (today the deployed engine answers 404 for
 * /v1/revoke) is a number an operator sees rather than a log line. `ok` is false while any id of an account the site has CUT OFF
 * (past_due, cancelled, held) is unconfirmed: that credential still verifies at the engine. Ids an active account holds on purpose
 * (an overlap key inside its window) are not counted. `engineRevokeRoute` says why when something is pending (asked of the engine
 * with an empty key id, which revokes nothing).
 */
export interface RevocationBacklog {
  /** false: the store could not be read, so nothing is claimed. */
  checked: boolean;
  ok: boolean;
  accountsPending: number;
  idsPending: number;
  /** Unconfirmed ids on accounts that are past_due, cancelled or on hold: credentials the site has cut off and the engine has not. */
  idsPendingOnCutOffAccounts: number;
  oldestCreatedAt: string | null;
  engineRevokeRoute: "served" | "not_deployed" | "unreachable" | "unconfigured" | "unknown" | "not_asked";
  error: string | null;
  checkedAt: string;
}

export async function checkRevocationBacklog(now: Date = new Date()): Promise<RevocationBacklog> {
  const base = { checkedAt: now.toISOString() };
  const empty = { accountsPending: 0, idsPending: 0, idsPendingOnCutOffAccounts: 0, oldestCreatedAt: null, engineRevokeRoute: "not_asked" as const };
  const r = await pg<{ status: string; created_at: string | null; revoked_key_ids: string[] | null; revoked_confirmed_ids: string[] | null; overlap_key_ids: Record<string, string> | null }[]>(
    "GET",
    "api_accounts?revocation_pending=eq.true&select=status,created_at,revoked_key_ids,revoked_confirmed_ids,overlap_key_ids&order=created_at.asc&limit=500"
  );
  if (!r.ok) return { ...base, ...empty, checked: false, ok: false, error: `The account store could not be read (${r.status}); the revocation backlog is unknown.` };
  const today = now.toISOString().slice(0, 10);
  let accountsPending = 0;
  let idsPending = 0;
  let cutOff = 0;
  let oldest: string | null = null;
  for (const row of r.data ?? []) {
    const confirmed = new Set(row.revoked_confirmed_ids ?? []);
    const todo = (row.revoked_key_ids ?? []).filter((id) => !confirmed.has(id) && !overlapHeld({ status: row.status as ApiAccount["status"], overlap_key_ids: row.overlap_key_ids }, id, today));
    if (todo.length === 0) continue;
    accountsPending++;
    idsPending += todo.length;
    if (row.status !== "active") cutOff += todo.length;
    if (row.created_at && (!oldest || row.created_at < oldest)) oldest = row.created_at;
  }
  const engineRevokeRoute = idsPending > 0 ? await probeEngineRevokeRoute() : "not_asked";
  const ok = cutOff === 0;
  return {
    ...base,
    checked: true,
    ok,
    accountsPending,
    idsPending,
    idsPendingOnCutOffAccounts: cutOff,
    oldestCreatedAt: oldest,
    engineRevokeRoute,
    error: ok
      ? null
      : `${cutOff} key id(s) on accounts the site has cut off are NOT confirmed revoked by the engine and may still verify there` +
        (engineRevokeRoute === "not_deployed" ? ": the engine does not serve /v1/revoke (redeploy it; scripts/check-engine-drift.py)." : ".") +
        " They are retried daily and on the next billing event for each account.",
  };
}

export async function checkBillingPortal(
  stripeClient: {
    billingPortal: { configurations: { list(params: { active: boolean; limit: number }): Promise<{ data: unknown[] }> } };
  } | null
): Promise<BillingPortalHealth> {
  const base = { checkedAt: new Date().toISOString() };
  const WANTED = ["subscription_cancel", "payment_method_update", "invoice_history"] as const;
  if (!stripeClient) {
    return { ...base, configured: false, reachable: false, ok: false, missing: [...WANTED], warnings: [], error: "STRIPE_SECRET_KEY is not set: cannot verify the Billing Portal." };
  }
  let configs: unknown[];
  try {
    configs = (await stripeClient.billingPortal.configurations.list({ active: true, limit: 10 })).data;
  } catch (err) {
    return { ...base, configured: true, reachable: false, ok: false, missing: [...WANTED], warnings: [], error: `Could not reach Stripe to list Billing Portal configurations: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The portal session the site creates uses the account's DEFAULT configuration (no configuration id is passed), so that is the one that counts.
  const usable = configs.filter((c): c is { is_default?: boolean; features?: Record<string, { enabled?: boolean } | undefined> } => typeof c === "object" && c !== null);
  const chosen = usable.find((c) => c.is_default) ?? usable[0];
  if (!chosen) {
    return { ...base, configured: true, reachable: true, ok: false, missing: [...WANTED], warnings: [], error: "No active Billing Portal configuration exists. Customers who press 'Manage or cancel' will be told it is not available." };
  }
  const missing = WANTED.filter((f) => chosen.features?.[f]?.enabled !== true);
  const warnings = Object.entries(UNHANDLED_PORTAL_FEATURES).filter(([f]) => chosen.features?.[f]?.enabled === true).map(([, text]) => text);
  return {
    ...base,
    configured: true,
    reachable: true,
    ok: missing.length === 0,
    missing: [...missing],
    warnings,
    error: missing.length === 0 ? null : `The default Billing Portal configuration does not enable: ${missing.join(", ")}.`,
  };
}
