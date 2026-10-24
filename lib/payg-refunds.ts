// Server-only: Stripe refunds (in full or in part) or disputes a pay-as-you-go MONTHLY SETTLEMENT invoice.
//
// What a settlement invoice is. usage_settlements has one row per (account, month); its Stripe invoice (idempotency key
// payg:{account}:{YYYY-MM}) carries metadata.kind = "payg_settlement". It has no subscription, so none of the subscription machinery in
// lib/billing-holds.ts ever saw a refund or a chargeback of it: the settlement stayed "paid", the customer's page kept showing the full
// amount as paid, and the account went on using the engine as if nothing had happened.
//
// The policy, and why (the conservative reversible one; the narrow decision left to the owner is named in the report):
//
//   RECORD     Every refund (cumulative amount as Stripe reports it) and every dispute state is appended to payg_settlement_reversals
//              (migration 0043), linked to the settlement, once per refund amount / per dispute and state, never per delivery. The
//              settlement row is NOT edited (its status is the history of the INVOICE: it was paid) and the usage ledger (usage_events,
//              append-only, the engine's record of what was consumed) is NOT touched: the units were consumed and stay consumed. Nothing is
//              re-granted, the cap does not move, and no credit is applied to any future invoice. What the customer sees is the settlement's
//              status plus the refunded amount and the dispute state (app/api/usage).
//   PARTIAL    A partial refund is recorded and the operator is told. Access is unchanged.
//   SUSPEND    A refund IN FULL, or a dispute that is open or was lost, suspends further pay-as-you-go use the same way a subscription
//              hold does: the live key is revoked (recorded first, the engine told after, only an engine 2xx confirms), minting refused,
//              the row kept (billing_hold refunded / disputed on api_accounts). Reversible, nothing deleted. Not applied when the account
//              has since paid a LATER settlement (the customer is current: the reversed month is history), when the account is cancelled,
//              or when the refunded invoice is not the settlement's own recorded invoice (a duplicate invoice refunded is the right outcome).
//   RESTORE    A dispute won (or closed without a loss) lifts the hold that dispute caused. A later settlement invoice that is PAID lifts
//              a refund or dispute hold (lib/payg-billing.ts). An operator can release a hold by appending a 'release' row naming the
//              hold's own charge or dispute id; the daily job applies it once and audits it. The revoked key stays revoked: the customer mints a new one.
//   OPERATOR   Every new reversal is mailed once (settlement, month, account reference, amounts, what was done, how to release); the daily
//              job reports the accounts still on hold. A person decides whether the customer's access continues.

import type { ApiAccount } from "@/lib/api-access";
import { applyHold, liftHold, recordBillingAudit, type Handled, type PaymentOwner } from "@/lib/billing-holds";
import { classifyDispute, HOLDS_ACCESS, LIFTS_DISPUTE_HOLD, type DisputeState } from "@/lib/dispute-state";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import { releaseSql } from "@/lib/payg-release-sql";
import { eurText, accountRef, MONTH } from "@/lib/payg";
import { reconcileAccount } from "@/lib/payg-billing";
import type { Settlement } from "@/lib/payg-settle";
import { enc, pg } from "@/lib/payg-store";

export interface SettlementRef {
  account: string;
  month: string;
  invoiceId: string;
}

/**
 * Is this payment a pay-as-you-go settlement invoice? null: no (a subscription invoice, a deposit). "malformed": it says it is one and
 * names no usable account and month (nothing can be linked; the operator is told).
 */
export function settlementRefOf(owner: Extract<PaymentOwner, { ok: true }>): SettlementRef | "malformed" | null {
  const meta = owner.invoiceMeta;
  if (meta?.kind !== "payg_settlement") return null;
  const account = String(meta.account ?? "");
  const month = String(meta.month ?? "");
  if (!account || !MONTH.test(month) || !owner.invoiceId) return "malformed";
  return { account, month, invoiceId: owner.invoiceId };
}

export type ReversalEvent =
  | { kind: "refund"; ref: string; full: boolean; refundedCents: number; chargeCents: number }
  | { kind: "dispute"; ref: string; status: string; state: DisputeState; amountCents: number };

async function accountByName(account: string): Promise<ApiAccount | null | "error"> {
  const r = await pg<ApiAccount[]>("GET", `api_accounts?account=eq.${enc(account)}&limit=1`);
  if (!r.ok) return "error";
  return r.data?.[0] ?? null;
}

