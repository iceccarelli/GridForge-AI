/**
 * charge.dispute.created / .updated / .closed arrive in any order and are redelivered.
 *
 * Every dispute event is decided from the dispute's CURRENT state at Stripe (disputes.retrieve), never from its own payload or its type. So
 * a stale `created` or `updated` that arrives after the dispute is won, lost or closed cannot create a hold, a `closed` (won) that arrives
 * BEFORE its `created` leaves no hold behind, a lost dispute applies the hold exactly once, and everything is idempotent per dispute id and
 * state. Each case fails against the previous handler (which decided by event type and payload status and never lifted a hold that its own
 * `created` applied after the `closed`).
 *
 *   MOCK STRIPE / MOCK ENGINE / FAKE STORE   tests/site/billing-holds-harness.ts. `pinDispute` is Stripe's CURRENT state of the dispute;
 *   the payloads below are what each event said when it was GENERATED (and may be stale by the time they are delivered).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiAcct, audit, intelRow, operatorMail, revokeCalls, send, startRig, watchRow, type Rig } from "./billing-holds-harness";

let rig: Rig;
beforeEach(() => { rig = startRig(); });
afterEach(() => rig.stop());

const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", amount: 90_000, currency: "eur", charge: "ch_1", reason: "fraudulent", status: "needs_response", ...over });
type Ev = "created" | "updated" | "closed";
const TYPE: Record<Ev, string> = { created: "charge.dispute.created", updated: "charge.dispute.updated", closed: "charge.dispute.closed" };
/** What each event said when it was generated, for a dispute that ended `final`. */
const payload = (ev: Ev, final: "won" | "lost") => dispute({ status: ev === "created" ? "needs_response" : ev === "updated" ? "under_review" : final });

const perms = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const ORDERS = perms<Ev>(["created", "updated", "closed"]);

/** Deliver the events in `order`, each twice (Stripe redelivers), at distinct event times in their natural order. */
async function deliver(order: Ev[], final: "won" | "lost", twice = true) {
  const at: Record<Ev, number> = { created: rig.T0 + 10, updated: rig.T0 + 20, closed: rig.T0 + 30 };
  for (const ev of order) {
    for (let n = 0; n < (twice ? 2 : 1); n++) {
      const res = await send(rig, TYPE[ev], payload(ev, final), { created: at[ev], id: `evt_${ev}_${n}` });
      expect(res.status, `${ev} #${n}`).toBe(200);
    }
  }
}

describe("1. all six orderings of created / updated / closed(won): no hold, however they arrive", () => {
  for (const order of ORDERS) {
    it(`order ${order.join(" -> ")}: nothing is suspended, nothing is revoked, one record of the state`, async () => {
      const a = apiAcct(rig);
      const w = watchRow(rig);
      const i = intelRow(rig);
      for (const [c, pi, inv, sub] of [["ch_1", "pi_1", "in_1", "sub_api"], ["ch_w", "pi_w", "in_w", "sub_w"], ["ch_i", "pi_i", "in_i", "sub_i"]]) rig.stripe.link(c, pi, inv, sub);
      rig.stripe.pinDispute("dp_1", { status: "won", charge: "ch_1", amount: 90_000 }); // Stripe: the dispute is WON
      await deliver(order, "won");
      expect(a).toMatchObject({ status: "active", key_id: "keyLIVE1", billing_hold: null });
      expect(revokeCalls(rig)).toEqual([]);
      expect(audit(rig, "hold_applied")).toHaveLength(0);
      expect(audit(rig, "dispute_state")).toHaveLength(1); // per dispute and state, not per delivery (6 deliveries)
      expect(audit(rig, "dispute_state")[0]).toMatchObject({ stripe_object_id: "dp_1", subject_table: "api_accounts", detail: { status: "won", decision: "none" } });
      expect(w.status).toBe("active");
      expect(i.status).toBe("active");
    });
  }
});

describe("2. all six orderings with a dispute that was LOST: the reversal hold is applied exactly once", () => {
  for (const order of ORDERS) {
    it(`order ${order.join(" -> ")}: one hold, one revocation, one record of each decision`, async () => {
      const a = apiAcct(rig);
      rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
      rig.stripe.pinDispute("dp_1", { status: "lost", charge: "ch_1", amount: 90_000 });
      await deliver(order, "lost");
      expect(a).toMatchObject({ status: "past_due", key_id: null, billing_hold: "disputed", billing_hold_ref: "dp_1", billing_hold_invoice: "in_1", billing_hold_prev_status: "active" });
      expect(revokeCalls(rig)).toEqual(["keyLIVE1"]);
      expect(audit(rig, "hold_applied")).toHaveLength(1);
      expect(audit(rig, "dispute_lost_hold_stands")).toHaveLength(1);
      expect(audit(rig, "dispute_state").map((r) => (r.detail as any).status)).toEqual(["lost"]);
    });
  }
});

