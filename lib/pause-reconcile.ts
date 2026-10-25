// Server-only: one rule for "may this customer use what they paid for, when a scheduled pause says the paid period is over?".
//
// A scheduled billing pause (lib/billing-pause.ts, migration 0043) is a RECORD: billing_pause_from is the end of the paid period, and once
// that instant has passed the access checks treat the pause as started even before the daily job writes the hold. The record is wrong in
// exactly one case: the customer resumed billing and the resume event (customer.subscription.updated) was lost, or has not arrived yet.
// Until the daily job asked Stripe, such a customer was denied for up to ~24 h. The API-key mint asked Stripe once; the Intelligence
// entitlement lookup and the Hall Watch route did not. This module is the one place all three ask.
//
//   not due (no schedule, or the instant is ahead)      nothing to decide here: allowed
//   row cancelled / superseded                          DENIED (a cancellation is never revived)
//   a hold stands on the row (refund, dispute, ...)     DENIED, and nothing is written: a resume lifts the PAUSE, never a separate hold. The
//                                                       schedule stays (lib/billing-pause.ts keeps it under a stronger hold on purpose)
//   Stripe: billing running again                       the stale schedule is cleared by a conditional write (compare-and-set on the schedule
//                                                       instant AND on the pause/resume clock, and only while no hold stands), one audit
//                                                       row says so, and access is ALLOWED
//   Stripe: still paused / unpaid / cancelled           DENIED
//   Stripe timed out (STRIPE_CALL_TIMEOUT_MS), errored, has no such subscription, or is not configured
//                                                       DENIED, schedule untouched: "cannot say" is never read as "resumed"
//
// A denial that came from asking Stripe is remembered for NEGATIVE_CACHE_MS in this process, so that a denied customer's page loads (and a
// hanging Stripe) do not become a Stripe call each. Nothing positive is cached: a grant is the database patch itself (the schedule is gone,
// so the next check is not "due" at all). Concurrent checks of one row share a single Stripe call.
//
// The event-order clocks are not moved here (a lost event has no time to record): billing_pause_event_ts is only COMPARED, so a re-pause
// that lands while Stripe is being read (it moves the clock) makes the conditional write match nothing, and the re-pause keeps its schedule.
// A resume event that arrives later is applied as ever (it finds no schedule to clear and records its clock).

import { withStripeTimeout } from "@/lib/stripe-timeout";
import { enc, pg } from "@/lib/payg-store";
import { paygStripe } from "@/lib/payg-stripe";
import { pauseDue, billingStopped, type BillingState } from "@/lib/billing-pause-due";
import { recordBillingAudit } from "@/lib/billing-audit";
import { notifyOperatorOnce } from "@/lib/payg-operator";

/** How long a denial that came from Stripe (still paused, or Stripe could not say) is remembered in this process. */
export const NEGATIVE_CACHE_MS = 45_000;
const CACHE_MAX_ENTRIES = 2_000;

export type PauseTable = "api_accounts" | "watches" | "subscriptions";

/** The columns of a row that a scheduled pause decision reads. */
export interface PauseRow {
  id: string;
  status: string;
  token?: string;
  stripe_subscription_id?: string | null;
  billing_hold?: string | null;
  billing_pause_from?: string | null;
  billing_pause_resumes_at?: string | null;
  billing_pause_event_ts?: number | null;
}

/** The slice of the Stripe client this reads: injectable, so tests never touch a live service. */
export interface PauseStripe {
  subscriptions?: { retrieve(id: string): Promise<unknown> };
}

export interface ReconcileOptions {
  /** The client to ask (default: the deployment's). `null`: not configured, which denies. */
  stripe?: PauseStripe | null;
  nowMs?: number;
  /** A deliberate customer action (minting a key) ignores a remembered denial, so "I resumed in the portal" is believed at once. */
  bypassCache?: boolean;
}

const denied = new Map<string, number>();
const inFlight = new Map<string, Promise<boolean>>();

/** Tests only. */
export function resetPauseReconcileCache(): void {
  denied.clear();
  inFlight.clear();
}

const isEnded = (row: { status: string }): boolean => row.status === "cancelled" || row.status === "superseded";

function guardQuery(table: PauseTable, row: PauseRow): string | null {
  if (table === "subscriptions") return `subscriptions?id=eq.${enc(row.id)}&status=not.in.(cancelled,superseded)`;
  if (!row.token) return null;
  return `${table}?token=eq.${enc(row.token)}&status=neq.cancelled`;
}

