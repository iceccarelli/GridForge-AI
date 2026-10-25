// Server-only: month-end settlement. One invoice per account per closed month, however often the cron runs.
//
// THE RULE (the same sentence is shown to customers; see billingRuleText): a month's charge is its net ledger units (charges
// minus refunds, UTC calendar month, `payg` scope only) x the unit price, invoiced in arrears. Below the minimum invoice the
// month is CARRIED into the next. The free allowance (`trial` scope) and subscription usage (`machine`) are never invoiced:
// they are not in the units this module sees at all (gf_payg_unsettled sums scope 'payg' only).
//
// "Once" is built from three independent things, because Stripe's idempotency keys expire after 24 hours and the cron is daily:
//   1. usage_settlements UNIQUE (account, month): the row is created FIRST; a second run finds it and creates nothing.
//   2. Our own record of progress on that row (stripe_invoice_id, then the item), so a retry resumes instead of repeating.
//   3. Before creating anything on Stripe, look for what an earlier crashed attempt may have created (an invoice carrying this
//      settlement's key in its metadata, an invoice item carrying it) and reuse it. The idempotency key `payg:{account}:{month}`
//      is passed as well, which covers the common case of a retry inside Stripe's 24 h window.
// A failed Stripe call leaves the row `pending` with a category in last_error; the next run finishes the same invoice.
//
// A TIMEOUT (lib/stripe-timeout.ts: every call here is bounded) is "cannot say", never an outcome. The request may still have reached
// Stripe, so a timed-out call never marks anything paid, collected or failed, and the retry is safe whichever way it went:
//   invoices.list / customers.retrieve / invoices.retrieve / invoiceItems.list    reads: nothing happened, the next run asks again
//   invoices.create      may have created the draft: the next run LISTS the customer's invoices and finds it by its settlement_key metadata
//                        before creating (and passes the idempotency key payg:{account}:{month} as well), so there is never a second invoice
//   invoiceItems.create  may have attached the item: the next run lists the invoice's items and finds it by the same metadata first
//                        (idempotency key {key}:item as well), so there is never a second item
//   invoices.update      idempotent (points the invoice at the card); our record of the replaced card moves only AFTER it succeeded
//   invoices.finalizeInvoice  may have finalised: the next run retrieves the invoice and, finding it open, does not finalise again
// The row stays `pending` (it is only ever moved on by an invoice event or by a confirmed finalise), the ledger and the other settlement
// rows are never touched by a Stripe failure, the timeout is counted in the report and mailed to the operator once a day per settlement.
// One stuck account cannot starve the others: after a timeout the account's remaining months wait for the next run, three timeouts in a
// row mean Stripe is not answering and the pass stops, and the pass as a whole has a time budget; what was not attempted is counted.

import { PAYG, eurText, paygChargeCents, utcMonth } from "@/lib/payg";
import { boundStripe, isStripeTimeout, stripeCallTimeoutMs } from "@/lib/stripe-timeout";
import { recordFunnelEvent } from "@/lib/funnel";
import { accountRef } from "@/lib/payg";
import { enc, pg, rpc } from "@/lib/payg-store";
import { stripeFault, type InvoiceLite, type PaygStripe } from "@/lib/payg-stripe";
import { openQuarantine } from "@/lib/payg-usage";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import type { ApiAccount } from "@/lib/api-access";

export interface Settlement {
  id: string;
  account: string;
  month: string;
  units: number;
  amount_cents: number;
  status: "pending" | "carried" | "invoiced" | "paid" | "failed" | "void";
  carried_units: number;
  carried_months: string[];
  rolled_into: string | null;
  stripe_invoice_id: string | null;
  stripe_invoice_item_id: string | null;
  hosted_invoice_url: string | null;
  attempts: number;
  last_error: string | null;
}

export const settlementKey = (account: string, month: string) => `payg:${account}:${month}`;

