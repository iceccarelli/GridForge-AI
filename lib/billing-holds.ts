// Server-only: suspending paid access without cancelling it, and getting it back.
//
// Four things take a customer's PAID access away while the Stripe subscription itself goes on:
//
//   refunded   a charge for the subscription's invoice was refunded IN FULL (charge.refunded). A partial refund suspends nothing.
//   disputed   a chargeback is open on such a charge (charge.dispute.created, an actual dispute, not a warning inquiry).
//   paused     Stripe's pause_collection is set, or the subscription's status is paused (customer.subscription.updated).
//   grace      an API plan has been past_due for API_PAST_DUE_GRACE_DAYS: the already-minted key is revoked (the daily job, or the next
//              failure event). That one is not a hold: the account stays past_due and a payment that clears reopens minting.
//
// What "suspended" means for each thing a subscription can entitle (resolved from the subscription id, all three, as the rest of the
// webhook does):
//
//   API plan (api_accounts)       status past_due, the live key and any overlap key revoked and cleared (suspendApiKeys: the account
//                                 records the revocation FIRST; the engine is told after; only an engine 2xx confirms it), no minting.
//   Hall Watch (watches)          status paused: dueWatches() lists only active watches, and a note already queued is abandoned.
//   Intelligence (subscriptions)  status suspended: the entitlement check lists only active and past_due, so it entitles nothing.
//
// Nothing is deleted. The hold is recorded on the row (billing_hold, billing_hold_ref, billing_hold_invoice, billing_hold_prev_status,
// migration 0041) and every decision is written to the append-only billing_audit table, once per Stripe event and subject.
//
// Reversal. A hold of kind refunded or disputed is lifted by a LATER verified invoice.paid for a DIFFERENT invoice than the one whose
// payment was reversed (the customer paid again). A disputed hold is lifted by charge.dispute.closed with status won (back to what the row
// was before). A paused hold is lifted by the subscription update that clears the pause. A cancelled row never gets a hold and never
// comes back by itself: re-subscribing is a new sale.
//
// Ordering. Stripe does not deliver events in order, so every state change here obeys the same clock as the invoice events
// (last_billing_event_ts, migration 0039): an event older than the newest one applied is stale and changes nothing, and redelivery of an
// event whose effect is already recorded is a no-op that still re-checks the audit row. Every write is an absolute state.
//
// Pause. Stripe's pause_collection stops FUTURE invoices only, so a customer who pauses mid-period has already paid for access up to the
// end of that period. A pause therefore does NOT start a hold at once: lib/billing-pause.ts records it as a scheduled pause (migration 0043:
// billing_pause_from = the end of the paid period) and the hold begins then, applied by the daily job, the Hall Watch cron and the access
// checks. A resume before that instant cancels the schedule (no interruption). Pause and resume events are ordered by a clock of their own
// (billing_pause_event_ts), not by last_billing_event_ts, which orders payments. Where no paid period can be established (status paused,
// no period on the subscription, a period already over, migration 0043 not applied) the hold is immediate, as before.
//
// Disputes. charge.dispute.created / updated / closed arrive in any order and are redelivered. lib/billing-disputes.ts asks Stripe for the
// dispute's CURRENT state before it applies or lifts anything, so a stale event can neither create a hold on a dispute already won nor
// leave one behind; the decision is keyed per dispute and state, never per delivery.
//
// Pay-as-you-go settlement invoices have no subscription: a refund or dispute of one is handled by lib/payg-refunds.ts, which reuses the
// same hold machinery (kind refunded / disputed on the api_accounts row, same lifts) and records an append-only event of its own.
//
// Deploy order: if migration 0041 has not been applied, an API plan or a Hall Watch is still suspended (as a status only: it is reinstated
// by a later payment for a different invoice, not by a dispute won, and it is not audited) and the operator is told once. An Intelligence
// subscription is NOT suspended without the hold columns (nothing could ever say why, or lift it): the event is answered 500 and Stripe
// retries until the migration is applied.

import type Stripe from "stripe";
import {
  API_PAST_DUE_GRACE_MS,
  graceElapsed,
  lookupBySubscription,
  suspendApiKeys,
  updateApiAccount,
  updateApiAccountUnlessCancelled,
  type ApiAccount,
} from "@/lib/api-access";
import { isApiProduct } from "@/lib/products";
import { accountRef } from "@/lib/payg";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import { enc, pg } from "@/lib/payg-store";
import { lookupSubscriptionByStripeId, type SubscriptionRecord } from "@/lib/subscribers";
import { lookupWatchBySubscription, updateWatchUnlessCancelled, abandonPendingNotices, type WatchRecord } from "@/lib/watches";

export type HoldKind = "refunded" | "disputed" | "paused";

/** A stronger hold is never replaced by a weaker one arriving later: a refund outranks a dispute, a dispute outranks a pause. */
const RANK: Record<HoldKind, number> = { paused: 1, disputed: 2, refunded: 3 };

/** The hold columns (migration 0041) as the three tables carry them; `select=*` returns them once the migration is applied. */
export interface HoldFields {
  billing_hold?: HoldKind | null;
  billing_hold_ref?: string | null;
  billing_hold_invoice?: string | null;
  billing_hold_at?: string | null;
  billing_hold_prev_status?: string | null;
  last_billing_event_ts?: number | null;
  /** Scheduled pause (migration 0043): see lib/billing-pause.ts. */
  billing_pause_from?: string | null;
  billing_pause_resumes_at?: string | null;
  billing_pause_event_ts?: number | null;
}
/** Intelligence rows also take the status "suspended" (SubscriptionStatus, lib/subscribers.ts, predates holds). */
export type IntelligenceRow = Omit<SubscriptionRecord, "status"> & HoldFields & { status: SubscriptionRecord["status"] | "suspended" };

