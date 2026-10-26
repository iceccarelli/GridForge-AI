/**
 * The webhook pause writer is conditional on the row it READ.
 *
 * applyPauseState reads the row (pause clock C0, schedule instant), planPause asks Stripe (up to two calls, 8 s each), THEN it writes. The
 * access-check reconcile (lib/pause-reconcile.ts) can clear the stale schedule and move the pause clock to the start of ITS read in that window; a
 * webhook write that is not conditional then writes the OLD clock back and re-creates the stale schedule. Every case here is a mutation check:
 * it fails when the compare-and-set (`ifRow` in lib/billing-pause.ts patchTarget) is taken out.
 *
 * Labels: MOCK STRIPE (HoldStripe) with the planPause call held open by a gate the test releases (the harness `hang` never answers, so it
 * cannot express "answers late"); FAKE STORE (in-memory PostgREST), whose store is touched directly or through a fetch interceptor at the
 * instant the test needs "another writer got there first". The reconcile and the webhook are the REAL code. Only Date is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDuePauses } from "@/lib/billing-pause";
import type { ReversalStripe } from "@/lib/billing-holds";
import { lookupEntitlement } from "@/lib/subscribers";
import { DAY, at, audit, intelRow, send, startRig, type Rig } from "./billing-holds-harness";

let rig: Rig;
let restoreFetch: (() => void) | null = null;
beforeEach(() => { rig = startRig(); });
afterEach(() => { restoreFetch?.(); restoreFetch = null; rig.stop(); });

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const PERIOD = 10 * DAY;
const sub = (id: string, over: Record<string, unknown> = {}) => ({
  id, object: "subscription", status: "active", pause_collection: null, metadata: {},
  current_period_start: rig.T0 - 20 * DAY, current_period_end: rig.T0 + PERIOD, latest_invoice: `in_current_${id}`, ...over,
});
const paused = (id: string, over: Record<string, unknown> = {}) => sub(id, { pause_collection: { behavior: "void" }, ...over });
const ents = () => lookupEntitlement("i@hall.example");
const retrieves = () => rig.stripe.calls.filter((c) => c === "subscriptions.retrieve").length;
/** The WHOLE value of the row's pause state, for "nothing moved" assertions. */
const pauseState = (r: Record<string, unknown>) => ({ from: r.billing_pause_from, resumes: r.billing_pause_resumes_at, clock: r.billing_pause_event_ts, hold: r.billing_hold, status: r.status });

/** Hold the NEXT call of planPause's invoice read open until `release()`; `entered` resolves when the webhook is parked there. */
function gateInvoiceRead() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const parked = new Promise<void>((r) => { entered = r; });
  const invoices = (rig.stripe as any).invoices;
  const orig = invoices.retrieve;
  invoices.retrieve = async (id: string) => {
    invoices.retrieve = orig; // only the first call is held
    entered();
    await gate;
    return orig(id);
  };
  return { release, parked };
}

/** Run `before` ahead of every request for which `when(method, url)` holds, as "another writer got there first". */
function interceptFetch(when: (method: string, url: string) => boolean, before: () => void) {
  const prev = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (when((init?.method ?? "GET").toUpperCase(), decodeURIComponent(url))) before();
    return prev(input, init);
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = prev; };
}

/** An Intelligence row whose pause was scheduled by the real webhook (clock T0+5) and whose paid period is now over. */
async function dueIntelligence() {
  const i = intelRow(rig);
  await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
  expect(pauseState(i)).toMatchObject({ from: iso(rig.T0 + PERIOD), clock: rig.T0 + 5 });
  at(rig.T0 + PERIOD + 60);
  rig.stripe.setSubscription("sub_i", { status: "active", pause_collection: null }); // Stripe: billing is running (the resume event is lost)
  return i;
}

/** A pause update for a RENEWED, paid period: planPause asks Stripe (invoice read), and the plan is "scheduled" for the new period end. */
const renewedPause = () => paused("sub_i", { current_period_end: rig.T0 + 40 * DAY, latest_invoice: "in_renewed" });

