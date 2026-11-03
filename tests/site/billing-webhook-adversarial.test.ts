/**
 * Adversarial deliveries to the REAL webhook route (app/api/stripe/webhook/route.ts), signed with the Stripe SDK's own test-header helper.
 *
 * Labels: STRIPE is a stand-in (tests/site/billing-holds-harness.ts HoldStripe: no live call, nothing proves what live Stripe sends), the store is the
 * in-memory PostgREST fake (the SQL is proven separately against PostgreSQL), the engine is a fetch interceptor. Signatures are real: the route
 * verifies them with the SDK, exactly as in production.
 *
 *   A. authenticity   bad / tampered / stale / missing signature, wrong secret, unconfigured secret: refused, and NOTHING is written
 *   B. replay         the same event id, and a different event id for the same sale, produce exactly one entitlement of each kind
 *   C. ordering       cancel before pay, pay after cancel, refund before / after pay, failure after success: the entitlement ends where the money says
 *   D. holds          a refund or a dispute holds paid access, once, and only the right payment lifts it
 *   E. unknown        an event type the site does not handle is acknowledged with 200 and changes nothing
 */
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { paidSession } from "./checkout-fixture";
import { WH, at, audit, apiAcct, intelRow, operatorMail, revokeCalls, send, startRig, watchRow, DAY, type Rig } from "./billing-holds-harness";
import type { Row } from "./postgrest-fake";

const sdk = new Stripe("sk_test_placeholder");
let rig: Rig;
beforeEach(() => {
  rig = startRig();
  // The production indexes of migration 0011 (one fulfilment per payment), which the fake store does not have unless told: they are what makes
  // concurrent deliveries of one sale safe, so the concurrency test below must run with them.
  rig.db.uniqueKeys.set("watches", [["stripe_subscription_id"]]);
  rig.db.uniqueKeys.set("api_accounts", [...(rig.db.uniqueKeys.get("api_accounts") ?? []), ["stripe_subscription_id"]]);
});
afterEach(() => rig.stop());

/** Every table a delivery could write to, as one snapshot: a refused or ignored event must leave it byte-identical. */
const TABLES = ["api_accounts", "watches", "subscriptions", "deliverables", "leads", "billing_audit", "funnel_events", "customer_notifications", "operator_notices"];
const snapshot = () => JSON.stringify(TABLES.map((t) => { try { return rig.db.rows(t); } catch { return null; } }));

async function post(raw: string, signature: string | null) {
  const { POST } = await import("@/app/api/stripe/webhook/route");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["stripe-signature"] = signature;
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers, body: raw }));
}
const signed = (raw: string, over: { secret?: string; timestamp?: number } = {}) =>
  sdk.webhooks.generateTestHeaderString({ payload: raw, secret: over.secret ?? WH, ...(over.timestamp ? { timestamp: over.timestamp } : {}) });

const checkout = (kind: string, over: Record<string, unknown> = {}) =>
  paidSession({
    id: `cs_${kind}`, object: "checkout.session", customer_email: "buyer@hall.example", customer: `cus_${kind}`, subscription: `sub_${kind}`,
    amount_total: 90_000, currency: "eur", metadata: { kind, company: "Hall Co", ...(kind === "intelligence_subscription" ? { plan: "team" } : {}) }, ...over,
  });
const subObj = (kind: string, over: Record<string, unknown> = {}) => ({ id: `sub_${kind}`, object: "subscription", status: "canceled", metadata: { kind }, ...over });
const entitlements = () => ({
  api: (rig.db.rows("api_accounts") as Row[]).filter((r) => r.stripe_subscription_id === "sub_api_scale"),
  watch: (rig.db.rows("watches") as Row[]).filter((r) => r.stripe_subscription_id === "sub_hall_watch"),
  intel: (rig.db.rows("subscriptions") as Row[]).filter((r) => r.stripe_subscription_id === "sub_intelligence_subscription"),
});

