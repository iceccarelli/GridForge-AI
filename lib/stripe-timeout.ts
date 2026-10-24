// A bound on a Stripe call made while a webhook, the daily job or a customer's request is waiting on it. A call that has not answered in
// STRIPE_CALL_TIMEOUT_MS is a failure of the ordinary kind (no Stripe error code), which every caller already treats as "cannot say":
// the event is retried, the pause is not lifted, the mint is refused. Used on the pause and dispute paths (the SDK's own default is far
// longer than a webhook can afford).

export const STRIPE_CALL_TIMEOUT_MS = 8_000;

/** (STRIPE_CALL_TIMEOUT_MS in the environment overrides the bound; tests use it to prove a hanging call is a refusal without waiting 8 s.) */
const bound = (): number => {
  const n = Number(process.env.STRIPE_CALL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : STRIPE_CALL_TIMEOUT_MS;
};

export function withStripeTimeout<T>(call: Promise<T>, ms: number = bound()): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("stripe call timed out"), { type: "StripeConnectionError" })), ms);
  });
  return Promise.race([call, limit]).finally(() => clearTimeout(timer));
}
