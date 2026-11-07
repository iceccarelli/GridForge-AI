// "What changed" at a hall: a deterministic comparison of what was recorded at two points in its history, or of one field's successive values.
// Computed in the browser from the claims the registry's read API already returns (current figures + the history); nothing is fetched or invented here.
//
// WHAT THIS IS. A comparison of RECORDED CLAIMS: a figure's value, and the origin, class and file the recorder declared for it. It is not a recomputed
// capacity result (that needs the engine and is not what a hall's recorded figures are), and it never says a figure "improved". A change in a number is
// always shown beside the evidence it rests on, in the same line: declared origin, declared class, the file and that file's review status.
//
// HONEST LIMITS, built into the code:
//   * A file's review status is the LIVE status (the API does not keep the status a file had when the figure was recorded). Both sides of a comparison
//     therefore show today's status of their file; the line says so.
//   * The history endpoint returns at most the newest 500 claims. A field whose first claim is not loaded has an INCOMPLETE chain: for a point before its
//     first loaded claim its state is "unknown", never "added" or "none".
//   * A correction replaces a claim; a field is never deleted. The nearest thing to removal is a correction that records the field as missing: "withdrawn".

import { classRank, originText, sourceText, valueText, type RegistryInput } from "@/lib/site-registry-model";

export type Chain = { path: string; claims: RegistryInput[]; complete: boolean };

/** Group claims by field and order each field's claims oldest to newest, following the supersedes links (falling back to the recording time). Duplicate ids collapse. */
export function buildChains(claims: RegistryInput[]): Map<string, Chain> {
  const byId = new Map<string, RegistryInput>();
  for (const c of claims) byId.set(c.id, c);
  const byPath = new Map<string, RegistryInput[]>();
  for (const c of byId.values()) byPath.set(c.fieldPath, [...(byPath.get(c.fieldPath) ?? []), c]);
  const out = new Map<string, Chain>();
  for (const [path, list] of byPath) {
    const ids = new Set(list.map((c) => c.id));
    const successor = new Map<string, RegistryInput>();
    for (const c of list) if (c.supersedesId && ids.has(c.supersedesId) && !successor.has(c.supersedesId)) successor.set(c.supersedesId, c);
    const starts = list.filter((c) => !c.supersedesId || !ids.has(c.supersedesId));
    let ordered: RegistryInput[] = [];
    if (starts.length === 1) {
      const seen = new Set<string>();
      for (let c: RegistryInput | undefined = starts[0]; c && !seen.has(c.id); c = successor.get(c.id)) { ordered.push(c); seen.add(c.id); }
    }
    if (ordered.length !== list.length) {
      // Not one clean line (should not happen): order by the time recorded so the result is still deterministic.
      ordered = [...list].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
    }
    out.set(path, { path, claims: ordered, complete: !ordered[0]?.supersedesId });
  }
  return out;
}

const time = (c: RegistryInput): number => (c.recordedAt ? Date.parse(c.recordedAt) : Number.NaN);

// --------------------------------------------------------------------------------------------------------------- points in time

export type Point = { id: string; label: string; /** null: now (the current figures). Otherwise the end of that day, UTC, in ms; -Infinity: before anything was recorded. */ at: number | null };

export const NOW_POINT: Point = { id: "now", label: "Now (the current figures)", at: null };
export const START_POINT: Point = { id: "start", label: "Before the first recorded figure", at: Number.NEGATIVE_INFINITY };

/** The points a person can compare: now, the end of each day something was recorded (newest first), and the start. */
export function pointsOf(claims: RegistryInput[]): Point[] {
  const days = [...new Set(claims.map((c) => (c.recordedAt && !Number.isNaN(Date.parse(c.recordedAt)) ? new Date(Date.parse(c.recordedAt)).toISOString().slice(0, 10) : "")).filter(Boolean))].sort().reverse();
  return [NOW_POINT, ...days.map((d) => ({ id: d, label: `End of ${d} (UTC)`, at: Date.parse(`${d}T23:59:59.999Z`) })), START_POINT];
}

export type State = { kind: "claim"; claim: RegistryInput } | { kind: "none" } | { kind: "unknown" };

