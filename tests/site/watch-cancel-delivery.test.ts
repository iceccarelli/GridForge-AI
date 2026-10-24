/**
 * A Hall Watch that is cancelled (or held) receives NO further delivery, through the real cron route.
 *
 * Labels: FAKE STORE (tests/site/postgrest-fake.ts, with the same `dueWatches` stand-in as watch-cron.test.ts because the fake has no
 * `or=` operator), MOCK ENGINE (a fetch interceptor for /v1/diff), MAIL SINK (sendMail is stubbed; nothing leaves the process). The
 * races are produced by the interceptor changing the watch's row at the exact point named in each test, which is what a webhook
 * landing in the middle of a run does. NOT PROVEN here: overlap between two real processes against PostgreSQL (the claim and the
 * conditional writes are single conditional UPDATEs, `status=eq.active`, whose semantics are PostgreSQL's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const sent: { to: string; subject: string }[] = [];
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  sendMail: async (m: { to: string; subject: string }) => { sent.push(m); return { sent: true, id: "m1" }; },
}));
// dueWatches() uses `or=`, which the fake lacks: list what it would (status active, due) and keep every other function real.
let dueOverride: (() => unknown[]) | null = null;
vi.mock("@/lib/watches", async (orig) => {
  const real = await orig<typeof import("@/lib/watches")>();
  return { ...real, dueWatches: async () => (dueOverride ? dueOverride() : real.dueWatches()) };
});

const ENGINE = "http://engine.test";
const WH = "whsec_watch_cancel";
let db: PostgrestFake;
let restore: () => void;
let restoreEngine: () => void;
let engineCalls: number;
/** Runs inside the engine call (the run is in flight): the place a cancellation can land. */
let duringEngine: (() => void) | null = null;
/** Runs after a successful write to this table by this method (the next step of the run is about to start). */
let afterWrite: { table: string; method: string; nth?: number; fn: () => void } | null = null;

function install() {
  const pg = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith(ENGINE)) {
      engineCalls++;
      duringEngine?.();
      return new Response(JSON.stringify({ headline: "Racks moved", material: true, racks_delta: 4, weeks_delta: 2, binding_moved: false, after: { racks: 44 }, document: "<p>n</p>" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const res = await pg(i as RequestInfo, init);
    const method = (init?.method ?? "GET").toUpperCase();
    if (afterWrite && res.ok && method === afterWrite.method && url.includes(`/rest/v1/${afterWrite.table}`)) {
      if ((afterWrite.nth ?? 1) > 1) afterWrite.nth = (afterWrite.nth ?? 1) - 1;
      else {
        const fn = afterWrite.fn;
        afterWrite = null;
        fn();
      }
    }
    return res;
  }) as typeof fetch;
  return () => { globalThis.fetch = pg; };
}

const past = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
function seedWatch(token: string, over: Record<string, unknown> = {}) {
  db.seed("watches", [{ id: `id-${token}`, token, status: "active", cadence: "quarterly", email: `${token}@hall.example`, intake: { siteName: "H" }, last_state: { racks: 40 }, next_run_at: past(10), stripe_subscription_id: `sub_${token}`, ...over }]);
}
const watch = (t: string) => db.rows("watches").find((r: any) => r.token === t) as any;
const cancel = (t: string) => { watch(t).status = "cancelled"; };
const auth = { authorization: "Bearer cron-secret-value" };
const run = async () => (await (await import("@/app/api/cron/watches/route")).GET(new Request(siteUrl("/api/cron/watches"), { headers: auth }))).json();

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", GRIDFORGE_API_URL: ENGINE, GRIDFORGE_API_KEY: "k", CRON_SECRET: "cron-secret-value",
    STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sent.length = 0; engineCalls = 0; duringEngine = null; afterWrite = null;
  db = new PostgrestFake(["watches", "watch_notes", "watch_note_notices", "funnel_events", "operator_notices", "api_accounts", "subscriptions"]);
  db.uniqueKeys.set("watch_note_notices", [["watch_note_id"]]);
  db.rowDefaults.set("watch_note_notices", () => ({ status: "pending", attempts: 0, next_attempt_at: new Date(0).toISOString() }));
  restore = db.install();
  restoreEngine = install();
  dueOverride = () => db.rows("watches").filter((r: any) => r.status === "active").sort((a: any, b: any) => String(a.next_run_at).localeCompare(String(b.next_run_at))).map((r: any) => ({ ...r }));
});
afterEach(() => { restoreEngine(); restore(); dueOverride = null; vi.restoreAllMocks(); });

