// The Stripe client for a request or webhook that is waiting on Stripe: a checkout, a subscription, a webhook delivery, the admin
// health check, the post-purchase landing page. Every call answers within STRIPE_CALL_TIMEOUT_MS (lib/stripe-timeout.ts), so a slow or
// unreachable Stripe ends in the failure each route already handles (checkout answers "Could not start checkout" and releases a Founding
// reservation; the webhook answers 500 and Stripe redelivers) instead of holding the buyer's request until the platform kills it.
//
// Same limits as the billing client (paygStripe): the SDK's own timeout sits one second OUTSIDE the race, so the race, which carries the
// stripe_call_timeout code, is what ends a wait, and the SDK never retries by itself (a retry inside the SDK would keep a socket alive after
// the race gave up). A timeout is "cannot say", never an outcome: the call may still have reached Stripe.
import Stripe from "stripe";
import { boundStripe, stripeCallTimeoutMs } from "./stripe-timeout";

export function boundedStripeClient(key: string): Stripe {
  return boundStripe(new Stripe(key, { timeout: stripeCallTimeoutMs() + 1_000, maxNetworkRetries: 0 }));
}
