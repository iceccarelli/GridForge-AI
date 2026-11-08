// Server-only: POST /api/halls/[id]/diff - the engine's own answer to "what did this change do to the hall's capacity envelope?".
//
// THE ORDER (each step spends less than the next, and nothing that costs units happens before the caller is known to belong to the hall):
//   the door (verified bearer)  ->  the body  ->  the registry READ allowance  ->  the hall's figures (the database checks membership: a stranger gets the SAME
//   404 as a hall that does not exist)  ->  the two documents are built  ->  if a required figure is missing, or the two are the same, the answer is
//   given here and the engine is never called  ->  only then the engine allowance (per account and per hall)  ->  the engine, under the operator's key.
//
// NOTHING IS WRITTEN. The route reads the hall's figures and counters; a pending import (`proposed`) is judged by the import's own rules and laid over a copy.
// WHAT IS RETURNED is built field by field (lib/site-registry-engine.ts shapeEngineDiff): no engine output as it came, no project link token, no storage
// location, no address.

import { z } from "zod";
import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/http-body";
import { callEngine } from "@/lib/power-deploy";
import { hallInputs, reply } from "@/lib/sites";
import { IMPORT_MAX_ROWS, type RawRow } from "@/lib/site-registry-import";
import type { RegistryInput } from "@/lib/site-registry-model";
import {
  ENGINE_DIFF_LABEL, ENGINE_DIFF_UNITS, buildEngineDocument, carryingClass, compareBuilt, pointLabel, recordedAsOf, recordedNow, recordedWithProposed, shapeEngineDiff,
  type Built, type Comparison, type PointSpec, type Recorded,
} from "@/lib/site-registry-engine";

const MAX_BODY_BYTES = 160 * 1024;                      // 200 import rows of at most ~700 bytes each, with room

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => reply({ ok: false, error, ...extra }, status);

// --------------------------------------------------------------------------------------------------------------- the body

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date as YYYY-MM-DD.").refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "That date does not exist.");

const cell = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const Cells = z.strictObject({ field_path: cell, value: cell, unit: cell, origin: cell, class: cell, as_of: cell, source_kind: cell, source_id: cell }).partial();
/** A row of an import preview as the page holds it: the cells exactly as the file gave them (`fromCsv`: they were text in a CSV). The server judges them again. */
const ProposedRow = z.strictObject({ n: z.number().int().min(1).max(100000).optional(), fromCsv: z.boolean().optional(), cells: Cells });

const Point = z.union([
  z.strictObject({ asOf: day }),
  z.strictObject({ now: z.literal(true) }),
  z.strictObject({ proposed: z.array(ProposedRow).min(1).max(IMPORT_MAX_ROWS) }),
]);
export type PointBody = z.infer<typeof Point>;

export const DiffBody = z.strictObject({ from: Point, to: Point }).superRefine((b, ctx) => {
  const same = ("now" in b.from && "now" in b.to) || ("asOf" in b.from && "asOf" in b.to && b.from.asOf === b.to.asOf);
  if (same) ctx.addIssue({ code: "custom", path: ["to"], message: "Choose two different points." });
});
export type DiffRequest = z.infer<typeof DiffBody>;

export async function readDiffBody(req: Request): Promise<{ ok: true; value: DiffRequest } | { ok: false; response: NextResponse }> {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return { ok: false, response: fail(read.status, read.status === 413 ? read.error : "Invalid payload") };
  const parsed = DiffBody.safeParse(read.value);
  if (!parsed.success) {
    return { ok: false, response: fail(400, "Some fields are not valid.", { issues: parsed.error.issues.slice(0, 12).map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })) }) };
  }
  return { ok: true, value: parsed.data };
}

// --------------------------------------------------------------------------------------------------------------- preparing the two documents

export interface Prepared {
  hall: { id: string; label: string };
  today: string;
  specs: { from: PointSpec; to: PointSpec };
  built: { from: Built; to: Built };
  comparison: Comparison;
  /** The history was cut at the newest 500 claims, so an earlier point may be unreadable for some fields. */
  historyTruncated: boolean;
}

type Out<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/** Read the hall's figures (the database decides who may), judge a pending import, and build both documents. Calls no provider and writes nothing. */
export async function prepareDiff(email: string, hallId: string, body: DiffRequest): Promise<Out<Prepared>> {
  const today = new Date().toISOString().slice(0, 10);
  const points = [body.from, body.to];
  for (const p of points) {
    if ("asOf" in p && p.asOf > today) return { ok: false, response: fail(400, "That date has not happened yet. Choose today or an earlier day.") };
    if ("asOf" in p && p.asOf < "1990-01-01") return { ok: false, response: fail(400, "That date is too early to be a record's date.") };
  }
  const needHistory = points.some((p) => "asOf" in p);
  const needCurrent = points.some((p) => !("asOf" in p));

  let hall: { id: string; label: string } | null = null;
  let current: RegistryInput[] = [];
  let history: RegistryInput[] = [];
  let truncated = false;
  if (needCurrent || !needHistory) {
    const r = await hallInputs(email, hallId, { history: false, limit: 500 });
    if (!r.ok) return r;
    hall = { id: r.value.hall.id, label: r.value.hall.label };
    current = r.value.inputs as unknown as RegistryInput[];
  }
  if (needHistory) {
    const r = await hallInputs(email, hallId, { history: true, limit: 500 });
    if (!r.ok) return r;
    hall = hall ?? { id: r.value.hall.id, label: r.value.hall.label };
    history = r.value.inputs as unknown as RegistryInput[];
    truncated = r.value.truncated;
  }
  if (!hall) return { ok: false, response: fail(503, "The site registry is unavailable just now. Nothing was changed.") };

  const specs: Partial<Record<"from" | "to", PointSpec>> = {};
  const recorded: Partial<Record<"from" | "to", Recorded>> = {};
  for (const side of ["from", "to"] as const) {
    const p = body[side];
    if ("now" in p) { specs[side] = { kind: "now" }; recorded[side] = recordedNow(current); }
    else if ("asOf" in p) { specs[side] = { kind: "asOf", day: p.asOf }; recorded[side] = recordedAsOf([...history, ...current], p.asOf); }
    else {
      const rows: RawRow[] = p.proposed.map((r, i) => ({ n: r.n ?? i + 1, cells: r.cells, fromCsv: Boolean(r.fromCsv) }));
      const plan = recordedWithProposed(current, rows, today);
      specs[side] = { kind: "proposed", used: plan.used, unchanged: plan.unchanged, excluded: plan.excluded };
      recorded[side] = plan.recorded;
    }
  }
  const built = { from: buildEngineDocument(recorded.from!), to: buildEngineDocument(recorded.to!) };
  return { ok: true, value: { hall, today, specs: specs as Prepared["specs"], built, comparison: compareBuilt(built.from, built.to), historyTruncated: truncated } };
}

