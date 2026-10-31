// Server-only: charge.dispute.created / .updated / .closed, decided by the dispute's CURRENT state at Stripe.
//
// Stripe does not deliver these in order and redelivers them. Deciding by the event type (and by the status inside the payload) meant that
//   - a `closed` (won) delivered BEFORE its `created` found nothing to lift, and the `created` that followed then applied a hold that nothing
//     ever lifted;
//   - a stale `created` or `updated` delivered AFTER the dispute was won (or lost, or closed) could create a hold on a dispute that was over.
// Now every one of the three events asks Stripe (disputes.retrieve, injectable) what the dispute IS, and decides from that alone:
//
//   open      (needs_response, under_review)   suspend what the payment entitles                    reversePayment, once per dispute
//   lost                                       the same hold, and the suspension is recorded as standing
//   won / resolved / inquiry_closed            lift the hold THIS dispute caused; a hold that was never applied stays unapplied
//   inquiry   (warning_*)                      no money has moved: nothing
//   unknown                                    nothing changes, the operator is told once
//
// so all six orderings of created / updated / closed(won), and of created / updated / closed(lost), end in the same state, and a
// redelivery decides the same thing again (an absolute state: the hold is already there, the audit row is already there).
//
// Audit rows are keyed per dispute and STATE (dispute_state:{dispute}:{status}:{table}:{row}), not per delivery: a state is on record
// once however many events carried it. The hold's own rows (hold_applied / hold_lifted / dispute_lost_hold_stands) keep their keys.
//
// A Stripe lookup that fails answers 500 so Stripe retries. A dispute Stripe says DOES NOT EXIST can never be resolved by a retry: it is
// acknowledged with an audit row (subject stripe_disputes), not retried for ever.
//
// A dispute on a pay-as-you-go settlement invoice has no subscription behind it: lib/payg-refunds.ts decides it.

import { withStripeTimeout } from "@/lib/stripe-timeout";
import { classifyDispute, LIFTS_DISPUTE_HOLD, type DisputeState } from "@/lib/dispute-state";
import {
  idOf,
  liftedByEvent,
  liftHold,
  recordBillingAudit,
  resolveSubscription,
  reversePayment,
  subscriptionOfPayment,
  type AuditEntry,
  type Entitlements,
  type Handled,
  type HoldKind,
  type ReversalStripe,
} from "@/lib/billing-holds";
import { reassertPause } from "@/lib/billing-pause";
import { holdOneTimePurchase, liftOneTimeDispute } from "@/lib/one-time-holds";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import { cents, reverseSettlement, settlementRefOf } from "@/lib/payg-refunds";

/** The slice of a dispute (Stripe's, or the event's copy of it) this module reads. */
export interface DisputeLike {
  id: string;
  status?: string | null;
  amount?: number | null;
  charge?: unknown;
  payment_intent?: unknown;
}

const isMissing = (err: unknown): boolean => (err as { code?: string } | null)?.code === "resource_missing";

/**
 * The invoice and payment intent a dispute is about. The dispute names its payment intent in newer API versions and always names its
 * charge, which is retrieved when the intent is not there. `ok: false`: Stripe could not be asked (the event is retried).
 */
export async function disputedPayment(stripe: ReversalStripe | null, d: DisputeLike): Promise<{ ok: true; invoice?: unknown; paymentIntent?: unknown } | { ok: false }> {
  if (d.payment_intent) return { ok: true, paymentIntent: d.payment_intent };
  const chargeId = idOf(d.charge);
  if (!chargeId) return { ok: true };
  if (!stripe) return { ok: false };
  try {
    const c = (await withStripeTimeout(stripe.charges.retrieve(chargeId))) as { invoice?: unknown; payment_intent?: unknown };
    return { ok: true, invoice: c.invoice, paymentIntent: c.payment_intent };
  } catch (err) {
    // A charge Stripe says does not exist (another account's, or a deleted test object) can never be resolved by a redelivery.
    return isMissing(err) ? { ok: true } : { ok: false };
  }
}

type Fetched = { ok: true; dispute: DisputeLike } | { ok: true; missing: true } | { ok: false };

async function fetchDispute(stripe: ReversalStripe | null, id: string): Promise<Fetched> {
  if (!stripe?.disputes) {
    console.error("[GridForge] cannot read a dispute: no Stripe client with disputes");
    return { ok: false };
  }
  try {
    const d = (await withStripeTimeout(stripe.disputes.retrieve(id))) as DisputeLike | null;
    if (!d || typeof d !== "object") return { ok: false };
    return { ok: true, dispute: { ...d, id } };
  } catch (err) {
    return isMissing(err) ? { ok: true, missing: true } : { ok: false };
  }
}

const rowsOf = (found: Entitlements): { table: AuditEntry["table"]; id: string; hold: HoldKind | null | undefined; ref: string | null | undefined }[] => [
  ...(found.api ? [{ table: "api_accounts" as const, id: found.api.id, hold: found.api.billing_hold, ref: found.api.billing_hold_ref }] : []),
  ...(found.watch ? [{ table: "watches" as const, id: found.watch.id, hold: found.watch.billing_hold, ref: found.watch.billing_hold_ref }] : []),
  ...(found.intelligence ? [{ table: "subscriptions" as const, id: found.intelligence.id, hold: found.intelligence.billing_hold, ref: found.intelligence.billing_hold_ref }] : []),
];

/**
 * Decide one dispute event. `payload` is the event's copy (possibly stale: only its id is trusted); `eventType` is for the record only.
 * `ok: false` = answer 500 so Stripe redelivers.
 */
