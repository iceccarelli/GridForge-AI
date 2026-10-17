// Server-only: who is spending, for the duration of one request.
//
// A route that may reach a paid provider (the capacity engine under the platform key, or Anthropic) establishes a scope
// with `guardRequest` (lib/rate-limit.ts), or runs under `runTrusted` when the caller is authenticated by something
// stronger than a request limit (an operator session, the cron secret). Every provider call is made through
// `engineFetch` / `anthropicFetch`, which look the scope up here. A call made with NO scope is refused in production: a
// new route that forgets to guard itself cannot spend by accident, it fails closed.
//
// This file is a leaf on purpose (no imports from this repository): the helpers that call providers import the gate, and
// the gate imports the counter, so the scope store itself must not import either.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * public   an anonymous or low-trust caller, identified only by the (pseudonymised) address the request came from.
 * customer a holder of a token issued by a purchase, or a verified subscriber: still metered, against a separate budget so
 *          anonymous traffic cannot starve paying customers' fulfilment.
 * trusted  an operator or scheduled job already authenticated by a secret. Not metered here.
 */
export type SpendClass = "public" | "customer" | "trusted";

/** Why trusted work is allowed to spend. A closed list: adding a reason is a reviewed code change, not a string typo. */
export type TrustedReason = "admin-session" | "cron-secret";

export interface SpendDenial {
  status: 429 | 503;
  /** Seconds, for a 429. */
  retryAfter: number | null;
}

export interface SpendScope {
  cls: SpendClass;
  /** HMAC pseudonym of the caller's address; null for trusted work. Never an address. */
  caller: string | null;
  denial: SpendDenial | null;
}

const storage = new AsyncLocalStorage<SpendScope>();

export function currentSpendScope(): SpendScope | undefined {
  return storage.getStore();
}

export function runInSpendScope<T>(scope: SpendScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** Run operator- or scheduler-authenticated work that may spend without a per-caller budget. */
export function runTrusted<T>(_reason: TrustedReason, fn: () => Promise<T>): Promise<T> {
  return storage.run({ cls: "trusted", caller: null, denial: null }, fn);
}
