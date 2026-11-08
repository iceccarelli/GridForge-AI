// Server-only: POST /api/halls/[id]/diff - the engine's own answer to "what did this change do to the hall's capacity envelope?".
//
// SWITCHED OFF BY DEFAULT. A run spends the OPERATOR's engine units for a free verified account, so the route and the panel exist only where GRIDFORGE_HALL_ENGINE_DIFF=1
// (`engineDiffEnabled`); otherwise POST answers 503 `feature_off` before anything is read or asked.
//
// THE ORDER (each step spends less than the next, and nothing that costs units happens before the caller is known to belong to the hall):
//   the flag  ->  the door (verified bearer)  ->  the body  ->  the registry READ allowance  ->  the hall's figures (the database checks membership: a stranger gets the SAME
//   404 as a hall that does not exist)  ->  the two documents are built (a figure the engine would refuse is refused here)  ->  if a required figure is missing, or the two are
//   the same, the answer is given here and the engine is never called  ->  only then the allowances, ORGANISATION and HALL first, then the verified ACCOUNT (hour, then day), then the
//   site-wide daily ceiling  ->  the engine, under the operator's key and the registry's own provider budget, with an Idempotency-Key that is a hash of the two documents.
//   Every allowance a run took is GIVEN BACK (`RunAllowance.refundAll`) when the run fails before the engine answers: a failure never burns an allowance.
//
// NOTHING IS WRITTEN. The route reads the hall's figures and counters; a pending import (`proposed`) is judged by the import's own rules and laid over a copy.
// WHAT IS RETURNED is built field by field (lib/site-registry-engine.ts shapeEngineDiff): no engine output as it came, no project link token, no storage
// location, no address.

import { z } from "zod";
import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/http-body";
import { callEngine } from "@/lib/power-deploy";
import { countHit, refundHit, subjectOf, accountSubject, type RatePolicyName } from "@/lib/rate-limit";
import crypto from "node:crypto";
import { hallInputs, reply } from "@/lib/sites";
import { IMPORT_MAX_ROWS, type RawRow } from "@/lib/site-registry-import";
import type { RegistryInput } from "@/lib/site-registry-model";
import {
  ENGINE_DIFF_GLOBAL_PER_DAY, ENGINE_DIFF_LABEL, buildEngineDocument, stable, carryingClass, compareBuilt, pointLabel, recordedAsOf, recordedNow, recordedWithProposed, shapeEngineDiff,
  type Built, type Comparison, type PointSpec, type Recorded,
} from "@/lib/site-registry-engine";

/** The engine diff spends the operator's units for a free verified account, so it exists only where the operator has switched it on. */
export const engineDiffEnabled = (): boolean => process.env.GRIDFORGE_HALL_ENGINE_DIFF === "1";
export const FEATURE_OFF_MESSAGE = "The engine diff is not switched on for this deployment. Nothing was run.";
export const featureOff = () => fail(503, FEATURE_OFF_MESSAGE, { reason: "feature_off" });

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
  /** orgId is internal (it keys the organisation's allowance) and is never returned. */
  hall: { id: string; label: string; orgId: string };
  today: string;
  /** sha256 of the two documents and a fixed salt: the same question is the same key, whoever asks and whenever. */
  idempotencyKey: string;
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

  let hall: { id: string; label: string; orgId: string } | null = null;
  let current: RegistryInput[] = [];
  let history: RegistryInput[] = [];
  let truncated = false;
  if (needCurrent || !needHistory) {
    const r = await hallInputs(email, hallId, { history: false, limit: 500 });
    if (!r.ok) return r;
    hall = { id: r.value.hall.id, label: r.value.hall.label, orgId: r.value.hall.orgId };
    current = r.value.inputs as unknown as RegistryInput[];
  }
  if (needHistory) {
    const r = await hallInputs(email, hallId, { history: true, limit: 500 });
    if (!r.ok) return r;
    hall = hall ?? { id: r.value.hall.id, label: r.value.hall.label, orgId: r.value.hall.orgId };
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
  return { ok: true, value: { hall, today, idempotencyKey: idempotencyKeyFor(built.from.doc, built.to.doc), specs: specs as Prepared["specs"], built, comparison: compareBuilt(built.from, built.to), historyTruncated: truncated } };
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
    hall: { id: p.hall.id, label: p.hall.label },
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
      ...common(p), ran: false, reason: "missing",
      message: `The engine was not run: ${c.missing.length} figure${c.missing.length === 1 ? "" : "s"} it needs ${c.missing.length === 1 ? "is" : "are"} not recorded in a usable form at one or both points.${p.historyTruncated ? " Only the newest 500 recorded claims were read, so a figure that is not found may be outside the history window." : ""} Nothing was run and none of your runs was used.`,
    });
  }
  if (c.identical) {
    return reply({ ...common(p), ran: false, reason: "identical", message: "The figures the engine reads are the same at these two points, so there is nothing for it to compare. Nothing was run and none of your runs was used." });
  }
  return null;
}