describe("a cancelled Hall Watch receives nothing more", () => {
  it("control: an active watch still runs, stores its note and emails it", async () => {
    seedWatch("a");
    const r = await run();
    expect(r.results[0].status).toBe("changed");
    expect(db.rows("watch_notes")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("cancelled by Stripe's customer.subscription.deleted, then the cron runs: no engine call, no note, no email", async () => {
    seedWatch("a", { stripe_subscription_id: "sub_a" });
    const payload = JSON.stringify({ id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_a", object: "subscription", metadata: { kind: "hall_watch" } } } });
    const sdk = new Stripe("sk_test_placeholder");
    const { POST } = await import("@/app/api/stripe/webhook/route");
    expect((await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }))).status).toBe(200);
    expect(watch("a").status).toBe("cancelled");
    const r = await run();
    expect(r.considered).toBe(0);
    expect(engineCalls).toBe(0);
    expect(db.rows("watch_notes")).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("a due list read BEFORE the cancellation cannot run it: the claim is conditional on the watch still being active", async () => {
    seedWatch("a");
    dueOverride = () => db.rows("watches").map((r: any) => ({ ...r })); // the stale list still names it
    cancel("a");
    const r = await run();
    expect(r.results[0].status).toBe("skipped_claimed_elsewhere");
    expect(engineCalls).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("a hold (paused) is the same: a paused watch is not run", async () => {
    seedWatch("a", { status: "paused", billing_hold: "refunded" });
    const r = await run();
    expect(r.considered).toBe(0);
    expect(engineCalls).toBe(0);
  });

  it("cancelled WHILE the engine is working: no note is stored, state does not advance, nothing is sent", async () => {
    seedWatch("a");
    duringEngine = () => cancel("a");
    const r = await run();
    expect(r.results[0].status).toBe("skipped_inactive");
    expect(db.rows("watch_notes")).toHaveLength(0);
    expect(watch("a").last_state).toEqual({ racks: 40 });
    expect(watch("a").status).toBe("cancelled");
    expect(sent).toHaveLength(0);
    expect(db.rows("watch_note_notices")).toHaveLength(0);
  });

  it("cancelled in the instant after the note is stored: the state write does not overtake the cancellation and the note is not announced", async () => {
    seedWatch("a");
    afterWrite = { table: "watch_notes", method: "POST", fn: () => cancel("a") };
    const r = await run();
    expect(r.results[0].status).toBe("skipped_inactive");
    expect(watch("a").last_state).toEqual({ racks: 40 }); // never advanced
    expect(watch("a").status).toBe("cancelled");
    expect(db.rows("watch_notes")).toHaveLength(1); // rows are never deleted: the stored note stays
    expect(db.rows("watch_note_notices")).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("cancelled after the state advanced but before the announcement: the last look before the email stops it", async () => {
    seedWatch("a");
    // the first PATCH of watches is the claim; the second is the state advance, after which the cancellation lands
    afterWrite = { table: "watches", method: "PATCH", nth: 2, fn: () => cancel("a") };
    const r = await run();
    expect(r.results[0].status).toBe("skipped_inactive");
    expect(watch("a").last_state).toEqual({ racks: 44 }); // the advance had already happened; only the email is withheld
    expect(sent).toHaveLength(0);
    expect(db.rows("watch_note_notices")).toHaveLength(0);
  });

  it("the first run (baseline) racing a cancellation does not write the baseline", async () => {
    seedWatch("a", { last_state: null });
    duringEngine = () => cancel("a");
    const r = await run();
    expect(r.results[0].status).toBe("skipped_inactive");
    expect(watch("a").last_state).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("a store that cannot be asked is not read as 'still active': the run backs off and sends nothing", async () => {
    seedWatch("a");
    duringEngine = () => { db.failMethod = { method: "GET", status: 503, body: JSON.stringify({ message: "outage" }) }; };
    const r = await run();
    db.failMethod = null;
    expect(r.results[0].status).toBe("store_error");
    expect(db.rows("watch_notes")).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("a change note already queued for an email is abandoned when the subscription is cancelled, so the notice sweep sends nothing", async () => {
    seedWatch("a", { stripe_subscription_id: "sub_a" });
    const note = db.insertRow("watch_notes", { watch_id: "id-a", headline: "Racks moved", material: true });
    db.insertRow("watch_note_notices", { watch_note_id: note.id, watch_id: "id-a", status: "pending", attempts: 0, next_attempt_at: past(5) });
    const payload = JSON.stringify({ id: "evt_del2", type: "customer.subscription.deleted", data: { object: { id: "sub_a", object: "subscription", metadata: { kind: "hall_watch" } } } });
    const sdk = new Stripe("sk_test_placeholder");
    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
    const { sweepNotices } = await import("@/lib/watch-notices");
    const out = await sweepNotices();
    expect(out.outcomes.sent).toBe(0);
    expect(sent).toHaveLength(0);
    expect((db.rows("watch_note_notices") as any[])[0]).toMatchObject({ status: "abandoned", last_error: "watch_not_active" });
  });
});
