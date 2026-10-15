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

import crypto from "node:crypto";
import { documentHash, type DeliverableRecord } from "@/lib/deliverables";
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

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

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
  "reviewer,reviewed_at,review_reason,superseded_by";

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

export interface EvidenceRun {
  created: boolean;
  run: Record<string, unknown>;
  evidence_ids: string[];
  document: string;
  document_sha256: string;
  effect: unknown;
  ignored: unknown[];
}

/**
 * Re-run the study for this engagement's intake with the CURRENTLY accepted evidence. The stored deliverable is not
 * touched; the run is recorded once per (intake, accepted evidence set), so a retry returns the same record.
 */
export async function runWithEvidence(row: DeliverableRecord, actor: string): Promise<Result<{ result: EvidenceRun }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const ok = eligible(row);
  if (!ok.ok) return ok;
  const all = await evidenceFor(row.id);
  if (!all.ok) return all;
  const accepted = all.items.filter((i) => i.state === "accepted");
  if (accepted.length === 0) {
    return { ok: false, status: 409, error: "No quotation has been accepted for this engagement, so there is nothing to apply." };
  }
  const out = await callEngine("/v1/study", {
    intake: ok.intake,
    format: "html",
    cost_evidence: accepted.map(toEngineEntry),
  });
  if (!out.ok) return out;
  const document = typeof out.data.document_full === "string" ? out.data.document_full : "";
  const block = (out.data.cost_evidence ?? {}) as { used?: { evidence_id: string }[]; ignored?: unknown[]; effect?: unknown };
  const used = (block.used ?? []).map((u) => u.evidence_id).filter(Boolean);
  if (!document || used.length === 0) {
    return { ok: false, status: 502, error: "The engine applied none of the accepted evidence. Nothing was recorded." };
  }
  const ids = [...used].sort();
  const document_sha256 = documentHash(document);
  const saved = await rpc<{ created: boolean; run: Record<string, unknown> }>("gf_record_cost_evidence_run", {
    p: {
      deliverable_id: row.id,
      intake_digest: sha(canonical(ok.intake)),
      evidence_digest: sha(ids.join(",")),
      evidence_ids: ids,
      effect: block.effect ?? {},
      ignored: block.ignored ?? [],
      document_sha256,
    },
    p_event: ev("cost_evidence_run", actor, {}),
  });
  if (!saved.ok || !saved.data) {
    return { ok: false, status: 502, error: "The run could not be recorded. Nothing was saved." };
  }
  return {
    ok: true,
    result: {
      created: saved.data.created,
      run: saved.data.run,
      evidence_ids: ids,
      document,
      document_sha256,
      effect: block.effect ?? null,
      ignored: block.ignored ?? [],
    },
  };
}
