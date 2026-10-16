// Server-only: a Time-to-Power scenario comparison saved to a Verified Power Record project.
//
// The engine answers (POST /v1/compare); this keeps the answer. One write path (gf_save_comparison, migration 0024),
// which writes the record and its `comparison_saved` event in one transaction and is idempotent in the database:
// the same key with the same answer is a replay, the same answer under another key is one record, and a key reused
// for a different answer is refused. Reading a saved comparison reads the row; nothing here recomputes.
//
// A save re-asks the engine for the request it is given and stores THAT answer, after checking it is the answer the
// customer reviewed (its digest). So a stored result is always a real engine answer for its stored request: a client
// cannot hand us a doctored result, and an engine that changed between "compare" and "save" is a 409, never a
// silently different record.

import { digestOf, sortSnapshot } from "@/lib/run-identity";
import { acceptedEvidenceForProject, toEngineEntry } from "@/lib/cost-evidence";
import { creds, ev, rest, rpc, STORE_UNCONFIGURED, type ProjectRow, type Result } from "@/lib/projects";
import { TTP_COMPARE_SCHEMA, type CompareObjective, type CompareRequest, type CompareResult } from "@/lib/ttp-compare";
import { resultDigest, runCompare } from "@/lib/ttp-compare-server";

export interface ComparisonRecord {
  id: string;
  project_id: string;
  schema: string;
  /** The body POST /v1/compare was given: what reproduces the answer at the API or `gridforge compare`. */
  request: Record<string, unknown>;
  request_digest: string;
  /** The engine's answer, verbatim. */
  result: CompareResult;
  result_digest: string;
  engine_provenance: CompareResult["provenance"];
  provenance_digest: string;
  objective: CompareObjective;
  baseline: string;
  grade: "indicative" | "screening";
  scenario_ids: string[];
  label: string | null;
  idempotency_key: string;
  actor: string;
  created_at: string;
}

/** What the project view lists: identity and provenance, never the document bodies. */
export type ComparisonSummary = Pick<
  ComparisonRecord,
  "id" | "created_at" | "label" | "objective" | "baseline" | "grade" | "request_digest" | "result_digest" | "provenance_digest" | "scenario_ids"
> & { leader: string | null; quotations_used: number };

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL = 120;
const q = encodeURIComponent;

export type SaveOutcome = Result<{ created: boolean; reason: "created" | "idempotent_replay" | "already_saved"; comparison: ComparisonRecord }>;

export interface EvidenceOffer {
  /** Every accepted line, as the engine takes it, sorted by evidence id: the same set is always the same bytes. */
  snapshot: Record<string, unknown>[];
  ids: string[];
}

/** The project's accepted quotations, ready for the engine. Only ACCEPTED lines: nothing validated, rejected,
 * superseded or withdrawn can reach a price. */
export async function projectQuotations(project: ProjectRow): Promise<Result<EvidenceOffer>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await acceptedEvidenceForProject(project.id);
  if (!r.ok) return r;
  const snapshot = sortSnapshot(r.items.map(toEngineEntry));
  return { ok: true, snapshot, ids: snapshot.map((x) => String(x.evidence_id)) };
}

const NO_QUOTATIONS: Result<never> = {
  ok: false,
  status: 409,
  error:
    "No quotation has been accepted on this project, so there is nothing to apply. Compare from the cost library, or " +
    "have a reviewer accept a supplier quotation first.",
};

export interface EvidenceUse {
  offered: string[];
  used: string[];
  ignored: { key: string; evidence_id: string | null; reason: string }[];
}

function evidenceUse(result: CompareResult, offer: EvidenceOffer): Result<{ use: EvidenceUse }> {
  const block = result.cost_evidence ?? { used: [], ignored: [] };
  const used = (block.used ?? []).map((u) => String(u.evidence_id));
  if (used.some((id) => !offer.ids.includes(id))) {
    return { ok: false, status: 502, error: "The engine reported using a quotation that was not offered. Nothing is shown." };
  }
  return { ok: true, use: { offered: offer.ids, used, ignored: block.ignored ?? [] } };
}

