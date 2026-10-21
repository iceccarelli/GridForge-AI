// Pure helpers for pay-as-you-go billing: months, caps, the free-allowance email identity. No I/O.
//
// Every number comes from PAYG in lib/products.ts (mirrored by gridforge/commercial.py and proved equal in
// tests/test_catalogue_parity.py). Nothing here hand-types a price, a cap bound or an allowance.

import crypto from "node:crypto";
import { PAYG, paygCapUnits, paygChargeCents } from "@/lib/products";

export { PAYG, paygCapUnits, paygChargeCents };

/** The one billing rule, worded once (lib/payg-pricing.ts), identical to the engine's BILLING_RULE; tests/site/payg-billing-rule.test.ts pins them. */
export { billingRuleText } from "@/lib/payg-pricing";

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' (UTC) of an instant. */
export function utcMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** [from, to) of a UTC month as ISO instants. */
export function monthBounds(month: string): { from: string; to: string } {
  if (!MONTH.test(month)) throw new Error(`not a month: ${month}`);
  const [y, m] = month.split("-").map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
}

export function nextMonth(month: string): string {
  return utcMonth(new Date(monthBounds(month).to));
}

/**
 * The identity a free allowance is claimed against: lower-cased, and with the "+tag" suffix and (for Gmail) the dots removed,
 * so alice+1@x, alice+2@x are one claim. This is a bound on casual farming, not a proof of identity: the key is only ever
 * minted from the emailed link, which is the email verification.
 */
export function normaliseFreeEmail(raw: unknown): string | null {
  const clean = cleanEmail(raw);
  if (!clean) return null;
  const at = clean.lastIndexOf("@");
  let local = clean.slice(0, at);
  let domain = clean.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * The address as it will be mailed to: Unicode NFKC-normalised (so fullwidth or compatibility forms of an address are the plain one),
 * lower-cased, a trailing dot on the domain removed (alice@example.com. is alice@example.com), and refused outright if it is not a
 * plain dot-atom address: quoted local parts, whitespace, control characters, empty or leading/trailing-dash domain labels.
 */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 400) return null;
  const e = raw.normalize("NFKC").trim().toLowerCase();
  if (e.length < 5 || e.length > 254) return null;
  if (/[\s\u0000-\u001f\u007f"(),:;<>[\]\\]/.test(e)) return null; // quoted local parts, comments, groups, control characters
  const at = e.lastIndexOf("@");
  if (at < 1 || e.indexOf("@") !== at) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1).replace(/\.+$/, "");
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9-]{1,63}$/.test(l) || l.startsWith("-") || l.endsWith("-"))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null; // an IP literal is not a mailbox we will write to
  return `${local}@${domain}`;
}

/** A cap in whole euros, within PAYG's bounds; null otherwise. Accepts a number or a numeric string, never a float. */
export function parseCapEur(v: unknown): number | null {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  if (n < PAYG.minCapEur || n > PAYG.maxCapEur) return null;
  return n;
}

/** The site-wide ceiling on new free accounts per UTC month. GRIDFORGE_FREE_ACCOUNTS_MAX overrides the catalogue default. */
export function freeAccountsMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GRIDFORGE_FREE_ACCOUNTS_MAX;
  if (raw !== undefined && /^\d{1,6}$/.test(raw.trim())) return Number(raw.trim());
  return PAYG.freeAccountsMaxPerMonth;
}

/** The scope the engine sees, by plan. */
export function scopeForPlan(plan: string): "trial" | "payg" | "machine" {
  return plan === "api_free" ? "trial" : plan === "api_payg" ? "payg" : "machine";
}

let processKey: Buffer | null = null;

/** The key for account references: dedicated FUNNEL_REF_KEY, else derived (domain-separated) from the key-signing secret. */
function refKey(): Buffer {
  const dedicated = process.env.FUNNEL_REF_KEY;
  if (dedicated && dedicated.length >= 16) return crypto.createHmac("sha256", dedicated).update("gf-funnel-ref-v2").digest();
  const secret = process.env.GRIDFORGE_KEY_SECRET;
  if (secret) return crypto.createHmac("sha256", secret).update("gf-funnel-ref-v2").digest();
  // Development and tests only: a per-process key. Never a constant: a bare hash of an account id could be recomputed from a guess.
  return (processKey ??= crypto.randomBytes(32));
}

/**
 * A short, non-reversible reference for an account, safe to put in a product event. An HMAC under a server secret (a bare SHA-256 of
 * a guessable id could be confirmed by anyone who can guess the id), with a domain-separation label so the same secret signing keys
 * never produces these.
 */
export function accountRef(account: string): string {
  return crypto.createHmac("sha256", refKey()).update(`account:${account}`).digest("hex").slice(0, 12);
}

/**
 * The stored form of a once-only key. Callers build keys from things like a Stripe subscription id or a checkout session id, and those
 * must not sit in the funnel table in the clear (they are identifiers an outsider could look up): the table holds only this opaque
 * keyed digest, which still makes "once" exact.
 */
export function funnelKey(key: string): string {
  return crypto.createHmac("sha256", refKey()).update(`dedupe:${key}`).digest("hex").slice(0, 32);
}

export const eurText = (cents: number) => `EUR ${(cents / 100).toFixed(2)}`;
