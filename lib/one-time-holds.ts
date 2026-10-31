// Server-only: a refunded or disputed ONE-TIME purchase (Density Screen, Procurement Specification) suspends what it paid for.
//
// lib/billing-holds.ts reverses SUBSCRIPTION payments. A charge with no subscription behind it used to fall through ("an engagement
// deposit: nothing of ours to suspend"), so a released Density Screen stayed readable after a full refund or a lost dispute, the intake of
// a refunded purchase still ran the engine, and the "credits in full against the Study" offer stayed on the table.
//
//   charge / dispute -> payment intent -> the Checkout Session that took it -> the row our webhook made from that session
//
// The session is found through Stripe (checkout.sessions.list), the same way a charge is resolved to its invoice for subscriptions, so no
// payment identifier has to be stored. Migration 0045 holds the state; until it is applied the operator is told once per charge and the
// event is acknowledged (a retry cannot add a column).
//
// Precedence: a refund is terminal and outranks a dispute; a dispute outranks nothing. A dispute that is WON lifts exactly the hold it
// caused. A refund is never lifted by an event; an operator who releases a refunded or disputed purchase on purpose (goodwill, a dispute
// they are contesting) does it through the admin release, which lifts the hold and records who and why.
//
// Every decision is an append-only billing_audit row keyed per charge/dispute and subject, so a redelivered event records nothing twice
// and applies nothing twice. Identifiers only: no email, no card, no free text from Stripe.

import { withStripeTimeout } from "@/lib/stripe-timeout";
import { pg } from "@/lib/payg-store";
import { recordBillingAudit } from "@/lib/billing-audit";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import { PRODUCT_BY_KIND } from "@/lib/products";
import type { Handled, ReversalStripe } from "@/lib/billing-holds";

export type OneTimeHold = "refunded" | "disputed";

export interface HoldFields {
  billing_hold?: OneTimeHold | null;
  billing_hold_ref?: string | null;
  billing_hold_at?: string | null;
}

const idOf = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : "");
const q = encodeURIComponent;

type Subject = { table: "deliverables"; id: string; kind: string; hold: OneTimeHold | null; ref: string | null } | { table: "engagement_deposits"; id: string; kind: string };
type Found = { ok: true; subject: Subject | null; sessionKind: string | null } | { ok: false } | { ok: true; unmigrated: true };

/** Does this Checkout Session kind belong to a one-time purchase of ours? Subscriptions and pay-as-you-go are decided elsewhere. */
function oneTimeKind(kind: string): "deliverable" | "deposit" | null {
  if (kind === "engagement_deposit") return "deposit";
  const p = PRODUCT_BY_KIND[kind];
  if (!p || p.recurring) return null;
  if (p.producesDeliverable) return "deliverable";
  return p.opensBandCents ? "deposit" : null;
}

const missingColumn = (r: { ok: boolean; status: number; code?: string }) => !r.ok && r.status === 400 && (r.code === "42703" || r.code === "PGRST204");

async function sessionOfPayment(stripe: ReversalStripe | null, paymentIntent: unknown): Promise<{ ok: true; id: string; kind: string } | { ok: true; none: true } | { ok: false }> {
  const pi = idOf(paymentIntent);
  if (!pi) return { ok: true, none: true };
  if (!stripe?.checkout?.sessions?.list) {
    console.error("[GridForge] cannot resolve a one-time payment to its checkout session: no Stripe client with checkout.sessions");
    return { ok: false };
  }
  try {
    const list = await withStripeTimeout(stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 }));
    const s = list.data?.[0];
    if (!s?.id) return { ok: true, none: true };
    return { ok: true, id: s.id, kind: typeof s.metadata?.kind === "string" ? s.metadata.kind : "" };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "resource_missing") return { ok: true, none: true };
    console.error("[GridForge] could not resolve a one-time payment to its checkout session:", (err as { type?: string })?.type ?? "stripe_error");
    return { ok: false };
  }
}

async function findSubject(stripe: ReversalStripe | null, paymentIntent: unknown): Promise<Found> {
  const s = await sessionOfPayment(stripe, paymentIntent);
  if (!s.ok) return { ok: false };
  if ("none" in s) return { ok: true, subject: null, sessionKind: null };
  const route = oneTimeKind(s.kind);
  if (!route) return { ok: true, subject: null, sessionKind: null }; // a subscription, pay-as-you-go or somebody else's payment on the account
  if (route === "deliverable") {
    const r = await pg<{ id: string; kind: string; billing_hold: OneTimeHold | null; billing_hold_ref: string | null }[]>(
      "GET",
      `deliverables?stripe_session_id=eq.${q(s.id)}&select=id,kind,billing_hold,billing_hold_ref&limit=1`
    );
    if (missingColumn(r)) return { ok: true, unmigrated: true };
    if (!r.ok) return { ok: false };
    const row = r.data?.[0];
    return { ok: true, sessionKind: s.kind, subject: row ? { table: "deliverables", id: row.id, kind: row.kind, hold: row.billing_hold ?? null, ref: row.billing_hold_ref ?? null } : null };
  }
  const r = await pg<{ id: string; kind: string }[]>("GET", `engagement_deposits?stripe_session_id=eq.${q(s.id)}&select=id,kind&limit=1`);
  if (!r.ok) return { ok: false };
  const row = r.data?.[0];
  return { ok: true, sessionKind: s.kind, subject: row ? { table: "engagement_deposits", id: row.id, kind: row.kind } : null };
}