// =========================================================================================================================
describe("A. authenticity: a delivery that cannot prove it is Stripe's changes nothing", () => {
  const body = () => JSON.stringify({ id: "evt_a", type: "checkout.session.completed", data: { object: checkout("hall_watch") } });

  it("a forged signature, a wrong-secret signature, a missing header and a malformed header are each refused with 400 and write nothing", async () => {
    const before = snapshot();
    const raw = body();
    for (const sig of ["t=1,v1=deadbeef", signed(raw, { secret: "whsec_someone_else" }), null, "", "garbage", "t=,v1=", `t=${Math.floor(Date.now() / 1000)}`]) {
      expect((await post(raw, sig)).status, String(sig)).toBe(400);
    }
    expect(snapshot()).toBe(before);
    expect(entitlements().watch).toHaveLength(0);
  });

  it("a payload altered after signing (a different amount, a different customer) is refused", async () => {
    const raw = body();
    const good = signed(raw);
    for (const tampered of [raw.replace("90000", "1"), raw.replace("buyer@hall.example", "attacker@evil.example"), raw + " ", raw.replace("hall_watch", "api_platform")]) {
      expect(tampered).not.toBe(raw);
      expect((await post(tampered, good)).status).toBe(400);
    }
    expect(entitlements().watch).toHaveLength(0);
    expect(rig.db.rows("api_accounts")).toHaveLength(0);
  });

  it("a correctly signed but STALE delivery (older than Stripe's five-minute tolerance) is refused: a captured request cannot be replayed later", async () => {
    const raw = body();
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(raw, signed(raw, { timestamp: old }))).status).toBe(400);
    expect(entitlements().watch).toHaveLength(0);
    // the same payload, freshly signed, is accepted: the refusal above was about time, not content
    expect((await post(raw, signed(raw))).status).toBe(200);
    expect(entitlements().watch).toHaveLength(1);
  });

  it("with the webhook secret unset the route answers 503 for even a perfectly signed event, and writes nothing", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const raw = body();
    expect((await post(raw, signed(raw))).status).toBe(503);
    expect(entitlements().watch).toHaveLength(0);
  });

  it("a validly signed body that is not an event (JSON null, [], {}, no type, no data) is refused with 400: never an unhandled 500, never a write", async () => {
    const before = snapshot();
    for (const raw of ["not json", "[]", "null", "{}", '{"id":1}', '{"id":"e","type":"charge.refunded"}', '{"id":"e","type":5,"data":{}}']) {
      const res = await post(raw, signed(raw));
      expect(res.status, raw).toBe(400);
    }
    expect(snapshot()).toBe(before);
  });
});

// =========================================================================================================================
describe("B. replay and duplicate delivery produce exactly one entitlement", () => {
  it.each(["api_scale", "hall_watch", "intelligence_subscription"])("%s: the SAME event id delivered five times opens one entitlement and mints no second credential", async (kind) => {
    for (let i = 0; i < 5; i++) expect((await send(rig, "checkout.session.completed", checkout(kind), { id: "evt_same" })).status).toBe(200);
    const e = entitlements();
    const mine = kind === "api_scale" ? e.api : kind === "hall_watch" ? e.watch : e.intel;
    expect(mine).toHaveLength(1);
    expect(rig.db.rows("api_accounts").length + rig.db.rows("watches").length + rig.db.rows("subscriptions").length).toBe(1);
  });

  it.each(["api_scale", "hall_watch", "intelligence_subscription"])("%s: DIFFERENT event ids for the same checkout session (Stripe redelivering as a new event, or two endpoints) still open one", async (kind) => {
    for (const id of ["evt_1", "evt_2", "evt_3"]) expect((await send(rig, "checkout.session.completed", checkout(kind), { id })).status).toBe(200);
    expect(rig.db.rows("api_accounts").length + rig.db.rows("watches").length + rig.db.rows("subscriptions").length).toBe(1);
  });

  it("a completed event then the async_payment_succeeded event for the same session is one sale, not two", async () => {
    await send(rig, "checkout.session.completed", checkout("hall_watch"), { id: "evt_c" });
    await send(rig, "checkout.session.async_payment_succeeded", checkout("hall_watch"), { id: "evt_s" });
    expect(entitlements().watch).toHaveLength(1);
  });

  it("a replayed invoice.paid does not extend, reopen or re-credit anything: the second delivery leaves the store identical to the first", async () => {
    const a = apiAcct(rig, { status: "past_due" });
    const inv = { id: "in_r", object: "invoice", subscription: "sub_api" };
    rig.stripe.addInvoice("in_r", "sub_api");
    await send(rig, "invoice.paid", inv, { id: "evt_p", created: rig.T0 });
    expect(a.status).toBe("active");
    const once = snapshot();
    for (let i = 0; i < 3; i++) expect((await send(rig, "invoice.paid", inv, { id: "evt_p", created: rig.T0 })).status).toBe(200);
    expect(snapshot()).toBe(once);
  });

  it("a replayed customer.subscription.deleted revokes once: one engine revocation, one funnel row", async () => {
    apiAcct(rig);
    for (let i = 0; i < 3; i++) expect((await send(rig, "customer.subscription.deleted", subObj("api_scale", { id: "sub_api", metadata: { kind: "api_scale" } }), { id: "evt_d" })).status).toBe(200);
    // The engine's /v1/revoke is idempotent, so a redelivery may push the same id again; what must hold is that it is only ever THAT id, recorded once.
    expect(new Set(revokeCalls(rig))).toEqual(new Set(["keyLIVE1"]));
    expect((rig.db.rows("funnel_events") as Row[]).filter((r) => r.name === "subscription_cancelled")).toHaveLength(1);
    expect((rig.db.rows("api_accounts") as Row[])[0]).toMatchObject({ status: "cancelled", revoked_key_ids: ["keyLIVE1"] });
  });

  it("concurrent deliveries of the same sale (Promise.all) still open exactly one entitlement", async () => {
    await Promise.all([1, 2, 3, 4].map((i) => send(rig, "checkout.session.completed", checkout("hall_watch"), { id: `evt_par_${i}` })));
    expect(entitlements().watch.length).toBe(1);
  });
});

