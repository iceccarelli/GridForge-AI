// Server-only: a supplier's quotation becomes cost evidence only by a named person's decision.
//
//   Procurement Specification (a deliverable) -> supplier responses -> engine-validated quote LINES (received)
//     -> human review (accepted | rejected) -> retired later (superseded | withdrawn)
//     -> a NEW engine run that applies the accepted lines to that one request and records which it used.
//
// What this file deliberately does not do:
//   * It never decides a quote is trustworthy. Validation is the engine's (`/v1/bids`, evidence_only), review is a
//     person's (the admin route), and receipt alone gives a line no authority at all.
//   * It never edits the cost library or a stored deliverable. Accepted lines are handed to the engine for ONE
//     request, so every earlier document keeps the prices it was written with.
//   * It never multiplies or divides a price. Whether a quote is a lump covering a stated quantity or a per-unit
//     price is carried by the engine's line (unit, quoted_quantity, quoted_quantity_unit) and read back verbatim.
//   * It never returns supplier pricing to anyone but the holder of the engagement's own document token (who
//     submitted it) or an authenticated administrator. Nothing here logs a price or a supplier.

import type { DeliverableRecord } from "@/lib/deliverables";
import {
  ARTIFACT_MEDIA_TYPE,
  artifactPath,
  artifactRef,
  deleteArtifact,
  putVerified,
  readVerified,
} from "@/lib/artifact-store";
import {
  RUN_IDENTITY_VERSION,
  RUN_REQUEST_OPTIONS,
  digestOf,
  runFingerprint,
  sha256Hex,
  sortSnapshot,
} from "@/lib/run-identity";
import { creds, ev, rest, rpc, STORE_UNCONFIGURED, type Result } from "@/lib/projects";