const tableMissing = (r: { ok: boolean; status: number; code?: string }) => !r.ok && (r.status === 404 || r.code === "PGRST205" || r.code === "42P01");

const holdKindOf = (ev: ReversalEvent) => (ev.kind === "refund" ? ("refunded" as const) : ("disputed" as const));

function describe(ev: ReversalEvent, s: Settlement): { subject: string; lead: string } {
  const amount = eurText(s.amount_cents);
  if (ev.kind === "refund") {
    return {
      subject: `Pay-as-you-go settlement ${ev.full ? "REFUNDED IN FULL" : "partly refunded"} (${s.month})`,
      lead: `Stripe reports ${eurText(ev.refundedCents)} refunded of the ${eurText(ev.chargeCents || s.amount_cents)} charged for the ${s.month} settlement (${amount}, ${s.units.toLocaleString("en-IE")} units).`,
    };
  }
  return {
    subject: `Pay-as-you-go settlement DISPUTED: ${ev.status} (${s.month})`,
    lead: `The ${s.month} settlement (${amount}) is disputed with the card issuer; Stripe's status is ${ev.status}${ev.state === "won" ? " (won: the money came back)" : ev.state === "lost" ? " (lost: the money stays debited)" : ""}.`,
  };
}

async function operatorNotice(ev: ReversalEvent, s: Settlement, key: string, outcome: string, mismatch: boolean): Promise<void> {
  const d = describe(ev, s);
  await notifyOperatorOnce(
    `payg_reversal:${key}`,
    `${d.subject} (account ${accountRef(s.account)})`,
    `${d.lead}\n\nSettlement ${s.id}, Stripe invoice ${s.stripe_invoice_id ?? "-"}, account reference ${accountRef(s.account)}, Stripe object ${ev.ref}.\n\n` +
      (mismatch ? "WARNING: Stripe's event names an invoice that is NOT the one this settlement records. Check Stripe for a duplicate invoice; the refund of a duplicate is the right outcome and no access was changed.\n\n" : "") +
      `What the site did: ${outcome}\n\n` +
      "What it did NOT do, on purpose: the usage ledger and the units already consumed are unchanged (the engine's record of what was used stays as it is), the account's cap is unchanged, the settlement row was not edited, and no credit was applied to any future invoice. " +
      "A person decides whether this customer's access continues.\n\n" +
      `To restore a held account without waiting for a won dispute or a paid later settlement, append a release (Supabase SQL editor, service role):\n` +
      `  ${releaseSql(s, ev.ref)}\n` +
      "The daily job lifts exactly that hold, once, and audits it. The release covers the hold as it stands NOW: a later state of the same dispute (open, then lost) or a later hold needs its own release. The revoked key stays revoked; the customer mints a new one. This notice is sent once per refund amount or dispute status."
  );
}

/**
 * A refund or dispute state of a settlement invoice. `ok: false` = a lookup or write failed and the event is retried (every step is
 * idempotent: the reversal row is once-only, the hold and the lift are absolute).
 */
