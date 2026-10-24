// Server-only data layer for Hall Watch.
//
// A watch holds a hall's inputs and the answer as last reported. Re-solving is
// cheap; the value is in the comparison, and in being the only party holding the
// model when the client asks "what moved?".
//
// Two things trigger a run: the client updates an input, or the schedule comes
// round and our own libraries have moved since. Both are real. Neither invents a
// finding — "nothing material changed" is a legitimate note and is sent as three
// lines rather than padded into a document.

import crypto from "node:crypto";
import { storeFault } from "@/lib/safe-log";
import { engineFetch } from "@/lib/rate-limit";
import { formatWeeksDelta, type DateBasisKeys } from "@/lib/date-basis";

export type WatchStatus = "active" | "paused" | "cancelled";
export type Cadence = "monthly" | "quarterly";

export interface WatchRecord {
  id: string;
  created_at?: string;
  token: string;
  status: WatchStatus;
  cadence: Cadence;
  email: string | null;
  company: string | null;
  site_name: string | null;
  hall_id: string | null;
  intake: Record<string, unknown> | null;
  last_state: Record<string, unknown> | null;
  last_run_at: string | null;
  next_run_at: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  /** Stripe event.created of the newest invoice event applied to this watch (migration 0039): orders a late payment_failed against a later paid. */
  last_billing_event_ts?: number | null;
  /** A suspension that is not a cancellation (migration 0041): see lib/billing-holds.ts. */
  billing_hold?: "refunded" | "disputed" | "paused" | null;
  billing_hold_ref?: string | null;
  billing_hold_invoice?: string | null;
  billing_hold_at?: string | null;
  billing_hold_prev_status?: string | null;
}

export interface WatchNote {
  id: string;
  created_at: string;
  watch_id: string;
  material: boolean;
  headline: string | null;
  racks_delta: number | null;
  weeks_delta: number | null;
  binding_moved: boolean | null;
  document_html: string | null;
  document_md: string | null;
  change: Record<string, unknown> | null;
  trigger: string;
}

/** What the note for a watch's first answer says: it is the point later change notes are measured from, not a change. */
export const BASELINE_HEADLINE = "Baseline recorded. Later change notes compare against this answer.";

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function nextRun(from: Date, cadence: Cadence): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + (cadence === "monthly" ? 1 : 3));
  return d.toISOString();
}

function creds(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers: { ...auth, "Content-Type": "application/json" } };
}

export async function createWatch(
  row: Partial<WatchRecord> & { email?: string | null }
): Promise<WatchRecord | null> {
  const token = row.token ?? newToken();
  const cadence: Cadence = row.cadence ?? "quarterly";
  const record = {
    status: "active" as WatchStatus,
    cadence,
    next_run_at: nextRun(new Date(), cadence),
    ...row,
    token,
  };
  const c = creds();
  if (!c) {
    // See createDeliverable: a "local" success would make the Stripe webhook ack a
    // paid subscription that was never stored. Fail outside `next dev`; never log
    // the record (token, buyer email).
    if (process.env.NODE_ENV !== "development") {
      console.error("[GridForge] watch NOT persisted: Supabase is not configured");
      return null;
    }
    console.warn("[GridForge] DEV ONLY: watch not persisted (Supabase unset)");
    return { ...(record as WatchRecord), id: "local" };
  }
  const res = await fetch(`${c.url}/rest/v1/watches`, {
    method: "POST",
    headers: { ...c.headers, Prefer: "return=representation" },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    console.error("[GridForge] watch insert failed:", await storeFault(res));
    return null;
  }
  return ((await res.json()) as WatchRecord[])[0] ?? null;
}

export async function getWatch(token: string): Promise<WatchRecord | null> {
  const c = creds();
  if (!c || !token) return null;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(token)}&select=*&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) return null;
    return ((await res.json()) as WatchRecord[])[0] ?? null;
  } catch (err) {
    console.error("[GridForge] watch lookup unreachable:", err);
    return null;
  }
}

