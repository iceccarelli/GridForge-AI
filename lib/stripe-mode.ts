// Server-only: which Stripe mode this deployment's secret key belongs to, read from the key's PREFIX alone.
//
// A Stripe secret key starts `sk_live_` or `sk_test_` (a restricted key `rk_live_` / `rk_test_`). The prefix is not a secret and this reads
// nothing else of the key; the key itself is never returned, logged or compared with anything but those four prefixes. Anything else
// (unset, a placeholder, a publishable key) is `null`: the mode is not known, and callers must then behave as they did before the check existed.

export type StripeMode = "live" | "test";

export function stripeKeyMode(key: string | undefined): StripeMode | null {
  if (!key) return null;
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return null;
}

/** True only when the key's mode is known, the event states a boolean `livemode`, and the two disagree. */
export function livemodeMismatch(keyMode: StripeMode | null, eventLivemode: unknown): boolean {
  if (keyMode === null || typeof eventLivemode !== "boolean") return false;
  return (eventLivemode ? "live" : "test") !== keyMode;
}
