// Server-only: is the money behind a one-off engagement still there?
//
// A buyer pays by Checkout, the operator reviews and releases the pack by hand. Between those two moments the payment can be
// refunded in the Stripe Dashboard or disputed by the card issuer, and the webhook only counts those events. Release is the
// one irreversible step (the buyer then holds the work), so it asks Stripe directly, at that moment, rather than trusting a
// state that was true when the session completed.
//
//   ok                  paid in full, no dispute (a partial refund is reported, not blocking)
//   refunded / disputed the work should not be handed over without a person deciding to
//   unchecked           nothing to ask: no Stripe key, no session on the row, or no payment was due
//   unavailable         Stripe was asked and did not answer: standing unknown

import Stripe from "stripe";

export type PaymentStanding =
  | { state: "ok"; partial_refund_cents: number }
  | { state: "refunded" | "disputed"; detail: string }
  | { state: "unchecked" }
  | { state: "unavailable" };

type Retrieve = (id: string) => Promise<Stripe.Checkout.Session>;

export async function paymentStanding(sessionId: string | null | undefined, retrieve?: Retrieve): Promise<PaymentStanding> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { state: "unchecked" };
  if (!retrieve && !key) {
    console.warn("[GridForge] STRIPE_SECRET_KEY is not set: the payment standing of an engagement was not checked before release");
    return { state: "unchecked" };
  }
  const ask: Retrieve =
    retrieve ?? ((id) => new Stripe(key as string, { timeout: 8_000, maxNetworkRetries: 1 }).checkout.sessions.retrieve(id, { expand: ["payment_intent.latest_charge"] }));
  let session: Stripe.Checkout.Session;
  try {
    session = await ask(sessionId);
  } catch (err) {
    console.error("[GridForge] could not read the payment standing of a checkout session:", err);
    return { state: "unavailable" };
  }
  if (session.payment_status === "no_payment_required") return { state: "unchecked" };
  const pi = session.payment_intent;
  const charge = pi && typeof pi === "object" ? pi.latest_charge : null;
  if (!charge || typeof charge !== "object") {
    // A paid session whose charge cannot be read is unknown, not fine.
    return session.payment_status === "paid" ? { state: "unavailable" } : { state: "unchecked" };
  }
  if (charge.disputed) return { state: "disputed", detail: "the card issuer has opened a dispute on this payment" };
  const refunded = charge.amount_refunded ?? 0;
  if (charge.refunded || (charge.amount > 0 && refunded >= charge.amount)) {
    return { state: "refunded", detail: "this payment has been refunded in full" };
  }
  return { state: "ok", partial_refund_cents: refunded };
}
