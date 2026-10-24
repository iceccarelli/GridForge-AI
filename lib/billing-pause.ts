// Server-only: a billing pause takes effect when the PAID period ends.
//
// Stripe's pause_collection stops FUTURE invoices only. A customer who pauses in the middle of a period has already paid for the rest of
// it, and used to lose it at once (the hold began with the event). Now:
//
//   customer.subscription.updated, pause_collection set
//       paid period known and still running     SCHEDULED: billing_pause_from = the end of the paid period (migration 0043). Nothing is
//                                               suspended yet; the audit trail says "pause_scheduled".
//       pause_collection.resumes_at on or before the end of the paid period
//                                               NO INTERRUPTION: billing resumes before the paid period ends, so nothing is scheduled.
//       status "paused", period already over, no period to be had, a row that is not in good standing (past_due ...), or migration 0043
//       not applied yet
//                                               IMMEDIATE: the hold of 0041 begins now, exactly as before.
//   customer.subscription.updated, pause cleared (resume)
//                                               the schedule is cancelled (a resume before the period end interrupts nothing) and a hold
//                                               that had begun is lifted back to what the row was before.
//   invoice.paid for a LATER period            moves a scheduled pause to the end of that period (a payment is access, whatever the pause).
//   the scheduled instant passes                the daily job (applyDuePauses), the Hall Watch cron (gateWatch) and the access checks
//                                               (mintChecked, lookupEntitlement) treat it as started; the job writes the hold, revokes the
//                                               API key, pauses the watch, suspends Intelligence, once, with an audit row. While paused no new
//                                               paid invoice exists, so a renewal does not extend anything: access stays held after the period.
//   cancellation                                wins, always: the writers refuse a cancelled row and the daily job never selects one.
//
// Ordering. Pause and resume events carry their own clock, billing_pause_event_ts (Stripe event.created of the newest pause or resume
// decision applied to the row), written LAST so that "the clock is at this event" means "everything this event required is on record".
// last_billing_event_ts orders PAYMENT events and is neither read nor moved here: a resume must not make an older, not yet delivered
// invoice.paid look stale. An event older than the clock is stale and changes nothing; at the same second a resume wins a tie, a pause
// that finds its own effects already recorded only re-checks its audit row. A row with no clock yet (migration 0043 not applied, or never
// paused) accepts any event.
//
// Hall Watch. A change note that was already DUE before the instant the pause starts is still delivered, whenever the cron reaches it
// (the schedule is weekly); none that falls due after it is. The daily job does not pause a watch that owes such a note for up to
// WATCH_OWED_NOTE_GRACE_MS; the Hall Watch cron delivers it and then writes the hold.

import { pg, enc } from "@/lib/payg-store";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import { pauseDue, pauseFromMs } from "@/lib/billing-pause-due";
import {
  applyHold,
  endedRow,
  idOf,
  liftHold,
  pauseEventIsCurrent,
  recordBillingAudit,
  resolveSubscription,
  type AuditEntry,
  type Entitlements,
  type ReversalStripe,
} from "@/lib/billing-holds";
import type { WatchRecord } from "@/lib/watches";

/** How long after a scheduled pause starts a Hall Watch that owes a note is left active for the Hall Watch cron to deliver it. The cron is weekly. */
export const WATCH_OWED_NOTE_GRACE_MS = 8 * 86_400_000;

type TableName = "api_accounts" | "watches" | "subscriptions";

interface PauseFields {
  id: string;
  status: string;
  token?: string;
  stripe_subscription_id?: string | null;
  billing_hold?: string | null;
  billing_pause_from?: string | null;
  billing_pause_resumes_at?: string | null;
  billing_pause_event_ts?: number | null;
  billing_pause_checked_at?: string | null;
}

interface Target {
  table: TableName;
  row: PauseFields;
  ent: keyof Entitlements;
}

function targetsOf(found: Entitlements): Target[] {
  const out: Target[] = [];
  if (found.api) out.push({ table: "api_accounts", row: found.api as unknown as PauseFields, ent: "api" });
  if (found.watch) out.push({ table: "watches", row: found.watch as unknown as PauseFields, ent: "watch" });
  if (found.intelligence && found.intelligence.status !== "superseded") out.push({ table: "subscriptions", row: found.intelligence as unknown as PauseFields, ent: "intelligence" });
  return out;
}

