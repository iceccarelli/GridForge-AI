// Server-only: what the Stripe webhook does for pay-as-you-go.
//
// Two events, both written as ABSOLUTE state so a duplicate or reordered delivery is harmless, and both answering "retry" (HTTP
// 500 from the route) only when a read or write that is needed failed, as the rest of the webhook does:
//
//   checkout.session.completed, metadata.kind === "api_payg_enable", mode "setup"
//        the card was saved (and charged nothing): attach the payment method to the customer as the invoice default, then turn
//        the account into `api_payg` with the cap the customer chose. A replay never re-enables, never resets a cap the customer
//        has since changed, and never lifts a past_due.
//   invoice.paid / invoice.payment_failed, invoice.metadata.kind === "payg_settlement"
//        the settlement row moves paid / failed (a late `failed` can never override `paid`), and the ACCOUNT is derived from
//        its settlements: past_due (live key revoked, no mint) while any is failed, active again when none is. An account on a refund
//        or dispute hold (lib/payg-refunds.ts) is left to that hold: this derivation neither lifts nor re-applies it, and a LATER
//        settlement that is paid in full lifts it (the customer is current).

import type Stripe from "stripe";
import { suspendApiKeys, updateApiAccount, type ApiAccount } from "@/lib/api-access";
import { liftHold, noteUnconfirmedRevocation } from "@/lib/billing-holds";
import { notifyOperator } from "@/lib/mail";
import { accountRef, MONTH, paygCapUnits, parseCapEur } from "@/lib/payg";
import { recordFunnelEvent } from "@/lib/funnel";
import { notifyCustomer } from "@/lib/notifications";
import { enc, pg } from "@/lib/payg-store";
import { stripeFault, type PaygStripe } from "@/lib/payg-stripe";
import { boundStripe, isStripeTimeout } from "@/lib/stripe-timeout";
import type { Settlement } from "@/lib/payg-settle";

export type Applied = { ok: true } | { ok: false; why: string };

async function accountByName(account: string): Promise<ApiAccount | null | "error"> {
  const r = await pg<ApiAccount[]>("GET", `api_accounts?account=eq.${enc(account)}&limit=1`);
  if (!r.ok) return "error";
  return r.data?.[0] ?? null;
}

const idOf = (v: string | { id: string } | null | undefined): string => (typeof v === "string" ? v : v?.id ?? "");

// Every Stripe call in this file is bounded (lib/stripe-timeout.ts), whoever built the client. A call with no answer is "cannot say": the
// event is answered "retry" (Stripe redelivers) and nothing is recorded as done. Both handlers are absolute-state and replay-safe, so a call
// that did take effect at Stripe is simply repeated (setting the same default card; paying an invoice Stripe says is already paid).

export async function handlePaygEnable(session: Stripe.Checkout.Session, client: PaygStripe | null): Promise<Applied> {
  const stripe = client ? boundStripe(client) : null;
  const accountName = String(session.metadata?.account_id ?? "");
  const cap = parseCapEur(session.metadata?.cap_eur);
  if (!accountName || cap === null || session.mode !== "setup") {
    // Our own route wrote this metadata; a redelivery cannot repair a malformed one. Say so once and stop retrying.
    console.error("[GridForge] payg enable event with unusable metadata; acknowledged without effect:", session.id);
    await notifyOperator("A pay-as-you-go enable event could not be applied", `Checkout session ${session.id} carried unusable metadata. No account was changed.`);
    return { ok: true };
  }
  if (!stripe) return { ok: false, why: "stripe not configured" };
  const acct = await accountByName(accountName);
  if (acct === "error") return { ok: false, why: "account lookup failed" };
  if (!acct) {
    console.error("[GridForge] payg enable for an account that does not exist:", session.id);
    return { ok: true };
  }
  if (acct.status === "cancelled") {
    console.error("[GridForge] payg enable for a cancelled account ignored:", session.id);
    return { ok: true };
  }
  const customer = idOf(session.customer as string | { id: string } | null);
  const siId = idOf(session.setup_intent as string | { id: string } | null);
  if (!customer || !siId) {
    console.error("[GridForge] payg enable without a customer or setup intent; acknowledged without effect:", session.id);
    return { ok: true };
  }

  let pm = "";
  try {
    const si = await stripe.setupIntents.retrieve(siId);
    // The saved method must belong to the session's customer and the setup must be the one WE started for this account.
    if (si.status && si.status !== "succeeded") return { ok: true };
    if (si.metadata && si.metadata.account_id && si.metadata.account_id !== accountName) {
      console.error("[GridForge] payg enable: setup intent names a different account; refused:", session.id);
      return { ok: true };
    }
    pm = idOf(si.payment_method);
    if (!pm) return { ok: true };
    await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pm } });
  } catch (err) {
    console.error(`[GridForge] payg enable: Stripe call failed (${stripeFault(err)}); asking for a redelivery`);
    return { ok: false, why: isStripeTimeout(err) ? "stripe timeout" : "stripe" };
  }

  const first = acct.plan !== "api_payg";
  const units = paygCapUnits(cap);
  const saved = await updateApiAccount(
    acct.token,
    first
      ? {
          plan: "api_payg",
          cap_units: units,
          monthly_units: units,
          stripe_customer_id: customer,
          stripe_payment_method_id: pm,
          payg_enabled_at: acct.payg_enabled_at ?? new Date().toISOString(),
          status: "active",
        }
      : // Already pay-as-you-go: only the card can change. The cap, the status and the enable time are NOT touched by a replay.
        { stripe_customer_id: customer, stripe_payment_method_id: pm }
  );
  if (!saved) return { ok: false, why: "account write failed" };
  if (first) await recordFunnelEvent("payg_enabled", { cap_eur: cap, plan: "api_payg", account_ref: accountRef(accountName) }, { dedupeKey: `payg_enabled:${accountRef(accountName)}` });
  return { ok: true };
}

