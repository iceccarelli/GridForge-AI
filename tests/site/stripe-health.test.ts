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

// ---------------------------------------------------------------------------------------------------------------------
// Recommended events and the Billing Portal (MOCKS: a fake Stripe client; nothing here touches a real account)
// ---------------------------------------------------------------------------------------------------------------------
import { checkBillingPortal, RECOMMENDED_WEBHOOK_EVENTS } from "@/lib/stripe-health";

describe("recommended webhook events are reported but never make an endpoint unhealthy", () => {
  it("an endpoint with every required event and neither recommended one is healthy, and lists what it is not subscribed to", async () => {
    const health = await checkStripeWebhookHealth(
      fakeClient([{ id: "we_1", url: EXPECTED_URL, status: "enabled", enabled_events: [...REQUIRED_WEBHOOK_EVENTS] }]),
      EXPECTED_URL
    );
    expect(health.healthy).toBe(true);
    expect(health.missingEvents).toEqual([]);
    expect(health.missingRecommended).toEqual([...RECOMMENDED_WEBHOOK_EVENTS]);
  });

  it("subscribing to them clears the note, and a wildcard subscription needs none", async () => {
    const both = await checkStripeWebhookHealth(
      fakeClient([{ id: "we_1", url: EXPECTED_URL, status: "enabled", enabled_events: [...REQUIRED_WEBHOOK_EVENTS, ...RECOMMENDED_WEBHOOK_EVENTS] }]),
      EXPECTED_URL
    );
    expect(both.missingRecommended).toEqual([]);
    const star = await checkStripeWebhookHealth(fakeClient([{ id: "we_2", url: EXPECTED_URL, status: "enabled", enabled_events: ["*"] }]), EXPECTED_URL);
    expect(star.healthy).toBe(true);
    expect(star.missingRecommended).toEqual([]);
  });

  it("the handlers' real dependencies are the four required events: the webhook route names no other event for money or access", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/stripe/webhook/route.ts", "utf8");
    const used = [...src.matchAll(/event\.type === "([a-z_.]+)"/g)].map((m) => m[1]);
    const money = used.filter((e) => !(RECOMMENDED_WEBHOOK_EVENTS as readonly string[]).includes(e));
    expect(new Set(money)).toEqual(new Set(REQUIRED_WEBHOOK_EVENTS));
    expect(used).toEqual(expect.arrayContaining([...RECOMMENDED_WEBHOOK_EVENTS]));
  });
});

describe("checkBillingPortal", () => {
  const portalClient = (data: unknown[]) => ({ billingPortal: { configurations: { list: async () => ({ data }) } } });
  const features = (on: string[]) => Object.fromEntries(["subscription_cancel", "payment_method_update", "invoice_history"].map((f) => [f, { enabled: on.includes(f) }]));

  it("says so when there is no Stripe client, and when Stripe cannot be reached", async () => {
    expect(await checkBillingPortal(null)).toMatchObject({ configured: false, ok: false });
    const down = await checkBillingPortal({ billingPortal: { configurations: { list: async () => { throw new Error("net"); } } } });
    expect(down).toMatchObject({ reachable: false, ok: false });
    expect(down.error).toMatch(/Could not reach Stripe/);
  });

  it("no active configuration: not ok, every feature missing", async () => {
    const r = await checkBillingPortal(portalClient([]));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["subscription_cancel", "payment_method_update", "invoice_history"]);
  });

  it("the DEFAULT configuration is the one that counts: a fully enabled non-default does not rescue a default that cannot cancel", async () => {
    const r = await checkBillingPortal(portalClient([
      { is_default: false, features: features(["subscription_cancel", "payment_method_update", "invoice_history"]) },
      { is_default: true, features: features(["payment_method_update", "invoice_history"]) },
    ]));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["subscription_cancel"]);
    expect(r.error).toMatch(/subscription_cancel/);
  });

  it("cancel, card update and invoices all enabled: ok", async () => {
    const r = await checkBillingPortal(portalClient([{ is_default: true, features: features(["subscription_cancel", "payment_method_update", "invoice_history"]) }]));
    expect(r).toMatchObject({ ok: true, missing: [], error: null });
  });
});
