/**
 * Every Stripe call on the pay-as-you-go settlement, invoicing and setup paths is bounded (lib/stripe-timeout.ts), and a TIMEOUT IS "CANNOT
 * SAY", never an outcome: the call may have succeeded at Stripe. Each test here makes ONE call hang (STRIPE_CALL_TIMEOUT_MS is 40 ms, the
 * fake never answers) and asserts what is on record afterwards and that a later run finishes the job exactly once.
 *
 * Labels. STRIPE is a MOCK (MockStripe, payg-harness.ts): `hang.set(name, "before")` = the request never reaches Stripe; `"after"` = it reaches
 * Stripe and TAKES EFFECT but the answer never comes back (a timed-out create that actually succeeded). The store is the in-memory PostgREST
 * with TypeScript mirrors of the SQL functions (SUPPLEMENTAL). No live Stripe call is made; nothing here proves how live Stripe behaves.
 * The timers are real (40 ms); only Date is not faked, so the daily "now" is passed in as the cron does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { accountRef } from "@/lib/payg";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { boundStripe, isStripeTimeout, withStripeTimeout } from "@/lib/stripe-timeout";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MockStripe, ledgerEvent, ledgerFetcherOver, mockEngine, newPaygDb, paygAccount, resetSeq, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let stripe: MockStripe;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
const NOW = new Date("2026-10-21T03:23:00Z"); // September and earlier are closed
const NEXT_DAY = new Date("2026-10-22T03:23:00Z");

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder",
    GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "T <p@timetopower.ai>",
    STRIPE_CALL_TIMEOUT_MS: "40",
  });
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
afterEach(() => {
  delete process.env.STRIPE_CALL_TIMEOUT_MS;
  delete process.env.PAYG_SETTLE_BUDGET_MS;
  setPaygStripeForTests(null);
  engine.restore();
  restore();
  vi.restoreAllMocks();
});

const settleLib = () => import("@/lib/payg-settle");
const cronLib = () => import("@/lib/payg-cron");
const settlements = () => db.rows("usage_settlements") as any[];
const ledger = () => JSON.stringify(db.rows("usage_events"));
const opMail = () => mail.filter((m) => m.to === "ops@example.test");

async function ingest(events: Record<string, unknown>[]) {
  const { ingestLedger } = await import("@/lib/payg-usage");
  const r = await ingestLedger(ledgerFetcherOver(events));
  expect(r.complete).toBe(true);
}
/** One pay-as-you-go account with one closed month of usage. */
async function seed(i = 0) {
  const account = i === 0 ? "acme-123456" : `acct-${i}`;
  paygAccount(db, i === 0 ? {} : { account, token: `tok-${i}-0123456789abcdefghijklmn`, stripe_customer_id: `cus_${i}`, stripe_payment_method_id: `pm_${i}`, email: `o${i}@x.example` });
  await ingest([ledgerEvent({ account, units: 10 })]);
  return account;
}
const settle = async (now = NOW) => (await settleLib()).settleClosedMonths(stripe, now);
const KEY = "payg:acme-123456:2026-09";

// ================================================================================================================== the bound itself

describe("the bound", () => {
  it("withStripeTimeout rejects a call that never answers with a StripeConnectionError carrying the timeout code, after the bound", async () => {
    const t0 = performance.now();
    const err = await withStripeTimeout(new Promise<never>(() => {}), 30).catch((e) => e);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(err).toMatchObject({ type: "StripeConnectionError", code: "stripe_call_timeout" });
    expect(isStripeTimeout(err)).toBe(true);
    expect(isStripeTimeout(Object.assign(new Error("x"), { type: "StripeConnectionError", statusCode: 503 }))).toBe(false); // Stripe answered with a failure
  });

  it("boundStripe bounds EVERY method of EVERY namespace, passes values through, and is idempotent", async () => {
    const fake = new MockStripe();
    const b = boundStripe(fake);
    expect(boundStripe(b)).toBe(b);
    const paths: [string, () => Promise<unknown>][] = [
      ["checkout.sessions.create", () => b.checkout.sessions.create({} as any)],
      ["setupIntents.retrieve", () => b.setupIntents.retrieve("si")],
      ["customers.retrieve", () => b.customers.retrieve("cus")],
      ["customers.update", () => b.customers.update("cus", {})],
      ["billingPortal.sessions.create", () => b.billingPortal.sessions.create({ customer: "c", return_url: "u" })],
      ["charges.retrieve", () => b.charges.retrieve("ch")],
      ["invoices.create", () => b.invoices.create({} as any)],
      ["invoices.finalizeInvoice", () => b.invoices.finalizeInvoice("in")],
      ["invoices.retrieve", () => b.invoices.retrieve("in")],
      ["invoices.list", () => b.invoices.list({} as any)],
      ["invoices.update", () => b.invoices.update("in", {})],
      ["invoices.pay", () => b.invoices.pay("in")],
      ["invoiceItems.create", () => b.invoiceItems.create({} as any)],
      ["invoiceItems.list", () => b.invoiceItems.list({} as any)],
    ];
    for (const [name, call] of paths) {
      fake.hang.set(name, "before");
      const err = await call().catch((e) => e);
      expect(isStripeTimeout(err), name).toBe(true);
    }
    expect(fake.calls).toEqual([]); // "before": none of them reached Stripe
    expect(await b.setupIntents.retrieve("si").catch((e) => (e as { code?: string }).code)).toBe("resource_missing"); // an answer is passed on as it is
  });

  it("paygStripe() hands out a bounded client even when a fake is injected", async () => {
    const { paygStripe } = await import("@/lib/payg-stripe");
    stripe.hang.set("invoices.retrieve", "before");
    const err = await paygStripe()!.invoices.retrieve("in_x").catch((e) => e);
    expect(isStripeTimeout(err)).toBe(true);
  });
});

