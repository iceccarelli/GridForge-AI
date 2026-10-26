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
import { DAY, at, audit, intelRow, operatorMail, send, startRig, type Rig } from "./billing-holds-harness";

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

  // INVARIANT TESTS (3b, 3c): these also pass with the compare-and-set removed, because the writer never touches hold columns and its plain
  // status guard already refuses an ended row. They pin those properties; the tests that discriminate the CAS are the others in this file.
  it("[invariant, does not discriminate the CAS] a dispute (a stronger hold) lands mid-flight: its hold columns and status are untouched by the event", async () => {
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

  it("[invariant, does not discriminate the CAS] a cancellation that lands mid-flight stays: nothing is written to the ended row, and the event is acknowledged", async () => {
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

/** How many times the webhook (or anything) read the subscription row set by Stripe subscription id: 1 per event when nothing raced, 2 after a lost race. */
const rowReads = () => (rig.db.calls as { method: string; url: string }[]).filter((c) => c.method === "GET" && c.url.includes("/subscriptions?") && c.url.includes("stripe_subscription_id")).length;
const isCas = (m: string, u: string) => m === "PATCH" && u.includes("/subscriptions?") && u.includes("billing_pause_event_ts");
const casPatches = () => (rig.db.calls as { method: string; url: string }[]).filter((c) => c.method === "PATCH" && c.url.includes("/subscriptions?") && c.url.includes("billing_pause_event_ts")).map((c) => decodeURIComponent(c.url));

describe("6. the writes that follow a hold this event itself changed expect that change (and are still guarded)", () => {
  it("a RESUME that LIFTS the paused hold: its clock write expects hold=null, so it costs no re-read; raced by a newer event it re-evaluates and never moves the clock backwards", async () => {
    const heldRow = () => intelRow(rig, { status: "suspended", billing_hold: "paused", billing_hold_ref: "sub_i", billing_hold_at: iso(rig.T0 - DAY), billing_hold_prev_status: "active", billing_pause_event_ts: rig.T0 + 5 });
    // uncontended: lifted, clock forward, ONE read of the row (a wrong expectation of the hold would read as a race and read twice)
    const a = heldRow();
    expect((await send(rig, "customer.subscription.updated", sub("sub_i"), { created: rig.T0 + 20, unmirrored: true })).status).toBe(200);
    expect(pauseState(a)).toEqual({ from: null, resumes: null, clock: rig.T0 + 20, hold: null, status: "active" });
    expect(rowReads()).toBe(1);
    expect(casPatches()).toHaveLength(1);
    expect(casPatches()[0]).toContain("billing_hold=is.null");
    rig.db.rows("subscriptions").length = 0;

    // raced: a newer pause/resume event lands between the lift and the clock write
    const b = heldRow();
    let fired = false;
    interceptFetch((m, u) => !fired && isCas(m, u), () => { fired = true; b.billing_pause_event_ts = rig.T0 + 30; });
    expect((await send(rig, "customer.subscription.updated", sub("sub_i"), { created: rig.T0 + 20, unmirrored: true, id: "evt_resume_lift" })).status).toBe(200);
    expect(fired).toBe(true);
    expect(pauseState(b)).toEqual({ from: null, resumes: null, clock: rig.T0 + 30, hold: null, status: "active" });
  });

  it("an IMMEDIATE pause: the hold is begun, then its clock write expects hold=paused (no re-read); raced by a newer event it re-evaluates, the hold stands and the clock never moves backwards", async () => {
    const over = { current_period_start: rig.T0 - 31 * DAY, current_period_end: rig.T0 - DAY }; // the paid period is over: the hold begins now
    const a = intelRow(rig);
    expect((await send(rig, "customer.subscription.updated", paused("sub_i", over), { created: rig.T0 + 5, unmirrored: true })).status).toBe(200);
    expect(pauseState(a)).toEqual({ from: null, resumes: null, clock: rig.T0 + 5, hold: "paused", status: "suspended" });
    expect(rowReads()).toBe(1);
    expect(casPatches()).toHaveLength(1);
    expect(casPatches()[0]).toContain("billing_hold=eq.paused");
    rig.db.rows("subscriptions").length = 0;

    const b = intelRow(rig);
    let fired = false;
    interceptFetch((m, u) => !fired && isCas(m, u), () => { fired = true; b.billing_pause_event_ts = rig.T0 + 30; });
    expect((await send(rig, "customer.subscription.updated", paused("sub_i", over), { created: rig.T0 + 5, unmirrored: true, id: "evt_imm" })).status).toBe(200);
    expect(fired).toBe(true);
    expect(pauseState(b)).toEqual({ from: null, resumes: null, clock: rig.T0 + 30, hold: "paused", status: "suspended" }); // the hold of the (now stale) event stands: fail closed
  });

  it("the guarded write finding the row ENDED is terminal, not a race: acknowledged (200) with no second read; the guard's own read failing is an error: 500 (retry)", async () => {
    const i = intelRow(rig);
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
    const reads = rowReads();
    // ended AND changed in the same instant: nothing matches; the follow-up read finds no live row
    interceptFetch((m, u) => isCas(m, u), () => { i.status = "cancelled"; i.billing_pause_event_ts = rig.T0 + 99; });
    expect((await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 50, unmirrored: true })).status).toBe(200);
    expect(rowReads() - reads).toBe(1);
    expect(i.status).toBe("cancelled");
    restoreFetch?.();
    restoreFetch = null;

    // the same lost write, but the read that tells "raced" from "ended" fails
    i.status = "active";
    i.billing_pause_event_ts = rig.T0 + 5;
    const prev = globalThis.fetch;
    let bumped = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = decodeURIComponent(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const m = (init?.method ?? "GET").toUpperCase();
      if (isCas(m, url) && !bumped) { bumped = true; i.billing_pause_event_ts = rig.T0 + 7; }
      if (m === "GET" && url.includes("/subscriptions?") && url.includes("select=id&limit=1")) return Promise.resolve(new Response(JSON.stringify({ message: "store down" }), { status: 500 }));
      return prev(input, init);
    }) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = prev; };
    const before = pauseState(i);
    expect((await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 50, unmirrored: true, id: "evt_guard_read_fails" })).status).toBe(500);
    expect(pauseState(i)).toEqual({ ...before, clock: rig.T0 + 7 });
  });
});

