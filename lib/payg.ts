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

/**
 * Common free-mail providers. A free account from one of these is NOT subject to the per-domain cap below: one provider hosts millions of unrelated people,
 * so "this domain already has N accounts" says nothing about abuse. Every other domain (a company, a university, or a catch-all domain an attacker bought for
 * the purpose) is a domain whose mailboxes a single party can mint without limit, which is what the cap exists for. Not exhaustive and not a claim about any
 * provider: a free-mail domain missing here is simply capped like any other, and a disposable-mail domain is capped as its own domain. Lower-case, exact match
 * (a sub-domain of a listed name is not listed).
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch", "web.de", "mail.com", "zoho.com", "fastmail.com", "hey.com",
  "tutanota.com", "tuta.io", "t-online.de", "freenet.de", "yandex.com", "yandex.ru", "mail.ru", "bk.ru", "inbox.ru", "list.ru", "qq.com", "163.com", "126.com",
  "sina.com", "naver.com", "daum.net", "hanmail.net", "orange.fr", "free.fr", "laposte.net", "wanadoo.fr", "sfr.fr", "libero.it", "virgilio.it", "tiscali.it",
  "btinternet.com", "sky.com", "talktalk.net", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.es", "yahoo.it", "yahoo.co.jp", "yahoo.com.br", "yahoo.ca",
  "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.es", "hotmail.it", "outlook.fr", "outlook.de", "outlook.es", "outlook.it", "live.co.uk", "live.fr",
  "live.nl", "ziggo.nl", "hetnet.nl", "kpnmail.nl", "telenet.be", "skynet.be", "bluewin.ch", "seznam.cz", "centrum.cz", "wp.pl", "o2.pl", "onet.pl", "interia.pl",
  "rediffmail.com", "bigpond.com", "optusnet.com.au", "shaw.ca", "rogers.com", "sympatico.ca", "comcast.net", "verizon.net", "att.net", "sbcglobal.net",
  "bellsouth.net", "cox.net", "charter.net",
]);

/** The default cap on VERIFIED free accounts per non-free-mail domain per UTC month. Well under the site-wide ceiling (PAYG.freeAccountsMaxPerMonth): no one domain can be the whole allowance. */
export const FREE_ACCOUNTS_MAX_PER_DOMAIN_DEFAULT = 10;

/** The per-domain monthly cap: GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN when it is an integer from 1 to 100000, else the default. (There is no "0" or "off": use a large number.) */
export function freeAccountsMaxPerDomain(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GRIDFORGE_FREE_ACCOUNTS_MAX_PER_DOMAIN?.trim();
  if (raw && /^\d{1,6}$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 100000) return n;
  }
  return FREE_ACCOUNTS_MAX_PER_DOMAIN_DEFAULT;
}

// Second-level labels under a two-letter country code that make a name like evil.co.uk or evil.com.au (three labels, not two).
const TWO_PART_SUFFIX_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "gob", "ltd", "plc", "sch", "nom"]);

/**
 * The name a domain's accounts are grouped under: its last two labels, or its last three under a short list of two-part suffixes (co.uk, com.au, ...), so that
 * a wildcard catch-all (anything.evil.example) is ONE domain, not a fresh one per sub-domain. A heuristic, not the Public Suffix List: an unusual suffix
 * groups too broadly or too narrowly; the site-wide ceiling still bounds the total.
 */
export function freeDomainKey(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  return labels.slice(tld.length === 2 && TWO_PART_SUFFIX_LABELS.has(sld) ? -3 : -2).join(".");
}

/** What the per-domain cap is for this address: null when it is exempt (free-mail) or has no usable domain, else the domain key to count under and the cap. */
export function freeDomainCap(rawEmail: unknown, env: NodeJS.ProcessEnv = process.env): { key: string; max: number } | null {
  const norm = normaliseFreeEmail(rawEmail);
  if (!norm) return null;
  const domain = norm.slice(norm.lastIndexOf("@") + 1);
  const key = freeDomainKey(domain);
  if (FREE_MAIL_DOMAINS.has(domain) || FREE_MAIL_DOMAINS.has(key)) return null;
  return { key, max: freeAccountsMaxPerDomain(env) };
}

/** The scope the engine sees, by plan. */
export function scopeForPlan(plan: string): "trial" | "payg" | "machine" {
  return plan === "api_free" ? "trial" : plan === "api_payg" ? "payg" : "machine";
}

let processKey: Buffer | null = null;

let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[GridForge] ${message}`);
}

/**
 * The key for account references and once-only keys: FUNNEL_REF_KEY. It is REQUIRED for stable funnel cohorts: references and
 * once-only keys derived from the key-signing secret change when that secret is rotated, which would re-fire every once-only event and
 * split every cohort in two. The old derivation from GRIDFORGE_KEY_SECRET remains only as a fallback, with a warning, so a deployment
 * that never set FUNNEL_REF_KEY keeps the references it already has until it does (set it to the SAME value you are using today only if
 * you want continuity: the two derivations differ, so switching starts new references).
 */
function refKey(): Buffer {
  const dedicated = process.env.FUNNEL_REF_KEY;
  if (dedicated && dedicated.length >= 16) return crypto.createHmac("sha256", dedicated).update("gf-funnel-ref-v2").digest();
  const secret = process.env.GRIDFORGE_KEY_SECRET;
  if (secret) {
    warnOnce("FUNNEL_REF_KEY is not set: funnel references are derived from GRIDFORGE_KEY_SECRET and will change if it is rotated. Set FUNNEL_REF_KEY (16+ characters) for stable cohorts.");
    return crypto.createHmac("sha256", secret).update("gf-funnel-ref-v2").digest();
  }
  warnOnce("Neither FUNNEL_REF_KEY nor GRIDFORGE_KEY_SECRET is set: funnel references use a per-process key and are not stable across restarts.");
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