/**
 * checkout.session.completed, kind api_payg_card_update (Checkout mode "setup" on the account's EXISTING customer): the customer
 * replaced the card on file. Saved as the customer's default and the account's card; any UNPAID failed invoice is pointed at it (an
 * invoice keeps the card it was created with, so the new default alone would not help) and tried now. The result of that attempt comes
 * back as the usual invoice.paid / invoice.payment_failed event, which is what reinstates the account. Replay-safe: the card write is
 * absolute, and paying an invoice that is already paid is refused by Stripe and ignored.
 */
export async function handlePaygCardUpdate(session: Stripe.Checkout.Session, client: PaygStripe | null): Promise<Applied> {
  const stripe = client ? boundStripe(client) : null;
  const accountName = String(session.metadata?.account_id ?? "");
  if (!accountName || session.mode !== "setup") {
    console.error("[GridForge] payg card update with unusable metadata; acknowledged without effect:", session.id);
    return { ok: true };
  }
  if (!stripe) return { ok: false, why: "stripe not configured" };
  const acct = await accountByName(accountName);
  if (acct === "error") return { ok: false, why: "account lookup failed" };
  if (!acct || acct.plan !== "api_payg" || acct.status === "cancelled") {
    console.error("[GridForge] payg card update for an account that cannot take one; acknowledged without effect:", session.id);
    return { ok: true };
  }
  const customer = idOf(session.customer as string | { id: string } | null);
  const siId = idOf(session.setup_intent as string | { id: string } | null);
  // The card goes on the customer WE hold for this account, never on whichever customer the session names.
  if (!customer || !siId || customer !== acct.stripe_customer_id) {
    console.error("[GridForge] payg card update names a different customer than the account's; refused:", session.id);
    return { ok: true };
  }
  let pm = "";
  try {
    const si = await stripe.setupIntents.retrieve(siId);
    if (si.status && si.status !== "succeeded") return { ok: true };
    if (si.metadata?.account_id !== accountName || si.metadata?.kind !== "api_payg_card_update") {
      console.error("[GridForge] payg card update: setup intent is not ours for this account; refused:", session.id);
      return { ok: true };
    }
    pm = idOf(si.payment_method);
    if (!pm) return { ok: true };
    await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pm } });
  } catch (err) {
    console.error(`[GridForge] payg card update: Stripe call failed (${stripeFault(err)}); asking for a redelivery`);
    return { ok: false, why: isStripeTimeout(err) ? "stripe timeout" : "stripe" };
  }
  if (!(await updateApiAccount(acct.token, { stripe_payment_method_id: pm }))) return { ok: false, why: "account write failed" };

  const failed = await pg<{ stripe_invoice_id: string | null }[]>("GET", `usage_settlements?account=eq.${enc(accountName)}&status=eq.failed&select=stripe_invoice_id&limit=20`);
  if (!failed.ok) return { ok: false, why: "settlement lookup failed" };
  for (const f of failed.data ?? []) {
    if (!f.stripe_invoice_id) continue;
    try {
      await stripe.invoices.update(f.stripe_invoice_id, { default_payment_method: pm });
      await stripe.invoices.pay(f.stripe_invoice_id, { payment_method: pm });
    } catch (err) {
      // No answer in time: the attempt may or may not have been made, and every further invoice would wait out the same bound inside a webhook.
      // The card is already saved (absolute), so Stripe is asked to redeliver; the retry repeats the (idempotent) attempts.
      if (isStripeTimeout(err)) {
        console.error("[GridForge] payg card update: Stripe did not answer retrying an unpaid invoice; asking for a redelivery");
        return { ok: false, why: "stripe timeout" };
      }
      // Declined again, or already paid: either way the invoice events say what happened. Never fails the card replacement itself.
      console.error(`[GridForge] payg card update: retrying an unpaid invoice did not succeed (${stripeFault(err)})`);
    }
  }
  return { ok: true };
}

