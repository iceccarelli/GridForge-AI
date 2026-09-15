/**
 * app/api/stripe/webhook — the only place where money becomes entitlement.
 *
 * Signatures are generated for real with the Stripe SDK's own test helper, so a
 * forged event is rejected by the same code path production uses.
 *
 * Three things ride a Stripe subscription in this product: metered API access
 * (api_accounts), Hall Watch (watches) and GridForge Intelligence
 * (subscriptions). For two releases only the first was resolved on a lifecycle
 * event; then the second was fixed and the third was still missing — and the
 * third had no table at all, so nothing was ever recorded to cancel.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const WH_SECRET = "whsec_test_secret_for_signature_generation";
const BUYER = "director@northhall.example";

let db: PostgrestFake;
let restore: () => void;
let stripe: Stripe;

async function route() {
  return await import("@/app/api/stripe/webhook/route");
}

/** A correctly signed delivery of `event`. */
function delivery(event: Record<string, unknown>, opts: { signature?: string } = {}) {
  const payload = JSON.stringify(event);
  const signature =
    opts.signature ??
    stripe.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET });
  return new Request(siteUrl("/api/stripe/webhook"), {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body: payload,
  });
}

function checkoutCompleted(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_intelligence_1",
        object: "checkout_session",
        customer_email: BUYER,
        customer: "cus_123",
        subscription: "sub_123",
        amount_total: 199900,
        metadata: { kind: "intelligence_subscription", plan: "team" },
        ...over,
      },
    },
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  delete process.env.RESEND_API_KEY; // no outbound email from a test
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  db = new PostgrestFake(["subscriptions", "scenarios", "watches", "api_accounts", "leads"]);
  restore = db.install();
});

afterEach(() => restore());

