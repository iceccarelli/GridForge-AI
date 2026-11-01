/**
 * Pay-as-you-go against REAL PostgreSQL through REAL PostgREST (scripts/realdb-up.sh): the unique settlement row, ON CONFLICT DO
 * NOTHING through `Prefer: resolution=ignore-duplicates`, the conditional PATCH filters the compare-and-set mint and the webhook rely
 * on, the SQL net-usage functions, the ingest transaction, the free-allowance ceiling and the Founding slot reservation. The only
 * stand-ins are Stripe (MockStripe), Resend and the engine's /v1/revoke: no live Stripe, Supabase or engine is contacted.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set -- a skip is a gap in what was checked, and GF_REQUIRE_REALDB=1 turns the skip
 * into a failure.
 */
import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { inspectKey, mintChecked, type ApiAccount } from "@/lib/api-access";
import { rest } from "@/lib/pgrest";
import { paygChargeCents } from "@/lib/products";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { MockStripe, mockEngine, type MockEngine } from "./payg-harness";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT;
const required = process.env.GF_REQUIRE_REALDB === "1";

describe("real-database prerequisites (pay-as-you-go)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
  });
  it.runIf(required && enabled)("migration 0028 is applied", async () => {
    const r = await fetch(`${PGRST}/rpc/gf_usage_net`, {
      method: "POST", headers: { Authorization: `Bearer ${JWT}`, "content-type": "application/json" },
      body: JSON.stringify({ p_account: "nobody", p_from: "2026-01-01T00:00:00Z", p_to: "2026-02-01T00:00:00Z" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ charged: 0, refunded: 0, net: 0, billable_net: 0 });
  });
});

const realFetch = globalThis.fetch;
let gateway: http.Server | null = null;

async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/")) { res.writeHead(404).end("{}"); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await realFetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}
afterAll(() => { gateway?.close(); });

const uid = () => Math.random().toString(36).slice(2, 10);
const NOW = new Date("2026-10-21T03:23:00Z");
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
let stripe: MockStripe;
let seqBase = 0;