export const MAX_RESPONSES = 20;
export const BASES = ["budgetary_quote", "firm_quote", "contracted"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface QuoteLineWire {
  key: string;
  unit: string;
  value: number | null;
  submitted_value: number | null;
  currency: string;
  supplier: string;
  received_on: string;
  valid_until: string;
  reference: string;
  scope: string;
  quoted_quantity: number | null;
  quoted_quantity_unit: string | null;
  specification: Record<string, unknown>;
  response_digest: string;
  status: "validated" | "invalid";
  problems: string[];
  limitations: string[];
  comparability: "exact" | "limited";
  digest: string;
}

export type EvidenceState = "validated" | "invalid" | "accepted" | "rejected" | "superseded" | "withdrawn";

export interface EvidenceRow {
  id: string;
  deliverable_id: string;
  project_id: string | null;
  cost_key: string;
  unit: string;
  value: number | null;
  currency: string;
  supplier: string;
  received_on: string | null;
  valid_until: string | null;
  reference: string | null;
  scope: string;
  quoted_quantity: number | null;
  quoted_quantity_unit: string | null;
  specification: Record<string, unknown>;
  response_digest: string;
  validation_status: "validated" | "invalid";
  problems: string[];
  limitations: string[];
  comparability: "exact" | "limited";
  synthetic: boolean;
  submitted_at: string;
  state: EvidenceState;
  reviewed_basis: string | null;
  reviewed_comparability: string | null;
  includes_keys: string[] | null;
  reviewed_region: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  superseded_by: string | null;
  retired_kind: "superseded" | "withdrawn" | null;
  retired_at: string | null;
  retirement_reason: string | null;
  retired_by: string | null;
}

function engine(): { base: string; key: string } | null {
  const base = process.env.GRIDFORGE_API_URL;
  const key = process.env.GRIDFORGE_API_KEY;
  return base && key ? { base: base.replace(/\/$/, ""), key } : null;
}

async function callEngine(
  path: string,
  body: Record<string, unknown>
): Promise<Result<{ data: Record<string, unknown> }>> {
  const e = engine();
  if (!e) return { ok: false, status: 503, error: "The capacity engine is not connected to this deployment." };
  try {
    const res = await fetch(`${e.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": e.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = typeof data?.error === "string" ? data.error : `engine ${res.status}`;
      // 422 is the caller's input being wrong, which they can fix; anything else is ours. The body is not logged:
      // it holds supplier pricing.
      console.error("[GridForge] cost-evidence engine call refused:", path, res.status);
      return { ok: false, status: res.status === 422 ? 422 : 502, error: detail };
    }
    return { ok: true, data };
  } catch {
    console.error("[GridForge] cost-evidence engine unreachable:", path);
    return { ok: false, status: 502, error: "The capacity engine could not be reached." };
  }
}

/** The customer's own numbers only: `_gridforge` is ours. */
function engineIntake(row: DeliverableRecord): Record<string, unknown> | null {
  const intake = (row.intake ?? null) as Record<string, unknown> | null;
  if (!intake) return null;
  const clean = { ...intake };
  delete clean._gridforge;
  return clean;
}

function constraintOf(row: DeliverableRecord): string {
  const meta = ((row.intake ?? {}) as Record<string, unknown>)._gridforge as { spec?: { constraint_id?: string } } | undefined;
  return meta?.spec?.constraint_id ?? "";
}

function eligible(row: DeliverableRecord): Result<{ intake: Record<string, unknown> }> {
  if (row.kind !== "procurement_spec") {
    return {
      ok: false,
      status: 409,
      error: `Cost evidence comes from the Procurement Specification. This engagement is a ${row.kind.replace(/_/g, " ")}.`,
    };
  }
  if (row.status !== "released") return { ok: false, status: 409, error: "The specification has not been released yet." };
  const intake = engineIntake(row);
  if (!intake) return { ok: false, status: 409, error: "This engagement has no intake yet." };
  return { ok: true, intake };
}

// ------------------------------------------------------------------------ received

/**
 * Validate completed response schedules against the specification they answer and record every priced line as
 * RECEIVED. Idempotent: the same response submitted again is the same row. Nothing here accepts anything.
 */
export async function submitQuotes(
  row: DeliverableRecord,
  responses: unknown[],
  opts: { synthetic?: boolean; submitted_by: string }
): Promise<Result<{ lines: { id: string; created: boolean; line: QuoteLineWire }[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const ok = eligible(row);
  if (!ok.ok) return ok;
  if (!Array.isArray(responses) || responses.length === 0) {
    return { ok: false, status: 422, error: "Send the completed response schedules as { responses: [ ... ] }." };
  }
  if (responses.length > MAX_RESPONSES) {
    return { ok: false, status: 422, error: `That is more than ${MAX_RESPONSES} responses.` };
  }
  const submitted_by = opts.submitted_by.trim();
  if (!submitted_by || submitted_by.length > 120) {
    return { ok: false, status: 422, error: "submitted_by is required: who is submitting these quotations." };
  }
  const out = await callEngine("/v1/bids", {
    intake: ok.intake,
    responses,
    constraint: constraintOf(row),
    evidence_only: true,
  });
  if (!out.ok) return out;
  const lines = Array.isArray(out.data.lines) ? (out.data.lines as QuoteLineWire[]) : [];
  if (lines.length === 0) return { ok: false, status: 502, error: "The engine returned no quotation lines." };

  const recorded: { id: string; created: boolean; line: QuoteLineWire }[] = [];
  for (const line of lines) {
    const saved = await rpc<{ created: boolean; id: string }>("gf_submit_cost_evidence", {
      p: {
        deliverable_id: row.id,
        line_digest: line.digest,
        cost_key: line.key,
        unit: line.unit,
        value: line.value,
        submitted_value: line.submitted_value,
        currency: line.currency,
        supplier: line.supplier,
        received_on: ISO_DATE.test(line.received_on ?? "") ? line.received_on : null,
        valid_until: ISO_DATE.test(line.valid_until ?? "") ? line.valid_until : null,
        reference: line.reference || null,
        scope: line.scope,
        quoted_quantity: line.quoted_quantity,
        quoted_quantity_unit: line.quoted_quantity_unit,
        specification: line.specification,
        response_digest: line.response_digest,
        validation_status: line.status,
        problems: line.problems,
        limitations: line.limitations,
        comparability: line.comparability,
        synthetic: opts.synthetic === true,
      },
      p_event: ev("cost_evidence_received", submitted_by, {}),
    });
    if (!saved.ok || !saved.data) {
      return {
        ok: false,
        status: 502,
        error:
          `${recorded.length} of ${lines.length} quotation lines were recorded before the store failed. ` +
          "Submit the same responses again: lines already recorded are not duplicated.",
      };
    }
    recorded.push({ id: saved.data.id, created: saved.data.created, line });
  }
  return { ok: true, lines: recorded };
}

// ------------------------------------------------------------------------ read

const COLUMNS =
  "id,deliverable_id,project_id,cost_key,unit,value,currency,supplier,received_on,valid_until,reference,scope," +
  "quoted_quantity,quoted_quantity_unit,specification,response_digest,validation_status,problems,limitations," +
  "comparability,synthetic,submitted_at,state,reviewed_basis,reviewed_comparability,includes_keys,reviewed_region," +
  "reviewer,reviewed_at,review_reason,superseded_by,retired_kind,retired_at,retirement_reason,retired_by";

export async function evidenceFor(deliverable_id: string): Promise<Result<{ items: EvidenceRow[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rest<EvidenceRow[]>(
    "GET",
    `cost_evidence_state?deliverable_id=eq.${encodeURIComponent(deliverable_id)}&select=${COLUMNS}&order=submitted_at.asc,id.asc`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The cost evidence could not be read." };
  return { ok: true, items: r.data ?? [] };
}

/** Every line awaiting a decision, across engagements — the administrator's queue. */
export async function evidenceQueue(state: "pending" | "all"): Promise<Result<{ items: EvidenceRow[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const filter = state === "pending" ? "&state=eq.validated" : "";
  const r = await rest<EvidenceRow[]>("GET", `cost_evidence_state?select=${COLUMNS}${filter}&order=submitted_at.desc`);
  if (!r.ok) return { ok: false, status: 502, error: "The cost evidence queue could not be read." };
  return { ok: true, items: r.data ?? [] };
}

// ------------------------------------------------------------------------ decision

export async function reviewEvidence(input: Record<string, unknown>): Promise<Result<{ review: unknown; superseded: string[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const id = typeof input.evidence_id === "string" ? input.evidence_id : "";
  if (!UUID.test(id)) return { ok: false, status: 404, error: "Not found." };
  const decision = input.decision;
  if (decision !== "accepted" && decision !== "rejected") {
    return { ok: false, status: 422, error: "decision must be 'accepted' or 'rejected'." };
  }
  const reviewer = typeof input.reviewer === "string" ? input.reviewer.trim() : "";
  if (!reviewer || reviewer.length > 120) {
    return { ok: false, status: 422, error: "reviewer is required: the person taking this decision." };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) || null : null;
  const p: Record<string, unknown> = { evidence_id: id, decision, reviewer, reason };
  if (decision === "accepted") {
    // Never inferred and never defaulted: the reviewer says what kind of quotation this is.
    if (typeof input.basis !== "string" || !(BASES as readonly string[]).includes(input.basis)) {
      return { ok: false, status: 422, error: `An accepted quotation needs a basis (${BASES.join(", ")}).` };
    }
    if (input.comparability !== "exact" && input.comparability !== "limited") {
      return { ok: false, status: 422, error: "An accepted quotation needs a comparability ('exact' or 'limited')." };
    }
    const includes = input.includes_keys ?? [];
    if (!Array.isArray(includes) || includes.some((k) => typeof k !== "string") || includes.length > 20) {
      return { ok: false, status: 422, error: "includes_keys must be a list of cost-library keys the quotation also covers." };
    }
    const region = typeof input.region === "string" ? input.region.trim().slice(0, 80) : "";
    Object.assign(p, { basis: input.basis, comparability: input.comparability, includes_keys: includes, region });
  } else if (input.basis != null || input.comparability != null) {
    return { ok: false, status: 422, error: "A rejected quotation carries no basis or comparability." };
  }
  const done = await rpc<{ review: unknown; superseded: string[] }>("gf_review_cost_evidence", {
    p,
    p_event: ev("cost_evidence_reviewed", reviewer, {}),
  });
  if (!done.ok || !done.data) {
    if (done.ok === false && done.code === "23503") return { ok: false, status: 404, error: "Not found." };
    if (done.ok === false && done.code === "23505") {
      return { ok: false, status: 409, error: "This quotation has already been reviewed." };
    }
    if (done.ok === false && done.code === "23514") {
      return { ok: false, status: 422, error: "That quotation cannot be accepted: it is invalid or has expired." };
    }
    return { ok: false, status: 502, error: "The review could not be saved. Nothing was recorded." };
  }
  return { ok: true, review: done.data.review, superseded: done.data.superseded ?? [] };
}

export async function withdrawEvidence(input: Record<string, unknown>): Promise<Result<{ id: string }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const id = typeof input.evidence_id === "string" ? input.evidence_id : "";
  if (!UUID.test(id)) return { ok: false, status: 404, error: "Not found." };
  const by = typeof input.retired_by === "string" ? input.retired_by.trim() : "";
  if (!by || by.length > 120) return { ok: false, status: 422, error: "retired_by is required: the person withdrawing this quotation." };
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) || null : null;
  const done = await rpc<{ id: string }>("gf_retire_cost_evidence", {
    p: { evidence_id: id, retired_by: by, reason },
    p_event: ev("cost_evidence_retired", by, {}),
  });
  if (!done.ok || !done.data) {
    if (done.ok === false && done.code === "23503") return { ok: false, status: 404, error: "Not found." };
    if (done.ok === false && done.code === "23514") {
      return { ok: false, status: 409, error: "Only accepted evidence can be withdrawn." };
    }
    return { ok: false, status: 502, error: "The withdrawal could not be saved. Nothing was recorded." };
  }
  return { ok: true, id: done.data.id };
}

// ------------------------------------------------------------------------ the next run

/** An accepted row as the engine's CostEntry: provenance carried, nothing re-derived. */
export function toEngineEntry(r: EvidenceRow): Record<string, unknown> {
  return {
    key: r.cost_key,
    label: `${r.scope} (${r.supplier})`,
    unit: r.unit,
    value: Number(r.value),
    basis: r.reviewed_basis,
    supplier: r.supplier,
    quoted_on: r.received_on,
    valid_until: r.valid_until,
    region: r.reviewed_region || null,
    project: r.project_id,
    currency: r.currency,
    quoted_quantity: r.quoted_quantity === null ? null : Number(r.quoted_quantity),
    quoted_quantity_unit: r.quoted_quantity_unit,
    scope: r.scope,
    comparability: r.reviewed_comparability,
    status: "accepted",
    evidence_id: r.id,
    response_ref: r.response_digest,
    reviewer: r.reviewer,
    reviewed_on: (r.reviewed_at ?? "").slice(0, 10),
    includes_keys: r.includes_keys ?? [],
    synthetic: r.synthetic,
  };
}

/** A recorded run, as the database holds it. `run_fingerprint === null` marks a LEGACY run: no artifact was ever kept. */
export interface RunRow {
  id: string;
  deliverable_id: string;
  project_id: string | null;
  intake_digest: string;
  evidence_digest: string;
  evidence_ids: string[];
  effect: unknown;
  ignored: unknown[];
  document_sha256: string;
  created_at: string;
  identity_version: string | null;
  run_fingerprint: string | null;
  accepted_snapshot_digest: string | null;
  accepted_evidence_ids: string[] | null;
  engine_provenance: { engine_version?: string; digest?: string } | null;
  engine_fingerprint: string | null;
  report_date: string | null;
  artifact_storage_ref: string | null;
  artifact_sha256: string | null;
  artifact_bytes: number | null;
  artifact_media_type: string | null;
}

const RUN_COLUMNS =
  "id,deliverable_id,project_id,intake_digest,evidence_digest,evidence_ids,effect,ignored,document_sha256,created_at," +
  "identity_version,run_fingerprint,accepted_snapshot_digest,accepted_evidence_ids,engine_provenance,engine_fingerprint," +
  "report_date,artifact_storage_ref,artifact_sha256,artifact_bytes,artifact_media_type";

export interface EvidenceRun {
  created: boolean;
  run: RunRow;
  evidence_ids: string[];
  accepted_evidence_ids: string[];
  /** The bytes read back from private storage and verified against the run's recorded digest and length. */
  document: string;
  document_sha256: string;
  effect: unknown;
  ignored: unknown[];
  /** Another request's candidate for this identity produced different bytes. The persisted artifact was returned. */
  determinism_warning: boolean;
}

interface Prepared {
  intake: Record<string, unknown>;
  snapshot: Record<string, unknown>[];
  intake_digest: string;
  accepted_snapshot_digest: string;
  accepted_ids: string[];
  provenance: { digest: string; report_date?: string } & Record<string, unknown>;
  fingerprint: string;
}

async function engineProvenance(): Promise<Result<{ provenance: Prepared["provenance"] }>> {
  const e = engine();
  if (!e) return { ok: false, status: 503, error: "The capacity engine is not connected to this deployment." };
  try {
    const res = await fetch(`${e.base}/v1/version`, {
      headers: { "X-API-Key": e.key },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { provenance?: Prepared["provenance"] };
    const p = data.provenance;
    if (!res.ok || !p || !/^[0-9a-f]{64}$/.test(String(p.digest))) {
      // No invented version: an engine that cannot say what it is cannot have its output recorded as a versioned run.
      console.error("[GridForge] engine provenance unavailable:", res.status);
      return { ok: false, status: 502, error: "The capacity engine did not report its build and library identity. Nothing was recorded." };
    }
    return { ok: true, provenance: p };
  } catch {
    console.error("[GridForge] engine provenance unreachable");
    return { ok: false, status: 502, error: "The capacity engine could not be reached." };
  }
}

/** Everything a run's identity is made of, computed from the engagement, the CURRENT accepted evidence and the engine. */
async function prepare(row: DeliverableRecord): Promise<Result<{ prep: Prepared }>> {
  const ok = eligible(row);
  if (!ok.ok) return ok;
  const all = await evidenceFor(row.id);
  if (!all.ok) return all;
  const accepted = all.items.filter((i) => i.state === "accepted");
  if (accepted.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "No quotation has been accepted for this engagement, so there is nothing to apply.",
    };
  }
  const prov = await engineProvenance();
  if (!prov.ok) return prov;
  const snapshot = sortSnapshot(accepted.map(toEngineEntry));
  const intake_digest = digestOf(ok.intake);
  const accepted_snapshot_digest = digestOf(snapshot);
  return {
    ok: true,
    prep: {
      intake: ok.intake,
      snapshot,
      intake_digest,
      accepted_snapshot_digest,
      accepted_ids: snapshot.map((s) => String(s.evidence_id)),
      provenance: prov.provenance,
      fingerprint: runFingerprint({
        deliverable_id: row.id,
        intake_digest,
        accepted_snapshot_digest,
        engine_fingerprint: prov.provenance.digest,
      }),
    },
  };
}

async function runByFingerprint(deliverable_id: string, fingerprint: string): Promise<Result<{ run: RunRow | null }>> {
  const r = await rest<RunRow[]>(
    "GET",
    `cost_evidence_runs?deliverable_id=eq.${encodeURIComponent(deliverable_id)}&run_fingerprint=eq.${fingerprint}&select=${RUN_COLUMNS}&limit=1`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The run record could not be read." };
  return { ok: true, run: r.data?.[0] ?? null };
}

/** The persisted artifact of a run, proven against the digest and length the database recorded for it. */
async function verifiedDocument(run: RunRow): Promise<Result<{ bytes: Buffer }>> {
  if (!run.artifact_storage_ref || !run.artifact_sha256 || !run.artifact_bytes) {
    return { ok: false, status: 404, error: "This run predates durable artifact storage: its document was never kept." };
  }
  const got = await readVerified(run.artifact_storage_ref, { sha256: run.artifact_sha256, bytes: Number(run.artifact_bytes) });
  if (!got.ok) {
    return {
      ok: false,
      status: 502,
      error:
        got.kind === "unavailable"
          ? "The stored document is temporarily unavailable. Try again."
          : "The stored document for this run could not be verified against its recorded digest, so it was not served.",
    };
  }
  return { ok: true, bytes: got.bytes };
}

const asEvidenceRun = (created: boolean, run: RunRow, bytes: Buffer, warn: boolean): EvidenceRun => ({
  created,
  run,
  evidence_ids: run.evidence_ids,
  accepted_evidence_ids: run.accepted_evidence_ids ?? [],
  document: bytes.toString("utf8"),
  document_sha256: run.document_sha256,
  effect: run.effect,
  ignored: run.ignored,
  determinism_warning: warn,
});

/**
 * Re-run the study for this engagement's intake with the CURRENTLY accepted evidence and keep the result.
 *
 * The run's identity is its fingerprint (lib/run-identity.ts). The DATABASE RECORD is the authority:
 *   1. identity already recorded  -> read ITS artifact from private storage, prove it, return it. The engine is not
 *      called, and nothing newly generated can ever be returned under an old record.
 *   2. otherwise run the engine once, store the exact bytes (no overwrite), read them back and prove them, then record
 *      the run and the artifact reference in one RPC. If a concurrent request recorded the identity first, the
 *      RPC hands back THAT row and this request returns the winner's verified artifact, never its own candidate.
 * A response of ok therefore means: the run is recorded, and its artifact is stored, readable and verified.
 * The stored deliverable is never touched.
 */
export async function runWithEvidence(row: DeliverableRecord, actor: string): Promise<Result<{ result: EvidenceRun }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const prepared = await prepare(row);
  if (!prepared.ok) return prepared;
  const { prep } = prepared;

  const existing = await runByFingerprint(row.id, prep.fingerprint);
  if (!existing.ok) return existing;
  if (existing.run) {
    const doc = await verifiedDocument(existing.run);
    if (!doc.ok) return doc;
    return { ok: true, result: asEvidenceRun(false, existing.run, doc.bytes, false) };
  }

  const out = await callEngine("/v1/study", {
    intake: prep.intake,
    format: RUN_REQUEST_OPTIONS.format,
    cost_evidence: prep.snapshot,
  });
  if (!out.ok) return out;
  const document = typeof out.data.document_full === "string" ? out.data.document_full : "";
  const block = (out.data.cost_evidence ?? {}) as { used?: { evidence_id: string }[]; ignored?: unknown[]; effect?: unknown };
  const used = (block.used ?? []).map((u) => u.evidence_id).filter(Boolean);
  if (!document || used.length === 0) {
    return { ok: false, status: 502, error: "The engine applied none of the accepted evidence. Nothing was recorded." };
  }
  // The identity was computed against the engine that answered /v1/version. If a different build answered the study,
  // the document does not belong under that fingerprint: record nothing, say so, let the caller retry.
  const produced = (out.data.provenance ?? {}) as { digest?: string; report_date?: string };
  if (produced.digest !== prep.provenance.digest || !/^\d{4}-\d{2}-\d{2}$/.test(String(produced.report_date))) {
    return {
      ok: false,
      status: 502,
      error: "The capacity engine changed while this run was being made, so the result was not recorded. Try again.",
    };
  }
  if (used.some((id) => !prep.accepted_ids.includes(id))) {
    return { ok: false, status: 502, error: "The engine reported using evidence that was not submitted. Nothing was recorded." };
  }

  const bytes = Buffer.from(document, "utf8");
  const meta = { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  const ref = artifactRef(artifactPath(row.id, prep.fingerprint, meta.sha256));
  const stored = await putVerified(ref, bytes, meta);
  if (!stored.ok) {
    // A write the store acknowledged but that read back wrong must not sit at this path and block every retry (the path
    // is fixed by the digest). Remove it only if no run references it.
    if (stored.kind === "corrupt") await discardCandidate(ref);
    return { ok: false, status: 502, error: "The study document could not be stored durably. Nothing was recorded." };
  }

  const ids = [...new Set(used)].sort();
  const saved = await rpc<{ created: boolean; run: RunRow }>("gf_record_cost_evidence_run", {
    p: {
      deliverable_id: row.id,
      identity_version: RUN_IDENTITY_VERSION,
      run_fingerprint: prep.fingerprint,
      intake_digest: prep.intake_digest,
      intake_snapshot: prep.intake,
      accepted_snapshot: prep.snapshot,
      accepted_snapshot_digest: prep.accepted_snapshot_digest,
      accepted_evidence_ids: prep.accepted_ids,
      // Meaning unchanged from 0022: the evidence the engine actually USED.
      evidence_digest: sha256Hex(ids.join(",")),
      evidence_ids: ids,
      effect: block.effect ?? {},
      ignored: block.ignored ?? [],
      engine_provenance: prep.provenance,
      engine_fingerprint: prep.provenance.digest,
      request_options: RUN_REQUEST_OPTIONS,
      report_date: produced.report_date,
      document_sha256: meta.sha256,
      artifact_storage_ref: ref,
      artifact_sha256: meta.sha256,
      artifact_bytes: meta.bytes,
      artifact_media_type: ARTIFACT_MEDIA_TYPE,
    },
    p_event: ev("cost_evidence_run", actor, {}),
  });
  if (!saved.ok || !saved.data) {
    // The record failed, so the run does not exist. Remove the candidate only if provably nothing references it.
    await discardCandidate(ref);
    return { ok: false, status: 502, error: "The run could not be recorded. Nothing was saved." };
  }

  const winner = saved.data.run;
  if (saved.data.created) {
    // The row is committed. Prove the object is still there before calling this a success: a concurrent request's cleanup
    // of an identical-bytes candidate (it cannot see a row that did not exist yet) could have removed it. Re-writing the
    // SAME bytes to the SAME digest-bearing path restores it without changing what the row references.
    let still = await readVerified(ref, meta);
    if (!still.ok && still.kind !== "unavailable") {
      const healed = await putVerified(ref, bytes, meta);
      still = healed.ok ? await readVerified(ref, meta) : healed;
    }
    if (!still.ok) {
      return { ok: false, status: 502, error: "The run was recorded but its stored document could not be verified. It was not served." };
    }
    return { ok: true, result: asEvidenceRun(true, winner, bytes, false) };
  }

  // Lost a race: the database already holds this identity. Our candidate never becomes the answer.
  const warn = winner.artifact_sha256 !== meta.sha256;
  if (warn) console.error("[GridForge] determinism warning: two candidates differ for one cost-evidence run identity");
  if (winner.artifact_storage_ref !== ref) await discardCandidate(ref);
  const doc = await verifiedDocument(winner);
  if (!doc.ok) return doc;
  return { ok: true, result: asEvidenceRun(false, winner, doc.bytes, warn) };
}

/** Delete an artifact object only after the database confirms no run references it. If that cannot be proven, keep it. */
export async function discardCandidate(ref: string): Promise<boolean> {
  const refd = await rest<{ id: string }[]>(
    "GET",
    `cost_evidence_runs?artifact_storage_ref=eq.${encodeURIComponent(ref)}&select=id&limit=1`
  );
  if (!refd.ok || (refd.data ?? []).length > 0) return false;
  return deleteArtifact(ref);
}

// ------------------------------------------------------------------------ history and retrieval

/** What the holder of the engagement may see of a run: identity, provenance and integrity. No storage reference, no
 * snapshot of other quotations, no intake copy. */
export function runView(r: RunRow, currentFingerprint: string | null | undefined) {
  const stored = r.run_fingerprint !== null && !!r.artifact_storage_ref;
  return {
    id: r.id,
    created_at: r.created_at,
    legacy: r.run_fingerprint === null,
    run_fingerprint: r.run_fingerprint,
    identity_version: r.identity_version,
    // true / false once the current identity could be computed; null when it could not (no accepted evidence, or the
    // engine could not be asked).
    is_current: currentFingerprint === undefined || currentFingerprint === null ? null : r.run_fingerprint === currentFingerprint,
    intake_digest: r.intake_digest,
    accepted_snapshot_digest: r.accepted_snapshot_digest,
    accepted_evidence_ids: r.accepted_evidence_ids,
    used_evidence_ids: r.evidence_ids,
    ignored_evidence: Array.isArray(r.ignored) ? r.ignored : [],
    effect: r.effect,
    engine: r.engine_provenance
      ? { version: r.engine_provenance.engine_version ?? null, fingerprint: r.engine_fingerprint }
      : null,
    report_date: r.report_date,
    artifact: stored
      ? {
          status: "stored" as const,
          sha256: r.artifact_sha256,
          bytes: r.artifact_bytes === null ? null : Number(r.artifact_bytes),
          media_type: r.artifact_media_type,
        }
      : {
          status: "legacy_unavailable" as const,
          sha256: null,
          bytes: null,
          media_type: null,
          note: "Recorded before durable artifact storage. The hash of the original document is on file but the document itself was not kept.",
          legacy_document_sha256: r.document_sha256,
        },
  };
}

export async function runsFor(deliverable_id: string): Promise<Result<{ runs: RunRow[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rest<RunRow[]>(
    "GET",
    `cost_evidence_runs?deliverable_id=eq.${encodeURIComponent(deliverable_id)}&select=${RUN_COLUMNS}&order=created_at.desc,id.desc`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The run history could not be read." };
  return { ok: true, runs: r.data ?? [] };
}

/** The identity a run would have if requested right now, or null when there is none or it cannot be computed. */
export async function currentRunFingerprint(row: DeliverableRecord): Promise<string | null> {
  const p = await prepare(row);
  return p.ok ? p.prep.fingerprint : null;
}

/** One run's verified artifact, addressed through the engagement the caller's token resolved. A run id alone grants nothing. */
export async function runArtifact(
  row: DeliverableRecord,
  runId: string
): Promise<Result<{ run: RunRow; bytes: Buffer }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  if (!UUID.test(runId)) return { ok: false, status: 404, error: "Not found." };
  const r = await rest<RunRow[]>(
    "GET",
    `cost_evidence_runs?id=eq.${runId}&deliverable_id=eq.${encodeURIComponent(row.id)}&select=${RUN_COLUMNS}&limit=1`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The run record could not be read." };
  const run = r.data?.[0];
  if (!run) return { ok: false, status: 404, error: "Not found." };
  const doc = await verifiedDocument(run);
  if (!doc.ok) return doc;
  return { ok: true, run, bytes: doc.bytes };
}