/** What a field's record said at a point. */
export function stateAt(chain: Chain, at: number | null): State {
  if (at === null) return chain.claims.length ? { kind: "claim", claim: chain.claims[chain.claims.length - 1]! } : { kind: "none" };
  let found: RegistryInput | null = null;
  for (const c of chain.claims) {
    const t = time(c);
    if (Number.isNaN(t)) return { kind: "unknown" };      // a claim with no usable time cannot be placed
    if (t <= at) found = c;
  }
  if (found) return { kind: "claim", claim: found };
  return chain.complete ? { kind: "none" } : { kind: "unknown" };
}

// --------------------------------------------------------------------------------------------------------------- one change

export type Aspect = { what: "value" | "unit" | "declared origin" | "declared class" | "source file" | "file review status" | "as of"; from: string; to: string; direction?: "raised" | "lowered"; note?: string };

const fileName = (i: RegistryInput) => (i.source ? i.source.filename ?? "a file" : "no file cited");
const fileStatus = (i: RegistryInput) => {
  if (!i.source) return "no file";
  if (i.source.kind === "intake_evidence") return "not reviewable";
  return i.source.reviewStatus === "verified" ? "reviewed and verified" : i.source.reviewStatus === "rejected" ? "rejected" : "not yet reviewed";
};

/** The numeric difference of two figures that are both numbers in the same unit, as text; null otherwise. */
function delta(a: RegistryInput, b: RegistryInput): string | null {
  if (typeof a.value !== "number" || typeof b.value !== "number" || (a.unit ?? null) !== (b.unit ?? null)) return null;
  const d = Math.round((b.value - a.value) * 1e6) / 1e6;
  if (d === 0) return null;
  const pct = a.value !== 0 ? ` (${d > 0 ? "+" : ""}${Math.round(((b.value - a.value) / Math.abs(a.value)) * 1000) / 10}%)` : "";
  return `${d > 0 ? "+" : ""}${d}${b.unit ? " " + b.unit : ""}${pct}`;
}

/** Every respect in which two claims of the same field differ. Empty when they say the same thing. */
export function aspectsBetween(a: RegistryInput, b: RegistryInput): Aspect[] {
  const out: Aspect[] = [];
  if (valueText(a) !== valueText(b) || (a.value ?? null) !== (b.value ?? null)) {
    const d = delta(a, b);
    out.push({ what: "value", from: valueText(a), to: valueText(b), ...(d ? { note: d } : {}) });
  } else if ((a.unit ?? null) !== (b.unit ?? null)) out.push({ what: "unit", from: a.unit ?? "none", to: b.unit ?? "none" });
  if (a.origin !== b.origin) out.push({ what: "declared origin", from: originText(a.origin), to: originText(b.origin) });
  if (a.evidenceClass !== b.evidenceClass) {
    const ra = classRank(a.evidenceClass), rb = classRank(b.evidenceClass);
    out.push({ what: "declared class", from: a.evidenceClass, to: b.evidenceClass, direction: rb > ra ? "raised" : "lowered" });
  }
  if ((a.source?.id ?? null) !== (b.source?.id ?? null) || fileName(a) !== fileName(b)) out.push({ what: "source file", from: fileName(a), to: fileName(b) });
  if (fileStatus(a) !== fileStatus(b)) out.push({ what: "file review status", from: fileStatus(a), to: fileStatus(b) });
  if (a.asOf !== b.asOf) out.push({ what: "as of", from: a.asOf, to: b.asOf });
  return out;
}

/** "declared assumed E0, no file cited" -> "declared measured E5, meter.pdf (file reviewed and verified)": the evidence a figure rests on, always together. */
export const evidenceLine = (i: RegistryInput): string => `${originText(i.origin)} ${i.evidenceClass}, ${sourceText(i)}`;
export const evidenceShift = (a: RegistryInput | null, b: RegistryInput): string => (a ? `${evidenceLine(a)} → ${evidenceLine(b)}` : `no figure → ${evidenceLine(b)}`);

