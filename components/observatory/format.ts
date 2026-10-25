// Pure formatting for the Observatory: quantities with their evidence, utilisation, and provenance wording.
// Nothing here invents a number: a missing value stays missing and says why; a date is never produced from weeks.
import type { EvidenceClass, Quantity } from "@/lib/observatory/types";
import { weakest } from "@/components/observatory/evidence";

const NF = new Intl.NumberFormat("en-IE", { maximumFractionDigits: 2 });
export function fmtNumber(n: number): string {
  return NF.format(n);
}

const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export function fmtUnitValue(value: number, unit: string): string {
  if (unit === "EUR" || unit === "€") return EUR.format(value);
  return unit ? `${fmtNumber(value)} ${unit}` : fmtNumber(value);
}

export interface QuantityView {
  /** "2.5 MVA", or "not available" when the engine gave no value. */
  text: string;
  known: boolean;
  /** "range 2.1 to 2.9 MVA" when the engine gave a range that differs from the value. */
  range: string | null;
  evidence: EvidenceClass | null;
  /** Why it is missing, verbatim from the engine, when it is. */
  missing: string | null;
}

export function viewQuantity(q: Quantity | null | undefined): QuantityView {
  if (!q) return { text: "not modelled", known: false, range: null, evidence: null, missing: null };
  if (q.value === null || !Number.isFinite(q.value)) {
    return { text: "not available", known: false, range: null, evidence: null, missing: q.missingReason ?? null };
  }
  const lo = q.low;
  const hi = q.high;
  const range =
    lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi) && (lo !== q.value || hi !== q.value)
      ? `range ${fmtUnitValue(lo, q.unit)} to ${fmtUnitValue(hi, q.unit)}`
      : null;
  return { text: fmtUnitValue(q.value, q.unit), known: true, range, evidence: q.evidence, missing: null };
}

/** SI-prefix normalisation, only within one base unit (W, VA, A). MW vs MVA are NOT converted: they are different things. */
export function toBase(v: number, unit: string): { value: number; base: string } {
  const m = /^([kMG]?)(W|VA|A)$/.exec(unit.trim());
  if (!m) return { value: v, base: unit.trim() };
  const mult = m[1] === "k" ? 1e3 : m[1] === "M" ? 1e6 : m[1] === "G" ? 1e9 : 1;
  return { value: v * mult, base: m[2] };
}

/** load / capacity, or null when either is missing or the units cannot be compared without a conversion we do not have. */
export function utilisation(capacity: Quantity | null, load: Quantity | null): number | null {
  if (!capacity || !load || capacity.value === null || load.value === null) return null;
  const c = toBase(capacity.value, capacity.unit);
  const l = toBase(load.value, load.unit);
  if (c.base !== l.base || !(c.value > 0) || !Number.isFinite(l.value)) return null;
  // A temperature (or a percentage) against its limit is not "how full" something is, so no ratio is drawn for it.
  if (/deg|°|^K$|^%$/i.test(c.base)) return null;
  return l.value / c.value;
}

export function fmtPct(frac: number | null): string {
  return frac === null ? "not comparable" : `${Math.round(frac * 100)}%`;
}

/** The weakest evidence class among the quantities that actually have a value (what a derived ratio is worth). */
export function weakestOf(qs: (Quantity | null)[]): EvidenceClass | null {
  let out: EvidenceClass | null = null;
  for (const q of qs) if (q && q.value !== null) out = out ? weakest(out, q.evidence) : q.evidence;
  return out;
}

// ---- dates -------------------------------------------------------------------------------------------------------

