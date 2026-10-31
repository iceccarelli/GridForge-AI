// What a one-time checkout actually charged, against what the catalogue sells it for.
// The webhook dispatches on metadata.kind, which the checkout route sets, so a session whose amount or currency differs from
// PRODUCTS[kind] (a Dashboard edit, a hand-made payment link carrying the metadata, a price changed mid-flight) would otherwise be
// fulfilled and recorded as the catalogue product without anyone being told. Subscriptions already get this check
// (checkPlanAgainstCatalogue); this is the one-time counterpart. It never blocks fulfilment: the money is taken, so the answer is a
// notice to a person, not a refusal.

import type { Product } from "./products";

export interface ChargedSession {
  amount_subtotal?: number | null;
  amount_total?: number | null;
  currency?: string | null;
}

/**
 * A sentence describing the discrepancy, or null when the session charged the catalogue price in EUR (or there is nothing to compare).
 * Compared on amount_subtotal (before any discount) because only the generic Founding deposit is discounted, and a catalogue product
 * never is; falls back to amount_total when a payload carries no subtotal. Recurring products are checked per subscription instead.
 */
export function oneTimeAmountMismatch(product: Product | undefined, session: ChargedSession): string | null {
  if (!product || product.recurring) return null;
  const charged = session.amount_subtotal ?? session.amount_total;
  if (typeof charged !== "number") return null;
  const currency = (session.currency ?? "eur").toLowerCase();
  const problems: string[] = [];
  if (charged !== product.amountCents) problems.push(`charged ${charged} cents, the catalogue sells it for ${product.amountCents}`);
  if (currency !== "eur") problems.push(`charged in ${currency.toUpperCase()}, the catalogue is EUR`);
  return problems.length ? problems.join("; ") : null;
}
