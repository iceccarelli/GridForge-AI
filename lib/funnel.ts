// Server-only: the product funnel, as a closed vocabulary.
//
// A free allowance that never converts and a cap that nobody raises are both visible in these six events and in nothing else.
// So that the table can never become a second copy of customer data, BOTH the event names and the property keys are allow-listed,
// and a value must look like a short code or a number: an email address, a token, a company name or a card detail cannot pass
// for one. A rejected event is dropped and logged by category; recording is best-effort and never fails the request that
// caused it (a lost product event must not undo a payment).

import { pg } from "@/lib/payg-store";

export const FUNNEL_EVENTS = ["free_account_created", "key_minted", "payg_enabled", "first_charge", "payment_failed", "alert_sent"] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

/** The only property keys an event may carry. Anything else is refused, not stripped: a caller that sends a stray key has a bug. */
export const FUNNEL_PROP_KEYS = ["plan", "scope", "cap_eur", "percent", "month", "units", "amount_cents", "account_ref", "reason"] as const;
type PropKey = (typeof FUNNEL_PROP_KEYS)[number];

export type FunnelProps = Partial<Record<PropKey, string | number | boolean>>;

/** A code: letters, digits and _ . : - only (no @, no spaces), short, and not shaped like a credential. */
const CODE = /^[A-Za-z0-9_.:-]{1,40}$/;
const LONG_RUN = /[A-Za-z0-9_-]{24,}/;

export type Checked = { ok: true; props: Record<string, string | number | boolean> } | { ok: false; reason: string };

export function checkFunnelEvent(name: unknown, props: unknown): Checked {
  if (typeof name !== "string" || !(FUNNEL_EVENTS as readonly string[]).includes(name)) return { ok: false, reason: "unknown_event" };
  if (props === null || typeof props !== "object" || Array.isArray(props)) return { ok: false, reason: "props_not_object" };
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (!(FUNNEL_PROP_KEYS as readonly string[]).includes(k)) return { ok: false, reason: "prop_not_allowed" };
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return { ok: false, reason: "bad_value" };
    } else if (typeof v === "string") {
      if (!CODE.test(v) || LONG_RUN.test(v)) return { ok: false, reason: "bad_value" };
    } else if (typeof v !== "boolean") {
      return { ok: false, reason: "bad_value" };
    }
    out[k] = v as string | number | boolean;
  }
  return { ok: true, props: out };
}

/**
 * Record one event. `dedupeKey` makes it once-only (a webhook redelivery, a cron re-run). Returns true when a row was written.
 * Never throws; a refused or failed write is logged with a category and nothing else.
 */
export async function recordFunnelEvent(name: FunnelEvent, props: FunnelProps = {}, opts: { dedupeKey?: string } = {}): Promise<boolean> {
  const checked = checkFunnelEvent(name, props);
  if (!checked.ok) {
    console.error(`[GridForge] funnel event refused: ${checked.reason}`);
    return false;
  }
  const dedupe = opts.dedupeKey ? opts.dedupeKey.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) : null;
  try {
    const r = await pg<unknown[]>(
      "POST",
      "funnel_events?on_conflict=dedupe_key",
      { name, props: checked.props, dedupe_key: dedupe },
      "resolution=ignore-duplicates,return=representation"
    );
    return r.ok && Array.isArray(r.data) ? r.data.length > 0 : false;
  } catch {
    return false;
  }
}