// =========================================================================================================================
describe("C. out-of-order events: the entitlement ends where the money says", () => {
  it("cancel BEFORE pay: the cancellation is answered 500 (Stripe retries it) rather than lost; once the checkout lands, the retry cancels", async () => {
    const early = await send(rig, "customer.subscription.deleted", subObj("hall_watch"), { id: "evt_del" });
    expect(early.status).toBe(500);
    expect(entitlements().watch).toHaveLength(0);
    expect((await send(rig, "checkout.session.completed", checkout("hall_watch"), { id: "evt_pay" })).status).toBe(200);
    expect(entitlements().watch[0].status).toBe("active");
    expect((await send(rig, "customer.subscription.deleted", subObj("hall_watch"), { id: "evt_del" })).status).toBe(200);
    expect(entitlements().watch[0].status).toBe("cancelled");
  });

  it("the same for an Intelligence subscription and an API account", async () => {
    for (const kind of ["intelligence_subscription", "api_scale"]) {
      expect((await send(rig, "customer.subscription.deleted", subObj(kind), { id: `evt_del_${kind}` })).status).toBe(500);
      await send(rig, "checkout.session.completed", checkout(kind), { id: `evt_pay_${kind}` });
      expect((await send(rig, "customer.subscription.deleted", subObj(kind), { id: `evt_del_${kind}` })).status).toBe(200);
    }
    expect(entitlements().intel[0].status).toBe("cancelled");
    expect(entitlements().api[0].status).toBe("cancelled");
  });

  it("a deletion for a subscription that is NOT ours (no kind of ours, no record) is acknowledged 200, not retried for ever", async () => {
    expect((await send(rig, "customer.subscription.deleted", { id: "sub_other", object: "subscription", metadata: { kind: "somebody_elses_app" } })).status).toBe(200);
    expect((await send(rig, "customer.subscription.deleted", { id: "sub_none", object: "subscription" })).status).toBe(200);
  });

  it("pay AFTER cancel: an invoice.paid for a cancelled subscription does not resurrect it (re-subscribing is a new sale)", async () => {
    const a = apiAcct(rig);
    await send(rig, "customer.subscription.deleted", subObj("api_scale", { id: "sub_api" }), { id: "evt_d", created: rig.T0 });
    expect(a.status).toBe("cancelled");
    rig.stripe.addInvoice("in_late", "sub_api");
    expect((await send(rig, "invoice.paid", { id: "in_late", object: "invoice", subscription: "sub_api" }, { id: "evt_late", created: rig.T0 + 60 })).status).toBe(200);
    expect(a.status).toBe("cancelled");
  });

  it("a failure delivered AFTER the payment that cleared it (older event time) does not put the account back to past_due", async () => {
    const a = apiAcct(rig);
    rig.stripe.addInvoice("in_ok", "sub_api");
    await send(rig, "invoice.paid", { id: "in_ok", object: "invoice", subscription: "sub_api" }, { id: "evt_ok", created: rig.T0 + 100 });
    await send(rig, "invoice.payment_failed", { id: "in_bad", object: "invoice", subscription: "sub_api" }, { id: "evt_bad", created: rig.T0 + 10 });
    expect(a.status).toBe("active");
  });

  it("a refund delivered BEFORE the checkout event (no record yet) is acknowledged and holds nothing; the later sale is a normal sale", async () => {
    rig.stripe.link("ch_early", "pi_early", "in_early", "sub_hall_watch");
    const res = await send(rig, "charge.refunded", { id: "ch_early", object: "charge", amount: 90_000, amount_refunded: 90_000, refunded: true, payment_intent: "pi_early", currency: "eur" }, { id: "evt_rf", created: rig.T0 });
    expect(res.status).toBe(200);
    expect(audit(rig, "hold_applied")).toHaveLength(0);
    await send(rig, "checkout.session.completed", checkout("hall_watch"), { id: "evt_pay" });
    expect(entitlements().watch).toHaveLength(1);
  });
});

