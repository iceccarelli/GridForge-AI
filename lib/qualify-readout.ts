// How the capacity qualifier reads the engine's /v1/qualify answer for a buyer. Pure: no React, no I/O, importable by the client component and by
// lib/qualify.ts alike. Nothing here computes a figure. Every number it prints is the engine's, and each sentence about the engine's own fallbacks is
// triggered by the engine's wording in the answer (the patterns below), never by what the form sent.
//
// Three things the answer says that the page used to drop:
//   - warnings (`intake.warnings`): a MW/MVA/kW slip or a peak below the IT load makes the engine answer "0 racks" with a note that the INPUTS disagree;
//     the verdict beside it then reads as a fact about the hall.
//   - a rack count that is an upper bound: an equipment bank nobody declared is "treated as no limit", the most favourable reading.
//   - which assumed inputs are required (the paid document needs them) and how many of them there are.

import type { QualifyResult } from "@/lib/qualify";

type Intake = QualifyResult["intake"];
export type QualifyGap = Intake["gaps"][number];

/**
 * The engine's own words for "these inputs cannot all be right" (gridforge/power/plausibility.py): the unit hint "(MW, MVA, kW)", "wrong unit",
 * and "the inputs disagree with each other". The warnings it prints for a plain gap ("No UPS schedule supplied ...") say none of these.
 * tests/site/qualifier-journey-fixes.test.ts runs the real engine on a unit slip and fails if its wording stops matching.
 */
const INPUT_PROBLEM = /\(MW,\s*MVA,\s*kW\)|\bwrong unit\b|\binputs disagree\b|\bdisagree with each other\b/i;

/** What a verdict starts with while a unit or consistency warning stands (lib/qualify.ts headline()). */
export const CHECK_INPUTS_FIRST = "Check your inputs first:";

/** The whole prefix: one sentence, naming the warning shown with the result and saying the verdict that follows is provisional. */
export const CHECK_INPUTS_NOTE = `${CHECK_INPUTS_FIRST} the warning shown with this result says some figures may disagree with each other or be in the wrong unit, so what follows is provisional.`;

export function isInputProblem(warning: string): boolean {
  return INPUT_PROBLEM.test(warning);
}

/** Every warning the engine returned, as text, the unit/inconsistency ones first; the order inside each group is the engine's. */
export function orderedWarnings(r: { intake?: Partial<Intake> | null }): string[] {
  const raw = r.intake?.warnings;
  const all = Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string" && w.trim() !== "").map((w) => w.trim()) : [];
  return [...all.filter(isInputProblem), ...all.filter((w) => !isInputProblem(w))];
}

/** Whether the answer carries a unit or consistency warning. */
export function hasInputProblem(r: { intake?: Partial<Intake> | null }): boolean {
  return orderedWarnings(r).some(isInputProblem);
}

/**
 * The engine's "nobody declared this bank" fallback reads "not evaluated: treated as no limit, so the rack count is an upper bound"
 * (gridforge/intake/loader.py UNASSESSED_BANK_TEXT). The qualify answer carries no separate flag for it: the gap's own `assumed` text is the record.
 */
const NO_LIMIT = /\bno limit\b|\bupper bound\b/i;

/** The inputs the engine treated as "no limit", by the name it gave them. */
export function upperBoundInputs(r: { intake?: Partial<Intake> | null }): string[] {
  const gaps = r.intake?.gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.filter((g) => typeof g?.assumed === "string" && NO_LIMIT.test(g.assumed)).map((g) => String(g.input));
}

/** True when any input was treated as no limit: the rack counts can only be too high, so they are said as "at most", never "about". */
export function rackCountIsUpperBound(r: { intake?: Partial<Intake> | null }): boolean {
  return upperBoundInputs(r).length > 0;
}

/**
 * The fixed note on a page that prints a FREE read's rack counts without the engine's own answer beside them (the shared link, /q/[token]).
 * The free qualifier sends no transformer or UPS figures, so the engine treats both banks as "no limit" (gridforge/intake/loader.py
 * UNASSESSED_BANK_TEXT) on every free read: each count is an upper bound whatever else the answer says. The live page derives "at most" from the
 * engine's own gap text; a stored read keeps no gaps, so this page says it for all of them.
 */
export const FREE_READ_UPPER_BOUND_NOTE = "A free read treats transformers and UPS as no limit, so each rack count is an upper bound.";