/**
 * Compare this hall with the project's accepted quotations priced in. Nothing is saved: the answer, its digest, the
 * exact request (quotations included) and what the engine used or ignored come back for the person to read first.
 */
export async function compareForProject(
  project: ProjectRow,
  request: CompareRequest
): Promise<Result<{ result: CompareResult; result_digest: string; engineBody: Record<string, unknown>; evidence: EvidenceUse }>> {
  const offer = await projectQuotations(project);
  if (!offer.ok) return offer;
  if (offer.ids.length === 0) return NO_QUOTATIONS;
  const run = await runCompare(request, offer.snapshot);
  if (!run.ok) return { ok: false, status: run.status, error: run.error };
  const use = evidenceUse(run.result, offer);
  if (!use.ok) return use;
  return { ok: true, result: run.result, result_digest: resultDigest(run.result), engineBody: run.engineBody, evidence: use.use };
}

export async function saveComparison(
  project: ProjectRow,
  input: {
    request: CompareRequest;
    idempotency_key: string;
    label?: string | null;
    reviewed_result_digest?: string | null;
    /** "project": price the comparison with the project's accepted quotations, as compareForProject does. */
    evidence?: "project" | null;
  }
): Promise<SaveOutcome> {
  // Fail closed before spending an engine unit: no store, no save.
  if (!creds()) return STORE_UNCONFIGURED;
  if (!IDEMPOTENCY_KEY.test(input.idempotency_key)) {
    return { ok: false, status: 422, error: "idempotency_key is required: 8 to 128 characters of letters, digits, _ . : or -." };
  }
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length > MAX_LABEL) return { ok: false, status: 422, error: `label must be at most ${MAX_LABEL} characters.` };
  const reviewed = typeof input.reviewed_result_digest === "string" ? input.reviewed_result_digest : "";
  if (reviewed && !/^[0-9a-f]{64}$/.test(reviewed)) {
    return { ok: false, status: 422, error: "reviewed_result_digest must be the result digest the comparison returned." };
  }

  // Quotations are gathered at save time, from the record, never taken from the client: a line accepted (or
  // withdrawn) since the person compared changes the answer, and the digest check below turns that into a 409.
  let offer: EvidenceOffer | null = null;
  if (input.evidence === "project") {
    const q = await projectQuotations(project);
    if (!q.ok) return q;
    if (q.ids.length === 0) return NO_QUOTATIONS;
    offer = q;
  }
  const run = await runCompare(input.request, offer?.snapshot);
  if (!run.ok) return { ok: false, status: run.status, error: run.error };
  const fresh = run.result;
  const rd = resultDigest(fresh);
  let use: EvidenceUse | null = null;
  if (offer) {
    const u = evidenceUse(fresh, offer);
    if (!u.ok) return u;
    use = u.use;
  }
  if (reviewed && reviewed !== rd) {
    return {
      ok: false,
      status: 409,
      error:
        "The engine's answer for these inputs is no longer the one you reviewed (the engine or its libraries changed). " +
        "Compare again, read the new result, then save. Nothing was saved.",
    };
  }
  if (fresh.schema !== TTP_COMPARE_SCHEMA || !fresh.provenance?.digest || !fresh.request_digest) {
    return { ok: false, status: 502, error: "The comparison carries no provenance; it was not saved." };
  }

  const scenario_ids = fresh.scenarios.map((s) => s.id);
  const r = await rpc<{ created: boolean; reason?: string; comparison: ComparisonRecord }>("gf_save_comparison", {
    p: {
      project_id: project.id,
      schema: fresh.schema,
      request: run.engineBody,
      request_digest: fresh.request_digest,
      result: fresh,
      result_digest: rd,
      engine_provenance: fresh.provenance,
      provenance_digest: fresh.provenance.digest,
      objective: fresh.objective,
      baseline: fresh.baseline,
      grade: fresh.grade,
      scenario_ids,
      label: label || null,
      idempotency_key: input.idempotency_key,
      actor: "project_token_holder",
    },
    p_event: ev("comparison_saved", "project_token_holder", {
      request_digest: fresh.request_digest,
      result_digest: rd,
      provenance_digest: fresh.provenance.digest,
      objective: fresh.objective,
      grade: fresh.grade,
      scenario_ids,
      // Identifiers only: which accepted quotations were offered and which priced a line. Never a price.
      evidence_offered: use?.offered ?? [],
      evidence_used: use?.used ?? [],
    }),
  });
  if (!r.ok) {
    if (r.code === "23505") {
      return {
        ok: false,
        status: 409,
        error: "This idempotency key was already used to save a different comparison on this project. Nothing was saved.",
      };
    }
    return { ok: false, status: r.status === 503 ? 503 : 502, error: "The comparison could not be saved. Nothing was recorded." };
  }
  const out = r.data;
  if (!out || typeof out !== "object" || !out.comparison || !UUID.test(String(out.comparison.id))) {
    // The store answered 2xx with something that is not a record: do not report a save it did not confirm.
    return { ok: false, status: 502, error: "The store did not confirm the saved comparison. Treat it as not saved." };
  }
  const reason = out.created ? "created" : out.reason === "idempotent_replay" ? "idempotent_replay" : "already_saved";
  return { ok: true, created: out.created === true, reason, comparison: out.comparison };
}