export async function reconcileDispute(p: { payload: DisputeLike; stripe: ReversalStripe | null; eventId: string; created?: number }): Promise<Handled> {
  const id = p.payload.id;
  const fetched = await fetchDispute(p.stripe, id);
  if (!fetched.ok) return { ok: false, why: "dispute could not be read from Stripe" };

  if ("missing" in fetched) {
    // Stripe has no such dispute: a redelivery cannot change that. Acknowledge, with a record.
    const a = await recordBillingAudit({ dedupeKey: `dispute_not_found:${id}`, table: "stripe_disputes", subjectId: id, action: "dispute_not_found", eventId: p.eventId, objectId: id, detail: {} });
    if (a === "error" || a === "unavailable") {
      await notifyOperatorOnce(`dispute_not_found:${id}`, "A Stripe dispute event names a dispute Stripe does not have", `Dispute ${id} was named by event ${p.eventId} but Stripe answers that it does not exist. Nothing was changed and the event was acknowledged (a retry cannot fix it).`);
    }
    return { ok: true };
  }

  const d = { ...p.payload, ...fetched.dispute };
  const status = typeof d.status === "string" ? d.status : "";
  const state = classifyDispute(status);
  if (state === "unknown") {
    await notifyOperatorOnce(`dispute_status_unknown:${id}:${status}`, `Stripe dispute ${id} has a status this site has no rule for`, `Stripe reports dispute ${id} as "${status}". Nothing was changed. Decide by hand whether the customer's access should be held.`);
    return { ok: true };
  }
  if (state === "inquiry") return { ok: true }; // an early-warning inquiry: no money has moved

  const via = await disputedPayment(p.stripe, d);
  if (!via.ok) return { ok: false, why: "payment could not be read" };
  const owner = await subscriptionOfPayment(p.stripe, { invoice: via.invoice, paymentIntent: via.paymentIntent });
  if (!owner.ok) return { ok: false, why: "payment could not be resolved to its subscription" };

  // A pay-as-you-go settlement invoice has no subscription: its own rules.
  const settlement = settlementRefOf(owner);
  if (settlement !== null) return reverseSettlement({ s: settlement, ev: { kind: "dispute", ref: id, status, state, amountCents: cents(d.amount) }, eventId: p.eventId, created: p.created });
  if (!owner.subscriptionId) {
    // Not a subscription: a one-time purchase (lib/one-time-holds.ts), or somebody else's payment on the account, which changes nothing.
    // An open or lost dispute holds it; one that was WON lifts exactly the hold it caused; an inquiry already returned above.
    if (state === "open" || state === "lost") return holdOneTimePurchase({ kind: "disputed", ref: id, paymentIntent: via.paymentIntent, stripe: p.stripe, eventId: p.eventId, lost: state === "lost" });
    if (LIFTS_DISPUTE_HOLD.includes(state as DisputeState)) return liftOneTimeDispute({ dispute: id, paymentIntent: via.paymentIntent, stripe: p.stripe, eventId: p.eventId });
    return { ok: true };
  }

  let found: Entitlements | undefined;
  let decision: "hold" | "lift" | "none" = "none";
  if (state === "open" || state === "lost") {
    const out = await reversePayment({ kind: "disputed", ref: id, stripe: p.stripe, eventId: p.eventId, created: p.created, owner });
    if (!out.ok) return out;
    found = out.found;
  } else if (LIFTS_DISPUTE_HOLD.includes(state as DisputeState)) {
    const f = await resolveSubscription(owner.subscriptionId);
    if (!f.ok) return { ok: false, why: "subscription lookup failed" };
    found = f;
    // No event time can make this stale: the dispute's state was read from Stripe just now.
    const lifted = await liftHold(f, { kinds: ["disputed"], ref: id, restore: "prev", cause: "dispute_won", clock: "none", subscriptionId: owner.subscriptionId, eventId: p.eventId });
    if (!lifted.ok) return { ok: false, why: "dispute hold could not be lifted" };
    decision = lifted.lifted.api || lifted.lifted.watch || lifted.lifted.intelligence ? "lift" : "none";
    // The dispute may have REPLACED a pause (one hold column); billing may still be paused at Stripe, and then the pause goes back at once.
    if (decision === "lift" || (await liftedByEvent(p.eventId))) {
      const again = await reassertPause(owner.subscriptionId, p.stripe, { id: p.eventId });
      if (!again.ok) return { ok: false, why: "pause could not be re-checked after the lift" };
    }
  }
  if (!found) return { ok: true };

  let ok = true;
  for (const r of rowsOf(found)) {
    const holds = r.hold === "disputed" && r.ref === id;
    if (state === "lost" && holds) {
      if ((await recordBillingAudit({ dedupeKey: `dispute_lost:${id}:${r.table}:${r.id}`, table: r.table, subjectId: r.id, action: "dispute_lost_hold_stands", eventId: p.eventId, objectId: id, invoiceId: owner.invoiceId, subscriptionId: owner.subscriptionId })) === "error") ok = false;
    }
    // One row per dispute and state however many events carried it (the decision may be "none": the state is what is on record).
    const seen = await recordBillingAudit({
      dedupeKey: `dispute_state:${id}:${status}:${r.table}:${r.id}`,
      table: r.table,
      subjectId: r.id,
      action: "dispute_state",
      eventId: p.eventId,
      objectId: id,
      invoiceId: owner.invoiceId,
      subscriptionId: owner.subscriptionId,
      detail: { status, decision: state === "open" || state === "lost" ? (holds ? "hold" : "none") : decision },
    });
    if (seen === "error") ok = false;
  }
  return ok ? { ok: true } : { ok: false, why: "dispute state could not be recorded" };
}
