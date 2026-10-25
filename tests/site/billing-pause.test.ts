/**
 * A billing pause takes effect when the PAID period ends, not at once.
 *
 * Stripe's pause_collection stops FUTURE invoices only, so a customer who pauses in the middle of a period has already paid for the rest
 * of it; the hold used to begin with the event and took that away. Every case here fails against the code before this change (the
 * held-out behaviours are in the commit message). Labels, never upgraded into one another:
 *   MOCK STRIPE / MOCK ENGINE / FAKE STORE   tests/site/billing-holds-harness.ts. No live Stripe call is made; the SQL itself (columns,
 *                                            append-only audit) is proven against PostgreSQL in tests/test_billing_pause_reversals_migration.py.
 *   the clock                                only Date is faked (vi.setSystemTime); the webhook, the daily job, the access checks and the
 *                                            Hall Watch cron are the REAL code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { applyDuePauses } from "@/lib/billing-pause";
import type { ReversalStripe } from "@/lib/billing-holds";
import { lookupEntitlement } from "@/lib/subscribers";
import { DAY, apiAcct, at, audit, intelRow, operatorMail, post, revokeCalls, send, startRig, watchRow, type Rig } from "./billing-holds-harness";

let rig: Rig;
beforeEach(() => { rig = startRig(); });
afterEach(() => rig.stop());

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const PERIOD = 10 * DAY; // the customer paid until T0 + 10 days
const sub = (id: string, over: Record<string, unknown> = {}) => ({
  id, object: "subscription", status: "active", pause_collection: null, metadata: {},
  current_period_start: rig.T0 - 20 * DAY, current_period_end: rig.T0 + PERIOD, latest_invoice: `in_current_${id}`, ...over,
});
const paused = (id: string, over: Record<string, unknown> = {}, pc: Record<string, unknown> = {}) => sub(id, { pause_collection: { behavior: "void", ...pc }, ...over });
/** What Stripe itself says when the daily job asks: billing is still paused. */
const stripePaused = (...ids: string[]) => { for (const id of ids) rig.stripe.setSubscription(id, { status: "active", pause_collection: { behavior: "void" } }); };
const runDue = () => applyDuePauses({ stripe: rig.stripe as unknown as ReversalStripe, now: new Date() });
const all = () => ({ a: apiAcct(rig), w: watchRow(rig), i: intelRow(rig) });
const SUBS = ["sub_api", "sub_w", "sub_i"];

describe("1. a pause mid-period is SCHEDULED for the end of the paid period; nothing is suspended yet", () => {
  it("API key stays live and mintable, Hall Watch stays active, Intelligence stays entitled; the schedule and the decision are on record", async () => {
    const { a, w, i } = all();
    for (const s of SUBS) expect((await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", key_id: "keyLIVE1", billing_hold: null });
    expect(w).toMatchObject({ status: "active", billing_hold: null });
    expect(i).toMatchObject({ status: "active", billing_hold: null });
    for (const r of [a, w, i]) expect(r).toMatchObject({ billing_pause_from: iso(rig.T0 + PERIOD), billing_pause_event_ts: rig.T0 + 5 });
    expect(revokeCalls(rig)).toEqual([]);
    expect(audit(rig, "hold_applied")).toHaveLength(0);
    expect(audit(rig, "pause_scheduled").map((r) => r.subject_table).sort()).toEqual(["api_accounts", "subscriptions", "watches"]);
    expect(audit(rig, "pause_scheduled")[0].detail).toMatchObject({ effective_from: iso(rig.T0 + PERIOD), basis: "subscription_period_end" });
    expect((await lookupEntitlement("i@hall.example")).entitlement?.role).toBe("owner");
    const { POST } = await import("@/app/api/keys/route");
    const minted = await POST(post("/api/keys", { token: a.token, rotate: true }));
    expect(minted.status).toBe(200); // the paid period is the customer's: a new key can be minted
    expect((await minted.json()).issued).toBe(true);
  });

  it("the same pause event delivered again is a no-op: one schedule, one audit row per row", async () => {
    all();
    for (let n = 0; n < 3; n++) for (const s of SUBS) expect((await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5, id: `evt_p_${s}` })).status).toBe(200);
    expect(audit(rig, "pause_scheduled")).toHaveLength(3);
  });
});

describe("2. when the paid period is over the access checks stop access without waiting for the daily job", () => {
  it("Intelligence is not entitled and no key is minted from that instant; the instant before, both are", async () => {
    const { a } = all();
    for (const s of SUBS) await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 });
    at(rig.T0 + PERIOD - 1);
    expect((await lookupEntitlement("i@hall.example")).entitlement).not.toBeNull();
    const { POST: before } = await import("@/app/api/keys/route");
    expect(((await (await before(post("/api/keys", { token: a.token, rotate: true }))).json()) as { issued?: boolean }).issued).toBe(true);
    at(rig.T0 + PERIOD);
    expect(await lookupEntitlement("i@hall.example")).toEqual({ reachable: true, entitlement: null });
    const { POST } = await import("@/app/api/keys/route");
    const r = await POST(post("/api/keys", { token: a.token, rotate: true }));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/paused/i);
    expect(a.key_id).not.toBeNull(); // refusing to mint is not the job's revocation
  });
});

describe("3. the daily job turns a due pause into the hold: once, audited, with the effective time recorded", () => {
  it("API key revoked (recorded, then confirmed), Hall Watch paused, Intelligence suspended; a second run changes nothing", async () => {
    const { a, w, i } = all();
    for (const s of SUBS) await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 });
    stripePaused(...SUBS);
    at(rig.T0 + PERIOD - 60);
    expect(await runDue()).toMatchObject({ due: 0, promoted: 0 }); // not yet
    expect(a.status).toBe("active");
    at(rig.T0 + PERIOD + 60);
    expect(await runDue()).toMatchObject({ due: 3, promoted: 3, errors: 0 });
    expect(a).toMatchObject({ status: "past_due", key_id: null, billing_hold: "paused", billing_hold_prev_status: "active", billing_hold_at: iso(rig.T0 + PERIOD), billing_pause_from: null });
    expect(a.revoked_confirmed_ids).toEqual(["keyLIVE1"]);
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused", billing_hold_at: iso(rig.T0 + PERIOD), billing_pause_from: null });
    expect(i).toMatchObject({ status: "suspended", billing_hold: "paused", billing_hold_at: iso(rig.T0 + PERIOD), billing_pause_from: null });
    expect(revokeCalls(rig)).toEqual(["keyLIVE1"]);
    expect(audit(rig, "hold_applied")).toHaveLength(3);
    expect(audit(rig, "hold_applied")[0].detail).toMatchObject({ kind: "paused", effective_from: iso(rig.T0 + PERIOD) });
    expect(await runDue()).toMatchObject({ due: 0 });
    expect(revokeCalls(rig)).toEqual(["keyLIVE1"]);
    expect(audit(rig, "hold_applied")).toHaveLength(3);
    // the pause/resume clock is untouched by the job (it is the clock of EVENTS)
    expect(a.billing_pause_event_ts).toBe(rig.T0 + 5);
  });

  it("the GET /api/cron/payg route runs it and says so in its report", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePaused("sub_api");
    at(rig.T0 + PERIOD + 3600);
    const { GET } = await import("@/app/api/cron/payg/route");
    const res = await GET(new Request(siteUrl("/api/cron/payg"), { headers: { authorization: "Bearer cron-secret-value" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).pauses).toMatchObject({ due: 1, promoted: 1 });
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due" });
  });
});