// --------------------------------------------------------------------------------------------------------------- the allowances

/** One hash for one question: the two documents as sent, and a fixed salt. The same figures at the same two points give the same key whoever asks, so a retry is the engine's free replay. */
const IDEMPOTENCY_SALT = "gridforge-hall-engine-diff/1";
export function idempotencyKeyFor(before: unknown, after: unknown): string {
  return crypto.createHash("sha256").update(`${stable(before)}\n${stable(after)}\n${IDEMPOTENCY_SALT}`).digest("hex");
}

const GLOBAL_SUBJECT = "registry-diff-global";
const unavailable = () => reply({ ok: false, error: "This service is temporarily unavailable, so nothing was run. Try again shortly.", reason: "unavailable" }, 503);
const over = (message: string, reason: string, retryAfter: number) => {
  const r = reply({ ok: false, error: message, reason, retry_after_seconds: retryAfter }, 429);
  r.headers.set("Retry-After", String(retryAfter));
  return r;
};

/**
 * The allowances one run takes, so that ALL of them can be given back if the run fails before the engine answers. A hit that is refused is given back at once (the counters stay at
 * their cap, and a request that was turned away has used nothing). Order matters: the organisation's and the hall's counters are taken BEFORE the member's, so a team or a hall that is at its
 * cap never costs a member their own allowance.
 */
export class RunAllowance {
  private taken: { policy: RatePolicyName; subject: string }[] = [];

  /** Take one hit; null = taken, or the response to send (the hit was given back). */
  async take(policy: RatePolicyName, subject: string | null, refusal: { message: string; reason: string }): Promise<NextResponse | null> {
    if (!subject) return unavailable();
    const h = await countHit(policy, subject);
    if (!h) return unavailable();
    if (!h.allowed) {
      await refundHit(policy, subject);
      return over(refusal.message, refusal.reason, h.retryAfter);
    }
    this.taken.push({ policy, subject });
    return null;
  }

  /** Record a hit another part took for this run (the guard's per-account hour counter). */
  note(policy: RatePolicyName, subject: string | null): void {
    if (subject) this.taken.push({ policy, subject });
  }

  /** The organisation, then the hall. */
  async scope(orgId: string, hallId: string): Promise<NextResponse | null> {
    return (
      (await this.take("registry_diff_org", subjectOf(`org-diff:${orgId}`), { message: "This organisation has used its engine runs for today. Nothing was run.", reason: "org_allowance" })) ??
      (await this.take("registry_diff_hall", subjectOf(`hall-diff:${hallId}`), { message: "This hall has used its engine runs for today. Nothing was run.", reason: "hall_allowance" }))
    );
  }