export async function reverseSettlement(p: { s: SettlementRef | "malformed"; ev: ReversalEvent; eventId: string; created?: number }): Promise<Handled> {
  if (p.s === "malformed") {
    await notifyOperatorOnce(`payg_reversal_malformed:${p.ev.ref}`, "A refund or dispute of a pay-as-you-go invoice could not be linked", `Stripe object ${p.ev.ref} belongs to an invoice marked payg_settlement that names no usable account and month. Nothing was changed. Find the settlement by the invoice in Stripe.`);
    return { ok: true };
  }
  const { account, month, invoiceId } = p.s;
  const ev = p.ev;
  const got = await pg<Settlement[]>("GET", `usage_settlements?account=eq.${enc(account)}&month=eq.${enc(month)}&limit=1`);
  if (!got.ok) return { ok: false, why: "settlement lookup failed" };
  const s = got.data?.[0];
  if (!s) {
    await notifyOperatorOnce(`payg_reversal_nosettlement:${ev.ref}`, "A refund or dispute of a pay-as-you-go invoice has no settlement record", `Stripe invoice ${invoiceId} (object ${ev.ref}) carries payg_settlement metadata but no usage_settlements row matches it. Nothing was changed.`);
    return { ok: true };
  }
  const mismatch = Boolean(s.stripe_invoice_id && s.stripe_invoice_id !== invoiceId);

  // 1. The record. Once per refund amount / per dispute and status; a redelivery finds it and goes on to the (idempotent) decision below.
  const key = ev.kind === "refund" ? `refund:${ev.ref}:${ev.refundedCents}` : `dispute:${ev.ref}:${ev.status}`;
  const ins = await pg<{ id: string }[]>(
    "POST",
    "payg_settlement_reversals?on_conflict=dedupe_key",
    {
      dedupe_key: key,
      settlement_id: s.id,
      account,
      month,
      kind: ev.kind,
      stripe_object_id: ev.ref,
      stripe_invoice_id: invoiceId,
      stripe_event_id: p.eventId,
      amount_cents: ev.kind === "refund" ? ev.refundedCents : ev.amountCents,
      state: ev.kind === "refund" ? (ev.full ? "full" : "partial") : ev.status,
      detail: ev.kind === "refund" ? { charge_cents: ev.chargeCents, settlement_cents: s.amount_cents, invoice_mismatch: mismatch } : { invoice_mismatch: mismatch },
    },
    "resolution=ignore-duplicates,return=representation"
  );
  const missingTable = tableMissing(ins);
  if (!ins.ok && !missingTable) return { ok: false, why: "settlement reversal could not be recorded" };
  const recordedNow = ins.ok && (ins.data?.length ?? 0) > 0;

  // 2. The decision.
  const wantsHold = !mismatch && (ev.kind === "refund" ? ev.full : HOLDS_ACCESS.includes(ev.state));
  const wantsLift = !mismatch && ev.kind === "dispute" && LIFTS_DISPUTE_HOLD.includes(ev.state);
  let outcome = ev.kind === "refund" && !ev.full ? "recorded the partial refund; access is unchanged." : "recorded it; access is unchanged.";
  if (wantsHold || wantsLift) {
    const acct = await accountByName(account);
    if (acct === "error") return { ok: false, why: "account lookup failed" };
    if (!acct || acct.plan !== "api_payg" || acct.status === "cancelled") {
      outcome = "recorded it; the account is not an active pay-as-you-go account, so there is no access to suspend or restore.";
    } else if (wantsHold && !(await mayApplyHold(ev.ref, key, recordedNow))) {
      outcome = "recorded it; an operator RELEASED this hold after this state was first recorded, so the redelivery did not re-apply it.";
    } else if (wantsHold) {
      const later = await pg<{ id: string }[]>("GET", `usage_settlements?account=eq.${enc(account)}&month=gt.${enc(month)}&status=eq.paid&select=id&limit=1`);
      if (!later.ok) return { ok: false, why: "later settlements could not be read" };
      if ((later.data?.length ?? 0) > 0) {
        // The customer has paid a later month since: this one is history, as an old subscription invoice is (lib/billing-holds.ts reversePayment).
        const a = await recordBillingAudit({
          dedupeKey: `settlement_hold_skipped_later_paid:${ev.kind}:${ev.ref}:${acct.id}`,
          table: "api_accounts",
          subjectId: acct.id,
          action: "hold_skipped_later_settlement_paid",
          eventId: p.eventId,
          objectId: ev.ref,
          invoiceId,
          detail: { kind: holdKindOf(ev), month },
        });
        if (a === "error") return { ok: false, why: "settlement decision could not be recorded" };
        outcome = "recorded it; a LATER settlement of this account has been paid, so the reversed month is history and the account was not suspended.";
      } else {
        const out = await applyHold({ api: acct, watch: null, intelligence: null }, { kind: holdKindOf(ev), ref: ev.ref, invoiceId, subscriptionId: "", eventId: p.eventId, created: p.created, noPaymentClock: true });
        if (!out.ok) return { ok: false, why: `${holdKindOf(ev)} hold could not be applied` };
        outcome = "SUSPENDED further pay-as-you-go use (live key revoked and minting refused; reversible, nothing deleted).";
      }
    } else {
      const lifted = await liftHold({ api: acct, watch: null, intelligence: null }, { kinds: ["disputed"], ref: ev.ref, restore: "prev", cause: "dispute_won", clock: "none", subscriptionId: "", eventId: p.eventId });
      if (!lifted.ok) return { ok: false, why: "dispute hold could not be lifted" };
      // A failed settlement of another month still suspends the account.
      const re = await reconcileAccount(account);
      if (!re.ok) return re;
      outcome = lifted.lifted.api ? "LIFTED the hold this dispute caused (the revoked key stays revoked; the customer mints a new one)." : "recorded it; this dispute held nothing.";
    }
  }

  // The operator hears of it whether or not the record could be written (it is the only trace there is until the table exists).
  await operatorNotice(ev, s, key, missingTable ? `${outcome} (NOT RECORDED: payg_settlement_reversals does not exist, migration 0043 is not applied.)` : outcome, mismatch);
  if (missingTable) {
    await notifyOperatorOnce("migration_0043_reversals_missing", "Migration 0043 (settlement reversals) is not applied", `A refund or dispute of a pay-as-you-go settlement could not be recorded because payg_settlement_reversals does not exist. Any access decision was applied. An event that took an access decision is answered with a failure so Stripe redelivers it and the record is written once the migration is applied (supabase/migrations/0043_billing_pause_and_settlement_reversals.sql); one that needed none (a partial refund) is acknowledged, and the operator mail above is its only record. This notice is sent once.`);
    if (wantsHold || wantsLift) return { ok: false, why: "payg_settlement_reversals is missing (migration 0043)" };
  }
  return { ok: true };
}