describe.skipIf(!enabled)("pay-as-you-go — real PostgreSQL via PostgREST", () => {
  beforeEach(async () => {
    process.env.SUPABASE_URL = gateway ? `http://127.0.0.1:${(gateway.address() as { port: number }).port}` : await startGateway();
    process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
    Object.assign(process.env, { GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>", STRIPE_SECRET_KEY: "sk_test_placeholder", RATE_LIMIT_HMAC_KEY: "r".repeat(40) });
    delete process.env.GRIDFORGE_FREE_ACCOUNTS_MAX;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mail = [];
    engine = mockEngine(mail);
    stripe = new MockStripe();
    setPaygStripeForTests(stripe);
    const c = await rest<{ last_seq: number }[]>("GET", "payg_cursor?id=eq.1&select=last_seq");
    seqBase = Math.max(seqBase, Number(c.ok ? c.data?.[0]?.last_seq : 0)) + 1000;
  });
  afterEach(() => { setPaygStripeForTests(null); engine.restore(); vi.restoreAllMocks(); });

  async function newAccount(over: Record<string, unknown> = {}): Promise<ApiAccount> {
    const account = `rd-${uid()}`;
    const r = await rest<ApiAccount[]>("POST", "api_accounts", {
      token: `tok-${uid()}${uid()}${uid()}`, account, email: `${account}@example.test`, plan: "api_payg", monthly_units: 50, cap_units: 50, status: "active",
      stripe_customer_id: `cus_${account}`, stripe_payment_method_id: `pm_${account}`, ...over,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { data: ApiAccount[] }).data[0];
  }
  const fresh = async (token: string) => ((await rest<ApiAccount[]>("GET", `api_accounts?token=eq.${token}`)) as { data: ApiAccount[] }).data[0];
  const ev = (account: string, over: Record<string, unknown> = {}) => {
    const seq = ++seqBase;
    return { seq, id: `rd${uid()}${seq}`, ts: "2026-09-10T12:00:00+00:00", kind: "charge", account, key_id: "k", scope: "payg", endpoint: "/v1/study", units: 5, project: "", idem: "", ref: "", ...over };
  };
  const fetcherOver = (events: Record<string, unknown>[]) => async (after: number, limit: number) => {
    const page = events.filter((e) => (e.seq as number) > after).slice(0, limit);
    return { ok: true as const, events: page, last_seq: page.length ? (page[page.length - 1].seq as number) : after, head_seq: Math.max(...events.map((e) => e.seq as number)), durable: true };
  };

  it("ingest: idempotent through the real insert, cursor moves with the rows, net usage nets refunds across a month boundary", async () => {
    const a = await newAccount();
    const { ingestLedger, usageNet } = await import("@/lib/payg-usage");
    const c1 = ev(a.account, { units: 6, ts: "2026-09-30T23:59:59.999+00:00" });
    const events = [c1, ev(a.account, { kind: "refund", units: 6, ref: c1.id, ts: "2026-10-01T00:00:00.001+00:00" }), ev(a.account, { units: 4 })];
    // start the cursor just before this batch
    await rest("PATCH", `payg_cursor?id=eq.1`, { last_seq: events[0].seq - 1 });
    const f = fetcherOver(events);
    const r1 = await ingestLedger(f);
    expect(r1).toMatchObject({ ok: true, complete: true, inserted: 3 });
    expect(r1.cursor).toBe(events[2].seq);
    await rest("PATCH", `payg_cursor?id=eq.1`, { last_seq: events[0].seq - 1 }); // a lost cursor: replay everything
    const r2 = await ingestLedger(f);
    expect(r2).toMatchObject({ ok: true, inserted: 0 });
    expect(await usageNet(a.account, "2026-09")).toEqual({ charged: 10, refunded: 6, net: 4, billable_net: 4 });
    expect((await usageNet(a.account, "2026-10"))!.net).toBe(0);
  });

  it("settlement: one row per (account, month) through the real unique constraint; cron twice invoices once; carried months roll forward", async () => {
    const a = await newAccount();
    const small = await newAccount();
    const { ingestLedger } = await import("@/lib/payg-usage");
    const { runPaygCron } = await import("@/lib/payg-cron");
    const events = [ev(a.account, { units: 10 }), ev(a.account, { units: 5 }), ev(small.account, { units: 1, ts: "2026-08-10T10:00:00+00:00" }), ev(small.account, { units: 3, ts: "2026-09-10T10:00:00+00:00" })];
    await rest("PATCH", `payg_cursor?id=eq.1`, { last_seq: events[0].seq - 1 });
    void ingestLedger;
    const fetcher = fetcherOver(events);
    await runPaygCron({ fetcher, stripe, now: NOW });
    await runPaygCron({ fetcher, stripe, now: NOW });
    stripe.forgetIdempotency();
    await runPaygCron({ fetcher, stripe, now: new Date("2026-10-22T03:23:00Z") });
    const rows = ((await rest<any[]>("GET", `usage_settlements?account=in.(${a.account},${small.account})&order=account.asc,month.asc`)) as { data: any[] }).data;
    const mine = rows.filter((r) => r.account === a.account);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ month: "2026-09", units: 15, amount_cents: paygChargeCents(15), status: "invoiced", stripe_invoice_id: expect.stringMatching(/^in_mock_/) });
    const sm = rows.filter((r) => r.account === small.account);
    expect(sm.map((r) => [r.month, r.status, r.rolled_into])).toEqual([["2026-08", "carried", "2026-09"], ["2026-09", "invoiced", null]]);
    expect(sm[1]).toMatchObject({ units: 4, carried_units: 1, carried_months: ["2026-08"] });
    expect(stripe.allInvoices.filter((i) => i.customer === a.stripe_customer_id)).toHaveLength(1);
    expect(stripe.allInvoices.filter((i) => i.customer === small.stripe_customer_id)).toHaveLength(1);
  });

  it("the webhook against the real database: a late failed never overrides paid; failed suspends and revokes; the settlement row is the arbiter", async () => {
    const a = await newAccount({ key_id: "rdlive01", key_scope: "payg", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05" });
    await rest("POST", "usage_settlements", { account: a.account, month: "2026-09", units: 10, amount_cents: 2000, status: "invoiced", stripe_invoice_id: `in_${a.account}` });
    const { handlePaygInvoice } = await import("@/lib/payg-billing");
    const ev1 = (type: string) => ({ type, data: { object: { id: `in_${a.account}`, metadata: { kind: "payg_settlement", account: a.account, month: "2026-09" } } } }) as any;
    expect(await handlePaygInvoice(ev1("invoice.paid"))).toEqual({ ok: true });
    expect(await handlePaygInvoice(ev1("invoice.payment_failed"))).toEqual({ ok: true });
    let row = await fresh(a.token);
    expect(row).toMatchObject({ status: "active", key_id: "rdlive01" });
    // a different month fails for real: past_due, key revoked, id recorded and confirmed
    await rest("POST", "usage_settlements", { account: a.account, month: "2026-10", units: 9, amount_cents: 1800, status: "invoiced", stripe_invoice_id: `in_${a.account}_2` });
    const f2 = { type: "invoice.payment_failed", data: { object: { id: `in_${a.account}_2`, metadata: { kind: "payg_settlement", account: a.account, month: "2026-10" } } } } as any;
    await handlePaygInvoice(f2);
    row = await fresh(a.token);
    expect(row).toMatchObject({ status: "past_due", key_id: null });
    expect(row.revoked_key_ids).toContain("rdlive01");
    expect(row.revoked_confirmed_ids).toContain("rdlive01");
    expect(row.revocation_pending).toBe(false);
    expect(engine.revokeCalls).toContain("rdlive01");
  });

  it("the compare-and-set mint: concurrent mints leave exactly one winner and the revoked-id trigger keeps every id", async () => {
    const a = await newAccount({ plan: "api_scale", cap_units: null, monthly_units: 100 });
    const out = await Promise.all(Array.from({ length: 6 }, () => mintChecked({ ...a }, { rotate: true })));
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    expect(out.filter((o) => !o.ok && o.reason === "conflict")).toHaveLength(5);
    const winner = out.find((o) => o.ok) as { ok: true; result: { token: string } };
    const row = await fresh(a.token);
    expect(inspectKey(winner.result.token)!.k).toBe(row.key_id);
    // the trigger: a stale writer that sends a shorter revoked list cannot drop an id
    await rest("PATCH", `api_accounts?token=eq.${a.token}`, { revoked_key_ids: ["x1", "x2"] });
    await rest("PATCH", `api_accounts?token=eq.${a.token}`, { revoked_key_ids: ["x1"] });
    expect(((await fresh(a.token)).revoked_key_ids ?? []).sort()).toEqual(["x1", "x2"]);
    expect((await fresh(a.token)).revocation_pending).toBe(true);
  });

  it("the unique-per-email free allowance and the monthly ceiling, through the route and the real function", async () => {
    const { POST } = await import("@/app/api/free-account/route");
    const email = `rd-${uid()}@example.test`;
    const post = (e: string, ip: string) => POST(new Request(siteUrl("/api/free-account"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify({ email: e }) }));
    const r1 = await post(email, "10.9.0.1");
    const r2 = await post(email, "10.9.0.2");
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual(await r2.json());
    const rows = ((await rest<any[]>("GET", `api_accounts?email=eq.${email}`)) as { data: any[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plan: "api_free", free_email_norm: email });
    expect(rows[0].account).toMatch(/^rd-[a-z0-9]+-[0-9a-f]{10}$/); // an unguessable suffix, not a hash of the address
    // The ceiling counts VERIFIED accounts, at the first key mint from the emailed link: sign-up never reveals it.
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const verified = ((await rest<any[]>("GET", `api_accounts?free_verified_at=gte.${monthStart}&select=id`)) as { data: any[] }).data.length;
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX = String(verified + 1);
    const second = `rd-${uid()}@example.test`;
    expect((await post(second, "10.9.0.3")).status).toBe(200);
    const mint = async (e: string) => {
      const row = ((await rest<any[]>("GET", `api_accounts?email=eq.${e}`)) as { data: any[] }).data[0];
      const { POST: keys } = await import("@/app/api/keys/route");
      return keys(new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "10.9.1.1" }, body: JSON.stringify({ token: row.token }) }));
    };
    expect((await mint(email)).status).toBe(200); // takes the last verified place this month
    const over = await mint(second);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ reason: "capacity" });
    expect((await mint(email)).status).toBe(200); // already verified: never turned away, not counted twice
    expect((await post(`rd-${uid()}@example.test`, "10.9.0.4")).status).toBe(200); // and sign-up still answers the same
  });

  it("quarantine and the multi-page head, against the real transaction: a bad event is set aside, the cursor passes it, and 1200 events are all ingested", async () => {
    const a = await newAccount();
    const { ingestLedger, ackQuarantinedEvent } = await import("@/lib/payg-usage");
    const events = Array.from({ length: 1200 }, () => ev(a.account, { units: 1 }));
    events[600] = { ...events[600], units: 0 }; // unreadable: quarantined
    events[700] = { ...events[700], idem: "i".repeat(700) }; // long idem: accepted
    await rest("PATCH", `payg_cursor?id=eq.1`, { last_seq: (events[0].seq as number) - 1 });
    const fetcher = async (after: number, limit: number) => {
      const page = events.filter((e) => (e.seq as number) > after).slice(0, limit);
      return { ok: true as const, events: page, last_seq: page.length ? (page[page.length - 1].seq as number) : after, head_seq: events[events.length - 1].seq as number, durable: true };
    };
    const r = await ingestLedger(fetcher);
    expect(r).toMatchObject({ ok: true, complete: true, inserted: 1199, quarantined: 1, cursor: events[1199].seq });
    const q = ((await rest<any[]>("GET", `usage_quarantine?seq=eq.${events[600].seq}`)) as { data: any[] }).data;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ reason: "units out of range", acked_at: null });
    expect(await ackQuarantinedEvent(events[600].seq as number, "reviewed in test")).toBe(true);
    expect(((await rest<any[]>("GET", `usage_quarantine?seq=eq.${events[600].seq}`)) as { data: any[] }).data[0].acked_note).toBe("reviewed in test");
  });

  it("overlap keys and verified-at survive the real PATCH path: the sweep leaves a live overlap key alone until its day has passed", async () => {
    const { retryRevocations } = await import("@/lib/api-access");
    const expiry = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const a = await newAccount({ plan: "api_scale", cap_units: null, monthly_units: 100, key_id: "ovl-old-key", key_scope: "machine", key_issued_at: "2026-10-01", key_expires_at: expiry });
    const out = await mintChecked({ ...a }, {}); // not rotating: an overlap
    expect(out.ok).toBe(true);
    const row = await fresh(a.token);
    expect(row.overlap_key_ids).toEqual({ "ovl-old-key": expiry });
    expect(row.revoked_key_ids).toContain("ovl-old-key");
    await retryRevocations(200, new Date());
    expect(engine.revokeCalls).not.toContain("ovl-old-key");
    await retryRevocations(200, new Date(Date.now() + 5 * 86_400_000));
    expect(engine.revokeCalls).toContain("ovl-old-key");
    expect((await fresh(a.token)).revoked_confirmed_ids).toContain("ovl-old-key");
  });

  it("the Founding slot reservation returns the shapes the route reads (uuid string, then null) and serialises", async () => {
    await rest("DELETE", "founding_reservations?id=not.is.null");
    const { rpc } = await import("@/lib/pgrest");
    const calls = await Promise.all(Array.from({ length: 8 }, () => rpc<string | null>("gf_founding_reserve", { p_paid: 3, p_total: 5, p_ttl_minutes: 35 })));
    expect(calls.every((c) => c.ok)).toBe(true);
    const got = calls.map((c) => (c as { data: string | null }).data).filter(Boolean);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(/^[0-9a-f-]{36}$/);
    await rest("DELETE", "founding_reservations?id=not.is.null");
  });

  it("funnel events: allow-listed props round-trip, a duplicate key is ignored without an error, null keys all record", async () => {
    const { recordFunnelEvent } = await import("@/lib/funnel");
    const key = `rd:${uid()}`;
    expect(await recordFunnelEvent("payg_enabled", { cap_eur: 100 }, { dedupeKey: key })).toBe(true);
    expect(await recordFunnelEvent("payg_enabled", { cap_eur: 100 }, { dedupeKey: key })).toBe(false);
    expect(await recordFunnelEvent("key_minted", { scope: "payg" })).toBe(true);
    expect(await recordFunnelEvent("key_minted", { scope: "payg" })).toBe(true);
    expect(await recordFunnelEvent("key_minted", { email: "a@b.example" } as never)).toBe(false);
    const { funnelKey } = await import("@/lib/payg");
    const rows = ((await rest<any[]>("GET", `funnel_events?dedupe_key=eq.${funnelKey(key)}`)) as { data: any[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].props).toEqual({ cap_eur: 100 });
  });

  it("the admin funnel and economics reports against the real SQL read functions (cohort, strict steps, ledger-derived use and retention, month revenue)", async () => {
    const { funnelReport, economicsReport } = await import("@/lib/payg-analytics");
    const { recordFunnelEvent } = await import("@/lib/funnel");
    const { accountRef } = await import("@/lib/payg");
    const step = (r: any, key: string) => r.steps.find((x: any) => x.key === key);
    const base: any = await funnelReport(30);
    expect(base.ok).toBe(true);
    const a = await newAccount();
    const ref = accountRef(a.account);
    await recordFunnelEvent("free_account_created", { plan: "api_free", account_ref: ref }, { dedupeKey: `rd-fc:${a.account}` });
    await recordFunnelEvent("key_minted", { scope: "trial", plan: "api_free", account_ref: ref }, { dedupeKey: `rd-km:${a.account}` });
    await recordFunnelEvent("payg_enabled", { cap_eur: 100, account_ref: ref }, { dedupeKey: `rd-pe:${a.account}` });
    await recordFunnelEvent("first_charge", { month: "2026-09", account_ref: ref }, { dedupeKey: `rd-ch:${a.account}` });
    const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    for (const [i, at] of [d(10), d(2)].entries()) await rest("POST", "usage_events", { event_id: `fr${uid()}${i}`, seq: ++seqBase, account: a.account, scope: "payg", units: 3, kind: "charge", occurred_at: at });
    const after: any = await funnelReport(30);
    expect(after.ok).toBe(true);
    for (const key of ["free_account_created", "key_minted", "first_engine_use", "payg_enabled", "first_charge", "repeat_usage"]) {
      expect(step(after, key).count - step(base, key).count, key).toBe(1);
    }
    expect(step(after, "first_engine_use").source).toBe("derived");
    expect(JSON.stringify(after)).not.toMatch(new RegExp(`${a.account}|${ref}|@`));
    // economics: this month's ledger and a month with nothing in it, through the real month-summary function.
    // The two events above sit 10 and 2 days ago, so they fall in THIS month only from the 11th: asserting the month's units from them
    // made this test fail on the 1st to the 10th of every month (and every real-database CI run with it). The month's own event is dated
    // inside the month, as the usage-alerts test below does, so the assertion holds on any day.
    const month = new Date().toISOString().slice(0, 7);
    await rest("POST", "usage_events", { event_id: `ec${uid()}`, seq: ++seqBase, account: a.account, scope: "payg", units: 6, kind: "charge", occurred_at: `${month}-01T00:00:00Z` });
    const econ: any = await economicsReport(month, null);
    expect(econ.ok).toBe(true);
    expect(econ.revenue.payg_units).toBeGreaterThanOrEqual(6);
    expect(econ.compute).toMatchObject({ available: false });
    expect(econ.margin.claimed).toBe(false);
    const empty: any = await economicsReport("2001-01", null);
    expect(empty.revenue).toMatchObject({ payg_units: 0, accrued_payg_cents: 0, active_accounts: 0 });
  });

  it("usage alerts: once per account / month / percent through the real unique keys and the real outbox", async () => {
    // Real clock on purpose: the outbox's next_attempt_at defaults to the DATABASE's now(), and an alert is for the current month.
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const a = await newAccount({ cap_units: 50 });
    await rest("POST", "usage_events", { event_id: `al${uid()}`, seq: ++seqBase, account: a.account, scope: "payg", units: 45, kind: "charge", occurred_at: `${month}-01T00:00:01Z` });
    const { sendUsageAlerts } = await import("@/lib/payg-alerts");
    await sendUsageAlerts(now);
    await sendUsageAlerts(now);
    const rows = ((await rest<any[]>("GET", `usage_alerts?account=eq.${a.account}`)) as { data: any[] }).data;
    expect(rows.map((r) => r.percent)).toEqual([80]);
    expect(mail.filter((m) => m.to === `${a.account}@example.test` && /GridForge:/.test(m.subject))).toHaveLength(1);
  });
});