// ============================================================================================================ settlement, call by call

type Case = { name: string; mode: "before" | "after"; prepare?: () => Promise<void> };
const draftWithoutItem = async () => {
  // an earlier run got as far as the draft invoice and failed on the item: the next run resumes at the item / finalise stage
  stripe.failOnce.add("invoiceItems.create");
  await settle();
  expect(settlements()[0].stripe_invoice_id).toBeTruthy();
};
const CASES: Case[] = [
  { name: "customers.retrieve", mode: "before" },
  { name: "invoices.list", mode: "before" },
  { name: "invoices.create", mode: "before" },
  { name: "invoices.create", mode: "after" },
  { name: "invoiceItems.list", mode: "before" },
  { name: "invoiceItems.create", mode: "before" },
  { name: "invoiceItems.create", mode: "after" },
  { name: "invoices.retrieve", mode: "before" },
  { name: "invoices.update", mode: "before", prepare: draftWithoutItem },
  { name: "invoices.finalizeInvoice", mode: "before" },
  { name: "invoices.finalizeInvoice", mode: "after" },
];

describe("a timed-out call on the settlement path leaves the month pending, touches nothing else, and the next run finishes it exactly once", () => {
  for (const c of CASES) {
    it(`${c.name} (${c.mode === "after" ? "reached Stripe and took effect, the answer was lost" : "never reached Stripe"})`, async () => {
      const account = await seed();
      await c.prepare?.();
      const ledgerBefore = ledger();
      const rowsBefore = settlements().length;
      stripe.hang.set(c.name, c.mode);

      // ---- the run in which the call hangs
      const t0 = performance.now();
      const r1 = await settle();
      expect(performance.now() - t0).toBeLessThan(3_000); // bounded, not hung
      expect(r1).toMatchObject({ timedOut: 1, invoiced: 0, stillPending: 1 });
      const s = settlements();
      expect(s).toHaveLength(Math.max(1, rowsBefore));
      expect(s[0].status).toBe("pending"); // never invoiced, paid, collected or failed on a guess
      expect(s[0].last_error).toBe("StripeConnectionError:stripe_call_timeout");
      expect(ledger()).toBe(ledgerBefore); // the append-only ledger is untouched
      if (c.mode === "after") expect(stripe.hungAfter).toContain(c.name); // the dangerous case really happened
      // operator-visible: the cron JSON counts it, ONE mail names the account reference, the month and the step, and carries no secret
      const mails = opMail().filter((m) => /did not answer/.test(m.subject));
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toContain("2026-09");
      expect(mails[0].subject).toContain(accountRef(account));
      expect(mails[0].text).toContain(c.name);
      expect(mails[0].text).toContain(accountRef(account));
      expect(mails[0].text).not.toMatch(/cus_acme|pm_acme|ops@acme\.example|sk_test|re_test|test-signing-secret/);
      // ---- the next daily run: Stripe has forgotten its idempotency keys, so only the re-read by metadata can prevent a duplicate
      stripe.forgetIdempotency();
      const r2 = await settle(NEXT_DAY);
      expect(r2).toMatchObject({ timedOut: 0, invoiced: 1, stillPending: 0 });
      expect(stripe.allInvoices).toHaveLength(1); // one invoice, however the first attempt went
      expect(stripe.items).toHaveLength(1); // one item
      const inv = stripe.allInvoices[0];
      expect(inv.status).toBe("open");
      expect(inv.metadata).toMatchObject({ kind: "payg_settlement", month: "2026-09", settlement_key: KEY });
      expect(settlements()).toHaveLength(Math.max(1, rowsBefore));
      expect(settlements()[0]).toMatchObject({ status: "invoiced", stripe_invoice_id: inv.id, stripe_invoice_item_id: stripe.items[0].id, last_error: null });
      expect(stripe.items[0]).toMatchObject({ invoice: inv.id, amount: settlements()[0].amount_cents });
      expect(ledger()).toBe(ledgerBefore);
      // every create / finalise carried the idempotency key for THIS month (and nothing was sent without one)
      expect(stripe.idemKeys.length).toBeGreaterThan(0);
      for (const k of stripe.idemKeys) expect(k.startsWith(KEY)).toBe(true);

      // ---- and nothing is done twice after that
      const r3 = await settle(new Date("2026-10-23T03:23:00Z"));
      expect(r3).toMatchObject({ invoiced: 0, considered: 0, timedOut: 0 });
      expect(stripe.allInvoices).toHaveLength(1);
      expect(stripe.items).toHaveLength(1);
    });
  }

  it("a create that reached Stripe but timed out is found again by the SAME-DAY run through the idempotency key even if the invoice list does not show it yet", async () => {
    await seed();
    stripe.hang.set("invoices.create", "after");
    expect((await settle()).timedOut).toBe(1);
    expect(stripe.allInvoices).toHaveLength(1);
    (stripe.invoices as any).list = async () => ({ data: [] }); // a list that has not caught up
    const r = await settle();
    expect(r).toMatchObject({ invoiced: 1, timedOut: 0 });
    expect(stripe.allInvoices).toHaveLength(1); // the key returned the invoice that already existed, not a second one
    expect(stripe.idemKeys.filter((k) => k === KEY).length).toBe(2);
  });

  it("a finalise that took effect, then the invoice.paid event, then the next run: the row is paid once and the run leaves it alone", async () => {
    const account = await seed();
    stripe.hang.set("invoices.finalizeInvoice", "after");
    await settle();
    expect(settlements()[0].status).toBe("pending"); // a timeout never marks it invoiced, let alone paid
    const invoiceId = stripe.allInvoices[0].id;
    const { handlePaygInvoice } = await import("@/lib/payg-billing");
    const out = await handlePaygInvoice({
      id: "evt_paid_1", type: "invoice.paid",
      data: { object: { id: invoiceId, amount_paid: settlements()[0].amount_cents, hosted_invoice_url: "https://invoice.stripe.test/x", metadata: { kind: "payg_settlement", account, month: "2026-09" } } },
    } as unknown as Stripe.Event);
    expect(out).toEqual({ ok: true });
    expect(settlements()[0]).toMatchObject({ status: "paid", stripe_invoice_id: invoiceId });
    const r = await settle(NEXT_DAY);
    expect(r).toMatchObject({ invoiced: 0, considered: 0 });
    expect(settlements()[0].status).toBe("paid");
    expect(stripe.allInvoices).toHaveLength(1);
  });

  it("the replaced-card record moves only AFTER the invoice has been pointed at the card: a timed-out update leaves the difference for the next run", async () => {
    await seed();
    stripe.customerDefaults.set("cus_acme", "pm_new"); // the card was replaced in the Billing Portal
    stripe.failOnce.add("invoiceItems.create");
    await settle(); // a draft exists, created with the old card
    stripe.hang.set("invoices.update", "before");
    expect((await settle()).timedOut).toBe(1);
    expect((db.rows("api_accounts") as any[])[0].stripe_payment_method_id).toBe("pm_acme"); // not advanced
    expect((await settle(NEXT_DAY)).invoiced).toBe(1);
    expect((db.rows("api_accounts") as any[])[0].stripe_payment_method_id).toBe("pm_new");
    expect(stripe.allInvoices[0].params.default_payment_method).toBe("pm_new");
  });

  it("a different, non-timeout failure still reads as before (a category, the settlement-failed mail), not as a timeout", async () => {
    await seed();
    stripe.failOnce.add("invoices.create");
    const r = await settle();
    expect(r).toMatchObject({ timedOut: 0, stillPending: 1 });
    expect(settlements()[0].last_error).toBe("StripeConnectionError:503");
    expect(opMail().some((m) => /NOT invoiced/.test(m.subject))).toBe(true);
    expect(opMail().some((m) => /did not answer/.test(m.subject))).toBe(false);
  });

  it("the mail is once per settlement per DAY: the next day's timeout is mailed again", async () => {
    await seed();
    stripe.hangWhen = (n) => (n === "invoices.create" ? "before" : null);
    await settle();
    await settle();
    expect(opMail().filter((m) => /did not answer/.test(m.subject))).toHaveLength(1);
    await settle(NEXT_DAY);
    expect(opMail().filter((m) => /did not answer/.test(m.subject))).toHaveLength(2);
    expect(settlements()[0].attempts).toBe(3);
  });
});

