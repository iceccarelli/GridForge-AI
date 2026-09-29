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
    urlMismatch: false,
    healthy,
    checkedAt: new Date().toISOString(),
  };
}