/**
 * Revoke the account's live key and block minting: past_due. One write records both (api-access suspendApiKeys: compare-and-set on the
 * key id, the revocation recorded BEFORE the engine is asked); the engine is told after. Best effort towards the engine, like every
 * revocation: an unreachable engine must not turn a recorded failure into an endless redelivery. What it does not confirm stays an
 * unconfirmed revocation (a durable obligation the daily sweep keeps pushing, reported to the operator once and listed by
 * /api/admin/stripe-health), and a key deliberately left live next to a newer one is revoked with the rest.
 */
async function suspend(acct: ApiAccount): Promise<boolean> {
  const out = await suspendApiKeys(acct, { status: "past_due" });
  if (!out.ok) return Boolean(out.terminal); // terminal: the account was cancelled meanwhile, so there is nothing to suspend
  if (out.unconfirmed.length) await noteUnconfirmedRevocation(out.row, out.unconfirmed, "pay-as-you-go payment failed");
  return true;
}

/** The account follows its settlements: past_due while any is failed, active again when none is. Never touches a cancelled account. */
export async function reconcileAccount(accountName: string): Promise<Applied> {
  const acct = await accountByName(accountName);
  if (acct === "error") return { ok: false, why: "account lookup failed" };
  if (!acct || acct.plan !== "api_payg" || acct.status === "cancelled") return { ok: true };
  // A refund or dispute hold decides this account; a failed settlement elsewhere neither adds to it nor ends it.
  if (acct.billing_hold) return { ok: true };
  const failed = await pg<{ id: string }[]>("GET", `usage_settlements?account=eq.${enc(accountName)}&status=eq.failed&select=id&limit=1`);
  if (!failed.ok) return { ok: false, why: "settlement lookup failed" };
  const hasFailed = (failed.data?.length ?? 0) > 0;
  if (hasFailed && acct.status === "active") {
    if (!(await suspend(acct))) return { ok: false, why: "account write failed" };
  } else if (!hasFailed && acct.status === "past_due") {
    // The customer re-mints: the key that was revoked stays revoked.
    if (!(await updateApiAccount(acct.token, { status: "active" }))) return { ok: false, why: "account write failed" };
  }
  return { ok: true };
}

/**
 * A settlement invoice PAID for a month LATER than the one a refund or dispute hold was about: the customer is current again, so the hold
 * ends (to what the account was before; the revoked key stays revoked and the customer mints a new one). An older month, the same
 * invoice, or a payment of nothing lifts nothing. `ok: false` = retry.
 */
async function liftHoldOnLaterPayment(acct: ApiAccount, inv: Stripe.Invoice, month: string, eventId: string): Promise<Applied> {
  if (acct.billing_hold !== "refunded" && acct.billing_hold !== "disputed") return { ok: true };
  if (!(typeof inv.amount_paid === "number" && inv.amount_paid > 0) || !acct.billing_hold_invoice) return { ok: true };
  const held = await pg<{ month: string }[]>("GET", `usage_settlements?account=eq.${enc(acct.account)}&stripe_invoice_id=eq.${enc(acct.billing_hold_invoice)}&select=month&limit=1`);
  if (!held.ok) return { ok: false, why: "held settlement lookup failed" };
  const heldMonth = held.data?.[0]?.month;
  if (!heldMonth || !(month > heldMonth)) return { ok: true };
  const lifted = await liftHold(
    { api: acct, watch: null, intelligence: null },
    { kinds: ["refunded", "disputed"], notInvoice: inv.id, paidCents: inv.amount_paid, restore: "prev", cause: "invoice_paid", clock: "none", subscriptionId: "", eventId }
  );
  return lifted.ok ? { ok: true } : { ok: false, why: "settlement hold could not be lifted" };
}

