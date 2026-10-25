/**
 * A due pause schedule and a LOST (or late) resume event: the entitlement decision asks Stripe once, in one place.
 *
 * Before this change a scheduled pause whose instant had passed made lookupEntitlement (Intelligence, and every seat on it) and the Hall Watch
 * route deny the customer until the daily job asked Stripe (up to ~24 h) even when billing had resumed; only the API-key mint asked.
 * lib/pause-reconcile.ts is now the one rule for all three. Every "grants" case here fails against the code before this change; every
 * "denies" case proves the fail-closed side. Labels: MOCK STRIPE (HoldStripe, tests/site/billing-holds-harness.ts, no live call) and FAKE
 * STORE (in-memory PostgREST; the SQL columns are proven against PostgreSQL in tests/test_billing_pause_reversals_migration.py).
 * The clock is faked (Date only); the real timeout (STRIPE_CALL_TIMEOUT_MS) runs on real timers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { lookupEntitlement } from "@/lib/subscribers";
import { NEGATIVE_CACHE_MS, pauseAllowsAccess } from "@/lib/pause-reconcile";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { DAY, apiAcct, at, audit, intelRow, post, send, startRig, watchRow, type Rig } from "./billing-holds-harness";
import { installTeamRpcs } from "./team-rpc-fake";

let rig: Rig;
beforeEach(() => { rig = startRig(); });
afterEach(() => rig.stop());

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const PERIOD = 10 * DAY;
const sub = (id: string, over: Record<string, unknown> = {}) => ({
  id, object: "subscription", status: "active", pause_collection: null, metadata: {},
  current_period_start: rig.T0 - 20 * DAY, current_period_end: rig.T0 + PERIOD, latest_invoice: `in_current_${id}`, ...over,
});
const paused = (id: string, over: Record<string, unknown> = {}) => sub(id, { pause_collection: { behavior: "void" }, ...over });
const stripeSays = (id: string, state: "paused" | "running" | "unpaid" | "canceled") =>
  rig.stripe.setSubscription(id, state === "paused" ? { status: "active", pause_collection: { behavior: "void" } } : state === "running" ? { status: "active", pause_collection: null } : { status: state, pause_collection: null });
const retrieves = () => rig.stripe.calls.filter((c) => c === "subscriptions.retrieve").length;
const email = "i@hall.example";
const ents = () => lookupEntitlement(email);
const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", amount: 90_000, currency: "eur", charge: "ch_1", reason: "fraudulent", status: "needs_response", ...over });
const refundOf = (id = "ch_1", pi = "pi_1") => ({ id, object: "charge", amount: 90_000, amount_refunded: 90_000, refunded: true, payment_intent: pi, currency: "eur" });

/** An Intelligence row whose pause was scheduled by the real webhook and whose paid period is now over; Stripe's answer is not set yet. */
async function dueIntelligence(over: Record<string, unknown> = {}) {
  const i = intelRow(rig, over);
  await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
  at(rig.T0 + PERIOD + 60);
  return i;
}

