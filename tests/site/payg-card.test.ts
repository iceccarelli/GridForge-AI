/**
 * F6: a failed card could not be replaced (enable refuses a pay-as-you-go account, the cap does not touch the card, there is no billing
 * portal), so the next month's charge failed the same way. POST /api/payg/card starts Stripe Checkout in SETUP mode on the account's
 * EXISTING customer; the signed webhook (kind api_payg_card_update) replaces the card, points the unpaid failed invoice at it and tries
 * it. Stripe is a MOCK (MockStripe); webhook signatures are generated for real. No live Stripe call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MockStripe, mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";
import { noPaymentRequiredSession } from "./checkout-fixture";

const WH = "whsec_payg_card_test";
const sdk = new Stripe("sk_test_placeholder");
let db: PostgrestFake;
let restore: () => void;
let mock: MockStripe;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH,
    GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMemoryLimiter();
  db = newPaygDb();
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  mock = new MockStripe();
  setPaygStripeForTests(mock);
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); });

let ipn = 0;
const post = (body: unknown) => new Request(siteUrl("/api/payg/card"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.8.0.${(++ipn % 250) + 1}` }, body: JSON.stringify(body) });
let evt = 0;
async function webhook(object: Record<string, unknown>, type = "checkout.session.completed") {
  const payload = JSON.stringify({ id: `evt_${++evt}`, type, data: { object } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const route = () => import("@/app/api/payg/card/route");
const acct = () => (db.rows("api_accounts") as any[])[0];
const meta = { kind: "api_payg_card_update", account_id: "acme-123456" };
const cardSession = (over: Record<string, unknown> = {}) => noPaymentRequiredSession({ id: "cs_card_1", object: "checkout.session", mode: "setup", customer: "cus_acme", setup_intent: "seti_card", metadata: meta, ...over });
const intent = (over: Record<string, unknown> = {}) => mock.setupIntentStore.set("seti_card", { id: "seti_card", status: "succeeded", payment_method: "pm_new", customer: "cus_acme", metadata: meta, ...over } as any);

describe("POST /api/payg/card", () => {
  it("starts Checkout in setup mode on the EXISTING customer (nothing charged) and answers { ok, url } with a return cookie", async () => {
    const a = paygAccount(db);
    const res = await (await route()).POST(post({ token: a.token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//) });
    expect(mock.calls).toEqual(["checkout.sessions.create"]);
    const s = mock.sessions[0];
    expect(s).toMatchObject({ mode: "setup", currency: "eur", customer: "cus_acme", metadata: meta });
    expect(s).not.toHaveProperty("customer_creation");
    expect(s).not.toHaveProperty("line_items");
    expect(s.setup_intent_data.metadata).toEqual(meta);
    expect(s.success_url).not.toContain(a.token as string);
    expect(res.headers.get("set-cookie")).toContain(`gf_payg_return=${a.token}`);
  });

  it("is allowed for a past_due account (that is exactly when it is needed) and refused for a cancelled one, a free one, one with no customer, an unknown token", async () => {
    const { POST } = await route();
    const pastDue = paygAccount(db, { status: "past_due" });
    expect((await POST(post({ token: pastDue.token }))).status).toBe(200);
    const cancelled = paygAccount(db, { account: "c1", token: "tok-c1-0123456789abcdefghijkl", status: "cancelled" });
    expect((await POST(post({ token: cancelled.token }))).status).toBe(402);
    const free = paygAccount(db, { account: "f1", token: "tok-f1-0123456789abcdefghijkl", plan: "api_free", stripe_customer_id: null });
    const r = await POST(post({ token: free.token }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ fix: "enable_payg" });
    const nocust = paygAccount(db, { account: "n1", token: "tok-n1-0123456789abcdefghijkl", stripe_customer_id: null });
    expect((await POST(post({ token: nocust.token }))).status).toBe(409);
    expect((await POST(post({ token: "nope" }))).status).toBe(404);
    expect(mock.sessions).toHaveLength(1);
  });

  it("503 when Stripe is unconfigured, 502 when it fails; rate limited like the other account changes", async () => {
    const a = paygAccount(db);
    const { POST } = await route();
    mock.failOnce.add("checkout.sessions.create");
    expect((await POST(post({ token: a.token }))).status).toBe(502);
    const out: number[] = [];
    for (let i = 0; i < 32; i++) out.push((await POST(new Request(siteUrl("/api/payg/card"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.50" }, body: JSON.stringify({ token: a.token }) }))).status);
    expect(out.filter((s) => s === 429).length).toBeGreaterThan(0);
    setPaygStripeForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
    resetMemoryLimiter();
    expect((await POST(post({ token: a.token }))).status).toBe(503);
  });
});

describe("the card-update webhook", () => {
  it("replaces the card on the customer and the account; a replay changes nothing more", async () => {
    paygAccount(db);
    intent();
    expect((await webhook(cardSession())).status).toBe(200);
    expect(acct()).toMatchObject({ stripe_payment_method_id: "pm_new", stripe_customer_id: "cus_acme", plan: "api_payg", cap_units: 50 });
    expect(mock.customerUpdates).toEqual([{ id: "cus_acme", params: { invoice_settings: { default_payment_method: "pm_new" } } }]);
    await webhook(cardSession());
    expect(acct().stripe_payment_method_id).toBe("pm_new");
    expect(acct().status).toBe("active"); // it does not touch the cap, the status or the key
  });

  it("recovers a FAILED invoice: points it at the new card and tries it; the paid event then reinstates the account", async () => {
    const a = paygAccount(db, { status: "past_due", key_id: null });
    // a real failed settlement with a real (mock) Stripe invoice created with the OLD card
    const inv = await mock.invoices.create({ customer: "cus_acme", metadata: { kind: "payg_settlement", account: "acme-123456", month: "2026-09" }, default_payment_method: "pm_acme" } as any);
    await mock.invoices.finalizeInvoice(inv.id, { auto_advance: true });
    db.insertRow("usage_settlements", { account: "acme-123456", month: "2026-09", units: 10, amount_cents: 2000, status: "failed", stripe_invoice_id: inv.id });
    intent();
    expect((await webhook(cardSession())).status).toBe(200);
    expect(mock.invoiceUpdates).toEqual([{ id: inv.id, params: { default_payment_method: "pm_new" } }]);
    expect(mock.payAttempts).toEqual([{ id: inv.id, params: { payment_method: "pm_new" } }]);
    // Stripe then reports the payment; the existing invoice path reinstates the account
    const paid = await webhook({ id: inv.id, object: "invoice", hosted_invoice_url: "https://invoice.stripe.test/x", metadata: { kind: "payg_settlement", account: "acme-123456", month: "2026-09" } }, "invoice.paid");
    expect(paid.status).toBe(200);
    expect(a.status).toBe("active");
    expect((db.rows("usage_settlements") as any[])[0].status).toBe("paid");
  });

  it("a card that is declined again does not fail the replacement or the webhook, and a paid invoice is left alone", async () => {
    paygAccount(db, { status: "past_due" });
    const bad = await mock.invoices.create({ customer: "cus_acme", metadata: {} } as any);
    await mock.invoices.finalizeInvoice(bad.id);
    const done = await mock.invoices.create({ customer: "cus_acme", metadata: {} } as any);
    done.status = "paid";
    db.insertRow("usage_settlements", { account: "acme-123456", month: "2026-08", units: 5, amount_cents: 1000, status: "failed", stripe_invoice_id: bad.id });
    db.insertRow("usage_settlements", { account: "acme-123456", month: "2026-09", units: 5, amount_cents: 1000, status: "failed", stripe_invoice_id: done.id });
    mock.declineCards.add("pm_new");
    intent();
    expect((await webhook(cardSession())).status).toBe(200);
    expect(acct().stripe_payment_method_id).toBe("pm_new");
  });

  it("is refused (acknowledged, nothing changed) for a different customer, a setup intent that is not ours, an unsucceeded one, a free or cancelled account", async () => {
    paygAccount(db);
    intent();
    await webhook(cardSession({ customer: "cus_someone_else" }));
    expect(acct().stripe_payment_method_id).toBe("pm_acme");
    intent({ metadata: { kind: "api_payg_card_update", account_id: "other" } });
    await webhook(cardSession());
    expect(acct().stripe_payment_method_id).toBe("pm_acme");
    intent({ metadata: { kind: "api_payg_enable", account_id: "acme-123456" } }); // an enable intent cannot be replayed as a card update
    await webhook(cardSession());
    expect(acct().stripe_payment_method_id).toBe("pm_acme");
    intent({ status: "requires_action" });
    await webhook(cardSession());
    expect(acct().stripe_payment_method_id).toBe("pm_acme");
    intent();
    acct().status = "cancelled";
    await webhook(cardSession());
    expect(acct().stripe_payment_method_id).toBe("pm_acme");
    acct().status = "active"; acct().plan = "api_free";
    await webhook(cardSession());
    expect(acct().stripe_payment_method_id).toBe("pm_acme");
  });

  it("answers 500 so Stripe redelivers when Stripe or the account write fails, and the redelivery succeeds", async () => {
    paygAccount(db);
    intent();
    mock.failOnce.add("setupIntents.retrieve");
    expect((await webhook(cardSession())).status).toBe(500);
    db.failMethod = { method: "PATCH", status: 500, body: "{}" };
    expect((await webhook(cardSession())).status).toBe(500);
    db.failMethod = null;
    expect((await webhook(cardSession())).status).toBe(200);
    expect(acct().stripe_payment_method_id).toBe("pm_new");
  });
});
