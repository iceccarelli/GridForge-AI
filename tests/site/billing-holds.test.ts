/**
 * What a payment that is taken back, a billing pause, an unpaid invoice and an engine that cannot revoke do to PAID access.
 *
 * Every case here fails against the code before this change (the held-out claims are in the commit message). Labels, never upgraded
 * into one another:
 *   MOCK STRIPE   tests/site/payg-harness.ts MockStripe, extended below with the three calls the reversal handlers make (charges.retrieve,
 *                 invoicePayments.list, invoices.retrieve). No live Stripe call is made; nothing here proves what live Stripe sends.
 *   MOCK ENGINE   the engine's /v1/revoke as a fetch interceptor, with a variant that 404s like the DEPLOYED engine does today.
 *   FAKE STORE    the in-memory PostgREST (tests/site/postgrest-fake.ts). The SQL itself (columns, append-only audit table) is
 *                 proven against PostgreSQL in tests/test_billing_holds_migration.py (skipped where there is no database).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { retryRevocations, API_PAST_DUE_GRACE_DAYS, type ApiAccount } from "@/lib/api-access";
import { enforcePastDueGrace } from "@/lib/billing-holds";
import { checkRevocationBacklog, RECOMMENDED_WEBHOOK_EVENTS } from "@/lib/stripe-health";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { MockStripe, mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake, Row } from "./postgrest-fake";
import { paidSession } from "./checkout-fixture";

const WH = "whsec_holds";
const sdk = new Stripe("sk_test_placeholder");
const DAY = 86_400;

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
let stripe: HoldStripe;
let logs: unknown[][];
let T0: number;
let evt = 0;

/** MockStripe plus what the reversal handlers read: a charge's invoice / payment intent, and the invoice's subscription. */
class HoldStripe extends MockStripe {
  chargeInfo = new Map<string, { customer?: string; invoice?: string | null; payment_intent?: string | null }>();
  paymentIntentInvoice = new Map<string, string>();
  invoiceSubscription = new Map<string, string>();
  /** What Stripe says about an invoice (default: paid in full). */
  invoiceFacts = new Map<string, { status: string; amount_paid: number }>();
  /** A subscription's newest invoice, and the kind our checkout stamped on it. */
  subscriptionLatest = new Map<string, string>();
  subscriptionKinds = new Map<string, string>();
  constructor() {
    super();
    const missing = () => Object.assign(new Error("No such object"), { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404 });
    const outage = (name: string) => {
      this.calls.push(name);
      if (this.failOnce.delete(name)) throw Object.assign(new Error("simulated Stripe outage"), { type: "StripeConnectionError", statusCode: 503 });
    };
    (this as any).charges = {
      retrieve: async (id: string) => {
        outage("charges.retrieve");
        const c = this.chargeInfo.get(id);
        if (!c) throw missing();
        return { id, ...c };
      },
    };
    (this as any).invoicePayments = {
      list: async (p: { payment: { payment_intent: string } }) => {
        outage("invoicePayments.list");
        const inv = this.paymentIntentInvoice.get(p.payment.payment_intent);
        return { data: inv ? [{ invoice: inv }] : [] };
      },
    };
    const base = this.invoices;
    (this as any).invoices = {
      ...base,
      retrieve: async (id: string) => {
        outage("invoices.retrieve");
        const sub = this.invoiceSubscription.get(id);
        if (!sub) throw missing();
        return { id, ...(this.invoiceFacts.get(id) ?? { status: "paid", amount_paid: 90_000 }), parent: { subscription_details: { subscription: sub } } };
      },
    };
    (this as any).subscriptions = {
      retrieve: async (id: string) => {
        outage("subscriptions.retrieve");
        if (!this.subscriptionLatest.has(id) && !this.subscriptionKinds.has(id)) throw missing();
        return { id, latest_invoice: this.subscriptionLatest.get(id) ?? null, metadata: { kind: this.subscriptionKinds.get(id) } };
      },
    };
  }
  /** An invoice that exists on a subscription, becomes its newest, and has the given facts. */
  addInvoice(invoice: string, sub: string, facts: { status: string; amount_paid: number } = { status: "paid", amount_paid: 90_000 }) {
    this.invoiceSubscription.set(invoice, sub);
    this.invoiceFacts.set(invoice, facts);
    this.subscriptionLatest.set(sub, invoice);
  }
  /** charge -> payment intent -> invoice -> subscription, as the newer API versions chain them (Charge carries no `invoice`). */
  link(charge: string, pi: string, invoice: string, sub: string) {
    this.chargeInfo.set(charge, { payment_intent: pi });
    this.paymentIntentInvoice.set(pi, invoice);
    this.invoiceSubscription.set(invoice, sub);
    this.subscriptionLatest.set(sub, invoice);
  }
}

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", GRIDFORGE_KEY_SECRET: "test-signing-secret",
    STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: "cron-secret-value", RESEND_API_KEY: "re_test",
    LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "T <p@timetopower.ai>",
  });
  logs = [];
  for (const m of ["error", "log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); });
  T0 = Math.floor(Date.now() / 1000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
  db = newPaygDb();
  db.createTable("billing_audit");
  db.uniqueKeys.set("billing_audit", [["dedupe_key"]]);
  db.createTable("watch_note_notices");
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  stripe = new HoldStripe();
  setPaygStripeForTests(stripe);
});
afterEach(() => { vi.useRealTimers(); setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); });