describe("4. resumed before the period ends: no interruption at all", () => {
  it("the schedule is cancelled and recorded; when the period ends nothing is suspended", async () => {
    const { a, w, i } = all();
    for (const s of SUBS) await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 });
    for (const s of SUBS) expect((await send(rig, "customer.subscription.updated", sub(s), { created: rig.T0 + 100 })).status).toBe(200);
    for (const r of [a, w, i]) expect(r).toMatchObject({ billing_pause_from: null, billing_hold: null, billing_pause_event_ts: rig.T0 + 100 });
    expect(audit(rig, "pause_schedule_cleared")).toHaveLength(3);
    at(rig.T0 + PERIOD + DAY);
    expect(await runDue()).toMatchObject({ due: 0 });
    expect([a.status, w.status, i.status]).toEqual(["active", "active", "active"]);
    expect(a.key_id).toBe("keyLIVE1");
    expect(revokeCalls(rig)).toEqual([]);
    expect((await lookupEntitlement("i@hall.example")).entitlement).not.toBeNull();
  });
});

describe("5. pause then cancellation: the cancellation wins and nothing is ever revived", () => {
  it("a scheduled pause that outlives a cancelled subscription never becomes a hold, and a pause delivered after the cancellation is ignored", async () => {
    const { a, w, i } = all();
    for (const s of SUBS) await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 });
    for (const s of SUBS) expect((await send(rig, "customer.subscription.deleted", sub(s, { status: "canceled" }), { created: rig.T0 + 50 })).status).toBe(200);
    expect([a.status, w.status, i.status]).toEqual(["cancelled", "cancelled", "cancelled"]);
    stripePaused(...SUBS);
    at(rig.T0 + PERIOD + DAY);
    expect(await runDue()).toMatchObject({ due: 0, promoted: 0 });
    for (const s of SUBS) expect((await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 60 })).status).toBe(200);
    expect(await runDue()).toMatchObject({ due: 0 });
    expect([a.status, w.status, i.status]).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(audit(rig, "hold_applied")).toHaveLength(0);
    expect(a.billing_hold ?? null).toBeNull();
  });

  it("cancelled in the instant between the job's read and its write: the guarded write refuses and the row stays cancelled", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePaused("sub_api");
    at(rig.T0 + PERIOD + 60);
    // the job reads the row, Stripe is asked, and THEN the cancellation lands
    const orig = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => {
      const out = await orig(id);
      a.status = "cancelled";
      return out;
    };
    expect(await runDue()).toMatchObject({ due: 1, errors: 0 });
    expect(a.status).toBe("cancelled");
    expect(a.billing_hold ?? null).toBeNull();
    expect(a.billing_pause_from).not.toBeNull(); // untouched: nothing was written to a cancelled row
  });
});

describe("6. a pause whose paid period is already over starts at once", () => {
  it("pause at (or after) the period end: immediate hold, recorded as such", async () => {
    const { a, w, i } = all();
    for (const s of SUBS) expect((await send(rig, "customer.subscription.updated", paused(s, { current_period_end: rig.T0 - 100 }), { created: rig.T0 + 5 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", key_id: null, billing_hold: "paused" });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
    expect(i).toMatchObject({ status: "suspended", billing_hold: "paused" });
    expect(audit(rig, "pause_immediate")[0].detail).toMatchObject({ why: "paid_period_over" });
    expect(a.billing_pause_from ?? null).toBeNull();
  });

  it("Stripe's own status paused (no pause_collection) and an event with no period anywhere are immediate too", async () => {
    const { w, i } = all();
    await send(rig, "customer.subscription.updated", sub("sub_w", { status: "paused" }), { created: rig.T0 + 5 });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
    await send(rig, "customer.subscription.updated", paused("sub_i", { current_period_end: undefined, current_period_start: undefined }), { created: rig.T0 + 5 });
    expect(i).toMatchObject({ status: "suspended", billing_hold: "paused" });
    expect(audit(rig, "pause_immediate").map((r) => (r.detail as any).why).sort()).toEqual(["no_paid_period_known", "status_paused"]);
  });

  it("a row that is not in good standing (past_due) has no paid period to wait for: immediate, and what it was before is remembered", async () => {
    const { i } = all();
    i.status = "past_due";
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
    expect(i).toMatchObject({ status: "suspended", billing_hold: "paused", billing_hold_prev_status: "past_due" });
  });

  it("newer API versions carry the period on the items, not on the subscription", async () => {
    const { w } = all();
    const items = { data: [{ current_period_start: rig.T0 - 20 * DAY, current_period_end: rig.T0 + PERIOD }] };
    await send(rig, "customer.subscription.updated", paused("sub_w", { current_period_end: undefined, current_period_start: undefined, items }), { created: rig.T0 + 5 });
    expect(w).toMatchObject({ status: "active", billing_pause_from: iso(rig.T0 + PERIOD) });
  });

  it("the period end is read from Stripe when the event does not carry it", async () => {
    const { w } = all();
    rig.stripe.setSubscription("sub_w", { current_period_end: rig.T0 + PERIOD, current_period_start: rig.T0 - 20 * DAY });
    await send(rig, "customer.subscription.updated", paused("sub_w", { current_period_end: undefined, current_period_start: undefined }), { created: rig.T0 + 5 });
    expect(w).toMatchObject({ status: "active", billing_pause_from: iso(rig.T0 + PERIOD) });
  });

  it("a Stripe lookup that fails answers 500 (retried) and schedules nothing", async () => {
    const { w } = all();
    rig.stripe.failOnce.add("subscriptions.retrieve");
    const ev = paused("sub_w", { current_period_end: undefined, current_period_start: undefined });
    expect((await send(rig, "customer.subscription.updated", ev, { created: rig.T0 + 5, id: "evt_retry" })).status).toBe(500);
    expect(w.billing_pause_from ?? null).toBeNull();
    rig.stripe.setSubscription("sub_w", { current_period_end: rig.T0 + PERIOD });
    expect((await send(rig, "customer.subscription.updated", ev, { created: rig.T0 + 5, id: "evt_retry" })).status).toBe(200);
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
  });
});

describe("7. renewal while paused: no new paid invoice, so the access stays held after the period", () => {
  it("a renewal update that moves the period (voided invoice) neither extends the schedule nor ends the hold", async () => {
    const { a, w } = all();
    for (const s of ["sub_api", "sub_w"]) await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 });
    stripePaused("sub_api", "sub_w");
    // the renewal: the period moves a month, the new invoice was voided because collection is paused
    rig.stripe.addInvoice("in_renewal_api", "sub_api", { status: "void", amount_paid: 0 });
    rig.stripe.addInvoice("in_renewal_w", "sub_w", { status: "void", amount_paid: 0 });
    at(rig.T0 + PERIOD + 30);
    const renewed = (id: string, inv: string) => paused(id, { current_period_start: rig.T0 + PERIOD, current_period_end: rig.T0 + PERIOD + 30 * DAY, latest_invoice: inv });
    // delivered BEFORE the daily job has run
    await send(rig, "customer.subscription.updated", renewed("sub_api", "in_renewal_api"), { created: rig.T0 + PERIOD + 10 });
    await send(rig, "customer.subscription.updated", renewed("sub_w", "in_renewal_w"), { created: rig.T0 + PERIOD + 10 });
    expect(a.billing_pause_from).toBe(iso(rig.T0 + PERIOD)); // not pushed a month later
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    await runDue();
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due" });
    // and again AFTER the hold, and a month later: still held
    at(rig.T0 + PERIOD + 31 * DAY);
    await send(rig, "customer.subscription.updated", renewed("sub_api", "in_renewal_api"), { created: rig.T0 + PERIOD + 20 });
    expect(await runDue()).toMatchObject({ due: 0 });
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due", key_id: null });
    expect(w).toMatchObject({ billing_hold: "paused", status: "paused" });
  });

  it("a later update that carries a LATER period end (and an invoice Stripe cannot confirm either way) never pushes a pause that is already scheduled a month out", async () => {
    const { w } = all();
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    await send(rig, "customer.subscription.updated", paused("sub_w", { current_period_start: rig.T0 + PERIOD, current_period_end: rig.T0 + PERIOD + 30 * DAY }), { created: rig.T0 + 6 });
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD)); // only a PAYMENT moves it
    expect(w.billing_pause_event_ts).toBe(rig.T0 + 6);
  });

  it("even a renewal whose invoice is unknown to the event is not read as a paid month: the unpaid latest invoice means 'paid until the period began'", async () => {
    const { w } = all();
    rig.stripe.addInvoice("in_open", "sub_w", { status: "open", amount_paid: 0 });
    await send(rig, "customer.subscription.updated", paused("sub_w", { current_period_start: rig.T0 - DAY, current_period_end: rig.T0 + 29 * DAY, latest_invoice: "in_open" }), { created: rig.T0 + 5 });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
    expect(audit(rig, "pause_immediate")[0].detail).toMatchObject({ why: "paid_period_over" });
  });
});

