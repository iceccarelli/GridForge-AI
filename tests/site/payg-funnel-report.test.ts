/**
 * The adoption funnel and unit economics: the closed event vocabulary and its privacy, where each event is really recorded, the admin
 * reports (counts, denominators, null-not-zero rates, measured-vs-derived labels, the `unmeasured` list), and the economics statement.
 * Stripe is signed for real but its API is a MOCK; the engine is a fetch interceptor; the SQL read functions are mirrored in TypeScript
 * (SUPPLEMENTAL: tests/test_payg_migration.py runs the real SQL). No live service is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { accountRef } from "@/lib/payg";
import { FUNNEL_EVENTS, FUNNEL_PROP_KEYS, checkFunnelEvent, recordFunnelEvent } from "@/lib/funnel";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MockStripe, ledgerEvent, mockEngine, newPaygDb, paygAccount, resetSeq, type MockEngine } from "./payg-harness";
import { installProjectRpcs } from "./project-rpc-fake";
import type { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => jar.find((c) => c.name === name) }) }));

const WH = "whsec_funnel_report";
const sdk = new Stripe("sk_test_placeholder");
let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
const NOW = new Date("2026-10-21T08:00:00Z");

beforeEach(() => {
  jar.length = 0;
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH,
    GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
    ADMIN_PASSWORD: "a-long-random-admin-password", RATE_LIMIT_HMAC_KEY: "r".repeat(40), GRIDFORGE_API_KEY: "platform-key",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetSeq();
  resetMemoryLimiter();
  db = newPaygDb();
  for (const t of ["qualifications", "projects", "project_links", "project_evidence", "project_events", "engagement_deposits"]) db.createTable(t);
  db.uniqueKeys.set("projects", [["project_token"]]);
  installProjectRpcs(db);
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  setPaygStripeForTests(new MockStripe());
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); });

const signIn = () => jar.push({ name: "gf_admin", value: adminToken()! });
const events = (name?: string) => (db.rows("funnel_events") as any[]).filter((e) => !name || e.name === name);
const props = (name: string) => events(name).map((e) => e.props);

// --------------------------------------------------------------------------------------------- the closed vocabulary

describe("the funnel vocabulary is closed and privacy-safe", () => {
  it("names and property keys are exactly these (adding one is a deliberate change to this list)", () => {
    expect([...FUNNEL_EVENTS].sort()).toEqual([
      "alert_sent", "allowance_exhausted", "dispute_opened", "engagement_commissioned", "first_charge", "first_engine_use", "free_account_created", "key_minted",
      "payg_enabled", "payment_failed", "project_created", "project_saved_result", "qualify_completed", "qualify_started", "refund_issued",
      "subscription_cancelled", "subscription_started",
    ]);
    expect([...FUNNEL_PROP_KEYS].sort()).toEqual(["account_ref", "amount_cents", "cap_eur", "evidence_class", "kind", "month", "percent", "plan", "reason", "scope", "units"]);
  });

  const HOSTILE = [
    "ops@acme.example", "a@b.c", "Alice Smith", "North Hall Dublin", "free text with spaces", "https://evil.example/x?token=abc", "gfk1.eyJhIjoiYWNtZSJ9.c2ln",
    "n6xB2kq0wVn9mQp3hT7yL4aZ8sJ1cD5eF", "4242 4242 4242 4242", "line\nbreak", "x".repeat(41), "<script>", "'; drop table funnel_events;--", "", "tok_1234567890abcdefghijklmnop",
  ];

  it("NO property of ANY event can carry an email, a token, a site input, card data or free text, whatever the key", () => {
    for (const name of FUNNEL_EVENTS) {
      for (const key of FUNNEL_PROP_KEYS) {
        for (const bad of HOSTILE) {
          expect(checkFunnelEvent(name, { [key]: bad }).ok, `${name}.${key} = ${JSON.stringify(bad)}`).toBe(false);
        }
      }
    }
  });

  it("and no unlisted key can be added, with any value", () => {
    for (const key of ["email", "token", "name", "company", "site", "site_name", "hall", "address", "card", "ip", "user_agent", "comment", "message", "project", "project_name", "inputs", "result", "idem"]) {
      expect(checkFunnelEvent("qualify_completed", { [key]: "E3" }), key).toEqual({ ok: false, reason: "prop_not_allowed" });
    }
  });

  it("the legitimate values still pass (the fence is not a wall)", () => {
    expect(checkFunnelEvent("qualify_completed", { evidence_class: "E3" }).ok).toBe(true);
    expect(checkFunnelEvent("subscription_started", { kind: "intelligence_subscription", plan: "team" }).ok).toBe(true);
    expect(checkFunnelEvent("subscription_cancelled", { kind: "api_scale", reason: "cancellation_requested" }).ok).toBe(true);
    expect(checkFunnelEvent("refund_issued", { amount_cents: 4500 }).ok).toBe(true);
    expect(checkFunnelEvent("qualify_started", {}).ok).toBe(true);
  });

  it("a refused event is never written, and a derived event can be dated when the thing happened", async () => {
    expect(await recordFunnelEvent("qualify_completed", { evidence_class: "someone@example.com" })).toBe(false);
    expect(events()).toHaveLength(0);
    expect(await recordFunnelEvent("first_engine_use", { account_ref: "abc123def456" }, { dedupeKey: "k", at: new Date("2026-09-01T10:00:00Z") })).toBe(true);
    expect(events("first_engine_use")[0].created_at).toBe("2026-09-01T10:00:00.000Z");
  });
});

// ------------------------------------------------------------------------------------------------- where it is recorded

describe("events are recorded at the real points, and carry nothing about the person or the hall", () => {
  const SEVEN = { siteName: "North Hall Dublin", platform: "gb300_nvl72", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180, email: "director@northhall.example", company: "North Hall Ltd", name: "Dee Rector" };
  let engineOk = true;
  function qualifyEngine() {
    process.env.GRIDFORGE_API_URL = "http://engine.test";
    const inner = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = String(i);
      if (!url.startsWith("http://engine.test")) return inner(i as RequestInfo, init);
      if (!engineOk) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({
        platform: { id: "gb300_nvl72", name: "GB300" },
        as_found: { racks: 0, it_load_kW: { value: 1, low: 1, high: 2, unit: "kW", evidence: "E4 modelled from vendor data", label: "x" }, binding_constraint: "Rack feed", domain: "lv", basis: "b" },
        after_relief: { racks: 28, architecture: "full_dlc", then_binds_on: null },
        first_three_constraints: [], intake: { completeness: 0.5 }, notice: "n",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return () => { globalThis.fetch = inner; };
  }
  const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "10.4.4.4" }, body: JSON.stringify(body) });

  it("qualify_started on admission, qualify_completed with the evidence class ONLY; no input, name, email or result in either", async () => {
    const undo = qualifyEngine();
    engineOk = true;
    const { POST } = await import("@/app/api/qualify/route");
    expect((await POST(post("/api/qualify", SEVEN))).status).toBe(200);
    undo();
    expect(props("qualify_started")).toEqual([{}]);
    expect(props("qualify_completed")).toEqual([{ evidence_class: "E4" }]);
    const all = JSON.stringify(events().map((e) => ({ name: e.name, props: e.props })));
    for (const leak of ["North Hall", "northhall", "Dee Rector", "director@", "12", "7.4", "gb300", "Rack feed", "token"]) expect(all, leak).not.toContain(leak);
  });

  it("an engine failure is a start without a completion; an invalid request is neither (it never reached the engine)", async () => {
    const undo = qualifyEngine();
    engineOk = false;
    const { POST } = await import("@/app/api/qualify/route");
    expect((await POST(post("/api/qualify", SEVEN))).status).toBe(502);
    expect((await POST(post("/api/qualify", { nonsense: true }))).status).toBe(422);
    undo();
    expect(events("qualify_started")).toHaveLength(1);
    expect(events("qualify_completed")).toHaveLength(0);
  });

  it("project_created on creation, with no name, token or content", async () => {
    const { POST } = await import("@/app/api/projects/route");
    expect((await POST(post("/api/projects", { project_name: "Confidential Hall 7" }))).status).toBe(201);
    expect((await POST(post("/api/projects", {}))).status).toBeGreaterThanOrEqual(400); // a refused creation is not counted
    expect(props("project_created")).toEqual([{}]);
    expect(JSON.stringify(events())).not.toContain("Confidential");
  });

  let evt = 0;
  async function hook(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({ id: `evt_${++evt}`, type, data: { object } });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
  }
  const checkout = (id: string, kind: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) =>
    hook("checkout.session.completed", { id, object: "checkout_session", customer_email: "buyer@hall.example", customer: "cus_1", amount_total: 450_000, metadata: { kind, company: "Buyer Co", ...meta }, ...extra });

  it("subscription_started (an API plan and an Intelligence plan), once per Stripe subscription however often delivered, kind only", async () => {
    for (let i = 0; i < 3; i++) expect((await checkout("cs_api", "api_scale", { subscription: "sub_api" })).status).toBe(200);
    expect((await checkout("cs_int", "intelligence_subscription", { subscription: "sub_int" }, { plan: "team" })).status).toBe(200);
    expect(props("subscription_started")).toEqual([{ kind: "api_scale" }, { kind: "intelligence_subscription", plan: "team" }]);
    const all = JSON.stringify(events());
    for (const leak of ["buyer@", "Buyer Co", "cus_1", "sub_api", "cs_api"]) expect(all, leak).not.toContain(leak);
  });

  it("engagement_commissioned: the catalogue kind only, once per session", async () => {
    for (let i = 0; i < 2; i++) expect((await checkout("cs_eng", "density_screen")).status).toBe(200);
    expect(props("engagement_commissioned")).toEqual([{ kind: "density_screen" }]);
    expect(JSON.stringify(events())).not.toMatch(/450000|buyer|Buyer/);
  });

  it("subscription_cancelled carries the kind and Stripe's own fixed reason, never the free-text comment", async () => {
    await checkout("cs_api2", "api_triage", { subscription: "sub_x" });
    const object = { id: "sub_x", object: "subscription", metadata: {}, cancellation_details: { reason: "cancellation_requested", comment: "too expensive, call me at 0123456789 or mail boss@corp.example", feedback: "too_expensive" } };
    expect((await hook("customer.subscription.deleted", object)).status).toBe(200);
    await hook("customer.subscription.deleted", object);
    expect(props("subscription_cancelled")).toEqual([{ kind: "api_triage", reason: "cancellation_requested" }]);
    expect(JSON.stringify(events())).not.toMatch(/expensive|boss@|0123456789|feedback/);
    // a reason outside Stripe's fixed set is dropped, not invented or copied
    await checkout("cs_api3", "api_triage", { subscription: "sub_y" });
    await hook("customer.subscription.deleted", { id: "sub_y", object: "subscription", metadata: {}, cancellation_details: { reason: "some free text reason" } });
    expect(props("subscription_cancelled")[1]).toEqual({ kind: "api_triage" });
  });

  it("subscription payment failure is counted once per invoice; refunds and disputes are counted when Stripe sends them, with amount and its reason code only", async () => {
    await checkout("cs_api4", "api_scale", { subscription: "sub_f" });
    for (let i = 0; i < 3; i++) await hook("invoice.payment_failed", { id: "in_f1", object: "invoice", subscription: "sub_f" });
    expect(props("payment_failed")).toEqual([{ kind: "subscription" }]);
    await hook("charge.refunded", { id: "ch_1", object: "charge", amount_refunded: 4500, customer: "cus_1", billing_details: { email: "buyer@hall.example" }, description: "private" });
    await hook("charge.refunded", { id: "ch_1", object: "charge", amount_refunded: 4500 });
    await hook("charge.dispute.created", { id: "dp_1", object: "dispute", amount: 9000, reason: "fraudulent", evidence: { customer_email_address: "buyer@hall.example" } });
    expect(props("refund_issued")).toEqual([{ amount_cents: 4500 }]);
    expect(props("dispute_opened")).toEqual([{ amount_cents: 9000, reason: "fraudulent" }]);
    expect(JSON.stringify(events())).not.toMatch(/buyer@|private|cus_1/);
  });

  it("first_engine_use is derived from the ledger: once per account, dated when the first charge that stood happened", async () => {
    paygAccount(db, { account: "used-1" });
    paygAccount(db, { account: "unused-1", token: "tok-unused-0123456789abcdefghij" });
    db.rows("usage_events").push(
      { event_id: "e1", seq: 1, account: "used-1", scope: "payg", kind: "charge", units: 5, occurred_at: "2026-09-10T12:00:00.000Z", ref: "" },
      { event_id: "e2", seq: 2, account: "used-1", scope: "payg", kind: "charge", units: 5, occurred_at: "2026-09-20T12:00:00.000Z", ref: "" },
      // a charge refunded in full is not use
      { event_id: "e3", seq: 3, account: "unused-1", scope: "payg", kind: "charge", units: 5, occurred_at: "2026-09-11T12:00:00.000Z", ref: "" },
      { event_id: "e4", seq: 4, account: "unused-1", scope: "payg", kind: "refund", units: 5, occurred_at: "2026-09-11T12:00:01.000Z", ref: "e3" },
    );
    const { deriveFirstUse } = await import("@/lib/payg-analytics");
    expect(await deriveFirstUse()).toEqual({ considered: 1, recorded: 1 });
    expect(await deriveFirstUse()).toEqual({ considered: 1, recorded: 0 });
    expect(events("first_engine_use")).toHaveLength(1);
    expect(events("first_engine_use")[0]).toMatchObject({ props: { account_ref: accountRef("used-1") }, created_at: "2026-09-10T12:00:00.000Z" });
  });

  it("allowance_exhausted is derived at ingest from used >= cap: once per account and month, for the free allowance and for a customer's cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      paygAccount(db, { account: "free-x", token: "tok-freex-0123456789abcdefghij", plan: "api_free", cap_units: null, monthly_units: 25 });
      paygAccount(db, { account: "pay-x", token: "tok-payx-0123456789abcdefghijk", cap_units: 50 });
      paygAccount(db, { account: "partial", token: "tok-part-0123456789abcdefghijk", cap_units: 50 });
      const use = (account: string, units: number, n: number) => db.rows("usage_events").push({ event_id: `u${n}`, seq: n, account, scope: "payg", kind: "charge", units, occurred_at: "2026-10-05T10:00:00.000Z", ref: "" });
      use("free-x", 25, 1); use("pay-x", 50, 2); use("partial", 49, 3);
      const { sendUsageAlerts } = await import("@/lib/payg-alerts");
      await sendUsageAlerts(NOW);
      await sendUsageAlerts(NOW);
      const got = events("allowance_exhausted").map((e) => e.props).sort((a, b) => (a.plan < b.plan ? -1 : 1));
      expect(got).toEqual([
        { plan: "api_free", month: "2026-10", account_ref: accountRef("free-x") },
        { plan: "api_payg", month: "2026-10", account_ref: accountRef("pay-x") },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------------------------------------------- the funnel report

describe("funnelReport: counts, denominators, rates, labels", () => {
  const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  function ev(name: string, props: Record<string, unknown>, at: string) { db.insertRow("funnel_events", { name, props, dedupe_key: null, created_at: at }); }
  function usage(account: string, isoDates: string[]) {
    let n = db.rows("usage_events").length;
    for (const d of isoDates) db.rows("usage_events").push({ event_id: `x${++n}${account}`, seq: 100000 + n, account, scope: "payg", kind: "charge", units: 1, occurred_at: d, ref: "" });
  }
  const report = async (days = 30) => (await import("@/lib/payg-analytics")).funnelReport(days, NOW);

  it("with no data every rate is null (never 0%), every count is 0, and every denominator is shown", async () => {
    const r = await report();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const s of r.steps) {
      expect(s.count, s.key).toBe(0);
      expect(s.rate, s.key).toBeNull();
      expect(s.rate === 0, s.key).toBe(false);
    }
    expect(r.steps.find((s) => s.key === "qualify_completed")).toMatchObject({ count: 0, denominator: 0, rate: null });
    expect(r.steps.find((s) => s.key === "key_minted")).toMatchObject({ denominator: 0, rate: null });
    expect(r.allowance_exhausted.rate).toBeNull();
    expect(r.repeat_usage_any.rate).toBeNull();
    expect(r.subscriptions.cancellations_per_start).toBeNull();
    expect(r.qualifier_to_engagement.rate).toBeNull();
    expect(r.retention.cohorts).toEqual([]);
  });

  it("a zero numerator over a real denominator is 0 (we saw them and nobody converted), distinct from null (we saw nobody)", async () => {
    ev("qualify_started", {}, ago(1)); ev("qualify_started", {}, ago(2));
    const r = await report();
    if (!r.ok) throw new Error("report");
    expect(r.steps.find((s) => s.key === "qualify_completed")).toMatchObject({ count: 0, denominator: 2, rate: 0 });
    expect(r.steps.find((s) => s.key === "free_account_created")!.rate).toBeNull(); // unlinked: never a rate
  });

  it("the strict cohort funnel: each step counts only accounts that reached every earlier one; sources are labelled", async () => {
    const names = ["a1", "a2", "a3", "a4"];
    for (const n of names) paygAccount(db, { account: n, token: `tok-${n}-0123456789abcdefghijkl` });
    for (const n of names) ev("free_account_created", { plan: "api_free", account_ref: accountRef(n) }, ago(10));
    for (const n of ["a1", "a2", "a3"]) ev("key_minted", { scope: "trial", plan: "api_free", account_ref: accountRef(n) }, ago(9));
    ev("key_minted", { scope: "trial", plan: "api_free", account_ref: accountRef("a1") }, ago(8)); // a rotation: the same account, not another
    usage("a1", ["2026-10-06T10:00:00Z", "2026-10-14T10:00:00Z", "2026-10-15T10:00:00Z"]); // weeks 10-05 and 10-12: two weeks
    usage("a2", ["2026-10-07T10:00:00Z"]);               // one week
    usage("a4", ["2026-10-07T10:00:00Z"]);               // used but never minted a key in the cohort data: not counted past key_minted
    ev("payg_enabled", { cap_eur: 100, account_ref: accountRef("a1") }, ago(7));
    ev("payg_enabled", { cap_eur: 100, account_ref: accountRef("a3") }, ago(7)); // enabled but never used: not counted past first use
    ev("first_charge", { month: "2026-09", account_ref: accountRef("a1") }, ago(3));
    ev("qualify_started", {}, ago(5)); ev("qualify_started", {}, ago(5)); ev("qualify_completed", { evidence_class: "E3" }, ago(5));
    const r = await report();
    if (!r.ok) throw new Error("report");
    const by = Object.fromEntries(r.steps.map((s) => [s.key, s]));
    expect(by.qualify_started).toMatchObject({ count: 2, denominator: null, rate: null, source: "events" });
    expect(by.qualify_completed).toMatchObject({ count: 1, denominator: 2, rate: 0.5, source: "events" });
    expect(by.free_account_created).toMatchObject({ count: 4, rate: null, source: "events" });
    expect(by.key_minted).toMatchObject({ count: 3, denominator: 4, rate: 0.75, source: "events" });
    expect(by.first_engine_use).toMatchObject({ count: 2, denominator: 3, rate: 0.6667, source: "derived" });
    expect(by.payg_enabled).toMatchObject({ count: 1, denominator: 2, rate: 0.5, source: "events" });
    expect(by.first_charge).toMatchObject({ count: 1, denominator: 1, rate: 1, source: "events" });
    expect(by.repeat_usage).toMatchObject({ count: 1, denominator: 1, rate: 1, source: "derived" });
    expect(r.repeat_usage_any).toMatchObject({ count: 1, denominator: 2, rate: 0.5, source: "derived" });
    expect(r.steps.map((s) => s.key)).toEqual(["qualify_started", "qualify_completed", "free_account_created", "key_minted", "first_engine_use", "payg_enabled", "first_charge", "repeat_usage"]);
    for (const s of r.steps) { expect(typeof s.basis).toBe("string"); expect(["events", "derived"]).toContain(s.source); }
    expect(r.qualifier_evidence_classes).toEqual({ E3: 1 });
  });

  it("the cohort is the window: an account created before it is not in the funnel, and events outside the window are not counted", async () => {
    paygAccount(db, { account: "old", token: "tok-old-0123456789abcdefghijklm" });
    ev("free_account_created", { plan: "api_free", account_ref: accountRef("old") }, ago(60));
    ev("qualify_started", {}, ago(60));
    const r = await report(30);
    if (!r.ok) throw new Error("report");
    expect(r.steps.find((s) => s.key === "free_account_created")!.count).toBe(0);
    expect(r.steps.find((s) => s.key === "qualify_started")!.count).toBe(0);
    const wide = await report(90);
    if (!wide.ok) throw new Error("report");
    expect(wide.steps.find((s) => s.key === "free_account_created")!.count).toBe(1);
  });

  it("retention by cohort week: of the accounts created in a week, the share with net usage k weeks later (a refunded charge is not use)", async () => {
    for (const n of ["r1", "r2", "r3"]) { paygAccount(db, { account: n, token: `tok-${n}-0123456789abcdefghijkl` }); ev("free_account_created", { account_ref: accountRef(n) }, "2026-09-30T10:00:00Z"); }
    // cohort week = Monday 2026-09-28
    usage("r1", ["2026-09-29T10:00:00Z", "2026-10-06T10:00:00Z", "2026-10-20T10:00:00Z"]);
    usage("r2", ["2026-09-30T10:00:00Z"]);
    const r = await report();
    if (!r.ok) throw new Error("report");
    expect(r.retention.cohorts).toHaveLength(1);
    const c = r.retention.cohorts[0];
    expect(c).toMatchObject({ cohort_week: "2026-09-28", size: 3 });
    const wk = (k: number) => c.weeks.find((w) => w.offset === k)!;
    expect(wk(0)).toMatchObject({ active: 2, rate: 0.6667, partial: false });
    expect(wk(1)).toMatchObject({ active: 1, rate: 0.3333 });
    expect(wk(2)).toMatchObject({ active: 0, rate: 0 }); // a real zero: three accounts were observed that week
    expect(wk(3)).toMatchObject({ active: 1, partial: true }); // 2026-10-19 is the current week
    expect(c.weeks).toHaveLength(4); // never future weeks
  });

  it("subscriptions, engagements, payments, and the qualifier -> engagement link where a qualification id exists", async () => {
    ev("subscription_started", { kind: "api_scale" }, ago(2)); ev("subscription_started", { kind: "hall_watch" }, ago(2));
    ev("subscription_cancelled", { kind: "api_scale", reason: "payment_failed" }, ago(1));
    ev("engagement_commissioned", { kind: "density_screen" }, ago(1));
    ev("payment_failed", { kind: "subscription" }, ago(1)); ev("payment_failed", { month: "2026-09", account_ref: "abc" }, ago(1));
    ev("refund_issued", { amount_cents: 100 }, ago(1)); ev("dispute_opened", { amount_cents: 100 }, ago(1));
    ev("project_created", {}, ago(1)); ev("project_saved_result", { kind: "comparison" }, ago(1));
    for (const id of ["q1", "q2", "q3"]) db.rows("qualifications").push({ id, status: "scored", created_at: ago(3) });
    db.rows("qualifications").push({ id: "q4", status: "engine_unavailable", created_at: ago(3) });
    db.rows("deliverables").push({ id: "d1", qualification_id: "q1" }, { id: "d2", qualification_id: "q9-not-in-window" }, { id: "d3", qualification_id: null });
    const r = await report();
    if (!r.ok) throw new Error("report");
    expect(r.subscriptions).toMatchObject({ started: { total: 2, by_kind: { api_scale: 1, hall_watch: 1 } }, cancelled: { total: 1, stated_reasons: { payment_failed: 1 } }, cancellations_per_start: 0.5, source: "events" });
    expect(r.engagements.commissioned).toEqual({ total: 1, by_kind: { density_screen: 1 } });
    expect(r.payments).toMatchObject({ payment_failed: { total: 2 }, refunds: 1, disputes: 1 });
    expect(r.projects).toMatchObject({ created: 1, saved_results: { total: 1, by_kind: { comparison: 1 } } });
    expect(r.qualifier_to_engagement).toMatchObject({ qualifications_scored: 3, engagements_linked_to_those: 1, rate: 0.3333, truncated: false, source: "derived" });
  });

  it("names what it cannot measure, including the anonymous qualifier -> account link", async () => {
    const r = await report();
    if (!r.ok) throw new Error("report");
    const text = r.unmeasured.join("\n");
    expect(text).toMatch(/Anonymous qualifier -> free account linkage/);
    expect(text).toMatch(/Visitors, sessions and page views/);
    expect(text).toMatch(/charge\.refunded and charge\.dispute\.created/);
    expect(text).toMatch(/free-text cancellation comments are deliberately never read/);
    expect(r.cohort_definition).toMatch(/Strict cohort/);
  });

  it("the whole report carries no email, token or account name (only anonymous references are ever involved)", async () => {
    paygAccount(db, { account: "named-account-9", token: "tok-named-0123456789abcdefghij", email: "secret@acme.example" });
    ev("free_account_created", { account_ref: accountRef("named-account-9") }, ago(2));
    usage("named-account-9", ["2026-10-14T10:00:00Z"]);
    const r = await report();
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/@|tok-named|named-account-9|secret/);
    expect(text).not.toContain(accountRef("named-account-9"));
  });

  it("is an error, not an empty report, when the store cannot be read", async () => {
    db.rpcs.delete("gf_funnel_summary");
    const r = await report();
    expect(r.ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------- admin access

describe("the admin routes are admin-only", () => {
  const get = (path: string) => new Request(siteUrl(path));

  it("both refuse without the admin cookie (401) and reveal nothing", async () => {
    const f = await import("@/app/api/admin/funnel/route");
    const e = await import("@/app/api/admin/economics/route");
    for (const res of [await f.GET(get("/api/admin/funnel?days=30")), await e.GET(get("/api/admin/economics"))]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
    }
    jar.push({ name: "gf_admin", value: "forged" });
    expect((await f.GET(get("/api/admin/funnel"))).status).toBe(401);
    expect((await e.GET(get("/api/admin/economics"))).status).toBe(401);
  });

  it("with the admin cookie, funnel answers the documented shape and validates days", async () => {
    signIn();
    const f = await import("@/app/api/admin/funnel/route");
    const res = await f.GET(get("/api/admin/funnel?days=7"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, days: 7 });
    expect(Array.isArray(j.steps) && Array.isArray(j.unmeasured)).toBe(true);
    for (const bad of ["0", "366", "abc", "1.5", "-3"]) expect((await f.GET(get(`/api/admin/funnel?days=${bad}`))).status, bad).toBe(400);
    expect((await (await f.GET(get("/api/admin/funnel"))).json()).days).toBe(30); // default
  });

  it("with the admin cookie, economics validates the month and defaults to this one", async () => {
    signIn();
    const e = await import("@/app/api/admin/economics/route");
    for (const bad of ["2026-13", "oct", "2026-1", "../x"]) expect((await e.GET(get(`/api/admin/economics?month=${encodeURIComponent(bad)}`))).status, bad).toBe(400);
    const j = await (await e.GET(get("/api/admin/economics"))).json();
    expect(j).toMatchObject({ ok: true, month: new Date().toISOString().slice(0, 7), current_month: true });
  });
});

// --------------------------------------------------------------------------------------------------------- economics

describe("economics: measured revenue beside measured compute, no margin claimed", () => {
  const engineAnswers = (status: number, body: unknown) => {
    process.env.GRIDFORGE_API_URL = "https://engine.test";
    process.env.GRIDFORGE_ADMIN_KEY = "admin-test-key";
    const inner = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = String(i);
      if (url.startsWith("https://engine.test/v1/admin/economics")) {
        seen.push(`${url}|${(init?.headers as Record<string, string>)?.["X-API-Key"]}`);
        return new Response(JSON.stringify(body), { status });
      }
      return inner(i as RequestInfo, init);
    }) as typeof fetch;
    return { seen, restore: () => { globalThis.fetch = inner; } };
  };
  const ENGINE_BODY = {
    month: "2026-09",
    endpoints: [
      { endpoint: "/v1/study", calls: 10, units: 50, wall_ms_total: 40_000, wall_ms_p50: 3000, wall_ms_p95: 6000, units_per_call: 5, revenue_cents_at_payg_price: 10_000, free_units: 5 },
      { endpoint: "/v1/screen", calls: 20, units: 20, wall_ms_total: 10_000, wall_ms_p50: 400, wall_ms_p95: 900, units_per_call: 1, revenue_cents_at_payg_price: 4_000, free_units: 0 },
    ],
    basis: "wall-clock milliseconds measured by the engine around each metered handler",
    durable: true,
  };
  function seedMonth() {
    paygAccount(db, { account: "e1" });
    paygAccount(db, { account: "e2", token: "tok-e2-0123456789abcdefghijklmn", plan: "api_free", cap_units: null });
    const add = (account: string, scope: string, units: number, n: number) => db.rows("usage_events").push({ event_id: `m${n}`, seq: 5000 + n, account, scope, kind: "charge", units, occurred_at: "2026-09-10T10:00:00.000Z", ref: "" });
    add("e1", "payg", 60, 1); add("e1", "payg", 10, 2); add("e2", "trial", 5, 3);
    db.insertRow("usage_settlements", { account: "e1", month: "2026-09", units: 70, amount_cents: 14_000, status: "paid" });
    db.insertRow("usage_settlements", { account: "e3", month: "2026-09", units: 2, amount_cents: 400, status: "carried" });
    db.insertRow("usage_settlements", { account: "e4", month: "2026-09", units: 10, amount_cents: 2_000, status: "failed" });
  }
  const call = async (month = "2026-09") => {
    signIn();
    const { GET } = await import("@/app/api/admin/economics/route");
    return (await GET(new Request(siteUrl(`/api/admin/economics?month=${month}`)))).json();
  };

  it("combines ledger revenue and settlements with the engine's measured compute, and says plainly what it is and is not", async () => {
    seedMonth();
    const e = engineAnswers(200, ENGINE_BODY);
    const j = await call();
    e.restore();
    expect(e.seen).toEqual(["https://engine.test/v1/admin/economics?month=2026-09|admin-test-key"]);
    expect(j.revenue).toMatchObject({ currency: "eur", unit_price_cents: 200, accrued_payg_cents: 70 * 200, payg_units: 70, free_units: 5 });
    expect(j.revenue.settlements).toMatchObject({ invoiced_cents: 16_000, collected_cents: 14_000, failed_cents: 2_000, carried_units: 2, truncated: false });
    expect(j.revenue.settlements.by_status.paid).toEqual({ count: 1, units: 70, amount_cents: 14_000 });
    expect(j.compute).toMatchObject({ available: true, durable: true, totals: { calls: 30, units: 70, wall_ms_total: 50_000, free_units: 5, revenue_cents_at_payg_price: 14_000 } });
    expect(j.compute.endpoints).toHaveLength(2);
    expect(j.revenue_per_compute_second_cents).toBe(280); // 14,000 cents / 50 s
    expect(j.reconciliation).toMatchObject({ engine_units: 70, ledger_units: 75, difference: -5 });
    // no margin is claimed
    expect(j.margin).toMatchObject({ claimed: false, value: null });
    expect(j.margin.reason).toMatch(/No margin is claimed/);
    expect(j.not_included.join("|")).toMatch(/Fixed infrastructure[\s\S]*Stripe fees[\s\S]*LLM/);
    expect(j.unknown.join("|")).toMatch(/Margin/);
    expect(j.statement).toMatch(/Not included: fixed infrastructure, Stripe fees, LLM cost/);
    expect(JSON.stringify(j)).not.toMatch(/margin_cents|profit|gross_margin/i);
  });

  it("degrades honestly when the engine lacks the endpoint, errors, is unreachable or is not configured: revenue still shown, compute 'unavailable' with the reason", async () => {
    seedMonth();
    for (const [status, body, reason] of [[404, {}, /does not provide \/v1\/admin\/economics/], [500, {}, /answered 500/], [200, { nope: 1 }, /not understood/]] as const) {
      const e = engineAnswers(status, body);
      const j = await call();
      e.restore();
      expect(j.compute).toMatchObject({ available: false });
      expect(j.compute.reason).toMatch(reason);
      expect(j.revenue.accrued_payg_cents).toBe(14_000);
      expect(j.revenue_per_compute_second_cents).toBeNull();
      expect(j.reconciliation).toBeNull();
      expect(j.unknown.join("|")).toMatch(/All compute figures/);
      expect(j.margin.claimed).toBe(false);
    }
    delete process.env.GRIDFORGE_ADMIN_KEY;
    const j = await call();
    expect(j.compute).toMatchObject({ available: false });
    expect(j.compute.reason).toMatch(/not configured/);
  });

  it("an empty month is zeros with a null ratio, not a division by zero", async () => {
    const e = engineAnswers(200, { month: "2026-08", endpoints: [], basis: "b", durable: true });
    const j = await call("2026-08");
    e.restore();
    expect(j.revenue).toMatchObject({ accrued_payg_cents: 0, payg_units: 0, free_units: 0 });
    expect(j.revenue_per_compute_second_cents).toBeNull();
  });

  it("drops malformed endpoint rows rather than guessing them", async () => {
    const e = engineAnswers(200, { ...ENGINE_BODY, endpoints: [ENGINE_BODY.endpoints[0], { endpoint: "/v1/x", calls: "many" }, null, { calls: 1 }] });
    const j = await call();
    e.restore();
    expect(j.compute.endpoints).toHaveLength(1);
  });
});
