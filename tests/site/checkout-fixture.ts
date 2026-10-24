/**
 * The ONE place a test builds a Stripe Checkout Session for the webhook.
 *
 * Stripe puts `payment_status` on every Checkout Session it sends. The webhook used to treat a session WITHOUT one as paid, so
 * 23 test files quietly built fabricated sessions that carried no payment state at all and every one of them "passed": a
 * fixture that cannot say whether the money arrived was proving fulfilment of a sale nobody paid for. The webhook now fails
 * closed (app/api/stripe/webhook/route.ts, checkoutIsPaid), and this builder makes the field impossible to forget: the payment
 * status is the FIRST argument, and there is no overload that omits it.
 *
 *   paidSession({ id: "cs_1", metadata: {...} })        a card payment that settled
 *   unpaidSession(...)                                   a delayed method that has not settled yet
 *   noPaymentRequiredSession(...)                        a setup-mode or fully discounted session that owes nothing
 *
 * tests/site/checkout-fixture-guard.test.ts scans every test for a checkout.session.completed fixture that bypasses this module
 * (or states `payment_status` itself) and fails on it.
 *
 * To model a MALFORMED payload (the webhook must refuse it), delete the field on the result: `omitPaymentStatus(paidSession(...))`.
 * That is deliberate, named and greppable, instead of a fixture that lacks the field by accident.
 */

export type CheckoutPaymentStatus = "paid" | "unpaid" | "no_payment_required";

export function checkoutSession(
  paymentStatus: CheckoutPaymentStatus,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  // `fields` is spread LAST so a test can still override anything (a different `object`, an `id`), including `payment_status`
  // for a scenario that is about an unusual value; an override is visible in the test, not hidden in a helper.
  return { object: "checkout_session", payment_status: paymentStatus, ...fields };
}

export const paidSession = (fields: Record<string, unknown> = {}) => checkoutSession("paid", fields);
export const unpaidSession = (fields: Record<string, unknown> = {}) => checkoutSession("unpaid", fields);
export const noPaymentRequiredSession = (fields: Record<string, unknown> = {}) => checkoutSession("no_payment_required", fields);

/** A session as a hand-built or truncated payload would have it: Stripe never sends this; the webhook must refuse to read it. */
export function omitPaymentStatus(session: Record<string, unknown>): Record<string, unknown> {
  const { payment_status: _omitted, ...rest } = session;
  return rest;
}

/** The event envelope around a session. */
export function checkoutEvent(
  session: Record<string, unknown>,
  opts: { id?: string; type?: "checkout.session.completed" | "checkout.session.async_payment_succeeded" | "checkout.session.async_payment_failed" } = {}
): { id: string; type: string; data: { object: Record<string, unknown> } } {
  return {
    id: opts.id ?? `evt_${String(session.id ?? "checkout")}`,
    type: opts.type ?? "checkout.session.completed",
    data: { object: session },
  };
}
