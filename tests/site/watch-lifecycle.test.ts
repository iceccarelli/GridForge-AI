/**
 * Hall Watch, purchase to cron, end to end on MOCKS: the PostgREST fake stands in for the database (with the `or=` filter
 * dueWatches() really uses), a scripted stand-in is the engine and mail is intercepted. It proves the CONTROL FLOW of the
 * scheduler path locally. It does NOT prove that Vercel invokes /api/cron/watches on the schedule in vercel.json
 * ("0 7 * * 1"), that CRON_SECRET is set on the deployment, that the deployed engine answers /v1/diff the way the stand-in
 * does, or that the mail provider delivers to an inbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { NOTICE_MAX_ATTEMPTS } from "@/lib/watch-notices";
import { PostgrestFake } from "./postgrest-fake";
import { paidSession } from "./checkout-fixture";

(globalThis as { React?: unknown }).React = React;
const sent: { to: string; subject: string; text: string; idempotencyKey?: string }[] = [];
const operator: { subject: string; text: string }[] = [];
let mailFailure: null | { category: string; status?: number } = null;
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  sendMail: async (m: { to: string; subject: string; text: string; idempotencyKey?: string }) => {
    if (mailFailure) return { sent: false, reason: "refused", ...mailFailure };
    sent.push(m);
    return { sent: true, id: "m1" };
  },
  notifyOperator: async (subject: string, text: string) => { operator.push({ subject, text }); return { sent: true, id: "o" }; },
}));

const ENGINE = "http://engine.test";
const WH = "whsec_watch_lifecycle_secret";
let db: PostgrestFake;
let restore: () => void;
let restoreEngine: () => void;
let engineBodies: Record<string, any>[];
let engineMode: "ok" | "down";
let racks = 40;

function installEngine() {
  const pg = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (!url.startsWith(ENGINE)) return pg(i as RequestInfo, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    engineBodies.push({ url, ...body });
    vi.setSystemTime(Date.now() + engineStepMs);
    if (engineMode === "down") return new Response(JSON.stringify({ error: "down" }), { status: 502 });
    return new Response(
      JSON.stringify({ headline: `Racks ${racks}`, material: true, racks_delta: 4, weeks_delta: null,
        binding_moved: false, after: { racks }, document: "<p>n</p>", ...diffExtra }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return () => { globalThis.fetch = pg; };
}
let engineStepMs = 0;
/** Extra keys on the engine's /v1/diff answer (the date-basis keys of the physics change). */
let diffExtra: Record<string, unknown> = {};

const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const stripe = new Stripe("sk_test_placeholder");
function stripeEvent(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } });
  return new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload });
}
const hook = async (r: Request) => (await import("@/app/api/stripe/webhook/route")).POST(r);
const buy = (sub = "sub_1", email = "buyer@hall.example") => hook(stripeEvent("checkout.session.completed", paidSession({ id: `cs_${sub}`, customer_email: email, customer: "cus_1", subscription: sub, amount_total: 600_000, metadata: { kind: "hall_watch", company: "Hall Co" } })));
const failedPayment = (sub = "sub_1") => hook(stripeEvent("invoice.payment_failed", { id: "in_1", object: "invoice", subscription: sub }));
const paidInvoice = (sub = "sub_1") => hook(stripeEvent("invoice.paid", { id: "in_2", object: "invoice", subscription: sub }));
const cancelled = (sub = "sub_1") => hook(stripeEvent("customer.subscription.deleted", { id: sub, object: "subscription", metadata: { kind: "hall_watch" } }));
const watch = (sub = "sub_1") => db.rows("watches").find((r: any) => r.stripe_subscription_id === sub) as any;
const auth = { authorization: "Bearer cron-secret-value" };
const runCron = async () => (await (await import("@/app/api/cron/watches/route")).GET(new Request(siteUrl("/api/cron/watches"), { headers: auth }))).json() as Promise<any>;
const runSweep = async () => (await (await import("@/app/api/cron/engagements/route")).GET(new Request(siteUrl("/api/cron/engagements"), { headers: auth }))).json() as Promise<any>;
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const submit = async (token: string, over: Record<string, unknown> = {}) => (await import("@/app/api/watch/[token]/route")).POST(new Request(siteUrl("/x"), { method: "POST", body: JSON.stringify({ ...INTAKE, ...over }) }), ctx(token));
const notes = () => db.rows("watch_notes") as any[];
const notices = () => db.rows("watch_note_notices") as any[];
const makeDue = (sub = "sub_1") => { watch(sub).next_run_at = new Date(Date.now() - 60_000).toISOString(); };
/** A watch that has been through its first submission and is now due. */
async function started(sub = "sub_1") {
  await buy(sub);
  expect((await submit(watch(sub).token)).status).toBe(200);
  makeDue(sub);
  operator.length = 0;                                   // the founder's "new purchase" notice is not what is under test
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "k";
  process.env.CRON_SECRET = "cron-secret-value";
  delete process.env.WATCH_CRON_BUDGET_MS;
  sent.length = 0; operator.length = 0; engineBodies = []; engineMode = "ok"; mailFailure = null; racks = 40; engineStepMs = 0; diffExtra = {};
  db = new PostgrestFake(["watches", "watch_notes", "watch_note_notices", "customer_notifications", "leads", "deliverables", "api_accounts", "subscriptions", "deliverables"]);
  db.uniqueKeys.set("watches", [["stripe_subscription_id"]]);
  db.uniqueKeys.set("watch_note_notices", [["watch_note_id"]]);
  // the column defaults of 0030
  db.rowDefaults.set("watch_note_notices", () => ({ status: "pending", attempts: 0, next_attempt_at: new Date().toISOString() }));
  restore = db.install();
  restoreEngine = installEngine();
});
afterEach(() => { restoreEngine(); restore(); vi.useRealTimers(); });

