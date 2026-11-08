// Client-safe, pure: what a project holder may CLAIM about a supplier quotation, and the words the site uses around it.
//
// A claim is a statement made by the person who submitted it. Storing it verifies nothing: it becomes cost evidence only after a person has
// verified the quotation's file and accepted the record (supabase/migrations/0054_project_quotation_claims.sql). Nothing here prices anything,
// and the engine, not this file, decides what an accepted quotation changes.
//
// The honesty line for every surface that shows this (a test fails if a surface says otherwise): GridForge evaluates and applies the
// customer's OWN supplier quotations and compares bids against the engine's specification. It sells no equipment, takes no margin and quotes no
// equipment itself.

import { z } from "zod";

export * from "./cost-evidence-labels";
import { QUOTABLE_KEYS, QUOTE_TYPES, itemFor } from "./cost-evidence-labels";

export const LIMITS = {
  supplier: 120,
  scope: 300,
  notes: 1000,
  reference: 120,
  submittedBy: 120,
  maxPriceEur: 1_000_000_000,
  maxLeadWeeks: 520,
  /** Enforced by the database (GF013); named here so the refusal can say the number. */
  maxClaimsPerProject: 100,
  /** A quotation older than this is not a current price; refused rather than guessed at. */
  maxAgeDays: 5 * 366,
} as const;

/**
 * Code points a reviewer must not be shown in a supplier name, a scope or a reference: controls, invisible formatting characters, direction-changing
 * characters, tag characters and variation selectors. supabase/migrations/0054_project_quotation_claims.sql gf_quotation_text_ok holds the same list
 * (never `[[:cntrl:]]`, whose meaning depends on the cluster's locale); tests/site/project-quotation-claims.realdb.test.ts compares the two code point
 * by code point. Ranges are [first, last] inclusive.
 */
export const BAD_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], // C0 and C1 controls (tab, LF and CR are handled below)
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef], // tag characters, variation selectors supplement
];
/** Tab, line feed and carriage return: refused in a line of text, allowed in notes. */
const LINE_BREAKS: readonly (readonly [number, number])[] = [[0x09, 0x09], [0x0a, 0x0a], [0x0d, 0x0d]];
const cls = (ranges: readonly (readonly [number, number])[]) =>
  new RegExp("[" + ranges.map(([a, b]) => String.fromCodePoint(a) + (b > a ? "-" + String.fromCodePoint(b) : "")).join("") + "]", "u");
/** A line of text (supplier, scope, reference, submitter): none of the above and no line break. */
export const BAD_CHARS = cls([...BAD_RANGES, ...LINE_BREAKS]);
/** Notes: the same, but tab, LF and CR are allowed. */
const NOTES_BAD = cls(BAD_RANGES);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const line = (max: number, what: string) =>
  z
    .string({ message: `${what} must be text.` })
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, `${what} is required.`)
        .max(max, `${what} is at most ${max} characters.`)
        .refine((s) => !BAD_CHARS.test(s), `${what} may not contain control, invisible or direction-changing characters.`)
    );

/** The wire form of a claim (what the browser sends). Dates are ISO calendar dates; the price is in EUR. */
export const claimSchema = z
  .object({
    file_id: z.string().regex(UUID, "Choose the uploaded quotation file."),
    cost_key: z.enum(QUOTABLE_KEYS, { message: "Choose the part of the works this quotation prices." }),
    unit: z.string().regex(/^[A-Za-z0-9/]{1,20}$/, "The unit is not one this site prices."),
    price_eur: z.number({ message: "The price must be a number." }).finite("The price must be a finite number.").min(0.01, "The price must be at least 0.01 EUR.").max(LIMITS.maxPriceEur, "The price is above the 1,000,000,000 EUR ceiling."),
    quoted_quantity: z.number().finite().min(0.001, "A quantity is at least 0.001.").max(1e9).optional(),
    quote_type: z.enum(QUOTE_TYPES, { message: "Say whether it is a firm or an indicative quotation." }),
    supplier: line(LIMITS.supplier, "The supplier name"),
    quoted_on: z.string().refine(isRealDate, "The quotation date must be a calendar date (YYYY-MM-DD)."),
    valid_until: z.string().refine(isRealDate, "The validity date must be a calendar date (YYYY-MM-DD)."),
    lead_time_weeks: z.number().finite().gt(0, "A lead time must be above zero weeks.").max(LIMITS.maxLeadWeeks, `A lead time is at most ${LIMITS.maxLeadWeeks} weeks.`).optional(),
    scope: line(LIMITS.scope, "What the quotation covers"),
    notes: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().max(LIMITS.notes, `Notes are at most ${LIMITS.notes} characters.`).refine((s) => !NOTES_BAD.test(s), "Notes may not contain control, invisible or direction-changing characters."))
      .optional(),
    reference: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().max(LIMITS.reference).refine((s) => !BAD_CHARS.test(s), "The reference may not contain control or invisible characters."))
      .optional(),
    submitted_by: line(LIMITS.submittedBy, "Your name"),
  })
  .strict();

export type ClaimInput = z.infer<typeof claimSchema>;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface ClaimProblem {
  path: string;
  message: string;
}

/**
 * The checks that need the calendar and the catalogue, on top of the shape: the unit belongs to the line, a lump's quantity is counted in the
 * unit the engine prices it in, the validity date is in the FUTURE on the day it is submitted and not before the quotation date, and the
 * quotation date is not in the future or older than five years. `today` is passed in so the rule is testable and the server's clock decides.
 */
export function checkClaim(c: ClaimInput, today: string): ClaimProblem[] {
  const out: ClaimProblem[] = [];
  const item = itemFor(c.cost_key);
  if (!item) out.push({ path: "cost_key", message: "That is not a part of the works this site can price from a quotation." });
  else {
    if (!item.units.includes(c.unit)) out.push({ path: "unit", message: `${item.label} is entered in ${item.units.join(" or ")}.` });
    if (c.quoted_quantity !== undefined) {
      if (c.unit !== "EUR" || !item.quantityUnit) out.push({ path: "quoted_quantity", message: "A quantity belongs to a lump price (EUR) for a line the engine scales." });
    }
  }
  // Not in the future: the engine keeps the NEWEST quotation date when two accepted lines price one item, so a claim dated tomorrow could displace
  // an earlier firm or contracted quotation the day it is accepted.
  if (c.quoted_on > today) out.push({ path: "quoted_on", message: "The quotation date is in the future." });
  if (c.quoted_on < addDays(today, -LIMITS.maxAgeDays)) out.push({ path: "quoted_on", message: "A quotation more than five years old is not a current price." });
  if (c.valid_until <= today) out.push({ path: "valid_until", message: "The validity date must be after today: an expired quotation is not evidence of a current price." });
  if (c.valid_until < c.quoted_on) out.push({ path: "valid_until", message: "The validity date is earlier than the quotation date." });
  return out;
}

/** The comparability the submitter's own entry supports: a lump the engine would scale, with no stated quantity, is used once per step, unscaled. */
export function claimComparability(c: ClaimInput): { comparability: "exact" | "limited"; limitations: string[] } {
  const item = itemFor(c.cost_key);
  if (c.unit === "EUR" && item?.quantityUnit && c.quoted_quantity === undefined) {
    return {
      comparability: "limited",
      limitations: [`A lump price with no stated quantity: the engine uses it once per step, unscaled, and flags the result as limited (${item.quantityUnit} covered not stated).`],
    };
  }
  return { comparability: "exact", limitations: [] };
}
