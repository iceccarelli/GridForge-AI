/**
 * The webhook fulfils a checkout only when Stripe says it was PAID, and fails closed on anything else.
 *
 *   paid | no_payment_required            -> fulfilled
 *   unpaid, or any status we do not know  -> acknowledged (200), NOT fulfilled, logged; fulfilled later at async_payment_succeeded
 *   absent / null / not a string / ""     -> malformed: the route refuses (500) so Stripe redelivers; nothing is fulfilled or recorded
 *
 * The last row used to be "paid" (checkoutIsPaid returned true when the field was missing), which only ever happened in fabricated
 * fixtures: Stripe puts payment_status on every Checkout Session it sends. A permissive default there turns a truncated or hand-built
 * payload into a fulfilled sale. Acknowledging it with a 200 would be wrong the other way: Stripe would stop redelivering a REAL
 * payment whose payload this code could not read. The route (which Next turns into a 500 when a handler throws) is what Stripe retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { checkoutEvent, omitPaymentStatus, paidSession, checkoutSession } from "./checkout-fixture";

const WH = "whsec_payment_status_secret";
let db: PostgrestFake;
let undo: () => void;
let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a) => { logged.push(a.join(" ")); });
  vi.spyOn(console, "log").mockImplementation((...a) => { logged.push(a.join(" ")); });
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_status", STRIPE_WEBHOOK_SECRET: WH,
  });
  delete process.env.RESEND_API_KEY;
  db = new PostgrestFake(["deliverables", "subscriptions", "customer_notifications", "leads", "funnel_events"]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  undo = db.install();
});
afterEach(() => { undo(); vi.restoreAllMocks(); });

async function deliver(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), {
    method: "POST", headers: { "stripe-signature": new Stripe("sk_test_status").webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload,
  }));
}

const engagement = (fields: Record<string, unknown> = {}) => ({
  id: "cs_status_1", customer_email: "buyer@hall.example", customer: "cus_1", amount_total: 450000, metadata: { kind: "density_screen", company: "Hall Co" }, ...fields,
});
const subscription = (fields: Record<string, unknown> = {}) => ({
  id: "cs_status_sub", customer_email: "director@hall.example", customer: "cus_2", subscription: "sub_2", amount_total: 199900,
  metadata: { kind: "intelligence_subscription", plan: "team" }, ...fields,
});
const fulfilled = () => db.rows("deliverables").length + db.rows("subscriptions").length;

describe("states paid", () => {
  it.each(["paid", "no_payment_required"] as const)("%s is fulfilled, for an engagement and for a subscription", async (status) => {
    expect((await deliver(checkoutEvent(checkoutSession(status, engagement())))).status).toBe(200);
    expect((await deliver(checkoutEvent(checkoutSession(status, subscription())))).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(db.rows("subscriptions")).toHaveLength(1);
  });
});

describe("states not paid", () => {
  it.each(["unpaid", "requires_review", "PAID", "Paid", "paid ", "processing", "pending", "failed"])(
    "%j is acknowledged but fulfils nothing, on completion and on async success alike",
    async (status) => {
      for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"] as const) {
        const res = await deliver(checkoutEvent(paidSession(engagement({ payment_status: status })), { type }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, received: true, fulfilled: false });
      }
      expect(fulfilled()).toBe(0);
      expect(logged.join("\n")).toContain(`payment_status ${status}`);
    }
  );

  it("unpaid at completion, then paid at async_payment_succeeded: fulfilled once, however often delivered", async () => {
    await deliver(checkoutEvent(paidSession(engagement({ payment_status: "unpaid" }))));
    expect(fulfilled()).toBe(0);
    const settled = checkoutEvent(paidSession(engagement()), { type: "checkout.session.async_payment_succeeded", id: "evt_settled" });
    expect((await deliver(settled)).status).toBe(200);
    expect((await deliver(settled)).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
  });

  it("async_payment_failed fulfils nothing", async () => {
    const res = await deliver(checkoutEvent(checkoutSession("unpaid", engagement()), { type: "checkout.session.async_payment_failed" }));
    expect(res.status).toBe(200);
    expect(fulfilled()).toBe(0);
  });
});

describe("states nothing: a malformed payload is refused, never read as paid or as unpaid", () => {
  const malformed: [string, Record<string, unknown>][] = [
    ["absent", omitPaymentStatus(paidSession(engagement()))],
    ["null", paidSession(engagement({ payment_status: null }))],
    ["an empty string", paidSession(engagement({ payment_status: "" }))],
    ["a number", paidSession(engagement({ payment_status: 1 }))],
    ["an object", paidSession(engagement({ payment_status: { paid: true } }))],
  ];
  it.each(malformed)("payment_status %s: the route refuses it and nothing is fulfilled", async (_label, session) => {
    for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"] as const) {
      await expect(deliver(checkoutEvent(session, { type }))).rejects.toThrow(/cs_status_1 has no payment_status/);
    }
    expect(fulfilled()).toBe(0);
    expect(db.rows("customer_notifications")).toHaveLength(0);
    expect(logged.join("\n")).toContain("arrived WITHOUT payment_status");
  });

  it("the error names the session and carries no buyer data", async () => {
    const err = await deliver(checkoutEvent(omitPaymentStatus(paidSession(engagement())))).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("cs_status_1");
    expect(err?.message).not.toMatch(/hall\.example|Hall Co|450000/);
  });

  it("a subscription checkout without the field is refused too (the check precedes every product branch)", async () => {
    await expect(deliver(checkoutEvent(omitPaymentStatus(paidSession(subscription()))))).rejects.toThrow(/no payment_status/);
    expect(db.rows("subscriptions")).toHaveLength(0);
  });

  it("the corrected redelivery (Stripe's retry) is fulfilled once", async () => {
    await expect(deliver(checkoutEvent(omitPaymentStatus(paidSession(engagement()))))).rejects.toThrow();
    expect((await deliver(checkoutEvent(paidSession(engagement())))).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
  });
});
