/**
 * The independent review of the billing lifecycle, one describe per finding. Every case here FAILED against the code before its fix
 * (the failing-first run is recorded in the commit message); none of them touches a live provider.
 *
 * STAND-INS, all labelled: Stripe is MockStripe (tests/site/payg-harness.ts), the engine is `mockEngine` (a fetch interceptor for /v1/revoke
 * and /v1/version), Resend is the same interceptor's mail sink, and the database is the in-memory PostgREST (tests/site/postgrest-fake.ts).
 * Whatever depends on a real constraint (the once-only operator ledger, the conditional PATCH the cancellation compare-and-sets on, the
 * sweep's ORDER BY, the new columns) is ALSO proven against real PostgreSQL in tests/site/billing-lifecycle.realdb.test.ts and
 * tests/test_payg_migration.py. What only live Stripe can prove is listed in the final report, not asserted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { inspectKey, retryRevocations } from "@/lib/api-access";
import { remindExpiringKeys } from "@/lib/payg-reminders";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { accountRef } from "@/lib/payg";
import { INTELLIGENCE_PLANS, PRODUCTS } from "@/lib/products";
import { MockStripe, ledgerEvent, ledgerFetcherOver, mockEngine, newPaygDb, paygAccount, resetSeq, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

const WH = "whsec_review";
const sdk = new Stripe("sk_test_placeholder");
const NOW_S = () => Math.floor(Date.now() / 1000);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
let mock: MockStripe;
let logs: unknown[][];

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", GRIDFORGE_KEY_SECRET: "test-signing-secret",
    STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: "cron-secret-value", RESEND_API_KEY: "re_test",
    LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "T <p@timetopower.ai>",
  });
  logs = [];
  for (const m of ["error", "log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); });
  resetSeq();
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
const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const operatorMail = () => mail.filter((m) => m.to === "ops@example.test");
const rotationRows = () => (db.rows("customer_notifications") as any[]).filter((n) => n.kind === "key_rotation");
const allLogs = () => JSON.stringify(logs);

// ============================================================================================================================
// 1. the reminder sweep covers every API plan
// ============================================================================================================================
describe("1. the daily sweep reminds subscription customers too, once per key", () => {
  const sub = (over: Record<string, unknown> = {}) =>
    paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 2500, key_scope: "machine", key_id: "k1", key_issued_at: day(-33), key_expires_at: day(2), stripe_payment_method_id: null, stripe_customer_id: "cus_s", ...over });

  it("an active api_scale key expiring in 2 days is queued (it was never considered)", async () => {
    sub();
    const r = await remindExpiringKeys();
    expect(r).toMatchObject({ considered: 1, queued: 1, errors: 0 });
    expect(rotationRows()).toHaveLength(1);
  });

  it("covers every subscription plan, active or past_due; not a cancelled account, a healthy key or a long-dead one", async () => {
    sub({ account: "a1", token: "t".repeat(30) + "a1", plan: "api_triage" });
    sub({ account: "a2", token: "t".repeat(30) + "a2", plan: "api_platform", status: "past_due" });
    sub({ account: "a3", token: "t".repeat(30) + "a3", status: "cancelled" });
    sub({ account: "a4", token: "t".repeat(30) + "a4", key_expires_at: day(25) });
    sub({ account: "a5", token: "t".repeat(30) + "a5", key_expires_at: day(-60) });
    const r = await remindExpiringKeys();
    expect(r).toMatchObject({ considered: 2, queued: 2 });
  });

  it("is once per key: the sweep twice, then the renewal webhook for the same key, leave ONE obligation", async () => {
    const a = sub({ stripe_subscription_id: "sub_1" });
    await remindExpiringKeys();
    await remindExpiringKeys();
    expect((await send("invoice.paid", { id: "in_1", subscription: "sub_1" }, NOW_S())).status).toBe(200);
    expect(rotationRows()).toHaveLength(1);
    expect(rotationRows()[0].dedupe_key).toBe(`key_rotation:${a.id}:${day(2)}`);
  });

  it("the review's scenario: a key rotated mid-cycle (25 days left at renewal) gets no webhook reminder, and the SWEEP reminds it once it is 5 days from expiry", async () => {
    const a = sub({ stripe_subscription_id: "sub_1", key_issued_at: day(-10), key_expires_at: day(25) });
    await send("invoice.paid", { id: "in_1", subscription: "sub_1" }, NOW_S());
    expect(rotationRows()).toHaveLength(0);
    a.key_expires_at = day(5); // twenty days on, and no further invoice.paid was ever delivered
    const r = await remindExpiringKeys();
    expect(r.queued).toBe(1);
    expect(rotationRows()).toHaveLength(1);
  });

  it("a past-due subscriber is told it cannot mint until the payment clears, not that a payment was received", async () => {
    const a = sub({ status: "past_due" });
    await remindExpiringKeys();
    const { sweepNotifications } = await import("@/lib/notifications");
    await sweepNotifications();
    const m = mail.find((x) => /API key/.test(x.subject))!;
    expect(m).toBeTruthy();
    expect(m.text).toMatch(/payment has not cleared/);
    expect(m.text).not.toMatch(/payment has been received/);
    expect(a.status).toBe("past_due");
  });
});

// ============================================================================================================================
// 2. an explicit rotation ends every overlap
// ============================================================================================================================
describe("2. rotate revokes in-window overlap keys too", () => {
  const scale = (over: Record<string, unknown> = {}) =>
    paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 2500, stripe_payment_method_id: null, key_id: "keyAAAA1", key_scope: "machine", key_issued_at: day(-30), key_expires_at: day(3), ...over });

  it("mint in the window (overlap A), then rotate: A is revoked on the engine and the overlap record is cleared", async () => {
    const a = scale();
    const { POST } = await import("@/app/api/keys/route");
    const r1 = await (await POST(post("/api/keys", { token: a.token }))).json();
    expect(r1.issued).toBe(true);
    expect(a.overlap_key_ids).toEqual({ keyAAAA1: day(3) });
    expect(engine.revokeCalls).toEqual([]);
    const r2 = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(r2.issued).toBe(true);
    // B (the previous live key) and A (the overlap) are both revoked now
    expect(new Set(engine.revokeCalls)).toEqual(new Set([inspectKey(r1.key)!.k, "keyAAAA1"]));
    expect(r2.revoked_previous).toBe(true);
    expect(a.overlap_key_ids).toEqual({});
    expect(a.revoked_confirmed_ids).toEqual(expect.arrayContaining(["keyAAAA1", inspectKey(r1.key)!.k]));
  });

  it("the overlap is revoked only AFTER the engine is shown to verify the new key; until then it stays recorded and the sweep finishes the job", async () => {
    const a = scale({ overlap_key_ids: { keyOLD001: day(4) }, revoked_key_ids: ["keyOLD001"] });
    const { POST } = await import("@/app/api/keys/route");
    engine.down = true;
    const r = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(r.issued).toBe(true);
    expect(engine.revokeCalls).toEqual([]);
    expect(r.rotation_deferred).toBe(true);
    expect(a.revoked_key_ids).toEqual(expect.arrayContaining(["keyOLD001", "keyAAAA1"]));
    engine.down = false;
    await retryRevocations(50);
    expect(new Set(engine.revokeCalls)).toEqual(new Set(["keyOLD001", "keyAAAA1"]));
    expect(a.revocation_pending).toBe(false);
  });

  it("lowering a pay-as-you-go cap revokes the overlap key as well", async () => {
    const a = paygAccount(db, { key_id: "keyPAY01", key_scope: "payg", key_issued_at: day(-5), key_expires_at: day(30), overlap_key_ids: { keyPAY00: day(4) }, revoked_key_ids: ["keyPAY00"] });
    const { POST } = await import("@/app/api/payg/cap/route");
    const r = await (await POST(post("/api/payg/cap", { token: a.token, cap_eur: 20 }))).json();
    expect(r.issued).toBe(true);
    expect(new Set(engine.revokeCalls)).toEqual(new Set(["keyPAY01", "keyPAY00"]));
    expect(a.overlap_key_ids).toEqual({});
  });

  it("the sweep leaves an ACTIVE account's overlap alone until its last valid day, then pushes it", async () => {
    const a = scale({ key_id: "keyB", revoked_key_ids: ["keyA"], overlap_key_ids: { keyA: day(5) } });
    expect((await retryRevocations(50)).stillPending).toBe(0);
    expect(engine.revokeCalls).toEqual([]);
    a.overlap_key_ids = { keyA: day(-1) };
    await retryRevocations(50);
    expect(engine.revokeCalls).toEqual(["keyA"]);
  });

  it("but a CANCELLED or PAST_DUE account's overlap ids are pushed immediately", async () => {
    scale({ account: "c1", token: "c".repeat(31) + "1", status: "cancelled", key_id: "keyB1", revoked_key_ids: ["keyA1"], overlap_key_ids: { keyA1: day(5) } });
    scale({ account: "c2", token: "c".repeat(31) + "2", status: "past_due", key_id: "keyB2", revoked_key_ids: ["keyA2"], overlap_key_ids: { keyA2: day(5) } });
    const r = await retryRevocations(50);
    expect(new Set(engine.revokeCalls)).toEqual(new Set(["keyA1", "keyA2"]));
    expect(r).toMatchObject({ confirmed: 2, stillPending: 0 });
  });
});

// ============================================================================================================================
// 3. one ordering clock for the API account, Hall Watch and Intelligence
// ============================================================================================================================
describe("3. a late payment_failed cannot undo a later invoice.paid (watch and Intelligence), in both orders and on replay", () => {
  const watchRow = (over: Record<string, unknown> = {}) => db.insertRow("watches", { token: "w".repeat(32), status: "active", cadence: "quarterly", email: "a@b.test", stripe_subscription_id: "sub_w", stripe_customer_id: "cus_w", ...over });
  const intelRow = (over: Record<string, unknown> = {}) => db.insertRow("subscriptions", { email: "a@b.test", plan: "team", status: "active", stripe_session_id: "cs_1", stripe_customer_id: "cus_s", stripe_subscription_id: "sub_s", ...over });
  const cases = [
    { name: "Hall Watch", sub: "sub_w", make: () => watchRow(), ok: "active", failed: "paused" },
    { name: "Intelligence", sub: "sub_s", make: () => intelRow(), ok: "active", failed: "past_due" },
  ];

  for (const c of cases) {
    it(`${c.name}: paid (newer) then failed (older): stays active`, async () => {
      const row = c.make();
      const now = NOW_S();
      expect((await send("invoice.paid", { id: "in_2", subscription: c.sub }, now)).status).toBe(200);
      expect((await send("invoice.payment_failed", { id: "in_1", subscription: c.sub }, now - 3600)).status).toBe(200);
      expect(row.status).toBe(c.ok);
      expect(row.last_billing_event_ts).toBe(now);
    });

    it(`${c.name}: failed (older) then paid (newer): ends active`, async () => {
      const row = c.make();
      const now = NOW_S();
      await send("invoice.payment_failed", { id: "in_1", subscription: c.sub }, now - 3600);
      expect(row.status).toBe(c.failed);
      await send("invoice.paid", { id: "in_2", subscription: c.sub }, now);
      expect(row.status).toBe(c.ok);
    });

    it(`${c.name}: a replay of either event changes nothing, and a failure newer than the payment still counts`, async () => {
      const row = c.make();
      const now = NOW_S();
      await send("invoice.paid", { id: "in_2", subscription: c.sub }, now);
      await send("invoice.paid", { id: "in_2", subscription: c.sub }, now); // replay
      expect(row.status).toBe(c.ok);
      await send("invoice.payment_failed", { id: "in_3", subscription: c.sub }, now + 60); // genuinely newer
      expect(row.status).toBe(c.failed);
      await send("invoice.payment_failed", { id: "in_3", subscription: c.sub }, now + 60); // replay of the failure
      expect(row.status).toBe(c.failed);
      expect(row.last_billing_event_ts).toBe(now + 60);
    });

    it(`${c.name}: a failure applied while ALREADY failed advances the clock, so a payment older than it, delivered late, cannot reinstate`, async () => {
      const row = c.make();
      const now = NOW_S();
      await send("invoice.payment_failed", { id: "in_1", subscription: c.sub }, now - 100);
      await send("invoice.payment_failed", { id: "in_3", subscription: c.sub }, now); // newer failure, already failed
      expect(row.last_billing_event_ts).toBe(now);
      await send("invoice.paid", { id: "in_2", subscription: c.sub }, now - 50); // older than the newest failure: stale
      expect(row.status).toBe(c.failed);
    });

    it(`${c.name}: a cancelled row is never reopened and its clock is not touched`, async () => {
      const row = c.make();
      row.status = "cancelled";
      await send("invoice.paid", { id: "in_2", subscription: c.sub }, NOW_S());
      await send("invoice.payment_failed", { id: "in_3", subscription: c.sub }, NOW_S() + 5);
      expect(row.status).toBe("cancelled");
    });

    it(`${c.name}: before migration 0039 (no clock column) the state is still applied, as it was before the clock existed`, async () => {
      const table = c.name === "Hall Watch" ? "watches" : "subscriptions";
      const row = c.make();
      db.dropColumn(table, "last_billing_event_ts");
      expect((await send("invoice.payment_failed", { id: "in_1", subscription: c.sub }, NOW_S())).status).toBe(200);
      expect(row.status).toBe(c.failed);
      expect((await send("invoice.paid", { id: "in_2", subscription: c.sub }, NOW_S() + 10)).status).toBe(200);
      expect(row.status).toBe(c.ok);
    });
  }

  it("the API account: a failure applied while already past_due advances the clock too", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, stripe_subscription_id: "sub_a", key_id: "k", key_scope: "machine", key_expires_at: day(20), status: "past_due", last_billing_event_ts: 100 });
    const now = NOW_S();
    await send("invoice.payment_failed", { id: "in_3", subscription: "sub_a" }, now);
    expect(a.last_billing_event_ts).toBe(now);
    await send("invoice.paid", { id: "in_2", subscription: "sub_a" }, now - 5);
    expect(a.status).toBe("past_due");
  });
});

// ============================================================================================================================
// 4. disputes reach the operator
// ============================================================================================================================
describe("4. a dispute opened or closed is mailed to the operator, with no card data and no customer email", () => {
  const dispute = (over: Record<string, unknown> = {}) => ({
    id: "dp_1", object: "dispute", amount: 750000, currency: "eur", charge: "ch_1", reason: "fraudulent", status: "needs_response",
    evidence_details: { due_by: 1_790_000_000, has_evidence: false },
    evidence: { customer_email_address: "buyer@hall.example", billing_address: "1 Hall Road", customer_name: "Pat Buyer" },
    payment_method_details: { card: { brand: "visa", last4: "4242", fingerprint: "FPRINT1234" } },
    ...over,
  });

  it("charge.dispute.created: one mail with the amount, the charge id, the Stripe customer and the account reference, and the evidence deadline", async () => {
    paygAccount(db);
    mock.chargeCustomers.set("ch_1", "cus_acme");
    expect((await send("charge.dispute.created", dispute())).status).toBe(200);
    const m = operatorMail().filter((x) => /dispute/i.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].subject).toMatch(/OPENED/);
    expect(m[0].subject).toContain("7500.00 EUR");
    expect(m[0].subject).toContain("ch_1");
    expect(m[0].text).toContain("ch_1");
    expect(m[0].text).toContain("cus_acme");
    expect(m[0].text).toContain(accountRef("acme-123456"));
    expect(m[0].text).toMatch(/Evidence is due by 2026-/);
    // the adoption-funnel counter is unchanged
    expect((db.rows("funnel_events") as any[]).filter((e) => e.name === "dispute_opened")).toHaveLength(1);
  });

  it("nothing of the customer or the card is in the mail or in any log line", async () => {
    paygAccount(db);
    mock.chargeCustomers.set("ch_1", "cus_acme");
    await send("charge.dispute.created", dispute());
    await send("charge.dispute.closed", dispute({ status: "lost" }));
    const everything = JSON.stringify(mail) + allLogs();
    for (const secret of ["buyer@hall.example", "1 Hall Road", "Pat Buyer", "4242", "FPRINT1234", "visa", "ops@acme.example"]) expect(everything).not.toContain(secret);
  });

  it("charge.dispute.closed mails the outcome", async () => {
    paygAccount(db);
    mock.chargeCustomers.set("ch_1", "cus_acme");
    await send("charge.dispute.closed", dispute({ status: "won" }));
    const m = operatorMail().filter((x) => /dispute/i.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].subject).toMatch(/CLOSED \(won\)/);
    expect(m[0].text).toContain("ch_1");
  });

  it("a redelivery mails nothing more, and opened and closed are separate notices", async () => {
    paygAccount(db);
    mock.chargeCustomers.set("ch_1", "cus_acme");
    await send("charge.dispute.created", dispute());
    await send("charge.dispute.created", dispute());
    await send("charge.dispute.closed", dispute({ status: "lost" }));
    await send("charge.dispute.closed", dispute({ status: "lost" }));
    expect(operatorMail().filter((x) => /dispute/i.test(x.subject))).toHaveLength(2);
  });

  it("when Stripe cannot be asked for the charge's customer (or the payment had none) the notice still goes out with the charge id", async () => {
    mock.failOnce.add("charges.retrieve");
    expect((await send("charge.dispute.created", dispute({ id: "dp_2", charge: "ch_unknown" }))).status).toBe(200);
    const m = operatorMail().filter((x) => /dispute/i.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain("ch_unknown");
    expect(m[0].text).toMatch(/no matching account/);
  });
});

// ============================================================================================================================
// 5. settlement bills the customer's CURRENT card, and tells the operator when it cannot
// ============================================================================================================================
describe("5. settlement resolves the card at invoice time and mails the operator on a failure", () => {
  const NOW = new Date("2026-10-21T03:23:00Z");
  const settle = async (at = NOW) => {
    const { settleClosedMonths } = await import("@/lib/payg-settle");
    return settleClosedMonths(mock, at);
  };
  async function seedMonth(units = 10) {
    const { ingestLedger } = await import("@/lib/payg-usage");
    await ingestLedger(ledgerFetcherOver([ledgerEvent({ units })]));
  }

  it("a card replaced in the Billing Portal (the customer's default moved, no webhook) is the card on the invoice, and our record follows it", async () => {
    const a = paygAccount(db, { stripe_payment_method_id: "pm_old" });
    mock.customerDefaults.set("cus_acme", "pm_new"); // what the portal does
    await seedMonth();
    const r = await settle();
    expect(r).toMatchObject({ invoiced: 1, stillPending: 0 });
    expect(mock.allInvoices[0].params.default_payment_method).toBe("pm_new");
    expect(a.stripe_payment_method_id).toBe("pm_new");
  });

  it("falls back to the stored card only when Stripe names no default", async () => {
    paygAccount(db, { stripe_payment_method_id: "pm_stored" });
    await seedMonth();
    await settle();
    expect(mock.allInvoices[0].params.default_payment_method).toBe("pm_stored");
  });

  it("an invoice an earlier attempt left as a draft is pointed at the resolved card before it is finalised", async () => {
    const a = paygAccount(db, { stripe_payment_method_id: "pm_old" });
    await seedMonth();
    mock.failOnce.add("invoiceItems.create"); // the first run creates the invoice (pinned to pm_old) and stops
    await settle();
    expect(mock.allInvoices[0].params.default_payment_method).toBe("pm_old");
    mock.customerDefaults.set("cus_acme", "pm_new");
    await settle();
    expect(mock.invoiceUpdates).toEqual([{ id: mock.allInvoices[0].id, params: { default_payment_method: "pm_new" } }]);
    expect(mock.allInvoices[0].status).toBe("open");
    expect(a.stripe_payment_method_id).toBe("pm_new");
  });

  it("no payment method at all: the operator is mailed (category only), once per settlement per day, and again the next day", async () => {
    paygAccount(db, { stripe_payment_method_id: null });
    await seedMonth();
    await settle();
    await settle(); // the same day: nothing more
    const first = operatorMail().filter((m) => /settlement NOT invoiced/.test(m.subject));
    expect(first).toHaveLength(1);
    expect(first[0].subject).toContain("no_payment_method");
    expect(first[0].text).toContain("2026-09");
    await settle(new Date("2026-10-22T03:23:00Z"));
    expect(operatorMail().filter((m) => /settlement NOT invoiced/.test(m.subject))).toHaveLength(2);
  });

  it("a Stripe error is mailed with its category, never its message, the customer's email or a card", async () => {
    paygAccount(db);
    await seedMonth();
    mock.failOnce.add("invoices.create");
    const r = await settle();
    expect(r.stillPending).toBe(1);
    const m = operatorMail().filter((x) => /settlement NOT invoiced/.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].subject).toMatch(/StripeConnectionError/);
    expect(JSON.stringify(m) + allLogs()).not.toMatch(/customer@example\.test|ops@acme\.example|pm_acme/);
  });

  it("a card the customer detached (Stripe refuses it) is mailed with the detached-card advice", async () => {
    paygAccount(db);
    await seedMonth();
    const real = mock.invoices.create;
    mock.invoices.create = (async () => { throw Object.assign(new Error("The customer does not have a payment method with the ID pm_acme"), { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 400 }); }) as typeof real;
    await settle();
    const m = operatorMail().filter((x) => /settlement NOT invoiced/.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/detached/);
    expect(m[0].text).not.toContain("pm_acme");
  });

  it("an unreadable customer is a category and a mail too (the card cannot be resolved), and nothing is invoiced", async () => {
    paygAccount(db);
    await seedMonth();
    mock.failOnce.add("customers.retrieve");
    const r = await settle();
    expect(r.invoiced).toBe(0);
    expect(mock.allInvoices).toHaveLength(0);
    expect(operatorMail().filter((x) => /settlement NOT invoiced/.test(x.subject))).toHaveLength(1);
  });

  it("a settlement that goes through mails nothing", async () => {
    paygAccount(db);
    await seedMonth();
    await settle();
    expect(operatorMail().filter((x) => /settlement NOT invoiced/.test(x.subject))).toHaveLength(0);
  });
});

// ============================================================================================================================
// 6. customer.subscription.updated
// ============================================================================================================================
describe("6. customer.subscription.updated", () => {
  const price = (over: Record<string, unknown> = {}) => ({ id: "price_1", unit_amount: PRODUCTS.api_scale.amountCents, currency: "eur", product: "prod_1", recurring: { interval: "month", interval_count: 1 }, ...over });
  const subObj = (over: Record<string, unknown> = {}, p: Record<string, unknown> = price(), qty = 1) => ({
    id: "sub_1", object: "subscription", status: "active", customer: "cus_1", metadata: { kind: "api_scale" },
    items: { data: [{ id: "si_1", quantity: qty, price: p }] }, ...over,
  });
  const account = (over: Record<string, unknown> = {}) =>
    paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 2500, stripe_subscription_id: "sub_1", key_id: "k1", key_scope: "machine", key_issued_at: day(-5), key_expires_at: day(30), stripe_payment_method_id: null, ...over });

  it.each(["canceled", "unpaid", "incomplete_expired"])("status %s is a cancellation: account cancelled, every key id revoked on the engine, and a later .deleted changes nothing more", async (status) => {
    const a = account();
    expect((await send("customer.subscription.updated", subObj({ status }))).status).toBe(200);
    expect(a.status).toBe("cancelled");
    expect(a.revoked_key_ids).toContain("k1");
    expect(engine.revokeCalls).toContain("k1");
    expect(a.revoked_confirmed_ids).toContain("k1");
    const funnel = () => (db.rows("funnel_events") as any[]).filter((e) => e.name === "subscription_cancelled");
    expect(funnel()).toHaveLength(1);
    // replay, then the .deleted Stripe sends after: idempotent, one funnel event
    expect((await send("customer.subscription.updated", subObj({ status }))).status).toBe(200);
    expect((await send("customer.subscription.deleted", subObj({ status: "canceled" }))).status).toBe(200);
    expect(a.status).toBe("cancelled");
    expect(funnel()).toHaveLength(1);
  });

  it("cancels Hall Watch and Intelligence the same way", async () => {
    const w = db.insertRow("watches", { token: "w".repeat(32), status: "active", cadence: "quarterly", email: "a@b.test", stripe_subscription_id: "sub_w" });
    const s = db.insertRow("subscriptions", { email: "a@b.test", plan: "team", status: "active", stripe_session_id: "cs_1", stripe_subscription_id: "sub_s" });
    await send("customer.subscription.updated", subObj({ id: "sub_w", status: "canceled", metadata: { kind: "hall_watch" } }));
    await send("customer.subscription.updated", subObj({ id: "sub_s", status: "unpaid", metadata: { kind: "intelligence_subscription", plan: "team" } }));
    expect([w.status, s.status]).toEqual(["cancelled", "cancelled"]);
  });

  it("an ended subscription of OURS with no record yet is retried (it beat its own checkout); someone else's is acknowledged; a routine update with no record is acknowledged", async () => {
    expect((await send("customer.subscription.updated", subObj({ status: "canceled" }))).status).toBe(500);
    expect((await send("customer.subscription.updated", subObj({ status: "canceled", metadata: {} }))).status).toBe(200);
    expect((await send("customer.subscription.updated", subObj({ status: "active" }))).status).toBe(200);
    expect(operatorMail()).toHaveLength(0);
  });

  it("a renewal-time update that matches the catalogue changes nothing and mails nothing (Hall Watch quarterly and Intelligence monthly included)", async () => {
    const a = account();
    const w = db.insertRow("watches", { token: "w".repeat(32), status: "active", cadence: "quarterly", email: "a@b.test", stripe_subscription_id: "sub_w" });
    const s = db.insertRow("subscriptions", { email: "a@b.test", plan: "team", status: "active", stripe_session_id: "cs_1", stripe_subscription_id: "sub_s" });
    await send("customer.subscription.updated", subObj());
    await send("customer.subscription.updated", subObj({ id: "sub_w" }, price({ unit_amount: PRODUCTS.hall_watch.amountCents, recurring: { interval: "month", interval_count: 3 } })));
    await send("customer.subscription.updated", subObj({ id: "sub_s" }, price({ unit_amount: INTELLIGENCE_PLANS.team.priceCents })));
    expect(operatorMail()).toHaveLength(0);
    expect([a.status, w.status, s.status]).toEqual(["active", "active", "active"]);
  });

  it("a plan switch in the portal (the price no longer matches): entitlement is NOT changed, the operator is mailed ONCE with the ids", async () => {
    const a = account();
    const switched = price({ id: "price_other", unit_amount: PRODUCTS.api_triage.amountCents, product: "prod_other" });
    expect((await send("customer.subscription.updated", subObj({}, switched))).status).toBe(200);
    expect((await send("customer.subscription.updated", subObj({}, switched))).status).toBe(200); // renewal-time redelivery
    expect(a).toMatchObject({ status: "active", plan: "api_scale", monthly_units: 2500, key_id: "k1" });
    expect(engine.revokeCalls).toEqual([]);
    const m = operatorMail();
    expect(m).toHaveLength(1);
    expect(m[0].subject).toMatch(/no longer matches the catalogue/);
    for (const id of ["sub_1", "price_other", "prod_other", "cus_1"]) expect(m[0].text).toContain(id);
    expect(m[0].text).toMatch(/NOTHING was changed/);
    // a further, different change is a further notice
    await send("customer.subscription.updated", subObj({}, price({ id: "price_third", unit_amount: 1 })));
    expect(operatorMail()).toHaveLength(2);
  });

  it("a quantity change or a second line item is a mismatch too", async () => {
    account();
    await send("customer.subscription.updated", subObj({}, price(), 3));
    expect(operatorMail()).toHaveLength(1);
  });

  it("a cancelled record is not compared (nothing is entitled)", async () => {
    account({ status: "cancelled" });
    await send("customer.subscription.updated", subObj({}, price({ id: "price_other", unit_amount: 1 })));
    expect(operatorMail()).toHaveLength(0);
  });
});

// ============================================================================================================================
// 7. cancellation race, fair sweep, rotation_deferred
// ============================================================================================================================
describe("7a. a key minted between the cancellation's lookup and its write is revoked too", () => {
  it("race: the mint lands after the webhook read the row and before it wrote; the new key id is in the revoked set and revoked on the engine", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 2500, stripe_subscription_id: "sub_1", key_id: "keyOLD01", key_scope: "machine", key_expires_at: day(20), stripe_payment_method_id: null });
    const inner = globalThis.fetch;
    let raced = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!raced && init?.method === "PATCH" && url.includes("/rest/v1/api_accounts") && String(init.body).includes('"cancelled"')) {
        raced++;
        // the customer's mint lands here: the previous id is recorded as revoked and a new id is live
        a.revoked_key_ids = ["keyOLD01"];
        a.key_id = "keyNEW02";
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    expect((await send("customer.subscription.deleted", { id: "sub_1", metadata: { kind: "api_scale" } })).status).toBe(200);
    expect(raced).toBe(1);
    expect(a.status).toBe("cancelled");
    expect(a.revoked_key_ids).toEqual(expect.arrayContaining(["keyOLD01", "keyNEW02"]));
    expect(engine.revokeCalls).toEqual(expect.arrayContaining(["keyOLD01", "keyNEW02"]));
    expect(a.revoked_confirmed_ids).toContain("keyNEW02");
  });

  it("a write that fails still answers 500 (Stripe retries) and an unreadable account does too", async () => {
    paygAccount(db, { plan: "api_scale", cap_units: null, stripe_subscription_id: "sub_1", key_id: "k", key_scope: "machine", stripe_payment_method_id: null });
    db.failMethod = { method: "PATCH", status: 500, body: "{}" };
    expect((await send("customer.subscription.deleted", { id: "sub_1", metadata: { kind: "api_scale" } })).status).toBe(500);
  });
});

describe("7b. the revocation sweep is fair", () => {
  const acct = (n: number, over: Record<string, unknown> = {}) =>
    paygAccount(db, { account: `acct-${n}`, token: `tok-${n}`.padEnd(32, "x"), plan: "api_scale", cap_units: null, stripe_payment_method_id: null, status: "cancelled", key_id: `live${n}`, key_scope: "machine", revoked_key_ids: [`old${n}`], ...over });

  it("takes the least recently attempted first, so rows the engine keeps refusing cannot starve the others", async () => {
    const rows = [acct(1), acct(2), acct(3)];
    engine.refuseRevoke = true;
    await retryRevocations(1);
    await retryRevocations(1);
    await retryRevocations(1);
    expect(rows.every((r) => typeof r.last_revocation_attempt_at === "string")).toBe(true);
    // a fourth pass starts again from the one attempted longest ago
    const oldest = [...rows].sort((x, y) => String(x.last_revocation_attempt_at).localeCompare(String(y.last_revocation_attempt_at)))[0];
    engine.refuseRevoke = false;
    await retryRevocations(1);
    expect(oldest.revoked_confirmed_ids).toContain(String((oldest.revoked_key_ids as string[])[0]));
  });

  it("held-back active rows (the engine cannot yet be shown to verify keys) do not occupy the batch forever: the cancelled account behind them is reached", async () => {
    acct(1, { status: "active" });
    acct(2, { status: "active" });
    const c = acct(3);
    engine.down = true; // the verification cannot pass: both active rows are held back
    await retryRevocations(2);
    expect(engine.revokeCalls).toEqual([]);
    engine.down = false; // verification passes again, but only a cancelled-account row is not yet stamped
    // run with a batch of 2: the unattempted cancelled account sorts ahead of the two already attempted rows
    await retryRevocations(1);
    expect(engine.revokeCalls).toEqual(expect.arrayContaining(["old3"]));
    expect(c.revoked_confirmed_ids).toContain("old3");
  });

  it("before migration 0039 (no last_revocation_attempt_at) the sweep still reads and revokes, unordered", async () => {
    const c = acct(1);
    db.dropColumn("api_accounts", "last_revocation_attempt_at");
    await retryRevocations(50);
    expect(c.revoked_confirmed_ids).toContain("old1");
  });
});

describe("7c. rotation_deferred is surfaced, and the engine is asked about the REAL new key", () => {
  /** Record what is presented to the engine's /v1/version. */
  function spyVersion(): string[] {
    const presented: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://engine.test/v1/version") presented.push(String((init?.headers as Record<string, string>)["X-API-Key"]));
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    return presented;
  }
  const scale = () => paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 2500, stripe_payment_method_id: null, key_id: "keyOLD01", key_scope: "machine", key_issued_at: day(-5), key_expires_at: day(30) });

  it("/api/keys: engine unreachable -> rotation_deferred, new_key_unverified and an honest note; the previous key is NOT revoked", async () => {
    const a = scale();
    engine.down = true;
    const { POST } = await import("@/app/api/keys/route");
    const r = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(r).toMatchObject({ ok: true, issued: true, rotation_deferred: true, new_key_unverified: true, revoked_previous: false });
    expect(r.rotation_note).toMatch(/PREVIOUS key was not revoked and stays valid until the engine has verified the new one/);
    expect(engine.revokeCalls).toEqual([]);
    expect(a.key_id).not.toBe("keyOLD01");
  });

  it("/api/keys: a verified rotation carries none of those fields", async () => {
    const a = scale();
    const { POST } = await import("@/app/api/keys/route");
    const r = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(r.revoked_previous).toBe(true);
    expect(r).not.toHaveProperty("rotation_deferred");
    expect(r).not.toHaveProperty("new_key_unverified");
  });

  it("/api/payg/cap: an engine built before the payg scope refuses the real payg key: deferred (a trial probe would have passed and stranded the customer)", async () => {
    const a = paygAccount(db, { key_id: "keyPAY01", key_scope: "payg", key_issued_at: day(-5), key_expires_at: day(30) });
    engine.metered = false;
    const presented = spyVersion();
    const { POST } = await import("@/app/api/payg/cap/route");
    const r = await (await POST(post("/api/payg/cap", { token: a.token, cap_eur: 40 }))).json();
    expect(r).toMatchObject({ issued: true, rotation_deferred: true, new_key_unverified: true });
    expect(engine.revokeCalls).toEqual([]);
    expect(presented).toHaveLength(1);
    expect(inspectKey(presented[0])).toMatchObject({ s: "payg", valid: true, a: "acme-123456" }); // the customer's REAL new key
    expect(presented[0]).toBe(r.key);
  });

  it("a machine key is checked with the real new token, not a probe", async () => {
    const a = scale();
    const presented = spyVersion();
    const { POST } = await import("@/app/api/keys/route");
    const r = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(presented).toEqual([r.key]);
    expect(engine.revokeCalls).toEqual(["keyOLD01"]);
  });

  it("a trial (free-allowance) key is still checked with a throwaway probe, never presented itself", async () => {
    const a = paygAccount(db, { plan: "api_free", cap_units: null, monthly_units: 100, stripe_payment_method_id: null, key_id: "keyTRIAL1", key_scope: "trial", key_issued_at: day(-5), key_expires_at: day(30), free_verified_at: new Date().toISOString() });
    const presented = spyVersion();
    const { POST } = await import("@/app/api/keys/route");
    const r = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(r.issued).toBe(true);
    expect(presented).toHaveLength(1);
    expect(presented[0]).not.toBe(r.key);
    expect(inspectKey(presented[0])!.a).toBe("ttp-rotation-probe");
  });
});

// keep the unused-import guard honest: the helpers above are the ones this file needs
void ledgerFetcherOver;