const now = () => new Date().toISOString();

async function told(key: string, subject: string, text: string): Promise<void> {
  await notifyOperatorOnce(key, subject, text);
}

/**
 * charge.refunded (full) and an open or lost dispute, for a payment with no subscription behind it. `ok: false` = answer 500 so Stripe
 * redelivers (Stripe could not be asked, the store failed, or the purchase's own checkout event has not been processed yet).
 */
export async function holdOneTimePurchase(p: { kind: OneTimeHold; ref: string; paymentIntent: unknown; stripe: ReversalStripe | null; eventId: string; lost?: boolean }): Promise<Handled> {
  const found = await findSubject(p.stripe, p.paymentIntent);
  if (!found.ok) return { ok: false, why: "payment could not be resolved to a purchase" };
  if ("unmigrated" in found) {
    await told(
      "migration_0045_missing",
      "Migration 0045 (one-time purchase holds) is not applied",
      `A ${p.kind} charge/dispute (${p.ref}) belongs to a one-time purchase, but deliverables.billing_hold does not exist yet, so access could not be held. ` +
        "Nothing was changed and the event was acknowledged (a retry cannot add a column). Apply supabase/migrations/0045_one_time_purchase_holds.sql, then hold this purchase by hand " +
        "(or ask for the event to be redelivered from Stripe). This notice is sent once."
    );
    return { ok: true };
  }
  if (!found.subject) {
    // A deliverable's row is made by its own checkout event, which Stripe may deliver after the refund: retry until it exists. A deposit
    // may legitimately have no row (one attached to a project records an event instead): audit-free, the operator is told.
    if (found.sessionKind && oneTimeKind(found.sessionKind) === "deliverable") return { ok: false, why: "no record of the purchase yet" };
    if (found.sessionKind) {
      await told(`deposit_reversal_unrecorded:${p.ref}`, `A ${p.kind} deposit payment has no deposit record`, `Stripe ${p.kind === "refunded" ? "charge" : "dispute"} ${p.ref} is for a ${found.sessionKind} checkout with no engagement_deposits row (it may be attached to a project). Nothing was changed; decide by hand.`);
    }
    return { ok: true };
  }

  const s = found.subject;
  if (s.table === "engagement_deposits") {
    // A deposit entitles nothing that can be suspended: scoped work is a person's decision. Audit it and tell the person.
    const a = await recordBillingAudit({ dedupeKey: `onetime_deposit:${p.kind}:${p.ref}:${s.id}`, table: "engagement_deposits", subjectId: s.id, action: `deposit_${p.kind}`, eventId: p.eventId, objectId: p.ref, detail: { kind: s.kind } });
    if (a === "error") return { ok: false, why: "deposit reversal could not be recorded" };
    if (a === "recorded") {
      await told(`deposit_reversal:${p.kind}:${p.ref}`, `A ${s.kind} deposit was ${p.kind}`, `Deposit ${s.id} (${s.kind}): Stripe ${p.kind === "refunded" ? "charge" : "dispute"} ${p.ref} reverses its payment. Scoped work is not stopped automatically: decide whether to continue, and do not apply it as a credit.`);
    }
    return { ok: true };
  }

  // Precedence. A refund is terminal; a dispute never replaces a hold that stands.
  let applied = false;
  if (p.kind === "refunded") {
    if (s.hold === "refunded") applied = false;
    else {
      const set = { billing_hold: "refunded", billing_hold_ref: p.ref, billing_hold_at: now() };
      let r = await pg<{ id: string }[]>("PATCH", `deliverables?id=eq.${q(s.id)}&billing_hold=is.null`, set);
      if (r.ok && !(r.data?.length)) r = await pg<{ id: string }[]>("PATCH", `deliverables?id=eq.${q(s.id)}&billing_hold=eq.disputed`, set);
      if (!r.ok) return { ok: false, why: "refund hold could not be written" };
      applied = (r.data?.length ?? 0) > 0;
    }
  } else if (!s.hold) {
    const r = await pg<{ id: string }[]>("PATCH", `deliverables?id=eq.${q(s.id)}&billing_hold=is.null`, { billing_hold: "disputed", billing_hold_ref: p.ref, billing_hold_at: now() });
    if (!r.ok) return { ok: false, why: "dispute hold could not be written" };
    applied = (r.data?.length ?? 0) > 0;
  }
  const a = await recordBillingAudit({
    dedupeKey: `onetime_hold:${p.kind}:${p.ref}:${s.id}`,
    table: "deliverables",
    subjectId: s.id,
    action: applied ? "hold_applied" : "hold_stands",
    eventId: p.eventId,
    objectId: p.ref,
    detail: { kind: p.kind, product: s.kind, previous: s.hold },
  });
  if (a === "error") return { ok: false, why: "hold decision could not be recorded" };
  // A lost dispute is the end of the matter, and is on the record as its own decision (as it is for a subscription).
  if (p.lost) {
    const l = await recordBillingAudit({ dedupeKey: `onetime_dispute_lost:${p.ref}:${s.id}`, table: "deliverables", subjectId: s.id, action: "dispute_lost_hold_stands", eventId: p.eventId, objectId: p.ref, detail: { product: s.kind } });
    if (l === "error") return { ok: false, why: "lost dispute could not be recorded" };
  }
  return { ok: true };
}