describe("1. the reconcile clears the stale schedule while the webhook's planPause call is in flight", () => {
  it("an OLDER pause event does not move the clock backwards and does not re-create the schedule; the event is answered 200 (stale)", async () => {
    const i = await dueIntelligence();
    const g = gateInvoiceRead();
    const inFlight = send(rig, "customer.subscription.updated", renewedPause(), { created: rig.T0 + PERIOD + 30, unmirrored: true });
    await g.parked;
    // the access check proves billing is running at Stripe, clears the schedule and moves the clock to the start of its read (- 1 s)
    expect((await ents()).entitlement?.role).toBe("owner");
    expect(pauseState(i)).toMatchObject({ from: null, resumes: null, clock: rig.T0 + PERIOD + 59 });
    g.release();
    expect((await inFlight).status).toBe(200);
    expect(pauseState(i)).toEqual({ from: null, resumes: null, clock: rig.T0 + PERIOD + 59, hold: null, status: "active" });
    expect(audit(rig, "pause_scheduled")).toHaveLength(1); // the first (setup) event only
    // nothing is due, nothing is denied, Stripe is not asked again
    const asked = retrieves();
    expect((await ents()).entitlement?.role).toBe("owner");
    expect(retrieves()).toBe(asked);
  });

  it("a NEWER pause event is re-evaluated against the row as it is now: its own schedule (the renewed period end), its own clock, one audit row", async () => {
    const i = await dueIntelligence();
    const g = gateInvoiceRead();
    const inFlight = send(rig, "customer.subscription.updated", renewedPause(), { created: rig.T0 + PERIOD + 120, unmirrored: true });
    await g.parked;
    await ents();
    g.release();
    expect((await inFlight).status).toBe(200);
    // not the stale due instant that was read: the schedule this event actually describes
    expect(pauseState(i)).toEqual({ from: iso(rig.T0 + 40 * DAY), resumes: null, clock: rig.T0 + PERIOD + 120, hold: null, status: "active" });
    expect(audit(rig, "pause_scheduled")).toHaveLength(2);
  });

  it("the write is conditional on the schedule, the pause clock and the hold that were read", async () => {
    intelRow(rig);
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
    const patches = (rig.db.calls as { method: string; url: string }[]).filter((c) => c.method === "PATCH" && c.url.includes("/subscriptions?") && c.url.includes("billing_pause_event_ts"));
    expect(patches).toHaveLength(1);
    const q = decodeURIComponent(patches[0].url);
    expect(q).toContain("billing_pause_from=is.null");
    expect(q).toContain("billing_pause_event_ts=is.null");
    expect(q).toContain("billing_hold=is.null");
    expect(q).toContain("status=not.in.(cancelled,superseded)");
  });
});

describe("2. a RESUME event delayed past the reconcile (no Stripe call to hold open: the other writer lands between the read and the write)", () => {
  it("the clock is not moved backwards to the resume's own time; the stale resume changes nothing", async () => {
    const i = await dueIntelligence();
    let fired = false;
    interceptFetch((m, u) => !fired && m === "PATCH" && u.includes("/subscriptions?") && u.includes("billing_pause_event_ts"), () => {
      fired = true;
      i.billing_pause_from = null;
      i.billing_pause_resumes_at = null;
      i.billing_pause_event_ts = rig.T0 + PERIOD + 59; // exactly what the reconcile writes
    });
    expect((await send(rig, "customer.subscription.updated", sub("sub_i"), { created: rig.T0 + PERIOD + 30, unmirrored: true })).status).toBe(200);
    expect(fired).toBe(true);
    expect(pauseState(i)).toEqual({ from: null, resumes: null, clock: rig.T0 + PERIOD + 59, hold: null, status: "active" });
    expect(audit(rig, "pause_schedule_cleared")).toHaveLength(0); // the reconcile's own row says what happened; the stale resume adds none
  });
});