export type Entitlements = { api: ApiAccount | null; watch: WatchRecord | null; intelligence: IntelligenceRow | null };
export type Resolved = ({ ok: true } & Entitlements) | { ok: false };

/** Every table a Stripe subscription can entitle, read in one go; `ok: false` means a read failed. */
export async function resolveSubscription(subId: string): Promise<Resolved> {
  const [api, watch, intelligence] = await Promise.all([
    lookupBySubscription(subId),
    lookupWatchBySubscription(subId),
    lookupSubscriptionByStripeId(subId),
  ]);
  if (!api.ok || !watch.ok || !intelligence.ok) return { ok: false };
  return { ok: true, api: api.row, watch: watch.row, intelligence: intelligence.row as IntelligenceRow | null };
}

/** A cancelled entitlement is over: no invoice event reopens it or moves its clock (re-subscribing is a new sale). */
export function endedRow(row: { status: string }): boolean {
  return row.status === "cancelled";
}

/**
 * Stripe does not deliver events in order. Each billing event for a subscription (an API account, a Hall Watch, an Intelligence
 * subscription: all three carry the clock since migration 0039) records its `created` time when applied; an event OLDER than the newest
 * one already applied is stale and changes nothing. At the same second a payment that cleared wins over a failure (the failure is the
 * one that was retried into success). An event with no time cannot be ordered and is applied, as before.
 */
export function billingEventIsCurrent(row: { last_billing_event_ts?: number | null }, created: number | undefined, kind: "failed" | "paid"): boolean {
  if (typeof created !== "number") return true;
  const last = row.last_billing_event_ts;
  if (typeof last !== "number") return true;
  return kind === "paid" ? created >= last : created > last;
}

/**
 * Absolute-state write that also records the event's time. If the store refuses the clock column (migration 0039 not applied yet) the
 * state is written without it, as before the clock existed: a payment event is never refused for want of bookkeeping.
 */
export async function clockedWrite<P extends object>(write: (patch: P & { last_billing_event_ts?: number }) => Promise<boolean>, patch: P, created: number | undefined): Promise<boolean> {
  const stateless = Object.keys(patch).length === 0;
  if (typeof created !== "number") return stateless ? true : write(patch);
  if (await write({ ...patch, last_billing_event_ts: created })) return true;
  // A write that only advances the clock has nothing to fall back to: the state is already what it should be.
  return stateless ? true : write(patch);
}

type Written = "ok" | "terminal" | "error";

/**
 * Try each patch in turn (richest first) until the store accepts one: the richer ones name columns a missing migration lacks.
 * "terminal": the row is cancelled or superseded and was deliberately not written (a hold or a lift must never revive or demote it).
 */
async function firstAccepted(write: (patch: Record<string, unknown>) => Promise<Written>, variants: Record<string, unknown>[]): Promise<Written> {
  for (const v of variants) {
    const w = await write(v);
    if (w !== "error") return w;
  }
  return "error";
}

/** A subscription this site sells: its checkout stamped the subscription with one of these kinds. */
export function isOurSubscriptionKind(kind: unknown): boolean {
  return typeof kind === "string" && (isApiProduct(kind) || kind === "hall_watch" || kind === "intelligence_subscription");
}

/**
 * Write an Intelligence row only while it is neither cancelled nor superseded (a conditional update on the status): a billing event that
 * races a cancellation or a newer purchase can never turn that terminal state back into suspended or active. "conflict": the write would
 * leave two active rows for one email (the partial unique index refused it).
 */
export async function updateIntelligenceUnlessEnded(id: string, patch: Record<string, unknown>): Promise<Written | "conflict"> {
  const r = await pg<unknown[]>("PATCH", `subscriptions?id=eq.${enc(id)}&status=not.in.(cancelled,superseded)`, { ...patch, updated_at: new Date().toISOString() });
  if (!r.ok) return r.status === 409 ? "conflict" : "error";
  return (r.data?.length ?? 0) > 0 ? "ok" : "terminal";
}

/** The guarded writers the billing events use for every state change (true = written, or the row is terminal and nothing was owed). */
export const writeApi = async (token: string, p: Partial<ApiAccount>): Promise<boolean> => (await updateApiAccountUnlessCancelled(token, p)) !== "error";
export const writeWatch = async (token: string, p: Partial<WatchRecord>): Promise<boolean> => (await updateWatchUnlessCancelled(token, p)) !== "error";
export const writeIntelligence = async (id: string, p: Record<string, unknown>): Promise<boolean> => {
  const w = await updateIntelligenceUnlessEnded(id, p);
  return w !== "error" && w !== "conflict";
};

/**
 * The subscription id on an invoice.
 *
 * Stripe moved this off the top level of Invoice in a recent API version, and the
 * typings follow the newest one. Read it structurally so the handler works whether
 * the account is pinned to an older version or the current one — a webhook that
 * throws on an unexpected shape silently stops renewing everybody's keys.
 */
export function subscriptionIdOf(inv: Stripe.Invoice): string {
  const raw = inv as unknown as {
    subscription?: string | { id?: string };
    parent?: { subscription_details?: { subscription?: string | { id?: string } } };
  };
  const candidate = raw.subscription ?? raw.parent?.subscription_details?.subscription;
  if (typeof candidate === "string") return candidate;
  return candidate?.id ?? "";
}

// ------------------------------------------------------------------------------------------------------ audit trail