describe("authenticity", () => {
  it("refuses a forged event", async () => {
    const { POST } = await route();
    const res = await POST(delivery(checkoutCompleted(), { signature: "t=1,v1=deadbeef" }));
    expect(res.status).toBe(400);
    expect(db.rows("subscriptions")).toHaveLength(0);
  });

  it("refuses an unsigned event", async () => {
    const { POST } = await route();
    const req = new Request(siteUrl("/api/stripe/webhook"), {
      method: "POST",
      body: JSON.stringify(checkoutCompleted()),
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("refuses to run at all when the webhook secret is not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { POST } = await route();
    const res = await POST(delivery(checkoutCompleted()));
    // 503, not 200: a webhook that cannot verify anything must not report success
    // to Stripe, or every event is silently dropped.
    expect(res.status).toBe(503);
  });
});

describe("a paid Intelligence subscription becomes an entitlement", () => {
  it("records the subscription with the id cancellation needs", async () => {
    const { POST } = await route();
    const res = await POST(delivery(checkoutCompleted()));
    expect(res.status).toBe(200);

    const rows = db.rows("subscriptions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: BUYER,
      plan: "team",
      status: "active",
      stripe_session_id: "cs_test_intelligence_1",
      stripe_customer_id: "cus_123",
      // The column that was missing. Without it customer.subscription.deleted has
      // nothing to resolve against and a cancelled plan stays active forever.
      stripe_subscription_id: "sub_123",
    });
  });

  it("normalises the email so /account can find the row", async () => {
    const { POST } = await route();
    await POST(delivery(checkoutCompleted({ customer_email: "  Director@NorthHall.Example " })));
    expect(db.rows("subscriptions")[0].email).toBe(BUYER);
  });

  it("is idempotent — Stripe delivers the same event more than once", async () => {
    const { POST } = await route();
    expect((await POST(delivery(checkoutCompleted()))).status).toBe(200);
    expect((await POST(delivery(checkoutCompleted()))).status).toBe(200);
    expect(db.rows("subscriptions")).toHaveLength(1);
  });

  it("supersedes the previous plan on an upgrade rather than stacking two", async () => {
    const { POST } = await route();
    await POST(delivery(checkoutCompleted()));
    await POST(
      delivery(
        checkoutCompleted({
          id: "cs_test_intelligence_2",
          subscription: "sub_456",
          metadata: { kind: "intelligence_subscription", plan: "enterprise" },
        })
      )
    );
    const rows = db.rows("subscriptions");
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect(rows.find((r) => r.status === "active")?.plan).toBe("enterprise");
    expect(rows.find((r) => r.status === "superseded")?.plan).toBe("team");
  });

  it("asks Stripe to retry rather than welcoming a customer it failed to record", async () => {
    // The old code wrote into a table that did not exist, ignored the 404, and
    // sent the welcome email anyway. A 500 makes Stripe redeliver; the write is
    // idempotent on the session id, so the retry cannot double-issue.
    db.dropTable("subscriptions");
    const { POST } = await route();
    const res = await POST(delivery(checkoutCompleted()));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it("does not record a subscription with no email on it", async () => {
    const { POST } = await route();
    const res = await POST(
      delivery(checkoutCompleted({ customer_email: null, customer_details: null }))
    );
    expect(res.status).toBe(500);
    expect(db.rows("subscriptions")).toHaveLength(0);
  });
});

describe("the lifecycle must reach all three products", () => {
  async function seedLive() {
    const { POST } = await route();
    await POST(delivery(checkoutCompleted()));
    return POST;
  }

  function invoiceEvent(type: string, subscription: string) {
    return {
      id: `evt_${type}`,
      type,
      data: { object: { id: "in_1", object: "invoice", subscription } },
    };
  }

  it("cancels the Intelligence subscription when Stripe cancels it", async () => {
    const POST = await seedLive();
    await POST(
      delivery({
        id: "evt_del",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_123", object: "subscription" } },
      })
    );
    expect(db.rows("subscriptions")[0].status).toBe("cancelled");
  });

  it("puts a failed payment past_due rather than cancelling it outright", async () => {
    const POST = await seedLive();
    await POST(delivery(invoiceEvent("invoice.payment_failed", "sub_123")));
    expect(db.rows("subscriptions")[0].status).toBe("past_due");
  });

  it("reinstates a past_due subscription when the payment clears", async () => {
    const POST = await seedLive();
    await POST(delivery(invoiceEvent("invoice.payment_failed", "sub_123")));
    await POST(delivery(invoiceEvent("invoice.paid", "sub_123")));
    expect(db.rows("subscriptions")[0].status).toBe("active");
  });

  it("does not resurrect a cancelled subscription on a later invoice", async () => {
    // A cancelled plan is a new sale, not a renewal.
    const POST = await seedLive();
    await POST(
      delivery({
        id: "evt_del",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_123", object: "subscription" } },
      })
    );
    await POST(delivery(invoiceEvent("invoice.paid", "sub_123")));
    expect(db.rows("subscriptions")[0].status).toBe("cancelled");
  });

  it("leaves another customer's subscription alone", async () => {
    const POST = await seedLive();
    await POST(
      delivery({
        id: "evt_del",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_somebody_else", object: "subscription" } },
      })
    );
    expect(db.rows("subscriptions")[0].status).toBe("active");
  });

  it("reads the subscription id from the newer Invoice shape too", async () => {
    // Stripe moved `subscription` off the top level of Invoice. A handler that
    // only understands one shape silently stops cancelling everybody.
    const POST = await seedLive();
    await POST(
      delivery({
        id: "evt_nested",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_2",
            object: "invoice",
            parent: { subscription_details: { subscription: "sub_123" } },
          },
        },
      })
    );
    expect(db.rows("subscriptions")[0].status).toBe("past_due");
  });
});

describe("events we do not handle", () => {
  it("acknowledges an unrelated event without touching anything", async () => {
    const { POST } = await route();
    const res = await POST(
      delivery({
        id: "evt_other",
        type: "customer.updated",
        data: { object: { id: "cus_123", object: "customer" } },
      })
    );
    expect(res.status).toBe(200);
    expect(db.rows("subscriptions")).toHaveLength(0);
  });
});