// =========================================================================================================================
describe("D. refund and dispute holds", () => {
  const refund = (id = "ch_1", pi = "pi_1", full = true) => ({ id, object: "charge", amount: 90_000, amount_refunded: full ? 90_000 : 30_000, refunded: full, payment_intent: pi, currency: "eur" });
  const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", amount: 90_000, currency: "eur", charge: "ch_1", reason: "fraudulent", status: "needs_response", ...over });

  it("a full refund holds the API account once: key revoked at the engine, an audit row, the operator can see it; a duplicate delivery adds nothing", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    for (const id of ["evt_r1", "evt_r1", "evt_r2"]) expect((await send(rig, "charge.refunded", refund(), { id, created: rig.T0 })).status).toBe(200);
    expect(a).toMatchObject({ billing_hold: "refunded", status: "past_due", key_id: null });
    expect(revokeCalls(rig)).toEqual(["keyLIVE1"]);
    expect(audit(rig, "hold_applied")).toHaveLength(1);
  });

  it("a PARTIAL refund holds nothing", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "charge.refunded", refund("ch_1", "pi_1", false), { created: rig.T0 });
    expect(a.status).toBe("active");
    expect(a.billing_hold ?? null).toBeNull();
  });

  it("a lost dispute holds, and a replayed or reordered dispute event cannot lift or duplicate it", async () => {
    const w = watchRow(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_w");
    await send(rig, "charge.dispute.created", dispute({ status: "needs_response" }), { id: "evt_dc", created: rig.T0 });
    expect(w.status).toBe("paused");
    // closed(lost), then the OLD created event redelivered: still held, still one audit row
    await send(rig, "charge.dispute.closed", dispute({ status: "lost" }), { id: "evt_dl", created: rig.T0 + 100 });
    await send(rig, "charge.dispute.created", dispute({ status: "lost" }), { id: "evt_dc", created: rig.T0 });
    expect(w.status).toBe("paused");
    expect(w.billing_hold).toBe("disputed");
    expect(audit(rig, "hold_applied")).toHaveLength(1);
  });

  it("the SAME invoice paid again does not lift a refund hold; a LATER, different, paid invoice does", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "charge.refunded", refund(), { id: "evt_rf", created: rig.T0 });
    expect(a.billing_hold).toBe("refunded");
    await send(rig, "invoice.paid", { id: "in_1", object: "invoice", subscription: "sub_api" }, { id: "evt_same", created: rig.T0 + 10 });
    expect(a.billing_hold).toBe("refunded");
    at(rig.T0 + 30 * DAY);
    rig.stripe.addInvoice("in_2", "sub_api");
    await send(rig, "invoice.paid", { id: "in_2", object: "invoice", subscription: "sub_api" }, { id: "evt_next", created: rig.T0 + 30 * DAY });
    expect(a.billing_hold ?? null).toBeNull();
    expect(a.status).toBe("active");
    expect(a.key_id, "a revoked key is not brought back by the payment that lifts the hold").toBeNull();
  });

  it("Stripe cannot be asked about the charge: the refund is answered 500 so Stripe redelivers, and applies on the retry", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    rig.stripe.failOnce.add("invoicePayments.list");
    expect((await send(rig, "charge.refunded", refund(), { id: "evt_rf", created: rig.T0 })).status).toBe(500);
    expect(a.status).toBe("active");
    expect((await send(rig, "charge.refunded", refund(), { id: "evt_rf", created: rig.T0 })).status).toBe(200);
    expect(a.billing_hold).toBe("refunded");
  });

  it("a refund or dispute never touches somebody else's entitlement", async () => {
    const mine = apiAcct(rig);
    const other = apiAcct(rig, { account: "other", token: "tok-other-0123456789abcdefghij", stripe_subscription_id: "sub_other", key_id: "keyOTHER" });
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "charge.refunded", refund(), { created: rig.T0 });
    expect(mine.billing_hold).toBe("refunded");
    expect(other.status).toBe("active");
    expect(other.key_id).toBe("keyOTHER");
    const i = intelRow(rig);
    expect(i.status).toBe("active");
  });
});