/** Clear the stale schedule iff the row is still exactly as it was read: same schedule instant, same pause clock, no hold, not ended. */
async function clearSchedule(table: PauseTable, row: PauseRow): Promise<"cleared" | "raced" | "error"> {
  const base = guardQuery(table, row);
  if (!base || !row.billing_pause_from) return "error";
  const clock = typeof row.billing_pause_event_ts === "number" ? `billing_pause_event_ts=eq.${row.billing_pause_event_ts}` : "billing_pause_event_ts=is.null";
  const r = await pg<unknown[]>(
    "PATCH",
    `${base}&billing_pause_from=eq.${enc(row.billing_pause_from)}&billing_hold=is.null&${clock}`,
    { billing_pause_from: null, billing_pause_resumes_at: null, ...(table === "subscriptions" ? { updated_at: new Date().toISOString() } : {}) }
  );
  if (!r.ok) return "error";
  return (r.data?.length ?? 0) > 0 ? "cleared" : "raced";
}

async function decide(table: PauseTable, row: PauseRow, stripe: PauseStripe | null): Promise<{ allowed: boolean; remember: boolean }> {
  const subId = row.stripe_subscription_id ?? "";
  if (!stripe?.subscriptions || !subId) return { allowed: false, remember: false }; // nothing to ask: fail closed (and nothing to save a call on)
  let sub: BillingState;
  try {
    sub = (await withStripeTimeout(stripe.subscriptions.retrieve(subId))) as BillingState;
  } catch (err) {
    const e = err as { type?: unknown; code?: unknown } | null;
    console.error("[GridForge] due pause: Stripe could not say whether billing is running:", typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : "stripe_error");
    return { allowed: false, remember: true };
  }
  // canceled / incomplete_expired: the cancellation events own that (reported there); it is never an entitlement.
  const status = (sub as { status?: unknown } | null)?.status;
  if (!sub || status === "canceled" || status === "incomplete_expired" || billingStopped(sub)) return { allowed: false, remember: true };

  // Billing is running again at Stripe: the schedule is stale (its resume event was lost or has not arrived).
  const from = row.billing_pause_from as string;
  const w = await clearSchedule(table, row);
  if (w === "raced") return { allowed: false, remember: false }; // paused again, held or ended while Stripe was read: that row keeps what it has
  if (w === "error") return { allowed: false, remember: true };
  const a = await recordBillingAudit({
    dedupeKey: `pause_schedule_dropped:${table}:${row.id}:${from}`,
    table,
    subjectId: row.id,
    objectId: subId,
    subscriptionId: subId,
    action: "pause_schedule_dropped",
    detail: { why: "billing_running_at_stripe", was_effective_from: from, checked_by: "access_check" },
  });
  if (a === "error") {
    // The schedule is already gone, so this cannot be retried; say so to a person rather than lose the record silently.
    console.error("[GridForge] due pause: the schedule was cleared but its audit row could not be written");
    await notifyOperatorOnce(
      `pause_reconcile_audit:${table}:${row.id}:${from}`,
      "A stale billing pause was cleared but NOT audited",
      `A customer's scheduled pause (${table}, effective ${from}) was cleared because Stripe reports billing running again (the resume event never arrived), but the billing_audit row could not be written. ` +
        "Access was granted correctly; the audit trail has no record of this clearing. Check the billing_audit table and the store's health."
    );
  }
  return { allowed: true, remember: false };
}

/**
 * May this row's owner use what they paid for? `true` when no scheduled pause has come due (or a due one was proved stale at Stripe and
 * cleared); `false` otherwise. Never throws; every doubt is `false`.
 */
export async function pauseAllowsAccess(table: PauseTable, row: PauseRow, opts: ReconcileOptions = {}): Promise<boolean> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!pauseDue(row, nowMs)) return true;
  if (isEnded(row) || row.billing_hold) return false; // a cancellation, or a separate hold, is not for this check to lift
  const key = `${table}:${row.id}:${row.billing_pause_from}`;
  const until = denied.get(key);
  if (!opts.bypassCache && until !== undefined && until > nowMs) return false;
  const running = inFlight.get(key);
  if (running) return running;
  const stripe = opts.stripe !== undefined ? opts.stripe : (paygStripe() as unknown as PauseStripe | null);
  const call = decide(table, row, stripe)
    .then((v) => {
      if (v.allowed) denied.delete(key);
      else if (v.remember) {
        if (denied.size >= CACHE_MAX_ENTRIES) for (const [k, t] of denied) if (t <= nowMs) denied.delete(k);
        if (denied.size >= CACHE_MAX_ENTRIES) denied.clear();
        denied.set(key, nowMs + NEGATIVE_CACHE_MS);
      }
      return v.allowed;
    })
    .catch(() => false)
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, call);
  return call;
}