describe("8. duplicate and out-of-order pause and resume events (the pause clock)", () => {
  it("a resume delivered BEFORE the pause it follows makes the late pause stale: nothing is scheduled", async () => {
    const { w } = all();
    await send(rig, "customer.subscription.updated", sub("sub_w"), { created: rig.T0 + 200 }); // resume (200) first
    expect(w.billing_pause_event_ts).toBe(rig.T0 + 200);
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 100 }); // the pause (100), late
    expect(w).toMatchObject({ status: "active", billing_hold: null });
    expect(w.billing_pause_from ?? null).toBeNull();
    // a genuinely newer pause still applies, and a late resume (250) cannot undo it
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 300 });
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    await send(rig, "customer.subscription.updated", sub("sub_w"), { created: rig.T0 + 250 });
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
  });

  it("the same for a hold that has begun: a late resume does not lift it, a newer one does", async () => {
    const { w } = all();
    await send(rig, "customer.subscription.updated", paused("sub_w", { current_period_end: rig.T0 - 10 }), { created: rig.T0 + 300 });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
    await send(rig, "customer.subscription.updated", sub("sub_w"), { created: rig.T0 + 250 });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
    await send(rig, "customer.subscription.updated", sub("sub_w"), { created: rig.T0 + 400 });
    expect(w).toMatchObject({ status: "active", billing_hold: null });
  });

  it("repeated cycles are each on record; a redelivered event records nothing twice", async () => {
    all();
    let t = rig.T0;
    for (let cycle = 0; cycle < 2; cycle++) {
      t += 100;
      for (let n = 0; n < 2; n++) await send(rig, "customer.subscription.updated", paused("sub_w"), { created: t, id: `evt_pause_${cycle}` });
      t += 100;
      for (let n = 0; n < 2; n++) await send(rig, "customer.subscription.updated", sub("sub_w"), { created: t, id: `evt_resume_${cycle}` });
    }
    expect(audit(rig, "pause_scheduled")).toHaveLength(2);
    expect(audit(rig, "pause_schedule_cleared")).toHaveLength(2);
  });

  it("the pause clock does not order PAYMENT events: a payment failure older than a pause is still applied", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 200 });
    await send(rig, "invoice.payment_failed", { id: "in_f", object: "invoice", subscription: "sub_api" }, { created: rig.T0 + 150 });
    expect(a.status).toBe("past_due"); // before: the pause had advanced last_billing_event_ts to 200 and this failure was called stale
    expect(a.last_billing_event_ts).toBe(rig.T0 + 150);
    expect(a.billing_pause_event_ts).toBe(rig.T0 + 200);
  });

  it("and a resume does not make a payment older than it stale: failed, resume, then the payment that cleared it", async () => {
    const { a } = all();
    await send(rig, "invoice.payment_failed", { id: "in_f", object: "invoice", subscription: "sub_api" }, { created: rig.T0 + 100 });
    expect(a.status).toBe("past_due");
    await send(rig, "customer.subscription.updated", sub("sub_api"), { created: rig.T0 + 200 }); // a resume (or any update): clock 200
    await send(rig, "invoice.paid", { id: "in_ok", object: "invoice", subscription: "sub_api", amount_paid: 90_000 }, { created: rig.T0 + 150 });
    expect(a.status).toBe("active");
  });
});

describe("9. pause_collection.resumes_at", () => {
  it("billing resumes BEFORE the paid period ends: no interruption, nothing scheduled, on record", async () => {
    const { a, w } = all();
    for (const s of ["sub_api", "sub_w"]) await send(rig, "customer.subscription.updated", paused(s, {}, { resumes_at: rig.T0 + 5 * DAY }), { created: rig.T0 + 5 });
    expect(a.billing_pause_from ?? null).toBeNull();
    expect(w.billing_pause_from ?? null).toBeNull();
    expect(audit(rig, "pause_no_interruption")).toHaveLength(2);
    expect(audit(rig, "pause_no_interruption")[0].detail).toMatchObject({ paid_period_ends: iso(rig.T0 + PERIOD), resumes_at: iso(rig.T0 + 5 * DAY) });
    stripePaused("sub_api", "sub_w");
    at(rig.T0 + PERIOD + DAY);
    expect(await runDue()).toMatchObject({ due: 0 });
    expect([a.status, w.status]).toEqual(["active", "active"]);
  });

  it("billing resumes AFTER the paid period ends: the hold starts at the period end and the resume lifts it", async () => {
    const { a } = all();
    const resumes = rig.T0 + 20 * DAY;
    await send(rig, "customer.subscription.updated", paused("sub_api", {}, { resumes_at: resumes }), { created: rig.T0 + 5 });
    expect(a).toMatchObject({ billing_pause_from: iso(rig.T0 + PERIOD), billing_pause_resumes_at: iso(resumes), status: "active" });
    stripePaused("sub_api");
    at(rig.T0 + PERIOD + 60);
    await runDue();
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due" });
    at(resumes);
    await send(rig, "customer.subscription.updated", sub("sub_api", { current_period_end: rig.T0 + 40 * DAY }), { created: resumes });
    expect(a).toMatchObject({ billing_hold: null, status: "active", billing_pause_from: null, billing_pause_resumes_at: null });
    expect(a.key_id).toBeNull(); // the revoked key stays revoked
    expect(audit(rig, "hold_lifted")).toHaveLength(1);
  });
});