export interface AuditEntry {
  /** Once-only key: a redelivered event records nothing twice. */
  dedupeKey: string;
  table: "api_accounts" | "watches" | "subscriptions" | "stripe_disputes";
  subjectId: string;
  action: string;
  eventId?: string;
  objectId?: string;
  invoiceId?: string | null;
  subscriptionId?: string;
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * Append one decision to billing_audit. "duplicate": already there (a redelivery). "unavailable": the table does not exist yet
 * (migration 0041), reported to the operator once and NOT a reason to refuse the event. "error": the store failed; the caller retries.
 */
export async function recordBillingAudit(e: AuditEntry): Promise<"recorded" | "duplicate" | "unavailable" | "error"> {
  const r = await pg<{ id: string }[]>(
    "POST",
    "billing_audit?on_conflict=dedupe_key",
    {
      dedupe_key: e.dedupeKey,
      subject_table: e.table,
      subject_id: e.subjectId,
      action: e.action,
      stripe_event_id: e.eventId ?? null,
      stripe_object_id: e.objectId ?? null,
      stripe_invoice_id: e.invoiceId ?? null,
      stripe_subscription_id: e.subscriptionId || null,
      detail: e.detail ?? {},
    },
    "resolution=ignore-duplicates,return=representation"
  );
  if (r.ok) return (r.data?.length ?? 0) > 0 ? "recorded" : "duplicate";
  if (r.status === 404 || r.code === "PGRST205" || r.code === "42P01") {
    await notifyOperatorOnce(
      "migration_0041_missing",
      "Migration 0041 (billing holds and audit trail) is not applied",
      "A billing decision about a customer's access could not be written to billing_audit because the table does not exist. The decision itself WAS applied " +
        "(as a status change), but it is not audited and a refund, dispute or pause cannot be reversed individually until supabase/migrations/0041_billing_holds.sql is applied. " +
        "This notice is sent once."
    );
    return "unavailable";
  }
  return "error";
}

// ---------------------------------------------------------------------------------------- unconfirmed engine revocations

/**
 * A key id the site has recorded as revoked and the ENGINE has not confirmed: the key still verifies there until it expires. The account
 * row already carries the obligation (revoked_key_ids minus revoked_confirmed_ids is revocation_pending, pushed again by the daily job
 * and by the next billing event for the account); this makes it VISIBLE: one audit row and one operator mail per account and set of ids.
 * Says plainly that the key is not known to be dead.
 */
export async function noteUnconfirmedRevocation(row: Pick<ApiAccount, "id" | "account">, unconfirmed: { id: string; reason: string }[], why: string, eventId?: string): Promise<void> {
  if (unconfirmed.length === 0) return;
  const ids = unconfirmed.map((u) => u.id).sort();
  const reasons = [...new Set(unconfirmed.map((u) => u.reason))].sort();
  await recordBillingAudit({
    dedupeKey: `revoke_unconfirmed:${row.id}:${ids.join(",")}`,
    table: "api_accounts",
    subjectId: row.id,
    action: "revocation_unconfirmed",
    eventId,
    detail: { why, key_ids: ids.length, reasons: reasons.join(",") },
  });
  await notifyOperatorOnce(
    `revoke_unconfirmed:${row.id}:${ids.join(",")}`,
    `API key NOT confirmed revoked by the engine — account ${accountRef(row.account)} (${why})`,
    `The site has recorded ${ids.length} key id(s) as revoked for account reference ${accountRef(row.account)} (${why}) and the account can no longer mint, ` +
      `but the ENGINE did not confirm the revocation (${reasons.join(", ")}), so those keys still verify there until they expire (up to 35 days from minting).\n\n` +
      `Key id(s): ${ids.join(", ")}.\n\n` +
      (reasons.includes("not_deployed")
        ? "The engine answered 404 for /v1/revoke: the deployed engine is older than this repository. Redeploy it (scripts/check-engine-drift.py shows the difference); until then every revocation stays pending.\n\n"
        : "Check GRIDFORGE_API_URL / GRIDFORGE_ADMIN_KEY and the engine's /data volume (GET /v1/version as operator: revocation_persistable).\n\n") +
      "The revocation is a durable obligation: the daily job (/api/cron/payg) and the next billing event for this account push it again, and " +
      "/api/admin/stripe-health lists the backlog. This notice is sent once per account and set of ids."
  );
}

// ---------------------------------------------------------------------------------- charge -> invoice -> subscription

/** The slice of the Stripe client the reversal handlers read: injectable, so tests never touch a live service. */
export interface ReversalStripe {
  charges: { retrieve(id: string): Promise<unknown> };
  /** The dispute as Stripe holds it NOW: every dispute event is reconciled against this (lib/billing-disputes.ts). */
  disputes?: { retrieve(id: string): Promise<unknown> };
  invoices: { retrieve(id: string): Promise<unknown> };
  subscriptions?: { retrieve(id: string): Promise<unknown> };
  invoicePayments?: { list(params: Record<string, unknown>): Promise<{ data: { invoice?: unknown }[] }> };
}

export const idOf = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : "");

/** `invoiceMeta`: the metadata Stripe holds on the invoice (a pay-as-you-go settlement invoice names itself there). */
export type PaymentOwner = { ok: true; subscriptionId: string | null; invoiceId: string | null; invoiceMeta?: Record<string, string> | null } | { ok: false };

const metaOf = (v: unknown): Record<string, string> | null => {
  const m = v && typeof v === "object" ? (v as { metadata?: unknown }).metadata : null;
  if (!m || typeof m !== "object") return null;
  return Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>;
};

