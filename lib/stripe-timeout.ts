// A bound on a Stripe call made while a webhook, the daily job or a customer's request is waiting on it. A call that has not answered in
// STRIPE_CALL_TIMEOUT_MS is a failure of the ordinary kind (a StripeConnectionError), which every caller already treats as "cannot say":
// the event is retried, the pause is not lifted, the mint is refused, the settlement stays pending.
//
// A TIMEOUT IS NEVER AN OUTCOME. The request may still have reached Stripe and succeeded; all we know is that no answer came in time. So a
// caller never records a timed-out call as done, paid or failed, and its retry must be safe whether or not the first attempt landed
// (idempotency key on every create, and a re-read by that key or by metadata before any create: lib/payg-settle.ts).
//
// Two ways to apply the bound, both here so that it is one mechanism:
//   withStripeTimeout(call)   one awaited call (the pause / dispute / refund paths).
//   boundStripe(client)       a whole client: EVERY method of every namespace on it answers within the bound. paygStripe() returns a bounded
//                             client, and the settlement and PAYG webhook handlers bound whatever they are given, so no call on those paths
//                             can be left unbounded by forgetting to wrap it.

export const STRIPE_CALL_TIMEOUT_MS = 8_000;

/** The `code` a timed-out call carries (a category for logs, notices and settlement rows; never a Stripe message). */
export const STRIPE_TIMEOUT_CODE = "stripe_call_timeout";

/** (STRIPE_CALL_TIMEOUT_MS in the environment overrides the bound; tests use it to prove a hanging call is a refusal without waiting 8 s.) */
export function stripeCallTimeoutMs(): number {
  const n = Number(process.env.STRIPE_CALL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : STRIPE_CALL_TIMEOUT_MS;
}

/**
 * Did the call get NO ANSWER in time (our bound, or the SDK's own request timeout), as opposed to Stripe answering with a failure? The
 * call's outcome at Stripe is unknown. The SDK reports its own timeout as a StripeConnectionError whose message says the request timed out
 * (its cause is ETIMEDOUT / an abort); a connection refused or reset is also a StripeConnectionError but is NOT a timeout (nothing reached Stripe).
 */
export function isStripeTimeout(err: unknown): boolean {
  const e = err as { code?: unknown; type?: unknown; message?: unknown; detail?: { code?: unknown; name?: unknown } | null; raw?: { code?: unknown } | null } | null;
  if (!e) return false;
  if (e.code === STRIPE_TIMEOUT_CODE) return true;
  if (e.type !== "StripeConnectionError") return false;
  const causes = [e.code, e.detail?.code, e.raw?.code, e.detail?.name];
  if (causes.some((c) => c === "ETIMEDOUT" || c === "ESOCKETTIMEDOUT" || c === "TimeoutError" || c === "ECONNABORTED")) return true;
  return typeof e.message === "string" && /timed out|timeout being reached|request aborted due to timeout/i.test(e.message);
}

export function withStripeTimeout<T>(call: Promise<T>, ms: number = stripeCallTimeoutMs()): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("stripe call timed out"), { type: "StripeConnectionError", code: STRIPE_TIMEOUT_CODE })), ms);
  });
  // A call that loses the race may still reject later; nobody is waiting for it, so that rejection must not surface as an unhandled one.
  call.catch(() => {});
  return Promise.race([call, limit]).finally(() => clearTimeout(timer));
}

const bounded = new WeakSet<object>();
const proxies = new WeakMap<object, object>();

/**
 * The same client with every method bounded by withStripeTimeout. Synchronous methods (webhooks.constructEvent) and plain values pass
 * through unchanged; namespaces (invoices, checkout.sessions ...) are wrapped as they are reached, so a method added to the interface is
 * bounded without anyone remembering to. Idempotent. Methods are looked up at call time (a test that swaps one in sees the swap).
 */
export function boundStripe<T extends object>(client: T): T {
  if (bounded.has(client)) return client;
  const known = proxies.get(client);
  if (known) return known as T;
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol" || prop === "then") return value;
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out && typeof (out as { then?: unknown }).then === "function" ? withStripeTimeout(out as Promise<unknown>) : out;
        };
      }
      if (value && typeof value === "object") return boundStripe(value as object);
      return value;
    },
  });
  proxies.set(client, proxy);
  bounded.add(proxy);
  return proxy;
}