describe("3. a dispute in progress, then over", () => {
  it("opened (needs_response) holds; under_review is still the same hold; each state is on record once", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    expect((await send(rig, TYPE.created, dispute(), { created: rig.T0 + 10 })).status).toBe(200);
    expect(a).toMatchObject({ billing_hold: "disputed", status: "past_due" });
    expect((await send(rig, TYPE.updated, dispute({ status: "under_review" }), { created: rig.T0 + 20 })).status).toBe(200);
    expect(audit(rig, "hold_applied")).toHaveLength(1);
    expect(audit(rig, "dispute_state").map((r) => (r.detail as any).status).sort()).toEqual(["needs_response", "under_review"]);
    expect(revokeCalls(rig)).toEqual(["keyLIVE1"]);
  });

  it("won lifts the hold the dispute caused; a STALE created redelivered afterwards does not bring it back", async () => {
    const a = apiAcct(rig);
    const w = watchRow(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    rig.stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    await send(rig, TYPE.created, dispute(), { created: rig.T0 + 10 });
    await send(rig, TYPE.created, dispute({ id: "dp_w", charge: "ch_w" }), { created: rig.T0 + 10 });
    expect([a.status, w.status]).toEqual(["past_due", "paused"]);
    rig.stripe.pinDispute("dp_1", { status: "won", charge: "ch_1", amount: 90_000 });
    rig.stripe.pinDispute("dp_w", { status: "won", charge: "ch_w", amount: 90_000 });
    await send(rig, TYPE.closed, dispute({ status: "won" }), { created: rig.T0 + 30 });
    await send(rig, TYPE.closed, dispute({ id: "dp_w", charge: "ch_w", status: "won" }), { created: rig.T0 + 30 });
    expect([a.status, w.status]).toEqual(["active", "active"]);
    expect(a).toMatchObject({ billing_hold: null, key_id: null });
    expect(audit(rig, "hold_lifted")).toHaveLength(2);
    // the stale ones, delivered after the dispute is over
    for (const [id, ch] of [["dp_1", "ch_1"], ["dp_w", "ch_w"]]) {
      expect((await send(rig, TYPE.created, dispute({ id, charge: ch }), { created: rig.T0 + 11, id: `evt_stale_c_${id}` })).status).toBe(200);
      expect((await send(rig, TYPE.updated, dispute({ id, charge: ch, status: "under_review" }), { created: rig.T0 + 21, id: `evt_stale_u_${id}` })).status).toBe(200);
    }
    expect([a.status, w.status]).toEqual(["active", "active"]);
    expect(a.billing_hold ?? null).toBeNull();
    expect(audit(rig, "hold_applied")).toHaveLength(2); // the two original holds; no new one
    expect(revokeCalls(rig)).toEqual(["keyLIVE1"]); // a revoked key is not revoked again
  });

  it("a lost dispute delivered as `closed` after a stale `created` and `updated` of an earlier state still ends in one hold", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    rig.stripe.pinDispute("dp_1", { status: "lost", charge: "ch_1", amount: 90_000 });
    await send(rig, TYPE.closed, dispute({ status: "lost" }), { created: rig.T0 + 30 });
    await send(rig, TYPE.created, dispute(), { created: rig.T0 + 10 });
    await send(rig, TYPE.updated, dispute({ status: "under_review" }), { created: rig.T0 + 20 });
    expect(a).toMatchObject({ billing_hold: "disputed", billing_hold_ref: "dp_1" });
    expect(audit(rig, "hold_applied")).toHaveLength(1);
  });

  it("Hall Watch and Intelligence go back to what they were before (past_due stays past_due), and an unrelated dispute lifts nothing", async () => {
    const w = watchRow(rig);
    const i = intelRow(rig, { status: "past_due" });
    rig.stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    rig.stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    await send(rig, TYPE.created, dispute({ id: "dp_w", charge: "ch_w" }), { created: rig.T0 + 10 });
    await send(rig, TYPE.created, dispute({ id: "dp_i", charge: "ch_i" }), { created: rig.T0 + 10 });
    expect([w.status, i.status]).toEqual(["paused", "suspended"]);
    rig.stripe.pinDispute("dp_other", { status: "won", charge: "ch_w" });
    await send(rig, TYPE.closed, dispute({ id: "dp_other", charge: "ch_w", status: "won" }), { created: rig.T0 + 40 });
    expect([w.status, i.status]).toEqual(["paused", "suspended"]);
    rig.stripe.pinDispute("dp_w", { status: "won", charge: "ch_w" });
    rig.stripe.pinDispute("dp_i", { status: "won", charge: "ch_i" });
    await send(rig, TYPE.closed, dispute({ id: "dp_w", charge: "ch_w", status: "won" }), { created: rig.T0 + 50 });
    await send(rig, TYPE.closed, dispute({ id: "dp_i", charge: "ch_i", status: "won" }), { created: rig.T0 + 50 });
    expect([w.status, i.status]).toEqual(["active", "past_due"]);
  });

  it("a lift is not blocked by a later PAYMENT event on the same subscription (the dispute's own state decides)", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, TYPE.created, dispute(), { created: rig.T0 + 10 });
    await send(rig, "invoice.payment_failed", { id: "in_9", object: "invoice", subscription: "sub_api" }, { created: rig.T0 + 25 }); // advances the payment clock past the closed event below
    rig.stripe.pinDispute("dp_1", { status: "won", charge: "ch_1" });
    await send(rig, TYPE.closed, dispute({ status: "won" }), { created: rig.T0 + 20 });
    expect(a.billing_hold ?? null).toBeNull();
  });
});