/**
 * Which subscription (if any) a payment belongs to. Newer Stripe API versions removed `invoice` from Charge, so it is read from the
 * charge when present and otherwise through the payment intent's InvoicePayment; the invoice's subscription is read from the invoice
 * object when it came expanded and retrieved otherwise. A charge that belongs to no invoice (an engagement deposit) is `{ subscriptionId: null }`:
 * not an error and nothing to suspend. A Stripe call that fails is `{ ok: false }`: the caller answers 500 and Stripe redelivers.
 */
export async function subscriptionOfPayment(stripe: ReversalStripe | null, p: { invoice?: unknown; paymentIntent?: unknown }): Promise<PaymentOwner> {
  let invoice: unknown = p.invoice;
  let invoiceId = idOf(invoice);
  const pi = idOf(p.paymentIntent);
  try {
    if (!invoiceId && pi) {
      if (!stripe?.invoicePayments) {
        console.error("[GridForge] cannot resolve a charge to its invoice: no Stripe client with invoicePayments");
        return { ok: false };
      }
      const list = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1, expand: ["data.invoice"] });
      invoice = list.data?.[0]?.invoice;
      invoiceId = idOf(invoice);
    }
    if (!invoiceId) return { ok: true, subscriptionId: null, invoiceId: null, invoiceMeta: null };
    let subscriptionId = invoice && typeof invoice === "object" ? subscriptionIdOf(invoice as Stripe.Invoice) : "";
    let invoiceMeta = metaOf(invoice);
    if (!subscriptionId) {
      if (!stripe) return { ok: false };
      const full = await stripe.invoices.retrieve(invoiceId);
      subscriptionId = subscriptionIdOf(full as Stripe.Invoice);
      invoiceMeta = metaOf(full) ?? invoiceMeta;
    }
    return { ok: true, subscriptionId: subscriptionId || null, invoiceId, invoiceMeta };
  } catch (err) {
    // An invoice or payment Stripe says does not exist can never be resolved by a redelivery: nothing of ours to suspend.
    if ((err as { code?: string } | null)?.code === "resource_missing") return { ok: true, subscriptionId: null, invoiceId: invoiceId || null };
    console.error("[GridForge] could not resolve a payment to its subscription:", (err as { type?: string; code?: string })?.type ?? "stripe_error");
    return { ok: false };
  }
}

// ------------------------------------------------------------------------------------------------------------- holds

export interface HoldRequest {
  kind: HoldKind;
  /** The Stripe object that caused it: charge id (refunded), dispute id (disputed), subscription id (paused). */
  ref: string;
  /** The invoice whose payment was reversed; null for a pause. */
  invoiceId: string | null;
  subscriptionId: string;
  eventId: string;
  created?: number;
  /**
   * The hold is ordered by a clock of its own (a pause: billing_pause_event_ts, written by lib/billing-pause.ts) or by none (a pause that
   * came due, a settlement refund), so it neither consults nor advances last_billing_event_ts, which orders PAYMENT events.
   */
  noPaymentClock?: boolean;
  /** When the hold takes effect, if that is not now (a scheduled pause that has come due): recorded as billing_hold_at. */
  effectiveFrom?: string;
}

type Outcome = "applied" | "already" | "stale" | "skipped" | "failed";

const nowIso = () => new Date().toISOString();

function holdColumns(h: HoldRequest, prev: string): Record<string, unknown> {
  return { billing_hold: h.kind, billing_hold_ref: h.ref, billing_hold_invoice: h.invoiceId, billing_hold_at: h.effectiveFrom ?? nowIso(), billing_hold_prev_status: prev };
}

/** The payment clock a hold consults and advances: none for a hold with a clock of its own (see HoldRequest.noPaymentClock). */
const holdIsCurrent = (row: { last_billing_event_ts?: number | null }, h: HoldRequest): boolean => h.noPaymentClock || billingEventIsCurrent(row, h.created, "failed");
const holdClock = (h: HoldRequest): { last_billing_event_ts?: number } => (!h.noPaymentClock && typeof h.created === "number" ? { last_billing_event_ts: h.created } : {});
const clearedHold = { billing_hold: null, billing_hold_ref: null, billing_hold_invoice: null, billing_hold_at: null, billing_hold_prev_status: null };

async function audit(entry: AuditEntry): Promise<boolean> {
  return (await recordBillingAudit(entry)) !== "error";
}

async function holdApi(api: ApiAccount, h: HoldRequest): Promise<Outcome> {
  if (endedRow(api)) return "skipped";
  if (api.billing_hold === h.kind && api.billing_hold_ref === h.ref) return "already";
  if (api.billing_hold && RANK[api.billing_hold] >= RANK[h.kind]) return "skipped";
  if (!holdIsCurrent(api, h)) return "stale";
  const prev = api.billing_hold ? api.billing_hold_prev_status ?? "active" : api.status;
  const clock = holdClock(h);
  const status = { status: "past_due" as const };
  // Richest first. The bare variants exist so that access is still cut off before migration 0041 is applied: such a row is past_due with
  // no hold, and a LATER payment for a different invoice (newer than the clock it carries) reinstates it like any past_due account.
  const variants: Record<string, unknown>[] = [
    { ...status, ...holdColumns(h, prev), ...clock },
    { ...status, ...holdColumns(h, prev) },
    { ...status, ...clock },
    { ...status },
  ];
  let out: Awaited<ReturnType<typeof suspendApiKeys>> = { ok: false };
  for (const v of variants) {
    out = await suspendApiKeys(api, v as Partial<ApiAccount>);
    if (out.ok || out.terminal) break;
  }
  if (!out.ok) return out.terminal ? "skipped" : "failed";
  if (out.unconfirmed.length) await noteUnconfirmedRevocation(api, out.unconfirmed, `${h.kind} subscription payment`, h.eventId);
  return "applied";
}