/** The entitlements object holding ONLY this row, so a hold or a lift reaches that row and no other. */
function only(t: Target): Entitlements {
  return { api: null, watch: null, intelligence: null, [t.ent]: t.row } as unknown as Entitlements;
}

type Written = "ok" | "terminal" | "error" | "nocolumn";

/**
 * A guarded write: never to a cancelled (or superseded) row. "nocolumn": the store does not know the column (migration 0043 not applied
 * yet); a transient failure is "error" and is retried, never read as "the migration is missing".
 */
async function patchTarget(t: Target, patch: Record<string, unknown>): Promise<Written> {
  const q =
    t.table === "subscriptions"
      ? `subscriptions?id=eq.${enc(t.row.id)}&status=not.in.(cancelled,superseded)`
      : `${t.table}?token=eq.${enc(t.row.token ?? "")}&status=neq.cancelled`;
  const r = await pg<unknown[]>("PATCH", q, t.table === "subscriptions" ? { ...patch, updated_at: new Date().toISOString() } : patch);
  if (!r.ok) return r.status === 400 && (r.code === "PGRST204" || r.code === "42703") ? "nocolumn" : "error";
  return (r.data?.length ?? 0) > 0 ? "ok" : "terminal";
}

async function noteMigrationMissing(): Promise<void> {
  await notifyOperatorOnce(
    "migration_0043_missing",
    "Migration 0043 (scheduled pauses and settlement reversals) is not applied",
    "A billing pause could not be recorded as a scheduled pause because the pause columns do not exist yet, so it was applied IMMEDIATELY, as before 0043: a customer who " +
      "paused in the middle of a paid period loses the rest of it, and pause and resume events are not ordered against each other. Apply " +
      "supabase/migrations/0043_billing_pause_and_settlement_reversals.sql. This notice is sent once."
  );
}

// ------------------------------------------------------------------------------------------------------ the subscription

export interface PausedSub {
  id: string;
  status?: string | null;
  pause_collection?: { resumes_at?: number | null; behavior?: string | null } | null;
  current_period_end?: number | null;
  current_period_start?: number | null;
  items?: { data?: { current_period_end?: number | null; current_period_start?: number | null }[] } | null;
  latest_invoice?: unknown;
}

/** Billing is paused: pause_collection is set, or Stripe's own status says so. */
export function isPaused(sub: Pick<PausedSub, "status" | "pause_collection">): boolean {
  return Boolean(sub.pause_collection) || (sub.status as string | undefined) === "paused";
}

const sec = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** The end of the subscription's current period (unix seconds): on the object in older API versions, on its items in newer ones. */
export function periodEndOf(sub: Pick<PausedSub, "current_period_end" | "items">): number | null {
  const all = [sec(sub.current_period_end), ...(sub.items?.data ?? []).map((i) => sec(i?.current_period_end))].filter((n): n is number => n !== null);
  return all.length ? Math.max(...all) : null;
}

/** The start of the subscription's current period (unix seconds): the end of the period before it. */
export function periodStartOf(sub: Pick<PausedSub, "current_period_start" | "items">): number | null {
  const all = [sec(sub.current_period_start), ...(sub.items?.data ?? []).map((i) => sec(i?.current_period_start))].filter((n): n is number => n !== null);
  return all.length ? Math.max(...all) : null;
}

/** The end of the SERVICE periods an invoice's lines cover (unix seconds), or null. invoice.period_end is the billing window, not that. */
export function invoicePeriodEnd(inv: { lines?: { data?: { period?: { end?: number | null } | null }[] } | null }): number | null {
  const ends = (inv.lines?.data ?? []).map((l) => sec(l?.period?.end)).filter((n): n is number => n !== null);
  return ends.length ? Math.max(...ends) : null;
}

const isMissing = (err: unknown): boolean => (err as { code?: string } | null)?.code === "resource_missing";

type PaidEnd = { ok: true; sec: number | null; basis: string } | { ok: false };

type InvoiceFacts = { status?: unknown; amount_paid?: unknown; lines?: { data?: { period?: { end?: number | null } | null }[] } };

/**
 * Until when has the customer paid? The current period's end, IF the subscription's latest invoice was paid (a renewal that was voided
 * or left unpaid because billing is paused does not make the new period paid: then the customer has paid until the START of the current
 * period). The period comes from the event, else from Stripe as it holds the subscription now; with no period at all, from the latest
 * invoice if it was paid. `sec: null`: it cannot be established (the pause is then immediate). `ok: false`: Stripe could not be asked
 * (the event is retried).
 */