describe("4. a warning inquiry, an escalation, the other closed states", () => {
  it("an early-warning inquiry moves no money and holds nothing; its escalation to a real dispute does, once", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    expect((await send(rig, TYPE.created, dispute({ status: "warning_needs_response" }), { created: rig.T0 + 10 })).status).toBe(200);
    expect(a.status).toBe("active");
    expect((await send(rig, TYPE.updated, dispute({ status: "warning_under_review" }), { created: rig.T0 + 15 })).status).toBe(200);
    expect(a.status).toBe("active");
    for (let n = 0; n < 2; n++) expect((await send(rig, TYPE.updated, dispute({ status: "needs_response" }), { created: rig.T0 + 20, id: "evt_esc" })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", billing_hold: "disputed" });
    expect(audit(rig, "hold_applied")).toHaveLength(1);
  });

  it("an inquiry that closes without becoming a dispute, and a dispute closed because the charge was refunded, hold nothing", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, TYPE.closed, dispute({ status: "warning_closed" }), { created: rig.T0 + 10 });
    await send(rig, TYPE.closed, dispute({ id: "dp_r", status: "charge_refunded" }), { created: rig.T0 + 11 });
    expect(a).toMatchObject({ status: "active", billing_hold: null });
  });

  it("a status this site has no rule for changes nothing and tells the operator once", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    for (let n = 0; n < 2; n++) expect((await send(rig, TYPE.updated, dispute({ status: "something_new" }), { created: rig.T0 + 10, id: `evt_u${n}` })).status).toBe(200);
    expect(a.status).toBe("active");
    expect(operatorMail(rig).filter((m) => /no rule for/.test(m.subject))).toHaveLength(1);
  });

  it("a dispute on an engagement deposit (no subscription behind the payment) is acknowledged and changes nothing", async () => {
    const a = apiAcct(rig);
    rig.stripe.chargeInfo.set("ch_dep", { payment_intent: "pi_dep" });
    expect((await send(rig, TYPE.created, dispute({ charge: "ch_dep" }), { created: rig.T0 + 10 })).status).toBe(200);
    expect(a.status).toBe("active");
    expect(audit(rig)).toHaveLength(0);
  });
});

describe("5. Stripe cannot be asked, or has never heard of the dispute", () => {
  it("a failed lookup answers 500 so Stripe retries; the retry applies it; nothing was half-done", async () => {
    const a = apiAcct(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    rig.stripe.failOnce.add("disputes.retrieve");
    expect((await send(rig, TYPE.created, dispute(), { created: rig.T0 + 10, id: "evt_x" })).status).toBe(500);
    expect(a).toMatchObject({ status: "active", billing_hold: null });
    expect((await send(rig, TYPE.created, dispute(), { created: rig.T0 + 10, id: "evt_x" })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", billing_hold: "disputed" });
  });

  it("a dispute Stripe says does not exist is acknowledged (never retried for ever) with an audit row, once", async () => {
    const a = apiAcct(rig);
    for (let n = 0; n < 3; n++) expect((await send(rig, TYPE.updated, dispute({ id: "dp_ghost" }), { created: rig.T0 + 10, id: `evt_g${n}`, unmirrored: true })).status).toBe(200);
    expect(a.status).toBe("active");
    expect(audit(rig, "dispute_not_found")).toHaveLength(1);
    expect(audit(rig, "dispute_not_found")[0]).toMatchObject({ subject_table: "stripe_disputes", subject_id: "dp_ghost", stripe_object_id: "dp_ghost" });
  });

  it("without migration 0043 the audit row cannot name a dispute, but the event is still acknowledged and the operator told", async () => {
    // billing_audit's CHECK of 0041 refuses subject 'stripe_disputes': the fake store has no CHECK, so a missing table stands in for it
    rig.db.dropTable("billing_audit");
    expect((await send(rig, TYPE.updated, dispute({ id: "dp_ghost" }), { created: rig.T0 + 10, id: "evt_g1", unmirrored: true })).status).toBe(200);
    expect(operatorMail(rig).filter((m) => /does not have/.test(m.subject))).toHaveLength(1);
  });
});
