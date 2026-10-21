// The one formatter for a time-to-power figure (Rule D).
//
// A figure in weeks that is built from an assumed (E0) lead time must never read as a date. The engine now says what
// each figure rests on, in four flat keys that sit beside the figure (the qualifier's `after_relief`, a compare
// scenario's `time_to_power`, a readiness `time_to_power`, a power-deploy `architectures[]` row, a portfolio row):
//
//   date_basis            "none" | "assumed" | "supported"
//   date_evidence_class   the WEAKEST class behind the figure, e.g. "E0" (null when there is no date)
//   date_binding_item     the item whose lead time sets the figure (null when there is no date)
//   date_label            the sentence a reader sees next to the figure
//
// Every page that shows such a figure goes through `describeDate` / `formatWeeks`, so the rule lives in one place:
//   * none        no number at all; the label says why there is no date
//   * assumed     the number, always with the label, never alone
//   * supported   the number, with the engine's label (which names the evidence class)
//   * keys absent (an engine older than this change, or a stored result written before it): "lead time unverified",
//                 and NO number, because an unlabelled number is exactly what this rule forbids
//
// Pure: no React, no fetch. tests/site/date-basis.test.ts pins every string below.

export type DateBasis = "none" | "assumed" | "supported";

/** The additive keys as they arrive; any of them may be missing from an older engine or a stored result. */
export interface DateBasisKeys {
  date_basis?: unknown;
  date_evidence_class?: unknown;
  date_binding_item?: unknown;
  date_label?: unknown;
}

export const UNVERIFIED_LABEL = "lead time unverified";
export const NO_DATE_LABEL = "no date: nothing is deployable or a lead time on the path is missing";

export interface DateInfo {
  /** "unverified" when the engine did not say what the figure rests on. */
  basis: DateBasis | "unverified";
  evidenceClass: string | null;
  bindingItem: string | null;
  /** Always non-empty. The sentence shown beside the figure. */
  label: string;
  /** May the number of weeks be shown at all? False for none and unverified. */
  showsNumber: boolean;
  /** Must the label be shown beside the number? True for everything but a supported basis (which still shows it). */
  needsLabel: boolean;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

const BASES: readonly DateBasis[] = ["none", "assumed", "supported"];

/** Read the four keys. Unknown or missing `date_basis` is "unverified": never guessed from the number itself. */
export function readDateBasis(src: DateBasisKeys | null | undefined): DateInfo {
  const basis = BASES.find((b) => b === src?.date_basis);
  if (!basis) {
    return { basis: "unverified", evidenceClass: null, bindingItem: null, label: UNVERIFIED_LABEL, showsNumber: false, needsLabel: true };
  }
  const evidenceClass = text(src?.date_evidence_class);
  const bindingItem = text(src?.date_binding_item);
  const given = text(src?.date_label);
  const label =
    given ??
    (basis === "assumed"
      ? `assumed lead time, not a date${evidenceClass ? ` (${evidenceClass})` : ""}`
      : basis === "supported"
        ? `lead times of class ${evidenceClass ?? "unknown"} at best`
        : NO_DATE_LABEL);
  return {
    basis,
    evidenceClass,
    bindingItem,
    label,
    showsNumber: basis !== "none",
    needsLabel: basis !== "supported",
  };
}

/** The weaker of two bases, for a figure derived from two others (a difference between scenarios). */
export function weakestBasis(a: DateInfo, b: DateInfo): DateInfo {
  const rank = (i: DateInfo) => (i.basis === "supported" ? 2 : i.basis === "assumed" ? 1 : 0);
  return rank(a) <= rank(b) ? a : b;
}

export interface WeeksFigure {
  /** What to print where the number goes, or null when no number may be shown. */
  number: string | null;
  /** What to print beside it. Present whenever a number is shown for a non-supported basis, and in every other case too. */
  label: string;
  info: DateInfo;
}

function weeksText(weeks: number): string {
  return `${weeks.toLocaleString("en-IE")} wk`;
}

/** A figure in weeks together with what it rests on. `weeks` null or non-finite shows no number whatever the basis. */
export function describeDate(weeks: number | null | undefined, src: DateBasisKeys | null | undefined): WeeksFigure {
  const info = readDateBasis(src);
  const hasNumber = typeof weeks === "number" && Number.isFinite(weeks);
  return {
    number: info.showsNumber && hasNumber ? weeksText(weeks as number) : null,
    label: info.label,
    info,
  };
}

/** The figure as one string: "42 wk (assumed lead time, not a date (E0; set by transformer capacity))", or the label alone. */
export function formatWeeks(weeks: number | null | undefined, src: DateBasisKeys | null | undefined): string {
  const f = describeDate(weeks, src);
  return f.number === null ? f.label : `${f.number} (${f.label})`;
}

/** A change in weeks between two scenarios. Sign kept; labelled by the weaker of the two bases; no number unless both have one. */
export function formatWeeksDelta(
  delta: number | null | undefined,
  scenario: DateBasisKeys | null | undefined,
  baseline: DateBasisKeys | null | undefined
): string {
  const info = weakestBasis(readDateBasis(scenario), readDateBasis(baseline));
  if (!info.showsNumber || typeof delta !== "number" || !Number.isFinite(delta)) return info.label;
  return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-IE")} wk (${info.label})`;
}

/** A ranking value. Only a ranking by weeks is a date; any other metric passes through untouched. */
export function formatRankingValue(
  metric: string,
  value: number | undefined,
  leader: DateBasisKeys | null | undefined
): string {
  if (typeof value !== "number") return "";
  return /week|wk/i.test(metric) ? formatWeeks(value, leader) : value.toLocaleString("en-IE");
}

/** What the qualifier's "sets the date" readout shows: the item, and always what the date rests on. */
export function formatSetsTheDate(
  item: string | null | undefined,
  src: DateBasisKeys | null | undefined
): { value: string; label: string; info: DateInfo } {
  const info = readDateBasis(src);
  const name = text(item);
  const value = info.basis === "none" ? "No date" : name ?? "Not stated";
  return { value, label: info.label, info };
}

/**
 * One item's lead time ("transformer capacity: 160 wk"). It is a lead time, not a date, but it still wears its evidence
 * class, and an E0 one says it is an assumption.
 */
export function formatLeadTime(weeks: number, evidenceClass: string | null | undefined): string {
  const cls = text(evidenceClass);
  const tail = cls ? (/^E0\b/.test(cls) ? ` (${cls}, assumed)` : ` (${cls})`) : " (evidence class not stated)";
  return `${weeks.toLocaleString("en-IE")} wk lead${tail}`;
}