async function paidPeriodEnd(sub: PausedSub, stripe: ReversalStripe | null): Promise<PaidEnd> {
  let end = periodEndOf(sub);
  let start = periodStartOf(sub);
  let latest = idOf(sub.latest_invoice);
  if (end === null && stripe?.subscriptions) {
    try {
      const full = (await stripe.subscriptions.retrieve(sub.id)) as PausedSub;
      end = periodEndOf(full);
      start = periodStartOf(full) ?? start;
      latest = idOf(full.latest_invoice) || latest;
    } catch (err) {
      if (!isMissing(err)) return { ok: false };
    }
  }
  let facts: InvoiceFacts | null = null;
  if (latest && stripe) {
    try {
      facts = (await stripe.invoices.retrieve(latest)) as InvoiceFacts;
    } catch (err) {
      if (!isMissing(err)) return { ok: false };
    }
  }
  const paid = facts !== null && facts.status === "paid";
  if (end === null) {
    const lineEnd = facts ? invoicePeriodEnd(facts) : null;
    return paid && lineEnd !== null ? { ok: true, sec: lineEnd, basis: "latest_paid_invoice" } : { ok: true, sec: null, basis: "unknown" };
  }
  // The latest invoice is known and was NOT paid: the current period is not, and the customer has paid until the period began.
  if (facts !== null && !paid) return start !== null ? { ok: true, sec: start, basis: "current_period_unpaid" } : { ok: true, sec: null, basis: "unknown" };
  return { ok: true, sec: end, basis: "subscription_period_end" };
}

export type PausePlan =
  | { mode: "none" }
  | { mode: "immediate"; why: string }
  | { mode: "scheduled"; fromSec: number; resumesAtSec: number | null; basis: string }
  | { mode: "within_paid_period"; periodEndSec: number; resumesAtSec: number };

/** What a subscription's pause state means for access, given what the customer has paid for. */
export async function planPause(sub: PausedSub, stripe: ReversalStripe | null, nowMs: number): Promise<{ ok: true; plan: PausePlan } | { ok: false }> {
  if (!isPaused(sub)) return { ok: true, plan: { mode: "none" } };
  if (!sub.pause_collection) return { ok: true, plan: { mode: "immediate", why: "status_paused" } };
  const end = await paidPeriodEnd(sub, stripe);
  if (!end.ok) return { ok: false };
  if (end.sec === null) return { ok: true, plan: { mode: "immediate", why: "no_paid_period_known" } };
  if (end.sec * 1000 <= nowMs) return { ok: true, plan: { mode: "immediate", why: "paid_period_over" } };
  const resumes = sec(sub.pause_collection.resumes_at);
  if (resumes !== null && resumes <= end.sec) return { ok: true, plan: { mode: "within_paid_period", periodEndSec: end.sec, resumesAtSec: resumes } };
  return { ok: true, plan: { mode: "scheduled", fromSec: end.sec, resumesAtSec: resumes, basis: end.basis } };
}

// --------------------------------------------------------------------------------------------------------------- the event

const iso = (s: number) => new Date(s * 1000).toISOString();
const sameInstant = (a: string | null | undefined, s: number): boolean => typeof a === "string" && Date.parse(a) === s * 1000;

async function audit(e: AuditEntry): Promise<boolean> {
  return (await recordBillingAudit(e)) !== "error";
}

/**
 * customer.subscription.updated for a subscription that is not ending: apply its pause state to every row it entitles. `ok: false`: a
 * Stripe call, a write or an audit failed and the event is retried (every step is absolute, so the retry is safe).
 */
export async function applyPauseState(found: Entitlements, sub: PausedSub, ev: { id: string; created?: number }, stripe: ReversalStripe | null, nowMs: number = Date.now()): Promise<{ ok: boolean }> {
  const targets = targetsOf(found).filter((t) => !endedRow(t.row));
  if (targets.length === 0) return { ok: true };
  const planned = await planPause(sub, stripe, nowMs);
  if (!planned.ok) return { ok: false };
  let ok = true;
  for (const t of targets) if (!(await applyToTarget(t, planned.plan, sub, ev))) ok = false;
  return { ok };
}