// ======================================================================================================== one stuck account, many accounts

describe("the cron makes progress across accounts: a stuck account does not starve the others, and the whole pass is bounded", () => {
  const cust = (args: unknown[]) => (typeof args[0] === "string" ? args[0] : (args[0] as { customer?: string } | undefined)?.customer);

  it("one account whose invoice create never answers: its later months wait, every other account is invoiced in the same run", async () => {
    // account "stuck" has THREE closed months; four healthy accounts have one each
    paygAccount(db, { account: "stuck-1", token: "tok-stuck-0123456789abcdefghijklm", stripe_customer_id: "cus_stuck", stripe_payment_method_id: "pm_stuck" });
    await ingest([
      ledgerEvent({ account: "stuck-1", units: 10, ts: "2026-07-10T10:00:00+00:00" }),
      ledgerEvent({ account: "stuck-1", units: 10, ts: "2026-08-10T10:00:00+00:00" }),
      ledgerEvent({ account: "stuck-1", units: 10, ts: "2026-09-10T10:00:00+00:00" }),
    ]);
    for (const i of [1, 2, 3, 4]) await seed(i);
    stripe.hangWhen = (n, a) => (n === "invoices.create" && cust(a) === "cus_stuck" ? "before" : null);
    const t0 = performance.now();
    const r = await settle();
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(r).toMatchObject({ invoiced: 4, timedOut: 1, deferred: 2 }); // the stuck account's other two months were not even tried
    expect(settlements().filter((s) => s.account.startsWith("acct-")).every((s) => s.status === "invoiced")).toBe(true);
    expect(settlements().filter((s) => s.account === "stuck-1").every((s) => s.status === "pending")).toBe(true);
    expect(stripe.calls.filter((c) => c === "invoices.create")).toHaveLength(4); // the stuck create never reached Stripe; the four healthy accounts were not held up
    expect(opMail().some((m) => /not attempted today/.test(m.subject))).toBe(true);

    // the next day Stripe answers: the stuck account's months are invoiced, one invoice per month, nothing duplicated
    stripe.hangWhen = null;
    stripe.forgetIdempotency();
    const r2 = await settle(NEXT_DAY);
    expect(r2).toMatchObject({ invoiced: 3, timedOut: 0, deferred: 0 });
    expect(stripe.allInvoices).toHaveLength(7);
    expect(new Set(stripe.allInvoices.map((i) => i.metadata?.settlement_key)).size).toBe(7);
    expect(settlements().every((s) => s.status === "invoiced")).toBe(true);
  });

  it("Stripe not answering at all: the pass stops after three timeouts in a row instead of waiting out every row, and the rest are taken by the next run (stuck rows go to the back)", async () => {
    for (const i of [1, 2, 3, 4, 5, 6]) await seed(i);
    stripe.hangWhen = (n, a) => (n === "customers.retrieve" && ["cus_1", "cus_2", "cus_3", "cus_4"].includes(String(cust(a))) ? "before" : null);
    const t0 = performance.now();
    const r = await settle();
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(r).toMatchObject({ timedOut: 3, invoiced: 0, deferred: 3 });
    // next run: the three that timed out have a failure on record and go behind the ones that have not; 4 is still stuck, 5 and 6 are fine
    const r2 = await settle(NEXT_DAY);
    expect(r2.invoiced).toBe(2);
    expect(settlements().filter((s) => s.status === "invoiced").map((s) => s.account).sort()).toEqual(["acct-5", "acct-6"]);
    stripe.hangWhen = null;
    const r3 = await settle(new Date("2026-10-23T03:23:00Z"));
    expect(r3.invoiced).toBe(4);
    expect(stripe.allInvoices).toHaveLength(6);
  });

  it("the run has a time budget, checked between the Stripe steps of a row too: a row stops at a step boundary untouched, the rest are deferred, the next run does them exactly once", async () => {
    for (const i of [1, 2, 3, 4]) await seed(i);
    let t = 0; // an injected clock: only the calls below move it, no real sleeping
    const retrieve = stripe.customers.retrieve;
    const create = stripe.invoices.create;
    stripe.customers.retrieve = async (id: string) => { t += 40; return retrieve(id); };
    stripe.invoices.create = async (p: any, o?: any) => { t += 40; return create(p, o); };
    const r = await (await settleLib()).settleClosedMonths(stripe, NOW, { clock: () => t, budgetMs: 100 });
    // row 1 completes (t = 80); row 2 reads the customer (t = 120) and stops at its next step boundary; rows 3 and 4 are not started
    expect(r).toMatchObject({ invoiced: 1, deferred: 3, timedOut: 0, stillPending: 3 });
    const second = settlements().find((x) => x.account === "acct-2")!;
    expect(second).toMatchObject({ status: "pending", stripe_invoice_id: null, last_error: null, attempts: 0 }); // nothing written for it
    expect(stripe.allInvoices).toHaveLength(1);
    stripe.customers.retrieve = retrieve;
    stripe.invoices.create = create;
    const r2 = await settle(NEXT_DAY);
    expect(r2).toMatchObject({ invoiced: 3, deferred: 0 });
    expect(stripe.allInvoices).toHaveLength(4);
    expect(new Set(stripe.allInvoices.map((i) => i.metadata?.settlement_key)).size).toBe(4);
    expect(settlements().every((x) => x.status === "invoiced")).toBe(true);
  });

  it("the breaker counts only rows that asked Stripe: rows that never reached it (no payment method) do not reset it", async () => {
    // one account per month, so the order is fixed: stuck, no card, stuck, no card, stuck, healthy
    const specs: [string, string, "stuck" | "nocard" | "ok"][] = [
      ["a1", "2026-01", "stuck"], ["a2", "2026-02", "nocard"], ["a3", "2026-03", "stuck"], ["a4", "2026-04", "nocard"], ["a5", "2026-05", "stuck"], ["a6", "2026-06", "ok"],
    ];
    for (const [account, month, kind] of specs) {
      paygAccount(db, { account, token: `tok-${account}-0123456789abcdefghijklmn`, stripe_customer_id: kind === "nocard" ? null : `cus_${kind}_${account}`, stripe_payment_method_id: kind === "nocard" ? null : `pm_${account}`, email: `${account}@x.example` });
      await ingest([ledgerEvent({ account, units: 10, ts: `${month}-10T10:00:00+00:00` })]);
    }
    stripe.hangWhen = (n, a) => (n === "customers.retrieve" && String(a[0]).startsWith("cus_stuck_") ? "before" : null);
    const r = await settle();
    expect(r).toMatchObject({ timedOut: 3, noPaymentMethod: 2, invoiced: 0, deferred: 1 }); // the healthy account waits: Stripe was not answering
    expect(settlements().find((x) => x.account === "a6")).toMatchObject({ status: "pending", last_error: null });
  });

  it("runPaygCron with a Stripe that answers nothing: it returns within the bound with the count in its JSON, and nothing was written but last_error", async () => {
    const { runPaygCron } = await cronLib();
    const events: Record<string, unknown>[] = [];
    for (const i of [1, 2, 3, 4, 5]) {
      paygAccount(db, { account: `acct-${i}`, token: `tok-${i}-0123456789abcdefghijklmn`, stripe_customer_id: `cus_${i}`, stripe_payment_method_id: `pm_${i}`, email: `o${i}@x.example` });
      events.push(ledgerEvent({ account: `acct-${i}`, units: 10 }));
    }
    const fetcher = ledgerFetcherOver(events);
    stripe.hangWhen = () => "before";
    const t0 = performance.now();
    const report = await runPaygCron({ fetcher, stripe: (await import("@/lib/payg-stripe")).paygStripe(), now: NOW });
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(report.settle).toMatchObject({ timedOut: 3, deferred: 2, invoiced: 0, stillPending: 5 });
    expect(settlements()).toHaveLength(5);
    expect(settlements().every((s) => s.status === "pending")).toBe(true);
    expect(stripe.calls).toEqual([]);
    stripe.hangWhen = null;
    const next = await runPaygCron({ fetcher, stripe, now: NEXT_DAY });
    expect(next.settle).toMatchObject({ invoiced: 5, timedOut: 0 });
    expect(stripe.allInvoices).toHaveLength(5);
  });
});