  /** The member's day, then the whole site's day. The member's HOUR was taken by the guard. */
  async accountDayAndGlobal(email: string): Promise<NextResponse | null> {
    const day = await this.take("registry_diff_day", accountSubject(email), { message: "You have used your engine runs for today. Nothing was run.", reason: "account_day_allowance" });
    if (day) return day;
    const subject = subjectOf(GLOBAL_SUBJECT);
    if (!subject) return unavailable();
    const h = await countHit("registry_diff_global", subject);
    if (!h) return unavailable();
    if (!h.allowed) {
      await refundHit("registry_diff_global", subject);
      console.error(`[GridForge] hall engine diff: the site-wide daily ceiling of ${ENGINE_DIFF_GLOBAL_PER_DAY} runs is reached: runs are refused (503) until it resets. Nothing is spent beyond it.`);
      return unavailable();
    }
    this.taken.push({ policy: "registry_diff_global", subject });
    // The operator hears of it (a log line; no mail) at half the ceiling and at the ceiling, once each per day.
    if (h.count === Math.ceil(ENGINE_DIFF_GLOBAL_PER_DAY / 2)) console.error(`[GridForge] hall engine diff: 50% of the site-wide daily ceiling used (${h.count} of ${ENGINE_DIFF_GLOBAL_PER_DAY} runs).`);
    if (h.count === ENGINE_DIFF_GLOBAL_PER_DAY) console.error(`[GridForge] hall engine diff: 100% of the site-wide daily ceiling used (${h.count} of ${ENGINE_DIFF_GLOBAL_PER_DAY} runs): further runs are refused until it resets.`);
    return null;
  }

  /** Give back everything this run took. Best effort: a refund that cannot be made leaves the hit counted, which is the safe side. */
  async refundAll(): Promise<void> {
    const all = this.taken.splice(0);
    await Promise.all(all.map((t) => refundHit(t.policy, t.subject)));
  }
}

// --------------------------------------------------------------------------------------------------------------- asking the engine

const NOT_AVAILABLE = "The engine's change comparison is not available just now, so nothing was run and nothing was charged.";

/** What the engine says built the answer (its provenance), or null: an engine that does not say is shown as not saying. The digest is a hash of the ENGINE (its code, cost library and calibration ledger), never of anything recorded about a hall. */
function provenanceOf(body: Record<string, unknown>): { version: string; digest: string } | null {
  const p = body.provenance;
  if (typeof p !== "object" || p === null) return null;
  const { engine_version: v, digest: d } = p as { engine_version?: unknown; digest?: unknown };
  if (typeof v !== "string" || typeof d !== "string" || !/^[0-9a-f]{64}$/.test(d)) return null;
  return { version: v.slice(0, 40), digest: d };
}

/**
 * Ask the engine for the diff. The ONE place this feature spends: call it only inside the spend scope of an admitted request (guardRequest ... .run).
 * `cost_evidence: []` makes the engine attach the provenance of the build that answered, in the same response (an engine that predates that is asked once more without it). Every call
 * carries an Idempotency-Key that is a hash of the two documents, so an identical retry is the engine's own replay: free, and the same answer.
 */
export async function runEngineDiff(p: Prepared): Promise<NextResponse> {
  const doc = { before: p.built.from.doc, after: p.built.to.doc };
  let out = await callEngine("/v1/diff", { ...doc, cost_evidence: [] }, { "Idempotency-Key": p.idempotencyKey });
  if (!out.ok && out.status === 422 && /cost_evidence/.test(String(out.error))) out = await callEngine("/v1/diff", doc, { "Idempotency-Key": `${p.idempotencyKey}-nc` });
  if (!out.ok) {
    if (out.routeMissing) return fail(503, NOT_AVAILABLE, { reason: "engine_route_missing" });
    if (out.status === 422) {
      const msg = String(out.error).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300);
      return fail(422, `The engine did not accept the recorded figures: ${msg}`, { reason: "engine_refused", hall: { id: p.hall.id, label: p.hall.label } });
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
    ...common(p), ran: true,
    engine: provenanceOf(out.body),
    diff,
    carriedBy: carryingClass(diff.racksClass, c.ceiling),
  });
}