export async function dueWatches(limit = 25): Promise<WatchRecord[]> {
  const c = creds();
  if (!c) return [];
  const now = new Date().toISOString();
  const res = await fetch(
    `${c.url}/rest/v1/watches?status=eq.active&intake=not.is.null` +
      `&or=(next_run_at.is.null,next_run_at.lte.${now})&select=*&order=next_run_at.asc&limit=${limit}`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) {
    console.error("[GridForge] dueWatches failed:", await storeFault(res));
    return [];
  }
  return (await res.json()) as WatchRecord[];
}

/**
 * One engine call of a watch run. The two formats run concurrently, so a run is about this long at worst, and the cron
 * starts no new watch after WATCH_CRON_START_BY_MS of its 300 s budget, which keeps the whole invocation inside it.
 */
export const WATCH_ENGINE_TIMEOUT_MS = 100_000;
export const WATCH_CRON_START_BY_MS = 190_000;

/** How long a claimed watch is held by one cron invocation before another may take it. */
export const WATCH_LEASE_MS = 15 * 60 * 1000;
/** After an engine/store failure a watch is pushed this far back, behind everything else due. */
export const WATCH_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Claim a due watch: a conditional update of next_run_at (only if it is still the
 * value we read) to a lease expiry. Exactly one of several overlapping cron
 * invocations gets "claimed"; the others see the row already moved and skip it.
 * "error" means the store failed, so the caller must not work on it.
 */