async function send(type: string, object: Record<string, unknown>, opts: { created?: number; id?: string } = {}) {
  const id = opts.id ?? `evt_${++evt}`;
  const payload = JSON.stringify({ id, type, ...(opts.created ? { created: opts.created } : {}), data: { object } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const operatorMail = () => mail.filter((m) => m.to === "ops@example.test");
const audit = (action?: string) => (db.rows("billing_audit") as Row[]).filter((r) => !action || r.action === action);
const revokeCalls = () => engine.revokeCalls.filter((id) => id !== ""); // the route probe sends an empty id, which revokes nothing

const apiAcct = (over: Record<string, unknown> = {}) =>
  paygAccount(db, {
    account: "scale-1", token: "tok-scale-0123456789abcdefghij", plan: "api_scale", cap_units: null, monthly_units: 2500, stripe_subscription_id: "sub_api",
    stripe_customer_id: "cus_api", stripe_payment_method_id: null, key_id: "keyLIVE1", key_scope: "machine", key_issued_at: day(-5), key_expires_at: day(30), ...over,
  });
const watchRow = (over: Record<string, unknown> = {}) =>
  db.insertRow("watches", {
    token: "wtok-0123456789abcdefghijklmn", status: "active", cadence: "quarterly", email: "w@hall.example", site_name: "North Hall", hall_id: "H1",
    stripe_subscription_id: "sub_w", stripe_customer_id: "cus_w", intake: { siteName: "H" }, last_state: { racks: 40 }, next_run_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...over,
  });
const intelRow = (over: Record<string, unknown> = {}) =>
  db.insertRow("subscriptions", { email: "i@hall.example", plan: "team", status: "active", stripe_session_id: "cs_i", stripe_customer_id: "cus_i", stripe_subscription_id: "sub_i", ...over });

const fullRefund = (id = "ch_1", pi = "pi_1") => ({ id, object: "charge", amount: 90_000, amount_refunded: 90_000, refunded: true, payment_intent: pi, currency: "eur" });
const partialRefund = (id = "ch_1", pi = "pi_1") => ({ id, object: "charge", amount: 90_000, amount_refunded: 30_000, refunded: false, payment_intent: pi, currency: "eur" });
const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", amount: 90_000, currency: "eur", charge: "ch_1", reason: "fraudulent", status: "needs_response", ...over });
const paid = (invoice: string, sub: string) => ({ id: invoice, object: "invoice", subscription: sub });
const failed = (invoice: string, sub: string) => ({ id: invoice, object: "invoice", subscription: sub });

// ============================================================================================================================
// 1. a refunded or disputed subscription payment suspends paid access, reversibly, with an audit row, never by deleting
// ============================================================================================================================
describe("1. refund / dispute of a SUBSCRIPTION payment", () => {
  it("API plan: a full refund revokes the live key (recorded, then confirmed by the engine), refuses minting, and audits it; the row stays", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    const before = db.rows("api_accounts").length;
    expect((await send("charge.refunded", fullRefund(), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: null, key_expires_at: null, billing_hold: "refunded", billing_hold_ref: "ch_1", billing_hold_invoice: "in_1", billing_hold_prev_status: "active" });
    expect(a.revoked_key_ids).toEqual(["keyLIVE1"]);
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
    expect(a.revoked_confirmed_ids).toEqual(["keyLIVE1"]); // confirmed only because the engine answered 2xx
    expect(db.rows("api_accounts")).toHaveLength(before); // never deleted
    expect(audit("hold_applied")).toHaveLength(1);
    expect(audit("hold_applied")[0]).toMatchObject({ subject_table: "api_accounts", subject_id: a.id, stripe_object_id: "ch_1", stripe_invoice_id: "in_1", stripe_subscription_id: "sub_api" });
    const { POST } = await import("@/app/api/keys/route");
    const mint = await POST(post("/api/keys", { token: a.token }));
    expect(mint.status).toBe(402);
    expect((await mint.json()).hold).toBe("refunded");
    // the funnel counter is unchanged by the new behaviour
    expect((db.rows("funnel_events") as Row[]).filter((e) => e.name === "refund_issued")).toHaveLength(1);
  });

  it("Hall Watch: a full refund pauses it (no run is due), abandons a queued note email, and audits; Intelligence: not entitled afterwards", async () => {
    const w = watchRow();
    const i = intelRow();
    db.insertRow("watch_note_notices", { watch_note_id: "n1", watch_id: w.id, status: "pending", attempts: 0 });
    stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    expect((await send("charge.refunded", fullRefund("ch_w", "pi_w"), { created: T0 })).status).toBe(200);
    expect((await send("charge.refunded", fullRefund("ch_i", "pi_i"), { created: T0 })).status).toBe(200);
    expect(w).toMatchObject({ status: "paused", billing_hold: "refunded", billing_hold_prev_status: "active" });
    expect((db.rows("watch_note_notices") as Row[])[0]).toMatchObject({ status: "abandoned", last_error: "watch_not_active" });
    expect(i).toMatchObject({ status: "suspended", billing_hold: "refunded", billing_hold_invoice: "in_i" });
    const { lookupEntitlement } = await import("@/lib/subscribers");
    expect(await lookupEntitlement("i@hall.example")).toEqual({ reachable: true, entitlement: null });
    expect(audit("hold_applied").map((r) => r.subject_table).sort()).toEqual(["subscriptions", "watches"]);
  });

  it("a PARTIAL refund suspends nothing (and asks Stripe nothing)", async () => {
    const a = apiAcct();
    const w = watchRow();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    expect((await send("charge.refunded", partialRefund(), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", key_id: "keyLIVE1" });
    expect(w.status).toBe("active");
    expect(audit()).toHaveLength(0);
    expect(revokeCalls()).toEqual([]);
    expect(stripe.calls).not.toContain("invoicePayments.list");
  });

  it("a refunded payment that is not a subscription invoice (an engagement deposit) changes nothing", async () => {
    const a = apiAcct();
    stripe.chargeInfo.set("ch_dep", { payment_intent: "pi_dep" }); // no invoice behind this payment intent
    expect((await send("charge.refunded", fullRefund("ch_dep", "pi_dep"), { created: T0 })).status).toBe(200);
    expect(a.status).toBe("active");
    expect(audit()).toHaveLength(0);
  });

  it("older Stripe API versions put the invoice on the charge itself: that is used, and the invoice's subscription is read from the invoice", async () => {
    const a = apiAcct();
    stripe.invoiceSubscription.set("in_old", "sub_api");
    const res = await send("charge.refunded", { ...fullRefund("ch_old", "pi_old"), invoice: "in_old" }, { created: T0 });
    expect(res.status).toBe(200);
    expect(a.billing_hold).toBe("refunded");
    expect(stripe.calls).not.toContain("invoicePayments.list");
  });

  it("redelivery of the same event is a no-op: one audit row, one engine revocation, the same state", async () => {
    const a = apiAcct();
    const w = watchRow();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    for (let n = 0; n < 3; n++) {
      expect((await send("charge.refunded", fullRefund(), { created: T0, id: "evt_refund_a" })).status).toBe(200);
      expect((await send("charge.refunded", fullRefund("ch_w", "pi_w"), { created: T0, id: "evt_refund_w" })).status).toBe(200);
    }
    expect(audit("hold_applied")).toHaveLength(2);
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
    expect(a.billing_hold).toBe("refunded");
    expect(w.status).toBe("paused");
    expect(a.revoked_key_ids).toEqual(["keyLIVE1"]);
  });

  it("a dispute opened suspends; a warning inquiry (no money moved) does not", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    expect((await send("charge.dispute.created", dispute({ id: "dp_w", status: "warning_needs_response" }), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", key_id: "keyLIVE1" });
    expect((await send("charge.dispute.created", dispute(), { created: T0 + 5 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: null, billing_hold: "disputed", billing_hold_ref: "dp_1", billing_hold_invoice: "in_1" });
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
  });

  it("dispute won restores what the row was before (watch active, Intelligence active), keeps the API key revoked, and audits the lift", async () => {
    const a = apiAcct();
    const w = watchRow();
    const i = intelRow();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    await send("charge.dispute.created", dispute(), { created: T0 });
    await send("charge.dispute.created", dispute({ id: "dp_w", charge: "ch_w" }), { created: T0 });
    await send("charge.dispute.created", dispute({ id: "dp_i", charge: "ch_i" }), { created: T0 });
    expect([a.status, w.status, i.status]).toEqual(["past_due", "paused", "suspended"]);
    // another dispute's outcome lifts nothing
    await send("charge.dispute.closed", dispute({ id: "dp_other", status: "won" }), { created: T0 + 100 });
    expect([a.status, w.status, i.status]).toEqual(["past_due", "paused", "suspended"]);
    for (const [id, ch] of [["dp_1", "ch_1"], ["dp_w", "ch_w"], ["dp_i", "ch_i"]]) {
      expect((await send("charge.dispute.closed", dispute({ id, charge: ch, status: "won" }), { created: T0 + 200 })).status).toBe(200);
    }
    expect(a).toMatchObject({ status: "active", billing_hold: null, key_id: null });
    expect(a.revoked_key_ids).toEqual(["keyLIVE1"]); // a revoked key does not come back; the customer mints a new one
    expect(w).toMatchObject({ status: "active", billing_hold: null });
    expect(i).toMatchObject({ status: "active", billing_hold: null });
    expect(audit("hold_lifted")).toHaveLength(3);
    const { POST } = await import("@/app/api/keys/route");
    expect((await POST(post("/api/keys", { token: a.token }))).status).toBe(200); // minting is open again
  });

  it("dispute lost: the hold stands, and it is recorded", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send("charge.dispute.created", dispute(), { created: T0 });
    await send("charge.dispute.closed", dispute({ status: "lost" }), { created: T0 + 100 });
    expect(a).toMatchObject({ status: "past_due", billing_hold: "disputed" });
    expect(audit("dispute_lost_hold_stands")).toHaveLength(1);
  });

  it("a LATER verified payment for a different invoice restores everything; the same invoice paid again does not; an older payment does not", async () => {
    const a = apiAcct();
    const w = watchRow();
    const i = intelRow();
    for (const [c, pi, inv, sub] of [["ch_1", "pi_1", "in_1", "sub_api"], ["ch_w", "pi_w", "in_w", "sub_w"], ["ch_i", "pi_i", "in_i", "sub_i"]]) stripe.link(c, pi, inv, sub);
    await send("charge.refunded", fullRefund("ch_1", "pi_1"), { created: T0 });
    await send("charge.refunded", fullRefund("ch_w", "pi_w"), { created: T0 });
    await send("charge.refunded", fullRefund("ch_i", "pi_i"), { created: T0 });
    // the refunded invoice's own paid notice, delivered late: older than the refund AND the same invoice
    await send("invoice.paid", paid("in_1", "sub_api"), { created: T0 - 50 });
    await send("invoice.paid", paid("in_w", "sub_w"), { created: T0 - 50 });
    await send("invoice.paid", paid("in_i", "sub_i"), { created: T0 - 50 });
    // and the same invoice re-sent with a LATER time (a replayed event)
    await send("invoice.paid", paid("in_1", "sub_api"), { created: T0 + 10 });
    await send("invoice.paid", paid("in_w", "sub_w"), { created: T0 + 10 });
    await send("invoice.paid", paid("in_i", "sub_i"), { created: T0 + 10 });
    expect([a.status, w.status, i.status]).toEqual(["past_due", "paused", "suspended"]);
    // the next period's invoice, paid
    expect((await send("invoice.paid", paid("in_next_a", "sub_api"), { created: T0 + 30 * DAY })).status).toBe(200);
    expect((await send("invoice.paid", paid("in_next_w", "sub_w"), { created: T0 + 30 * DAY })).status).toBe(200);
    expect((await send("invoice.paid", paid("in_next_i", "sub_i"), { created: T0 + 30 * DAY })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", billing_hold: null, key_id: null });
    expect(w).toMatchObject({ status: "active", billing_hold: null });
    expect(i).toMatchObject({ status: "active", billing_hold: null });
    expect(audit("hold_lifted").map((r) => (r.detail as any).cause)).toEqual(["invoice_paid", "invoice_paid", "invoice_paid"]);
  });

  it("out of order: a refund delivered AFTER the next payment (older event time) changes nothing; one newer than it suspends", async () => {
    const a = apiAcct({ last_billing_event_ts: T0 + 500 });
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    expect((await send("charge.refunded", fullRefund(), { created: T0 + 100 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", key_id: "keyLIVE1" });
    expect((await send("charge.refunded", fullRefund("ch_1", "pi_1"), { created: T0 + 600 })).status).toBe(200);
    expect(a.status).toBe("past_due");
  });

  it("a cancelled entitlement never gets a hold and is never brought back by one", async () => {
    const a = apiAcct({ status: "cancelled" });
    const w = watchRow({ status: "cancelled" });
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    await send("charge.refunded", fullRefund(), { created: T0 });
    await send("charge.refunded", fullRefund("ch_w", "pi_w"), { created: T0 });
    await send("invoice.paid", paid("in_x", "sub_api"), { created: T0 + 9 });
    expect(a).toMatchObject({ status: "cancelled" });
    expect(a.billing_hold ?? null).toBeNull();
    expect(w.status).toBe("cancelled");
    expect(audit()).toHaveLength(0);
  });

  it("a stronger hold is not replaced by a weaker one: refunded outranks disputed", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send("charge.dispute.created", dispute(), { created: T0 });
    await send("charge.refunded", fullRefund(), { created: T0 + 10 });
    expect(a.billing_hold).toBe("refunded");
    await send("charge.dispute.created", dispute({ id: "dp_2" }), { created: T0 + 20 });
    expect(a.billing_hold).toBe("refunded");
    await send("charge.dispute.closed", dispute({ status: "won" }), { created: T0 + 30 });
    expect(a).toMatchObject({ status: "past_due", billing_hold: "refunded" }); // winning the dispute does not undo a refund
  });

  it("Stripe cannot be asked: the event is answered 500 (redelivered) and applies on the retry; a write that fails is retried the same way", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.failOnce.add("invoicePayments.list");
    expect((await send("charge.refunded", fullRefund(), { created: T0, id: "evt_r" })).status).toBe(500);
    expect(a.status).toBe("active"); // honest: it was NOT applied
    expect((await send("charge.refunded", fullRefund(), { created: T0, id: "evt_r" })).status).toBe(200);
    expect(a.status).toBe("past_due");

    const w = watchRow();
    stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    db.failMethod = { method: "PATCH", status: 503, body: JSON.stringify({ message: "outage" }) };
    expect((await send("charge.refunded", fullRefund("ch_w", "pi_w"), { created: T0, id: "evt_w" })).status).toBe(500);
    db.failMethod = null;
    expect(w.status).toBe("active");
    expect((await send("charge.refunded", fullRefund("ch_w", "pi_w"), { created: T0, id: "evt_w" })).status).toBe(200);
    expect(w.status).toBe("paused");
    expect(audit("hold_applied")).toHaveLength(2);
  });

  it("a dispute on a charge Stripe has never heard of is acknowledged, not retried for ever", async () => {
    apiAcct();
    expect((await send("charge.dispute.created", dispute({ id: "dp_x", charge: "ch_unknown" }), { created: T0 })).status).toBe(200);
  });

  it("migration 0041 not applied yet: access is STILL cut off (as a status), the operator is told once, and the event is not refused", async () => {
    const a = apiAcct();
    for (const c of ["billing_hold", "billing_hold_ref", "billing_hold_invoice", "billing_hold_at", "billing_hold_prev_status", "past_due_since"]) db.dropColumn("api_accounts", c);
    db.dropTable("billing_audit");
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    expect((await send("charge.refunded", fullRefund(), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: null });
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
    expect(operatorMail().filter((m) => /Migration 0041/.test(m.subject))).toHaveLength(1);
    await send("charge.refunded", fullRefund(), { created: T0, id: "evt_again" });
    expect(operatorMail().filter((m) => /Migration 0041/.test(m.subject))).toHaveLength(1);
  });
});

// ============================================================================================================================
// 2. past_due has a grace, and it is enforced
// ============================================================================================================================
describe("2. past_due grace for API plans", () => {
  it("the grace is an explicit constant: seven days", () => {
    expect(API_PAST_DUE_GRACE_DAYS).toBe(7);
  });

  it("the first failure starts the grace and the minted key keeps working inside it; minting is refused throughout", async () => {
    const a = apiAcct();
    expect((await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: "keyLIVE1" });
    expect(new Date(a.past_due_since as string).getTime()).toBe(T0 * 1000);
    expect(revokeCalls()).toEqual([]);
    // a retried failure of the same episode does not restart the clock
    vi.setSystemTime((T0 + 3 * DAY) * 1000);
    await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 + 3 * DAY });
    expect(new Date(a.past_due_since as string).getTime()).toBe(T0 * 1000);
    expect(a.key_id).toBe("keyLIVE1");
    const rep = await enforcePastDueGrace(new Date((T0 + 6 * DAY) * 1000));
    expect(rep).toMatchObject({ examined: 1, revoked: 0 });
    expect(a.key_id).toBe("keyLIVE1");
    const { POST } = await import("@/app/api/keys/route");
    expect((await POST(post("/api/keys", { token: a.token }))).status).toBe(402);
  });

  it("after the grace the daily pass revokes the live key (recorded, confirmed by the engine, audited), once; the account stays past_due", async () => {
    const a = apiAcct();
    await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 });
    const rep = await enforcePastDueGrace(new Date((T0 + 7 * DAY) * 1000));
    expect(rep).toMatchObject({ examined: 1, revoked: 1, unconfirmed: 0 });
    expect(a).toMatchObject({ status: "past_due", key_id: null });
    expect(a.revoked_key_ids).toEqual(["keyLIVE1"]);
    expect(a.revoked_confirmed_ids).toEqual(["keyLIVE1"]);
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
    expect(audit("grace_expired_key_revoked")).toHaveLength(1);
    const again = await enforcePastDueGrace(new Date((T0 + 8 * DAY) * 1000));
    expect(again).toMatchObject({ revoked: 0 });
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
    expect(audit("grace_expired_key_revoked")).toHaveLength(1);
  });

  it("the GET /api/cron/payg route runs the grace pass (and refuses a caller without the secret)", async () => {
    const a = apiAcct();
    await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 });
    vi.setSystemTime((T0 + 8 * DAY) * 1000);
    const { GET } = await import("@/app/api/cron/payg/route");
    expect((await GET(new Request(siteUrl("/api/cron/payg")))).status).toBe(401);
    const res = await GET(new Request(siteUrl("/api/cron/payg"), { headers: { authorization: "Bearer cron-secret-value" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).grace).toMatchObject({ revoked: 1 });
    expect(a.key_id).toBeNull();
  });

  it("a later failure event of the same episode, after the grace, revokes at the webhook without waiting for the daily pass", async () => {
    const a = apiAcct();
    await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 });
    vi.setSystemTime((T0 + 9 * DAY) * 1000);
    expect((await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 + 9 * DAY })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: null });
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
  });

  it("a payment inside the grace restores: active, the grace cleared, the key untouched; and the next failure starts a NEW episode", async () => {
    const a = apiAcct();
    await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 });
    expect((await send("invoice.paid", paid("in_f", "sub_api"), { created: T0 + 3 * DAY })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", past_due_since: null, key_id: "keyLIVE1" });
    expect(revokeCalls()).toEqual([]);
    await enforcePastDueGrace(new Date((T0 + 30 * DAY) * 1000));
    expect(a.key_id).toBe("keyLIVE1");
    await send("invoice.payment_failed", failed("in_g", "sub_api"), { created: T0 + 40 * DAY });
    expect(new Date(a.past_due_since as string).getTime()).toBe((T0 + 40 * DAY) * 1000);
  });

  it("a payment AFTER the grace restores the account (minting reopens) but not the key that was revoked", async () => {
    const a = apiAcct();
    await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 });
    await enforcePastDueGrace(new Date((T0 + 8 * DAY) * 1000));
    expect(a.key_id).toBeNull();
    vi.setSystemTime((T0 + 9 * DAY) * 1000);
    expect((await send("invoice.paid", paid("in_f", "sub_api"), { created: T0 + 9 * DAY })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", past_due_since: null, key_id: null });
    expect(a.revoked_key_ids).toEqual(["keyLIVE1"]);
    const { POST } = await import("@/app/api/keys/route");
    const mint = await POST(post("/api/keys", { token: a.token }));
    expect(mint.status).toBe(200);
    expect((await mint.json()).issued).toBe(true);
  });

  it("a past_due row from before the start time was recorded gets its grace from the day it is first seen, never earlier", async () => {
    const a = apiAcct({ status: "past_due" });
    expect((a.past_due_since ?? null)).toBeNull();
    expect(await enforcePastDueGrace(new Date((T0 + 30 * DAY) * 1000))).toMatchObject({ started: 1, revoked: 0 });
    expect(a.key_id).toBe("keyLIVE1");
    expect(new Date(a.past_due_since as string).getTime()).toBe((T0 + 30 * DAY) * 1000);
    expect(await enforcePastDueGrace(new Date((T0 + 37 * DAY) * 1000))).toMatchObject({ revoked: 1 });
    expect(a.key_id).toBeNull();
  });

  it("pay-as-you-go, free and held accounts are not touched by the grace pass", async () => {
    const payg = paygAccount(db, { account: "payg-1", token: "tok-payg-0123456789abcdefghij", status: "past_due", past_due_since: new Date(0).toISOString(), key_id: "keyPAYG1", stripe_subscription_id: null });
    const held = apiAcct({ account: "held-1", token: "tok-held-0123456789abcdefghijk", status: "past_due", past_due_since: new Date(0).toISOString(), stripe_subscription_id: "sub_h", billing_hold: "paused", key_id: "keyHELD1" });
    const rep = await enforcePastDueGrace(new Date(T0 * 1000));
    expect(rep.revoked).toBe(0);
    expect(payg.key_id).toBe("keyPAYG1");
    expect(held.key_id).toBe("keyHELD1");
  });

  it("migration 0041 not applied: the failure still sets past_due (the status write falls back), and the pass reports why it did not run", async () => {
    const a = apiAcct();
    db.dropColumn("api_accounts", "past_due_since");
    expect((await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 })).status).toBe(200);
    expect(a.status).toBe("past_due");
    // PostgREST answers 400 to a filter on a column the table does not have (the fake only models that for writes)
    db.failMethod = { method: "GET", status: 400, body: JSON.stringify({ code: "42703", message: "column api_accounts.billing_hold does not exist" }) };
    const rep = await enforcePastDueGrace(new Date(T0 * 1000));
    expect(rep.skipped).toMatch(/read failed \(400/);
    expect(operatorMail().filter((m) => /Migration 0041/.test(m.subject))).toHaveLength(1);
  });
});

// ============================================================================================================================
// 3. a revocation the engine cannot confirm is a durable, retried, visible obligation
// ============================================================================================================================
describe("3. the engine does not serve /v1/revoke (as the deployed engine does today)", () => {
  /** The deployed engine's answer for a route it does not have; layered over the mock engine. */
  let notDeployed = true;
  let undo: () => void;
  beforeEach(() => {
    notDeployed = true;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (notDeployed && url === "https://engine.test/v1/revoke") return new Response(JSON.stringify({ error: "not found", endpoints: ["/v1/qualify", "/v1/version"] }), { status: 404 });
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    undo = () => { globalThis.fetch = inner; };
  });
  afterEach(() => undo());

  it("cancellation: the account is cut off and the id RECORDED, but nothing says it is revoked: it is pending, the operator is told once, and health reports it", async () => {
    const a = apiAcct();
    const del = () => send("customer.subscription.deleted", { id: "sub_api", object: "subscription", metadata: { kind: "api_scale" } });
    expect((await del()).status).toBe(200);
    expect(a).toMatchObject({ status: "cancelled" });
    expect(a.revoked_key_ids).toEqual(["keyLIVE1"]);
    expect(a.revoked_confirmed_ids).toEqual([]);
    expect(a.revocation_pending).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/revoked key id keyLIVE1/);
    expect(JSON.stringify(logs)).toMatch(/NOT confirmed by the engine/);
    const notes = operatorMail().filter((m) => /NOT confirmed revoked/.test(m.subject));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(/404 for \/v1\/revoke/);
    expect(audit("revocation_unconfirmed")).toHaveLength(1);
    await del(); // a redelivery mails and audits nothing more
    expect(operatorMail().filter((m) => /NOT confirmed revoked/.test(m.subject))).toHaveLength(1);
    expect(audit("revocation_unconfirmed")).toHaveLength(1);

    const backlog = await checkRevocationBacklog();
    expect(backlog).toMatchObject({ checked: true, ok: false, accountsPending: 1, idsPending: 1, idsPendingOnCutOffAccounts: 1, engineRevokeRoute: "not_deployed" });
    expect(backlog.error).toMatch(/does not serve \/v1\/revoke/);

    // the portal never reads "revoked: 1" as "dead": it says how many the engine confirmed and that one is pending
    const { GET } = await import("@/app/api/keys/route");
    const j = await (await GET(new Request(siteUrl(`/api/keys?token=${a.token}`)))).json();
    expect(j.account).toMatchObject({ revoked: 1, revoked_confirmed: 0, revocation_pending: true });
  });

  it("the daily route keeps pushing it, says so while the engine 404s, mails the backlog once a day, and confirms it the day the engine can", async () => {
    const a = apiAcct({ status: "cancelled", revoked_key_ids: ["keyLIVE1"], key_id: null });
    const { GET } = await import("@/app/api/cron/payg/route");
    const call = async () => (await GET(new Request(siteUrl("/api/cron/payg"), { headers: { authorization: "Bearer cron-secret-value" } }))).json();
    const day1 = await call();
    expect(day1.revocations).toEqual({ accounts: 1, confirmed: 0, stillPending: 1 });
    expect(day1.revocation_backlog).toMatchObject({ ok: false, idsPendingOnCutOffAccounts: 1, engineRevokeRoute: "not_deployed" });
    await call();
    expect(operatorMail().filter((m) => /Key revocations NOT confirmed/.test(m.subject))).toHaveLength(1); // once a day
    expect(a.revocation_pending).toBe(true);
    notDeployed = false; // the engine is redeployed
    const day2 = await call();
    expect(day2.revocations).toEqual({ accounts: 1, confirmed: 1, stillPending: 0 });
    expect(day2.revocation_backlog).toMatchObject({ ok: true, idsPending: 0 });
    expect(a.revocation_pending).toBe(false);
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
  });

  it("the next billing event for the account retries it too, without waiting for the daily job", async () => {
    const a = apiAcct();
    await send("customer.subscription.deleted", { id: "sub_api", object: "subscription", metadata: { kind: "api_scale" } });
    expect(a.revocation_pending).toBe(true);
    notDeployed = false;
    expect((await send("invoice.payment_failed", failed("in_late", "sub_api"), { created: T0 + 5 })).status).toBe(200);
    expect(a.revocation_pending).toBe(false);
    expect(a.revoked_confirmed_ids).toEqual(["keyLIVE1"]);
  });

  it("a refund hold on an engine that 404s: the account may not mint, the key is recorded revoked-but-unconfirmed, and the operator is told", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    expect((await send("charge.refunded", fullRefund(), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: null, billing_hold: "refunded", revocation_pending: true });
    expect(a.revoked_confirmed_ids).toEqual([]);
    expect(operatorMail().filter((m) => /NOT confirmed revoked/.test(m.subject))).toHaveLength(1);
    expect(audit("revocation_unconfirmed")).toHaveLength(1);
    const { POST } = await import("@/app/api/keys/route");
    expect((await POST(post("/api/keys", { token: a.token }))).status).toBe(402);
  });

  it("the grace pass on an engine that 404s: counted unconfirmed, not claimed revoked", async () => {
    const a = apiAcct();
    await send("invoice.payment_failed", failed("in_f", "sub_api"), { created: T0 });
    const rep = await enforcePastDueGrace(new Date((T0 + 8 * DAY) * 1000));
    expect(rep).toMatchObject({ revoked: 1, unconfirmed: 1 });
    expect(a).toMatchObject({ key_id: null, revocation_pending: true });
    expect(await retryRevocations()).toMatchObject({ confirmed: 0, stillPending: 1 });
  });

  it("an active account's overlap key (live on purpose) is not a backlog", async () => {
    paygAccount(db, { plan: "api_scale", cap_units: null, key_id: "keyNEW01", overlap_key_ids: { keyOLD01: day(3) }, revoked_key_ids: ["keyOLD01"] });
    expect(await checkRevocationBacklog()).toMatchObject({ checked: true, ok: true, idsPending: 0 });
  });
});

// ============================================================================================================================
// 4. checkout.session.completed fulfils only a PAID session
// ============================================================================================================================
describe("4. delayed payment methods", () => {
  const checkout = (over: Record<string, unknown> = {}) => paidSession({
    id: "cs_async", object: "checkout.session", customer_email: "buyer@hall.example", customer: "cus_async", subscription: "sub_async", amount_total: 90_000, currency: "eur",
    metadata: { kind: "hall_watch", company: "Hall Co" }, ...over,
  });
  const watches = () => (db.rows("watches") as Row[]).filter((w) => w.stripe_subscription_id === "sub_async");

  it("completed with payment_status unpaid fulfils nothing and is acknowledged; async_payment_succeeded then fulfils, once, however often it is delivered", async () => {
    expect((await send("checkout.session.completed", checkout({ payment_status: "unpaid" }))).status).toBe(200);
    expect(watches()).toHaveLength(0);
    expect(operatorMail().filter((m) => /Deposit paid/.test(m.subject))).toHaveLength(0);
    for (let n = 0; n < 3; n++) expect((await send("checkout.session.async_payment_succeeded", checkout({ payment_status: "paid" }), { id: "evt_async_ok" })).status).toBe(200);
    expect(watches()).toHaveLength(1);
    // a completed(paid) after it is the same sale
    expect((await send("checkout.session.completed", checkout({ payment_status: "paid" }))).status).toBe(200);
    expect(watches()).toHaveLength(1);
  });

  it("async_payment_failed fulfils nothing and is logged", async () => {
    expect((await send("checkout.session.async_payment_failed", checkout({ payment_status: "unpaid" }))).status).toBe(200);
    expect(watches()).toHaveLength(0);
    expect(JSON.stringify(logs)).toMatch(/checkout payment FAILED after completion; nothing fulfilled: session cs_async/);
  });

  it("paid and no_payment_required (a setup or a free checkout) still fulfil at completion; an unknown status does not", async () => {
    expect((await send("checkout.session.completed", checkout({ payment_status: "paid", subscription: "sub_p1", id: "cs_p1" }))).status).toBe(200);
    expect((await send("checkout.session.completed", checkout({ payment_status: "no_payment_required", subscription: "sub_p2", id: "cs_p2" }))).status).toBe(200);
    expect((await send("checkout.session.completed", checkout({ payment_status: "something_new", subscription: "sub_p3", id: "cs_p3" }))).status).toBe(200);
    const subs = (db.rows("watches") as Row[]).map((w) => w.stripe_subscription_id).sort();
    expect(subs).toEqual(["sub_p1", "sub_p2"]);
  });

  it("an unpaid engagement deposit or Intelligence checkout is not fulfilled either", async () => {
    await send("checkout.session.completed", checkout({ payment_status: "unpaid", id: "cs_dep", subscription: null, metadata: { kind: "engagement_deposit", company: "Hall Co" } }));
    await send("checkout.session.completed", checkout({ payment_status: "unpaid", id: "cs_int", metadata: { kind: "intelligence_subscription", plan: "team" } }));
    expect(db.rows("subscriptions")).toHaveLength(0);
    expect(db.rows("engagement_deposits")).toHaveLength(0);
  });

  it("the health check recommends (never requires) both events, because the handler really handles them", async () => {
    expect(RECOMMENDED_WEBHOOK_EVENTS).toEqual(expect.arrayContaining(["checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"]));
    const { REQUIRED_WEBHOOK_EVENTS } = await import("@/lib/stripe-health");
    expect(REQUIRED_WEBHOOK_EVENTS as readonly string[]).not.toContain("checkout.session.async_payment_succeeded");
  });
});

// ============================================================================================================================
// 5. billing paused
// ============================================================================================================================
describe("5. customer.subscription.updated with a pause", () => {
  const sub = (id: string, over: Record<string, unknown> = {}) => ({ id, object: "subscription", status: "active", pause_collection: null, metadata: {}, ...over });

  it("pause_collection set holds all three; resume puts each back exactly where it was; redelivery is a no-op", async () => {
    const a = apiAcct();
    const w = watchRow();
    const i = intelRow({ status: "past_due" }); // already past_due before the pause
    const pausedAt = T0 + 10;
    for (const [id, over] of [["sub_api", {}], ["sub_w", {}], ["sub_i", {}]] as const) {
      for (let n = 0; n < 2; n++) expect((await send("customer.subscription.updated", sub(id, { pause_collection: { behavior: "void" }, ...over }), { created: pausedAt, id: `evt_pause_${id}` })).status).toBe(200);
    }
    expect(a).toMatchObject({ status: "past_due", key_id: null, billing_hold: "paused", billing_hold_prev_status: "active" });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
    expect(i).toMatchObject({ status: "suspended", billing_hold: "paused", billing_hold_prev_status: "past_due" });
    expect(revokeCalls()).toEqual(["keyLIVE1"]);
    expect(audit("hold_applied")).toHaveLength(3);
    // a payment that clears while paused does NOT end a pause
    await send("invoice.paid", paid("in_x", "sub_w"), { created: pausedAt + 5 });
    expect(w.status).toBe("paused");
    // the Hall Watch cron does not run it
    expect((db.rows("watches") as Row[]).filter((r) => r.status === "active")).toHaveLength(0);
    // resume
    for (const id of ["sub_api", "sub_w", "sub_i"]) expect((await send("customer.subscription.updated", sub(id), { created: pausedAt + 100 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", billing_hold: null });
    expect(a.key_id).toBeNull(); // the revoked key stays revoked
    expect(w).toMatchObject({ status: "active", billing_hold: null });
    expect(i).toMatchObject({ status: "past_due", billing_hold: null });
    expect(audit("hold_lifted")).toHaveLength(3);
  });

  it("status paused (no pause_collection) is a pause too", async () => {
    const w = watchRow();
    await send("customer.subscription.updated", sub("sub_w", { status: "paused" }), { created: T0 + 1 });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
  });

  it("out of order: a pause older than the resume already applied changes nothing; a resume older than the pause changes nothing", async () => {
    const w = watchRow();
    await send("customer.subscription.updated", sub("sub_w", { pause_collection: { behavior: "void" } }), { created: T0 + 100 });
    await send("customer.subscription.updated", sub("sub_w"), { created: T0 + 200 });
    expect(w.status).toBe("active");
    await send("customer.subscription.updated", sub("sub_w", { pause_collection: { behavior: "void" } }), { created: T0 + 150 }); // late
    expect(w.status).toBe("active");
    await send("customer.subscription.updated", sub("sub_w", { pause_collection: { behavior: "void" } }), { created: T0 + 300 });
    expect(w.status).toBe("paused");
    await send("customer.subscription.updated", sub("sub_w"), { created: T0 + 250 }); // late resume
    expect(w.status).toBe("paused");
  });

  it("an ordinary renewal update (no pause) changes nothing and advances no clock; a cancelled entitlement is not held", async () => {
    const a = apiAcct();
    await send("customer.subscription.updated", sub("sub_api"), { created: T0 + 1 });
    expect(a).toMatchObject({ status: "active", key_id: "keyLIVE1" });
    expect(a.last_billing_event_ts ?? null).toBeNull();
    const c = watchRow({ status: "cancelled" });
    await send("customer.subscription.updated", sub("sub_w", { pause_collection: { behavior: "void" } }), { created: T0 + 2 });
    expect(c.status).toBe("cancelled");
  });

  it("a pause whose write fails is retried", async () => {
    const w = watchRow();
    db.failMethod = { method: "PATCH", status: 503, body: JSON.stringify({ message: "outage" }) };
    expect((await send("customer.subscription.updated", sub("sub_w", { pause_collection: { behavior: "void" } }), { created: T0 + 1, id: "evt_p" })).status).toBe(500);
    db.failMethod = null;
    expect((await send("customer.subscription.updated", sub("sub_w", { pause_collection: { behavior: "void" } }), { created: T0 + 1, id: "evt_p" })).status).toBe(200);
    expect(w.status).toBe("paused");
  });
});

// ============================================================================================================================
// Review round: stale invoices, the unique index, deploy order, disputes that escalate, terminal states, early events, queued
// notices, bounded inline retries, repeated pause cycles
// ============================================================================================================================
describe("R1. a refund or dispute of an OLD invoice does not suspend a subscription whose current period is paid", () => {
  it("API plan and Hall Watch: the audit row is written, nothing else changes; the refund of the CURRENT invoice does suspend", async () => {
    const a = apiAcct();
    const w = watchRow();
    stripe.link("ch_old", "pi_old", "in_old", "sub_api");
    stripe.addInvoice("in_new", "sub_api"); // this month's invoice, paid in full
    stripe.link("ch_oldw", "pi_oldw", "in_oldw", "sub_w");
    stripe.addInvoice("in_neww", "sub_w");
    expect((await send("charge.refunded", fullRefund("ch_old", "pi_old"), { created: T0 })).status).toBe(200);
    expect((await send("charge.refunded", fullRefund("ch_oldw", "pi_oldw"), { created: T0 })).status).toBe(200);
    expect((await send("charge.dispute.created", dispute({ id: "dp_old", charge: "ch_old" }), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", key_id: "keyLIVE1" });
    expect(a.billing_hold ?? null).toBeNull();
    expect(w.status).toBe("active");
    expect(revokeCalls()).toEqual([]);
    expect(audit("hold_skipped_stale_invoice")).toHaveLength(3);
    expect(audit("hold_applied")).toHaveLength(0);
    // redelivered: still one row each
    await send("charge.refunded", fullRefund("ch_old", "pi_old"), { created: T0 });
    expect(audit("hold_skipped_stale_invoice")).toHaveLength(3);
    // refunding the CURRENT invoice is a real suspension
    stripe.link("ch_new", "pi_new", "in_new", "sub_api");
    await send("charge.refunded", fullRefund("ch_new", "pi_new"), { created: T0 + 5 });
    expect(a).toMatchObject({ status: "past_due", key_id: null, billing_hold: "refunded", billing_hold_invoice: "in_new" });
  });

  it("a newer invoice that is NOT paid (open, or paid zero) does not make the reversed one stale", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.addInvoice("in_open", "sub_api", { status: "open", amount_paid: 0 });
    await send("charge.refunded", fullRefund(), { created: T0 });
    expect(a.billing_hold).toBe("refunded");
    const b = apiAcct({ account: "scale-2", token: "tok-scale2-0123456789abcdefghi", stripe_subscription_id: "sub_b", key_id: "keyLIVE2" });
    stripe.link("ch_b", "pi_b", "in_b", "sub_b");
    stripe.addInvoice("in_zero", "sub_b", { status: "paid", amount_paid: 0 });
    await send("charge.refunded", fullRefund("ch_b", "pi_b"), { created: T0 });
    expect(b.billing_hold).toBe("refunded");
  });

  it("an invoice.paid that collected nothing (amount_paid 0) never lifts a hold; one that collected money does", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send("charge.refunded", fullRefund(), { created: T0 });
    await send("invoice.paid", { ...paid("in_credit", "sub_api"), amount_paid: 0 }, { created: T0 + 30 * DAY });
    expect(a).toMatchObject({ status: "past_due", billing_hold: "refunded" });
    await send("invoice.paid", { ...paid("in_real", "sub_api"), amount_paid: 90_000 }, { created: T0 + 31 * DAY });
    expect(a).toMatchObject({ status: "active", billing_hold: null });
  });
});

describe("R2. Intelligence: a lift never collides with the one-active-row-per-email index", () => {
  it("a newer purchase (another payer) was recorded while the old one was suspended: the old row is superseded, the event is answered 200, the newer row stands", async () => {
    const old = intelRow();
    stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    await send("charge.refunded", fullRefund("ch_i", "pi_i"), { created: T0 });
    expect(old.status).toBe("suspended");
    const newer = db.insertRow("subscriptions", { email: "i@hall.example", plan: "team", status: "active", stripe_session_id: "cs_new", stripe_customer_id: "cus_other", stripe_subscription_id: "sub_new" });
    expect((await send("invoice.paid", paid("in_next", "sub_i"), { created: T0 + 30 * DAY })).status).toBe(200);
    expect(old).toMatchObject({ status: "superseded", billing_hold: null });
    expect(newer.status).toBe("active");
    expect(audit("hold_lifted")[0]).toMatchObject({ subject_table: "subscriptions" });
    expect((audit("hold_lifted")[0].detail as any).restored_status).toBe("superseded");
  });

  it("the same for a dispute won", async () => {
    const old = intelRow();
    stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    await send("charge.dispute.created", dispute({ charge: "ch_i" }), { created: T0 });
    const newer = db.insertRow("subscriptions", { email: "i@hall.example", plan: "team", status: "active", stripe_session_id: "cs_new", stripe_customer_id: "cus_other", stripe_subscription_id: "sub_new" });
    expect((await send("charge.dispute.closed", dispute({ charge: "ch_i", status: "won" }), { created: T0 + 9 })).status).toBe(200);
    expect(old.status).toBe("superseded");
    expect(newer.status).toBe("active");
  });

  it("the fake store really does refuse two active rows (the premise of the tests above)", async () => {
    intelRow({ status: "suspended" });
    db.insertRow("subscriptions", { email: "i@hall.example", plan: "team", status: "active", stripe_session_id: "cs_x", stripe_subscription_id: "sub_x" });
    const res = await fetch("https://stub.supabase.co/rest/v1/subscriptions?stripe_subscription_id=eq.sub_i", { method: "PATCH", headers: { apikey: "k", "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ status: "active" }) });
    expect(res.status).toBe(409);
  });

  it("a new purchase by the same payer supersedes a SUSPENDED row too, so it cannot come back next to it", async () => {
    const old = intelRow({ status: "suspended", billing_hold: "refunded", billing_hold_ref: "ch_i", stripe_customer_id: "cus_i" });
    const { recordSubscription } = await import("@/lib/subscribers");
    const row = await recordSubscription({ email: "i@hall.example", plan: "team", sessionId: "cs_new2", customerId: "cus_i", subscriptionId: "sub_new2" });
    expect(row?.status).toBe("active");
    expect(old.status).toBe("superseded");
  });
});

describe("R3. holds before migration 0041", () => {
  it("Intelligence is NOT suspended without its hold columns: 500 (Stripe retries), nothing half-done, and it applies once the columns exist", async () => {
    const i = intelRow();
    stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    for (const c of ["billing_hold", "billing_hold_ref", "billing_hold_invoice", "billing_hold_at", "billing_hold_prev_status"]) db.dropColumn("subscriptions", c);
    expect((await send("charge.refunded", fullRefund("ch_i", "pi_i"), { created: T0, id: "evt_i" })).status).toBe(500);
    expect(i.status).toBe("active");
    db.missingColumns.delete("subscriptions");
    expect((await send("charge.refunded", fullRefund("ch_i", "pi_i"), { created: T0, id: "evt_i" })).status).toBe(200);
    expect(i).toMatchObject({ status: "suspended", billing_hold: "refunded" });
  });

  it("API plan without the columns: cut off as a status; the refunded invoice's own paid notice does not lift it, a later payment for a different invoice does", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    for (const c of ["billing_hold", "billing_hold_ref", "billing_hold_invoice", "billing_hold_at", "billing_hold_prev_status", "past_due_since"]) db.dropColumn("api_accounts", c);
    expect((await send("charge.refunded", fullRefund(), { created: T0 + 100 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: null });
    expect(a.last_billing_event_ts).toBe(T0 + 100);
    await send("invoice.paid", paid("in_1", "sub_api"), { created: T0 + 50 }); // the replay of the refunded invoice's own payment
    expect(a.status).toBe("past_due");
    await send("invoice.paid", paid("in_next", "sub_api"), { created: T0 + 30 * DAY });
    expect(a.status).toBe("active");
  });
});

describe("R4. disputes that escalate or are lost", () => {
  it("a warning inquiry that escalates to a real dispute (charge.dispute.updated) applies the hold then, once", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send("charge.dispute.created", dispute({ status: "warning_needs_response" }), { created: T0 });
    expect(a.status).toBe("active");
    await send("charge.dispute.updated", dispute({ status: "warning_under_review" }), { created: T0 + 5 });
    expect(a.status).toBe("active");
    for (let n = 0; n < 2; n++) expect((await send("charge.dispute.updated", dispute({ status: "needs_response" }), { created: T0 + 10, id: "evt_esc" })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", billing_hold: "disputed", billing_hold_ref: "dp_1", key_id: null });
    expect(audit("hold_applied")).toHaveLength(1);
  });

  it("an update that already carries a final status is left to the closed event", async () => {
    const a = apiAcct();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send("charge.dispute.updated", dispute({ status: "won" }), { created: T0 });
    expect(a.status).toBe("active");
  });

  it("closed as LOST with no hold yet (the created event was never seen) applies it and records that it stands", async () => {
    const a = apiAcct();
    const w = watchRow();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    expect((await send("charge.dispute.closed", dispute({ status: "lost" }), { created: T0 })).status).toBe(200);
    expect((await send("charge.dispute.closed", dispute({ id: "dp_w", charge: "ch_w", status: "lost" }), { created: T0 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", billing_hold: "disputed", key_id: null });
    expect(w).toMatchObject({ status: "paused", billing_hold: "disputed" });
    expect(audit("hold_applied")).toHaveLength(2);
    expect(audit("dispute_lost_hold_stands")).toHaveLength(2);
  });
});

describe("R5. a hold or a lift can never turn a terminal state back (either order)", () => {
  const snapshot = (...rows: Row[]) => rows.map((r) => ({ ...r }) as any);

  it("cancelled AFTER the event read the rows: the hold writes nothing, and the rows stay cancelled / superseded", async () => {
    const { applyHold } = await import("@/lib/billing-holds");
    const a = apiAcct();
    const w = watchRow();
    const i = intelRow();
    const [sa, sw, si] = snapshot(a, w, i); // what the event read
    a.status = "cancelled";
    w.status = "cancelled";
    i.status = "superseded";
    const out = await applyHold({ api: sa, watch: sw, intelligence: si }, { kind: "refunded", ref: "ch_x", invoiceId: "in_x", subscriptionId: "sub_x", eventId: "evt_x", created: T0 });
    expect(out.ok).toBe(true);
    expect([a.status, w.status, i.status]).toEqual(["cancelled", "cancelled", "superseded"]);
    expect([a.billing_hold ?? null, w.billing_hold ?? null, i.billing_hold ?? null]).toEqual([null, null, null]);
    expect(a.key_id).toBe("keyLIVE1"); // an ended account is not suspended a second time
  });

  it("cancelled AFTER the hold was read as held: the lift writes nothing and cannot revive it", async () => {
    const { applyHold, liftHold } = await import("@/lib/billing-holds");
    const a = apiAcct();
    const w = watchRow();
    const i = intelRow();
    await applyHold({ api: a as any, watch: w as any, intelligence: i as any }, { kind: "refunded", ref: "ch_x", invoiceId: "in_x", subscriptionId: "sub_x", eventId: "evt_x", created: T0 });
    expect([a.status, w.status, i.status]).toEqual(["past_due", "paused", "suspended"]);
    const [sa, sw, si] = snapshot(a, w, i); // held, as the invoice.paid event reads them
    a.status = "cancelled";
    w.status = "cancelled";
    i.status = "cancelled";
    const out = await liftHold({ api: sa, watch: sw, intelligence: si }, { kinds: ["refunded"], restore: "active", cause: "invoice_paid", subscriptionId: "sub_x", eventId: "evt_y", created: T0 + 30 * DAY });
    expect(out.ok).toBe(true);
    expect([a.status, w.status, i.status]).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("the webhook: a refund whose rows are cancelled by the deletion event delivered first leaves them cancelled, and the deletion after a hold wins too", async () => {
    const a = apiAcct();
    const w = watchRow();
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    await send("customer.subscription.deleted", { id: "sub_api", object: "subscription", metadata: { kind: "api_scale" } });
    await send("charge.refunded", fullRefund(), { created: T0 + 5 });
    await send("invoice.paid", paid("in_x", "sub_api"), { created: T0 + 9 });
    expect(a.status).toBe("cancelled");
    await send("charge.refunded", fullRefund("ch_w", "pi_w"), { created: T0 });
    expect(w.status).toBe("paused");
    await send("customer.subscription.deleted", { id: "sub_w", object: "subscription", metadata: { kind: "hall_watch" } });
    await send("invoice.paid", paid("in_y", "sub_w"), { created: T0 + 30 * DAY });
    expect(w.status).toBe("cancelled");
  });
});

describe("R6. a refund or dispute that arrives before its checkout is recorded", () => {
  it("one of OUR subscriptions with no record yet is answered 500 (retried); it applies once the checkout is recorded", async () => {
    stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    stripe.subscriptionKinds.set("sub_api", "api_scale");
    expect((await send("charge.refunded", fullRefund(), { created: T0, id: "evt_early" })).status).toBe(500);
    expect((await send("charge.dispute.created", dispute(), { created: T0, id: "evt_early_d" })).status).toBe(500);
    const a = apiAcct();
    expect((await send("charge.refunded", fullRefund(), { created: T0, id: "evt_early" })).status).toBe(200);
    expect(a.billing_hold).toBe("refunded");
  });

  it("somebody else's subscription on the same Stripe account is acknowledged, not retried", async () => {
    stripe.link("ch_x", "pi_x", "in_x", "sub_other");
    stripe.subscriptionKinds.set("sub_other", "something_else");
    expect((await send("charge.refunded", fullRefund("ch_x", "pi_x"), { created: T0 })).status).toBe(200);
  });
});

describe("R7. a queued Hall Watch note is never sent for a watch that is not active (the REAL attemptNotice)", () => {
  const queue = (w: Row) => {
    const note = db.insertRow("watch_notes", { watch_id: w.id, headline: "Racks moved", material: true, weeks_delta: 2, change: null });
    return db.insertRow("watch_note_notices", { watch_note_id: note.id, watch_id: w.id, status: "pending", attempts: 0, next_attempt_at: new Date(0).toISOString() });
  };
  const toWatcher = () => mail.filter((m) => m.to === "w@hall.example");

  it("control: an active watch's queued note is sent by attemptNotice", async () => {
    const w = watchRow();
    const { attemptNotice } = await import("@/lib/watch-notices");
    expect(await attemptNotice(queue(w) as any)).toBe("sent");
    expect(toWatcher()).toHaveLength(1);
  });

  it.each(["cancelled", "paused"])("a %s watch: the notice is abandoned and nothing is mailed, however the status changed", async (status) => {
    const w = watchRow();
    const n = queue(w);
    w.status = status; // changed directly: no webhook ran, so nothing abandoned the notice beforehand
    const { attemptNotice, sweepNotices } = await import("@/lib/watch-notices");
    expect(await attemptNotice(n as any)).toBe("abandoned");
    expect(toWatcher()).toHaveLength(0);
    const m = queue(w);
    expect((await sweepNotices()).outcomes.sent).toBe(0);
    expect(toWatcher()).toHaveLength(0);
    expect(m.status).toBe("abandoned");
  });

  it("announceNote for a watch that is no longer active sends nothing", async () => {
    const w = watchRow({ status: "cancelled" });
    const note = db.insertRow("watch_notes", { watch_id: w.id, headline: "Racks moved", material: true });
    const { announceNote } = await import("@/lib/watch-notices");
    await announceNote({ id: note.id as string, watch_id: w.id as string }, w as any, "Racks moved");
    expect(toWatcher()).toHaveLength(0);
  });
});

describe("R8. the inline revocation retry is bounded", () => {
  let attempts: number;
  let undo: () => void;
  let mode: "refuse" | "unreachable" | "ok";
  beforeEach(() => {
    attempts = 0;
    mode = "refuse";
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://engine.test/v1/revoke" && mode !== "ok") {
        attempts++;
        if (mode === "unreachable") throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    undo = () => { globalThis.fetch = inner; };
  });
  afterEach(() => undo());
  const many = () => apiAcct({ status: "cancelled", key_id: null, revoked_key_ids: ["k1", "k2", "k3", "k4", "k5", "k6"] });

  it("one billing event pushes at most three ids, and a second one inside ten minutes pushes none; the daily sweep still drains all of them", async () => {
    const a = many();
    expect((await send("invoice.paid", paid("in_x", "sub_api"), { created: T0 + 1 })).status).toBe(200);
    expect(attempts).toBe(3);
    expect((await send("invoice.paid", paid("in_y", "sub_api"), { created: T0 + 2 })).status).toBe(200);
    expect(attempts).toBe(3);
    vi.setSystemTime((T0 + 11 * 60) * 1000);
    await send("invoice.paid", paid("in_z", "sub_api"), { created: T0 + 11 * 60 });
    expect(attempts).toBe(6);
    mode = "ok";
    expect(await retryRevocations(50, new Date((T0 + 86_400) * 1000))).toMatchObject({ confirmed: 6, stillPending: 0 });
    expect(a.revocation_pending).toBe(false);
  });

  it("an engine that does not answer costs one attempt, not three", async () => {
    many();
    mode = "unreachable";
    await send("invoice.paid", paid("in_x", "sub_api"), { created: T0 + 1 });
    expect(attempts).toBe(1);
  });
});

describe("R9. audit keys and the grace pass", () => {
  it("repeated pause / resume cycles are each on record; a redelivery of one event is not recorded twice", async () => {
    watchRow();
    const sub = (over: Record<string, unknown> = {}) => ({ id: "sub_w", object: "subscription", status: "active", pause_collection: null, metadata: {}, ...over });
    let t = T0;
    for (let cycle = 0; cycle < 2; cycle++) {
      t += 100;
      await send("customer.subscription.updated", sub({ pause_collection: { behavior: "void" } }), { created: t, id: `evt_pause_${cycle}` });
      await send("customer.subscription.updated", sub({ pause_collection: { behavior: "void" } }), { created: t, id: `evt_pause_${cycle}` });
      t += 100;
      await send("customer.subscription.updated", sub(), { created: t, id: `evt_resume_${cycle}` });
      await send("customer.subscription.updated", sub(), { created: t, id: `evt_resume_${cycle}` });
    }
    expect(audit("hold_applied")).toHaveLength(2);
    expect(audit("hold_lifted")).toHaveLength(2);
  });

  it("rows whose key is already revoked cannot starve the pass: an expired grace behind 200+ of them is still revoked", async () => {
    for (let n = 0; n < 205; n++) {
      paygAccount(db, { account: `done-${n}`, token: `tok-done-${n}`.padEnd(30, "x"), plan: "api_scale", cap_units: null, status: "past_due", key_id: null, stripe_subscription_id: `sub_done_${n}`, past_due_since: new Date(T0 * 1000 - 40 * DAY * 1000).toISOString() });
    }
    const a = apiAcct({ status: "past_due", past_due_since: new Date((T0 - 10 * DAY) * 1000).toISOString() });
    const rep = await enforcePastDueGrace(new Date(T0 * 1000));
    expect(rep.revoked).toBe(1);
    expect(a.key_id).toBeNull();
  });
});