// ====================================================================================================== the webhook-side Stripe calls

describe("PAYG setup and card-replacement webhooks: a timeout asks for a redelivery and records nothing; the redelivery completes once", () => {
  const meta = { kind: "api_payg_enable", account_id: "free-1", cap_eur: "50" };
  const enableSession = () => ({ id: "cs_en_1", mode: "setup", customer: "cus_free", setup_intent: "seti_en", metadata: meta }) as unknown as Stripe.Checkout.Session;
  const freeAcct = () => (db.rows("api_accounts") as any[])[0];
  const prepEnable = () => {
    paygAccount(db, { account: "free-1", token: "tok-free-0123456789abcdefghijkl", plan: "api_free", stripe_customer_id: null, stripe_payment_method_id: null, cap_units: null, monthly_units: 25 });
    stripe.setupIntentStore.set("seti_en", { id: "seti_en", status: "succeeded", payment_method: "pm_en", customer: "cus_free", metadata: meta });
  };

  for (const [name, mode] of [["setupIntents.retrieve", "before"], ["customers.update", "before"], ["customers.update", "after"]] as const) {
    it(`enable: ${name} (${mode})`, async () => {
      prepEnable();
      const { handlePaygEnable } = await import("@/lib/payg-billing");
      stripe.hang.set(name, mode);
      const t0 = performance.now();
      const out = await handlePaygEnable(enableSession(), stripe);
      expect(performance.now() - t0).toBeLessThan(3_000);
      expect(out).toEqual({ ok: false, why: "stripe timeout" });
      expect(freeAcct()).toMatchObject({ plan: "api_free", stripe_customer_id: null, stripe_payment_method_id: null });
      expect(db.rows("funnel_events").filter((e: any) => e.name === "payg_enabled")).toHaveLength(0);
      // the redelivery
      expect(await handlePaygEnable(enableSession(), stripe)).toEqual({ ok: true });
      expect(freeAcct()).toMatchObject({ plan: "api_payg", stripe_customer_id: "cus_free", stripe_payment_method_id: "pm_en", cap_units: expect.any(Number) });
      expect(db.rows("funnel_events").filter((e: any) => e.name === "payg_enabled")).toHaveLength(1);
      expect(stripe.customerDefaults.get("cus_free")).toBe("pm_en");
    });
  }

  const cardMeta = { kind: "api_payg_card_update", account_id: "acme-123456" };
  const cardSession = () => ({ id: "cs_card_1", mode: "setup", customer: "cus_acme", setup_intent: "seti_card", metadata: cardMeta }) as unknown as Stripe.Checkout.Session;
  const prepCard = async (withFailed = false) => {
    paygAccount(db, { status: withFailed ? "past_due" : "active" });
    stripe.setupIntentStore.set("seti_card", { id: "seti_card", status: "succeeded", payment_method: "pm_new", customer: "cus_acme", metadata: cardMeta });
    if (!withFailed) return null;
    const inv = await stripe.invoices.create({ customer: "cus_acme", metadata: { kind: "payg_settlement", account: "acme-123456", month: "2026-09" }, default_payment_method: "pm_acme" } as any);
    await stripe.invoices.finalizeInvoice(inv.id, { auto_advance: true });
    db.insertRow("usage_settlements", { account: "acme-123456", month: "2026-09", units: 10, amount_cents: 2000, status: "failed", stripe_invoice_id: inv.id });
    return inv.id;
  };

  for (const [name, mode] of [["setupIntents.retrieve", "before"], ["customers.update", "after"]] as const) {
    it(`card replacement: ${name} (${mode}) asks for a redelivery; the card on the account is unchanged until it completes`, async () => {
      await prepCard();
      const { handlePaygCardUpdate } = await import("@/lib/payg-billing");
      stripe.hang.set(name, mode);
      expect(await handlePaygCardUpdate(cardSession(), stripe)).toEqual({ ok: false, why: "stripe timeout" });
      expect((db.rows("api_accounts") as any[])[0].stripe_payment_method_id).toBe("pm_acme");
      expect(await handlePaygCardUpdate(cardSession(), stripe)).toEqual({ ok: true });
      expect((db.rows("api_accounts") as any[])[0].stripe_payment_method_id).toBe("pm_new");
    });
  }

  for (const [name, mode] of [["invoices.update", "before"], ["invoices.pay", "before"], ["invoices.pay", "after"]] as const) {
    it(`card replacement retrying a failed invoice: ${name} (${mode}): redelivery requested, the card is saved; the retry pays the invoice once`, async () => {
      const invoiceId = (await prepCard(true))!;
      const { handlePaygCardUpdate } = await import("@/lib/payg-billing");
      stripe.hang.set(name, mode);
      expect(await handlePaygCardUpdate(cardSession(), stripe)).toEqual({ ok: false, why: "stripe timeout" });
      expect((db.rows("api_accounts") as any[])[0].stripe_payment_method_id).toBe("pm_new"); // the card write is absolute and already done
      expect(settlements()[0].status).toBe("failed"); // a timeout is not a payment, nor a second failure
      expect(await handlePaygCardUpdate(cardSession(), stripe)).toEqual({ ok: true }); // an invoice that was paid after all is "already paid": ignored
      expect(stripe.invoicesById.get(invoiceId)!.status).toBe("paid");
      expect(stripe.allInvoices).toHaveLength(1);
    });
  }
});