export interface SettleReport {
  considered: number;
  created: { invoiced: number; carried: number; void: number; pending: number };
  invoiced: number;
  stillPending: number;
  errors: string[];
  /** Pending rows that cannot proceed until the customer has a payment method on file. */
  noPaymentMethod: number;
  /** Months left alone because an un-acknowledged quarantined ledger event could belong to them. */
  heldByQuarantine: number;
  /** Stripe calls that got no answer in time. Each one's outcome at Stripe is UNKNOWN; its settlement stays pending and the next run re-reads before it writes. */
  timedOut: number;
  /** Pending rows NOT attempted this run (an earlier timeout on the same account, Stripe not answering, or the run's time budget): the next run takes them. */
  deferred: number;
}

/**
 * How long one run may spend invoicing (the daily job has other work to do inside its own 300 s limit: ingest, alerts, the pause pass, the
 * reversal pass). Checked between rows AND between the Stripe steps of a row, so the worst case is one bounded call past it.
 * PAYG_SETTLE_BUDGET_MS overrides it.
 */
export const SETTLE_BUDGET_MS = 90_000;
/** This many timeouts in a row, with no success between them, mean Stripe is not answering: the pass stops instead of waiting out every row. */
export const SETTLE_TIMEOUT_BREAKER = 3;
const settleBudgetMs = (): number => {
  const n = Number(process.env.PAYG_SETTLE_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : SETTLE_BUDGET_MS;
};

async function accountByName(account: string): Promise<ApiAccount | null | "error"> {
  const r = await pg<ApiAccount[]>("GET", `api_accounts?account=eq.${enc(account)}&limit=1`);
  if (!r.ok) return "error";
  return r.data?.[0] ?? null;
}

/** Phase A: give every unsettled closed month its row (invoice-bound `pending`, `carried` or `void`). */
interface Hold {
  /** An open quarantined event with an unreadable timestamp: no month can be trusted. */
  all: boolean;
  months: Set<string>;
}
const held = (h: Hold, month: string) => h.all || h.months.has(month);

async function createRows(now: Date, report: SettleReport, hold: Hold): Promise<boolean> {
  const un = await rpc<{ account: string; month: string; net_units: number | string }[]>("gf_payg_unsettled", { p_before: utcMonth(now) });
  if (!un.ok) {
    report.errors.push("could not list unsettled months");
    return false;
  }
  // Months are created strictly in order per account (the list is ordered), and a month's pending row ABSORBS the carried months it
  // includes in the same step, before the next month is looked at: otherwise a carried month would be counted again in every later
  // month of one run. If the absorb fails, that account's later months wait for the next run.
  const stopped = new Set<string>();
  for (const u of un.data ?? []) {
    if (stopped.has(u.account)) continue;
    if (held(hold, u.month)) {
      report.heldByQuarantine++;
      continue;
    }
    report.considered++;
    const net = Number(u.net_units);
    // Units carried in from earlier months of THIS account that no invoice has absorbed yet.
    const carried = await pg<Settlement[]>(
      "GET",
      `usage_settlements?account=eq.${enc(u.account)}&status=eq.carried&rolled_into=is.null&month=lt.${enc(u.month)}&select=id,month,units&order=month.asc`
    );
    if (!carried.ok) {
      report.errors.push("could not read carried months");
      continue;
    }
    const carriedRows = carried.data ?? [];
    const carriedUnits = carriedRows.reduce((n, r) => n + r.units, 0);
    const total = net + carriedUnits;
    const amount = paygChargeCents(total);
    let status: Settlement["status"];
    if (total === 0) status = "void";
    else if (amount < PAYG.minInvoiceCents) status = net > 0 ? "carried" : "void";
    else status = "pending";
    const billsCarried = status === "pending";

    const row = {
      account: u.account,
      month: u.month,
      units: billsCarried ? total : net,
      amount_cents: billsCarried ? amount : paygChargeCents(net),
      status,
      carried_units: billsCarried ? carriedUnits : 0,
      carried_months: billsCarried ? carriedRows.map((r) => r.month) : [],
    };
    // UNIQUE (account, month): created once. If a concurrent or earlier run already made it, nothing comes back.
    const ins = await pg<Settlement[]>("POST", "usage_settlements?on_conflict=account,month", row, "resolution=ignore-duplicates,return=representation");
    if (!ins.ok) {
      report.errors.push("could not create a settlement row");
      continue;
    }
    if (!ins.data || ins.data.length === 0) continue;
    if (status === "pending" && !(await absorbCarried({ account: u.account, month: u.month, carried_months: row.carried_months } as Settlement))) {
      report.errors.push("could not mark carried months");
      stopped.add(u.account);
    }
    if (status === "pending") report.created.pending++;
    else if (status === "carried") report.created.carried++;
    else report.created.void++;
  }
  return true;
}

/** Mark carried rows as absorbed by `month`. Idempotent: it names the exact months the settlement row recorded. */
async function absorbCarried(s: Settlement): Promise<boolean> {
  if (!s.carried_months?.length) return true;
  const r = await pg(
    "PATCH",
    `usage_settlements?account=eq.${enc(s.account)}&status=eq.carried&month=in.(${s.carried_months.map(enc).join(",")})&rolled_into=is.null`,
    { rolled_into: s.month, updated_at: new Date().toISOString() },
    "return=minimal"
  );
  return r.ok;
}

async function note(s: Settlement, error: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  await pg("PATCH", `usage_settlements?id=eq.${enc(s.id)}`, { last_error: error, attempts: s.attempts + (error ? 1 : 0), updated_at: new Date().toISOString(), ...extra }, "return=minimal");
}

/** What the operator should do about each category a settlement can fail with (never Stripe's own message: it can echo request data). */
function failureAdvice(category: string): string {
  if (category === "no_payment_method") return "The customer has no payment method on file (none saved, or none left on the Stripe customer). Nothing can be charged until they add a card; ask them to use Replace card in the portal.";
  if (category === "record_write_failed") return "Stripe accepted the call but the site could not record it. The next run resumes the same invoice; check the database if this repeats.";
  if (/^invoice_(void|uncollectible)$/.test(category)) return `The month's Stripe invoice was ${category.slice(8)} outside this system, so nothing is collected on it. The settlement stays pending and NO second invoice is created automatically. Decide in the Stripe Dashboard whether to reissue (create the invoice by hand with the same settlement_key metadata) or to forgive the month.`;
  if (/stripe_call_timeout/.test(category)) return "Stripe did not answer in time. The call may or may not have taken effect: the next run re-reads the invoice by its settlement key before it creates anything, so no second invoice is made.";
  if (/StripeCardError|card_declined/.test(category)) return "The card was declined. The customer needs to replace it (Replace card in the portal, or the Stripe Billing Portal; docs/10_PAYG_LAUNCH_CHECKLIST.md says what each reaches).";
  if (/StripeInvalidRequestError/.test(category)) return "Stripe refused the request. A card that was detached from the customer, or a deleted customer, is the usual cause: check the customer's payment methods in the Stripe Dashboard.";
  return "Stripe could not be reached or refused the call. The next run retries the same invoice.";
}

/**
 * A settlement that cannot be invoiced used to be visible only in the cron's JSON answer. A month that is not invoiced is revenue not
 * collected, and nobody reads that answer, so the operator is mailed: once per settlement per UTC day (the cron is daily; re-running it
 * the same day, or a retried run, mails nothing more). The mail names the settlement, the month, the amount and the category: never
 * the customer's email, a card detail or Stripe's message.
 */
async function alertOperator(s: Settlement, category: string, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  await notifyOperatorOnce(
    `settlement_failed:${s.id}:${day}`,
    `Pay-as-you-go settlement NOT invoiced: ${category} (${s.month})`,
    `Settlement ${s.id} for ${s.month} (${s.units.toLocaleString("en-IE")} units, ${eurText(s.amount_cents)}, account reference ${accountRef(s.account)}) could not be invoiced today.\n\n` +
      `Category: ${category}. Attempts so far: ${s.attempts + 1}.\n\n${failureAdvice(category)}\n\n` +
      "The row stays pending and every daily run retries it; this notice is sent once per settlement per day until it is invoiced."
  );
}

/**
 * A Stripe call that got NO ANSWER: its outcome is unknown, which is a different thing for the operator than a refusal. Once per
 * settlement per UTC day. Names the account REFERENCE, the month and the step; never the customer's email, a card detail or a message.
 */
async function alertTimeout(s: Settlement, step: string, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  await notifyOperatorOnce(
    `settlement_timeout:${s.id}:${day}`,
    `Pay-as-you-go settlement: Stripe did not answer (${s.month}, account ${accountRef(s.account)})`,
    `The Stripe call "${step}" for settlement ${s.id} (${s.month}, ${s.units.toLocaleString("en-IE")} units, ${eurText(s.amount_cents)}, account reference ${accountRef(s.account)}) got no answer within ${Math.round(stripeBoundSeconds())} s.\n\n` +
      "Its outcome at Stripe is UNKNOWN: it may have taken effect. Nothing was marked paid, collected or failed, and no ledger row was touched. The settlement stays pending and the next daily run " +
      "re-reads the invoice by its settlement key (and passes the same idempotency key) before it creates anything, so no second invoice or item is made. " +
      `Attempts so far: ${s.attempts + 1}. If this repeats, check status.stripe.com and the invoice in the Stripe Dashboard. This notice is sent once per settlement per day.`
  );
}
const stripeBoundSeconds = (): number => stripeCallTimeoutMs() / 1000;

/**
 * The card to bill: the customer's CURRENT default payment method at Stripe, because that is where a card replaced in the Stripe Billing
 * Portal lands (the portal changes the customer, not our row). Only when Stripe names none is the one we stored used.
 */
async function currentCard(stripe: PaygStripe, customer: string): Promise<string> {
  const c = await stripe.customers.retrieve(customer);
  if (c.deleted) return "";
  const d = c.invoice_settings?.default_payment_method;
  return typeof d === "string" ? d : d?.id ?? "";
}

/**
 * What one settlement's attempt came to. "timeout": a Stripe call got no answer (outcome unknown). "refused": Stripe ANSWERED with a failure
 * (it is reachable). "skipped": nothing was asked of Stripe, or the budget ended the row at a step boundary. The row is pending in every case
 * but "invoiced". Only "invoiced" and "refused" prove Stripe is answering (they reset the breaker).
 */
type Attempt = "invoiced" | "refused" | "skipped" | "timeout";

/** Thrown at a step boundary when the run's time is up: the row is left exactly as it is (pending, resumable) and counted as deferred. */
class OutOfTime extends Error {}

/** Phase B: carry one pending row through Stripe: invoice (draft) -> item -> finalise. Every step resumes where it stopped. */
async function invoiceOne(stripe: PaygStripe, s: Settlement, report: SettleReport, now: Date, gate: () => void): Promise<Attempt> {
  const acct = await accountByName(s.account);
  if (acct === "error" || !acct) {
    report.errors.push("account unreadable for a pending settlement");
    report.stillPending++;
    return "skipped";
  }
  if (!(await absorbCarried(s))) {
    report.errors.push("could not mark carried months");
    report.stillPending++;
    return "skipped";
  }
  // The Stripe call in flight, so a timeout can say WHICH call has an unknown outcome.
  let step = "customers.retrieve";
  const customer = acct.stripe_customer_id;
  const stored = acct.stripe_payment_method_id ?? "";
  // The card is resolved NOW, from the customer's current default at Stripe, and only falls back to the stored id when there is none.
  let current = "";
  if (customer) {
    try {
      gate();
      current = await currentCard(stripe, customer);
    } catch (err) {
      if (err instanceof OutOfTime) {
        report.deferred++;
        report.stillPending++;
        return "skipped";
      }
      const cat = stripeFault(err);
      await note(s, cat);
      report.stillPending++;
      report.errors.push(`settlement ${s.month} failed: ${cat}`);
      if (isStripeTimeout(err)) {
        report.timedOut++;
        await alertTimeout(s, step, now);
        return "timeout";
      }
      await alertOperator(s, cat, now);
      return "refused";
    }
  }
  const pm = current || stored;
  if (!customer || !pm) {
    // Not a failure to retry blindly: nothing can be charged without a saved payment method. Stays pending, visible in the report
    // and (once a day) in the operator's mail.
    await note(s, "no_payment_method");
    report.noPaymentMethod++;
    report.stillPending++;
    await alertOperator(s, "no_payment_method", now);
    return "skipped";
  }
  const cardChanged = Boolean(current) && current !== stored;
  const key = settlementKey(s.account, s.month);
  // Stripe refuses a request whose idempotency key it remembers WITH DIFFERENT PARAMETERS (StripeIdempotencyError): what the earlier
  // request created is what exists. Never answered by creating something else: the invoice / item is found again by the settlement key
  // in its metadata and used.
  const keyClash = (err: unknown): boolean => (err as { type?: unknown } | null)?.type === "StripeIdempotencyError";
  const findInvoice = async () => (await stripe.invoices.list({ customer, limit: 100 })).data.find((i) => i.metadata?.settlement_key === key);
  try {
    // 1. the draft invoice
    let invoiceId = s.stripe_invoice_id;
    let createdNow = false;
    if (!invoiceId) {
      // A crashed earlier attempt (or a create whose answer never came back) may have created it without our recording the id, and Stripe's
      // idempotency key may be older than 24 h: find it by the key we put in its metadata before creating another.
      step = "invoices.list";
      gate();
      let existing = await findInvoice();
      step = "invoices.create";
      let inv = existing;
      if (!inv) {
        gate();
        try {
          inv = await stripe.invoices.create(
            {
              customer,
              currency: PAYG.currency,
              collection_method: "charge_automatically",
              default_payment_method: pm,
              // Held as a draft until its item is attached and we finalise it ourselves (below), so a crash in between can never
              // leave Stripe auto-finalising an EMPTY invoice that our retry then cannot add to.
              auto_advance: false,
              pending_invoice_items_behavior: "exclude",
              description: `GridForge pay-as-you-go usage, ${s.month}`,
              metadata: { kind: "payg_settlement", account: s.account, month: s.month, settlement_key: key, settlement_id: s.id },
            },
            { idempotencyKey: key }
          );
        } catch (err) {
          if (!keyClash(err)) throw err;
          step = "invoices.list";
          existing = await findInvoice();
          if (!existing) throw err; // the key is remembered but no invoice carries it: stay pending, never create a second
          inv = existing;
        }
      }
      invoiceId = inv.id;
      createdNow = !existing;
      const saved = await pg<Settlement[]>("PATCH", `usage_settlements?id=eq.${enc(s.id)}&stripe_invoice_id=is.null`, { stripe_invoice_id: invoiceId, updated_at: new Date().toISOString() });
      if (!saved.ok) throw new Error("record");
    }
    // The invoice as Stripe holds it NOW, before anything is added to it.
    step = "invoices.retrieve";
    gate();
    const live = await stripe.invoices.retrieve(invoiceId);
    // An invoice that was voided or written off is NOT an invoiced month: nothing is collected on it and creating another would bill the
    // month a second time on nobody's decision. The row stays pending, the operator is told, and a person decides (reissue or forgive).
    if (live.status === "void" || live.status === "uncollectible") {
      const cat = `invoice_${live.status}`;
      await note(s, cat);
      report.stillPending++;
      report.errors.push(`settlement ${s.month} failed: ${cat}`);
      await alertOperator(s, cat, now);
      return "refused";
    }
    // 2. the one item, attached to THAT invoice
    let itemId = s.stripe_invoice_item_id;
    if (!itemId) {
      const findItem = async () => (await stripe.invoiceItems.list({ invoice: invoiceId!, limit: 100 })).data.find((i) => i.metadata?.settlement_key === key);
      step = "invoiceItems.list";
      gate();
      let have = await findItem();
      if (!have) {
        step = "invoiceItems.create";
        gate();
        try {
          have = await stripe.invoiceItems.create(
            {
              customer,
              invoice: invoiceId,
              amount: s.amount_cents,
              currency: PAYG.currency,
              description: `GridForge ${s.month}: ${s.units.toLocaleString("en-IE")} units at ${eurText(PAYG.unitPriceCents)} (net of refunds)`,
              metadata: { kind: "payg_settlement", account: s.account, month: s.month, settlement_key: key },
            },
            { idempotencyKey: `${key}:item` }
          );
        } catch (err) {
          if (!keyClash(err)) throw err;
          step = "invoiceItems.list";
          have = await findItem();
          if (!have) throw err;
        }
      }
      itemId = have.id;
      await pg("PATCH", `usage_settlements?id=eq.${enc(s.id)}`, { stripe_invoice_item_id: itemId, updated_at: new Date().toISOString() }, "return=minimal");
    }
    // 3. finalise (and let Stripe collect on the customer's saved payment method)
    // An invoice that already existed (an earlier attempt created it) keeps the card it was created with, whatever the customer has done
    // since: point a draft at the card resolved above, and an open one when the customer's card has changed since we last saw it.
    if (!createdNow && (live.status === "draft" || (live.status === "open" && cardChanged))) {
      step = "invoices.update";
      gate();
      await stripe.invoices.update(invoiceId, { default_payment_method: pm });
    }
    let finalised: InvoiceLite = live;
    if (live.status === "draft") {
      step = "invoices.finalizeInvoice";
      gate();
      try {
        finalised = await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: true }, { idempotencyKey: `${key}:finalize` });
      } catch (err) {
        if (!keyClash(err)) throw err;
        step = "invoices.retrieve";
        finalised = await stripe.invoices.retrieve(invoiceId); // the earlier finalise is what happened: read the invoice as it is now
        if (finalised.status === "draft") throw err;
      }
    }
    if (cardChanged) {
      // A card replaced in the Billing Portal: keep our record of the card in step, but only NOW that the invoice has been pointed at it
      // (a failed or timed-out update must leave the difference visible, or the next run would never repeat it). Best effort.
      const upd = await pg("PATCH", `api_accounts?account=eq.${enc(s.account)}`, { stripe_payment_method_id: current }, "return=minimal");
      if (!upd.ok) console.error("[GridForge] settlement: could not record the customer's replaced card; billed it anyway");
    }
    // `status=eq.pending`: a webhook that has already marked this row paid/failed is never moved backwards.
    await pg(
      "PATCH",
      `usage_settlements?id=eq.${enc(s.id)}&status=eq.pending`,
      { status: "invoiced", hosted_invoice_url: finalised.hosted_invoice_url ?? null, last_error: null, updated_at: new Date().toISOString() },
      "return=minimal"
    );
    report.invoiced++;
    // The funnel event is once per account, however many months are invoiced.
    await recordFunnelEvent("first_charge", { month: s.month, units: s.units, amount_cents: s.amount_cents, account_ref: accountRef(s.account) }, { dedupeKey: `first_charge:${accountRef(s.account)}` });
    return "invoiced";
  } catch (err) {
    if (err instanceof OutOfTime) {
      // The run's time is up at a step boundary: nothing is written, the row is exactly where it was, the next run resumes it.
      report.deferred++;
      report.stillPending++;
      return "skipped";
    }
    const record = err instanceof Error && err.message === "record";
    const cat = record ? "record_write_failed" : stripeFault(err);
    await note(s, cat);
    report.stillPending++;
    report.errors.push(`settlement ${s.month} failed: ${cat}`);
    if (isStripeTimeout(err)) {
      // No answer: whether the call took effect is UNKNOWN. The row stays pending exactly as it was (a timeout is not a failure of the
      // invoice, nor a payment); the next run re-reads by the settlement key before it creates anything.
      report.timedOut++;
      await alertTimeout(s, step, now);
      return "timeout";
    }
    await alertOperator(s, cat, now);
    return record ? "skipped" : "refused";
  }
}