/** Things a reader should not miss about the AFTER side: the class is a declaration, and the file may not (or no longer) stand behind it. */
export function cautions(before: RegistryInput | null, after: RegistryInput): string[] {
  const out: string[] = [];
  const rose = before ? classRank(after.evidenceClass) > classRank(before.evidenceClass) : classRank(after.evidenceClass) > 0;
  if (after.source?.kind === "project_evidence" && after.source.reviewStatus === "rejected") out.push("The file this figure cites has since been rejected.");
  else if (rose && classRank(after.evidenceClass) > 3 && !(after.source?.kind === "project_evidence" && after.source.reviewStatus === "verified")) {
    out.push(`The declared class ${after.evidenceClass} is the recorder's declaration; the file is not shown as reviewed and verified now.`);
  }
  if (before && after.origin !== before.origin && (after.origin === "measured" || after.origin === "observed") && !after.source) out.push("Declared " + after.origin + " with no file cited.");
  return out;
}

// --------------------------------------------------------------------------------------------------------------- two points

export type ChangeKind = "added" | "changed" | "withdrawn" | "unchanged" | "unknown";

export interface DiffRow {
  path: string;
  kind: ChangeKind;
  before: RegistryInput | null;
  after: RegistryInput | null;
  aspects: Aspect[];
  /** How many claims of this field were recorded after the first point and up to the second (the corrections that happened in between). */
  between: number;
  cautions: string[];
  /** Why the state is unknown, when it is. */
  note: string | null;
}

export interface Diff {
  rows: DiffRow[];
  counts: Record<ChangeKind, number>;
}

const kinds: ChangeKind[] = ["added", "changed", "withdrawn", "unchanged", "unknown"];

/** Compare the record at `from` with the record at `to`. `from` must not be later than `to`. */
export function diffPoints(chains: Map<string, Chain>, from: Point, to: Point): { ok: true; diff: Diff } | { ok: false; error: string } {
  const fa = from.at ?? Number.POSITIVE_INFINITY, ta = to.at ?? Number.POSITIVE_INFINITY;
  if (fa > ta) return { ok: false, error: "Choose an earlier point first and a later point second." };
  const rows: DiffRow[] = [];
  for (const path of [...chains.keys()].sort()) {
    const chain = chains.get(path)!;
    const a = stateAt(chain, from.at), b = stateAt(chain, to.at);
    const between = chain.claims.filter((c) => { const t = time(c); return t > fa && t <= ta; }).length;
    const row = (kind: ChangeKind, before: RegistryInput | null, after: RegistryInput | null, aspects: Aspect[], note: string | null = null): DiffRow => ({
      path, kind, before, after, aspects, between, cautions: after && kind !== "unchanged" ? cautions(before, after) : [], note,
    });
    if (a.kind === "unknown" || b.kind === "unknown") {
      rows.push(row("unknown", a.kind === "claim" ? a.claim : null, b.kind === "claim" ? b.claim : null, [], "Older history of this field was not loaded, so its state at the earlier point cannot be told."));
      continue;
    }
    if (a.kind === "none" && b.kind === "none") continue;
    if (a.kind === "none" && b.kind === "claim") { rows.push(row("added", null, b.claim, [])); continue; }
    if (a.kind !== "claim" || b.kind !== "claim") continue;
    const before = a.claim, after = b.claim;
    if (before.id === after.id) { rows.push(row("unchanged", before, after, [])); continue; }
    const aspects = aspectsBetween(before, after);
    if (before.origin !== "missing" && after.origin === "missing") rows.push(row("withdrawn", before, after, aspects));
    else if (aspects.length === 0) rows.push(row("unchanged", before, after, [], "Recorded again with the same content."));
    else rows.push(row("changed", before, after, aspects));
  }
  const counts = Object.fromEntries(kinds.map((k) => [k, rows.filter((r) => r.kind === k).length])) as Record<ChangeKind, number>;
  return { ok: true, diff: { rows, counts } };
}

// --------------------------------------------------------------------------------------------------------------- one field's successive values

export interface Step {
  /** null: the first claim ever recorded for the field. */
  before: RegistryInput | null;
  after: RegistryInput;
  aspects: Aspect[];
  cautions: string[];
}

/** The steps of one field, oldest first: each claim against the one it replaced. */
export function successions(chain: Chain): Step[] {
  return chain.claims.map((c, k) => {
    const before = k === 0 ? null : chain.claims[k - 1]!;
    return { before, after: c, aspects: before ? aspectsBetween(before, c) : [], cautions: cautions(before, c) };
  });
}
