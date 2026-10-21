// Detects the gap between what the Stripe webhook handler depends on and what
// the actual Stripe account is configured to deliver.
//
// app/api/stripe/webhook/route.ts already handles checkout.session.completed,
// invoice.paid, customer.subscription.deleted and invoice.payment_failed
// correctly -- but correct handler code is worthless if the Stripe Dashboard's
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
] as const;

/**
 * Events the handlers use for measurement only (refund and dispute counts in the admin funnel). Money, entitlements and
 * delivery never depend on them, so a missing one does not make the endpoint unhealthy; it is reported so it can be added.
 */
export const RECOMMENDED_WEBHOOK_EVENTS = ["charge.refunded", "charge.dispute.created"] as const;

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
  error: string | null;
  checkedAt: string;
}

export async function checkBillingPortal(
  stripeClient: {
    billingPortal: { configurations: { list(params: { active: boolean; limit: number }): Promise<{ data: unknown[] }> } };
  } | null
): Promise<BillingPortalHealth> {
  const base = { checkedAt: new Date().toISOString() };
  const WANTED = ["subscription_cancel", "payment_method_update", "invoice_history"] as const;
  if (!stripeClient) {
    return { ...base, configured: false, reachable: false, ok: false, missing: [...WANTED], error: "STRIPE_SECRET_KEY is not set: cannot verify the Billing Portal." };
  }
  let configs: unknown[];
  try {
    configs = (await stripeClient.billingPortal.configurations.list({ active: true, limit: 10 })).data;
  } catch (err) {
    return { ...base, configured: true, reachable: false, ok: false, missing: [...WANTED], error: `Could not reach Stripe to list Billing Portal configurations: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The portal session the site creates uses the account's DEFAULT configuration (no configuration id is passed), so that is the one that counts.
  const usable = configs.filter((c): c is { is_default?: boolean; features?: Record<string, { enabled?: boolean } | undefined> } => typeof c === "object" && c !== null);
  const chosen = usable.find((c) => c.is_default) ?? usable[0];
  if (!chosen) {
    return { ...base, configured: true, reachable: true, ok: false, missing: [...WANTED], error: "No active Billing Portal configuration exists. Customers who press 'Manage or cancel' will be told it is not available." };
  }
  const missing = WANTED.filter((f) => chosen.features?.[f]?.enabled !== true);
  return {
    ...base,
    configured: true,
    reachable: true,
    ok: missing.length === 0,
    missing: [...missing],
    error: missing.length === 0 ? null : `The default Billing Portal configuration does not enable: ${missing.join(", ")}.`,
  };
}