describe("purchase -> initial state", () => {
  it("opens one active watch with no numbers yet; a redelivered payment opens no second one", async () => {
    expect((await buy()).status).toBe(200);
    expect((await buy()).status).toBe(200);
    expect(db.rows("watches")).toHaveLength(1);
    expect(watch()).toMatchObject({ status: "active", cadence: "quarterly" });
    expect(watch().intake ?? null).toBeNull();
    expect(watch().last_state ?? null).toBeNull();
  });

  it("the buyer's FIRST submission starts the watch: it records a baseline, not an error — THE regression", async () => {
    await buy();
    const res = await submit(watch().token);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as any).baseline).toBe(true);
    expect(watch().last_state).toEqual({ racks: 40 });
    expect(watch().intake).toBeTruthy();
    expect(new Date(watch().next_run_at).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);   // about a quarter ahead
    // a baseline is a baseline: no "the answer moved" headline, no email
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ trigger: "baseline", material: false, racks_delta: null });
    expect(sent).toHaveLength(0);
  });

  it("nothing is due before there are numbers, and a watch that was never started is not run", async () => {
    await buy();
    watch().next_run_at = new Date(Date.now() - 60_000).toISOString();
    const out = await runCron();
    expect(out.considered).toBe(0);
    expect(engineBodies).toHaveLength(0);
  });
});