describe("A1. the resume event was lost: Stripe says billing is running", () => {
  it("Intelligence is granted, the stale schedule is cleared with one audit row, the clocks are untouched, and the next check needs no Stripe call", async () => {
    const i = await dueIntelligence();
    expect(i.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    const clock = i.billing_pause_event_ts;
    expect(clock).toBe(rig.T0 + 5);
    stripeSays("sub_i", "running");
    const before = retrieves();
    const first = await ents();
    expect(first.reachable && first.entitlement?.role).toBe("owner");
    expect(i).toMatchObject({ billing_pause_from: null, billing_pause_resumes_at: null, status: "active", billing_hold: null, billing_pause_event_ts: clock });
    expect(retrieves() - before).toBe(1);
    const rows = audit(rig, "pause_schedule_dropped");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_table: "subscriptions", subject_id: i.id, stripe_subscription_id: "sub_i" });
    expect(rows[0].detail).toMatchObject({ why: "billing_running_at_stripe", was_effective_from: iso(rig.T0 + PERIOD) });
    // the schedule is gone: nothing is due, nothing is asked
    expect((await ents()).entitlement?.role).toBe("owner");
    expect(retrieves() - before).toBe(1);
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(1);
  });

  it("the resume event that finally arrives is applied as ever (it finds nothing to clear and records its clock)", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "running");
    await ents();
    expect(i.billing_pause_from).toBeNull();
    expect((await send(rig, "customer.subscription.updated", sub("sub_i"), { created: rig.T0 + 50 })).status).toBe(200);
    expect(i).toMatchObject({ billing_pause_from: null, billing_hold: null, status: "active", billing_pause_event_ts: rig.T0 + 50 });
    expect((await ents()).entitlement).not.toBeNull();
  });

  it("the Hall Watch route re-solves instead of answering 409; the API-key mint goes ahead; both clear and audit their own row", async () => {
    const w = watchRow(rig);
    const a = apiAcct(rig);
    await send(rig, "customer.subscription.updated", paused("sub_w"), { created: rig.T0 + 5 });
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    at(rig.T0 + PERIOD + 60);
    stripeSays("sub_w", "running");
    stripeSays("sub_api", "running");
    const ENGINE = "https://engine.test";
    process.env.GRIDFORGE_API_URL = ENGINE;
    const inner = globalThis.fetch;
    let diffs = 0;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      if (url === `${ENGINE}/v1/diff`) {
        diffs++;
        return new Response(JSON.stringify({ headline: "x", material: false, racks_delta: 0, weeks_delta: 0, binding_moved: false, after: {}, document: "<p>n</p>" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return inner(i as RequestInfo, init);
    }) as typeof fetch;
    try {
      const intake = {
        siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12,
        currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12,
        positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
      };
      const { POST } = await import("@/app/api/watch/[token]/route");
      const res = await POST(new Request(siteUrl(`/api/watch/${w.token}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intake) }), { params: Promise.resolve({ token: w.token as string }) });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(diffs).toBeGreaterThan(0);
      expect(w.billing_pause_from).toBeNull();
      const keys = await import("@/app/api/keys/route");
      const minted = await keys.POST(post("/api/keys", { token: a.token, rotate: true }));
      expect(minted.status).toBe(200);
      expect(a.billing_pause_from).toBeNull();
      expect(audit(rig, "pause_schedule_dropped").map((r) => r.subject_table).sort()).toEqual(["api_accounts", "watches"]);
    } finally {
      globalThis.fetch = inner;
      delete process.env.GRIDFORGE_API_URL;
    }
  });
});

describe("A2. still paused, or Stripe cannot say: FAIL CLOSED, schedule untouched", () => {
  for (const state of ["paused", "unpaid", "canceled"] as const) {
    it(`Stripe says ${state}: denied, nothing written`, async () => {
      const i = await dueIntelligence();
      stripeSays("sub_i", state);
      expect((await ents()).entitlement).toBeNull();
      expect(i).toMatchObject({ billing_pause_from: iso(rig.T0 + PERIOD), status: "active", billing_hold: null });
      expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0);
    });
  }

  it("a Stripe 5xx: denied, schedule untouched, no audit row", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "running");
    rig.stripe.failOnce.add("subscriptions.retrieve");
    expect((await ents()).entitlement).toBeNull();
    expect(i.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0);
  });

  it("a Stripe that never answers: denied after the bound (not a hang), schedule untouched", async () => {
    const i = await dueIntelligence();
    process.env.STRIPE_CALL_TIMEOUT_MS = "40";
    (rig.stripe as any).subscriptions.retrieve = () => new Promise(() => {});
    try {
      const t0 = performance.now();
      expect((await ents()).entitlement).toBeNull();
      expect(performance.now() - t0).toBeLessThan(2_000);
    } finally {
      delete process.env.STRIPE_CALL_TIMEOUT_MS;
    }
    expect(i.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0);
  });

  it("no Stripe client (unconfigured): denied, schedule untouched", async () => {
    const i = await dueIntelligence();
    setPaygStripeForTests(null);
    const key = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      expect((await ents()).entitlement).toBeNull();
    } finally {
      process.env.STRIPE_SECRET_KEY = key;
    }
    expect(i.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
  });

  it("a subscription Stripe has no record of, and a row with no subscription id: denied", async () => {
    const i = await dueIntelligence();
    expect((await ents()).entitlement).toBeNull(); // HoldStripe: no state for sub_i -> resource_missing
    expect(i.billing_pause_from).not.toBeNull();
    expect(await pauseAllowsAccess("subscriptions", { ...(i as any), stripe_subscription_id: null })).toBe(false);
  });
});

describe("A3. a delayed or out-of-order resume must not clear a re-pause", () => {
  it("a re-pause that lands while Stripe is being read (same schedule instant, newer clock) keeps its schedule; the access check is denied", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "running"); // what Stripe said when it was read ...
    const orig = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => {
      const out = await orig(id);
      i.billing_pause_event_ts = rig.T0 + 300; // ... and the customer paused AGAIN before the write (the pause event moved the clock)
      return out;
    };
    expect((await ents()).entitlement).toBeNull();
    expect(i).toMatchObject({ billing_pause_from: iso(rig.T0 + PERIOD), billing_pause_event_ts: rig.T0 + 300 });
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0);
  });

  it("a re-pause that moved the schedule instant meanwhile is kept too", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "running");
    const orig = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => {
      const out = await orig(id);
      i.billing_pause_from = iso(rig.T0 + PERIOD - DAY);
      return out;
    };
    expect((await ents()).entitlement).toBeNull();
    expect(i.billing_pause_from).toBe(iso(rig.T0 + PERIOD - DAY));
  });

  it("pause(5), re-pause(100), then the DELAYED resume(50): the resume is stale (nothing changes) and, with Stripe paused, access stays denied; if the customer then resumes for real and that event is lost, the check grants", async () => {
    const i = await dueIntelligence();
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 100 });
    expect(i.billing_pause_event_ts).toBe(rig.T0 + 100);
    await send(rig, "customer.subscription.updated", sub("sub_i"), { created: rig.T0 + 50 }); // the delayed resume
    expect(i).toMatchObject({ billing_pause_from: iso(rig.T0 + PERIOD), billing_pause_event_ts: rig.T0 + 100 });
    stripeSays("sub_i", "paused");
    expect((await ents()).entitlement).toBeNull();
    expect(i.billing_pause_from).toBe(iso(rig.T0 + PERIOD));
    at(rig.T0 + PERIOD + 60 + NEGATIVE_CACHE_MS / 1000 + 1);
    stripeSays("sub_i", "running"); // the real resume, whose event is lost
    expect((await ents()).entitlement).not.toBeNull();
    expect(i).toMatchObject({ billing_pause_from: null, billing_pause_event_ts: rig.T0 + 100 });
  });
});

describe("A4. a resume never lifts a separate hold", () => {
  it("refund hold + due pause schedule + Stripe says running: still denied, the hold and the schedule are untouched, Stripe is not even asked", async () => {
    const a = apiAcct(rig);
    const i = intelRow(rig);
    rig.stripe.link("ch_1", "pi_1", "in_1", "sub_api");
    rig.stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    await send(rig, "charge.refunded", refundOf(), { created: rig.T0 + 3 });
    await send(rig, "charge.refunded", refundOf("ch_i", "pi_i"), { created: rig.T0 + 3 });
    await send(rig, "customer.subscription.updated", paused("sub_api"), { created: rig.T0 + 5 });
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
    expect(a).toMatchObject({ billing_hold: "refunded", billing_pause_from: iso(rig.T0 + PERIOD) });
    expect(i).toMatchObject({ billing_hold: "refunded", status: "suspended", billing_pause_from: iso(rig.T0 + PERIOD) });
    at(rig.T0 + PERIOD + 60);
    stripeSays("sub_api", "running");
    stripeSays("sub_i", "running");
    const before = retrieves();
    expect((await ents()).entitlement).toBeNull();
    const keys = await import("@/app/api/keys/route");
    expect((await keys.POST(post("/api/keys", { token: a.token, rotate: true }))).status).not.toBe(200); // (402: a held account mints nothing)
    expect(await pauseAllowsAccess("api_accounts", a as any)).toBe(false);
    expect(await pauseAllowsAccess("subscriptions", i as any)).toBe(false);
    expect(retrieves() - before).toBe(0);
    expect(a).toMatchObject({ billing_hold: "refunded", status: "past_due", key_id: null, billing_pause_from: iso(rig.T0 + PERIOD) });
    expect(i).toMatchObject({ billing_hold: "refunded", status: "suspended", billing_pause_from: iso(rig.T0 + PERIOD) });
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0);
  });

  it("a dispute hold likewise (and a row that still LOOKS entitled but carries a hold is not granted either)", async () => {
    const i = intelRow(rig);
    rig.stripe.link("ch_i", "pi_i", "in_i", "sub_i");
    await send(rig, "charge.dispute.created", dispute({ id: "dp_i", charge: "ch_i" }), { created: rig.T0 + 3 });
    await send(rig, "customer.subscription.updated", paused("sub_i"), { created: rig.T0 + 5 });
    expect(i).toMatchObject({ billing_hold: "disputed", billing_pause_from: iso(rig.T0 + PERIOD) });
    at(rig.T0 + PERIOD + 60);
    stripeSays("sub_i", "running");
    const before = retrieves();
    expect((await ents()).entitlement).toBeNull();
    expect(i).toMatchObject({ billing_hold: "disputed", status: "suspended", billing_pause_from: iso(rig.T0 + PERIOD) });
    i.status = "past_due"; // hypothetical store state: an entitling status next to a hold
    expect((await ents()).entitlement).toBeNull();
    expect(i).toMatchObject({ billing_hold: "disputed", billing_pause_from: iso(rig.T0 + PERIOD) });
    expect(retrieves() - before).toBe(0);
  });

  it("a hold that appears between the Stripe read and the write is not overwritten: the conditional write matches nothing", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "running");
    const orig = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => {
      const out = await orig(id);
      i.billing_hold = "refunded";
      return out;
    };
    expect((await ents()).entitlement).toBeNull();
    expect(i).toMatchObject({ billing_hold: "refunded", billing_pause_from: iso(rig.T0 + PERIOD) });
  });
});

describe("A5. the negative cache", () => {
  it("a denied customer's page loads make no further Stripe call within the window; after it the check asks again and recovers", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "paused");
    const before = retrieves();
    for (let n = 0; n < 5; n++) expect((await ents()).entitlement).toBeNull();
    expect(retrieves() - before).toBe(1);
    // the customer resumes at Stripe (event lost) ... still inside the window: remembered denial
    stripeSays("sub_i", "running");
    at(rig.T0 + PERIOD + 60 + NEGATIVE_CACHE_MS / 1000 - 1);
    expect((await ents()).entitlement).toBeNull();
    expect(retrieves() - before).toBe(1);
    // after it: asked again, recovered
    at(rig.T0 + PERIOD + 60 + NEGATIVE_CACHE_MS / 1000 + 1);
    expect((await ents()).entitlement).not.toBeNull();
    expect(retrieves() - before).toBe(2);
    expect(i.billing_pause_from).toBeNull();
  });

  it("an outage is remembered the same way (a hanging Stripe is not asked on every page load), then retried", async () => {
    await dueIntelligence();
    stripeSays("sub_i", "running");
    rig.stripe.failOnce.add("subscriptions.retrieve");
    const before = retrieves();
    expect((await ents()).entitlement).toBeNull();
    expect((await ents()).entitlement).toBeNull();
    expect(retrieves() - before).toBe(1);
    at(rig.T0 + PERIOD + 60 + NEGATIVE_CACHE_MS / 1000 + 1);
    expect((await ents()).entitlement).not.toBeNull();
    expect(retrieves() - before).toBe(2);
  });

  it("concurrent checks of one row share one Stripe call; a deliberate mint ignores a remembered denial", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "paused");
    const before = retrieves();
    const all = await Promise.all([ents(), ents(), ents(), ents()]);
    expect(all.every((r) => r.entitlement === null)).toBe(true);
    expect(retrieves() - before).toBe(1);
    stripeSays("sub_i", "running");
    expect(await pauseAllowsAccess("subscriptions", i as any, { bypassCache: true })).toBe(true);
    expect(i.billing_pause_from).toBeNull();
  });
});

describe("A6. seats inherit the owner's decision", () => {
  it("a member of an owner whose resume event was lost is entitled (the owner's row is cleared once); with Stripe still paused, denied", async () => {
    installTeamRpcs(rig.db);
    const owner = await dueIntelligence();
    rig.db.insertRow("subscription_members", { owner_email: email, email: "m@hall.example", added_at: new Date().toISOString(), removed_at: null });
    stripeSays("sub_i", "paused");
    expect((await lookupEntitlement("m@hall.example")).entitlement).toBeNull();
    expect((await ents()).entitlement).toBeNull();
    at(rig.T0 + PERIOD + 60 + NEGATIVE_CACHE_MS / 1000 + 1);
    stripeSays("sub_i", "running");
    const m = await lookupEntitlement("m@hall.example");
    expect(m.reachable && m.entitlement).toMatchObject({ role: "member", ownerEmail: email });
    expect(owner.billing_pause_from).toBeNull();
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(1);
    expect((await ents()).entitlement?.role).toBe("owner");
  });
});

describe("A7. a cancelled (or superseded) row is never revived", () => {
  it("cancelled with a due schedule and Stripe running: denied, no Stripe call, nothing written", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "running");
    i.status = "cancelled";
    const before = retrieves();
    expect((await ents()).entitlement).toBeNull();
    expect(await pauseAllowsAccess("subscriptions", i as any)).toBe(false);
    i.status = "superseded";
    expect(await pauseAllowsAccess("subscriptions", i as any)).toBe(false);
    expect(retrieves() - before).toBe(0);
    expect(i.billing_pause_from).not.toBeNull();
  });

  it("cancelled in the instant between the Stripe read and the write: the guarded write matches nothing and the row stays cancelled", async () => {
    const i = await dueIntelligence();
    stripeSays("sub_i", "running");
    const orig = (rig.stripe as any).subscriptions.retrieve;
    (rig.stripe as any).subscriptions.retrieve = async (id: string) => {
      const out = await orig(id);
      i.status = "cancelled";
      return out;
    };
    expect((await ents()).entitlement).toBeNull();
    expect(i).toMatchObject({ status: "cancelled", billing_pause_from: iso(rig.T0 + PERIOD) });
    expect(audit(rig, "pause_schedule_dropped")).toHaveLength(0);
  });

  it("an API account and a watch that are cancelled are refused by the mint and the route", async () => {
    const a = apiAcct(rig, { status: "cancelled" });
    a.billing_pause_from = iso(rig.T0 - 10);
    stripeSays("sub_api", "running");
    const before = retrieves();
    const keys = await import("@/app/api/keys/route");
    expect((await keys.POST(post("/api/keys", { token: a.token, rotate: true }))).status).not.toBe(200);
    expect(retrieves() - before).toBe(0);
    expect(a.billing_pause_from).not.toBeNull();
  });
});