describe("10. resume after the period end restores everything exactly as it was", () => {
  it("each row goes back to what it was before the hold; the API key stays revoked and minting reopens", async () => {
    const { a, w, i } = all();
    i.status = "active";
    for (const s of SUBS) await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 });
    stripePaused(...SUBS);
    at(rig.T0 + PERIOD + 60);
    await runDue();
    for (const s of SUBS) expect((await send(rig, "customer.subscription.updated", sub(s), { created: rig.T0 + PERIOD + 600 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", billing_hold: null, key_id: null, billing_pause_from: null });
    expect(w).toMatchObject({ status: "active", billing_hold: null });
    expect(i).toMatchObject({ status: "active", billing_hold: null });
    expect(audit(rig, "hold_lifted")).toHaveLength(3);
    const { POST } = await import("@/app/api/keys/route");
    expect((await POST(post("/api/keys", { token: a.token }))).status).toBe(200);
  });
});

describe("11. a payment for a later period moves the pause (never earlier)", () => {
  const paidFor = (end: number, over: Record<string, unknown> = {}) => ({ id: "in_next", object: "invoice", subscription: "sub_w", amount_paid: 90_000, lines: { data: [{ period: { start: rig.T0 + PERIOD, end } }] }, ...over });
  it("a paid invoice covering a later period moves the start; an older one, an equal one and a payment of nothing do not", async () => {
    const { w } = all();
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    await send(rig, "invoice.paid", paidFor(rig.T0 + PERIOD - DAY, { id: "in_old" }), { created: rig.T0 + 20 });
    await send(rig, "invoice.paid", paidFor(rig.T0 + PERIOD, { id: "in_eq" }), { created: rig.T0 + 21 });
    await send(rig, "invoice.paid", paidFor(rig.T0 + PERIOD + 30 * DAY, { id: "in_zero", amount_paid: 0 }), { created: rig.T0 + 22 });
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    await send(rig, "invoice.paid", paidFor(rig.T0 + PERIOD + 30 * DAY), { created: rig.T0 + 23 });
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD + 30 * DAY));
    expect(audit(rig, "pause_schedule_extended")).toHaveLength(1);
    // redelivered: the same
    await send(rig, "invoice.paid", paidFor(rig.T0 + PERIOD + 30 * DAY), { created: rig.T0 + 23, id: "evt_dup" });
    expect(w.billing_pause_from).toBe(iso(rig.T0 + PERIOD + 30 * DAY));
  });

  it("a longer paid period that contains the resume date means the pause interrupts nothing", async () => {
    const { w } = all();
    await send(rig, "customer.subscription.updated", paused("sub_w", {}, { resumes_at: rig.T0 + 20 * DAY }), { created: rig.T0 + 5 });
    expect(w.billing_pause_from).not.toBeNull();
    await send(rig, "invoice.paid", paidFor(rig.T0 + 40 * DAY), { created: rig.T0 + 23 });
    expect(w.billing_pause_from).toBeNull();
    expect(audit(rig, "pause_schedule_cleared")).toHaveLength(1);
  });
});

describe("12. the daily job asks Stripe before it suspends anybody", () => {
  it("billing running again at Stripe (the resume event never arrived): the schedule is dropped and nothing is suspended", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    rig.stripe.setSubscription("sub_api", { status: "active", pause_collection: null });
    at(rig.T0 + PERIOD + 60);
    expect(await runDue()).toMatchObject({ due: 1, dropped: 1, promoted: 0 });
    expect(a).toMatchObject({ status: "active", billing_hold: null, key_id: "keyLIVE1", billing_pause_from: null });
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(1);
  });

  it("Stripe unreachable: nothing is suspended on a guess; the next run applies it", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePaused("sub_api");
    at(rig.T0 + PERIOD + 60);
    rig.stripe.failOnce.add("subscriptions.retrieve");
    expect(await runDue()).toMatchObject({ due: 1, errors: 1, promoted: 0 });
    expect(a).toMatchObject({ status: "active", billing_hold: null });
    expect(await runDue()).toMatchObject({ due: 1, promoted: 1, errors: 0 });
    expect(a).toMatchObject({ billing_hold: "paused" });
  });

  it("a write that fails is retried by the next run (idempotent: one revocation, one audit row)", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePaused("sub_api");
    at(rig.T0 + PERIOD + 60);
    rig.db.failMethod = { method: "PATCH", status: 503, body: JSON.stringify({ message: "outage" }) };
    expect((await runDue()).errors).toBe(1);
    rig.db.failMethod = null;
    expect(await runDue()).toMatchObject({ promoted: 1 });
    expect(revokeCalls(rig)).toEqual(["keyLIVE1"]);
    expect(audit(rig, "hold_applied")).toHaveLength(1);
    expect(a.billing_pause_from).toBeNull();
  });

  it("a stronger hold that is already standing (a refund) is not replaced AND the pause is not forgotten: the schedule is KEPT", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "charge.refunded", { id: "ch_1", object: "charge", amount: 90_000, amount_refunded: 90_000, refunded: true, payment_intent: "pi_1" }, { created: rig.T0 + 30 });
    expect(a).toMatchObject({ billing_hold: "refunded", status: "past_due" });
    stripePaused("sub_api");
    at(rig.T0 + PERIOD + 60);
    expect(await runDue()).toMatchObject({ due: 1, deferred: 1, promoted: 0 });
    expect(a).toMatchObject({ billing_hold: "refunded", billing_pause_from: iso(rig.T0 + PERIOD) }); // before: cleared, the pause was lost
  });
});

describe("13. migration 0043 not applied yet", () => {
  it("the pause cannot be scheduled, so it is applied as before (immediately), the operator is told once, and no event is refused", async () => {
    const { a, w } = all();
    for (const t of ["api_accounts", "watches", "subscriptions"]) rig.db.missingColumns.set(t, new Set(["billing_pause_from", "billing_pause_resumes_at", "billing_pause_event_ts"]));
    for (const s of ["sub_api", "sub_w"]) expect((await send(rig, "customer.subscription.updated", paused(s), { created: rig.T0 + 5 })).status).toBe(200);
    expect(a).toMatchObject({ status: "past_due", billing_hold: "paused" });
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
    expect(operatorMail(rig).filter((m) => /0043/.test(m.subject))).toHaveLength(1);
    // the resume still works (the columns it would clear do not exist: nothing to clear)
    for (const s of ["sub_api", "sub_w"]) expect((await send(rig, "customer.subscription.updated", sub(s), { created: rig.T0 + 100 })).status).toBe(200);
    expect(a).toMatchObject({ status: "active", billing_hold: null });
    // and the daily job reports why it did nothing
    expect((await runDue()).skippedReason).toMatch(/0043/);
  });
});