describe("the scheduled run (/api/cron/watches)", () => {
  it("re-solves a due watch, stores the change note, advances state and tells the buyer", async () => {
    await started();
    racks = 44;
    const out = await runCron();
    expect(out).toMatchObject({ ok: true, considered: 1, budget_exhausted: false });
    expect(out.results[0].status).toBe("changed");
    expect(watch().last_state).toEqual({ racks: 44 });
    expect(new Date(watch().next_run_at).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
    const note = notes().find((n) => n.trigger === "scheduled");
    expect(note).toMatchObject({ material: true, racks_delta: 4 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("buyer@hall.example");
    expect(sent[0].text).toContain(`/watch/${watch().token}`);
    expect(sent[0].idempotencyKey).toBe(`watch-note-${note.id}`);
    expect(notices()).toEqual([expect.objectContaining({ watch_note_id: note.id, status: "sent", attempts: 1 })]);
  });

  it("does not run a watch that is not yet due, and an immediate second run does nothing", async () => {
    await started();
    watch().next_run_at = new Date(Date.now() + 5 * 86_400_000).toISOString();
    expect((await runCron()).considered).toBe(0);
    makeDue();
    expect((await runCron()).considered).toBe(1);
    expect((await runCron()).considered).toBe(0);
    expect(notes().filter((n) => n.trigger === "scheduled")).toHaveLength(1);
  });

  it("a client re-run on updated numbers records its own note and moves the next scheduled run out", async () => {
    await started();
    racks = 48;
    const res = await submit(watch().token, { positionsAvailable: 200 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(notes().map((n) => n.trigger)).toEqual(["baseline", "inputs_updated"]);
    expect(watch().last_state).toEqual({ racks: 48 });
    expect(new Date(watch().next_run_at).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
  });

  it("an engine that is down fails the run visibly: nothing advances, the operator is paged, the watch is pushed back", async () => {
    await started();
    engineMode = "down";
    const out = await runCron();
    expect(out.results[0].status).toMatch(/^engine_error/);
    expect(watch().last_state).toEqual({ racks: 40 });
    expect(notes().filter((n) => n.trigger === "scheduled")).toHaveLength(0);
    expect(operator).toHaveLength(1);
    expect(operator[0].subject).toMatch(/needs attention — 1 failed/);
    expect(operator[0].text).toMatch(/weekly: a watch that failed is not retried until the next scheduled run/);
    expect(new Date(watch().next_run_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("a change note's email is a retried obligation, not a log line", () => {
  it("a refused send leaves a pending obligation; the sweep retries it when due, once, and stops", async () => {
    await started();
    mailFailure = { category: "provider_error", status: 503 };
    await runCron();
    const note = notes().find((n) => n.trigger === "scheduled");
    expect(notices()).toEqual([expect.objectContaining({ watch_note_id: note.id, status: "pending", attempts: 1, last_error: "provider_error" })]);
    expect(new Date(notices()[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // not due yet: the sweep leaves it alone
    expect((await runSweep()).watch_notices).toMatchObject({ retry: 0, sent: 0 });
    expect(notices()[0].attempts).toBe(1);

    // due, provider back: delivered, with the same idempotency key so a retry cannot double-send
    mailFailure = null;
    notices()[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    expect((await runSweep()).watch_notices).toMatchObject({ sent: 1 });
    expect(notices()[0]).toMatchObject({ status: "sent", attempts: 2 });
    expect(sent.map((m) => m.idempotencyKey)).toEqual([`watch-note-${note.id}`]);
    expect((await runSweep()).watch_notices).toMatchObject({ sent: 0, retry: 0 });
    expect(sent).toHaveLength(1);
  });

  it("gives up after the bounded number of attempts and pages a person, once", async () => {
    await started();
    mailFailure = { category: "provider_error", status: 503 };
    await runCron();
    for (let i = 1; i < NOTICE_MAX_ATTEMPTS; i++) {
      notices()[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
      await runSweep();
    }
    expect(notices()[0]).toMatchObject({ status: "abandoned", attempts: NOTICE_MAX_ATTEMPTS });
    const pages = operator.filter((o) => /change note could not be emailed/.test(o.subject));
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toMatch(/stored and is on the buyer's watch page/);
    await runSweep();
    expect(operator.filter((o) => /change note could not be emailed/.test(o.subject))).toHaveLength(1);
  });

  it("a permanent refusal is abandoned at once, not retried for days", async () => {
    await started();
    mailFailure = { category: "rejected", status: 422 };
    await runCron();
    expect(notices()[0]).toMatchObject({ status: "abandoned", attempts: 1 });
  });

  it("two overlapping sweeps send it once", async () => {
    await started();
    mailFailure = { category: "provider_error", status: 503 };
    await runCron();
    mailFailure = null;
    notices()[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await Promise.all([runSweep(), runSweep()]);
    expect(sent).toHaveLength(1);
  });

  it("works before migration 0030 is applied: one direct attempt, as before", async () => {
    await started();
    db.dropTable("watch_note_notices");
    await runCron();
    expect(sent).toHaveLength(1);
  });
});

describe("payment failure pauses it, cancellation stops it", () => {
  it("a failed payment pauses the watch: it is not run, not re-solved on request, and says why — and a paid invoice resumes it", async () => {
    await started();
    expect((await failedPayment()).status).toBe(200);
    expect(watch().status).toBe("paused");
    expect((await runCron()).considered).toBe(0);
    expect(engineBodies.length).toBe(2);                            // only the two baseline calls from starting it
    const before = engineBodies.length;
    const res = await submit(watch().token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/paused because the last payment did not clear/);
    expect(engineBodies.length).toBe(before);
    const { default: Page } = await import("@/app/watch/[token]/page");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: watch().token }) }));
    expect(html).toContain("paused because the last payment did not clear");
    expect(html).not.toContain("Re-solve the hall");

    expect((await paidInvoice()).status).toBe(200);
    expect(watch().status).toBe("active");
    expect((await runCron()).considered).toBe(1);
  });

  it("cancellation stops runs for good and a late paid-invoice does not revive it", async () => {
    await started();
    expect((await cancelled()).status).toBe(200);
    expect(watch().status).toBe("cancelled");
    expect((await runCron()).considered).toBe(0);
    await paidInvoice();
    expect(watch().status).toBe("cancelled");
    expect((await runCron()).considered).toBe(0);
    expect((await submit(watch().token)).status).toBe(409);
    const { default: Page } = await import("@/app/watch/[token]/page");
    expect(renderToStaticMarkup(await Page({ params: Promise.resolve({ token: watch().token }) }))).toContain("This watch was cancelled");
  });
});

describe("the run drains everything due, or pages a person", () => {
  async function many(count: number) {
    for (let i = 0; i < count; i++) {
      await buy(`sub_m${i}`, `m${i}@hall.example`);
      watch(`sub_m${i}`).intake = { siteName: `H${i}` };
      watch(`sub_m${i}`).last_state = { racks: 40 };
      makeDue(`sub_m${i}`);
    }
    operator.length = 0;
  }

  it("runs more than the 25 it used to stop at", async () => {
    await many(30);
    racks = 41;
    const out = await runCron();
    expect(out.considered).toBe(30);
    expect(out.results.filter((r: any) => r.status === "changed")).toHaveLength(30);
    expect(out.remaining).toBe(0);
    expect(out.budget_exhausted).toBe(false);
    expect(operator).toHaveLength(0);
    expect(db.rows("watches").every((w: any) => new Date(w.next_run_at).getTime() > Date.now())).toBe(true);
  }, 30_000);

  it("a run that cannot finish inside its budget starts no new watch past it, says how many are left, and pages", async () => {
    await many(6);
    process.env.WATCH_CRON_BUDGET_MS = "100000";
    engineStepMs = 30_000;                                           // each engine call takes 30 s of the 100 s budget
    const out = await runCron();
    expect(out.budget_exhausted).toBe(true);
    expect(out.considered).toBeGreaterThan(0);
    expect(out.considered).toBeLessThan(6);
    expect(out.remaining).toBe(6 - out.considered);
    expect(operator).toHaveLength(1);
    expect(operator[0].text).toMatch(new RegExp(`${out.remaining} due watch\\(es\\) not started`));
    // the ones not reached are still due: the next run picks them up
    const stillDue = db.rows("watches").filter((w: any) => new Date(w.next_run_at).getTime() <= Date.now()).length;
    expect(stillDue).toBe(out.remaining);
  }, 30_000);
});

describe("the watch page is honest about what it can do", () => {
  it("states the re-run limit and that a scheduled run can follow its date by up to a week", async () => {
    await started();
    const { default: Page } = await import("@/app/watch/[token]/page");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: watch().token }) }));
    expect(html).toMatch(/limited to 20 an hour/);
    expect(html).toMatch(/by up to a week/);
    expect(html).toContain("baseline");
  });
});

describe("'Cancel any time' has a path: manage or cancel the subscription", () => {
  const pageOf = async (token: string) => {
    const { default: Page } = await import("@/app/watch/[token]/page");
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
  };

  it("an active and a paused watch show the control with honest copy; a cancelled one does not", async () => {
    await started();
    let html = await pageOf(watch().token);
    expect(html).toContain("Manage or cancel subscription");
    expect(html).toContain("Cancelling is handled by Stripe");
    expect(html).toContain("Nothing is cancelled by opening the portal");
    expect(html).toContain("scheduled runs stop");
    await failedPayment();
    html = await pageOf(watch().token);
    expect(html).toContain("Manage or cancel subscription");
    await cancelled();
    html = await pageOf(watch().token);
    expect(html).not.toContain("Manage or cancel subscription");
  });

  it("opens the portal route with this watch's token and follows only a real https URL", async () => {
    const { requestPortal } = await import("@/components/WatchManage");
    const calls: { url: string; body: string }[] = [];
    const ok = (async (u: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(u), body: String(init?.body) }); return new Response(JSON.stringify({ ok: true, url: "https://billing.stripe.com/p/session_1" }), { status: 200 }); }) as typeof fetch;
    expect(await requestPortal("tok123", ok)).toEqual({ url: "https://billing.stripe.com/p/session_1" });
    expect(calls).toEqual([{ url: "/api/billing/portal", body: JSON.stringify({ token: "tok123" }) }]);
    const evil = (async () => new Response(JSON.stringify({ url: "javascript:alert(1)" }), { status: 200 })) as typeof fetch;
    expect(await requestPortal("t", evil)).toEqual({ message: "We could not open the billing portal just now." });
  });

  it("degrades to 'email us' when the route is not deployed (404), refuses, or cannot be reached — never pretending it cancelled", async () => {
    const { requestPortal } = await import("@/components/WatchManage");
    expect(await requestPortal("t", (async () => new Response("{}", { status: 404 })) as typeof fetch))
      .toEqual({ message: "Self-service cancellation is not available on this deployment yet." });
    expect(await requestPortal("t", (async () => new Response(JSON.stringify({ error: "This watch is already cancelled." }), { status: 409 })) as typeof fetch))
      .toEqual({ message: "This watch is already cancelled." });
    expect(await requestPortal("t", (async () => { throw new Error("offline"); }) as typeof fetch))
      .toEqual({ message: "We could not reach the billing portal just now." });
  });

  it("the email fallback names the real contact address", async () => {
    const { WatchManage } = await import("@/components/WatchManage");
    const { SITE } = await import("@/lib/site");
    expect(renderToStaticMarkup(React.createElement(WatchManage, { token: "t", email: SITE.email }))).toContain("Manage or cancel subscription");
    expect(SITE.email).toBe("power@timetopower.ai");
  });
});

describe("a weeks figure always wears what it rests on (lib/date-basis.ts)", () => {
  const ASSUMED = {
    headline: "+40 weeks to full capacity (assumed lead time, not a date)", weeks_delta: 40,
    date_basis: "assumed", date_evidence_class: "E0", date_binding_item: "Transformer capacity",
    date_label: "assumed lead time, not a date (E0; set by Transformer capacity)",
  };
  const pageOf = async (token: string) => {
    const { default: Page } = await import("@/app/watch/[token]/page");
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
  };

  it("stores the date-basis keys with the change, and the email and the page print the labelled figure", async () => {
    await started();
    diffExtra = ASSUMED;
    await runCron();
    const note = notes().find((n) => n.trigger === "scheduled");
    expect(note.weeks_delta).toBe(40);
    expect(note.change).toMatchObject({ date_basis: "assumed", date_evidence_class: "E0", date_binding_item: "Transformer capacity",
      date_label: "assumed lead time, not a date (E0; set by Transformer capacity)" });
    const m = sent.find((x) => x.idempotencyKey === `watch-note-${note.id}`)!;
    expect(m.text).toContain("Time to full capacity: +40 wk (assumed lead time, not a date (E0; set by Transformer capacity))");
    expect(await pageOf(watch().token)).toContain("Time to full capacity: +40 wk (assumed lead time, not a date (E0; set by Transformer capacity))");
  });

  it("a retried email carries the same labelled figure", async () => {
    await started();
    diffExtra = ASSUMED;
    mailFailure = { category: "provider_error", status: 503 };
    await runCron();
    mailFailure = null;
    notices()[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await runSweep();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Time to full capacity: +40 wk (assumed lead time, not a date (E0; set by Transformer capacity))");
  });

  it("a note built from an older stored diff (no date keys) says 'lead time unverified' and shows NO number of weeks", async () => {
    await started();
    const w = watch();
    db.seed("watch_notes", [{ watch_id: w.id, material: true, headline: "+12 weeks to full capacity", racks_delta: 2, weeks_delta: 12,
      change: { headline: "+12 weeks to full capacity", weeks_delta: 12 }, trigger: "scheduled", created_at: new Date().toISOString() }]);
    const html = await pageOf(w.token);
    expect(html).toContain("Time to full capacity: lead time unverified");
    expect(html).not.toContain("12 wk");
    const old = notes().find((n) => n.weeks_delta === 12);
    db.rows("watch_note_notices").push({ id: "n1", watch_note_id: old.id, watch_id: w.id, status: "pending", attempts: 0, next_attempt_at: new Date(0).toISOString() });
    await runSweep();
    const mail = sent.find((x) => x.idempotencyKey === `watch-note-${old.id}`)!;
    expect(mail.text).toContain("Time to full capacity: lead time unverified");
    expect(mail.text).not.toContain("12 wk");
  });

  it("no weeks figure, no weeks line; a supported basis keeps the engine's label; a 'none' basis prints no number", async () => {
    const { weeksLine } = await import("@/lib/watches");
    expect(weeksLine({ weeks_delta: null, change: { date_basis: "assumed", date_label: "x" } })).toBeNull();
    expect(weeksLine({ weeks_delta: -3, change: { date_basis: "supported", date_evidence_class: "E4", date_label: "lead times of class E4 at best" } }))
      .toBe("-3 wk (lead times of class E4 at best)");
    expect(weeksLine({ weeks_delta: 5, change: { date_basis: "none", date_label: "no date: nothing is deployable or a lead time on the path is missing" } }))
      .toBe("no date: nothing is deployable or a lead time on the path is missing");
    expect(weeksLine({ weeks_delta: 5, change: null })).toBe("lead time unverified");
  });

  it("the watch API shows the labelled figure too", async () => {
    await started();
    diffExtra = ASSUMED;
    await runCron();
    const { GET } = await import("@/app/api/watch/[token]/route");
    const body: any = await (await GET(new Request(siteUrl("/x")), ctx(watch().token))).json();
    expect(body.notes.find((n: any) => n.trigger === "scheduled").weeks).toBe("+40 wk (assumed lead time, not a date (E0; set by Transformer capacity))");
  });
});