async function holdWatch(w: WatchRecord, h: HoldRequest): Promise<Outcome> {
  if (endedRow(w)) return "skipped";
  if (w.billing_hold === h.kind && w.billing_hold_ref === h.ref) return "already";
  if (w.billing_hold && RANK[w.billing_hold] >= RANK[h.kind]) return "skipped";
  if (!holdIsCurrent(w, h)) return "stale";
  const prev = w.billing_hold ? w.billing_hold_prev_status ?? "active" : w.status;
  const clock = holdClock(h);
  const done = await firstAccepted((p) => updateWatchUnlessCancelled(w.token, p as Partial<WatchRecord>), [
    { status: "paused", ...holdColumns(h, prev), ...clock },
    { status: "paused", ...holdColumns(h, prev) },
    { status: "paused", ...clock },
    { status: "paused" },
  ]);
  if (done === "error") return "failed";
  if (done === "terminal") return "skipped"; // cancelled in the meantime: it stays cancelled
  // No further paid delivery: a change note already queued for an email is not sent while the hold stands.
  await abandonPendingNotices(w.id, "watch_not_active");
  return "applied";
}

async function holdIntelligence(s: IntelligenceRow, h: HoldRequest): Promise<Outcome> {
  if (s.status !== "active" && s.status !== "past_due" && s.status !== "suspended") return "skipped";
  if (s.billing_hold === h.kind && s.billing_hold_ref === h.ref) return "already";
  if (s.billing_hold && RANK[s.billing_hold] >= RANK[h.kind]) return "skipped";
  if (!holdIsCurrent(s, h)) return "stale";
  const prev = s.billing_hold ? s.billing_hold_prev_status ?? "active" : s.status;
  const clock = holdClock(h);
  // NO bare {status: "suspended"} variant: a suspended Intelligence row without its hold columns could never be lifted (nothing would say
  // why it was suspended), and the entitlement is a paid, seat-bearing plan. Until migration 0041 is applied the event is answered 500 and
  // Stripe retries, so it applies the moment the columns exist. (The clock column is older, 0039, so that variant may fall back.)
  const done = await firstAccepted((p) => writeIntelligenceState(s.id, p), [
    { status: "suspended", ...holdColumns(h, prev), ...clock },
    { status: "suspended", ...holdColumns(h, prev) },
  ]);
  if (done === "error") return "failed";
  return done === "terminal" ? "skipped" : "applied";
}

async function writeIntelligenceState(id: string, p: Record<string, unknown>): Promise<Written> {
  const w = await updateIntelligenceUnlessEnded(id, p);
  return w === "conflict" ? "error" : w;
}

/**
 * Suspend everything this subscription entitles. `ok: false` means a write or the audit failed and the event must be retried (every
 * step is absolute, so the retry is safe: what already landed answers "already" and only its audit row is re-checked).
 */
export async function applyHold(found: Entitlements, h: HoldRequest): Promise<{ ok: boolean; applied: number }> {
  let ok = true;
  let applied = 0;
  const detail: Record<string, string | number | boolean | null> = { kind: h.kind, ...(h.effectiveFrom ? { effective_from: h.effectiveFrom } : {}) };
  const one = async (table: AuditEntry["table"], id: string, out: Outcome) => {
    if (out === "failed") ok = false;
    if (out === "applied") applied++;
    if (out === "applied" || out === "already") {
      // A pause's ref is the subscription itself, so repeated pause and resume cycles share it: the event id keeps every cycle on record
      // (a redelivery of the SAME event still records nothing twice). A refund's or dispute's ref is its own charge or dispute.
      const key = `hold_applied:${h.kind}:${h.ref}:${table}:${id}` + (h.kind === "paused" ? `:${h.eventId}` : "");
      if (!(await audit({ dedupeKey: key, table, subjectId: id, action: "hold_applied", eventId: h.eventId, objectId: h.ref, invoiceId: h.invoiceId, subscriptionId: h.subscriptionId, detail }))) ok = false;
    }
  };
  if (found.api) await one("api_accounts", found.api.id, await holdApi(found.api, h));
  if (found.watch) await one("watches", found.watch.id, await holdWatch(found.watch, h));
  if (found.intelligence) await one("subscriptions", found.intelligence.id, await holdIntelligence(found.intelligence, h));
  return { ok, applied };
}

// -------------------------------------------------------------------------------------------------------------- lifts

export interface LiftRequest {
  /** Only a hold of one of these kinds is lifted. */
  kinds: HoldKind[];
  /** If set, only a hold caused by this Stripe object (the dispute that was won). */
  ref?: string;
  /** If set, a hold whose reversed payment was THIS invoice is left alone: paying the same invoice again proves nothing new. */
  notInvoice?: string;
  /** For cause invoice_paid: the amount that invoice actually collected. A payment of zero (a credit, a trial) is not a payment. */
  paidCents?: number | null;
  /** "active": a new payment cleared, so the row is active. "prev": back to what it was before the hold. */
  restore: "active" | "prev";
  cause: "invoice_paid" | "dispute_won" | "billing_resumed" | "operator_release";
  subscriptionId: string;
  eventId: string;
  created?: number;
  /**
   * Which clock orders this lift against what was applied. "payment" (default): last_billing_event_ts, as for a payment that clears.
   * "pause": billing_pause_event_ts, the pause/resume clock. "none": the lift is a statement about a Stripe object whose CURRENT state was
   * just read (a dispute won, an operator's release), so no event time can make it stale; nothing is written to either clock.
   */
  clock?: "payment" | "pause" | "none";
}

export interface LiftResult {
  ok: boolean;
  lifted: { api: boolean; watch: boolean; intelligence: boolean };
}

