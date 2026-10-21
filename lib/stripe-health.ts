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
 * Events the handlers use for measurement and for notices to the operator (refund and dispute counts in the admin funnel; the mail
 * that a dispute opened, with its evidence deadline, and how it closed). Money, entitlements and delivery never depend on them, so a
 * missing one does not make the endpoint unhealthy; it is reported so it can be added.
 */
export const RECOMMENDED_WEBHOOK_EVENTS = ["charge.refunded", "charge.dispute.created", "charge.dispute.closed"] as const;

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
   * operator by the webhook; a pause is not seen at all).
   */
  warnings: string[];
  error: string | null;
  checkedAt: string;
}

/** Portal features a customer can switch on for themselves that this site does not implement. */
const UNHANDLED_PORTAL_FEATURES: Record<string, string> = {
  subscription_update: "subscription_update is enabled: customers can switch plans in the portal, which changes what Stripe bills but not what the site entitles (the operator is mailed once per subscription, nothing is changed automatically). Turn it off in the portal configuration.",
  subscription_pause: "subscription_pause is enabled: customers can pause billing in the portal, which the site does not see (the key and access continue). Turn it off in the portal configuration.",
};

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