export async function claimWatch(w: WatchRecord, now = new Date()): Promise<"claimed" | "lost" | "error"> {
  const c = creds();
  if (!c) return "error";
  const current = w.next_run_at === null ? "is.null" : `eq.${encodeURIComponent(w.next_run_at)}`;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(w.token)}&status=eq.active&next_run_at=${current}`,
      {
        method: "PATCH",
        headers: { ...c.headers, Prefer: "return=representation" },
        body: JSON.stringify({ next_run_at: new Date(now.getTime() + WATCH_LEASE_MS).toISOString() }),
      }
    );
    if (!res.ok) {
      console.error("[GridForge] watch claim failed:", await storeFault(res));
      return "error";
    }
    return ((await res.json().catch(() => [])) as unknown[]).length > 0 ? "claimed" : "lost";
  } catch (err) {
    console.error("[GridForge] watch claim unreachable:", err);
    return "error";
  }
}

export async function updateWatch(token: string, patch: Partial<WatchRecord>): Promise<boolean> {
  const c = creds();
  if (!c) return false;
  const res = await fetch(`${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(token)}`, {
    method: "PATCH",
    headers: { ...c.headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) console.error("[GridForge] watch update failed:", await storeFault(res));
  return res.ok;
}

/**
 * Write only while the watch is STILL active (a conditional update on the status, like claimWatch). A run claims a watch, spends up to
 * minutes in the engine and then records its result; a cancellation, a refund hold or a pause that lands in that time must not be
 * overtaken by the run's write. "inactive": no row matched, the watch is no longer entitled to a run. "error": the store failed.
 */
export async function updateWatchIfActive(token: string, patch: Partial<WatchRecord>): Promise<"ok" | "inactive" | "error"> {
  const c = creds();
  if (!c) return "error";
  try {
    const res = await fetch(`${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(token)}&status=eq.active`, {
      method: "PATCH",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error("[GridForge] watch conditional update failed:", await storeFault(res));
      return "error";
    }
    return ((await res.json().catch(() => [])) as unknown[]).length > 0 ? "ok" : "inactive";
  } catch (err) {
    console.error("[GridForge] watch conditional update unreachable:", err);
    return "error";
  }
}

/**
 * Write only while the watch is NOT cancelled (a conditional update on the status): a billing event that races a cancellation can never
 * turn cancelled into paused or active, in either order. "terminal": no row matched, the watch is cancelled and there is nothing to write.
 */
export async function updateWatchUnlessCancelled(token: string, patch: Partial<WatchRecord>): Promise<"ok" | "terminal" | "error"> {
  const c = creds();
  if (!c) return "error";
  try {
    const res = await fetch(`${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(token)}&status=neq.cancelled`, {
      method: "PATCH",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error("[GridForge] watch guarded update failed:", await storeFault(res));
      return "error";
    }
    return ((await res.json().catch(() => [])) as unknown[]).length > 0 ? "ok" : "terminal";
  } catch (err) {
    console.error("[GridForge] watch guarded update unreachable:", err);
    return "error";
  }
}

/** The watch's status as the store holds it NOW, apart from "could not ask" (never read an outage as "cancelled" or as "active"). */
export async function watchStatusNow(token: string): Promise<WatchStatus | "missing" | "unknown"> {
  const c = creds();
  if (!c || !token) return "unknown";
  try {
    const res = await fetch(`${c.url}/rest/v1/watches?token=eq.${encodeURIComponent(token)}&select=status&limit=1`, { headers: c.headers, cache: "no-store" });
    if (!res.ok) return "unknown";
    const row = ((await res.json()) as { status?: WatchStatus }[])[0];
    return row?.status ?? "missing";
  } catch {
    return "unknown";
  }
}

/**
 * A watch that is cancelled or held receives nothing more: a change note already queued for an email (migration 0030) is abandoned, so
 * the engagements sweep does not send it later. The note itself stays stored. Best effort: the table may not exist (migration 0030).
 */
export async function abandonPendingNotices(watchId: string, reason: string): Promise<void> {
  const c = creds();
  if (!c || !watchId) return;
  try {
    const res = await fetch(`${c.url}/rest/v1/watch_note_notices?watch_id=eq.${encodeURIComponent(watchId)}&status=eq.pending`, {
      method: "PATCH",
      headers: { ...c.headers, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "abandoned", last_error: reason }),
    });
    if (!res.ok && res.status !== 404) console.error("[GridForge] could not abandon queued watch notices:", await storeFault(res));
  } catch {
    /* the notice sweep re-checks nothing, but a watch with no queued notice has nothing to abandon */
  }
}

/**
 * The watch behind a Stripe subscription.
 *
 * This lookup exists because the billing webhook knew how to find an API account
 * by subscription id and did not know how to find a watch. The consequence was
 * one-directional and expensive in the wrong way: Hall Watch renewed correctly,
 * but a cancelled or unpaid subscription left `status` at "active", and
 * dueWatches() — which filters on exactly that — kept generating and sending
 * quarterly change notes to somebody who had stopped paying for them.
 */
/** The watch behind a subscription; a failed read is reported as such, never as "no watch". */
export async function lookupWatchBySubscription(
  subscriptionId: string
): Promise<{ ok: true; row: WatchRecord | null } | { ok: false }> {
  const c = creds();
  if (!c || !subscriptionId) return { ok: false };
  try {
    const res = await fetch(
      `${c.url}/rest/v1/watches?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}` +
        `&select=*&limit=1`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] watchBySubscription failed:", await storeFault(res));
      return { ok: false };
    }
    return { ok: true, row: ((await res.json()) as WatchRecord[])[0] ?? null };
  } catch (err) {
    console.error("[GridForge] watchBySubscription unreachable:", err);
    return { ok: false };
  }
}

export async function watchBySubscription(subscriptionId: string): Promise<WatchRecord | null> {
  const found = await lookupWatchBySubscription(subscriptionId);
  return found.ok ? found.row : null;
}

/** Store a change note. Returns the stored note's id, or null when it was NOT stored (the caller must not advance state or email). */
export async function recordNote(row: Partial<WatchNote> & { watch_id: string }): Promise<string | null> {
  const c = creds();
  if (!c) {
    console.error("[GridForge] watch note NOT persisted: Supabase is not configured (watch_id=%s)", row.watch_id);
    return null;
  }
  const res = await fetch(`${c.url}/rest/v1/watch_notes`, {
    method: "POST",
    headers: { ...c.headers, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    console.error("[GridForge] watch note insert failed:", await storeFault(res));
    return null;
  }
  const rows = (await res.json().catch(() => [])) as { id?: string }[];
  return rows[0]?.id ?? null;
}

export async function notesFor(watchId: string, limit = 12): Promise<WatchNote[]> {
  const c = creds();
  if (!c) return [];
  const res = await fetch(
    `${c.url}/rest/v1/watch_notes?watch_id=eq.${watchId}&select=*&order=created_at.desc&limit=${limit}`,
    { headers: c.headers, cache: "no-store" }
  );
  if (!res.ok) return [];
  return (await res.json()) as WatchNote[];
}

export interface DiffOutcome {
  headline: string;
  material: boolean;
  racks_delta: number;
  weeks_delta: number | null;
  binding_moved: boolean;
  after: Record<string, unknown>;
  document?: string;
  document_full?: string;
  markdown?: string;
  /** What the movement in weeks rests on (the engine's /v1/diff; absent from an older engine or an older stored diff). */
  date_basis?: string;
  date_evidence_class?: string | null;
  date_binding_item?: string | null;
  date_label?: string;
  [k: string]: unknown;
}

/** The four date-basis keys of a stored diff, only the ones present: absence stays absence (it reads as "lead time unverified"). */
export function dateKeysOf(change: Record<string, unknown> | DateBasisKeys | null | undefined): DateBasisKeys {
  const src = (change ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["date_basis", "date_evidence_class", "date_binding_item", "date_label"]) if (k in src) out[k] = src[k];
  return out as DateBasisKeys;
}

/** The record stored as a note's `change`: the diff, carrying its date-basis keys beside the figures they qualify. */
export function storedChange(d: DiffOutcome): Record<string, unknown> {
  return { ...d, ...dateKeysOf(d) };
}

/**
 * The movement in weeks as a reader may see it, through the one shared formatter (lib/date-basis.ts): the number always with
 * what it rests on, or "lead time unverified" and no number for a note whose stored diff predates the keys. Null when the
 * note has no weeks figure at all.
 */
export function weeksLine(n: { weeks_delta?: number | null; change?: Record<string, unknown> | null }): string | null {
  if (typeof n.weeks_delta !== "number" || !Number.isFinite(n.weeks_delta)) return null;
  const keys = dateKeysOf(n.change);
  return formatWeeksDelta(n.weeks_delta, keys, keys);
}

/** Re-solve a watched hall and compare against the answer last reported.
 *  `previousState` absent means this is the first run: there is nothing to
 *  compare to, so the note records the baseline instead of inventing a change. */
export async function runWatch(
  intake: Record<string, unknown>,
  previousState: Record<string, unknown> | null,
  before?: Record<string, unknown> | null
): Promise<{ ok: true; diff: DiffOutcome } | { ok: false; error: string }> {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  if (!base || !key) return { ok: false, error: "GRIDFORGE_API_URL / _API_KEY are not set" };

  const call = async (format: "html" | "md") => {
    const res = await engineFetch(`${base.replace(/\/$/, "")}/v1/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({
        after: intake,
        ...(before ? { before } : previousState ? { previous_state: previousState } : {}),
        format,
      }),
      signal: AbortSignal.timeout(WATCH_ENGINE_TIMEOUT_MS),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `engine ${res.status}`);
    return body as DiffOutcome;
  };

  if (!previousState && !before) {
    return { ok: false, error: "no baseline to compare against" };
  }

  try {
    const [html, md] = await Promise.all([call("html"), call("md")]);
    return { ok: true, diff: { ...html, markdown: md.document as string } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "engine unreachable" };
  }
}
