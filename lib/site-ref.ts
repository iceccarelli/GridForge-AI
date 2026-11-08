// Server-only: the reference to a SITE that goes into the calibration ledger.
//
// The ledger (calibration_ledger_rows, exported by /api/admin/calibration-export and imported by `gridforge calibrate import`) never carries a
// site's name, only a short reference. Until migration 0053 that reference was 'site_' + the first 12 hex of the UNSALTED SHA-256 of the
// lower-cased label, so anyone who could guess a label ("Hall A", "Dublin DC1") could confirm it by hashing. It is now
//
//     site_ref = 'site_' + first 12 hex of HMAC-SHA256(key, "site\0" + normalised(label))      normalised = trim, NFC, ASCII lower-case
//
// computed HERE, by the application, and handed to gf_submit_observation in the payload (0053 stores it; before 0053 the old function ignores it
// and derives the unsalted value, so refs are unsalted until 0053 is applied; see lib/project-observations.ts, which says so in the log when
// the database did not keep the value it was given). `gridforge calibrate add` computes the same value from the same environment variables
// (gridforge/calibration/siteref.py); tests/site/site-ref.test.ts and tests/test_site_ref_hmac.py pin the same literal vectors.
//
// THE KEY. GRIDFORGE_SITE_REF_SECRET (16+ characters, counted in Unicode code points), else GRIDFORGE_KEY_SECRET. ROTATING EITHER CHANGES EVERY site_ref FROM THEN ON: the same
// site would appear as a new site, and the independence count (distinct sites) would be wrong across the change. Treat GRIDFORGE_SITE_REF_SECRET as
// a long-lived key and set it separately, so rotating the API-key signing secret does not move every site. Nothing here ever logs a key.
//
// WHEN NEITHER IS SET. Outside a production deployment (a developer machine, CI, a preview: the cases where observations are stamped 'test' and
// can never reach the ledger anyway) a fixed, PUBLIC fallback key is used with a one-time warning, so tests are hermetic and stable. In a
// PRODUCTION deployment (VERCEL_ENV=production) there is no fallback: that key is in this repository, so a ref made with it protects nothing,
// and a per-process random key (what lib/payg.ts does for funnel references, where an unstable value is merely inconvenient) would make the SAME site
// a different site on every restart, which would corrupt the independence count silently. So a production deployment with no secret refuses the
// submission (503, "site reference secret not configured") instead of recording a reference it could not stand behind.

import crypto from "node:crypto";

export const SITE_REF_PATTERN = /^site_[0-9a-f]{12}$/;
/** Counted in CODE POINTS (not UTF-16 units), as Python's len() does, so a secret is long enough in both languages or in neither. */
export const SITE_REF_SECRET_MIN = 16;
const codePoints = (s: string): number => [...s].length;

/**
 * The key used when no secret is configured outside production. PUBLIC and fixed on purpose (tests must be hermetic); a reference made with it is
 * exactly as guessable as the old unsalted hash. gridforge/calibration/siteref.py holds the same string.
 */
export const SITE_REF_FALLBACK_KEY = "gridforge-site-ref-fallback-key-public-NOT-A-SECRET-local-and-test-only";

/** Characters trimmed from both ends of a label: the same explicit set in the Python implementation (a library `trim` differs between languages). */
const EDGE = /^[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g;

/**
 * The label as two spellings of one site would agree on it: trim the explicit whitespace set, normalise to NFC (a composed and a decomposed e-acute are one
 * label), and lower-case ASCII LETTERS ONLY. Empty means there is no label.
 *
 * Why not a full Unicode lower-case: Node and Python carry different Unicode tables (a letter that became cased in a later Unicode version is lower-cased by
 * one runtime and not the other), so the two implementations would silently disagree on exactly the labels where nobody would look. NFC is stable across
 * versions, and ASCII lower-casing is the same everywhere. THE CONSEQUENCE, stated plainly: two spellings of a NON-ASCII label that differ only in the case
 * of a non-ASCII letter (a capital and a small U-diaeresis) are two different sites to this reference, so such a site could be counted twice. Write the label the same
 * way every time. (The old unsalted reference lower-cased with the database's own rules, which is why `calibrate alias` takes the legacy reference from the
 * database for such labels.)
 */
export function normaliseSiteLabel(label: unknown): string {
  if (typeof label !== "string") return "";
  return label.replace(EDGE, "").normalize("NFC").replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Domain separation: the site reference and the hall suffix (siteref.py) are keyed over differently prefixed messages, so one cannot stand for the other. */
const SITE_DOMAIN = "site\u0000";

let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[GridForge] ${message}`);
}
/** For tests only. */
export function resetSiteRefWarning(): void { warned = false; }

export type SiteRefKey =
  | { ok: true; key: string; source: "GRIDFORGE_SITE_REF_SECRET" | "GRIDFORGE_KEY_SECRET" | "fallback" }
  | { ok: false; error: string };

export const SITE_REF_NOT_CONFIGURED = "site reference secret not configured: set GRIDFORGE_SITE_REF_SECRET (16+ characters, counted in Unicode code points). Nothing was recorded.";

/** Which key to use, from the environment. Never returns a value it should not (the key goes to HMAC and nowhere else). */
export function siteRefKey(env: Record<string, string | undefined> = process.env): SiteRefKey {
  const dedicated = env.GRIDFORGE_SITE_REF_SECRET;
  if (dedicated && codePoints(dedicated) >= SITE_REF_SECRET_MIN) return { ok: true, key: dedicated, source: "GRIDFORGE_SITE_REF_SECRET" };
  const signing = env.GRIDFORGE_KEY_SECRET;
  if (signing) {
    warnOnce("GRIDFORGE_SITE_REF_SECRET is not set (or is shorter than 16 characters): site references are keyed with GRIDFORGE_KEY_SECRET and will ALL change if it is rotated, so every site would look new. Set GRIDFORGE_SITE_REF_SECRET and keep it.");
    return { ok: true, key: signing, source: "GRIDFORGE_KEY_SECRET" };
  }
  if (env.VERCEL_ENV === "production") {
    console.error("[GridForge] GRIDFORGE_SITE_REF_SECRET (or GRIDFORGE_KEY_SECRET) is not set on a production deployment: observations are refused (503) until it is, because a site reference made without a secret is a plain hash anyone can confirm.");
    return { ok: false, error: SITE_REF_NOT_CONFIGURED };
  }
  warnOnce("Neither GRIDFORGE_SITE_REF_SECRET nor GRIDFORGE_KEY_SECRET is set: site references use a fixed PUBLIC fallback key. That is for local runs and tests only; those observations are never production data.");
  return { ok: true, key: SITE_REF_FALLBACK_KEY, source: "fallback" };
}

/** site_ + first 12 hex of HMAC-SHA256(key, "site\0" + normalised label); null when the label is empty (no label, no reference). */
export function siteRefFor(label: unknown, key: string): string | null {
  const normalised = normaliseSiteLabel(label);
  if (!normalised) return null;
  return "site_" + crypto.createHmac("sha256", key).update(SITE_DOMAIN + normalised, "utf8").digest("hex").slice(0, 12);
}

/** The reference for a project's site label under the environment's key, or the refusal to send. A label-less project has no reference (null). */
export function siteRefFromEnv(label: unknown, env: Record<string, string | undefined> = process.env): { ok: true; ref: string | null } | { ok: false; error: string } {
  if (!normaliseSiteLabel(label)) return { ok: true, ref: null };
  const k = siteRefKey(env);
  if (!k.ok) return k;
  return { ok: true, ref: siteRefFor(label, k.key) };
}