// ================================================================================================================= customer-facing routes

describe("routes that call Stripe for a customer who is waiting: no answer in the bound is a 502 that changes nothing", () => {
  let ipn = 0;
  const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.9.0.${(++ipn % 250) + 1}` }, body: JSON.stringify(body) });

  it("POST /api/payg/enable: checkout.sessions.create hangs", async () => {
    const a = paygAccount(db, { plan: "api_free", stripe_customer_id: null, stripe_payment_method_id: null, cap_units: null });
    stripe.hang.set("checkout.sessions.create", "before");
    const { POST } = await import("@/app/api/payg/enable/route");
    const t0 = performance.now();
    const res = await POST(post("/api/payg/enable", { token: a.token, cap_eur: 50 }));
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Nothing was changed/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(a).toMatchObject({ plan: "api_free", stripe_customer_id: null });
  });

  it("POST /api/payg/card: checkout.sessions.create hangs", async () => {
    const a = paygAccount(db);
    stripe.hang.set("checkout.sessions.create", "after"); // the session may exist at Stripe (unpaid, setup mode, expires); the account is untouched
    const { POST } = await import("@/app/api/payg/card/route");
    const res = await POST(post("/api/payg/card", { token: a.token }));
    expect(res.status).toBe(502);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(a).toMatchObject({ stripe_payment_method_id: "pm_acme", status: "active" });
  });

  it("POST /api/billing/portal: billingPortal.sessions.create hangs", async () => {
    const a = paygAccount(db);
    stripe.hang.set("billingPortal.sessions.create", "before");
    const { POST } = await import("@/app/api/billing/portal/route");
    const t0 = performance.now();
    const res = await POST(post("/api/billing/portal", { token: a.token }));
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "portal_unavailable" });
  });

  it("the client the dispute notice uses (paygStripe(), for charges.retrieve in the webhook) is bounded: a hanging lookup cannot hold the webhook past the bound", async () => {
    const mod = await import("@/app/api/stripe/webhook/route");
    expect(typeof mod.POST).toBe("function");
    const { paygStripe } = await import("@/lib/payg-stripe");
    stripe.hang.set("charges.retrieve", "before");
    const t0 = performance.now();
    const err = await paygStripe()!.charges.retrieve("ch_1").catch((e) => e);
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(isStripeTimeout(err)).toBe(true);
  });
});

// ============================================================================================ what Stripe holds is not always what we made

describe("an invoice that exists is judged by its real status; a remembered idempotency key with other parameters never makes a second invoice", () => {
  for (const status of ["void", "uncollectible"] as const) {
    it(`an invoice for the month that is ${status}: NOT marked invoiced, no second invoice or item, the operator is told once`, async () => {
      const account = await seed();
      const inv = await stripe.invoices.create({ customer: "cus_acme", metadata: { kind: "payg_settlement", account, month: "2026-09", settlement_key: KEY } } as any);
      stripe.invoicesById.get(inv.id)!.status = status;
      const r = await settle();
      expect(r).toMatchObject({ invoiced: 0, stillPending: 1, timedOut: 0 });
      expect(settlements()[0]).toMatchObject({ status: "pending", last_error: `invoice_${status}` });
      expect(settlements()[0].stripe_invoice_id).toBe(inv.id); // the invoice is recorded; it is simply not collectible
      expect(stripe.allInvoices).toHaveLength(1);
      expect(stripe.items).toHaveLength(0);
      const mails = opMail().filter((m) => /NOT invoiced/.test(m.subject));
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toContain(`invoice_${status}`);
      expect(mails[0].text).toContain(accountRef(account));
      await settle(); // the same day again: still one invoice, still one mail
      expect(stripe.allInvoices).toHaveLength(1);
      expect(opMail().filter((m) => /NOT invoiced/.test(m.subject))).toHaveLength(1);
    });
  }

  it("the operator mail for a void invoice names the real resolution (a person edits the settlement row); it does not point at the Dashboard alone", async () => {
    await seed();
    const inv = await stripe.invoices.create({ customer: "cus_acme", metadata: { kind: "payg_settlement", month: "2026-09", settlement_key: KEY } } as any);
    stripe.invoicesById.get(inv.id)!.status = "void";
    await settle();
    const m = opMail().find((x) => /NOT invoiced/.test(x.subject))!;
    expect(m.text).toMatch(/no automated resolution/i);
    expect(m.text).toContain("stripe_invoice_id");
    expect(m.text).toMatch(/status to void/);
  });

  it("the finalise call carries the stable per-month key (the same on every attempt, so a replay can never finalise twice)", async () => {
    await seed();
    await settle();
    expect(stripe.idemKeys).toContain(`${KEY}:finalize`);
    expect(stripe.idemKeys.filter((k) => k.endsWith(":finalize"))).toEqual([`${KEY}:finalize`]);
  });

  it("an open invoice made before the customer replaced the card is pointed at the new card, once, before the record of the card moves", async () => {
    const account = await seed();
    await settle();
    expect(stripe.allInvoices).toHaveLength(1);
    const id = stripe.allInvoices[0].id;
    expect(stripe.allInvoices[0].status).toBe("open");
    expect(stripe.invoiceUpdates).toHaveLength(0);
    // the customer replaces the card in the Billing Portal; the row is still pending (e.g. the earlier run died before recording it)
    stripe.customerDefaults.set("cus_acme", "pm_replaced");
    (db.rows("usage_settlements") as any[])[0].status = "pending";
    const r = await settle(NEXT_DAY);
    expect(r).toMatchObject({ timedOut: 0 });
    expect(stripe.invoiceUpdates).toEqual([{ id, params: { default_payment_method: "pm_replaced" } }]);
    expect((db.rows("api_accounts") as any[]).find((a) => a.account === account).stripe_payment_method_id).toBe("pm_replaced");
    expect(stripe.allInvoices).toHaveLength(1);
  });

  it("the same idempotency key with different parameters is refused by Stripe: the invoice is found again by its metadata and used; no second invoice", async () => {
    await seed();
    stripe.hang.set("invoices.create", "after"); // the first attempt created the draft (with pm_acme); the answer was lost
    expect((await settle()).timedOut).toBe(1);
    expect(stripe.allInvoices).toHaveLength(1);
    // the customer's card changed since; our create would carry other parameters; the list has not caught up on the first look only
    stripe.customerDefaults.set("cus_acme", "pm_new");
    const list = stripe.invoices.list;
    let looks = 0;
    stripe.invoices.list = async (p: any) => (++looks === 1 ? { data: [] } : list(p));
    const r = await settle();
    expect(r).toMatchObject({ invoiced: 1, timedOut: 0 });
    expect(stripe.allInvoices).toHaveLength(1);
    expect(stripe.items).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ status: "invoiced", stripe_invoice_id: stripe.allInvoices[0].id });
  });

  it("and if the invoice cannot be found even then, the month stays pending: Stripe's refusal is never answered by creating something else", async () => {
    await seed();
    stripe.hang.set("invoices.create", "after");
    await settle();
    stripe.customerDefaults.set("cus_acme", "pm_new");
    const list = stripe.invoices.list;
    stripe.invoices.list = async () => ({ data: [] });
    const r = await settle();
    expect(r).toMatchObject({ invoiced: 0, stillPending: 1 });
    expect(stripe.allInvoices).toHaveLength(1);
    expect(settlements()[0]).toMatchObject({ status: "pending", last_error: "StripeIdempotencyError:400" });
    stripe.invoices.list = list;
    expect((await settle(NEXT_DAY)).invoiced).toBe(1);
    expect(stripe.allInvoices).toHaveLength(1);
  });
});

describe("rows are taken in order of last touch, not of failure count", () => {
  it("a recovered row whose last attempt was long ago goes ahead of rows that failed more recently, however few times they failed", async () => {
    const rows: [string, number, string][] = [["s1", 2, "2026-10-20T01:00:00.000Z"], ["s2", 2, "2026-10-20T02:00:00.000Z"], ["rec", 10, "2026-10-01T01:00:00.000Z"]];
    for (const [account, attempts, touched] of rows) {
      paygAccount(db, { account, token: `tok-${account}-0123456789abcdefghijklmnop`, stripe_customer_id: `cus_${account}`, stripe_payment_method_id: `pm_${account}`, email: `${account}@x.example` });
      db.insertRow("usage_settlements", { account, month: "2026-09", units: 10, amount_cents: 2000, status: "pending", attempts, updated_at: touched });
    }
    const order: string[] = [];
    const retrieve = stripe.customers.retrieve;
    stripe.customers.retrieve = async (id: string) => { order.push(id); return retrieve(id); };
    await (await import("@/lib/payg-settle")).settleClosedMonths(stripe, NOW);
    expect(order).toEqual(["cus_rec", "cus_s1", "cus_s2"]);
  });
});
