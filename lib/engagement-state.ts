// Pure rules about where a paid engagement stands and when a person has to look at it. No I/O, importable anywhere.
//
// Three things live here because they were previously implied by prose or by nothing:
//
//   1. WHEN A `generating` ROW IS STALE. Generation runs inside one request (app/api/intake/[token], maxDuration 120 s).
//      If that invocation dies, the row stays `generating`; nothing else moves it, and every recovery action accepted only
//      other statuses. The claim now carries a timestamp and a row older than the request could possibly have lived is
//      stale and recoverable.
//   2. WHEN PAID WORK IS OVERDUE FOR A HUMAN. These are INTERNAL review thresholds that decide what the operator's
//      attention list shows. They are not promises to a customer and are never shown to one: how fast the work is done
//      is stated per engagement, as a date a named person recorded (deposits) or not at all.
//   3. WHAT A DEPOSIT STATES. Reserves / opens / credit / timing, derived from the catalogue so the figures cannot drift.

import { PRODUCTS, PRODUCT_BY_KIND, eurFromCents } from "@/lib/products";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The intake route's maxDuration is 120 s and every engine call inside it is bounded below that (ENGINE_CALL_TIMEOUT_MS). */
export const GENERATING_STALE_MS = 10 * MINUTE;

/** Per engine call during generation. Calls run concurrently, so the request's wall time is about the slowest one; this keeps it, with the storage writes, inside maxDuration (120 s). */
export const ENGINE_CALL_TIMEOUT_MS = 100_000;

/** Operator review thresholds (internal; see the header). Days since the event named. */
export const REVIEW_AFTER_DAYS = {
  /** Paid, intake link issued, no numbers submitted. */
  intake_not_submitted: 3,
  /** A draft is waiting for a person to review and release it. */
  draft_unreviewed: 2,
  /** A deposit is paid and nobody has recorded contacting the buyer. */
  deposit_uncontacted: 2,
  /** A deposit was contacted and the scope has not been recorded. */
  deposit_unscoped: 7,
  /** A Hall Watch is paid and the buyer has submitted no numbers, so it cannot run. */
  watch_no_numbers: 7,
} as const;

export const days = (n: number) => n * DAY;

interface GeneratingRow {
  status?: string | null;
  intake?: unknown;
  created_at?: string | null;
}

/** When the current generation claim was taken, or null if the row carries no stamp (a claim made before stamping existed). */
export function generatingSince(row: GeneratingRow): number | null {
  const meta = (row.intake as { _gridforge?: { generating_since?: unknown } } | null | undefined)?._gridforge;
  const t = typeof meta?.generating_since === "string" ? Date.parse(meta.generating_since) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** The raw claim stamp stored on the row, as the compare-and-set must match it; null when the row has none. */
export function generatingStampOf(row: GeneratingRow): string | null {
  const meta = (row.intake as { _gridforge?: { generating_since?: unknown } } | null | undefined)?._gridforge;
  return typeof meta?.generating_since === "string" ? meta.generating_since : null;
}

/**
 * A `generating` row whose request cannot still be running. A row with NO stamp is treated as stale: it was claimed by a
 * version that did not stamp, so its age is unknown, and the alternative (never stale) is the permanent stuck state this
 * exists to end. Recovering a row whose request is in fact alive loses at worst one redundant generation: every write
 * generation makes is a compare-and-set on `generating`.
 */
export function isStaleGenerating(row: GeneratingRow, now: number = Date.now()): boolean {
  if (row.status !== "generating") return false;
  const since = generatingSince(row);
  return since === null || now - since > GENERATING_STALE_MS;
}

/** The marker written with the claim, merged into whatever `_gridforge` the intake already carries. */
export function claimMeta(existing: unknown, now: Date = new Date()): Record<string, unknown> {
  const prev = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  return { ...prev, generating_since: now.toISOString() };
}

// ------------------------------------------------------------------------------------------------ deposits

export interface DepositTerms {
  /** What the payment reserves. */
  reserves: string;
  /** What scope it opens, and how that scope is agreed. */
  opens: string;
  /** How the money is credited. */
  credit: string;
  /** When the work is done, stated without inventing a date. */
  timing: string;
}

/**
 * What a deposit states, exactly, from the catalogue. Returns null for a kind that is not a deposit (the caller then says
 * nothing rather than guess). Every figure is read from lib/products.ts; nothing is typed here.
 */
export function depositTerms(kind: string): DepositTerms | null {
  const p = PRODUCT_BY_KIND[kind];
  if (!p?.opensBandCents) return null;
  const [lo, hi] = p.opensBandCents;
  const band = `${eurFromCents(lo)} to ${eurFromCents(hi)}`;
  const crediting = Object.values(PRODUCTS).filter((x) => x.creditsAgainst === p.id);
  const alsoCredited = crediting.length
    ? ` ${crediting.map((x) => `A ${x.name} you have already paid for (same email address, ${eurFromCents(x.amountCents)} each) is credited against the same fee, once.`).join(" ")}`
    : "";
  return {
    reserves:
      `This ${eurFromCents(p.amountCents)} deposit reserves senior engineering time for one ${p.name.replace(/ — deposit$/, "")}. ` +
      `It is not the fee for the work and it does not buy the document.`,
    opens:
      `It opens a scoping conversation with you. The fee is agreed there, in writing, for the scope agreed there, and falls ` +
      `within ${band}. Nothing is produced until that scope is agreed.`,
    credit:
      `The deposit is credited in full against the agreed fee; the balance is the agreed fee less the deposit.${alsoCredited}`,
    timing:
      `The ${p.turnaroundDays} working days quoted for it count from a complete intake and the scoping call, not from payment. ` +
      `A delivery date is committed when the scope is agreed, and it is recorded against your deposit.`,
  };
}

/** The balance due on an agreed fee after the deposit and any applied credits. Never negative: a credit cannot create a refund. */
export function balanceDueCents(agreedFeeCents: number, depositCents: number, creditCents: number): number {
  return Math.max(0, Math.round(agreedFeeCents) - Math.round(depositCents) - Math.round(creditCents));
}