/** A dispute that was WON (or resolved) lifts exactly the hold that dispute caused. A refund hold, or another dispute's, is untouched. */
export async function liftOneTimeDispute(p: { dispute: string; paymentIntent: unknown; stripe: ReversalStripe | null; eventId: string }): Promise<Handled & { lifted?: boolean }> {
  const found = await findSubject(p.stripe, p.paymentIntent);
  if (!found.ok) return { ok: false, why: "payment could not be resolved to a purchase" };
  if ("unmigrated" in found || !found.subject || found.subject.table !== "deliverables") return { ok: true, lifted: false };
  const s = found.subject;
  if (s.hold !== "disputed" || s.ref !== p.dispute) return { ok: true, lifted: false };
  const r = await pg<{ id: string }[]>("PATCH", `deliverables?id=eq.${q(s.id)}&billing_hold=eq.disputed&billing_hold_ref=eq.${q(p.dispute)}`, { billing_hold: null, billing_hold_ref: null, billing_hold_at: null });
  if (!r.ok) return { ok: false, why: "dispute hold could not be lifted" };
  const lifted = (r.data?.length ?? 0) > 0;
  const a = await recordBillingAudit({ dedupeKey: `onetime_lift:dispute_won:${p.dispute}:${s.id}`, table: "deliverables", subjectId: s.id, action: "hold_lifted", eventId: p.eventId, objectId: p.dispute, detail: { cause: "dispute_won", product: s.kind } });
  if (a === "error") return { ok: false, why: "lift could not be recorded" };
  return { ok: true, lifted };
}

/**
 * An operator releases a held purchase ON PURPOSE (a goodwill delivery, a dispute they have decided to contest): the admin release has
 * already demanded acknowledge_payment_issue. The hold is lifted and the decision is on the record. Returns false if the store failed.
 */
export async function releaseHoldByOperator(row: { id: string } & HoldFields, why: string): Promise<boolean> {
  if (!row.billing_hold) return true;
  const r = await pg<{ id: string }[]>("PATCH", `deliverables?id=eq.${q(row.id)}&billing_hold=eq.${row.billing_hold}`, { billing_hold: null, billing_hold_ref: null, billing_hold_at: null });
  if (!r.ok) return false;
  const a = await recordBillingAudit({
    dedupeKey: `onetime_lift:operator:${row.billing_hold_ref ?? "none"}:${row.id}`,
    table: "deliverables",
    subjectId: row.id,
    action: "hold_lifted",
    objectId: row.billing_hold_ref ?? undefined,
    detail: { cause: "operator_acknowledged", hold: row.billing_hold, why: why.slice(0, 120) },
  });
  return a !== "error";
}

/**
 * What a buyer-facing path answers while a purchase is on hold, or null. 402, not 404: the link is right and the buyer is owed an
 * explanation. No amount, no card, no Stripe identifier.
 */
export function paymentHoldAnswer(row: HoldFields | null | undefined): { status: 402; body: { ok: false; payment_hold: OneTimeHold; error: string } } | null {
  const hold = row?.billing_hold;
  if (hold !== "refunded" && hold !== "disputed") return null;
  return {
    status: 402,
    body: {
      ok: false,
      payment_hold: hold,
      error:
        hold === "refunded"
          ? "This purchase was refunded, so the document and its working files are no longer available. If this is a mistake, reply to your receipt."
          : "The payment for this purchase is in dispute with the card issuer, so access is paused while it is resolved. If this is a mistake, reply to your receipt and we will sort it out.",
    },
  };
}