describe("3. a hold that arrives while the webhook is in flight is never overwritten, lifted or ignored", () => {
  it("the due schedule became the paused hold (the daily job): the webhook does not put the schedule back next to it, and the hold stands", async () => {
    const i = await dueIntelligence();
    const g = gateInvoiceRead();
    const inFlight = send(rig, "customer.subscription.updated", renewedPause(), { created: rig.T0 + PERIOD + 30, unmirrored: true });
    await g.parked;
    // the daily job starts the hold: suspended, hold columns, schedule cleared (it does not touch the pause clock)
    Object.assign(i, { status: "suspended", billing_hold: "paused", billing_hold_ref: "sub_i", billing_hold_at: iso(rig.T0 + PERIOD), billing_hold_prev_status: "active", billing_pause_from: null, billing_pause_resumes_at: null });
    g.release();
    expect((await inFlight).status).toBe(200);
    expect(i).toMatchObject({ status: "suspended", billing_hold: "paused", billing_hold_ref: "sub_i", billing_hold_prev_status: "active", billing_pause_from: null, billing_pause_resumes_at: null });
    expect(audit(rig, "hold_lifted")).toHaveLength(0);
    expect(audit(rig, "pause_scheduled")).toHaveLength(1);
    expect((await ents()).entitlement).toBeNull(); // still denied
  });

  it("a dispute (a stronger hold) lands mid-flight: its hold columns and status are untouched by the event", async () => {
    const i = await dueIntelligence();
    const g = gateInvoiceRead();
    const inFlight = send(rig, "customer.subscription.updated", renewedPause(), { created: rig.T0 + PERIOD + 120, unmirrored: true });
    await g.parked;
    Object.assign(i, { status: "suspended", billing_hold: "disputed", billing_hold_ref: "dp_1", billing_hold_at: iso(rig.T0 + PERIOD + 50), billing_hold_prev_status: "active" });
    g.release();
    expect((await inFlight).status).toBe(200);
    expect(i).toMatchObject({ status: "suspended", billing_hold: "disputed", billing_hold_ref: "dp_1", billing_hold_prev_status: "active" });
    expect(audit(rig, "hold_lifted")).toHaveLength(0);
    expect(audit(rig, "hold_applied")).toHaveLength(0);
  });

  it("a cancellation that lands mid-flight stays: nothing is written to the ended row, and the event is acknowledged", async () => {
    const i = await dueIntelligence();
    const g = gateInvoiceRead();
    const inFlight = send(rig, "customer.subscription.updated", renewedPause(), { created: rig.T0 + PERIOD + 120, unmirrored: true });
    await g.parked;
    i.status = "cancelled";
    const before = pauseState(i);
    g.release();
    expect((await inFlight).status).toBe(200);
    expect(pauseState(i)).toEqual(before);
    expect(audit(rig, "pause_scheduled")).toHaveLength(1);
  });
});

describe("4. raced twice: the existing retry outcome, and the redelivery applies", () => {
  it("a newer writer wins both attempts: nothing is written over it, the event is answered 500, and the same event redelivered is applied", async () => {
    const i = intelRow(rig);
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
    const scheduled = pauseState(i);
    let bumps = 0;
    interceptFetch((m, u) => m === "PATCH" && u.includes("/subscriptions?") && u.includes("billing_pause_event_ts"), () => {
      bumps++;
      i.billing_pause_event_ts = (i.billing_pause_event_ts as number) + 1; // a newer pause/resume event lands just before each write
    });
    const res = await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 50, id: "evt_raced_twice", unmirrored: true });
    expect(res.status).toBe(500);
    expect(bumps).toBe(2); // one attempt, one re-evaluation: bounded, no loop
    expect(pauseState(i)).toEqual({ ...scheduled, clock: (scheduled.clock as number) + 2 }); // only the other writer's moves
    expect(audit(rig, "pause_scheduled")).toHaveLength(1);
    // Stripe redelivers once the other writer is quiet
    restoreFetch?.();
    restoreFetch = null;
    const again = await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 50, id: "evt_raced_twice", unmirrored: true });
    expect(again.status).toBe(200);
    expect(pauseState(i)).toMatchObject({ from: iso(rig.T0 + PERIOD), clock: rig.T0 + 50 });
  });

  it("raced once (then quiet) is re-evaluated and answered 200: a single lost race never costs a retry", async () => {
    const i = intelRow(rig);
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
    let bumps = 0;
    interceptFetch((m, u) => m === "PATCH" && u.includes("/subscriptions?") && u.includes("billing_pause_event_ts") && bumps === 0, () => {
      bumps++;
      i.billing_pause_event_ts = rig.T0 + 7;
    });
    expect((await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 50, unmirrored: true })).status).toBe(200);
    expect(bumps).toBe(1);
    expect(pauseState(i)).toMatchObject({ from: iso(rig.T0 + PERIOD), clock: rig.T0 + 50 });
  });
});