/** The part of every answer that does not depend on the engine. */
function common(p: Prepared): Record<string, unknown> {
  const meta = (s: PointSpec) => (s.kind === "now"
    ? { kind: "now", asOf: p.today, label: pointLabel(s) }
    : s.kind === "asOf"
      ? { kind: "asOf", asOf: s.day, label: pointLabel(s) }
      : { kind: "proposed", asOf: null, label: pointLabel(s), rows: { used: s.used, unchanged: s.unchanged, excluded: s.excluded } });
  const c = p.comparison;
  return {
    ok: true,
    hall: p.hall,
    from: meta(p.specs.from),
    to: meta(p.specs.to),
    label: ENGINE_DIFF_LABEL,
    historyTruncated: p.historyTruncated,
    missing: c.missing,
    classNotes: c.classNotes,
    placeholders: c.placeholders,
    notUsed: c.notUsed,
    ceiling: c.ceiling,
    classChanges: c.classChanges,
  };
}

/** The answer when the engine is not to be asked: a required figure is missing, or the two points hold the same figures. Costs nothing. */
export function notRun(p: Prepared): NextResponse | null {
  const c = p.comparison;
  if (c.missing.length > 0) {
    return reply({
      ...common(p), ran: false, reason: "missing", units: 0,
      message: `The engine was not run: ${c.missing.length} figure${c.missing.length === 1 ? "" : "s"} it needs ${c.missing.length === 1 ? "is" : "are"} not recorded in a usable form at one or both points. Nothing was run and no units were used.`,
    });
  }
  if (c.identical) {
    return reply({ ...common(p), ran: false, reason: "identical", units: 0, message: "The figures the engine reads are the same at these two points, so there is nothing for it to compare. Nothing was run and no units were used." });
  }
  return null;
}

// --------------------------------------------------------------------------------------------------------------- asking the engine

const NOT_AVAILABLE = "The engine's change comparison is not available just now, so nothing was run and nothing was charged.";

/** What the engine says built the answer (its provenance), or null: an engine that does not say is shown as not saying. */
function provenanceOf(body: Record<string, unknown>): { version: string; digest: string } | null {
  const p = body.provenance;
  if (typeof p !== "object" || p === null) return null;
  const { engine_version: v, digest: d } = p as { engine_version?: unknown; digest?: unknown };
  if (typeof v !== "string" || typeof d !== "string" || !/^[0-9a-f]{64}$/.test(d)) return null;
  return { version: v.slice(0, 40), digest: d };
}

/**
 * Ask the engine for the diff. The ONE place this feature spends: call it only inside the spend scope of an admitted request (guardRequest ... .run).
 * `cost_evidence: []` makes the engine attach the provenance of the build that answered, in the same response (an engine that predates that is asked once more without it).
 */
export async function runEngineDiff(p: Prepared): Promise<NextResponse> {
  const doc = { before: p.built.from.doc, after: p.built.to.doc };
  let out = await callEngine("/v1/diff", { ...doc, cost_evidence: [] });
  if (!out.ok && out.status === 422 && /cost_evidence/.test(String(out.error))) out = await callEngine("/v1/diff", doc);
  if (!out.ok) {
    if (out.routeMissing) return fail(503, NOT_AVAILABLE, { reason: "engine_route_missing" });
    if (out.status === 422) {
      const msg = String(out.error).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300);
      return fail(422, `The engine did not accept the recorded figures: ${msg}`, { reason: "engine_refused", hall: p.hall });
    }
    console.error("[GridForge] hall diff: the engine could not be asked:", out.status);
    return fail(503, NOT_AVAILABLE, { reason: "engine_unavailable" });
  }
  const diff = shapeEngineDiff(out.body, { from: p.built.from.pathMap, to: p.built.to.pathMap });
  if (!diff) {
    console.error("[GridForge] hall diff: the engine answered in a form this site does not understand");
    return fail(502, "The engine answered in a form this site does not understand, so nothing is shown. Nothing was changed.", { reason: "engine_answer_unreadable" });
  }
  const c = p.comparison;
  return reply({
    ...common(p), ran: true, units: ENGINE_DIFF_UNITS,
    engine: provenanceOf(out.body),
    diff,
    carriedBy: carryingClass(diff.racksClass, c.ceiling),
  });
}