/** Is a pause or resume event of time `created` at least as new as the newest one applied? (Equal: a redelivery or the same second; a resume wins ties.) */
export function pauseEventIsCurrent(row: { billing_pause_event_ts?: number | null }, created: number | undefined): boolean {
  if (typeof created !== "number") return true;
  const last = row.billing_pause_event_ts;
  return typeof last !== "number" || created >= last;
}

function liftable(row: { billing_hold?: HoldKind | null; billing_hold_ref?: string | null; billing_hold_invoice?: string | null; last_billing_event_ts?: number | null; billing_pause_event_ts?: number | null }, l: LiftRequest): boolean {
  if (!row.billing_hold || !l.kinds.includes(row.billing_hold)) return false;
  if (l.cause === "invoice_paid" && typeof l.paidCents === "number" && !(l.paidCents > 0)) return false;
  if (l.ref && row.billing_hold_ref !== l.ref) return false;
  if (l.notInvoice && row.billing_hold_invoice && row.billing_hold_invoice === l.notInvoice) return false;
  const clock = l.clock ?? "payment";
  if (clock === "none") return true;
  return clock === "pause" ? pauseEventIsCurrent(row, l.created) : billingEventIsCurrent(row, l.created, "paid");
}

const restoredStatus = (l: LiftRequest, prev: string | null | undefined, allowed: readonly string[]): string => (l.restore === "prev" && prev && allowed.includes(prev) ? prev : "active");

/** Lift the holds this event is allowed to lift. Rows with no such hold are untouched. */
export async function liftHold(found: Entitlements, l: LiftRequest): Promise<LiftResult> {
  const res: LiftResult = { ok: true, lifted: { api: false, watch: false, intelligence: false } };
  // Only a lift ordered by the payment clock advances it; a pause's own clock is advanced by lib/billing-pause.ts, a dispute's or an
  // operator's lift is ordered by none (a stale clock write must never move last_billing_event_ts backwards).
  const clock = (l.clock ?? "payment") === "payment" && typeof l.created === "number" ? { last_billing_event_ts: l.created } : {};
  const record = async (table: AuditEntry["table"], id: string, row: { billing_hold?: HoldKind | null; billing_hold_ref?: string | null; billing_hold_invoice?: string | null }, restored: string) => {
    const ok = await audit({
      // The event id is part of the key: a pause can be lifted again and again under the same ref (the subscription), and each lift is a
      // decision of its own; a redelivery of the same event still records nothing twice.
      dedupeKey: `hold_lifted:${row.billing_hold}:${row.billing_hold_ref}:${l.cause}:${table}:${id}:${l.eventId}`,
      table,
      subjectId: id,
      action: "hold_lifted",
      eventId: l.eventId,
      objectId: row.billing_hold_ref ?? undefined,
      invoiceId: row.billing_hold_invoice ?? null,
      subscriptionId: l.subscriptionId,
      detail: { kind: row.billing_hold ?? "", cause: l.cause, restored_status: restored },
    });
    if (!ok) res.ok = false;
  };

  const api = found.api;
  if (api && !endedRow(api) && liftable(api, l)) {
    const status = restoredStatus(l, api.billing_hold_prev_status, ["past_due"]);
    const since = status === "active" ? { past_due_since: null } : {};
    const done = await firstAccepted((p) => updateApiAccountUnlessCancelled(api.token, p as Partial<ApiAccount>), [
      { status, ...clearedHold, ...since, ...clock },
      { status, ...clearedHold, ...clock },
      { status, ...clock },
      { status },
    ]);
    if (done === "error") res.ok = false;
    else if (done === "ok") {
      res.lifted.api = true;
      // The revoked key stays revoked: the customer mints a fresh one, exactly as after a pay-as-you-go suspension.
      await record("api_accounts", api.id, api, status);
    }
  }
  const w = found.watch;
  if (w && !endedRow(w) && liftable(w, l)) {
    const status = restoredStatus(l, w.billing_hold_prev_status, ["paused"]);
    const done = await firstAccepted((p) => updateWatchUnlessCancelled(w.token, p as Partial<WatchRecord>), [
      { status, ...clearedHold, ...clock },
      { status, ...clock },
      { status },
    ]);
    if (done === "error") res.ok = false;
    else if (done === "ok") {
      res.lifted.watch = true;
      await record("watches", w.id, w, status);
    }
  }
  const s = found.intelligence;
  if (s && s.status !== "cancelled" && s.status !== "superseded" && liftable(s, l)) {
    let status = restoredStatus(l, s.billing_hold_prev_status, ["past_due"]);
    // The partial unique index allows one active row per email, and a newer purchase may have been recorded while this one was suspended
    // (recordSubscription now supersedes a suspended row too, but a purchase can also arrive from a different payer, or this lift can race
    // it). Restoring to an entitling status next to another entitling row would violate the index and Stripe would redeliver for ever:
    // the older row is superseded instead (it entitles nothing; the newer purchase stands).
    const others = await pg<{ id: string }[]>("GET", `subscriptions?email=eq.${enc(s.email)}&status=in.(active,past_due)&id=neq.${enc(s.id)}&select=id&limit=1`);
    if (!others.ok) res.ok = false;
    else {
      if ((others.data?.length ?? 0) > 0) status = "superseded";
      const done = await firstAccepted((p) => writeIntelligenceState(s.id, p), [
        { status, ...clearedHold, ...clock },
        { status, ...clearedHold },
      ]);
      if (done === "error") res.ok = false;
      else if (done === "ok") {
        res.lifted.intelligence = status !== "superseded";
        await record("subscriptions", s.id, s, status);
      }
    }
  }
  return res;
}