async function applyToTarget(t: Target, plan: PausePlan, sub: PausedSub, ev: { id: string; created?: number }): Promise<boolean> {
  const row = t.row;
  const created = ev.created;
  const ts = row.billing_pause_event_ts;
  const base = { table: t.table, subjectId: row.id, eventId: ev.id, objectId: sub.id, subscriptionId: sub.id } as const;

  // ---- resume --------------------------------------------------------------------------------------------------------------
  if (plan.mode === "none") {
    if (!pauseEventIsCurrent(row, created)) return true; // a newer pause or resume is already on record
    const lift = await liftHold(only(t), { kinds: ["paused"], restore: "prev", cause: "billing_resumed", clock: "pause", subscriptionId: sub.id, eventId: ev.id, created });
    if (!lift.ok) return false;
    const hadSchedule = Boolean(row.billing_pause_from || row.billing_pause_resumes_at);
    const clockMoves = typeof created === "number" && !(typeof ts === "number" && ts >= created);
    if (!hadSchedule && !clockMoves) return true;
    const w = await patchTarget(t, { billing_pause_from: null, billing_pause_resumes_at: null, ...(typeof created === "number" ? { billing_pause_event_ts: Math.max(created, ts ?? 0) } : {}) });
    if (w === "error") return false;
    if (w === "nocolumn") {
      await noteMigrationMissing();
      return true;
    }
    if (hadSchedule && w === "ok") return audit({ ...base, dedupeKey: `pause_schedule_cleared:${t.table}:${row.id}:${ev.id}`, action: "pause_schedule_cleared", detail: { was_effective_from: row.billing_pause_from ?? null, cause: "billing_resumed" } });
    return true;
  }

  // ---- pause ---------------------------------------------------------------------------------------------------------------
  if (typeof created === "number" && typeof ts === "number" && created < ts) return true; // stale: a newer pause or resume is on record
  const sameSecond = typeof created === "number" && ts === created;
  // A pause can wait for the end of the paid period only if the row IS paid up. A row already suspended (a failed payment, a refund) or
  // not active has no paid period to wait for.
  const mode = plan.mode === "scheduled" && row.status !== "active" ? "immediate" : plan.mode;

  if (mode === "immediate") {
    const why = plan.mode === "immediate" ? plan.why : "row_not_in_good_standing";
    // Same second as the newest decision and the hold is not there: the tie goes to the resume, which is what cleared it.
    if (sameSecond && row.billing_hold !== "paused") return true;
    // A STRONGER hold (a refund, a dispute) stands: a single billing_hold column cannot carry the pause as well, and the pause must not be
    // lost when that hold ends. It is kept as a schedule that is already due; the daily job begins the hold when the stronger one is gone,
    // and every lift re-reads Stripe (reassertPause) and puts the pause back at once.
    if (row.billing_hold && row.billing_hold !== "paused") {
      const w = await patchTarget(t, { billing_pause_from: row.billing_pause_from ?? new Date().toISOString(), ...(typeof created === "number" ? { billing_pause_event_ts: Math.max(created, ts ?? 0) } : {}) });
      if (w === "error") return false;
      if (w === "nocolumn") await noteMigrationMissing();
      return true;
    }
    // A pause already SCHEDULED whose period has since ended (a renewal update delivered after the instant, before the daily job): the
    // schedule stands. The job (or, for a Hall Watch that owes a note, the Hall Watch cron) begins the hold; an event must not pre-empt that.
    if (plan.mode === "immediate" && plan.why === "paid_period_over" && row.billing_pause_from && !row.billing_hold) {
      if (typeof created === "number" && !(typeof ts === "number" && ts >= created)) {
        const w = await patchTarget(t, { billing_pause_event_ts: Math.max(created, ts ?? 0) });
        if (w === "error") return false;
      }
      return true;
    }
    // The legacy order clock is used only where there is no pause clock to write (migration 0043 not applied).
    const out = await applyHold(only(t), { kind: "paused", ref: sub.id, invoiceId: null, subscriptionId: sub.id, eventId: ev.id, created, noPaymentClock: true });
    if (!out.ok) return false;
    if (row.billing_pause_from || row.billing_pause_resumes_at || (typeof created === "number" && !(typeof ts === "number" && ts >= created))) {
      const w = await patchTarget(t, { billing_pause_from: null, billing_pause_resumes_at: null, ...(typeof created === "number" ? { billing_pause_event_ts: Math.max(created, ts ?? 0) } : {}) });
      if (w === "error") return false;
      if (w === "nocolumn") await noteMigrationMissing();
    }
    // The immediate hold's own audit row ("hold_applied") is written by applyHold; this one says WHY it was not scheduled. A stronger hold
    // already standing (a refund, a dispute) was not replaced by this pause, so there is nothing to explain.
    if (row.billing_hold && row.billing_hold !== "paused") return true;
    return audit({ ...base, dedupeKey: `pause_immediate:${t.table}:${row.id}:${ev.id}`, action: "pause_immediate", detail: { why } });
  }

  if (row.billing_hold === "paused") {
    // Already held by an earlier pause that came due: there is nothing for a schedule to wait for.
    if (row.billing_pause_from || (typeof created === "number" && !(typeof ts === "number" && ts >= created))) {
      const w = await patchTarget(t, { billing_pause_from: null, billing_pause_resumes_at: null, ...(typeof created === "number" ? { billing_pause_event_ts: Math.max(created, ts ?? 0) } : {}) });
      if (w === "error") return false;
    }
    return true;
  }

  if (mode === "within_paid_period") {
    const nothingScheduled = !row.billing_pause_from && !row.billing_pause_resumes_at;
    if (sameSecond && !nothingScheduled) return true;
    if (!nothingScheduled || (typeof created === "number" && !(typeof ts === "number" && ts >= created))) {
      const w = await patchTarget(t, { billing_pause_from: null, billing_pause_resumes_at: null, ...(typeof created === "number" ? { billing_pause_event_ts: Math.max(created, ts ?? 0) } : {}) });
      if (w === "error") return false;
      if (w === "nocolumn") {
        await noteMigrationMissing();
        return true;
      }
    }
    const p = plan as Extract<PausePlan, { mode: "within_paid_period" }>;
    return audit({ ...base, dedupeKey: `pause_no_interruption:${t.table}:${row.id}:${ev.id}`, action: "pause_no_interruption", detail: { paid_period_ends: iso(p.periodEndSec), resumes_at: iso(p.resumesAtSec) } });
  }

  // ---- scheduled -----------------------------------------------------------------------------------------------------------
  const planned = plan as Extract<PausePlan, { mode: "scheduled" }>;
  // A pause already scheduled is never moved LATER by a subscription update: Stripe moves current_period_end on every renewal, paid or
  // not, and a paused renewal collects nothing. Only a payment moves it (extendScheduledPause).
  const existing = pauseFromMs(row);
  const p = { ...planned, fromSec: existing !== null ? Math.min(planned.fromSec, Math.floor(existing / 1000)) : planned.fromSec };
  const same = sameInstant(row.billing_pause_from, p.fromSec);
  if (sameSecond && !same) return true; // a different decision at the same second: the resume's tie
  if (!(same && sameSecond)) {
    if (!(same && typeof created === "number" && typeof ts === "number" && ts >= created)) {
      const w = await patchTarget(t, { billing_pause_from: iso(p.fromSec), billing_pause_resumes_at: p.resumesAtSec ? iso(p.resumesAtSec) : null, ...(typeof created === "number" ? { billing_pause_event_ts: Math.max(created, ts ?? 0) } : {}) });
      if (w === "error") return false;
      if (w === "terminal") return true;
      if (w === "nocolumn") {
        // No place to keep a schedule (0043 not applied): the previous behaviour, loudly, rather than losing the pause.
        await noteMigrationMissing();
        const out = await applyHold(only(t), { kind: "paused", ref: sub.id, invoiceId: null, subscriptionId: sub.id, eventId: ev.id, created });
        return out.ok;
      }
    }
  }
  if (same && !sameSecond) return true; // the same schedule seen again by a newer event: the clock moved, nothing new to record
  return audit({
    ...base,
    dedupeKey: `pause_scheduled:${t.table}:${row.id}:${ev.id}`,
    action: "pause_scheduled",
    detail: { effective_from: iso(p.fromSec), resumes_at: p.resumesAtSec ? iso(p.resumesAtSec) : null, basis: p.basis },
  });
}

