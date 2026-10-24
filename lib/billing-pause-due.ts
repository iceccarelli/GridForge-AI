// A scheduled billing pause (migration 0043) is a pause that has been RECORDED but has not started to hold access yet: Stripe's
// pause_collection stops future invoices only, so the customer keeps the period they already paid for and the hold begins when that
// period ends (`billing_pause_from`). This leaf module holds the one rule every access check shares ("is that instant behind us?"), with
// no imports, so lib/api-access.ts, lib/subscribers.ts, the Hall Watch cron and lib/billing-pause.ts agree on it.

export interface PauseScheduled {
  billing_pause_from?: string | null;
}

/** The instant a scheduled pause starts to hold access, or null when none is scheduled (or the stored value is unreadable). */
export function pauseFromMs(row: PauseScheduled | null | undefined): number | null {
  const raw = row?.billing_pause_from;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** The scheduled pause has started: the paid period it waited for is over. An unreadable instant never counts as due (it holds nothing). */
export function pauseDue(row: PauseScheduled | null | undefined, nowMs: number = Date.now()): boolean {
  const t = pauseFromMs(row);
  return t !== null && t <= nowMs;
}
