/**
 * Pay-as-you-go: ledger ingest and month-end settlement (lib/payg-usage.ts, lib/payg-settle.ts, lib/payg-cron.ts).
 *
 * Stripe is a MOCK here (MockStripe in payg-harness.ts): no live Stripe call is made by any test in this file. The SQL functions the
 * code calls are mirrored in TypeScript (SUPPLEMENTAL); tests/test_payg_migration.py runs the real SQL.
 *
 * The rules under test: the cursor moves only with a durable insert; ingest is idempotent; a month is settled once however often the
 * cron runs; a failed Stripe call leaves a pending row and a retry creates exactly one invoice (even after Stripe forgot its
 * idempotency key); a month under the minimum invoice is carried and rolls forward; free (trial) usage is never invoiced;
 * refunds net out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestFake } from "./postgrest-fake";
import { MockStripe, ledgerEvent, ledgerFetcherOver, newPaygDb, paygAccount, resetSeq } from "./payg-harness";
import { PAYG, paygChargeCents } from "@/lib/products";
import { setPaygStripeForTests } from "@/lib/payg-stripe";

let db: PostgrestFake;
let restore: () => void;
let stripe: MockStripe;
const NOW = new Date("2026-10-21T03:23:00Z"); // September and earlier are closed

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetSeq();
  db = newPaygDb();
  restore = db.install();
  stripe = new MockStripe();
});
afterEach(() => { restore(); vi.restoreAllMocks(); });

const ingestLib = () => import("@/lib/payg-usage");
const settleLib = () => import("@/lib/payg-settle");
const cronLib = () => import("@/lib/payg-cron");
const cursor = () => db.rows("payg_cursor")[0].last_seq as number;
const settlements = () => db.rows("usage_settlements") as any[];

describe("ledger ingest", () => {
  it("is idempotent: the same pages ingested twice insert nothing new and the cursor stays put", async () => {
    const { ingestLedger } = await ingestLib();
    const events = [ledgerEvent(), ledgerEvent({ units: 3 }), ledgerEvent({ kind: "refund", units: 3, ref: "ev000002" })];
    const f = ledgerFetcherOver(events);
    const a = await ingestLedger(f);
    expect(a).toMatchObject({ ok: true, complete: true, inserted: 3, cursor: 3 });
    // A second run starts at the cursor and finds nothing; and even replaying page 1 by hand inserts nothing.
    const b = await ingestLedger(f);
    expect(b).toMatchObject({ ok: true, complete: true, inserted: 0, cursor: 3 });
    db.rows("payg_cursor")[0].last_seq = 0; // lose the cursor: a full replay
    const c = await ingestLedger(f);
    expect(c).toMatchObject({ ok: true, inserted: 0 });
    expect(db.rows("usage_events")).toHaveLength(3);
    expect(cursor()).toBe(3);
  });

  it("advances the cursor ONLY after the insert is durable: a failed write leaves the cursor where it was", async () => {
    const { ingestLedger } = await ingestLib();
    const events = [ledgerEvent(), ledgerEvent()];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).includes("/rpc/gf_usage_ingest")) return new Response(JSON.stringify({ code: "XX000", message: "disk full" }), { status: 500 });
      return realFetch(i as RequestInfo, init);
    }) as typeof fetch;
    const r = await ingestLedger(ledgerFetcherOver(events));
    globalThis.fetch = realFetch;
    expect(r.ok).toBe(false);
    expect(r.complete).toBe(false);
    expect(cursor()).toBe(0);
    expect(db.rows("usage_events")).toHaveLength(0);
  });

  it("rolls the whole page back (events AND cursor) when one event in it is refused by the database", async () => {
    const { ingestLedger } = await ingestLib();
    // seq 4 is already taken by an unrelated row; the page [3, 4] inserts 3, hits the unique seq on 4, and must undo 3 and the cursor
    const good = [ledgerEvent(), ledgerEvent()];
    await ingestLedger(ledgerFetcherOver(good));
    db.rows("usage_events").push({ event_id: "foreign", seq: 4, account: "x", scope: "payg", kind: "charge", units: 1, occurred_at: "2026-09-01T00:00:00.000Z", ref: "" });
    const r = await ingestLedger(ledgerFetcherOver([...good, ledgerEvent({ seq: 3 }), ledgerEvent({ seq: 4 })]));
    expect(r.ok).toBe(false);
    expect(cursor()).toBe(2);
    expect(db.rows("usage_events")).toHaveLength(3); // the two good ones and the foreign row; event 3 was rolled back
  });

  it("refuses a page with a gap in seq, or with an event that has no readable seq, whole (an unreadable BODY is quarantined instead: see payg-hardening.test.ts)", async () => {
    const { ingestLedger } = await ingestLib();
    const gap = await ingestLedger(ledgerFetcherOver([ledgerEvent({ seq: 1 }), ledgerEvent({ seq: 3 })]));
    expect(gap).toMatchObject({ ok: false });
    expect(gap.error).toMatch(/gap/);
    expect(cursor()).toBe(0);
    expect(db.rows("usage_events")).toHaveLength(0);

    const bad = await ingestLedger(ledgerFetcherOver([ledgerEvent({ seq: 1 }), { ...ledgerEvent({ seq: 2 }), seq: "2" } as never]));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no readable seq/);
    const bad2 = await ingestLedger(ledgerFetcherOver([{ nothing: "useful" } as never]));
    expect(bad2.ok).toBe(false);
    expect(cursor()).toBe(0);
    expect(db.rows("usage_events")).toHaveLength(0);
  });

  it("an engine that cannot be reached is an error, not an empty ledger, and nothing is settled on it", async () => {
    const { runPaygCron } = await cronLib();
    paygAccount(db);
    db.rows("usage_events").push({ event_id: "ev1", seq: 1, account: "acme-123456", scope: "payg", kind: "charge", units: 10, occurred_at: "2026-09-10T00:00:00.000Z", ref: "" });
    const report = await runPaygCron({ fetcher: async () => ({ ok: false, error: "engine unreachable" }), stripe, now: NOW });
    expect(report.settle).toEqual({ skipped: "engine unreachable" });
    expect(settlements()).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
  });

  it("pages through a long ledger, each page durable before the next", async () => {
    const { ingestLedger } = await ingestLib();
    const events = Array.from({ length: 7 }, () => ledgerEvent());
    const f = ledgerFetcherOver(events);
    const r = await ingestLedger(f, { pageSize: 3 });
    expect(r).toMatchObject({ ok: true, complete: true, inserted: 7, cursor: 7 });
    expect(f.calls).toEqual([0, 3, 6]);
  });
});

describe("what a month is worth", () => {
  async function ingestAll(events: Record<string, unknown>[]) {
    const { ingestLedger } = await ingestLib();
    const r = await ingestLedger(ledgerFetcherOver(events));
    expect(r.complete).toBe(true);
  }

  it("refunds net out: a refunded request is not billed, and a partial refund bills the rest", async () => {
    paygAccount(db);
    await ingestAll([
      ledgerEvent({ units: 5 }),                                     // charge ev1
      ledgerEvent({ units: 5 }),                                     // charge ev2
      ledgerEvent({ kind: "refund", units: 5, ref: "ev000001" }),    // ev1 refunded in full
      ledgerEvent({ units: 4 }),                                     // charge ev4
    ]);
    const { usageNet } = await ingestLib();
    expect(await usageNet("acme-123456", "2026-09")).toEqual({ charged: 14, refunded: 5, net: 9, billable_net: 9 });
    const { settleClosedMonths } = await settleLib();
    await settleClosedMonths(stripe, NOW);
    expect(settlements()).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ month: "2026-09", units: 9, amount_cents: paygChargeCents(9), status: "invoiced" });
    expect(stripe.items[0].amount).toBe(paygChargeCents(9));
  });

  it("a refund that lands after midnight is netted against the month of the CHARGE it reverses", async () => {
    paygAccount(db);
    await ingestAll([
      ledgerEvent({ units: 6, ts: "2026-09-30T23:59:59.999+00:00" }),
      ledgerEvent({ kind: "refund", units: 6, ref: "ev000001", ts: "2026-10-01T00:00:00.001+00:00" }),
      ledgerEvent({ units: 4, ts: "2026-09-12T10:00:00+00:00" }),
    ]);
    const { usageNet } = await ingestLib();
    expect((await usageNet("acme-123456", "2026-09"))!.net).toBe(4);
    expect((await usageNet("acme-123456", "2026-10"))!.net).toBe(0); // October is not negative, and not billed for September's refund
  });

  it("a month below the minimum invoice is CARRIED and rolls into the next; nothing is invoiced for it", async () => {
    paygAccount(db);
    const unitsBelow = Math.floor((PAYG.minInvoiceCents - 1) / PAYG.unitPriceCents); // e.g. 2 units = EUR 4.00 < EUR 5.00
    expect(paygChargeCents(unitsBelow)).toBeLessThan(PAYG.minInvoiceCents);
    await ingestAll([
      ledgerEvent({ units: unitsBelow, ts: "2026-08-10T10:00:00+00:00" }),
      ledgerEvent({ units: unitsBelow, ts: "2026-09-10T10:00:00+00:00" }),
    ]);
    const { settleClosedMonths } = await settleLib();
    const r = await settleClosedMonths(stripe, NOW);
    // August alone is carried; September alone is below the minimum even with August (2+2 units = EUR 8.00)? it is not: 4 units >= 5.00
    const aug = settlements().find((s) => s.month === "2026-08")!;
    const sep = settlements().find((s) => s.month === "2026-09")!;
    expect(aug).toMatchObject({ status: "carried", units: unitsBelow, rolled_into: "2026-09" });
    expect(sep).toMatchObject({ status: "invoiced", units: unitsBelow * 2, carried_units: unitsBelow, carried_months: ["2026-08"] });
    expect(sep.amount_cents).toBe(paygChargeCents(unitsBelow * 2));
    expect(stripe.allInvoices).toHaveLength(1); // ONE invoice, for both months
    expect(r.invoiced).toBe(1);
  });

  it("carries again if the running total is still below the minimum, and a zero month does not lose the carry", async () => {
    paygAccount(db);
    await ingestAll([
      ledgerEvent({ units: 1, ts: "2026-07-10T10:00:00+00:00" }),
      ledgerEvent({ units: 1, ts: "2026-09-10T10:00:00+00:00" }), // August has no usage at all
    ]);
    const { settleClosedMonths } = await settleLib();
    await settleClosedMonths(stripe, NOW);
    expect(settlements().map((s) => [s.month, s.status, s.rolled_into])).toEqual([
      ["2026-07", "carried", null],
      ["2026-09", "carried", null], // 2 units = EUR 4.00 in total: still below the minimum
    ]);
    expect(stripe.calls).toHaveLength(0);
    // a later month pushes the total over, and absorbs BOTH carried months
    await ingestAll([ledgerEvent({ units: 1, ts: "2026-10-01T10:00:00+00:00" }), ledgerEvent({ units: 3, ts: "2026-10-02T10:00:00+00:00" })]);
    await settleClosedMonths(stripe, new Date("2026-11-02T03:00:00Z"));
    const oct = settlements().find((s) => s.month === "2026-10")!;
    expect(oct).toMatchObject({ status: "invoiced", units: 6, carried_units: 2, carried_months: ["2026-07", "2026-09"] });
    expect(settlements().filter((s) => s.rolled_into === "2026-10")).toHaveLength(2);
  });

  it("the current month is never settled", async () => {
    paygAccount(db);
    await ingestAll([ledgerEvent({ units: 30, ts: "2026-10-05T10:00:00+00:00" })]);
    const { settleClosedMonths } = await settleLib();
    await settleClosedMonths(stripe, NOW);
    expect(settlements()).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
  });

  it("trial (free allowance) usage is NEVER invoiced, even for an account that later became pay-as-you-go", async () => {
    // a free account with plenty of trial usage
    paygAccount(db, { account: "free-1", plan: "api_free", token: "tok-free-111111111111111111", stripe_customer_id: null, stripe_payment_method_id: null });
    // and a pay-as-you-go account whose September usage was entirely on the free allowance (scope trial) before it upgraded
    paygAccount(db, { account: "upg-1", token: "tok-upg-1111111111111111111" });
    await ingestAll([
      ledgerEvent({ account: "free-1", scope: "trial", units: 25 }),
      ledgerEvent({ account: "upg-1", scope: "trial", units: 20 }),
      ledgerEvent({ account: "upg-1", scope: "machine", units: 50 }),
    ]);
    const { settleClosedMonths } = await settleLib();
    const r = await settleClosedMonths(stripe, NOW);
    expect(settlements()).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
    expect(r.considered).toBe(0);
  });

  it("only payg-scope units are billed when scopes are mixed in one month", async () => {
    paygAccount(db);
    await ingestAll([ledgerEvent({ scope: "trial", units: 20 }), ledgerEvent({ scope: "payg", units: 7 })]);
    const { settleClosedMonths } = await settleLib();
    await settleClosedMonths(stripe, NOW);
    expect(settlements()[0]).toMatchObject({ units: 7, amount_cents: paygChargeCents(7) });
  });
});

describe("a month is settled once", () => {
  it("running the cron twice (and a third time a day later, after Stripe forgot its idempotency keys) creates one settlement, one invoice, one item", async () => {
    const { runPaygCron } = await cronLib();
    paygAccount(db);
    const fetcher = ledgerFetcherOver([ledgerEvent({ units: 10 }), ledgerEvent({ units: 5 })]);
    const first = await runPaygCron({ fetcher, stripe, now: NOW });
    expect(first.settle).toMatchObject({ invoiced: 1 });
    const second = await runPaygCron({ fetcher, stripe, now: NOW });
    expect(second.settle).toMatchObject({ invoiced: 0, considered: 0 });
    stripe.forgetIdempotency();
    await runPaygCron({ fetcher, stripe, now: new Date("2026-10-22T03:23:00Z") });
    expect(settlements()).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ month: "2026-09", units: 15, amount_cents: paygChargeCents(15), status: "invoiced", stripe_invoice_id: stripe.allInvoices[0].id });
    expect(stripe.allInvoices).toHaveLength(1);
    expect(stripe.items).toHaveLength(1);
    // the invoice is what the customer agreed to: collected automatically on the saved card, finalised only after its item
    const inv = stripe.allInvoices[0];
    expect(inv.params).toMatchObject({ collection_method: "charge_automatically", default_payment_method: "pm_acme", currency: "eur", customer: "cus_acme" });
    expect(inv.params.metadata).toMatchObject({ kind: "payg_settlement", account: "acme-123456", month: "2026-09", settlement_key: "payg:acme-123456:2026-09" });
    expect(inv.status).toBe("open");
  });

  it("two cron runs at the same moment settle one month once (the unique row is the arbiter)", async () => {
    const { runPaygCron } = await cronLib();
    paygAccount(db);
    const fetcher = ledgerFetcherOver([ledgerEvent({ units: 10 })]);
    await Promise.all([runPaygCron({ fetcher, stripe, now: NOW }), runPaygCron({ fetcher, stripe, now: NOW })]);
    expect(settlements()).toHaveLength(1);
    expect(stripe.allInvoices).toHaveLength(1);
    expect(stripe.items).toHaveLength(1);
  });

  it("a failed Stripe call leaves a PENDING row; the retry creates exactly one invoice", async () => {
    const { runPaygCron } = await cronLib();
    paygAccount(db);
    const fetcher = ledgerFetcherOver([ledgerEvent({ units: 10 })]);
    stripe.failOnce.add("invoiceItems.create");
    const first = await runPaygCron({ fetcher, stripe, now: NOW });
    expect(first.settle).toMatchObject({ invoiced: 0, stillPending: 1 });
    expect(settlements()[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(settlements()[0].last_error).toBe("StripeConnectionError:503"); // a category, never the provider's message
    expect(JSON.stringify(settlements())).not.toContain("customer@example.test");
    expect(stripe.items).toHaveLength(0);

    const retry = await runPaygCron({ fetcher, stripe, now: new Date("2026-10-22T03:23:00Z") });
    expect(retry.settle).toMatchObject({ invoiced: 1, stillPending: 0 });
    expect(settlements()).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ status: "invoiced", last_error: null });
    expect(stripe.allInvoices).toHaveLength(1);
    expect(stripe.items).toHaveLength(1);
    expect(stripe.items[0].invoice).toBe(stripe.allInvoices[0].id);
  });

  it("a failure at every step still ends in exactly one invoice and one item, even across Stripe's 24 h idempotency window", async () => {
    for (const step of ["invoices.create", "invoiceItems.list", "invoiceItems.create", "invoices.retrieve", "invoices.finalizeInvoice"]) {
      db = newPaygDb();
      restore();
      restore = db.install();
      stripe = new MockStripe();
      resetSeq();
      const { runPaygCron } = await cronLib();
      paygAccount(db);
      const fetcher = ledgerFetcherOver([ledgerEvent({ units: 10 })]);
      stripe.failOnce.add(step);
      await runPaygCron({ fetcher, stripe, now: NOW });
      stripe.forgetIdempotency(); // the next run is a day later
      await runPaygCron({ fetcher, stripe, now: new Date("2026-10-22T03:23:00Z") });
      expect(stripe.allInvoices, step).toHaveLength(1);
      expect(stripe.items, step).toHaveLength(1);
      expect(stripe.allInvoices[0].status, step).toBe("open");
      expect(settlements()[0].status, step).toBe("invoiced");
    }
  });

  it("an invoice created on Stripe whose id we failed to record is FOUND by its metadata next time, not duplicated", async () => {
    const { settleClosedMonths } = await settleLib();
    const { ingestLedger } = await ingestLib();
    paygAccount(db);
    await ingestLedger(ledgerFetcherOver([ledgerEvent({ units: 10 })]));
    // Make the id write fail: the PATCH of stripe_invoice_id is the first PATCH invoiceOne issues after creating the invoice
    const realFetch = globalThis.fetch;
    let blocked = true;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (blocked && String(i).includes("/usage_settlements") && init?.method === "PATCH" && String(init.body).includes("stripe_invoice_id")) return new Response("{}", { status: 500 });
      return realFetch(i as RequestInfo, init);
    }) as typeof fetch;
    const first = await settleClosedMonths(stripe, NOW);
    expect(first.stillPending).toBe(1);
    expect(stripe.allInvoices).toHaveLength(1);
    expect(settlements()[0].stripe_invoice_id).toBeNull();
    blocked = false;
    stripe.forgetIdempotency(); // a day later
    await settleClosedMonths(stripe, new Date("2026-10-22T03:23:00Z"));
    globalThis.fetch = realFetch;
    expect(stripe.allInvoices).toHaveLength(1);
    expect(stripe.items).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ status: "invoiced", stripe_invoice_id: stripe.allInvoices[0].id });
  });

  it("an account with no saved payment method is left pending and reported; nothing is created on Stripe", async () => {
    const { runPaygCron } = await cronLib();
    paygAccount(db, { stripe_payment_method_id: null });
    const r = await runPaygCron({ fetcher: ledgerFetcherOver([ledgerEvent({ units: 10 })]), stripe, now: NOW });
    expect(r.settle).toMatchObject({ noPaymentMethod: 1, invoiced: 0 });
    expect(settlements()[0]).toMatchObject({ status: "pending", last_error: "no_payment_method" });
    expect(stripe.allInvoices).toHaveLength(0);
  });

  it("is order-safe with the webhook: a row already marked paid is not moved back to invoiced by a late settlement run", async () => {
    const { settleClosedMonths } = await settleLib();
    paygAccount(db);
    const { ingestLedger } = await ingestLib();
    await ingestLedger(ledgerFetcherOver([ledgerEvent({ units: 10 })]));
    stripe.failOnce.add("invoices.retrieve"); // crash after the item exists, before the row says invoiced
    await settleClosedMonths(stripe, NOW);
    settlements()[0].status = "paid"; // the webhook got there first
    await settleClosedMonths(stripe, NOW);
    expect(settlements()).toHaveLength(1);
  });
});

describe("the engine ledger fetcher (production path) and the cron route", () => {
  function engineAnswering(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    process.env.GRIDFORGE_API_URL = "https://engine.test/";
    process.env.GRIDFORGE_ADMIN_KEY = "admin-test-key";
    const inner = globalThis.fetch;
    const seen: { url: string; key: string | null }[] = [];
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = String(i);
      if (url.startsWith("https://engine.test/v1/admin/ledger")) {
        seen.push({ url, key: (init?.headers as Record<string, string>)?.["X-API-Key"] ?? null });
        return answer(url, init);
      }
      return inner(i as RequestInfo, init);
    }) as typeof fetch;
    return { seen, restore: () => { globalThis.fetch = inner; } };
  }

  it("asks the operator-only endpoint with the operator key, after the cursor, and reads the documented shape", async () => {
    const { engineLedgerFetcher } = await ingestLib();
    const e = engineAnswering(() => new Response(JSON.stringify({ events: [ledgerEvent()], last_seq: 1, head_seq: 1, durable: true, status: {} }), { status: 200 }));
    const f = engineLedgerFetcher()!;
    const page = await f(41, 500);
    e.restore();
    expect(page).toMatchObject({ ok: true, last_seq: 1, head_seq: 1, durable: true });
    expect(e.seen).toEqual([{ url: "https://engine.test/v1/admin/ledger?after_seq=41&limit=500", key: "admin-test-key" }]);
  });

  it("is absent without engine configuration, and an unhappy engine is an error rather than an empty ledger", async () => {
    const { engineLedgerFetcher } = await ingestLib();
    expect(engineLedgerFetcher({} as NodeJS.ProcessEnv)).toBeNull();
    expect(engineLedgerFetcher({ GRIDFORGE_API_URL: "https://x" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    for (const answer of [() => new Response("{}", { status: 404 }), () => new Response("not json", { status: 200 }), () => new Response(JSON.stringify({ events: "no" }), { status: 200 }), () => { throw new Error("down"); }]) {
      const e = engineAnswering(answer as never);
      const r = await engineLedgerFetcher()!(0, 10);
      e.restore();
      expect(r.ok).toBe(false);
    }
  });

  it("GET /api/cron/payg end to end: ingests the engine ledger, then settles; a second call changes nothing", async () => {
    process.env.CRON_SECRET = "cron-secret";
    paygAccount(db);
    setPaygStripeForTests(stripe);
    const events = [ledgerEvent({ units: 10 }), ledgerEvent({ units: 5 })];
    const e = engineAnswering((url) => {
      const after = Number(new URL(url).searchParams.get("after_seq"));
      const page = events.filter((x) => (x.seq as number) > after);
      return new Response(JSON.stringify({ events: page, last_seq: page.length ? page[page.length - 1].seq : after, head_seq: 2, durable: true }), { status: 200 });
    });
    const { GET } = await import("@/app/api/cron/payg/route");
    const call = () => GET(new Request("https://gridforge.test/api/cron/payg", { headers: { authorization: "Bearer cron-secret" } }));
    const first = await call();
    const second = await call();
    e.restore();
    setPaygStripeForTests(null);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.ingest).toMatchObject({ ok: true, complete: true, inserted: 2, cursor: 2 });
    expect(body.settle).toMatchObject({ invoiced: 1 });
    expect((await second.json()).settle).toMatchObject({ invoiced: 0, considered: 0 });
    expect(settlements()).toHaveLength(1);
    expect(db.rows("usage_events")).toHaveLength(2);
  });
});