/**
 * What the shared page says beside a count of ZERO. The engine answers "0 racks" for a hall whose figures are in the wrong unit or disagree (a
 * MW/kW slip, a peak below the IT load) and says so in a warning; the stored row keeps no warnings (no column for the answer exists), so the page
 * cannot tell that read from a hall that is really stopped, and does not claim to: it names the cause it cannot rule out and the way to check.
 */
export const SHARED_ZERO_RACKS_NOTE =
  "Zero racks can mean a real limit, or figures in the wrong unit or that disagree with each other (MW typed as kW, a peak below the IT load). " +
  "Check your inputs first: this link does not keep the engine's warnings, so run the read again at /qualify and read the warning shown there before relying on it.";

/**
 * How the rack tiles and the note under them speak of an upper bound. An upper bound of ZERO is just zero: "upper bound 0 racks" and "the hall may
 * carry fewer racks than this" mean nothing at 0, so a tile at 0 carries no label, and the note says what zero means:
 *
 *   racks today        both tiles are labelled; the note is the original ("may carry fewer racks than this");
 *   none today, some after   the second tile only is labelled; the note says no racks can be deployed today, and that it is the count after the
 *                      ladder that may be lower (it keeps the "Upper bound: ... not evaluated (treated as no limit)" wording the other tests pin);
 *   none at all        no tile is labelled; the note says no racks can be deployed on these inputs, even with the banks treated as no limit
 *                      (the most favourable reading, so declaring them cannot raise it).
 *
 * Nothing here is a figure: every number is the engine's.
 */
export function upperBoundReading(r: { as_found: { racks: number }; after_relief: { racks: number }; intake?: Partial<Intake> | null }): {
  todayLabel: string;
  afterLabel: string;
  note: string | null;
} {
  const names = upperBoundInputs(r);
  const today = r.as_found.racks;
  const after = r.after_relief.racks;
  const tag = (n: number) => (names.length && n > 0 ? " · upper bound" : "");
  if (!names.length) return { todayLabel: "Deployable today", afterLabel: "After the ladder", note: null };
  const verb = names.length === 1 ? "was" : "were";
  let note: string;
  if (today === 0 && after === 0) {
    note = `No racks can be deployed on these inputs, even with ${joinNames(names)} treated as no limit.`;
  } else if (today === 0) {
    note = `No racks can be deployed today on these inputs. Upper bound: ${joinNames(names)} ${verb} not evaluated (treated as no limit), so the hall may carry fewer than ${after} ${rackNoun(after)} after the ladder.`;
  } else {
    note = `Upper bound: ${joinNames(names)} ${verb} not evaluated (treated as no limit), so the hall may carry fewer racks than this.`;
  }
  return { todayLabel: `Deployable today${tag(today)}`, afterLabel: `After the ladder${tag(after)}`, note };
}

/**
 * The engine's floor-space basis reads "<free> of <total> positions available in <hall>". The TOTAL is the hall's rack positions, which the free
 * qualifier never asks for (toEngineBody sends no rack_positions), so it is the engine's library default, printed beside the free count as if it
 * were a figure the visitor gave. Said once, wherever the engine prints one.
 */
const POSITIONS_BASIS = /\b\d+ of (\d+) positions available\b/;

export function assumedTotalNote(basis: string | null | undefined): string | null {
  const m = typeof basis === "string" ? POSITIONS_BASIS.exec(basis) : null;
  return m ? `The total of ${m[1]} positions is assumed (a library default): the free read asks only for the positions that are free.` : null;
}

/** The rows of the assumed-inputs table that are shown without a click: every required one, then optional ones up to this many rows in all. */
export const VISIBLE_GAP_ROWS = 8;

/**
 * The assumed inputs, split for display: all required gaps first (the engine's order), then optional ones until VISIBLE_GAP_ROWS rows are shown,
 * and the remaining optional ones, which the page puts behind a disclosure. `requiredCount` is the number of starred rows, so a footer that says
 * "N required inputs" and the stars on screen are one count.
 */
export function splitGaps(gaps: readonly QualifyGap[] | null | undefined): { shown: QualifyGap[]; more: QualifyGap[]; requiredCount: number } {
  const list = Array.isArray(gaps) ? gaps : [];
  const required = list.filter((g) => g.required);
  const optional = list.filter((g) => !g.required);
  const room = Math.max(0, VISIBLE_GAP_ROWS - required.length);
  return { shown: [...required, ...optional.slice(0, room)], more: optional.slice(room), requiredCount: required.length };
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The noun that agrees with a rack count: "1 rack", "28 racks". */
export function rackNoun(n: number): string {
  return n === 1 ? "rack" : "racks";
}