describe("5. the uncontended path is unchanged", () => {
  it("pause, redelivery, resume: one schedule, one audit row each, the clock moves forward only, no re-read of the row", async () => {
    const i = intelRow(rig);
    const rowReads = () => (rig.db.calls as { method: string; url: string }[]).filter((c) => c.method === "GET" && c.url.includes("/subscriptions?") && c.url.includes("stripe_subscription_id")).length;
    const r0 = rowReads();
    expect((await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5, id: "evt_a" })).status).toBe(200);
    expect(rowReads() - r0).toBe(1);
    expect((await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5, id: "evt_a" })).status).toBe(200);
    expect(pauseState(i)).toMatchObject({ from: iso(rig.T0 + PERIOD), clock: rig.T0 + 5 });
    expect(audit(rig, "pause_scheduled")).toHaveLength(1);
    expect((await send(rig, "customer.subscription.updated", sub("sub_i"), { created: rig.T0 + 9, id: "evt_b" })).status).toBe(200);
    expect(pauseState(i)).toEqual({ from: null, resumes: null, clock: rig.T0 + 9, hold: null, status: "active" });
    expect(audit(rig, "pause_schedule_cleared")).toHaveLength(1);
  });
});

describe("6. the closing audit row of a cleared stale schedule is never lost", () => {
  const runDue = () => applyDuePauses({ stripe: rig.stripe as unknown as ReversalStripe, now: new Date() });

  it("the closing row could not be written (or the process died after the clear): the daily pass writes it under the same key, once", async () => {
    const i = await dueIntelligence();
    let failing = true;
    const prev = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (failing && (init?.method ?? "GET").toUpperCase() === "POST" && String(init?.body).includes('"action":"pause_schedule_dropped"')) return Promise.resolve(new Response(JSON.stringify({ message: "store down" }), { status: 500 }));
      return prev(input, init);
    }) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = prev; };
    expect((await ents()).entitlement?.role).toBe("owner"); // access is granted, the schedule is cleared
    failing = false;
    expect(i.billing_pause_from).toBeNull();
    expect(audit(rig, "pause_schedule_drop_started")).toHaveLength(1);
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0); // the orphan
    const started = audit(rig, "pause_schedule_drop_started")[0];

    // too soon: the check that wrote "started" may still be finishing
    expect((await runDue()).auditClosed).toBe(0);
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0);

    at(rig.T0 + PERIOD + 60 + 11 * 60);
    expect((await runDue()).auditClosed).toBe(1);
    const closed = audit(rig, "pause_schedule_dropped");
    expect(closed).toHaveLength(1);
    expect(closed[0].dedupe_key).toBe((started.dedupe_key as string).replace("pause_schedule_drop_started:", "pause_schedule_dropped:"));
    expect(closed[0]).toMatchObject({ subject_table: "subscriptions", subject_id: i.id, stripe_subscription_id: "sub_i" });
    expect(closed[0].detail).toMatchObject({ why: "billing_running_at_stripe", was_effective_from: iso(rig.T0 + PERIOD), closed_by: "daily_pass", schedule_found_clear: true });

    // idempotent
    expect((await runDue()).auditClosed).toBe(0);
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(1);
  });

  it("a normally closed drop is not closed again, and a 'started' whose schedule still stands is left to its own check", async () => {
    const i = await dueIntelligence();
    expect((await ents()).entitlement?.role).toBe("owner");
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(1);
    at(rig.T0 + PERIOD + 60 + 11 * 60);
    expect((await runDue()).auditClosed).toBe(0);
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(1);

    // a crash BEFORE the clear: "started" is on record and the schedule still stands (the next check repeats both rows)
    const { recordBillingAudit } = await import("@/lib/billing-audit");
    await recordBillingAudit({ table: "subscriptions", subjectId: i.id as string, subscriptionId: "sub_i", dedupeKey: "pause_schedule_drop_started:subscriptions:x:2099-01-01T00:00:00.000Z:1", action: "pause_schedule_drop_started", detail: { why: "billing_running_at_stripe" } });
    i.billing_pause_from = iso(rig.T0 + 99 * DAY);
    at(rig.T0 + PERIOD + 60 + 30 * 60);
    expect((await runDue()).auditClosed).toBe(0);
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(1);
  });
});