/**
 * Settle every closed month. Safe to run any number of times, concurrently or not. The caller must have ingested the ledger up to
 * the engine's head first (see lib/payg-cron.ts): this function trusts usage_events to be complete for closed months.
 */
export async function settleClosedMonths(client: PaygStripe, now: Date = new Date(), opts: { clock?: () => number; budgetMs?: number } = {}): Promise<SettleReport> {
  // Every Stripe call below is bounded, whoever built the client (paygStripe() already is; a client handed in directly is bounded here).
  const stripe = boundStripe(client);
  const report: SettleReport = { considered: 0, created: { invoiced: 0, carried: 0, void: 0, pending: 0 }, invoiced: 0, stillPending: 0, errors: [], noPaymentMethod: 0, heldByQuarantine: 0, timedOut: 0, deferred: 0 };
  // A quarantined ledger event nobody has looked at could belong to a month about to be closed for good. Unreadable open quarantine
  // state means we cannot tell, so nothing is settled.
  const open = await openQuarantine();
  if (!open) {
    report.errors.push("could not read the ledger quarantine; nothing settled");
    return report;
  }
  const hold: Hold = { all: open.some((q) => !q.month), months: new Set(open.filter((q) => q.month).map((q) => q.month as string)) };

  const pending = await pg<Settlement[]>("GET", "usage_settlements?status=eq.pending&order=month.asc&limit=200");
  if (!pending.ok) {
    report.errors.push("could not list pending settlements");
    return report;
  }
  // Rows left pending by an earlier run that crashed before absorbing: do it now, before any new month reads the carried rows.
  for (const s of pending.data ?? []) await absorbCarried(s);
  await createRows(now, report, hold);
  // Least recently TOUCHED first (a failed attempt stamps updated_at): a row that was just tried and failed goes behind every other, so
  // rows stuck for a lasting reason (no payment method, a stuck account) rotate and cannot keep a recovered row beyond the batch limit.
  const toInvoice = await pg<Settlement[]>("GET", "usage_settlements?status=eq.pending&order=updated_at.asc.nullsfirst,month.asc&limit=200");
  if (!toInvoice.ok) {
    report.errors.push("could not list pending settlements");
    return report;
  }
  const clock = opts.clock ?? (() => performance.now());
  const started = clock();
  const budget = opts.budgetMs ?? settleBudgetMs();
  const gate = () => {
    if (clock() - started > budget) throw new OutOfTime();
  };
  const stuck = new Set<string>();
  let inARow = 0;
  for (const s of toInvoice.data ?? []) {
    if (held(hold, s.month)) {
      report.heldByQuarantine++;
      continue;
    }
    // Not attempted this run: this account already timed out (its later months would only wait out the same bound), Stripe has stopped
    // answering, or the run has used its time. Nothing is written for them; they are still pending and the next run takes them.
    if (stuck.has(s.account) || inARow >= SETTLE_TIMEOUT_BREAKER || clock() - started > budget) {
      report.deferred++;
      report.stillPending++;
      continue;
    }
    const out = await invoiceOne(stripe, s, report, now, gate);
    if (out === "timeout") {
      stuck.add(s.account);
      inARow++;
    } else if (out === "invoiced" || out === "refused") inARow = 0; // Stripe answered; a row that never asked it proves nothing
  }
  if (report.deferred > 0) {
    await notifyOperatorOnce(
      `settlement_deferred:${now.toISOString().slice(0, 10)}`,
      `Pay-as-you-go settlement: ${report.deferred} invoice(s) not attempted today`,
      `${report.deferred} pending settlement(s) were not attempted in today's run because Stripe stopped answering (${report.timedOut} call(s) timed out), an account's earlier call timed out, or the run used its time budget. ` +
        "Nothing was written for them: they are still pending and the next daily run takes them. If this repeats, check status.stripe.com. This notice is sent once a day."
    );
  }
  return report;
}