/** null = not a pay-as-you-go invoice (the caller carries on with subscription handling). */
export async function handlePaygInvoice(event: Stripe.Event): Promise<Applied | null> {
  if (event.type !== "invoice.paid" && event.type !== "invoice.payment_failed") return null;
  const inv = event.data.object as Stripe.Invoice;
  if (inv.metadata?.kind !== "payg_settlement") return null;
  const accountName = String(inv.metadata.account ?? "");
  const month = String(inv.metadata.month ?? "");
  if (!accountName || !MONTH.test(month) || !inv.id) {
    console.error("[GridForge] payg invoice event with unusable metadata; acknowledged:", inv.id);
    return { ok: true };
  }
  const got = await pg<Settlement[]>("GET", `usage_settlements?account=eq.${enc(accountName)}&month=eq.${enc(month)}&limit=1`);
  if (!got.ok) return { ok: false, why: "settlement lookup failed" };
  const s = got.data?.[0];
  if (!s) {
    // A settlement row is written BEFORE its invoice exists, so this is not an early event; it is not ours to guess at.
    console.error("[GridForge] payg invoice event for a settlement we have no row for:", inv.id);
    await notifyOperator("A pay-as-you-go invoice has no settlement record", `Stripe invoice ${inv.id} carries payg_settlement metadata but no usage_settlements row matches it. Nothing was changed.`);
    return { ok: true };
  }
  if (s.stripe_invoice_id && s.stripe_invoice_id !== inv.id) {
    // Two Stripe invoices for one settled month would be a double charge. Never apply it silently.
    console.error("[GridForge] payg invoice event names a different invoice than the settlement records:", inv.id);
    await notifyOperator(
      "Possible duplicate pay-as-you-go invoice",
      `Settlement ${s.id} (${month}) records invoice ${s.stripe_invoice_id}, but Stripe sent an event for ${inv.id} carrying the same settlement metadata. Check Stripe for a second invoice and void or refund it.`
    );
    return { ok: true };
  }

  const stamp = new Date().toISOString();
  let failedApplied = false;
  if (event.type === "invoice.paid") {
    // pending/invoiced/failed -> paid. `paid` is terminal against `failed`: nothing here can move it back.
    const r = await pg(
      "PATCH",
      `usage_settlements?id=eq.${enc(s.id)}&status=in.(pending,invoiced,failed)`,
      { status: "paid", stripe_invoice_id: inv.id, hosted_invoice_url: inv.hosted_invoice_url ?? s.hosted_invoice_url, last_error: null, updated_at: stamp },
      "return=minimal"
    );
    if (!r.ok) return { ok: false, why: "settlement write failed" };
  } else {
    const r = await pg<Settlement[]>(
      "PATCH",
      `usage_settlements?id=eq.${enc(s.id)}&status=in.(pending,invoiced,failed)`,
      { status: "failed", stripe_invoice_id: inv.id, hosted_invoice_url: inv.hosted_invoice_url ?? s.hosted_invoice_url, updated_at: stamp }
    );
    if (!r.ok) return { ok: false, why: "settlement write failed" };
    failedApplied = (r.data?.length ?? 0) > 0;
    if (failedApplied && s.status !== "failed") {
      await recordFunnelEvent("payment_failed", { month, account_ref: accountRef(accountName) }, { dedupeKey: `payment_failed:${inv.id}` });
    }
  }
  // The account first (so the key really is revoked by the time the customer reads that it is), then the customer's notice: ONE
  // durable obligation per failed settlement. Stripe reports every retried failure and may redeliver; the outbox's unique key makes
  // all of those the same single email, and a settlement that has since been paid cancels it unsent. A late `failed` that did not
  // apply (the row was already paid) enqueues nothing. If the obligation cannot be recorded the event is retried.
  if (event.type === "invoice.paid") {
    const acct = await accountByName(accountName);
    if (acct === "error") return { ok: false, why: "account lookup failed" };
    if (acct && acct.billing_hold && acct.status !== "cancelled") {
      const lifted = await liftHoldOnLaterPayment(acct, inv, month, event.id);
      if (!lifted.ok) return lifted;
    }
  }
  const reconciled = await reconcileAccount(accountName);
  if (!reconciled.ok) return reconciled;
  if (failedApplied && (await notifyCustomer("payg_payment_failed", s.id)) === "retry_webhook") return { ok: false, why: "notification not recorded" };
  return { ok: true };
}