// ----------------------------------------------------------------------------------------------- a payment extends the paid period

/**
 * invoice.paid with money collected for a period that ends AFTER a scheduled pause starts: the customer has paid for more, so the pause
 * starts later (it never moves earlier). A pause whose resume date falls inside the longer period interrupts nothing and is dropped.
 * Order-independent (a maximum), so it needs no clock. `ok: false` = retry the event.
 */
export async function extendScheduledPause(found: Entitlements, inv: { id?: string; amount_paid?: number | null; lines?: { data?: { period?: { end?: number | null } | null }[] } | null }, ev: { id: string }): Promise<boolean> {
  if (!(typeof inv.amount_paid === "number" && inv.amount_paid > 0)) return true;
  const end = invoicePeriodEnd(inv);
  if (end === null) return true;
  let ok = true;
  for (const t of targetsOf(found)) {
    const from = pauseFromMs(t.row);
    if (endedRow(t.row) || from === null || end * 1000 <= from) continue;
    const resumes = t.row.billing_pause_resumes_at ? Date.parse(t.row.billing_pause_resumes_at) : NaN;
    const dropped = Number.isFinite(resumes) && resumes <= end * 1000;
    const w = await patchTarget(t, dropped ? { billing_pause_from: null, billing_pause_resumes_at: null } : { billing_pause_from: iso(end) });
    if (w === "error") ok = false;
    else if (w === "ok") {
      const a = await audit({
        dedupeKey: `pause_schedule_extended:${t.table}:${t.row.id}:${inv.id ?? ev.id}`,
        table: t.table,
        subjectId: t.row.id,
        action: dropped ? "pause_schedule_cleared" : "pause_schedule_extended",
        eventId: ev.id,
        invoiceId: inv.id ?? null,
        subscriptionId: t.row.stripe_subscription_id ?? undefined,
        detail: { was_effective_from: t.row.billing_pause_from ?? null, effective_from: dropped ? null : iso(end), cause: "later_period_paid" },
      });
      if (!a) ok = false;
    }
  }
  return ok;
}

