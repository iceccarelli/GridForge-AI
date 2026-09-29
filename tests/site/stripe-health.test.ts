/**
 * lib/stripe-health.ts -- detects the gap between what
 * app/api/stripe/webhook/route.ts depends on (checkout.session.completed,
 * invoice.paid, customer.subscription.deleted, invoice.payment_failed) and
 * what the live Stripe account's webhook endpoint is actually configured to
 * send. This never assumes health from the handler code alone; every case
 * here goes through the same function the admin health check calls against
 * a real Stripe client.
 */
import { describe, expect, it } from "vitest";
import { checkStripeWebhookHealth, REQUIRED_WEBHOOK_EVENTS } from "@/lib/stripe-health";

// Deliberately not the real domain — tests/test_one_company.py enforces that no file
// outside lib/site.ts hardcodes the real site URL. Any stand-in works here since this
// unit only checks URL-string equality inside checkStripeWebhookHealth() itself.
const EXPECTED_URL = "https://example-deployment.test/api/stripe/webhook";

function fakeClient(endpoints: Array<{ id: string; url: string; status: string; enabled_events: string[] }>) {
  return {
    webhookEndpoints: {
      list: async () => ({ data: endpoints }),
    },
  };
}

describe("checkStripeWebhookHealth", () => {
  it("is unhealthy and says so when there is no Stripe client (STRIPE_SECRET_KEY unset)", async () => {
    const health = await checkStripeWebhookHealth(null, EXPECTED_URL);
    expect(health.configured).toBe(false);
    expect(health.healthy).toBe(false);
    expect(health.error).toMatch(/STRIPE_SECRET_KEY/);
  });

  it("is unhealthy when Stripe cannot be reached", async () => {
    const client = {
      webhookEndpoints: {
        list: async () => {
          throw new Error("network down");
        },
      },
    };
    const health = await checkStripeWebhookHealth(client, EXPECTED_URL);
    expect(health.configured).toBe(true);
    expect(health.reachable).toBe(false);
    expect(health.healthy).toBe(false);
    expect(health.error).toMatch(/network down/);
  });

  it("is unhealthy when no endpoint is registered for the expected URL", async () => {
    const client = fakeClient([
      { id: "we_1", url: "https://old-domain.example/webhook", status: "enabled", enabled_events: [...REQUIRED_WEBHOOK_EVENTS] },
    ]);
    const health = await checkStripeWebhookHealth(client, EXPECTED_URL);
    expect(health.healthy).toBe(false);
    expect(health.endpoint).toBeNull();
    expect(health.urlMismatch).toBe(true);
    expect(health.error).toMatch(EXPECTED_URL);
  });

  it("is unhealthy when the endpoint exists but is disabled", async () => {
    const client = fakeClient([
      { id: "we_1", url: EXPECTED_URL, status: "disabled", enabled_events: [...REQUIRED_WEBHOOK_EVENTS] },
    ]);
    const health = await checkStripeWebhookHealth(client, EXPECTED_URL);
    expect(health.healthy).toBe(false);
    expect(health.endpoint?.status).toBe("disabled");
    expect(health.error).toMatch(/disabled/);
  });

  it("is unhealthy and names exactly the missing events when some are not enabled", async () => {
    const client = fakeClient([
      {
        id: "we_1",
        url: EXPECTED_URL,
        status: "enabled",
        enabled_events: ["checkout.session.completed", "invoice.paid"],
      },
    ]);
    const health = await checkStripeWebhookHealth(client, EXPECTED_URL);
    expect(health.healthy).toBe(false);
    expect(health.missingEvents).toEqual(
      expect.arrayContaining(["customer.subscription.deleted", "invoice.payment_failed"])
    );
    expect(health.error).toMatch(/customer.subscription.deleted/);
  });

  it("is healthy when every required event is enabled on a live endpoint", async () => {
    const client = fakeClient([
      { id: "we_1", url: EXPECTED_URL, status: "enabled", enabled_events: [...REQUIRED_WEBHOOK_EVENTS, "invoice.finalized"] },
    ]);
    const health = await checkStripeWebhookHealth(client, EXPECTED_URL);
    expect(health.healthy).toBe(true);
    expect(health.missingEvents).toEqual([]);
    expect(health.error).toBeNull();
  });

  it("treats a wildcard enabled_events subscription as covering everything required", async () => {
    const client = fakeClient([
      { id: "we_1", url: EXPECTED_URL, status: "enabled", enabled_events: ["*"] },
    ]);
    const health = await checkStripeWebhookHealth(client, EXPECTED_URL);
    expect(health.healthy).toBe(true);
  });

  it("ignores a trailing slash difference between the registered and expected URL", async () => {
    const client = fakeClient([
      { id: "we_1", url: `${EXPECTED_URL}/`, status: "enabled", enabled_events: [...REQUIRED_WEBHOOK_EVENTS] },
    ]);
    const health = await checkStripeWebhookHealth(client, EXPECTED_URL);
    expect(health.healthy).toBe(true);
  });
});