// ============================================================================================================================
// Hall Watch: a note already due before the pause starts still delivers; none after
// ============================================================================================================================
describe("14. Hall Watch around the instant its pause starts", () => {
  const ENGINE = "https://engine.test";
  let restoreDiff: () => void;
  let diffCalls = 0;
  beforeEach(() => {
    diffCalls = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      if (url === `${ENGINE}/v1/diff`) {
        diffCalls++;
        return new Response(JSON.stringify({ headline: "Racks moved", material: false, racks_delta: 0, weeks_delta: 0, binding_moved: false, after: { racks: 41 }, document: "<p>n</p>" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return inner(i as RequestInfo, init);
    }) as typeof fetch;
    restoreDiff = () => { globalThis.fetch = inner; };
  });
  afterEach(() => restoreDiff());
  const cron = async () => (await import("@/app/api/cron/watches/route")).GET(new Request(siteUrl("/api/cron/watches"), { headers: { authorization: "Bearer cron-secret-value" } }));
  const notes = () => rig.db.rows("watch_notes");

  it("a note that fell due BEFORE the pause starts is delivered by the cron even after that instant; then the pause is written", async () => {
    const w = watchRow(rig, { next_run_at: iso(rig.T0 + 8 * DAY) });
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    stripePaused("sub_w");
    at(rig.T0 + PERIOD + 3600); // the weekly cron is late: the note was due at day 8, the pause starts at day 10
    expect(await runDue()).toMatchObject({ due: 1, deferred: 1, promoted: 0 }); // the daily job leaves it for the cron
    expect(w.status).toBe("active");
    const res = await cron();
    expect((await res.json()).results.map((r: any) => r.status)).toEqual(["no_change"]);
    expect(diffCalls).toBeGreaterThan(0);
    expect(notes()).toHaveLength(1);
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused", billing_pause_from: null, billing_hold_at: iso(rig.T0 + PERIOD) });
    expect(audit(rig, "hold_applied")).toHaveLength(1);
    // and the next cron delivers nothing more
    diffCalls = 0;
    await cron();
    expect(diffCalls).toBe(0);
    expect(notes()).toHaveLength(1);
  });

  it("a note that falls due AFTER the pause starts is not delivered: the daily job pauses the watch", async () => {
    const w = watchRow(rig, { next_run_at: iso(rig.T0 + 11 * DAY) });
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    stripePaused("sub_w");
    at(rig.T0 + 12 * DAY);
    expect(await runDue()).toMatchObject({ promoted: 1 });
    expect(w.status).toBe("paused");
    await cron();
    expect(diffCalls).toBe(0);
    expect(notes()).toHaveLength(0);
  });

  it("the Hall Watch cron itself refuses a note due after the pause started, even if the daily job has not run (and pauses the watch)", async () => {
    const w = watchRow(rig, { next_run_at: iso(rig.T0 + 11 * DAY) });
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    stripePaused("sub_w");
    at(rig.T0 + 12 * DAY);
    const res = await cron();
    expect((await res.json()).results.map((r: any) => r.status)).toEqual(["skipped_pause_started"]);
    expect(diffCalls).toBe(0);
    expect(w).toMatchObject({ status: "paused", billing_hold: "paused" });
  });

  it("before the instant, the same watch is run as always", async () => {
    watchRow(rig, { next_run_at: iso(rig.T0 + 8 * DAY) });
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    at(rig.T0 + 9 * DAY);
    const res = await cron();
    expect((await res.json()).results.map((r: any) => r.status)).toEqual(["no_change"]);
    expect(notes()).toHaveLength(1);
  });

  it("a watch that owes a note for longer than the cron's own cadence is not held up for ever: after the grace the daily job pauses it", async () => {
    const w = watchRow(rig, { next_run_at: iso(rig.T0 + 8 * DAY) });
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    stripePaused("sub_w");
    at(rig.T0 + PERIOD + 9 * DAY);
    expect(await runDue()).toMatchObject({ promoted: 1, deferred: 0 });
    expect(w.status).toBe("paused");
  });
});

// ============================================================================================================================
// Review round: one billing_hold column carries one hold, so a stronger hold REPLACES a pause; the pause must survive it
// ============================================================================================================================
/** Stripe's current state of a paused subscription whose paid period ended `endsIn` seconds from T0. */
const stripePausedUntil = (endsIn: number, ...ids: string[]) => {
  for (const id of ids) rig.stripe.setSubscription(id, { status: "active", pause_collection: { behavior: "void" }, current_period_start: rig.T0 - 20 * DAY, current_period_end: rig.T0 + endsIn });
};
const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", amount: 90_000, currency: "eur", charge: "ch_1", reason: "fraudulent", status: "needs_response", ...over });
const refundOf = (id = "ch_1", pi = "pi_1") => ({ id, object: "charge", amount: 90_000, amount_refunded: 90_000, refunded: true, payment_intent: pi, currency: "eur" });

describe("15. a pause survives a stronger hold that replaces it", () => {
  it("pause comes due (paused hold), the customer DISPUTES the charge, the dispute is WON: the pause is put back, access does not return unpaid", async () => {
    const { a, w, i } = all();
    for (const [c, pi, inv, sb] of [["ch_1", "pi_1", "in_1", "sub_api"], ["ch_w", "pi_w", "in_w", "sub_w"], ["ch_i", "pi_i", "in_i", "sub_i"]]) rig.stripe.link(c, pi, inv, sb);
    for (const sb of SUBS) await send(rig, "customer.subscription.updated", paused(sb), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, ...SUBS);
    at(rig.T0 + PERIOD + 60);
    await runDue();
    expect([a.billing_hold, w.billing_hold, i.billing_hold]).toEqual(["paused", "paused", "paused"]);
    for (const [id, ch] of [["dp_1", "ch_1"], ["dp_w", "ch_w"], ["dp_i", "ch_i"]]) await send(rig, "charge.dispute.created", dispute({ id, charge: ch }), { created: rig.T0 + PERIOD + 100 });
    expect([a.billing_hold, w.billing_hold, i.billing_hold]).toEqual(["disputed", "disputed", "disputed"]); // the stronger hold REPLACED the pause
    for (const [id, ch] of [["dp_1", "ch_1"], ["dp_w", "ch_w"], ["dp_i", "ch_i"]]) {
      rig.stripe.pinDispute(id, dispute({ id, charge: ch, status: "won" }));
      expect((await send(rig, "charge.dispute.closed", dispute({ id, charge: ch, status: "won" }), { created: rig.T0 + PERIOD + 200 })).status).toBe(200);
    }
    // Stripe still has the pause: the row goes back to PAUSED, not to active
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due", key_id: null });
    expect(w).toMatchObject({ billing_hold: "paused", status: "paused" });
    expect(i).toMatchObject({ billing_hold: "paused", status: "suspended" });
    expect((await lookupEntitlement("i@hall.example")).entitlement).toBeNull();
    expect(audit(rig, "pause_reasserted")).toHaveLength(3);
    // and the resume then ends it, to what the rows were before the pause
    for (const sb of SUBS) {
      rig.stripe.setSubscription(sb, { status: "active", pause_collection: null });
      await send(rig, "customer.subscription.updated", sub(sb), { created: rig.T0 + PERIOD + 900 });
    }
    expect([a.status, w.status, i.status]).toEqual(["active", "active", "active"]);
    expect([a.billing_hold, w.billing_hold, i.billing_hold]).toEqual([null, null, null]);
  });

  it("pause comes due, a refund replaces it, a LATER PAYMENT lifts the refund: billing is still paused at Stripe, so the pause is rescheduled for the period just paid", async () => {
    const { a } = all();
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_api");
    at(rig.T0 + PERIOD + 60);
    await runDue();
    expect(a.billing_hold).toBe("paused");
    await send(rig, "charge.refunded", refundOf(), { created: rig.T0 + PERIOD + 100 });
    expect(a).toMatchObject({ billing_hold: "refunded", billing_hold_prev_status: "active" });
    // the customer pays a new invoice (another period): it lifts the refund; Stripe says billing is still paused
    const NEXT_END = rig.T0 + PERIOD + 30 * DAY;
    rig.stripe.setSubscription("sub_api", { status: "active", pause_collection: { behavior: "void" }, current_period_start: rig.T0 + PERIOD, current_period_end: NEXT_END });
    rig.stripe.addInvoice("in_2", "sub_api");
    at(rig.T0 + PERIOD + 200);
    await send(rig, "invoice.paid", { id: "in_2", object: "invoice", subscription: "sub_api", amount_paid: 90_000 }, { created: rig.T0 + PERIOD + 200 });
    expect(a).toMatchObject({ billing_hold: null, status: "active", billing_pause_from: iso(NEXT_END) }); // paid through NEXT_END, then the pause begins
    expect(audit(rig, "pause_reasserted")).toHaveLength(1);
    // the same payment when the period it paid is already over: the hold itself comes back
    const b = apiAcct(rig, { account: "scale-2", token: "tok-scale2-0123456789abcdefghij", stripe_subscription_id: "sub_api2", key_id: "keyLIVE2", status: "past_due", billing_hold: "refunded", billing_hold_ref: "ch_9", billing_hold_invoice: "in_9", billing_hold_prev_status: "active", billing_hold_at: new Date().toISOString() });
    rig.stripe.setSubscription("sub_api2", { status: "active", pause_collection: { behavior: "void" }, current_period_start: rig.T0 - 20 * DAY, current_period_end: rig.T0 - 10 });
    rig.stripe.addInvoice("in_3", "sub_api2");
    await send(rig, "invoice.paid", { id: "in_3", object: "invoice", subscription: "sub_api2", amount_paid: 90_000 }, { created: rig.T0 + PERIOD + 300 });
    expect(b).toMatchObject({ billing_hold: "paused", status: "past_due", key_id: null });
  });

  it("a dispute is open when the pause arrives: the pause is recorded with ITS OWN start (the end of the paid period), and winning mid-period does not take the paid days away", async () => {
    const { a, i } = all();
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    rig.stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    at(rig.T0 + 1 * DAY);
    await send(rig, "charge.dispute.created", dispute(), { created: rig.T0 + 1 * DAY });
    await send(rig, "charge.dispute.created", dispute({ id: "dp_i", charge: "ch_i" }), { created: rig.T0 + 1 * DAY });
    expect(a.billing_hold).toBe("disputed");
    at(rig.T0 + 2 * DAY); // the customer pauses the next day: the paid period still has days to run
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 2 * DAY });
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 2 * DAY });
    expect(a).toMatchObject({ billing_hold: "disputed", billing_pause_event_ts: rig.T0 + 2 * DAY });
    expect(a.billing_pause_from).toBe(iso(rig.T0 + PERIOD)); // before: "now", which made the pause due the moment the dispute ended
    expect(i.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    // the dispute is WON on day 5 of the remaining 10: the rows go back to what they were, with the pause still to come
    stripePausedUntil(PERIOD, "sub_api", "sub_i");
    at(rig.T0 + 5 * DAY);
    rig.stripe.pinDispute("dp_1", dispute({ status: "won" }));
    rig.stripe.pinDispute("dp_i", dispute({ id: "dp_i", charge: "ch_i", status: "won" }));
    await send(rig, "charge.dispute.closed", dispute({ status: "won" }), { created: rig.T0 + 5 * DAY });
    await send(rig, "charge.dispute.closed", dispute({ id: "dp_i", charge: "ch_i", status: "won" }), { created: rig.T0 + 5 * DAY });
    expect(a).toMatchObject({ billing_hold: null, status: "active", billing_pause_from: iso(rig.T0 + PERIOD) });
    expect(i).toMatchObject({ billing_hold: null, status: "active", billing_pause_from: iso(rig.T0 + PERIOD) });
    expect((await lookupEntitlement("i@hall.example")).entitlement).not.toBeNull(); // paid days kept
    expect(await runDue()).toMatchObject({ due: 0 });
    // ... and access ends at the period end, not before
    at(rig.T0 + PERIOD + 60);
    expect((await lookupEntitlement("i@hall.example")).entitlement).toBeNull();
    expect(await runDue()).toMatchObject({ promoted: 2 });
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due" });
  });

  it("the daily job keeps the pause's own start under a stronger hold too (a day-6 pause is not due on day 7)", async () => {
    const { a } = all();
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "charge.dispute.created", dispute(), { created: rig.T0 + 5 });
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 10 });
    stripePausedUntil(PERIOD, "sub_api");
    at(rig.T0 + 3 * DAY);
    expect(await runDue()).toMatchObject({ due: 0 });
    expect(a.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    at(rig.T0 + PERIOD + 60);
    expect(await runDue()).toMatchObject({ deferred: 1, promoted: 0 });
    expect(a).toMatchObject({ billing_hold: "disputed" });
    expect(a.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    rig.stripe.pinDispute("dp_1", dispute({ status: "won" }));
    await send(rig, "charge.dispute.closed", dispute({ status: "won" }), { created: rig.T0 + PERIOD + 100 });
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due" });
  });

  it("a dispute is open, the pause arrives AND ends before it is won: nothing is held afterwards", async () => {
    const { a } = all();
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "charge.dispute.created", dispute(), { created: rig.T0 + 5 });
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 10 });
    rig.stripe.setSubscription("sub_api", { status: "active", pause_collection: null });
    await send(rig, "customer.subscription.updated", sub("sub_api"), { created: rig.T0 + 20 }); // resumed during the dispute
    expect(a.billing_pause_from).toBeNull();
    expect(a.billing_hold).toBe("disputed");
    rig.stripe.pinDispute("dp_1", dispute({ status: "won" }));
    await send(rig, "charge.dispute.closed", dispute({ status: "won" }), { created: rig.T0 + 30 });
    expect(a).toMatchObject({ billing_hold: null, status: "active" });
    expect(audit(rig, "pause_reasserted")).toHaveLength(0);
  });

  it("the pause was in force, the dispute replaced it, the customer RESUMED during the dispute but Stripe's resume event was for a pause that no longer holds: won -> active", async () => {
    const { w } = all();
    rig.stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_w");
    at(rig.T0 + PERIOD + 60);
    await runDue();
    await send(rig, "charge.dispute.created", dispute({ charge: "ch_w" }), { created: rig.T0 + PERIOD + 70 });
    expect(w.billing_hold).toBe("disputed");
    rig.stripe.setSubscription("sub_w", { status: "active", pause_collection: null });
    await send(rig, "customer.subscription.updated", sub("sub_w"), { created: rig.T0 + PERIOD + 80 });
    rig.stripe.pinDispute("dp_1", dispute({ charge: "ch_w", status: "won" }));
    await send(rig, "charge.dispute.closed", dispute({ charge: "ch_w", status: "won" }), { created: rig.T0 + PERIOD + 90 });
    expect(w).toMatchObject({ billing_hold: null, status: "active" });
  });

  it("Stripe cannot be asked after the lift: the event is answered 500 (retried), and the retry puts the pause back", async () => {
    const { a } = all();
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_api");
    at(rig.T0 + PERIOD + 60);
    await runDue();
    await send(rig, "charge.dispute.created", dispute(), { created: rig.T0 + PERIOD + 70 });
    rig.stripe.pinDispute("dp_1", dispute({ status: "won" }));
    rig.stripe.failOnce.add("subscriptions.retrieve");
    expect((await send(rig, "charge.dispute.closed", dispute({ status: "won" }), { created: rig.T0 + PERIOD + 90, id: "evt_won" })).status).toBe(500);
    expect((await send(rig, "charge.dispute.closed", dispute({ status: "won" }), { created: rig.T0 + PERIOD + 90, id: "evt_won" })).status).toBe(200);
    expect(a).toMatchObject({ billing_hold: "paused" });
  });
});

