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
//   Stripe: billing running again                       (an ALLOWLISTED status for the very subscription asked about, not paused, not unpaid) the
//                                                       audit row "started" is written, then the stale schedule is cleared by a conditional
//                                                       write (schedule instant, pause/resume clock, no hold, not ended) that also moves the
//                                                       pause clock to the start of the read (so an older pause event delivered later is
//                                                       stale), then the closing audit row; access is ALLOWED. A conditional write that
//                                                       matches nothing because another instance already cleared the schedule also ALLOWS.
//   Stripe: still paused / unpaid / cancelled           DENIED
//   Stripe timed out (STRIPE_CALL_TIMEOUT_MS), errored, has no such subscription, or is not configured
//                                                       DENIED, schedule untouched: "cannot say" is never read as "resumed"
//
// A denial that came from asking Stripe is remembered for NEGATIVE_CACHE_MS in this process, so that a denied customer's page loads (and a
// hanging Stripe) do not become a Stripe call each. Nothing positive is cached: a grant is the database patch itself (the schedule is gone,
// so the next check is not "due" at all). Concurrent checks of one row share a single Stripe call.
//
// The pause clock (billing_pause_event_ts) is COMPARED by the conditional write, so a re-pause that lands while Stripe is being read (it moves
// the clock) makes the write match nothing and keeps its schedule; the same write then moves the clock forward to the start of the read, so
// a pause event created before that read and delivered after it is stale. last_billing_event_ts (payments) is never touched.

import { stripeCallTimeoutMs, withStripeTimeout } from "@/lib/stripe-timeout";
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

/**
 * Clear the stale schedule iff the row is still exactly as it was read: same schedule instant, same pause clock, no hold, not ended.
 * The SAME write advances the pause clock to `clockTo` (the moment the read of Stripe began, minus a second): a pause event that was
 * created before a read which proved billing running, and is delivered after this clear, is then stale and cannot re-create the schedule
 * (or the hold). Never moved backwards.
 */
async function clearSchedule(table: PauseTable, row: PauseRow, clockTo: number): Promise<"cleared" | "raced" | "error"> {
  const base = guardQuery(table, row);
  if (!base || !row.billing_pause_from) return "error";
  const clock = typeof row.billing_pause_event_ts === "number" ? `billing_pause_event_ts=eq.${row.billing_pause_event_ts}` : "billing_pause_event_ts=is.null";
  const r = await pg<unknown[]>(
    "PATCH",
    `${base}&billing_pause_from=eq.${enc(row.billing_pause_from)}&billing_hold=is.null&${clock}`,
    {
      billing_pause_from: null,
      billing_pause_resumes_at: null,
      billing_pause_event_ts: Math.max(row.billing_pause_event_ts ?? 0, clockTo),
      ...(table === "subscriptions" ? { updated_at: new Date().toISOString() } : {}),
    }
  );
  if (!r.ok) return "error";
  return (r.data?.length ?? 0) > 0 ? "cleared" : "raced";
}

/** The conditional write matched nothing: has ANOTHER instance (or the daily job, or the resume event) already cleared the schedule, with no hold and no end? Then access is the customer's. */
async function alreadyClear(table: PauseTable, row: PauseRow): Promise<boolean> {
  const base = guardQuery(table, row);
  if (!base) return false;
  const r = await pg<{ billing_pause_from?: string | null; billing_hold?: string | null }[]>("GET", `${base}&select=billing_pause_from,billing_hold&limit=1`);
  const now = r.ok ? r.data?.[0] : undefined;
  return Boolean(now) && !now!.billing_pause_from && !now!.billing_hold;
}

/** A subscription that Stripe says is collecting payment again. Anything not named here (a missing or unknown status, incomplete, canceled ...) is not "running". */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

/** The request path must not make a customer wait the full 8 s in a Stripe brown-out: the read of Stripe is bounded more tightly than the batch jobs'. */
export const REQUEST_STRIPE_BOUND_MS = 2_500;

type Decision = { allowed: boolean; remember: boolean };
const DENY_QUIET: Decision = { allowed: false, remember: false };