export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "not stated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not stated";
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "an unstated date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unstated date";
  return d.toISOString().slice(0, 10);
}
export function fmtAge(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round((seconds / 3600) * 10) / 10} h`;
  return `${Math.round(seconds / 86400)} days`;
}

// ---- scenario outcomes -------------------------------------------------------------------------------------------

export interface TimeView {
  kind: "weeks" | "undated" | "missing" | "nothing";
  /** The headline: "38 weeks", "Not dated — lead times assumed", or "Not available". Never a calendar date. */
  text: string;
  note: string | null;
  evidence: EvidenceClass | null;
}

/** Time to capacity. A calendar date is never produced: weeks only, and only as a programme length. */
export function viewTimeToCapacity(o: { weeksToCapacity: Quantity; dated: boolean; racksAfterPlan?: number }): TimeView {
  const q = o.weeksToCapacity;
  const has = q.value !== null && Number.isFinite(q.value);
  // An alternative that deploys no rack has no capacity to reach: "lead times assumed" would imply a date that merely lacks input.
  if (o.racksAfterPlan === 0 && !has) {
    return { kind: "nothing", text: "Nothing deploys, so there is nothing to date", note: null, evidence: null };
  }
  if (!o.dated) {
    return {
      kind: "undated",
      text: "Not dated — lead times assumed",
      note: has
        ? `A programme length of ${fmtNumber(q.value as number)} ${q.unit || "weeks"} on assumed lead times. It is not a date.`
        : (q.missingReason ?? "No lead time was supplied for every step."),
      evidence: has ? q.evidence : null,
    };
  }
  if (!has) {
    return { kind: "missing", text: "Not available", note: q.missingReason ?? null, evidence: null };
  }
  return {
    kind: "weeks",
    text: `${fmtNumber(q.value as number)} ${q.unit || "weeks"}`,
    note: "Programme length from supplied lead times. It is not a calendar date.",
    evidence: q.evidence,
  };
}

export interface CapexView {
  kind: "complete" | "lower_bound" | "unpriced";
  /** The amount (euro sign, grouped digits), or "at least" and the amount for a lower bound, or "Not priced". */
  text: string;
  /** "(priced lines only)" beside a lower bound. */
  qualifier: string | null;
  /** The engine's range, only for a complete figure: a lower bound has no upper bound to show. */
  range: string | null;
  /** What the lines rest on, in words: "library placeholder prices". Null when every line is a supplied figure. */
  pricing: string | null;
  note: string | null;
  evidence: EvidenceClass | null;
}

type CapexInput = { capexEur: Quantity; unpricedComponents: string[]; capexComplete?: boolean; capexPricing?: "placeholder" | "partly_supplied" | "supplied" | "none" };

/**
 * Capital cost. No value is "Not priced", never zero. A total that omits components (or that the engine says is not complete) is
 * a LOWER BOUND: "at least", with no upper bound shown, because the omitted parts have no price. Placeholder lines are named as
 * library placeholder prices, never as prices.
 */
export function viewCapex(o: CapexInput): CapexView {
  const q = viewQuantity(o.capexEur);
  const unpriced = o.unpricedComponents ?? [];
  if (!q.known) {
    return {
      kind: "unpriced",
      text: "Not priced",
      qualifier: null,
      range: null,
      pricing: null,
      note: unpriced.length ? `Unpriced: ${unpriced.join(", ")}.` : (q.missing ?? "No cost evidence was supplied."),
      evidence: null,
    };
  }
  const pricing =
    o.capexPricing === "placeholder"
      ? "library placeholder prices"
      : o.capexPricing === "partly_supplied"
        ? "some lines are library placeholder prices"
        : null;
  const lower = unpriced.length > 0 || o.capexComplete === false;
  if (lower) {
    return {
      kind: "lower_bound",
      text: `at least ${q.text}`,
      qualifier: "(priced lines only)",
      range: null,
      pricing,
      note: unpriced.length ? `Excludes ${unpriced.join(", ")}. Not a complete price.` : "Not a complete price.",
      evidence: q.evidence,
    };
  }
  return { kind: "complete", text: q.text, qualifier: null, range: q.range, pricing, note: null, evidence: q.evidence };
}
