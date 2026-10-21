/**
 * Second-pass review fixes (F2-F13) in ingest, settlement, keys, free accounts and the return flow. Each section names the defect it
 * closes; Stripe is a MOCK (MockStripe), email goes to a sink, the store is the in-memory PostgREST with SQL mirrors (SUPPLEMENTAL:
 * tests/test_payg_migration.py and tests/site/payg.realdb.test.ts run the real SQL and PostgREST). No live service is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { siteUrl } from "@/lib/site";
import { inspectKey, mintChecked, retryRevocations, type ApiAccount } from "@/lib/api-access";
import { PAYG, paygChargeCents } from "@/lib/products";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MockStripe, ledgerEvent, ledgerFetcherOver, mockEngine, newPaygDb, paygAccount, resetSeq, type MockEngine } from "./payg-harness";
import { PgError, type PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let stripe: MockStripe;
let mail: { to: string; subject: string; text: string }[];
const NOW = new Date("2026-10-21T03:23:00Z");

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder", GRIDFORGE_KEY_SECRET: "test-signing-secret",
    RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>", CRON_SECRET: "cron-secret",
  });
  delete process.env.GRIDFORGE_FREE_ACCOUNTS_MAX;
  delete process.env.FUNNEL_REF_KEY;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetSeq();
  resetMemoryLimiter();
  db = newPaygDb();
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  stripe = new MockStripe();
  setPaygStripeForTests(stripe);
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); });

const usage = () => import("@/lib/payg-usage");
const cron = () => import("@/lib/payg-cron");
const settle = () => import("@/lib/payg-settle");
const cursor = () => db.rows("payg_cursor")[0].last_seq as number;
const settlements = () => db.rows("usage_settlements") as any[];
const opsMail = (re: RegExp) => mail.filter((m) => m.to === "ops@example.test" && re.test(m.subject));
let ipn = 0;
const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.7.${Math.floor(++ipn / 250)}.${(ipn % 250) + 1}` }, body: JSON.stringify(body) });

// ------------------------------------------------------------------------------------------------------ F2: the head

describe("F2: ingest is complete only when the cursor reaches the engine's HEAD, never the last seq of the page it just read", () => {
  it("1200 events in 500-event pages: all three pages are ingested, and the month is invoiced for 1200 units, not 500", async () => {
    paygAccount(db);
    const events = Array.from({ length: 1200 }, () => ledgerEvent({ units: 1 }));
    const report = await (await cron()).runPaygCron({ fetcher: ledgerFetcherOver(events), stripe, now: NOW });
    expect(report.ingest).toMatchObject({ ok: true, complete: true, inserted: 1200, cursor: 1200, headSeq: 1200 });
    expect(settlements()).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ month: "2026-09", units: 1200, amount_cents: paygChargeCents(1200) });
    expect(stripe.items[0].amount).toBe(paygChargeCents(1200));
  });

  it("when the page budget runs out first, the result is NOT complete and nothing is settled on the partial copy", async () => {
    paygAccount(db);
    const events = Array.from({ length: 1200 }, () => ledgerEvent({ units: 1 }));
    const { ingestLedger } = await usage();
    const r = await ingestLedger(ledgerFetcherOver(events), { pageSize: 500, maxPages: 1 });
    expect(r).toMatchObject({ ok: true, complete: false, inserted: 500, cursor: 500, headSeq: 1200 });
    const { runPaygCron } = await cron();
    // a cron whose ingest stops short must skip settlement; simulate with a fetcher that always claims a head far ahead
    const short = ledgerFetcherOver(events.slice(0, 500), { headSeq: 1200 });
    const report = await runPaygCron({ fetcher: short, stripe, now: NOW });
    expect(report.settle).toHaveProperty("skipped");
    expect(settlements()).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
  });

  it("the test fetcher really mirrors the engine: last_seq is the last event IN THE PAGE and head_seq is separate", async () => {
    const events = Array.from({ length: 7 }, () => ledgerEvent());
    const f = ledgerFetcherOver(events);
    const p = (await f(0, 3)) as { last_seq: number; head_seq: number; events: unknown[] };
    expect([p.events.length, p.last_seq, p.head_seq]).toEqual([3, 3, 7]);
    const empty = (await f(7, 3)) as { last_seq: number; head_seq: number };
    expect([empty.last_seq, empty.head_seq]).toEqual([7, 7]);
  });

  it("a head BEHIND the cursor (a restored or lost ledger volume) is an alarm: nothing settles and the operator is told", async () => {
    paygAccount(db);
    db.rows("payg_cursor")[0].last_seq = 40;
    db.rows("usage_events").push({ event_id: "old", seq: 40, account: "acme-123456", scope: "payg", kind: "charge", units: 50, occurred_at: "2026-09-10T00:00:00.000Z", ref: "" });
    const report = await (await cron()).runPaygCron({ fetcher: ledgerFetcherOver([], { headSeq: 3 }), stripe, now: NOW });
    expect(report.ingest).toMatchObject({ ok: false, complete: false, alarm: "ledger_behind" });
    expect(report.settle).toHaveProperty("skipped");
    expect(settlements()).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
    expect(cursor()).toBe(40); // never moved back, never moved on
    expect(opsMail(/ledger alarm.*BEHIND/i)).toHaveLength(1);
  });

  it("a ledger that is not durable is an alarm too", async () => {
    paygAccount(db);
    const report = await (await cron()).runPaygCron({ fetcher: ledgerFetcherOver([ledgerEvent()], { durable: false }), stripe, now: NOW });
    expect(report.ingest).toMatchObject({ ok: false, alarm: "not_durable" });
    expect(settlements()).toHaveLength(0);
    expect(opsMail(/not durable/i)).toHaveLength(1);
  });

  it("an engine answer with no head_seq is an error (the head cannot be guessed), as is a head ahead of an empty page", async () => {
    const { engineLedgerFetcher, ingestLedger } = await usage();
    process.env.GRIDFORGE_API_URL = "https://engine.test/";
    process.env.GRIDFORGE_ADMIN_KEY = "k";
    const inner = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
      String(i).startsWith("https://engine.test/v1/admin/ledger") ? new Response(JSON.stringify({ events: [], last_seq: 0, durable: true }), { status: 200 }) : inner(i as RequestInfo, init)) as typeof fetch;
    const r = await engineLedgerFetcher()!(0, 10);
    globalThis.fetch = inner;
    expect(r).toEqual({ ok: false, error: "engine ledger answer has no head_seq" });
    const stuck = await ingestLedger(async () => ({ ok: true as const, events: [], last_seq: 0, head_seq: 9, durable: true }));
    expect(stuck.ok).toBe(false);
    expect(stuck.complete).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------- F3: quarantine

describe("F3: one unreadable event is quarantined, not fatal, and never lets its month settle silently", () => {
  it("a long idempotency key (the engine caps it, but a long one must never stall the ledger) is simply accepted", async () => {
    const { ingestLedger } = await usage();
    const r = await ingestLedger(ledgerFetcherOver([ledgerEvent({ idem: "x".repeat(600) }), ledgerEvent()]));
    expect(r).toMatchObject({ ok: true, complete: true, inserted: 2, quarantined: 0 });
  });

  it("an event out of range is set aside WITH its reason; the others are ingested and the cursor moves past it", async () => {
    const { ingestLedger } = await usage();
    const events = [ledgerEvent({ units: 3 }), ledgerEvent({ units: 0 }), ledgerEvent({ kind: "give-away" }), ledgerEvent({ endpoint: "e".repeat(500) }), ledgerEvent({ units: 4 })];
    const r = await ingestLedger(ledgerFetcherOver(events));
    expect(r).toMatchObject({ ok: true, complete: true, inserted: 2, quarantined: 3, cursor: 5 });
    expect(cursor()).toBe(5);
    expect(db.rows("usage_events").map((e: any) => e.units)).toEqual([3, 4]);
    const q = db.rows("usage_quarantine") as any[];
    expect(q.map((x) => [x.seq, x.reason])).toEqual([[2, "units out of range"], [3, "unknown kind"], [4, "bad endpoint"]]);
    expect(q[0]).toMatchObject({ month: "2026-09", acked_at: null });
    expect(q[0].raw).toContain("\"units\":0");
  });

  it("the operator is mailed once when something is quarantined, and the cron keeps going for everyone else", async () => {
    paygAccount(db);
    const events = [ledgerEvent({ units: 10 }), ledgerEvent({ units: 0, ts: "2026-08-10T00:00:00+00:00" })];
    const report = await (await cron()).runPaygCron({ fetcher: ledgerFetcherOver(events), stripe, now: NOW });
    expect(report.ingest).toMatchObject({ ok: true, complete: true, quarantined: 1 });
    expect(opsMail(/quarantined/i)).toHaveLength(1);
  });

  it("a month with an un-acknowledged quarantined event is NOT settled; other months are; after the operator acknowledges it, it is", async () => {
    paygAccount(db);
    const events = [
      ledgerEvent({ units: 10, ts: "2026-09-10T00:00:00+00:00" }),
      ledgerEvent({ units: 0, ts: "2026-09-11T00:00:00+00:00" }), // quarantined, claims September
      ledgerEvent({ units: 10, ts: "2026-08-10T00:00:00+00:00" }),
    ];
    const { runPaygCron } = await cron();
    const first = await runPaygCron({ fetcher: ledgerFetcherOver(events), stripe, now: NOW });
    expect(first.settle).toMatchObject({ heldByQuarantine: 1 });
    expect(settlements().map((s) => s.month)).toEqual(["2026-08"]); // August settled; September held
    expect(opsMail(/held by quarantined/i).length).toBeGreaterThan(0);
    await runPaygCron({ fetcher: ledgerFetcherOver(events), stripe, now: NOW });
    expect(settlements().map((s) => s.month)).toEqual(["2026-08"]);
    const { ackQuarantinedEvent } = await usage();
    expect(await ackQuarantinedEvent(2, "reviewed: a zero-unit event, nothing to bill")).toBe(true);
    await runPaygCron({ fetcher: ledgerFetcherOver(events), stripe, now: NOW });
    expect(settlements().map((s) => s.month).sort()).toEqual(["2026-08", "2026-09"]);
    expect((db.rows("usage_quarantine") as any[])[0].acked_note).toMatch(/reviewed/);
  });

  it("an unreadable TIMESTAMP could belong to any month, so it holds every month until acknowledged", async () => {
    paygAccount(db);
    const events = [ledgerEvent({ units: 10 }), { ...ledgerEvent({ seq: 2 }), ts: "not a time" }];
    const { runPaygCron } = await cron();
    const r = await runPaygCron({ fetcher: ledgerFetcherOver(events), stripe, now: NOW });
    expect(r.ingest).toMatchObject({ quarantined: 1 });
    expect(settlements()).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
    expect((db.rows("usage_quarantine") as any[])[0].month).toBeNull();
  });

  it("if the quarantine cannot be read, nothing is settled (we cannot tell what is held)", async () => {
    paygAccount(db);
    const { ingestLedger } = await usage();
    await ingestLedger(ledgerFetcherOver([ledgerEvent({ units: 10 })]));
    db.dropTable("usage_quarantine");
    const r = await (await settle()).settleClosedMonths(stripe, NOW);
    expect(r.errors.join()).toMatch(/quarantine/);
    expect(settlements()).toHaveLength(0);
  });

  it("an event with no readable seq still refuses the page whole (it cannot be placed in the sequence)", async () => {
    const { ingestLedger } = await usage();
    // a raw page (the engine's own filtering would not drop it): one good event, then one with no seq at all
    const r = await ingestLedger(async () => ({ ok: true as const, events: [ledgerEvent({ seq: 1 }), { id: "x", units: 3 }], last_seq: 2, head_seq: 2, durable: true }));
    expect(r.ok).toBe(false);
    expect(cursor()).toBe(0);
    expect(db.rows("usage_quarantine")).toHaveLength(0);
  });

  it("a replayed page quarantines nothing twice", async () => {
    const { ingestLedger } = await usage();
    const f = ledgerFetcherOver([ledgerEvent(), ledgerEvent({ units: 0 })]);
    await ingestLedger(f);
    db.rows("payg_cursor")[0].last_seq = 0;
    const r = await ingestLedger(f);
    expect(r).toMatchObject({ ok: true, inserted: 0, quarantined: 0 });
    expect(db.rows("usage_quarantine")).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------------- F4: carried months, one run

describe("F4: a carried month is absorbed by exactly one invoice, even with a backlog of months in one run", () => {
  it("Jul 1 unit (carried), Aug 10, Sep 10 in a single run: billed 11 + 10 = 21 units, not 22", async () => {
    paygAccount(db);
    const { ingestLedger } = await usage();
    await ingestLedger(ledgerFetcherOver([
      ledgerEvent({ units: 1, ts: "2026-07-10T10:00:00+00:00" }),
      ledgerEvent({ units: 10, ts: "2026-08-10T10:00:00+00:00" }),
      ledgerEvent({ units: 10, ts: "2026-09-10T10:00:00+00:00" }),
    ]));
    await (await settle()).settleClosedMonths(stripe, NOW);
    const by = Object.fromEntries(settlements().map((s) => [s.month, s]));
    expect(by["2026-07"]).toMatchObject({ status: "carried", rolled_into: "2026-08" });
    expect(by["2026-08"]).toMatchObject({ status: "invoiced", units: 11, carried_units: 1, carried_months: ["2026-07"] });
    expect(by["2026-09"]).toMatchObject({ status: "invoiced", units: 10, carried_units: 0, carried_months: [] });
    expect(settlements().filter((s) => s.status === "invoiced").reduce((n, s) => n + s.units, 0)).toBe(21);
    expect(stripe.items.reduce((n, i) => n + i.amount, 0)).toBe(paygChargeCents(21));
  });

  it("if marking the carried month fails, the account's later months wait for the next run rather than double-count it", async () => {
    paygAccount(db);
    const { ingestLedger } = await usage();
    await ingestLedger(ledgerFetcherOver([
      ledgerEvent({ units: 1, ts: "2026-07-10T10:00:00+00:00" }),
      ledgerEvent({ units: 10, ts: "2026-08-10T10:00:00+00:00" }),
      ledgerEvent({ units: 10, ts: "2026-09-10T10:00:00+00:00" }),
    ]));
    const real = globalThis.fetch;
    let failing = true;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
      failing && init?.method === "PATCH" && String(i).includes("/usage_settlements") && String(init.body).includes("rolled_into") ? new Response("{}", { status: 500 }) : real(i as RequestInfo, init)) as typeof fetch;
    await (await settle()).settleClosedMonths(stripe, NOW);
    expect(settlements().map((s) => s.month)).toEqual(["2026-07", "2026-08"]); // September waits
    failing = false;
    await (await settle()).settleClosedMonths(stripe, NOW);
    globalThis.fetch = real;
    expect(settlements().filter((s) => s.status === "invoiced").reduce((n, s) => n + s.units, 0)).toBe(21);
  });
});

// ------------------------------------------------------------------------------------------ F5: overlapping keys

describe("F5: a key left live ON PURPOSE is not killed by the daily revocation sweep before its overlap ends", () => {
  const near = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it("an overlap mint is recorded as an overlap; the sweep leaves the old key alone until its last valid day has passed, then revokes it", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100, key_id: "oldkey01", key_scope: "machine", key_issued_at: "2026-10-01", key_expires_at: near(3) });
    const { POST } = await import("@/app/api/keys/route");
    const j = await (await POST(post("/api/keys", { token: a.token }))).json();
    expect(j).toMatchObject({ ok: true, issued: true, previous_key_overlaps_until_expiry: true });
    expect(engine.revokeCalls).toEqual([]);
    expect(a.overlap_key_ids).toEqual({ oldkey01: near(3) });
    expect(a.revoked_key_ids).toContain("oldkey01"); // tracked, so a cancellation revokes it at once

    // days before the overlap ends: the sweep must not touch it
    expect(await retryRevocations(50, new Date())).toEqual({ accounts: 1, confirmed: 0, stillPending: 0 });
    expect(await retryRevocations(50, new Date(Date.now() + 3 * 86_400_000))).toEqual({ accounts: 1, confirmed: 0, stillPending: 0 }); // its last valid day
    expect(engine.revokeCalls).toEqual([]);
    // the day after, it is revoked and confirmed
    expect(await retryRevocations(50, new Date(Date.now() + 4 * 86_400_000))).toEqual({ accounts: 1, confirmed: 1, stillPending: 0 });
    expect(engine.revokeCalls).toEqual(["oldkey01"]);
    expect(a.revocation_pending).toBe(false);
  });

  it("a rotating mint is NOT an overlap: its previous id is revoked immediately and retried by the sweep as before", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100, key_id: "oldkey01", key_scope: "machine", key_issued_at: "2026-10-01", key_expires_at: near(20) });
    engine.refuseRevoke = true;
    const { POST } = await import("@/app/api/keys/route");
    await POST(post("/api/keys", { token: a.token, rotate: true }));
    expect(a.overlap_key_ids).toEqual({});
    engine.refuseRevoke = false;
    expect(await retryRevocations()).toEqual({ accounts: 1, confirmed: 1, stillPending: 0 });
  });

  it("cancellation and suspension still kill an overlapping key at once (it is live, so it must die with the account)", async () => {
    const a = paygAccount(db, { cap_units: 50, key_id: "newkey01", key_scope: "payg", key_expires_at: near(30), revoked_key_ids: ["oldkey01"], overlap_key_ids: { oldkey01: near(3) } });
    db.insertRow("usage_settlements", { account: "acme-123456", month: "2026-09", units: 10, amount_cents: 2000, status: "invoiced", stripe_invoice_id: "in_1" });
    const { handlePaygInvoice } = await import("@/lib/payg-billing");
    await handlePaygInvoice({ type: "invoice.payment_failed", data: { object: { id: "in_1", metadata: { kind: "payg_settlement", account: "acme-123456", month: "2026-09" } } } } as never);
    expect(a.status).toBe("past_due");
    expect(engine.revokeCalls.sort()).toEqual(["newkey01", "oldkey01"]);
    expect(a.revocation_pending).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- F7: account ids

describe("F7: free-account ids are unguessable, a collision is retried, and a pre-registered id cannot lock an address out", () => {
  it("the id carries 40 random bits; two sign-ups with the same stem never share an id", async () => {
    const { freeAccountId } = await import("@/lib/payg-accounts");
    const ids = new Set(Array.from({ length: 50 }, () => freeAccountId("alice@gmail.com")));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^alice-[0-9a-f]{10}$/);
  });

  it("an attacker who pre-registered the OLD hash-derived id for alice cannot lock her out: she signs up and gets a different id", async () => {
    const { accountIdFor } = await import("@/lib/api-access");
    paygAccount(db, { account: accountIdFor("alice@gmail.com", "", null), token: "attacker-token-0123456789abcdef", plan: "api_scale" });
    const { POST } = await import("@/app/api/free-account/route");
    const res = await POST(post("/api/free-account", { email: "alice@gmail.com" }));
    expect(res.status).toBe(200);
    const mine = (db.rows("api_accounts") as any[]).find((a) => a.free_email_norm === "alice@gmail.com");
    expect(mine).toBeTruthy();
    expect(mine.account).not.toBe(accountIdFor("alice@gmail.com", "", null));
  });

  it("a unique_violation on the account id or token is retried with fresh random values, a bounded number of times", async () => {
    const { createFreeAccount } = await import("@/lib/payg-accounts");
    const seen: { account: string; token: string }[] = [];
    const real = db.rpcs.get("gf_free_account_create")!;
    db.rpcs.set("gf_free_account_create", (args, d) => {
      seen.push({ account: args.p_account, token: args.p_token });
      if (seen.length <= 2) throw new PgError("23505", "duplicate key value violates unique constraint", 409);
      return real(args, d);
    });
    const r = await createFreeAccount("carol@example.com", null);
    expect(r).toMatchObject({ ok: true, created: true });
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.account)).size).toBe(3);
    expect(new Set(seen.map((s) => s.token)).size).toBe(3);
    // and it gives up after four, with no account
    db.rpcs.set("gf_free_account_create", () => { seen.push({ account: "x", token: "y" }); throw new PgError("23505", "dup", 409); });
    seen.length = 0;
    expect(await createFreeAccount("dave@example.com", null)).toEqual({ ok: false, reason: "store" });
    expect(seen).toHaveLength(4);
  });

  it("existing accounts keep their ids (nothing renames them)", async () => {
    const a = paygAccount(db, { account: "old-style-ab12cd", plan: "api_free", free_email_norm: "erin@example.com", email: "erin@example.com", token: "erin-token-0123456789abcdefgh" });
    const { createFreeAccount } = await import("@/lib/payg-accounts");
    await createFreeAccount("erin@example.com", null);
    expect(a.account).toBe("old-style-ab12cd");
    expect(db.rows("api_accounts")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------ F9: key reminders, guard

describe("F9: free and pay-as-you-go keys are reminded before they expire, once per key; /api/keys is rate limited; key_minted is once per key", () => {
  const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const reminders = () => mail.filter((m) => /API key (expires|has expired)|expires shortly/i.test(m.subject) || /Your GridForge API key/.test(m.subject));

  it("the cron queues one reminder for a payg or free key within 7 days of expiry, and none for a healthy or long-dead one", async () => {
    paygAccount(db, { account: "soon", token: "tok-soon-0123456789abcdefghijk", email: "soon@x.example", key_id: "k1", key_scope: "payg", key_expires_at: daysFromNow(3) });
    paygAccount(db, { account: "free1", token: "tok-free-0123456789abcdefghijk", email: "free@x.example", plan: "api_free", cap_units: null, key_id: "k2", key_scope: "trial", key_expires_at: daysFromNow(6) });
    paygAccount(db, { account: "fine", token: "tok-fine-0123456789abcdefghijk", email: "fine@x.example", key_id: "k3", key_scope: "payg", key_expires_at: daysFromNow(30) });
    paygAccount(db, { account: "dead", token: "tok-dead-0123456789abcdefghijk", email: "dead@x.example", key_id: "k4", key_scope: "payg", key_expires_at: daysFromNow(-60) });
    paygAccount(db, { account: "sub", token: "tok-subs-0123456789abcdefghijk", email: "sub@x.example", plan: "api_scale", key_id: "k5", key_scope: "machine", key_expires_at: daysFromNow(2) });
    const { runPaygCron } = await cron();
    const r1 = await runPaygCron({ fetcher: ledgerFetcherOver([]), stripe, now: new Date() });
    expect(r1.reminders).toMatchObject({ considered: 2, queued: 2 });
    expect(reminders().map((m) => m.to).sort()).toEqual(["free@x.example", "soon@x.example"]);
    for (const m of reminders()) {
      expect(m.text).toMatch(/does not extend a key|extends a key/);
      expect(m.text).toContain("/api-access/");
      expect(m.text).not.toMatch(/subscription/i);
    }
    // a second run (and a third) sends nothing more for the same keys
    await runPaygCron({ fetcher: ledgerFetcherOver([]), stripe, now: new Date() });
    await runPaygCron({ fetcher: ledgerFetcherOver([]), stripe, now: new Date() });
    expect(reminders()).toHaveLength(2);
  });

  it("after the customer rotates, a reminder queued for the old key is cancelled unsent, and the new key gets its own when its time comes", async () => {
    const a = paygAccount(db, { key_id: "k1", key_scope: "payg", key_expires_at: daysFromNow(3), key_issued_at: daysFromNow(-32) });
    const { runPaygCron } = await cron();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i).startsWith("https://api.resend.com") ? new Response("{}", { status: 503 }) : realFetch(i as RequestInfo, init))) as typeof fetch;
    await runPaygCron({ fetcher: ledgerFetcherOver([]), stripe, now: new Date() }); // provider down: queued, not sent
    globalThis.fetch = realFetch;
    expect(reminders()).toHaveLength(0);
    a.key_expires_at = daysFromNow(35); // rotated
    const { sweepNotifications } = await import("@/lib/notifications");
    for (const n of db.rows("customer_notifications") as any[]) { n.next_attempt_at = new Date(0).toISOString(); n.claimed_until = null; }
    await sweepNotifications();
    expect(reminders()).toHaveLength(0);
    expect((db.rows("customer_notifications") as any[]).find((n) => n.kind === "key_rotation").status).toBe("cancelled");
  });

  it("POST /api/keys is rate limited per caller address (429 with Retry-After) and the refused request mints nothing", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100 });
    const { POST } = await import("@/app/api/keys/route");
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 33; i++) {
      statuses.push((await POST(new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify({ token: a.token }) }))).status);
    }
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429, 429]);
  });

  it("key_minted is written once per key id, however often the same mint is retried", async () => {
    const a = paygAccount(db, { cap_units: 50 });
    const { POST } = await import("@/app/api/keys/route");
    const j = await (await POST(post("/api/keys", { token: a.token }))).json();
    const keyId = inspectKey(j.key)!.k;
    const { recordFunnelEvent } = await import("@/lib/funnel");
    expect(await recordFunnelEvent("key_minted", { scope: "payg" }, { dedupeKey: `key_minted:${keyId}` })).toBe(false); // already written by the route
    expect((db.rows("funnel_events") as any[]).filter((e) => e.name === "key_minted")).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------- F10: normalisation

describe("F10: email normalisation", () => {
  it("strips a trailing dot, NFKC-normalises, and treats these as one address", async () => {
    const { normaliseFreeEmail, cleanEmail } = await import("@/lib/payg");
    expect(normaliseFreeEmail("alice@example.com.")).toBe("alice@example.com");
    expect(normaliseFreeEmail("alice@example.com...")).toBe("alice@example.com");
    expect(normaliseFreeEmail("ＡＬＩＣＥ@ＥＸＡＭＰＬＥ．ＣＯＭ")).toBe("alice@example.com"); // fullwidth forms
    expect(normaliseFreeEmail("Alice+x@Example.COM")).toBe("alice@example.com");
    expect(cleanEmail("Alice+x@Example.COM.")).toBe("alice+x@example.com"); // what is mailed: the typed address, tidied
    expect(normaliseFreeEmail("a.l.i.c.e+z@googlemail.com")).toBe("alice@gmail.com");
  });

  it("rejects quoted local parts, comments, control characters, bad domains and IP literals", async () => {
    const { normaliseFreeEmail } = await import("@/lib/payg");
    for (const bad of [
      '"alice smith"@example.com', '"a@b"@example.com', "alice(comment)@example.com", "<alice@example.com>", "alice@example.com;bob@example.com", "alice@example.com,bob@example.com",
      "alice@@example.com", "a\u0000b@example.com", "alice@exam ple.com", "alice@-example.com", "alice@example-.com", "alice@example..com", "alice@example", "alice@.com",
      ".alice@example.com", "alice.@example.com", "al..ice@example.com", "alice@123.45.67.89", "alice@[127.0.0.1]", "x".repeat(300) + "@example.com", "", " ", "a@b.c" + "d".repeat(70),
    ]) expect(normaliseFreeEmail(bad), JSON.stringify(bad)).toBeNull();
    expect(normaliseFreeEmail(42 as never)).toBeNull();
  });

  it("the sign-up route rejects them (400) and creates nothing; a trailing-dot variant is the same account", async () => {
    const { POST } = await import("@/app/api/free-account/route");
    expect((await POST(post("/api/free-account", { email: '"x y"@example.com' }))).status).toBe(400);
    expect((await POST(post("/api/free-account", { email: "frank@example.com" }))).status).toBe(200);
    expect((await POST(post("/api/free-account", { email: "frank@example.com." }))).status).toBe(200);
    expect(db.rows("api_accounts")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------- F11: account_ref

describe("F11: funnel account references are an HMAC under a server secret, domain-separated, never a bare hash", () => {
  it("is not the bare SHA-256 of the account, differs per secret, and is stable under one secret", async () => {
    const { accountRef } = await import("@/lib/payg");
    const bare = crypto.createHash("sha256").update("gf-funnel-v1:acme-123456").digest("hex").slice(0, 12);
    const a = accountRef("acme-123456");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).not.toBe(bare);
    expect(accountRef("acme-123456")).toBe(a);
    process.env.GRIDFORGE_KEY_SECRET = "another-signing-secret";
    expect(accountRef("acme-123456")).not.toBe(a);
    // a dedicated key wins, and the signing secret itself never signs these (domain separation)
    process.env.FUNNEL_REF_KEY = "dedicated-funnel-key-0123456789";
    const d = accountRef("acme-123456");
    expect(d).not.toBe(a);
    const direct = crypto.createHmac("sha256", process.env.GRIDFORGE_KEY_SECRET).update("account:acme-123456").digest("hex").slice(0, 12);
    expect(accountRef("acme-123456")).not.toBe(direct);
  });

  it("with no secret configured it is still keyed (per process), never a constant anyone could recompute", async () => {
    delete process.env.GRIDFORGE_KEY_SECRET;
    delete process.env.FUNNEL_REF_KEY;
    const { accountRef } = await import("@/lib/payg");
    const bare = crypto.createHash("sha256").update("gf-funnel-v1:acme-123456").digest("hex").slice(0, 12);
    expect(accountRef("acme-123456")).not.toBe(bare);
    expect(accountRef("acme-123456")).toBe(accountRef("acme-123456"));
  });
});

// ------------------------------------------------------------------------------------------------ F12: return flow

describe("F12: the portal token is not in any URL Stripe stores; the way back is a token-free URL resolved by a short-lived HttpOnly cookie", () => {
  const free = () => paygAccount(db, { account: "free-ab12", token: "free-token-0123456789abcdefgh", plan: "api_free", monthly_units: 25, cap_units: null, stripe_customer_id: null, stripe_payment_method_id: null });

  it("enable sends Stripe token-free success and cancel URLs and sets an HttpOnly, SameSite=Lax, path-scoped cookie", async () => {
    const a = free();
    const { POST } = await import("@/app/api/payg/enable/route");
    const res = await POST(post("/api/payg/enable", { token: a.token, cap_eur: 100 }));
    expect(res.status).toBe(200);
    const s = stripe.sessions[0];
    for (const url of [s.success_url, s.cancel_url]) {
      expect(url).not.toContain(a.token as string);
      expect(url).not.toMatch(/token=/);
    }
    expect(s.success_url).toMatch(/\/api\/payg\/return\?payg=success$/);
    expect(s.cancel_url).toMatch(/\/api\/payg\/return\?payg=cancelled$/);
    expect(JSON.stringify(s)).not.toContain(a.token as string); // nowhere in what Stripe was sent
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`gf_payg_return=${a.token}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/payg/);
    expect(cookie).toMatch(/Max-Age=3600/);
    expect(JSON.stringify(await res.json())).not.toContain(a.token as string);
  });

  it("returning WITH the cookie redirects to the portal and clears the cookie; the token is in the redirect only, not in the request URL", async () => {
    const { GET } = await import("@/app/api/payg/return/route");
    const res = await GET(new Request(siteUrl("/api/payg/return?payg=success"), { headers: { cookie: "gf_payg_return=free-token-0123456789abcdefgh; other=1" } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(siteUrl("/api-access/free-token-0123456789abcdefgh?payg=success"));
    expect(res.headers.get("set-cookie")).toMatch(/gf_payg_return=;.*Max-Age=0/);
  });

  it("returning WITHOUT the cookie (another browser, expired) gets a page that says to open the emailed link, and never a redirect", async () => {
    const { GET } = await import("@/app/api/payg/return/route");
    const res = await GET(new Request(siteUrl("/api/payg/return?payg=success")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/open the link in the email/i);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a forged or malformed cookie, and an unknown outcome, never produce an open redirect", async () => {
    const { GET } = await import("@/app/api/payg/return/route");
    for (const cookie of ["gf_payg_return=../../evil", "gf_payg_return=https://evil.example/x", "gf_payg_return=a b", "gf_payg_return=short"]) {
      const res = await GET(new Request(siteUrl("/api/payg/return?payg=success"), { headers: { cookie } }));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
    const ok = await GET(new Request(siteUrl("/api/payg/return?payg=%0d%0aSet-Cookie:x"), { headers: { cookie: "gf_payg_return=free-token-0123456789abcdefgh" } }));
    expect(ok.headers.get("location")).toBe(siteUrl("/api-access/free-token-0123456789abcdefgh?payg=cancelled"));
  });
});

// ---------------------------------------------------------------------------------------------- F13: one rule text

describe("F13: one billing-rule text, equal to the engine's string parsed out of gridforge/api/metering.py", () => {
  let engineText: string | null = null;
  try {
    engineText = execFileSync("python3", ["-c", "from gridforge.api.metering import BILLING_RULE; print(BILLING_RULE, end='')"], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  } catch {
    engineText = null;
  }

  it.skipIf(engineText === null)("lib/payg-pricing.ts billingRuleText() equals the engine's BILLING_RULE, and lib/payg.ts is that same function", async () => {
    const { billingRuleText } = await import("@/lib/payg-pricing");
    const payg = await import("@/lib/payg");
    expect(billingRuleText()).toBe(engineText);
    expect(payg.billingRuleText).toBe(billingRuleText);
  });

  it("there is exactly one definition of the sentence in the website's source", async () => {
    const fs = await import("node:fs");
    const hits = ["lib/payg.ts", "lib/payg-pricing.ts", "lib/payg-settle.ts", "lib/notifications.ts", "app/api/usage/route.ts"].filter((f) => /minimum invoice is not invoiced on its own/.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual(["lib/payg-pricing.ts"]);
  });
});

void PAYG; void mintChecked;