async function decide(table: PauseTable, row: PauseRow, stripe: PauseStripe | null): Promise<Decision> {
  const subId = row.stripe_subscription_id ?? "";
  if (!stripe?.subscriptions || !subId) return DENY_QUIET; // nothing to ask: fail closed (and nothing to save a call on)
  const readStartedMs = Date.now();
  let sub: (BillingState & { id?: unknown }) | null;
  try {
    sub = (await withStripeTimeout(stripe.subscriptions.retrieve(subId), Math.min(stripeCallTimeoutMs(), REQUEST_STRIPE_BOUND_MS))) as BillingState & { id?: unknown };
  } catch (err) {
    const e = err as { type?: unknown; code?: unknown } | null;
    console.error("[GridForge] due pause: Stripe could not say whether billing is running:", typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : "stripe_error");
    return { allowed: false, remember: true };
  }
  // ALLOWLIST: grant only for a subscription that is the one asked about, is in a status that collects payment, and is not paused or unpaid
  // (the single billingStopped rule). A missing or unknown status, `incomplete`, `canceled`, `incomplete_expired` ... deny; the cancellation
  // events own those.
  //
  // OWNER DECISION (not changed here): "billing is running" is not "the current period is paid". A subscription paused across a renewal and
  // then resumed has access from the resume until its next invoice settles, exactly as the daily job (promote) already treats it; this check
  // does not add a stricter test than the job's. If the product wants "paid up" instead, test the latest invoice here AND in promote.
  const status = (sub as { status?: unknown } | null)?.status;
  const sameSub = typeof sub?.id === "string" && sub.id === subId; // an answer that does not name the subscription asked about is not an answer
  if (!sub || !sameSub || typeof status !== "string" || !RUNNING_STATUSES.has(status) || billingStopped(sub)) return { allowed: false, remember: true };

  // Billing is running again at Stripe: the schedule is stale (its resume event was lost or has not arrived).
  const from = row.billing_pause_from as string;
  const key = `${table}:${row.id}:${from}:${row.billing_pause_event_ts ?? "none"}`;
  const entry = { table, subjectId: row.id, objectId: subId, subscriptionId: subId } as const;
  // The audit row goes FIRST (idempotent by its key), so a crash between it and the clear cannot lose the record (the next check repeats
  // both). A crash AFTER the clear leaves "started" without "dropped": the schedule is gone, so no access check repeats the closing row;
  // the daily pass leaves a truthful, differently named row for it (closeOrphanedDropAudits, below: it cannot know who cleared the schedule), and a failed write of it is reported to a person below. Its
  // key carries the schedule instant AND the pause clock, so a re-pause to the same period end followed by a second clear is recorded
  // again. It says what was decided; the row after the clear says what happened.
  const started = await recordBillingAudit({ ...entry, dedupeKey: `pause_schedule_drop_started:${key}`, action: "pause_schedule_drop_started", detail: { why: "billing_running_at_stripe", was_effective_from: from, checked_by: "access_check" } });
  if (started === "error") return DENY_QUIET; // a store fault, not a verdict about the customer: not remembered
  const w = await clearSchedule(table, row, Math.floor(readStartedMs / 1000) - 1);
  if (w === "error") return DENY_QUIET; // transient store failure: the next check tries again at once
  if (w === "raced") {
    // Someone else changed the row since it was read. If that was a clear (another instance, the daily job, the resume event), access is the
    // customer's; a re-pause, a hold or an end keeps its own state.
    return (await alreadyClear(table, row)) ? { allowed: true, remember: false } : DENY_QUIET;
  }
  const a = await recordBillingAudit({ ...entry, dedupeKey: `pause_schedule_dropped:${key}`, action: "pause_schedule_dropped", detail: { why: "billing_running_at_stripe", was_effective_from: from, checked_by: "access_check" } });
  if (a === "error") {
    // The schedule is already gone and the "started" row is on record; say so to a person rather than lose the closing record silently.
    console.error("[GridForge] due pause: the schedule was cleared but its closing audit row could not be written");
    await notifyOperatorOnce(
      `pause_reconcile_audit:${key}`,
      "A stale billing pause was cleared but its closing audit row was NOT written",
      `A customer's scheduled pause (${table}, effective ${from}) was cleared because Stripe reports billing running again (the resume event never arrived). The "started" audit row exists; the closing row could not be written. ` +
        "Access was granted correctly. Check the billing_audit table and the store's health."
    );
  }
  return { allowed: true, remember: false };
}

/** How far back the daily pass looks for a "started" row that never got its closing row, and how long a "started" row is left to its own check first. */
export const DROP_AUDIT_LOOKBACK_MS = 14 * 86_400_000;
export const DROP_AUDIT_SETTLE_MS = 10 * 60_000;
/** One pass reads at most DROP_AUDIT_MAX_PAGES pages of DROP_AUDIT_PAGE "started" rows (newest first) and examines at most DROP_AUDIT_MAX_ROWS of the unclosed ones. */
export const DROP_AUDIT_PAGE = 200;
export const DROP_AUDIT_MAX_PAGES = 5;
export const DROP_AUDIT_MAX_ROWS = 50;

const DROP_STARTED = "pause_schedule_drop_started:";
const DROP_DONE = "pause_schedule_dropped:";
const DROP_UNCONFIRMED = "pause_schedule_drop_unconfirmed:";

