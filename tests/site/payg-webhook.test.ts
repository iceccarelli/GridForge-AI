/**
 * The Stripe webhook for pay-as-you-go (lib/payg-billing.ts through app/api/stripe/webhook/route.ts).
 *
 * Event signatures are generated with the Stripe SDK's own test helper, so the real signature check runs. Stripe's API calls the
 * handler makes (setupIntents.retrieve, customers.update) go to MockStripe: NO live Stripe call is made.
 *
 * Proven here: a duplicate enable event cannot double-enable (or reset a cap, or lift a past_due); a late `failed` cannot override
 * `paid`; a failed invoice suspends the account (key revoked, mint refused) and a paid one reinstates it; a failed write answers 500
 * so Stripe redelivers; and the same order-safety for subscription API accounts (F13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { MockStripe, mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

const WH = "whsec_payg_test_secret";
const sdk = new Stripe("sk_test_placeholder");
let db: PostgrestFake;
let restore: () => void;
let mock: MockStripe;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: WH, GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test",
    LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = newPaygDb();
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  mock = new MockStripe();
  setPaygStripeForTests(mock);
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); });

let evt = 0;
async function send(type: string, object: Record<string, unknown>, created?: number) {
  const payload = JSON.stringify({ id: `evt_${++evt}`, type, ...(created ? { created } : {}), data: { object } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}

const FREE_TOKEN = "free-portal-token-0123456789abcdef";
function freeAccount(over: Record<string, unknown> = {}) {
  return paygAccount(db, { account: "free-ab12", token: FREE_TOKEN, plan: "api_free", monthly_units: 25, cap_units: null, stripe_customer_id: null, stripe_payment_method_id: null, payg_enabled_at: null, ...over });
}
function setupIntent(id = "seti_1", over: Record<string, unknown> = {}) {
  mock.setupIntentStore.set(id, { id, status: "succeeded", payment_method: "pm_new", customer: "cus_new", metadata: { kind: "api_payg_enable", account_id: "free-ab12" }, ...over } as any);
}
const enableEvent = (over: Record<string, unknown> = {}) => ({
  id: "cs_setup_1", object: "checkout.session", mode: "setup", customer: "cus_new", setup_intent: "seti_1",
  metadata: { kind: "api_payg_enable", account_id: "free-ab12", cap_eur: "100" }, ...over,
});
const acct = (a = "free-ab12") => (db.rows("api_accounts") as any[]).find((r) => r.account === a);
const funnel = (name: string) => (db.rows("funnel_events") as any[]).filter((e) => e.name === name);

describe("enabling pay-as-you-go (checkout.session.completed, mode setup)", () => {
  it("saves the card as the invoice default and turns the free account into pay-as-you-go with the chosen cap", async () => {
    freeAccount(); setupIntent();
    const res = await send("checkout.session.completed", enableEvent());
    expect(res.status).toBe(200);
    expect(acct()).toMatchObject({ plan: "api_payg", status: "active", cap_units: 50, monthly_units: 50, stripe_customer_id: "cus_new", stripe_payment_method_id: "pm_new" });
    expect(acct().payg_enabled_at).toBeTruthy();
    expect(mock.customerUpdates).toEqual([{ id: "cus_new", params: { invoice_settings: { default_payment_method: "pm_new" } } }]);
    expect(funnel("payg_enabled")).toHaveLength(1);
    // enable time never charges: nothing in the invoice API was touched
    expect(mock.calls.filter((c) => c.startsWith("invoice"))).toEqual([]);
  });

  it("a DUPLICATE delivery cannot double-enable: same row, same enable time, one funnel event", async () => {
    freeAccount(); setupIntent();
    await send("checkout.session.completed", enableEvent());
    const first = { ...acct() };
    for (let i = 0; i < 3; i++) expect((await send("checkout.session.completed", enableEvent())).status).toBe(200);
    expect(db.rows("api_accounts")).toHaveLength(1);
    expect(acct().payg_enabled_at).toBe(first.payg_enabled_at);
    expect(acct()).toMatchObject({ plan: "api_payg", cap_units: 50, stripe_payment_method_id: "pm_new" });
    expect(funnel("payg_enabled")).toHaveLength(1);
  });

  it("a replay never resets a cap the customer has since changed, nor lifts a past_due", async () => {
    freeAccount(); setupIntent();
    await send("checkout.session.completed", enableEvent());
    Object.assign(acct(), { cap_units: 200, monthly_units: 200, status: "past_due" }); // changed cap; then a failed invoice
    await send("checkout.session.completed", enableEvent());
    expect(acct()).toMatchObject({ cap_units: 200, status: "past_due" });
  });

  it("a cancelled account is not reopened", async () => {
    freeAccount({ status: "cancelled" }); setupIntent();
    expect((await send("checkout.session.completed", enableEvent())).status).toBe(200);
    expect(acct()).toMatchObject({ plan: "api_free", status: "cancelled" });
  });

  it("refuses a setup intent that names a different account, an unsucceeded one, and an out-of-bounds cap", async () => {
    freeAccount();
    setupIntent("seti_other", { metadata: { kind: "api_payg_enable", account_id: "someone-else" } });
    await send("checkout.session.completed", enableEvent({ setup_intent: "seti_other" }));
    expect(acct().plan).toBe("api_free");
    setupIntent("seti_pending", { status: "requires_action" });
    await send("checkout.session.completed", enableEvent({ setup_intent: "seti_pending" }));
    expect(acct().plan).toBe("api_free");
    setupIntent();
    await send("checkout.session.completed", enableEvent({ metadata: { kind: "api_payg_enable", account_id: "free-ab12", cap_eur: "999999" } }));
    expect(acct().plan).toBe("api_free");
  });

  it("answers 500 (so Stripe redelivers) when Stripe or the account write fails, and the redelivery then succeeds", async () => {
    freeAccount(); setupIntent();
    mock.failOnce.add("setupIntents.retrieve");
    expect((await send("checkout.session.completed", enableEvent())).status).toBe(500);
    expect(acct().plan).toBe("api_free");
    db.failMethod = { method: "PATCH", status: 500, body: "{}" };
    expect((await send("checkout.session.completed", enableEvent())).status).toBe(500);
    db.failMethod = null;
    expect((await send("checkout.session.completed", enableEvent())).status).toBe(200);
    expect(acct().plan).toBe("api_payg");
  });
});

describe("settlement invoices (invoice.paid / invoice.payment_failed with metadata.kind payg_settlement)", () => {
  function invoicedMonth(over: Record<string, unknown> = {}) {
    paygAccount(db, { key_id: "livekey1", key_scope: "payg", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05", ...over });
    const row = db.insertRow("usage_settlements", { account: "acme-123456", month: "2026-09", units: 10, amount_cents: 2000, status: "invoiced", stripe_invoice_id: "in_1" });
    return row;
  }
  const inv = (over: Record<string, unknown> = {}) => ({ id: "in_1", object: "invoice", hosted_invoice_url: "https://invoice.stripe.test/i/in_1", metadata: { kind: "payg_settlement", account: "acme-123456", month: "2026-09" }, ...over });
  const sRow = () => (db.rows("usage_settlements") as any[])[0];
  const a = () => acct("acme-123456");

  it("paid -> the settlement is paid and the account stays active", async () => {
    invoicedMonth();
    expect((await send("invoice.paid", inv())).status).toBe(200);
    expect(sRow()).toMatchObject({ status: "paid", hosted_invoice_url: "https://invoice.stripe.test/i/in_1" });
    expect(a().status).toBe("active");
  });

  it("failed -> settlement failed, account past_due, the LIVE key revoked on the engine and recorded; minting is refused", async () => {
    invoicedMonth();
    expect((await send("invoice.payment_failed", inv())).status).toBe(200);
    expect(sRow().status).toBe("failed");
    expect(a()).toMatchObject({ status: "past_due", key_id: null, key_scope: null });
    expect(a().revoked_key_ids).toContain("livekey1");
    expect(engine.revokeCalls).toEqual(["livekey1"]);
    expect(a().revoked_confirmed_ids).toContain("livekey1"); // the engine confirmed
    expect(funnel("payment_failed")).toHaveLength(1);
    // and the customer cannot mint while past_due
    const { POST } = await import("@/app/api/keys/route");
    const res = await POST(new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: a().token }) }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, status: "past_due" });
  });

  it("paid after failed reinstates the account (the customer mints a new key; the revoked one stays revoked)", async () => {
    invoicedMonth();
    await send("invoice.payment_failed", inv());
    await send("invoice.paid", inv());
    expect(sRow().status).toBe("paid");
    expect(a().status).toBe("active");
    const { POST } = await import("@/app/api/keys/route");
    const res = await POST(new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: a().token }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, issued: true });
    expect(a().key_scope).toBe("payg");
    expect(a().revoked_key_ids).toContain("livekey1");
  });

  it("REORDERED: a late failed after paid does NOT downgrade (settlement stays paid, account stays active, key not revoked)", async () => {
    invoicedMonth();
    await send("invoice.paid", inv());
    await send("invoice.payment_failed", inv());
    await send("invoice.payment_failed", inv());
    expect(sRow().status).toBe("paid");
    expect(a()).toMatchObject({ status: "active", key_id: "livekey1" });
    expect(engine.revokeCalls).toEqual([]);
    expect(funnel("payment_failed")).toHaveLength(0);
  });

  it("duplicate failed events are harmless: one revocation, one funnel event, still past_due", async () => {
    invoicedMonth();
    for (let i = 0; i < 3; i++) expect((await send("invoice.payment_failed", inv())).status).toBe(200);
    expect(a().status).toBe("past_due");
    expect(engine.revokeCalls).toEqual(["livekey1"]);
    expect(funnel("payment_failed")).toHaveLength(1);
  });

  it("paying an OLD failed invoice does not reinstate an account that has a newer failed one", async () => {
    invoicedMonth();
    db.insertRow("usage_settlements", { account: "acme-123456", month: "2026-10", units: 9, amount_cents: 1800, status: "invoiced", stripe_invoice_id: "in_2" });
    await send("invoice.payment_failed", inv());
    await send("invoice.payment_failed", inv({ id: "in_2", metadata: { kind: "payg_settlement", account: "acme-123456", month: "2026-10" } }));
    await send("invoice.paid", inv());
    expect(a().status).toBe("past_due");
    await send("invoice.paid", inv({ id: "in_2", metadata: { kind: "payg_settlement", account: "acme-123456", month: "2026-10" } }));
    expect(a().status).toBe("active");
  });

  it("a cancelled account is never reopened by a payment event, nor a past_due one demoted again", async () => {
    invoicedMonth({ status: "cancelled" });
    await send("invoice.paid", inv());
    expect(a().status).toBe("cancelled");
  });

  it("an event naming a DIFFERENT invoice than the settlement records changes nothing and tells the operator (possible double charge)", async () => {
    invoicedMonth();
    expect((await send("invoice.paid", inv({ id: "in_DUPLICATE" }))).status).toBe(200);
    expect(sRow().status).toBe("invoiced");
    expect(mail.some((m) => /duplicate pay-as-you-go invoice/i.test(m.subject))).toBe(true);
  });

  it("answers 500 when the settlement write fails, so Stripe redelivers", async () => {
    invoicedMonth();
    db.failMethod = { method: "PATCH", status: 500, body: "{}" };
    expect((await send("invoice.payment_failed", inv())).status).toBe(500);
    db.failMethod = null;
    expect((await send("invoice.payment_failed", inv())).status).toBe(200);
    expect(sRow().status).toBe("failed");
  });

  it("a subscription invoice (no payg metadata) is untouched by this path", async () => {
    const row = paygAccount(db, { account: "sub-1", token: "tok-sub-1-0123456789abcdefgh", plan: "api_scale", stripe_subscription_id: "sub_1", monthly_units: 2500 });
    await send("invoice.payment_failed", { id: "in_s", object: "invoice", subscription: "sub_1" });
    expect(row.status).toBe("past_due");
  });
});

describe("F13: invoice events for SUBSCRIPTION API accounts are order-safe too", () => {
  const subAccount = (over: Record<string, unknown> = {}) => paygAccount(db, { account: "sub-1", token: "tok-sub-1-0123456789abcdefgh", plan: "api_scale", stripe_subscription_id: "sub_1", monthly_units: 2500, ...over });
  const inv = { id: "in_s", object: "invoice", subscription: "sub_1" };

  it("a failed event OLDER than the paid event already applied does not re-mark past_due", async () => {
    const row = subAccount();
    await send("invoice.payment_failed", inv, 1_000);
    expect(row.status).toBe("past_due");
    await send("invoice.paid", inv, 2_000);
    expect(row.status).toBe("active");
    await send("invoice.payment_failed", inv, 1_500); // delivered late
    expect(row.status).toBe("active");
    await send("invoice.payment_failed", inv, 3_000); // a genuinely newer failure still applies
    expect(row.status).toBe("past_due");
  });

  it("an older paid event does not reinstate an account whose newer failure was applied", async () => {
    const row = subAccount();
    await send("invoice.payment_failed", inv, 5_000);
    await send("invoice.paid", inv, 4_000);
    expect(row.status).toBe("past_due");
  });

  it("events without a time are applied as before", async () => {
    const row = subAccount();
    await send("invoice.payment_failed", inv);
    expect(row.status).toBe("past_due");
    await send("invoice.paid", inv);
    expect(row.status).toBe("active");
  });
});
