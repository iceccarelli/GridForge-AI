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

import { PAYG, eurText, paygChargeCents, utcMonth } from "@/lib/payg";
import { recordFunnelEvent } from "@/lib/funnel";
import { accountRef } from "@/lib/payg";
import { enc, pg, rpc } from "@/lib/payg-store";
import { stripeFault, type PaygStripe } from "@/lib/payg-stripe";
import { openQuarantine } from "@/lib/payg-usage";
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
}

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

/** Phase B: carry one pending row through Stripe: invoice (draft) -> item -> finalise. Every step resumes where it stopped. */
async function invoiceOne(stripe: PaygStripe, s: Settlement, report: SettleReport): Promise<void> {
  const acct = await accountByName(s.account);
  if (acct === "error" || !acct) {
    report.errors.push("account unreadable for a pending settlement");
    report.stillPending++;
    return;
  }
  if (!(await absorbCarried(s))) {
    report.errors.push("could not mark carried months");
    report.stillPending++;
    return;
  }
  const customer = acct.stripe_customer_id;
  const pm = acct.stripe_payment_method_id;
  if (!customer || !pm) {
    // Not a failure to retry blindly: nothing can be charged without a saved payment method. Stays pending, visible in the report.
    await note(s, "no_payment_method");
    report.noPaymentMethod++;
    report.stillPending++;
    return;
  }
  const key = settlementKey(s.account, s.month);
  try {
    // 1. the draft invoice
    let invoiceId = s.stripe_invoice_id;
    if (!invoiceId) {
      // A crashed earlier attempt may have created it without our recording the id (and Stripe's idempotency key may be older than
      // 24 h): find it by the key we put in its metadata before creating another.
      const existing = (await stripe.invoices.list({ customer, limit: 100 })).data.find((i) => i.metadata?.settlement_key === key);
      const inv =
        existing ??
        (await stripe.invoices.create(
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
        ));
      invoiceId = inv.id;
      const saved = await pg<Settlement[]>("PATCH", `usage_settlements?id=eq.${enc(s.id)}&stripe_invoice_id=is.null`, { stripe_invoice_id: invoiceId, updated_at: new Date().toISOString() });
      if (!saved.ok) throw new Error("record");
    }
    // 2. the one item, attached to THAT invoice
    let itemId = s.stripe_invoice_item_id;
    if (!itemId) {
      const items = (await stripe.invoiceItems.list({ invoice: invoiceId, limit: 100 })).data;
      const have = items.find((i) => i.metadata?.settlement_key === key);
      itemId =
        have?.id ??
        (
          await stripe.invoiceItems.create(
            {
              customer,
              invoice: invoiceId,
              amount: s.amount_cents,
              currency: PAYG.currency,
              description: `GridForge ${s.month}: ${s.units.toLocaleString("en-IE")} units at ${eurText(PAYG.unitPriceCents)} (net of refunds)`,
              metadata: { kind: "payg_settlement", account: s.account, month: s.month, settlement_key: key },
            },
            { idempotencyKey: `${key}:item` }
          )
        ).id;
      await pg("PATCH", `usage_settlements?id=eq.${enc(s.id)}`, { stripe_invoice_item_id: itemId, updated_at: new Date().toISOString() }, "return=minimal");
    }
    // 3. finalise (and let Stripe collect on the customer's saved payment method)
    const current = await stripe.invoices.retrieve(invoiceId);
    const finalised = current.status === "draft" ? await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: true }, { idempotencyKey: `${key}:finalize` }) : current;
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
  } catch (err) {
    const cat = err instanceof Error && err.message === "record" ? "record_write_failed" : stripeFault(err);
    await note(s, cat);
    report.stillPending++;
    report.errors.push(`settlement ${s.month} failed: ${cat}`);
  }
}

/**
 * Settle every closed month. Safe to run any number of times, concurrently or not. The caller must have ingested the ledger up to
 * the engine's head first (see lib/payg-cron.ts): this function trusts usage_events to be complete for closed months.
 */
export async function settleClosedMonths(stripe: PaygStripe, now: Date = new Date()): Promise<SettleReport> {
  const report: SettleReport = { considered: 0, created: { invoiced: 0, carried: 0, void: 0, pending: 0 }, invoiced: 0, stillPending: 0, errors: [], noPaymentMethod: 0, heldByQuarantine: 0 };
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
  const toInvoice = await pg<Settlement[]>("GET", "usage_settlements?status=eq.pending&order=month.asc&limit=200");
  if (!toInvoice.ok) {
    report.errors.push("could not list pending settlements");
    return report;
  }
  for (const s of toInvoice.data ?? []) {
    if (held(hold, s.month)) {
      report.heldByQuarantine++;
      continue;
    }
    await invoiceOne(stripe, s, report);
  }
  return report;
}