/**
 * Did THIS event already lift a hold (its hold_lifted audit row exists)? A retried event finds the hold gone, so "nothing to lift" alone
 * cannot tell a retry that must still finish its follow-up (re-checking a pause at Stripe) from an event that never lifted anything.
 */
export async function liftedByEvent(eventId: string): Promise<boolean> {
  const r = await pg<{ id: string }[]>("GET", `billing_audit?stripe_event_id=eq.${enc(eventId)}&action=eq.hold_lifted&select=id&limit=1`);
  return r.ok && (r.data?.length ?? 0) > 0;
}

// ------------------------------------------------------------------------------------------ charge and dispute events

/** `found`: the subscription's entitlements as they stood when the decision was taken, when there were any (callers audit against them). */
export type Handled = { ok: true; found?: Entitlements; subscriptionId?: string; invoiceId?: string | null } | { ok: false; why: string };

/** A charge refunded in full (partial refunds suspend nothing). */
export function isFullRefund(ch: { refunded?: boolean | null; amount?: number | null; amount_refunded?: number | null }): boolean {
  if (ch.refunded === true) return true;
  return typeof ch.amount === "number" && ch.amount > 0 && typeof ch.amount_refunded === "number" && ch.amount_refunded >= ch.amount;
}

/**
 * charge.refunded (full) and charge.dispute.created: find the subscription the payment belonged to and suspend what it entitles.
 * A payment that is not a subscription invoice (an engagement deposit) changes nothing here. `ok: false` = retry the event.
 */
export async function reversePayment(p: {
  kind: "refunded" | "disputed";
  ref: string;
  invoice?: unknown;
  paymentIntent?: unknown;
  stripe: ReversalStripe | null;
  eventId: string;
  created?: number;
  /** The payment already resolved to its owner (so Stripe is not asked twice for one event). */
  owner?: PaymentOwner;
}): Promise<Handled> {
  const owner = p.owner ?? (await subscriptionOfPayment(p.stripe, { invoice: p.invoice, paymentIntent: p.paymentIntent }));
  if (!owner.ok) return { ok: false, why: "payment could not be resolved to its subscription" };
  if (!owner.subscriptionId) return { ok: true };
  const found = await resolveSubscription(owner.subscriptionId);
  if (!found.ok) return { ok: false, why: "subscription lookup failed" };
  const subscription = await readSubscription(p.stripe, owner.subscriptionId);
  if (!subscription.ok) return { ok: false, why: "subscription could not be read from Stripe" };
  if (!found.api && !found.watch && !found.intelligence) {
    // A refund or dispute may beat its own checkout event (Stripe does not deliver in order): one of OUR subscriptions with no record yet
    // is retried like a cancellation that arrived early. Anything else is somebody else's subscription on the same Stripe account.
    if (isOurSubscriptionKind(subscription.kind)) return { ok: false, why: "no record of the subscription yet" };
    return { ok: true };
  }
  // Only a payment that is the subscription's LATEST paid invoice suspends it. A full refund or a dispute of an OLD invoice (a customer
  // refunded for a past month, a late chargeback) must not take away a current period the customer has paid for: it is recorded in the
  // audit trail and nothing else changes. latest_invoice is the newest invoice of any status; if that is some other invoice that actually
  // collected money, the reversed one is not the current period.
  if (owner.invoiceId && subscription.latestInvoiceId && subscription.latestInvoiceId !== owner.invoiceId) {
    const latest = await readInvoice(p.stripe, subscription.latestInvoiceId);
    if (!latest.ok) return { ok: false, why: "latest invoice could not be read from Stripe" };
    if (latest.status === "paid" && latest.amountPaid > 0) {
      let ok = true;
      const detail = { kind: p.kind, latest_invoice: subscription.latestInvoiceId };
      for (const [table, id] of [
        ...(found.api ? [["api_accounts", found.api.id] as const] : []),
        ...(found.watch ? [["watches", found.watch.id] as const] : []),
        ...(found.intelligence ? [["subscriptions", found.intelligence.id] as const] : []),
      ]) {
        if (!(await audit({ dedupeKey: `hold_skipped_stale:${p.kind}:${p.ref}:${table}:${id}`, table, subjectId: id, action: "hold_skipped_stale_invoice", eventId: p.eventId, objectId: p.ref, invoiceId: owner.invoiceId, subscriptionId: owner.subscriptionId, detail }))) ok = false;
      }
      return ok ? { ok: true, found, subscriptionId: owner.subscriptionId, invoiceId: owner.invoiceId } : { ok: false, why: "stale-invoice decision could not be recorded" };
    }
  }
  const out = await applyHold(found, { kind: p.kind, ref: p.ref, invoiceId: owner.invoiceId, subscriptionId: owner.subscriptionId, eventId: p.eventId, created: p.created });
  if (!out.ok) return { ok: false, why: `${p.kind} hold could not be applied` };
  // Re-read after the write: the caller audits against what the rows say NOW (a hold it just applied).
  const after = await resolveSubscription(owner.subscriptionId);
  return { ok: true, found: after.ok ? after : found, subscriptionId: owner.subscriptionId, invoiceId: owner.invoiceId };
}

export type SubscriptionRead = { ok: true; latestInvoiceId: string; kind: string } | { ok: false };