describe("7. the audit trail of a stale schedule that was cleared is never left without an honest end", () => {
  const runDue = (extra: Record<string, unknown> = {}) => applyDuePauses({ stripe: rig.stripe as unknown as ReversalStripe, now: new Date(), ...extra });
  const startedKey = (i: Record<string, unknown>, clock: number | string = rig.T0 + 5) => `pause_schedule_drop_started:subscriptions:${i.id}:${iso(rig.T0 + PERIOD)}:${clock}`;
  async function recordStarted(i: Record<string, unknown>, key = startedKey(i)) {
    const { recordBillingAudit } = await import("@/lib/billing-audit");
    await recordBillingAudit({ table: "subscriptions", subjectId: i.id as string, subscriptionId: "sub_i", dedupeKey: key, action: "pause_schedule_drop_started", detail: { why: "billing_running_at_stripe", was_effective_from: iso(rig.T0 + PERIOD), checked_by: "access_check" } });
  }
  const later = () => at(rig.T0 + PERIOD + 60 + 11 * 60);
  const drops = () => audit(rig, "pause_schedule_dropped");
  const unconfirmed = () => audit(rig, "pause_schedule_drop_unconfirmed");

  it("the closing row could not be written: the daily pass leaves `pause_schedule_drop_unconfirmed` (it claims no reason and no actor, never `dropped`), once, and not too soon", async () => {
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
    const started = audit(rig, "pause_schedule_drop_started")[0];
    expect(drops()).toHaveLength(0); // the orphan

    expect((await runDue()).auditClosed).toBe(0); // too soon: the check that wrote "started" may still be finishing
    expect(unconfirmed()).toHaveLength(0);

    later();
    expect((await runDue()).auditClosed).toBe(1);
    expect(drops()).toHaveLength(0); // never claims "dropped"
    const rows = unconfirmed();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe((started.dedupe_key as string).replace("pause_schedule_drop_started:", "pause_schedule_drop_unconfirmed:"));
    expect(rows[0]).toMatchObject({ subject_table: "subscriptions", subject_id: i.id, stripe_subscription_id: "sub_i" });
    expect(rows[0].detail).toEqual({ schedule_found_clear: true, closed_by: "daily_pass", started_key: started.dedupe_key, was_effective_from: iso(rig.T0 + PERIOD) });
    expect((await runDue()).auditClosed).toBe(0); // idempotent
    expect(unconfirmed()).toHaveLength(1);
  });

  it("a NORMALLY closed pair is left alone, and a 'started' whose schedule still stands is left to its own check", async () => {
    const i = await dueIntelligence();
    expect((await ents()).entitlement?.role).toBe("owner");
    expect(drops()).toHaveLength(1);
    later();
    expect((await runDue()).auditClosed).toBe(0);
    await recordStarted(i, "pause_schedule_drop_started:subscriptions:x:2099-01-01T00:00:00.000Z:1");
    i.billing_pause_from = iso(rig.T0 + 99 * DAY);
    at(rig.T0 + PERIOD + 60 + 30 * 60);
    expect((await runDue()).auditClosed).toBe(0);
    expect(drops()).toHaveLength(1);
    expect(unconfirmed()).toHaveLength(0);
  });

  it("MISLABEL 1: the daily job's promote cleared the schedule as the hold began (hold paused, suspended): nothing is written about it", async () => {
    const i = intelRow(rig, { status: "suspended", billing_hold: "paused", billing_hold_ref: "sub_i", billing_hold_prev_status: "active", billing_pause_from: null });
    await recordStarted(i);
    later();
    expect((await runDue()).auditClosed).toBe(0);
    expect(drops()).toHaveLength(0);
    expect(unconfirmed()).toHaveLength(0);
  });

  it("MISLABEL 2: the RESUME webhook cleared the schedule: the closing row says only 'found clear' (no reason, no actor), and is never `dropped`", async () => {
    const i = await dueIntelligence();
    await recordStarted(i); // the check wrote "started", then died before it cleared anything
    expect((await send(rig, "customer.subscription.updated", sub("sub_i"), { created: rig.T0 + PERIOD + 30, unmirrored: true })).status).toBe(200);
    expect(i.billing_pause_from).toBeNull();
    expect(audit(rig, "pause_schedule_cleared")).toHaveLength(1); // the webhook's own row says what happened
    later();
    expect((await runDue()).auditClosed).toBe(1);
    expect(drops()).toHaveLength(0);
    expect(unconfirmed()).toHaveLength(1);
    expect(unconfirmed()[0].detail).not.toHaveProperty("why");
    expect(unconfirmed()[0].detail).toMatchObject({ schedule_found_clear: true, closed_by: "daily_pass" });
  });

  it("MISLABEL 3: the access check LOST the conditional clear to another instance and let the customer in (no closing row by design): the pass says only 'found clear'", async () => {
    const i = await dueIntelligence();
    let fired = false;
    interceptFetch((m, u) => !fired && m === "PATCH" && u.includes("/subscriptions?") && u.includes("billing_pause_from=eq."), () => {
      fired = true;
      i.billing_pause_from = null; // another instance cleared it first
      i.billing_pause_event_ts = rig.T0 + PERIOD + 59;
    });
    expect((await ents()).entitlement?.role).toBe("owner");
    expect(fired).toBe(true);
    expect(audit(rig, "pause_schedule_drop_started")).toHaveLength(1);
    expect(drops()).toHaveLength(0);
    later();
    expect((await runDue()).auditClosed).toBe(1);
    expect(drops()).toHaveLength(0);
    expect(unconfirmed()).toHaveLength(1);
  });

  it("205 closed pairs do not crowd out an orphan: newest orphan, and an orphan older than all of them", async () => {
    const { recordBillingAudit } = await import("@/lib/billing-audit");
    const closedPairs = async (from: number) => {
      for (let n = 0; n < 205; n++) {
        const key = `subscriptions:gone-${from}-${n}:${iso(rig.T0 + PERIOD)}:1`;
        await recordBillingAudit({ table: "subscriptions", subjectId: `gone-${n}`, dedupeKey: `pause_schedule_drop_started:${key}`, action: "pause_schedule_drop_started" });
        await recordBillingAudit({ table: "subscriptions", subjectId: `gone-${n}`, dedupeKey: `pause_schedule_dropped:${key}`, action: "pause_schedule_dropped" });
      }
    };
    for (const orphanFirst of [false, true]) {
      rig.db.rows("billing_audit").length = 0;
      rig.db.rows("subscriptions").length = 0;
      const i = intelRow(rig);
      at(rig.T0 + 100);
      if (orphanFirst) await recordStarted(i);
      at(rig.T0 + 200);
      await closedPairs(orphanFirst ? 1 : 0);
      at(rig.T0 + 300);
      if (!orphanFirst) await recordStarted(i);
      at(rig.T0 + 300 + 11 * 60);
      expect((await runDue()).auditClosed, orphanFirst ? "orphan older than every closed pair" : "orphan newer than every closed pair").toBe(1);
      expect(unconfirmed()).toHaveLength(1);
      expect(unconfirmed()[0].subject_id).toBe(i.id);
      at(rig.T0);
    }
  });

  it("a store that never answers during the sweep does not delay the operator notices (they go out first) and does not hang the pass", async () => {
    await dueIntelligence();
    rig.stripe.failOnce.add("subscriptions.retrieve"); // the due pause cannot be examined: the pass will owe the operator a notice
    const mailAtSweep: number[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = decodeURIComponent(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if ((init?.method ?? "GET").toUpperCase() === "GET" && url.includes("/billing_audit?") && url.includes("action=eq.pause_schedule_dropped")) {
        mailAtSweep.push(operatorMail(rig).length);
        return new Promise<Response>(() => {}); // never answers
      }
      return prev(input, init);
    }) as typeof fetch;
    restoreFetch = () => { globalThis.fetch = prev; };
    const t0 = Date.now();
    const out = await applyDuePauses({ stripe: rig.stripe as unknown as ReversalStripe, now: new Date(), budgetMs: 250 });
    expect(out).toMatchObject({ due: 1, errors: 1, auditClosed: 0 });
    expect(mailAtSweep).toEqual([1]); // the notice was already sent when the sweep began
    expect(operatorMail(rig)).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(5_000); // returned at the bound, not at "never"
  });
});