/**
 * A crash after the clear of a stale schedule (or a failed write of the closing row) leaves `pause_schedule_drop_started` with no
 * `pause_schedule_dropped`, and the schedule is gone, so no access check repeats the closing row. The daily pass calls this to leave a
 * TRUTHFUL end to the pair, and nothing more than it knows.
 *
 * What it knows: a "started" row (last 14 days, older than ten minutes so a check still in flight finishes its own) has no closing row, and its
 * subject row now has no schedule, no hold and is not ended. It does NOT know who cleared the schedule: the access check that wrote "started",
 * the resume webhook, or the access check that lost the conditional write and found the schedule already clear (which writes no closing row by
 * design). The daily job's promote clears the schedule as the hold begins; such a row has a hold and is skipped here. So the row written is a
 * DIFFERENT action, `pause_schedule_drop_unconfirmed`, whose detail says only that the schedule was found clear, who wrote this row, and which
 * "started" row it answers. Its key derives from the started key, so a second pass records nothing twice. It never claims
 * `pause_schedule_dropped` (that row means "Stripe said billing is running and WE cleared it"; the audit trail is append-only, so a wrong label
 * could never be corrected). A subject with a schedule, a hold, or an end is left alone.
 *
 * Bounded: the closing keys are read first (both actions), "started" rows are read newest first in pages and the closed ones skipped, so closed
 * pairs never crowd an orphan out; at most DROP_AUDIT_MAX_ROWS subjects are examined per pass; `shouldStop` is checked between reads (the daily
 * pass's budget). Never throws. Returns how many rows it wrote.
 */
export async function closeOrphanedDropAudits(nowMs: number = Date.now(), opts: { shouldStop?: () => boolean } = {}): Promise<number> {
  try {
    const stop = opts.shouldStop ?? (() => false);
    const since = new Date(nowMs - DROP_AUDIT_LOOKBACK_MS).toISOString();
    const settled = new Date(nowMs - DROP_AUDIT_SETTLE_MS).toISOString();
    const done = new Set<string>();
    for (const action of ["pause_schedule_dropped", "pause_schedule_drop_unconfirmed"]) {
      if (stop()) return 0;
      const closed = await pg<{ dedupe_key: string }[]>("GET", `billing_audit?action=eq.${action}&created_at=gte.${enc(since)}&select=dedupe_key&order=created_at.desc&limit=2000`);
      if (!closed.ok) return 0;
      for (const r of closed.data ?? []) done.add(r.dedupe_key);
    }
    type Started = { dedupe_key: string; subject_table: string; subject_id: string; stripe_subscription_id?: string | null; detail?: { was_effective_from?: unknown } | null };
    const open: { row: Started; key: string }[] = [];
    for (let page = 0; page < DROP_AUDIT_MAX_PAGES && open.length < DROP_AUDIT_MAX_ROWS; page++) {
      if (stop()) return 0;
      const started = await pg<Started[]>(
        "GET",
        `billing_audit?action=eq.pause_schedule_drop_started&created_at=gte.${enc(since)}&created_at=lte.${enc(settled)}&select=dedupe_key,subject_table,subject_id,stripe_subscription_id,detail&order=created_at.desc,id.desc&limit=${DROP_AUDIT_PAGE}&offset=${page * DROP_AUDIT_PAGE}`
      );
      if (!started.ok) return 0;
      for (const row of started.data ?? []) {
        if (!row.dedupe_key.startsWith(DROP_STARTED)) continue;
        const key = row.dedupe_key.slice(DROP_STARTED.length);
        if (done.has(`${DROP_DONE}${key}`) || done.has(`${DROP_UNCONFIRMED}${key}`)) continue;
        if (open.length < DROP_AUDIT_MAX_ROWS) open.push({ row, key });
      }
      if ((started.data?.length ?? 0) < DROP_AUDIT_PAGE) break;
    }
    let written = 0;
    for (const { row: r, key } of open) {
      if (stop()) break;
      const table = r.subject_table;
      if (table !== "api_accounts" && table !== "watches" && table !== "subscriptions") continue;
      const now = await pg<{ billing_pause_from?: string | null; billing_hold?: string | null; status?: string }[]>("GET", `${table}?id=eq.${enc(r.subject_id)}&select=billing_pause_from,billing_hold,status&limit=1`);
      const s = now.ok ? now.data?.[0] : undefined;
      // unreadable, gone, a schedule still standing, a hold (promote clears the schedule as it begins one), or ended: nothing to say about it
      if (!s || s.billing_pause_from || s.billing_hold || isEnded({ status: String(s.status) })) continue;
      const a = await recordBillingAudit({
        table,
        subjectId: r.subject_id,
        subscriptionId: r.stripe_subscription_id ?? undefined,
        objectId: r.stripe_subscription_id ?? undefined,
        dedupeKey: `${DROP_UNCONFIRMED}${key}`,
        action: "pause_schedule_drop_unconfirmed",
        detail: {
          schedule_found_clear: true,
          closed_by: "daily_pass",
          started_key: r.dedupe_key,
          was_effective_from: typeof r.detail?.was_effective_from === "string" ? r.detail.was_effective_from : null,
        },
      });
      if (a === "recorded") written++;
    }
    return written;
  } catch {
    return 0;
  }
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