// =========================================================================================================================
describe("E. event types the site does not handle are acknowledged and change nothing", () => {
  const TYPES = [
    "customer.updated", "customer.created", "invoice.finalized", "invoice.created", "invoice.upcoming", "payment_intent.succeeded", "payment_intent.created",
    "customer.subscription.created", "customer.subscription.trial_will_end", "charge.succeeded", "charge.failed", "price.updated", "product.created",
    "payout.paid", "balance.available", "checkout.session.expired", "setup_intent.succeeded", "radar.early_fraud_warning.created",
    "charge.dispute.funds_withdrawn", "charge.refund.updated", "v2.core.event_destination.ping", "totally.made.up.event", "a", "",
  ];

  it.each(TYPES)("%j: 200, nothing written, nobody mailed", async (type) => {
    // one of every kind of entitlement exists, so a stray handler touching any of them would show
    apiAcct(rig); watchRow(rig); intelRow(rig);
    const before = snapshot();
    const mailBefore = rig.mail.length;
    const res = await send(rig, type, { id: "obj_1", object: "thing", subscription: "sub_api", customer: "cus_api", status: "canceled" }, { unmirrored: true });
    expect(res.status).toBe(200);
    expect(snapshot()).toBe(before);
    expect(rig.mail.length).toBe(mailBefore);
    expect(revokeCalls(rig)).toEqual([]);
  });

  it("an unknown type with a hostile data.object (null, array, deep nesting, huge string) is still 200 and still harmless", async () => {
    apiAcct(rig);
    const before = snapshot();
    const deep: any = {}; let cur = deep;
    for (let i = 0; i < 200; i++) { cur.n = {}; cur = cur.n; }
    for (const object of [null, [], "x".repeat(200_000), deep, { id: 5 }, { "__proto__": { polluted: true } }]) {
      const raw = JSON.stringify({ id: "evt_h", type: "customer.updated", data: { object } });
      const res = await post(raw, signed(raw));
      expect(res.status).toBe(200);
    }
    expect(snapshot()).toBe(before);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("a known type with a hollow payload is not a 500 that Stripe retries for ever on a request that can never succeed, and writes nothing", async () => {
    apiAcct(rig);
    const before = { api: JSON.stringify(rig.db.rows("api_accounts")) };
    const out: Record<string, number> = {};
    for (const type of ["invoice.paid", "invoice.payment_failed", "customer.subscription.deleted", "customer.subscription.updated", "charge.refunded", "charge.dispute.created"]) {
      const raw = JSON.stringify({ id: `evt_${type}`, type, data: { object: {} } });
      out[type] = (await post(raw, signed(raw))).status;
    }
    // Stripe never sends these. Bookkeeping rows (a funnel count, an audit note that the dispute was not found) may be written, but no
    // entitlement moves, no credential is revoked and nobody is mailed.
    expect(JSON.stringify(rig.db.rows("api_accounts"))).toBe(before.api);
    expect(rig.db.rows("watches")).toHaveLength(0);
    expect(rig.db.rows("subscriptions")).toHaveLength(0);
    expect(revokeCalls(rig)).toEqual([]);
    for (const [type, status] of Object.entries(out)) expect([200, 400, 500], `${type} -> ${status}`).toContain(status);
  });
});