describe("16. the customer-facing Hall Watch routes stop at the instant, not at the daily job", () => {
  const ENGINE = "https://engine.test";
  let diff = 0;
  let restoreDiff: () => void;
  beforeEach(() => {
    diff = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      if (url === `${ENGINE}/v1/diff`) {
        diff++;
        return new Response(JSON.stringify({ headline: "x", material: false, racks_delta: 0, weeks_delta: 0, binding_moved: false, after: {}, document: "<p>n</p>" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return inner(i as RequestInfo, init);
    }) as typeof fetch;
    restoreDiff = () => { globalThis.fetch = inner; };
  });
  afterEach(() => restoreDiff());
  const intake = {
    siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12,
    currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12,
    positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
  };
  const postIntake = async (token: string) => (await import("@/app/api/watch/[token]/route")).POST(new Request(siteUrl(`/api/watch/${token}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intake) }), { params: Promise.resolve({ token }) });

  it("a watch whose pause has started (the daily job has not run) answers 409 and spends no engine work, however often it is posted; the instant before, it is not refused", async () => {
    const w = watchRow(rig);
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    at(rig.T0 + PERIOD - 1);
    const before = await postIntake(w.token as string);
    expect(before.status, await before.clone().text()).toBe(200); // the paid period is the customer's: the engine is called
    expect(diff).toBeGreaterThan(0);
    expect(rig.db.rows("watch_notes").length).toBeGreaterThan(0);
    diff = 0;
    rig.db.rows("watch_notes").length = 0;
    at(rig.T0 + PERIOD + 1);
    for (let n = 0; n < 3; n++) {
      const res = await postIntake(w.token as string);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/paused/i);
    }
    expect(diff).toBe(0);
    expect(rig.db.rows("watch_notes")).toHaveLength(0);
  });
});

describe("17. the daily pass reports what it could not start, and no stuck row starves the others", () => {
  it("failures are mailed to the operator once a day (not left in the JSON); a canceled-at-Stripe subscription whose event never came is reported, not skipped for ever", async () => {
    all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_api");
    rig.stripe.setSubscription("sub_w", { status: "canceled" });
    at(rig.T0 + PERIOD + 60);
    rig.stripe.failOnce.add("subscriptions.retrieve");
    const r1 = await runDue();
    expect(r1.errors + r1.skipped).toBeGreaterThan(0);
    const mails = () => operatorMail(rig).filter((m) => /Scheduled billing pauses NOT started/.test(m.subject));
    expect(mails()).toHaveLength(1);
    await runDue();
    expect(mails()).toHaveLength(1); // once a day
    at(rig.T0 + PERIOD + 60 + 86_400);
    await runDue();
    expect(mails()).toHaveLength(2); // the next day, while it lasts
  });

  it("Stripe's status `unpaid` (dunning ran out, billing stopped) begins the hold instead of being skipped for ever", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    rig.stripe.setSubscription("sub_api", { status: "unpaid", pause_collection: { behavior: "void" } });
    at(rig.T0 + PERIOD + 60);
    expect(await runDue()).toMatchObject({ promoted: 1, skipped: 0 });
    expect(a).toMatchObject({ billing_hold: "paused", status: "past_due" });
  });

  it("205 stuck rows ahead of a startable one do not starve it: the least recently examined are read first and every stuck row is stamped", async () => {
    for (let n = 0; n < 205; n++) {
      apiAcct(rig, { account: `stuck-${n}`, token: `tok-stuck-${n}`.padEnd(30, "x"), stripe_subscription_id: `sub_stuck_${n}`, key_id: null, billing_pause_from: iso(rig.T0 - 10 * DAY + n) });
      rig.stripe.setSubscription(`sub_stuck_${n}`, { status: "canceled" });
    }
    const good = apiAcct(rig, { account: "good-1", token: "tok-good-0123456789abcdefghijk", stripe_subscription_id: "sub_good", key_id: null, billing_pause_from: iso(rig.T0 - DAY) });
    rig.stripe.setSubscription("sub_good", { status: "active", pause_collection: { behavior: "void" } });
    expect((await runDue()).promoted).toBe(0); // the first 200 (all stuck) fill the batch
    expect(good.billing_hold ?? null).toBeNull();
    const r2 = await runDue(); // the stamped ones go to the back: the good one is read now
    expect(r2.promoted).toBe(1);
    expect(good.billing_hold).toBe("paused");
  });
});

describe("18. a mint after the instant asks Stripe once whether billing is still paused", () => {
  it("resumed at Stripe (the resume event was lost): the stale schedule is cleared and the mint goes ahead; still paused: refused", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    at(rig.T0 + PERIOD + 60);
    const { POST } = await import("@/app/api/keys/route");
    rig.stripe.setSubscription("sub_api", { status: "active", pause_collection: { behavior: "void" } });
    expect((await POST(post("/api/keys", { token: a.token, rotate: true }))).status).toBe(409);
    expect(a.billing_pause_from).not.toBeNull();
    rig.stripe.setSubscription("sub_api", { status: "active", pause_collection: null });
    const ok = await POST(post("/api/keys", { token: a.token, rotate: true }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).issued).toBe(true);
    expect(a.billing_pause_from).toBeNull();
  });
});

// ============================================================================================================================
// Second review round
// ============================================================================================================================
describe("19. a kept schedule does not outlive the pause", () => {
  it("resumed at Stripe with the resume event lost, the stronger hold ended: the kept (due) schedule is cleared so access is not denied for a day", async () => {
    const { i, a } = all();
    rig.stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "charge.dispute.created", dispute({ id: "dp_i", charge: "ch_i" }), { created: rig.T0 + 5 });
    await send(rig, "charge.dispute.created", dispute(), { created: rig.T0 + 5 });
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 6 });
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 6 });
    expect(i.billing_pause_from).not.toBeNull();
    // the customer resumes; the resume event is never delivered
    for (const sb of ["sub_i", "sub_api"]) rig.stripe.setSubscription(sb, { status: "active", pause_collection: null });
    at(rig.T0 + PERIOD + 60);
    rig.stripe.pinDispute("dp_i", dispute({ id: "dp_i", charge: "ch_i", status: "won" }));
    rig.stripe.pinDispute("dp_1", dispute({ status: "won" }));
    await send(rig, "charge.dispute.closed", dispute({ id: "dp_i", charge: "ch_i", status: "won" }), { created: rig.T0 + PERIOD + 60 });
    await send(rig, "charge.dispute.closed", dispute({ status: "won" }), { created: rig.T0 + PERIOD + 60 });
    expect(i).toMatchObject({ billing_hold: null, status: "active", billing_pause_from: null });
    expect(a).toMatchObject({ billing_hold: null, billing_pause_from: null });
    expect((await lookupEntitlement("i@hall.example")).entitlement).not.toBeNull(); // before: denied until the daily job dropped it
    expect(audit(rig, "pause_schedule_dropped").length).toBe(2);
  });
});

describe("20. a resume that lands between the read of Stripe and the hold", () => {
  /** Stripe answers "paused" once, then the customer resumes (the resume event is processed while the hold is being written). */
  const resumeAfterFirstRead = (sb: string) => {
    const orig = (rig.stripe as any).subscriptions.retrieve;
    let first = true;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => {
      const out = await orig(id);
      if (id === sb && first) {
        first = false;
        rig.stripe.setSubscription(sb, { status: "active", pause_collection: null });
      }
      return out;
    };
  };

  it("the daily job: the hold it just wrote is lifted again, not left for ever", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_api");
    at(rig.T0 + PERIOD + 60);
    resumeAfterFirstRead("sub_api");
    const rep = await runDue();
    expect(rep).toMatchObject({ promoted: 0, dropped: 1, errors: 0 });
    expect(a).toMatchObject({ billing_hold: null, status: "active", billing_pause_from: null });
    expect(audit(rig, "hold_lifted")).toHaveLength(1);
  });

  it("after a lift (dispute won): the same", async () => {
    const { a } = all();
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_api");
    at(rig.T0 + PERIOD + 60);
    await runDue();
    await send(rig, "charge.dispute.created", dispute(), { created: rig.T0 + PERIOD + 70 });
    rig.stripe.pinDispute("dp_1", dispute({ status: "won" }));
    resumeAfterFirstRead("sub_api");
    await send(rig, "charge.dispute.closed", dispute({ status: "won" }), { created: rig.T0 + PERIOD + 80 });
    expect(a).toMatchObject({ billing_hold: null, status: "active" });
  });
});

describe("21. `unpaid` is one rule: billing is stopped", () => {
  it("a pause replaced by a dispute that is won while Stripe says `unpaid` (no pause_collection) goes back to a hold, and the job's own re-check does not undo an unpaid hold", async () => {
    const { w } = all();
    rig.stripe.link("ch_w", "pi_w", "in_w", "sub_w");
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_w");
    at(rig.T0 + PERIOD + 60);
    await runDue();
    await send(rig, "charge.dispute.created", dispute({ charge: "ch_w" }), { created: rig.T0 + PERIOD + 70 });
    rig.stripe.setSubscription("sub_w", { status: "unpaid", pause_collection: null });
    rig.stripe.pinDispute("dp_1", dispute({ charge: "ch_w", status: "won" }));
    await send(rig, "charge.dispute.closed", dispute({ charge: "ch_w", status: "won" }), { created: rig.T0 + PERIOD + 80 });
    expect(w).toMatchObject({ billing_hold: "paused", status: "paused" });
  });
});

describe("22. the daily pass without the rotation column, and when it cannot read at all", () => {
  it("a store without billing_pause_checked_at (400 on the ordering) still starts the due pauses, oldest first", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    stripePausedUntil(PERIOD, "sub_api");
    rig.db.missingColumns.set("api_accounts", new Set(["billing_pause_checked_at"]));
    at(rig.T0 + PERIOD + 60);
    expect(await runDue()).toMatchObject({ due: 1, promoted: 1, errors: 0 });
    expect(a.billing_hold).toBe("paused");
  });

  it("a store without billing_pause_from cannot be read: the report says why AND the operator is mailed, once a day", async () => {
    all();
    rig.db.missingColumns.set("api_accounts", new Set(["billing_pause_from"]));
    rig.db.missingColumns.set("watches", new Set(["billing_pause_from"]));
    rig.db.missingColumns.set("subscriptions", new Set(["billing_pause_from"]));
    expect((await runDue()).skippedReason).toMatch(/0043/);
    await runDue();
    const m = () => operatorMail(rig).filter((x) => /did NOT run/.test(x.subject));
    expect(m()).toHaveLength(1);
    at(rig.T0 + 86_400 + 5);
    await runDue();
    expect(m()).toHaveLength(2);
  });
});

describe("23. a mint that finds a due pause", () => {
  it("a pause scheduled AGAIN between the Stripe read and the write keeps its schedule, and the mint is refused", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    at(rig.T0 + PERIOD + 60);
    rig.stripe.setSubscription("sub_api", { status: "active", pause_collection: null }); // Stripe: resumed...
    const orig = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => {
      const out = await orig(id);
      a.billing_pause_from = iso(rig.T0 + PERIOD + 30 * DAY); // ...and paused again before the write
      return out;
    };
    const { POST } = await import("@/app/api/keys/route");
    expect((await POST(post("/api/keys", { token: a.token, rotate: true }))).status).toBe(409);
    expect(a.billing_pause_from).toBe(iso(rig.T0 + PERIOD + 30 * DAY));
  });

  it("a Stripe call that never answers is a refusal ('cannot say'), after the bound, not a hang", async () => {
    const { a } = all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    at(rig.T0 + PERIOD + 60);
    process.env.STRIPE_CALL_TIMEOUT_MS = "40";
    (rig.stripe as any).subscriptions.retrieve = () => new Promise(() => {});
    try {
      const { POST } = await import("@/app/api/keys/route");
      const t0 = performance.now();
      expect((await POST(post("/api/keys", { token: a.token, rotate: true }))).status).toBe(409);
      expect(performance.now() - t0).toBeLessThan(2_000);
    } finally {
      delete process.env.STRIPE_CALL_TIMEOUT_MS;
    }
    expect(a.billing_pause_from).not.toBeNull();
  });

  it("the daily job: a hanging Stripe is a failed row (retried), not a stuck pass", async () => {
    all();
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    at(rig.T0 + PERIOD + 60);
    process.env.STRIPE_CALL_TIMEOUT_MS = "40";
    (rig.stripe as any).subscriptions.retrieve = () => new Promise(() => {});
    try {
      expect(await runDue()).toMatchObject({ errors: 1, promoted: 0 });
    } finally {
      delete process.env.STRIPE_CALL_TIMEOUT_MS;
    }
  });
});

describe("24. a Stripe brown-out cannot consume the whole cron in the pause pass", () => {
  const dueRows = (n: number) => Array.from({ length: n }, (_, i) =>
    apiAcct(rig, { account: `h-${i}`, token: `tok-h-${i}`.padEnd(30, "x"), stripe_subscription_id: `sub_h_${i}`, key_id: null, billing_pause_from: iso(rig.T0 - DAY + i) }));

  it("three failures in a row stop the pass: the rest are counted as not reached, left untouched and first in line next run", async () => {
    const rows = dueRows(6);
    process.env.STRIPE_CALL_TIMEOUT_MS = "40";
    const answering = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = () => new Promise(() => {});
    let r1;
    const t0 = performance.now();
    try {
      r1 = await runDue();
    } finally {
      delete process.env.STRIPE_CALL_TIMEOUT_MS;
    }
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(r1).toMatchObject({ due: 6, errors: 3, unreached: 3, promoted: 0 });
    expect(rows.filter((x) => x.billing_pause_checked_at).length).toBe(3); // only the rows that were looked at are stamped
    expect(rows.slice(3).every((x) => !x.billing_pause_checked_at && x.billing_pause_from)).toBe(true);
    expect(operatorMail(rig).some((m) => /3 not reached/.test(m.subject))).toBe(true);
    // Stripe answers again: the unreached rows are read FIRST (the stamped ones go behind them)
    for (let i = 0; i < 6; i++) rig.stripe.setSubscription(`sub_h_${i}`, { status: "active", pause_collection: { behavior: "void" } });
    (rig.stripe as any).subscriptions.retrieve = answering;
    const r2 = await runDue();
    expect(r2).toMatchObject({ promoted: 6, unreached: 0 });
  });

  it("the pass has a time budget (an injected clock moved only by the Stripe reads): rows past it are not reached", async () => {
    dueRows(5);
    let t = 0;
    const orig = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => { t += 40; return orig(id); };
    for (let i = 0; i < 5; i++) rig.stripe.setSubscription(`sub_h_${i}`, { status: "active", pause_collection: { behavior: "void" } });
    const r = await applyDuePauses({ stripe: rig.stripe as unknown as ReversalStripe, now: new Date(), clock: () => t, budgetMs: 100 });
    // each row reads Stripe twice (before the hold and again after it): rows run while t <= 100
    expect(r.promoted).toBeGreaterThanOrEqual(1);
    expect(r.unreached).toBeGreaterThanOrEqual(1);
    expect(r.promoted + r.unreached).toBe(5);
  });

  it("the cron route still reaches the settlement-reversal and revocation-backlog stages, and reports the pause pass's unreached rows, with a Stripe that answers nothing", async () => {
    dueRows(6);
    process.env.STRIPE_CALL_TIMEOUT_MS = "40";
    (rig.stripe as any).subscriptions.retrieve = () => new Promise(() => {});
    try {
      const { GET } = await import("@/app/api/cron/payg/route");
      const t0 = performance.now();
      const res = await GET(new Request(siteUrl("/api/cron/payg"), { headers: { authorization: "Bearer cron-secret-value" } }));
      expect(performance.now() - t0).toBeLessThan(4_000);
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.pauses).toMatchObject({ due: 6, errors: 3, unreached: 3 });
      expect(j.settlement_reversals).toBeDefined();
      expect(j.revocation_backlog).toBeDefined();
    } finally {
      delete process.env.STRIPE_CALL_TIMEOUT_MS;
    }
  });
});