/**
 * False when an operator RELEASE of this hold (a release row naming the same charge or dispute) is newer than the record of the state being
 * applied: the redelivery of an event that was already recorded must not re-apply a hold a person lifted. A state recorded NOW (a new
 * dispute status, a first refund) is newer than any release, so it applies.
 */
async function mayApplyHold(ref: string, key: string, recordedNow: boolean): Promise<boolean> {
  if (recordedNow) return true;
  const rel = await pg<{ created_at: string }[]>("GET", `payg_settlement_reversals?kind=eq.release&stripe_object_id=eq.${enc(ref)}&select=created_at&order=created_at.desc&limit=1`);
  if (!rel.ok || !rel.data?.[0]) return true;
  const mine = await pg<{ created_at: string }[]>("GET", `payg_settlement_reversals?dedupe_key=eq.${enc(key)}&select=created_at&limit=1`);
  if (!mine.ok || !mine.data?.[0]) return true;
  return !(Date.parse(rel.data[0].created_at) > Date.parse(mine.data[0].created_at));
}

// ------------------------------------------------------------------------------------------------- the refund event itself

/** A refund (or dispute) amount as a non-negative integer number of cents. */
export const cents = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.trunc(v), 2_000_000_000) : 0);

// ------------------------------------------------------------------------------------------------------ what the customer sees

export interface ReversalView {
  /** The most Stripe reports refunded of this settlement's charge(s), in cents. */
  refundedCents: number;
  refundState: "partial" | "full" | null;
  /** open: money is debited and the dispute stands; lost; won. Early-warning inquiries move no money and show nothing. */
  dispute: "open" | "lost" | "won" | null;
}

/**
 * The refunds and disputes recorded against an account's settlements, by month. `null`: the store could not be read (the caller says
 * so; it never reads that as "nothing was refunded"). A store without migration 0043 has none: an empty map.
 */