// --------------------------------------------------------------------------------------------------- a scheduled pause comes due

/** A watch that owes a change note due BEFORE the instant its pause starts keeps it (for a while): the note was paid for. */
export function watchOwesNote(w: Pick<WatchRecord, "intake" | "next_run_at" | "billing_pause_from">, nowMs: number): boolean {
  const from = pauseFromMs(w);
  if (from === null || !w.intake || !w.next_run_at) return false;
  const due = Date.parse(w.next_run_at);
  return Number.isFinite(due) && due < from && nowMs < from + WATCH_OWED_NOTE_GRACE_MS;
}

export type Promoted = "promoted" | "deferred" | "dropped" | "skipped" | "failed";

/**
 * A scheduled pause whose instant has passed becomes the hold: once, with an audit row, after asking Stripe that billing is STILL paused
 * (a resume whose event never arrived must not suspend anybody). Stripe unreachable: "failed", tried again at the next run.
 */
async function promote(t: Target, stripe: ReversalStripe | null, nowMs: number, opts: { delivered?: boolean } = {}): Promise<Promoted> {
  const row = t.row;
  const from = pauseFromMs(row);
  const subId = row.stripe_subscription_id ?? "";
  if (from === null || from > nowMs || endedRow(row) || !subId) return "skipped";
  // (`delivered`: the Hall Watch cron has just sent the note this watch owed, so there is nothing left to wait for.)
  if (t.table === "watches" && !opts.delivered && watchOwesNote(row as unknown as WatchRecord, nowMs)) return "deferred";
  // A STRONGER hold (a refund, a dispute) stands: the schedule is KEPT, not cleared. When that hold ends the pause must still be there
  // (reassertPause puts it back at the lift; this is the fallback for a hold that ends some other way).
  if (row.billing_hold && row.billing_hold !== "paused") return "deferred";
  if (stripe?.subscriptions) {
    try {
      const sub = (await stripe.subscriptions.retrieve(subId)) as PausedSub;
      // canceled / incomplete_expired: the cancellation events own it (reported, never silent). unpaid is a subscription whose dunning ran out
      // and whose billing is stopped: nobody is paying, so the hold begins rather than waiting for an event that may never come.
      if (sub.status === "canceled" || sub.status === "incomplete_expired") return "skipped";
      if (!isPaused(sub) && sub.status !== "unpaid") {
        // Billing is running again at Stripe and the resume event was never applied: the schedule is void.
        const w = await patchTarget(t, { billing_pause_from: null, billing_pause_resumes_at: null });
        if (w === "error") return "failed";
        if (w === "ok") await audit({ dedupeKey: `pause_schedule_dropped:${t.table}:${row.id}:${row.billing_pause_from}`, table: t.table, subjectId: row.id, objectId: subId, subscriptionId: subId, action: "pause_schedule_dropped", detail: { why: "billing_running_at_stripe", was_effective_from: row.billing_pause_from ?? null } });
        return "dropped";
      }
    } catch (err) {
      if (!isMissing(err)) return "failed"; // cannot confirm: nothing is suspended on a guess, the next run asks again
    }
  }
  const fromIso = new Date(from).toISOString();
  const out = await applyHold(only(t), {
    kind: "paused",
    ref: subId,
    invoiceId: null,
    subscriptionId: subId,
    eventId: `pause_due:${subId}:${Math.floor(from / 1000)}`,
    noPaymentClock: true,
    effectiveFrom: fromIso,
  });
  if (!out.ok) return "failed";
  const w = await patchTarget(t, { billing_pause_from: null, billing_pause_resumes_at: null });
  if (w === "error") return "failed";
  return "promoted";
}