export async function listComparisons(project: ProjectRow): Promise<Result<{ comparisons: ComparisonSummary[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  type Row = Omit<ComparisonSummary, "leader" | "quotations_used"> & { leader?: string | null; applied?: unknown; result?: CompareResult };
  const r = await rest<Row[]>(
    "GET",
    `project_comparisons?project_id=eq.${q(project.id)}` +
      `&select=id,created_at,label,objective,baseline,grade,request_digest,result_digest,provenance_digest,scenario_ids,leader:result->ranking->>leader,applied:result->evidence_applied` +
      `&order=created_at.desc,id.desc`
  );
  if (!r.ok) return { ok: false, status: r.status === 503 ? 503 : 502, error: "The saved comparisons could not be read." };
  return {
    ok: true,
    comparisons: (r.data ?? []).map((x) => ({
      id: x.id,
      created_at: x.created_at,
      label: x.label ?? null,
      objective: x.objective,
      baseline: x.baseline,
      grade: x.grade,
      request_digest: x.request_digest,
      result_digest: x.result_digest,
      provenance_digest: x.provenance_digest,
      scenario_ids: Array.isArray(x.scenario_ids) ? x.scenario_ids : [],
      // Real PostgREST answers the JSON-path select; a store that returns the whole row is read the same way.
      leader: typeof x.leader === "string" ? x.leader : x.result?.ranking?.leader ?? null,
      quotations_used: Array.isArray(x.applied) ? x.applied.length : Array.isArray(x.result?.evidence_applied) ? x.result!.evidence_applied.length : 0,
    })),
  };
}

/** One saved comparison, as stored. Scoped by the project the token opened: another project's record is "Not found". */
export async function getComparison(project: ProjectRow, id: string): Promise<Result<{ comparison: ComparisonRecord }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  if (!UUID.test(id)) return { ok: false, status: 404, error: "Not found." };
  const r = await rest<ComparisonRecord[]>(
    "GET",
    `project_comparisons?project_id=eq.${q(project.id)}&id=eq.${q(id)}&select=*&limit=1`
  );
  if (!r.ok) return { ok: false, status: r.status === 503 ? 503 : 502, error: "The saved comparison could not be read." };
  const row = r.data?.[0];
  if (!row) return { ok: false, status: 404, error: "Not found." };
  // Integrity: the stored answer must still hash to the digest recorded beside it, or it is not shown.
  if (resultDigest(row.result) !== row.result_digest || row.result?.request_digest !== row.request_digest) {
    console.error("[GridForge] saved comparison failed its integrity check; refusing to serve it");
    return { ok: false, status: 502, error: "The saved comparison does not match its recorded digest and was not served." };
  }
  return { ok: true, comparison: row };
}

/** Deterministic identity of the stored request, for callers that want to compare two records' questions. */
export const requestDigestOf = (request: Record<string, unknown>): string => digestOf(request);