/** The subscription as Stripe holds it: its newest invoice and the kind our checkout stamped on it. A subscription Stripe no longer has reads as empty. */
async function readSubscription(stripe: ReversalStripe | null, id: string): Promise<SubscriptionRead> {
  if (!stripe?.subscriptions) {
    console.error("[GridForge] cannot read a subscription: no Stripe client with subscriptions");
    return { ok: false };
  }
  try {
    const sub = (await stripe.subscriptions.retrieve(id)) as { latest_invoice?: unknown; metadata?: { kind?: unknown } | null };
    return { ok: true, latestInvoiceId: idOf(sub.latest_invoice), kind: typeof sub.metadata?.kind === "string" ? sub.metadata.kind : "" };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "resource_missing") return { ok: true, latestInvoiceId: "", kind: "" };
    return { ok: false };
  }
}

type InvoiceRead = { ok: true; status: string; amountPaid: number } | { ok: false };

async function readInvoice(stripe: ReversalStripe | null, id: string): Promise<InvoiceRead> {
  if (!stripe) return { ok: false };
  try {
    const inv = (await stripe.invoices.retrieve(id)) as { status?: unknown; amount_paid?: unknown };
    return { ok: true, status: typeof inv.status === "string" ? inv.status : "", amountPaid: typeof inv.amount_paid === "number" ? inv.amount_paid : 0 };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "resource_missing") return { ok: true, status: "", amountPaid: 0 };
    return { ok: false };
  }
}

// ------------------------------------------------------------------------------------------------ past_due grace

export interface GraceReport {
  examined: number;
  /** past_due accounts with no start time yet: their grace starts now. */
  started: number;
  /** Accounts whose live key was revoked because the grace had run out. */
  revoked: number;
  /** Of those, how many revocations the engine did not confirm (they stay pending). */
  unconfirmed: number;
  errors: number;
  skipped?: string;
}

/**
 * One past_due subscription account: start its grace if it has none, or revoke its live key if the grace has run out. Idempotent: a
 * second call finds the key already cleared and does nothing. `ok: false` = a write failed.
 */
export async function enforceGraceRow(row: ApiAccount, nowMs: number, eventId?: string): Promise<{ ok: boolean; action: "none" | "started" | "revoked"; unconfirmed: number }> {
  if (row.status !== "past_due" || row.billing_hold) return { ok: true, action: "none", unconfirmed: 0 };
  if (row.plan === "api_payg" || row.plan === "api_free" || !row.stripe_subscription_id) return { ok: true, action: "none", unconfirmed: 0 };
  if (!row.past_due_since) {
    // A past_due row from before the start time was recorded: its grace begins when it is first seen, never earlier.
    const since = new Date(nowMs).toISOString();
    if (!(await updateApiAccount(row.token, { past_due_since: since }))) return { ok: false, action: "none", unconfirmed: 0 };
    const a = await audit({ dedupeKey: `grace_started:${row.id}:${since.slice(0, 10)}`, table: "api_accounts", subjectId: row.id, action: "grace_started", eventId, subscriptionId: row.stripe_subscription_id, detail: { grace_days: API_PAST_DUE_GRACE_MS / 86_400_000, basis: "first_seen" } });
    return { ok: a, action: "started", unconfirmed: 0 };
  }
  if (!graceElapsed(row, nowMs)) return { ok: true, action: "none", unconfirmed: 0 };
  const hasKey = Boolean(row.key_id) || Object.keys(row.overlap_key_ids ?? {}).length > 0;
  if (!hasKey) return { ok: true, action: "none", unconfirmed: 0 };
  const out = await suspendApiKeys(row, {});
  if (!out.ok) return { ok: Boolean(out.terminal), action: "none", unconfirmed: 0 }; // terminal: cancelled meanwhile, nothing owed
  const a = await audit({
    dedupeKey: `grace_expired:${row.id}:${row.past_due_since}:${out.revoked.join(",")}`,
    table: "api_accounts",
    subjectId: row.id,
    action: "grace_expired_key_revoked",
    eventId,
    subscriptionId: row.stripe_subscription_id,
    detail: { grace_days: API_PAST_DUE_GRACE_MS / 86_400_000, engine_confirmed: out.confirmed.length, engine_unconfirmed: out.unconfirmed.length },
  });
  if (out.unconfirmed.length) await noteUnconfirmedRevocation(row, out.unconfirmed, "past_due grace elapsed", eventId);
  return { ok: a, action: "revoked", unconfirmed: out.unconfirmed.length };
}

/**
 * The daily pass over past_due subscription API accounts: start the grace of any that has none, revoke the live key of any whose grace
 * has run out. Run by /api/cron/payg. Never throws; a store that lacks migration 0041 reports `skipped` and tells the operator once.
 */
export async function enforcePastDueGrace(now: Date = new Date()): Promise<GraceReport> {
  const report: GraceReport = { examined: 0, started: 0, revoked: 0, unconfirmed: 0, errors: 0 };
  const r = await pg<ApiAccount[]>("GET", "api_accounts?status=eq.past_due&billing_hold=is.null&stripe_subscription_id=not.is.null&key_id=not.is.null&select=*&order=past_due_since.asc.nullsfirst,created_at.asc&limit=200");
  if (!r.ok) {
    report.skipped = `read failed (${r.status}${r.code ? ` ${r.code}` : ""})`;
    if (r.status === 400) {
      await notifyOperatorOnce("migration_0041_missing", "Migration 0041 (billing holds and audit trail) is not applied", "The past_due grace pass could not read api_accounts.billing_hold, so it did not run. Apply supabase/migrations/0041_billing_holds.sql. Until then a past_due API account keeps its minted key until the key expires.");
    }
    return report;
  }
  for (const row of r.data ?? []) {
    report.examined++;
    const out = await enforceGraceRow(row, now.getTime());
    if (!out.ok) report.errors++;
    else if (out.action === "started") report.started++;
    else if (out.action === "revoked") {
      report.revoked++;
      report.unconfirmed += out.unconfirmed;
    }
  }
  return report;
}
