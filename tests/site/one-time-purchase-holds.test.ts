/**
 * A refunded or disputed ONE-TIME purchase (Density Screen, Procurement Specification) suspends what it paid for.
 *
 * Before: a charge with no subscription behind it fell through "an engagement deposit: nothing of ours to suspend". A released document
 * stayed readable after a full refund, an unsubmitted intake still ran the engine, and the Density Screen was still offered as a credit
 * "in full" against the Study. Each test below fails against that behaviour.
 *
 *   REAL webhook, buyer routes, admin release and credit lookup; MOCK Stripe (tests/site/billing-holds-harness.ts) and a FAKE store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { adminToken } from "@/lib/admin";
import { documentHash } from "@/lib/deliverables";
import { audit, operatorMail, send, startRig, type Rig } from "./billing-holds-harness";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));
let standing: { state: string; detail?: string; partial_refund_cents?: number } = { state: "ok", partial_refund_cents: 0 };
vi.mock("@/lib/payment-standing", () => ({ paymentStanding: async () => standing }));

const DOC = "<p>SECRET reviewed document</p>";
let rig: Rig;
beforeEach(() => {
  rig = startRig();
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  jar.length = 0;
  jar.push({ name: "gf_admin", value: adminToken()! });
  standing = { state: "ok", partial_refund_cents: 0 };
  rig.db.createTable("deliverables");
  rig.db.createTable("engagement_deposits");
  rig.db.createTable("operator_notices");
  rig.db.uniqueKeys.set("operator_notices", [["dedupe_key"]]);
  rig.db.rowDefaults.set("deliverables", () => ({ billing_hold: null, billing_hold_ref: null, billing_hold_at: null }));
});
afterEach(() => rig.stop());

function purchase(over: Record<string, unknown> = {}) {
  rig.db.seed("deliverables", [{
    id: "d-1", token: "doc-token", intake_token: "intake-token", kind: "density_screen", status: "released", email: "buyer@hall.example",
    company: "North Hall", stripe_session_id: "cs_1", amount_cents: 450_000, document_html: DOC, document_md: "x", title: "Density Screen",
    intake: { siteName: "North Hall", _gridforge: { document_sha256: documentHash(DOC) } }, working_files: {},
    billing_hold: null, billing_hold_ref: null, billing_hold_at: null,   // as PostgREST reads a column that has never been set
    ...over,
  }]);
  rig.stripe.linkOneTime("ch_1", "pi_1", "cs_1", "density_screen");
}
const row = () => rig.db.rows("deliverables")[0] as any;
const hold = () => ({ hold: row().billing_hold, ref: row().billing_hold_ref });

const charge = (over: Record<string, unknown> = {}) => ({ id: "ch_1", object: "charge", amount: 450_000, amount_refunded: 450_000, refunded: true, currency: "eur", payment_intent: "pi_1", ...over });
const refund = (over: Record<string, unknown> = {}, id?: string) => send(rig, "charge.refunded", charge(over), { id, created: rig.T0 + 10 });
const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", amount: 450_000, currency: "eur", charge: "ch_1", reason: "fraudulent", status: "needs_response", ...over });
const disputeEvent = (type: "created" | "closed", status: string, id?: string) => {
  rig.stripe.pinDispute("dp_1", { status, charge: "ch_1", amount: 450_000 });
  return send(rig, `charge.dispute.${type}`, dispute({ status }), { id, created: rig.T0 + 20 });
};
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const get = (path: string) => new Request(siteUrl(path));

describe("a full refund", () => {
  it("holds the purchase, records who and which charge, and does it once however often Stripe redelivers", async () => {
    purchase();
    for (let i = 0; i < 3; i++) expect((await refund({}, `evt_r${i}`)).status).toBe(200);
    expect(hold()).toEqual({ hold: "refunded", ref: "ch_1" });
    expect(row().billing_hold_at).toBeTruthy();
    const a = audit(rig, "hold_applied");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ subject_table: "deliverables", subject_id: "d-1", stripe_object_id: "ch_1" });
    expect(JSON.stringify(a[0])).not.toContain("buyer@hall.example");
  });

  it("a PARTIAL refund holds nothing", async () => {
    purchase();
    expect((await refund({ amount_refunded: 100_000, refunded: false })).status).toBe(200);
    expect(hold()).toEqual({ hold: null, ref: null });
  });

  it("is withheld from the buyer on every path that serves or acts on the purchase, and nothing of the document leaks", async () => {
    purchase();
    const doc = await import("@/app/api/deliverable/[token]/route");
    expect(await (await doc.GET(get("/api/deliverable/doc-token"), ctx("doc-token"))).text()).toContain("SECRET reviewed document");   // before: served
    await refund();
    const paths: [string, () => Promise<Response>][] = [
      ["document", () => doc.GET(get("/api/deliverable/doc-token"), ctx("doc-token"))],
      ["document files", () => doc.GET(get("/api/deliverable/doc-token?format=csv&file=x"), ctx("doc-token"))],
      ["bids", async () => (await import("@/app/api/deliverable/[token]/bids/route")).POST(new Request(siteUrl("/x"), { method: "POST", body: "{}" }), ctx("doc-token"))],
      ["quotes (read)", async () => (await import("@/app/api/deliverable/[token]/quotes/route")).GET(get("/x"), ctx("doc-token"))],
      ["quotes (write)", async () => (await import("@/app/api/deliverable/[token]/quotes/route")).POST(new Request(siteUrl("/x"), { method: "POST", body: "{}" }), ctx("doc-token"))],
      ["evidence runs (read)", async () => (await import("@/app/api/deliverable/[token]/evidence-run/route")).GET(get("/x"), ctx("doc-token"))],
      ["evidence runs (write)", async () => (await import("@/app/api/deliverable/[token]/evidence-run/route")).POST(new Request(siteUrl("/x"), { method: "POST", body: "{}" }), ctx("doc-token"))],
      ["intake form", async () => (await import("@/app/api/intake/[token]/route")).GET(get("/x"), ctx("intake-token"))],
      ["intake submit", async () => (await import("@/app/api/intake/[token]/route")).POST(new Request(siteUrl("/x"), { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), ctx("intake-token"))],
      ["attach a document", async () => (await import("@/app/api/intake/[token]/evidence/route")).POST(new Request(siteUrl("/x"), { method: "POST", body: "x", headers: { "content-type": "application/pdf" } }), ctx("intake-token"))],
      ["confirm a figure", async () => (await import("@/app/api/intake/[token]/confirm/route")).POST(new Request(siteUrl("/x"), { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), ctx("intake-token"))],
    ];
    for (const [name, call] of paths) {
      const res = await call();
      const text = await res.text();
      expect(res.status, name).toBe(402);
      expect(text, name).toContain("refunded");
      for (const secret of ["SECRET reviewed document", "buyer@hall.example", "cs_1", "ch_1", "450000"]) expect(text, `${name} leaks ${secret}`).not.toContain(secret);
    }
  });

  it("the engine is not run for a refunded purchase's intake, while it IS run for the same intake on a clean purchase", async () => {
    const engineCalls: string[] = [];
    process.env.GRIDFORGE_API_URL = "http://engine.test";
    process.env.GRIDFORGE_API_KEY = "engine-key";
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("http://engine.test")) return inner(input as RequestInfo, init);
      engineCalls.push(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify(body.format === "html" || body.format === "md" ? { format: body.format, title: "Density Screen", document: "<p>d</p>" } : { project: {}, recommended: "full_dlc", scenarios: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const FULL = { siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72" };
      const submit = () => import("@/app/api/intake/[token]/route").then((m) => m.POST(new Request(siteUrl("/x"), { method: "POST", body: JSON.stringify(FULL), headers: { "content-type": "application/json" } }), ctx("intake-token")));

      purchase({ status: "awaiting_intake", document_html: null, document_md: null });
      const control = await submit();                                    // positive control: a clean purchase runs the engine
      expect(control.status).toBe(200);
      expect(engineCalls.length).toBeGreaterThan(0);

      engineCalls.length = 0;
      rig.db.rows("deliverables").length = 0;                            // a second, refunded purchase
      purchase({ status: "awaiting_intake", document_html: null, document_md: null });
      await refund();
      expect((await submit()).status).toBe(402);
      expect(engineCalls).toEqual([]);                                   // nothing was generated for a refunded purchase
      expect(row().status).toBe("awaiting_intake");
    } finally {
      globalThis.fetch = inner;
    }
  });
});

describe("a dispute", () => {
  it("open holds as disputed; won lifts exactly that hold and says so; a stale 'created' redelivered afterwards brings nothing back", async () => {
    purchase();
    expect((await disputeEvent("created", "needs_response", "evt_c")).status).toBe(200);
    expect(hold()).toEqual({ hold: "disputed", ref: "dp_1" });
    expect((await disputeEvent("closed", "won", "evt_w")).status).toBe(200);
    expect(hold()).toEqual({ hold: null, ref: null });
    expect(audit(rig, "hold_lifted")).toHaveLength(1);
    expect((await disputeEvent("created", "won", "evt_c")).status).toBe(200);          // Stripe says it is won: a stale created cannot re-hold
    expect(hold()).toEqual({ hold: null, ref: null });
    const doc = await import("@/app/api/deliverable/[token]/route");
    expect((await doc.GET(get("/x"), ctx("doc-token"))).status).toBe(200);              // the buyer has the document again
  });

  it("lost: the hold stands, and the loss is on the record exactly once", async () => {
    purchase();
    await disputeEvent("created", "needs_response", "evt_c");
    for (let i = 0; i < 2; i++) await disputeEvent("closed", "lost", `evt_l${i}`);
    expect(hold()).toEqual({ hold: "disputed", ref: "dp_1" });
    expect(audit(rig, "dispute_lost_hold_stands")).toHaveLength(1);
    expect(audit(rig, "hold_applied")).toHaveLength(1);
  });

  it("lost with no earlier 'created' event still holds", async () => {
    purchase();
    expect((await disputeEvent("closed", "lost")).status).toBe(200);
    expect(hold()).toEqual({ hold: "disputed", ref: "dp_1" });
  });

  it("a dispute WON on a purchase that was also refunded leaves the refund hold alone", async () => {
    purchase();
    await refund();
    await disputeEvent("created", "needs_response", "evt_c");
    expect(hold()).toEqual({ hold: "refunded", ref: "ch_1" });
    expect(audit(rig, "hold_stands")).toHaveLength(1);
    await disputeEvent("closed", "won", "evt_w");
    expect(hold()).toEqual({ hold: "refunded", ref: "ch_1" });
  });

  it("a refund after a dispute upgrades the hold to refunded (terminal); a different dispute's win does not lift it", async () => {
    purchase();
    await disputeEvent("created", "needs_response", "evt_c");
    await refund();
    expect(hold()).toEqual({ hold: "refunded", ref: "ch_1" });
    rig.stripe.pinDispute("dp_other", { status: "won", charge: "ch_1", amount: 1 });
    await send(rig, "charge.dispute.closed", dispute({ id: "dp_other", status: "won" }), { created: rig.T0 + 30 });
    expect(hold()).toEqual({ hold: "refunded", ref: "ch_1" });
  });

  it("a second open dispute does not replace the first one's hold, so the first being won still lifts it", async () => {
    purchase();
    await disputeEvent("created", "needs_response", "evt_c");
    rig.stripe.pinDispute("dp_2", { status: "needs_response", charge: "ch_1", amount: 1 });
    await send(rig, "charge.dispute.created", dispute({ id: "dp_2" }), { created: rig.T0 + 25 });
    expect(hold()).toEqual({ hold: "disputed", ref: "dp_1" });
    await disputeEvent("closed", "won", "evt_w");
    expect(hold()).toEqual({ hold: null, ref: null });
  });
});

describe("the Study credit", () => {
  it("a refunded or disputed Density Screen is not offered as a credit; a clean one is; it returns when a dispute is won", async () => {
    purchase();
    const { creditsToward } = await import("@/lib/deliverables");
    expect((await creditsToward("buyer@hall.example", "envelope_study")).cents).toBe(450_000);
    await disputeEvent("created", "needs_response", "evt_c");
    expect(await creditsToward("buyer@hall.example", "envelope_study")).toMatchObject({ ok: true, cents: 0, from: [] });
    await disputeEvent("closed", "won", "evt_w");
    expect((await creditsToward("buyer@hall.example", "envelope_study")).cents).toBe(450_000);
    await refund();
    expect((await creditsToward("buyer@hall.example", "envelope_study")).cents).toBe(0);
  });
});

describe("an operator releasing a held purchase on purpose", () => {
  const release = async (extra: Record<string, unknown> = {}) => {
    const { PATCH } = await import("@/app/api/admin/deliverables/route");
    const draft = row();
    const hash = (await import("@/lib/deliverables")).reviewHash(draft);
    return PATCH(new Request(siteUrl("/x"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "doc-token", action: "release", reviewed_hash: hash, reviewed_by: "Ada", ...extra }) }));
  };

  it("is refused while the hold stands, even if Stripe, asked now, says the payment is fine, and names the hold", async () => {
    purchase({ status: "draft" });
    await refund();
    standing = { state: "ok" };
    const res = await release();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ payment_hold: "refunded" });
    expect(row().status).toBe("draft");
  });

  it("with acknowledge_payment_issue it releases, lifts the hold, and records who decided", async () => {
    purchase({ status: "draft" });
    await refund();
    const res = await release({ acknowledge_payment_issue: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "released", payment_hold_lifted: true });
    expect(hold()).toEqual({ hold: null, ref: null });
    expect(audit(rig, "hold_lifted").map((r) => (r.detail as any).cause)).toEqual(["operator_acknowledged"]);
  });
});

describe("when the purchase's own checkout event has not been processed yet", () => {
  it("a refund that arrives first is retried (500), and applied once the purchase exists", async () => {
    rig.stripe.linkOneTime("ch_1", "pi_1", "cs_1", "density_screen");        // Stripe knows the session; our store has no row yet
    expect((await refund({}, "evt_early")).status).toBe(500);
    purchase();
    expect((await refund({}, "evt_early")).status).toBe(200);
    expect(hold()).toEqual({ hold: "refunded", ref: "ch_1" });
  });
});

describe("deposits and payments that are not ours to hold", () => {
  it("a refunded deposit with a record is audited and the operator told once; no state, no credit possible", async () => {
    rig.db.seed("engagement_deposits", [{ id: "dep-1", kind: "envelope_study_deposit", stripe_session_id: "cs_dep", status: "contacted", email: "buyer@hall.example" }]);
    rig.stripe.linkOneTime("ch_d", "pi_d", "cs_dep", "envelope_study_deposit");
    for (let i = 0; i < 2; i++) expect((await send(rig, "charge.refunded", charge({ id: "ch_d", payment_intent: "pi_d" }), { id: `evt_d${i}`, created: rig.T0 + 10 })).status).toBe(200);
    expect(audit(rig, "deposit_refunded")).toHaveLength(1);
    expect(audit(rig, "deposit_refunded")[0]).toMatchObject({ subject_table: "engagement_deposits", subject_id: "dep-1" });
    expect(operatorMail(rig).filter((m) => /deposit was refunded/.test(m.subject))).toHaveLength(1);
    expect(rig.db.rows("engagement_deposits")[0]).toMatchObject({ status: "contacted" });
  });

  it("a deposit with NO record (attached to a project) is not retried for days: acknowledged, the operator told", async () => {
    rig.stripe.linkOneTime("ch_d", "pi_d", "cs_dep", "envelope_study_deposit");
    expect((await send(rig, "charge.refunded", charge({ id: "ch_d", payment_intent: "pi_d" }), { created: rig.T0 + 10 })).status).toBe(200);
    expect(operatorMail(rig).filter((m) => /no deposit record/.test(m.subject))).toHaveLength(1);
  });

  it("a payment that is neither (another product on the same Stripe account) changes nothing", async () => {
    purchase();
    rig.stripe.linkOneTime("ch_x", "pi_x", "cs_x", "someone_elses_product");
    expect((await send(rig, "charge.refunded", charge({ id: "ch_x", payment_intent: "pi_x" }), { created: rig.T0 + 10 })).status).toBe(200);
    expect(hold()).toEqual({ hold: null, ref: null });
    expect(audit(rig)).toHaveLength(0);
  });

  it("a Stripe outage while resolving the purchase is retried (500), not guessed at", async () => {
    purchase();
    rig.stripe.failOnce.add("checkout.sessions.list");
    expect((await refund({}, "evt_out")).status).toBe(500);
    expect(hold()).toEqual({ hold: null, ref: null });
    expect((await refund({}, "evt_out")).status).toBe(200);
    expect(hold()).toEqual({ hold: "refunded", ref: "ch_1" });
  });
});

describe("where migration 0045 has not been applied", () => {
  beforeEach(() => rig.db.dropColumn("deliverables", "billing_hold"));

  it("the refund is acknowledged, the operator is told ONCE (not per redelivery), and nothing else changes", async () => {
    purchase();
    for (let i = 0; i < 3; i++) expect((await refund({}, `evt_m${i}`)).status).toBe(200);
    expect(operatorMail(rig).filter((m) => /Migration 0045/.test(m.subject))).toHaveLength(1);
  });

  it("credits and the buyer's document still work exactly as before", async () => {
    purchase();
    const { creditsToward } = await import("@/lib/deliverables");
    expect((await creditsToward("buyer@hall.example", "envelope_study")).cents).toBe(450_000);
    const doc = await import("@/app/api/deliverable/[token]/route");
    expect((await doc.GET(get("/x"), ctx("doc-token"))).status).toBe(200);
  });
});

describe("paymentHoldAnswer", () => {
  it("answers only for the two holds and says nothing that identifies the payment", async () => {
    const { paymentHoldAnswer } = await import("@/lib/one-time-holds");
    expect(paymentHoldAnswer(null)).toBeNull();
    expect(paymentHoldAnswer({})).toBeNull();
    expect(paymentHoldAnswer({ billing_hold: null })).toBeNull();
    expect(paymentHoldAnswer({ billing_hold: "paused" as never })).toBeNull();
    for (const h of ["refunded", "disputed"] as const) {
      const a = paymentHoldAnswer({ billing_hold: h, billing_hold_ref: "ch_secret" })!;
      expect(a.status).toBe(402);
      expect(JSON.stringify(a)).not.toContain("ch_secret");
    }
  });
});