export async function reversalViews(account: string): Promise<Map<string, ReversalView> | null> {
  const r = await pg<{ month: string; kind: string; state: string; amount_cents: number; stripe_object_id: string | null; created_at: string }[]>(
    "GET",
    `payg_settlement_reversals?account=eq.${enc(account)}&kind=in.(refund,dispute)&select=month,kind,state,amount_cents,stripe_object_id,created_at&order=created_at.asc&limit=500`
  );
  if (tableMissing(r)) return new Map();
  if (!r.ok) return null;
  const refunds = new Map<string, Map<string, { cents: number; full: boolean }>>();
  const disputes = new Map<string, Map<string, DisputeState>>();
  for (const row of r.data ?? []) {
    const obj = row.stripe_object_id ?? "";
    if (row.kind === "refund") {
      const byCharge = refunds.get(row.month) ?? new Map();
      const cur = byCharge.get(obj) ?? { cents: 0, full: false };
      byCharge.set(obj, { cents: Math.max(cur.cents, Number(row.amount_cents) || 0), full: cur.full || row.state === "full" });
      refunds.set(row.month, byCharge);
    } else {
      const byDispute = disputes.get(row.month) ?? new Map();
      byDispute.set(obj, classifyDispute(row.state)); // ascending order: the newest state of each dispute wins
      disputes.set(row.month, byDispute);
    }
  }
  const out = new Map<string, ReversalView>();
  for (const month of new Set([...refunds.keys(), ...disputes.keys()])) {
    const rf = [...(refunds.get(month)?.values() ?? [])];
    const states = [...(disputes.get(month)?.values() ?? [])];
    out.set(month, {
      refundedCents: rf.reduce((n, x) => n + x.cents, 0),
      refundState: rf.length === 0 ? null : rf.some((x) => x.full) ? "full" : "partial",
      dispute: states.includes("open") ? "open" : states.includes("lost") ? "lost" : states.some((x) => x === "won" || x === "resolved") ? "won" : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ the daily pass

export interface ReversalReport {
  /** Pay-as-you-go accounts currently on a refund or dispute hold: each needs a person's decision (or a won dispute, or a paid later settlement). */
  heldAccounts: { account_ref: string; hold: string; since: string | null }[];
  releasesApplied: number;
  errors: number;
  skipped?: string;
}

/** Operator releases (append-only rows naming a hold's own charge or dispute id) become lifts, once; then the accounts still held are listed. Never throws. */
export async function runSettlementReversalPass(): Promise<ReversalReport> {
  const report: ReversalReport = { heldAccounts: [], releasesApplied: 0, errors: 0 };
  const rel = await pg<{ id: string; account: string; stripe_object_id: string | null; created_at: string }[]>("GET", "payg_settlement_reversals?kind=eq.release&select=id,account,stripe_object_id,created_at&order=created_at.desc&limit=100");
  if (tableMissing(rel)) {
    report.skipped = "migration 0043 not applied (no payg_settlement_reversals)";
    return report;
  }
  if (!rel.ok) {
    report.errors++;
  } else {
    for (const row of rel.data ?? []) {
      const acct = await accountByName(row.account);
      if (acct === "error") {
        report.errors++;
        continue;
      }
      if (!acct || !acct.billing_hold || acct.billing_hold === "paused" || !row.stripe_object_id || acct.billing_hold_ref !== row.stripe_object_id) continue;
      // A release is a decision about the hold AS IT STOOD when it was made. It never lifts a hold that began after it, nor one whose state
      // changed after it (a dispute released while open that is then LOST): both need a release of their own.
      const releasedAt = Date.parse(row.created_at);
      const heldAt = acct.billing_hold_at ? Date.parse(acct.billing_hold_at) : NaN;
      if (Number.isFinite(heldAt) && releasedAt < heldAt) continue;
      const newest = await pg<{ created_at: string }[]>("GET", `payg_settlement_reversals?stripe_object_id=eq.${enc(row.stripe_object_id)}&kind=in.(refund,dispute)&select=created_at&order=created_at.desc&limit=1`);
      if (!newest.ok) {
        report.errors++;
        continue;
      }
      if (newest.data?.[0] && Date.parse(newest.data[0].created_at) >= releasedAt) continue;
      const lifted = await liftHold({ api: acct, watch: null, intelligence: null }, { kinds: ["refunded", "disputed"], ref: row.stripe_object_id, restore: "prev", cause: "operator_release", clock: "none", subscriptionId: "", eventId: `release:${row.id}` });
      if (!lifted.ok) {
        report.errors++;
        continue;
      }
      if (lifted.lifted.api) report.releasesApplied++;
      const re = await reconcileAccount(row.account);
      if (!re.ok) report.errors++;
    }
  }
  const held = await pg<{ account: string; billing_hold: string; billing_hold_at: string | null }[]>("GET", "api_accounts?plan=eq.api_payg&billing_hold=in.(refunded,disputed)&select=account,billing_hold,billing_hold_at&order=billing_hold_at.asc&limit=200");
  if (!held.ok) {
    if (held.status !== 400) report.errors++;
    return report;
  }
  report.heldAccounts = (held.data ?? []).map((a) => ({ account_ref: accountRef(a.account), hold: a.billing_hold, since: a.billing_hold_at }));
  return report;
}
