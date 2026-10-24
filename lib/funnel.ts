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
import { PRODUCTS } from "@/lib/products";

export const FUNNEL_EVENTS = [
  "free_account_created", "key_minted", "payg_enabled", "first_charge", "payment_failed", "alert_sent",
  "qualify_started", "qualify_completed", "project_created", "project_saved_result", "first_engine_use", "allowance_exhausted",
  "engagement_commissioned", "subscription_started", "subscription_cancelled", "refund_issued", "dispute_opened",
  "checkout_attempted", "checkout_session_created", "checkout_failed",
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

// ---- Checkout funnel (migration 0042). Three events that must never be confused with one another or with a payment:
//   checkout_attempted        a valid catalogue request passed every gate this site controls and was handed to Stripe;
//   checkout_session_created  Stripe returned a hosted-page URL. That is NOT a payment: nothing was charged by it, and the buyer may
//                             never open the page. The only payment evidence is the webhook's engagement_commissioned / subscription_started;
//   checkout_failed           a valid catalogue request that was refused or that Stripe could not turn into a session, with one fixed reason.
// Props are exactly `kind` (+ `reason` on a failure), checked against closed lists here AND by a check constraint in the database.
export const CHECKOUT_EVENTS = ["checkout_attempted", "checkout_session_created", "checkout_failed"] as const;
export type CheckoutEvent = (typeof CHECKOUT_EVENTS)[number];

/** Every way a VALID request can end without a session. Closed: a new refusal path needs a new entry here and in migration 0042. */
export const CHECKOUT_FAILURE_REASONS = [
  "payments_not_configured", // no STRIPE_SECRET_KEY on this deployment (503)
  "project_reference_rejected", // the named project token / buyer link is wrong, revoked, unusable for this product, or both were sent (400/404)
  "store_unavailable", // the project could not be confirmed because the store could not be read (502/503)
  "api_plan_not_ready", // API plan: key issuance not proven against the engine (503), nothing sold
  "founding_slots_unreadable", // legacy deposit: Founding availability could not be counted (503)
  "founding_reservation_failed", // legacy deposit: the Founding slot could not be reserved (503)
  "stripe_coupon_failed", // Stripe refused to create the Founding coupon (500)
  "stripe_session_failed", // Stripe refused to create the session (500)
] as const;
export type CheckoutFailureReason = (typeof CHECKOUT_FAILURE_REASONS)[number];
/** The reasons that happen AFTER Stripe was asked (the others are refusals before it was). */
export const CHECKOUT_STRIPE_STAGE_REASONS: readonly CheckoutFailureReason[] = ["stripe_coupon_failed", "stripe_session_failed"];

/** The kind of the off-catalogue deposit, recorded only when the operator has switched that path on (GRIDFORGE_LEGACY_DEPOSIT=1). */
export const LEGACY_DEPOSIT_KIND = "engagement_deposit";
/** The product kinds a checkout event may name: the catalogue (lib/products.ts) plus the legacy deposit. Mirrored in migration 0042. */
export const CHECKOUT_KINDS: readonly string[] = [...new Set(Object.values(PRODUCTS).map((p) => p.kind)), LEGACY_DEPOSIT_KIND];

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
  if ((CHECKOUT_EVENTS as readonly string[]).includes(name)) {
    // Exactly the catalogue kind (and, on a failure, one fixed reason): nothing else, nothing optional.
    for (const k of Object.keys(out)) if (k !== "kind" && k !== "reason") return { ok: false, reason: "prop_not_allowed" };
    if (typeof out.kind !== "string" || !CHECKOUT_KINDS.includes(out.kind)) return { ok: false, reason: "bad_value" };
    if (name === "checkout_failed") {
      if (typeof out.reason !== "string" || !(CHECKOUT_FAILURE_REASONS as readonly string[]).includes(out.reason)) return { ok: false, reason: "bad_value" };
    } else if ("reason" in out) return { ok: false, reason: "prop_not_allowed" };
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

/** The longest a checkout response waits for a checkout event to be written. Past it the response goes out and the write is abandoned. */
export const CHECKOUT_RECORD_TIMEOUT_MS = 600;

/**
 * Record a checkout event from the checkout route. It can NEVER change what the route does: it does not throw, it does not reject, and it
 * does not wait longer than CHECKOUT_RECORD_TIMEOUT_MS (a store that hangs, errors or is down costs the buyer at most that, once per event,
 * and changes nothing else). A refused, failed or abandoned write is simply a missing measurement.
 */
export async function recordCheckoutEvent(
  name: CheckoutEvent,
  props: { kind: string; reason?: CheckoutFailureReason },
  timeoutMs: number = CHECKOUT_RECORD_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = recordFunnelEvent(name, props).then(
      () => undefined,
      () => undefined
    );
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    });
    await Promise.race([write, limit]);
  } catch {
    /* never surfaces */
  } finally {
    if (timer) clearTimeout(timer);
  }
}
