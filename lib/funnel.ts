// Server-only: the product funnel, as a closed vocabulary.
//
// A free allowance that never converts and a cap that nobody raises are both visible in these events and in nothing else. They are
// the whole adoption funnel (qualifier -> free account -> key -> first use -> pay-as-you-go -> first charge -> repeat use, plus
// subscriptions and engagements) and are read back by the admin report (lib/payg-analytics.ts).
// So that the table can never become a second copy of customer data, BOTH the event names and the property keys are allow-listed,
// and a value must look like a short code or a number: an email address, a token, a company name or a card detail cannot pass
// for one. A rejected event is dropped and logged by category; recording is best-effort and never fails the request that
// caused it (a lost product event must not undo a payment).

import { funnelKey } from "@/lib/payg";
import { pg } from "@/lib/payg-store";

export const FUNNEL_EVENTS = [
  "free_account_created", "key_minted", "payg_enabled", "first_charge", "payment_failed", "alert_sent",
  "qualify_started", "qualify_completed", "project_created", "project_saved_result", "first_engine_use", "allowance_exhausted",
  "engagement_commissioned", "subscription_started", "subscription_cancelled", "refund_issued", "dispute_opened",
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

/** The only property keys an event may carry. Anything else is refused, not stripped: a caller that sends a stray key has a bug. */
export const FUNNEL_PROP_KEYS = ["plan", "scope", "cap_eur", "percent", "month", "units", "amount_cents", "account_ref", "reason", "evidence_class", "kind"] as const;
type PropKey = (typeof FUNNEL_PROP_KEYS)[number];

export type FunnelProps = Partial<Record<PropKey, string | number | boolean>>;

/**
 * What each property may hold, by key. Numbers for the four numeric keys (whole, bounded); for the rest a string of one exact shape,
 * so a value that is not the code we put there cannot get in: not an email (no @ or dot), not a token (no uppercase, dash, dot or
 * long hex run), not a name or a sentence (no spaces or capitals), not card data (no digits-only run beyond a count).
 */
const NUMERIC_KEYS: ReadonlySet<string> = new Set(["cap_eur", "percent", "units", "amount_cents"]);
const STRING_SHAPE: Record<string, RegExp> = {
  account_ref: /^[0-9a-f]{12}$/, // the anonymous HMAC reference (lib/payg.ts accountRef)
  month: /^\d{4}-(0[1-9]|1[0-2])$/,
  evidence_class: /^E[0-7]$/,
  plan: /^[a-z][a-z0-9_]{0,39}$/,
  scope: /^[a-z][a-z0-9_]{0,39}$/,
  kind: /^[a-z][a-z0-9_]{0,39}$/,
  reason: /^[a-z][a-z0-9_]{0,39}$/,
};
/** A long run of hex is a token or a digest, whatever key it is under (account_ref is the one exception, matched exactly above). */
const HEX_RUN = /[0-9a-f]{16,}/;

export type Checked = { ok: true; props: Record<string, string | number | boolean> } | { ok: false; reason: string };

export function checkFunnelEvent(name: unknown, props: unknown): Checked {
  if (typeof name !== "string" || !(FUNNEL_EVENTS as readonly string[]).includes(name)) return { ok: false, reason: "unknown_event" };
  if (props === null || typeof props !== "object" || Array.isArray(props)) return { ok: false, reason: "props_not_object" };
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (!(FUNNEL_PROP_KEYS as readonly string[]).includes(k)) return { ok: false, reason: "prop_not_allowed" };
    if (NUMERIC_KEYS.has(k)) {
      if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 1_000_000_000) return { ok: false, reason: "bad_value" };
    } else {
      if (typeof v !== "string" || !STRING_SHAPE[k]?.test(v)) return { ok: false, reason: "bad_value" };
      if (k !== "account_ref" && HEX_RUN.test(v)) return { ok: false, reason: "bad_value" };
    }
    out[k] = v;
  }
  return { ok: true, props: out };
}

/**
 * Record one event. `dedupeKey` makes it once-only (a webhook redelivery, a cron re-run). Returns true when a row was written.
 * Never throws; a refused or failed write is logged with a category and nothing else.
 */
export async function recordFunnelEvent(name: FunnelEvent, props: FunnelProps = {}, opts: { dedupeKey?: string; at?: Date } = {}): Promise<boolean> {
  const checked = checkFunnelEvent(name, props);
  if (!checked.ok) {
    console.error(`[GridForge] funnel event refused: ${checked.reason}`);
    return false;
  }
  // Stored as an opaque keyed digest, never the key itself (it is often built from a Stripe object id).
  const dedupe = opts.dedupeKey ? funnelKey(opts.dedupeKey) : null;
  try {
    const r = await pg<unknown[]>(
      "POST",
      "funnel_events?on_conflict=dedupe_key",
      // `at` is for events DERIVED from a record that has its own time (the first ledger charge): the event is dated when the thing happened.
      { name, props: checked.props, dedupe_key: dedupe, ...(opts.at && !Number.isNaN(opts.at.getTime()) ? { created_at: opts.at.toISOString() } : {}) },
      "resolution=ignore-duplicates,return=representation"
    );
    return r.ok && Array.isArray(r.data) ? r.data.length > 0 : false;
  } catch {
    return false;
  }
}