export interface PauseReport {
  due: number;
  promoted: number;
  /** A Hall Watch that owes a note due before its pause: left for the Hall Watch cron, which delivers it and then pauses the watch. */
  deferred: number;
  /** Billing was running again at Stripe: the schedule was dropped, nothing suspended. */
  dropped: number;
  skipped: number;
  errors: number;
  skippedReason?: string;
}

/** Best effort: mark a due row as examined so that rows that stay stuck rotate behind the others (the job reads the least recently examined first). */
async function stampChecked(t: Target, now: Date): Promise<void> {
  await patchTarget(t, { billing_pause_checked_at: now.toISOString() });
}

/**
 * The daily pass: every scheduled pause whose instant has passed becomes the hold. Idempotent (a second run finds nothing due), never
 * throws, never touches a cancelled row. Run by /api/cron/payg. A store without migration 0043 reports why it did nothing.
 */
export async function applyDuePauses(opts: { now?: Date; stripe: ReversalStripe | null }): Promise<PauseReport> {
  const now = opts.now ?? new Date();
  const report: PauseReport = { due: 0, promoted: 0, deferred: 0, dropped: 0, skipped: 0, errors: 0 };
  const tables: { table: TableName; ent: keyof Entitlements; status: string }[] = [
    { table: "api_accounts", ent: "api", status: "status=neq.cancelled" },
    { table: "watches", ent: "watch", status: "status=neq.cancelled" },
    { table: "subscriptions", ent: "intelligence", status: "status=not.in.(cancelled,superseded)" },
  ];
  for (const p of tables) {
    // Least recently examined first: a row that stays stuck (Stripe unreachable, a stronger hold, a cancellation not yet delivered) is stamped
    // and goes to the back, so it cannot starve the rows behind it run after run.
    const r = await pg<PauseFields[]>("GET", `${p.table}?billing_pause_from=lte.${enc(now.toISOString())}&${p.status}&select=*&order=billing_pause_checked_at.asc.nullsfirst,billing_pause_from.asc&limit=200`);
    if (!r.ok) {
      if (r.status === 400) report.skippedReason = "migration 0043 not applied (no billing_pause_from column)";
      else report.errors++;
      continue;
    }
    for (const row of r.data ?? []) {
      report.due++;
      const target: Target = { table: p.table, row, ent: p.ent };
      const out = await promote(target, opts.stripe, now.getTime());
      if (out === "promoted") report.promoted++;
      else if (out === "deferred") report.deferred++;
      else if (out === "dropped") report.dropped++;
      else if (out === "failed") report.errors++;
      else report.skipped++;
      if (out !== "promoted" && out !== "dropped") await stampChecked(target, now);
    }
  }
  // A pause that does not start is a customer's paid access held open (or, worse, a hold that never comes): said to a person, once a day
  // while it lasts, not left in the cron's JSON.
  if (report.errors > 0 || report.skipped > 0) {
    await notifyOperatorOnce(
      `pause_job:${now.toISOString().slice(0, 10)}`,
      `Scheduled billing pauses NOT started: ${report.errors} failed, ${report.skipped} skipped`,
      `The daily pass found ${report.due} scheduled pause(s) whose paid period has ended: ${report.promoted} started, ${report.deferred} deferred (a Hall Watch owing a note, or a stronger hold standing), ` +
        `${report.dropped} dropped (billing was running again at Stripe), ${report.errors} FAILED (Stripe or the store could not be reached; tried again next run) and ${report.skipped} skipped ` +
        "(the subscription is canceled at Stripe but its cancellation event was never applied: check the customer.subscription.deleted deliveries for it). " +
        "Until each starts, that customer keeps paid access they have stopped paying for. This notice is sent once a day while any remains."
    );
  }
  return report;
}

// ------------------------------------------------------------------------------------------ a lift must not forget the pause

