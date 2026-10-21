// Pure helpers for pay-as-you-go billing: months, caps, the free-allowance email identity. No I/O.
//
// Every number comes from PAYG in lib/products.ts (mirrored by gridforge/commercial.py and proved equal in
// tests/test_catalogue_parity.py). Nothing here hand-types a price, a cap bound or an allowance.

import crypto from "node:crypto";
import { PAYG, paygCapUnits, paygChargeCents } from "@/lib/products";

export { PAYG, paygCapUnits, paygChargeCents };

/** The one sentence that states the billing rule, identical wherever it is shown (see the contract). */
export function billingRuleText(): string {
  const eur = (c: number) => `EUR ${(c / 100).toFixed(2)}`;
  return (
    `Each month's charge is the month's net units (charges minus refunds, UTC calendar month) x ${eur(PAYG.unitPriceCents)}, ` +
    `invoiced in arrears. A month below ${eur(PAYG.minInvoiceCents)} is carried into the next. ` +
    `Rejected, unauthorised and failed requests are refunded and never charged. The free allowance is never invoiced.`
  );
}

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
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 5 || e.length > 254) return null;
  const m = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(e);
  if (!m) return null;
  let [, local, domain] = m;
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local) return null;
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

/** A short, non-reversible reference for an account, safe to put in a product event. */
export function accountRef(account: string): string {
  return crypto.createHash("sha256").update(`gf-funnel-v1:${account}`).digest("hex").slice(0, 12);
}

export const eurText = (cents: number) => `EUR ${(cents / 100).toFixed(2)}`;