/**
 * One billing_hold column carries one hold: a dispute or a refund that arrives while a pause is in force REPLACES it (the stronger wins),
 * and when that hold is lifted the row goes back to what it was before, which has no pause in it. Stripe still has the pause, and no
 * event will re-announce it, so access would come back with no payment. After ANY lift of a hold on a subscription (a dispute won, a
 * payment that cleared) this reads the subscription's CURRENT state from Stripe: if billing is still paused, the pause is put back (the
 * hold now if the paid period is over, the schedule if it is not). Not paused, or Stripe has no such subscription: nothing. Stripe
 * unreachable: `ok: false` and the event is retried (the lift is already on record; the retry only asks again).
 */
export async function reassertPause(subId: string, stripe: ReversalStripe | null, ev: { id: string }, nowMs: number = Date.now()): Promise<{ ok: boolean }> {
  if (!subId || !stripe?.subscriptions) return { ok: true };
  let sub: PausedSub;
  try {
    sub = (await stripe.subscriptions.retrieve(subId)) as PausedSub;
  } catch (err) {
    return { ok: isMissing(err) };
  }
  if (!isPaused(sub)) return { ok: true };
  const found = await resolveSubscription(subId);
  if (!found.ok) return { ok: false };
  const targets = targetsOf(found).filter((t) => !endedRow(t.row) && !t.row.billing_hold);
  if (targets.length === 0) return { ok: true };
  const planned = await planPause(sub, stripe, nowMs);
  if (!planned.ok) return { ok: false };
  const plan = planned.plan;
  let ok = true;
  for (const t of targets) {
    const base = { table: t.table, subjectId: t.row.id, eventId: ev.id, objectId: subId, subscriptionId: subId } as const;
    if (plan.mode === "immediate" || pauseDue(t.row, nowMs)) {
      const out = await applyHold(only(t), { kind: "paused", ref: subId, invoiceId: null, subscriptionId: subId, eventId: `pause_reasserted:${subId}:${ev.id}`, noPaymentClock: true });
      if (!out.ok) {
        ok = false;
        continue;
      }
      const w = await patchTarget(t, { billing_pause_from: null, billing_pause_resumes_at: null });
      if (w === "error") ok = false;
      if (!(await audit({ ...base, dedupeKey: `pause_reasserted:${t.table}:${t.row.id}:${ev.id}`, action: "pause_reasserted", detail: { why: "billing_still_paused_at_stripe" } }))) ok = false;
    } else if (plan.mode === "scheduled" && !t.row.billing_pause_from) {
      const w = await patchTarget(t, { billing_pause_from: iso(plan.fromSec), billing_pause_resumes_at: plan.resumesAtSec ? iso(plan.resumesAtSec) : null });
      if (w === "error") ok = false;
      else if (!(await audit({ ...base, dedupeKey: `pause_reasserted:${t.table}:${t.row.id}:${ev.id}`, action: "pause_reasserted", detail: { why: "billing_still_paused_at_stripe", effective_from: iso(plan.fromSec) } }))) ok = false;
    }
  }
  return { ok };
}

// ------------------------------------------------------------------------------------------------------------ Hall Watch cron

/** What the Hall Watch cron does with a due watch whose paid period may be over. */
export type WatchGate = { skip: false; pauseAfter?: boolean } | { skip: true; status: string };

/**
 * Before a due watch is run: if its scheduled pause has started, a note that fell due BEFORE it is still delivered (then the pause is
 * written: pauseAfter), and one that falls due after is not (the watch is paused now).
 */
export async function gateWatch(w: WatchRecord, stripe: ReversalStripe | null, nowMs: number = Date.now()): Promise<WatchGate> {
  if (!pauseDue(w, nowMs)) return { skip: false };
  if (watchOwesNote(w, nowMs)) return { skip: false, pauseAfter: true };
  const out = await promote({ table: "watches", row: w as unknown as PauseFields, ent: "watch" }, stripe, nowMs);
  if (out === "dropped") return { skip: false };
  return { skip: true, status: out === "promoted" ? "skipped_pause_started" : out === "failed" ? "pause_check_failed" : "skipped_pause" };
}

/** After a watch that owed a note has been run (delivered or not): write the pause that was waiting. `w` is the watch AS READ NOW, not as it was before the run. */
export async function pauseWatchNow(w: WatchRecord, stripe: ReversalStripe | null, nowMs: number = Date.now()): Promise<Promoted> {
  return promote({ table: "watches", row: w as unknown as PauseFields, ent: "watch" }, stripe, nowMs, { delivered: true });
}
