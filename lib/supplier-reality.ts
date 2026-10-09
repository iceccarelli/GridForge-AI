// Server-only: what a supplier promised against what the project experienced.
//
//   selected supplier's stored quote -> typed actual-delivery record -> human review -> derived comparison
//
// A RECORD, not a signal. Nothing here feeds gridforge/costs.py, supplier rankings, benchmarks or
// the calibration ledger. The quote is never typed by the submitter: the database copies it from the
// stored response of the package's selection. Every delivery fact may be unknown; unknown is stored as
// unknown. A cost is only ever compared against the quote when the submitter states it covers the same
// scope and the currency matches. A correction is a new record superseding exactly one earlier one.

import {
  creds,
  ev,
  rest,
  rpc,
  STORE_UNCONFIGURED,
  type ProjectRow,
  type Result,
} from "@/lib/projects";
import { getPackage } from "@/lib/project-procurement";

export const DATE_FACTS = ["po_date", "dispatch_date", "on_site_date", "install_complete_date", "energised_date"] as const;
export const VERIFIABLE_FIELDS = [...DATE_FACTS, "actual_cost"] as const;
export const COST_SCOPES = ["same_as_quote", "differs", "unknown"] as const;

export interface ActualRow {
  id: string;
  project_id: string;
  package_id: string;
  selected_response_id: string;
  supplier: string;
  case_token: string;
  case_revision: number;
  architecture: string;
  quoted_capex_eur: number | null;
  quoted_lead_time_weeks: number | null;
  quoted_install_weeks: number | null;
  po_date: string | null;
  dispatch_date: string | null;
  on_site_date: string | null;
  install_complete_date: string | null;
  energised_date: string | null;
  actual_cost: number | null;
  actual_cost_currency: string | null;
  cost_scope: (typeof COST_SCOPES)[number] | null;
  cost_scope_note: string | null;
  evidence_id: string;
  method: string;
  submitted_by: string;
  submitted_at: string;
  supersedes_id: string | null;
  note: string | null;
}

export interface ActualReviewRow {
  id: string;
  actual_id: string;
  project_id: string;
  decision: "verified" | "rejected";
  verified_fields: string[];
  reviewer: string;
  reason: string | null;
  reviewed_at: string;
}

export interface RealityRow {
  actual_id: string;
  quoted_lead_time_weeks: number | null;
  actual_lead_time_weeks: number | null;
  lead_time_basis: string;
  quoted_install_weeks: number | null;
  actual_install_weeks: number | null;
  install_basis: string;
  quoted_capex_eur: number | null;
  actual_cost: number | null;
  actual_cost_currency: string | null;
  cost_scope: string | null;
  cost_delta_eur: number | null;
  cost_basis: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isoDate(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return undefined;
  return v;
}

/** The facts of one record that a reviewer could vouch for. */
export function suppliedFacts(a: ActualRow): string[] {
  return VERIFIABLE_FIELDS.filter((f) => a[f] !== null && a[f] !== undefined);
}

/** Record what happened after a supplier was selected. */
export async function submitSupplierActual(
  project: ProjectRow,
  packageToken: string,
  input: Record<string, unknown>
): Promise<Result<{ actual: ActualRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const pk = await getPackage(project, packageToken);
  if (!pk.ok) return pk;
  if (!pk.pkg.selected_supplier) {
    return { ok: false, status: 409, error: "No supplier has been selected for this package, so there is no quote to compare against." };
  }

  const dates: Record<string, string | null> = {};
  const today = new Date().toISOString().slice(0, 10);
  for (const f of DATE_FACTS) {
    const d = isoDate(input[f]);
    if (d === undefined) return { ok: false, status: 422, error: `${f} must be an ISO date (YYYY-MM-DD) or left out if unknown.` };
    if (d !== null && d > today) return { ok: false, status: 422, error: `${f} cannot be in the future; leave it out until it has happened.` };
    dates[f] = d;
  }
  const ordered = [["po_date", "dispatch_date"], ["po_date", "on_site_date"], ["dispatch_date", "on_site_date"],
    ["on_site_date", "install_complete_date"], ["on_site_date", "energised_date"], ["install_complete_date", "energised_date"]] as const;
  for (const [a, b] of ordered) {
    if (dates[a] && dates[b] && dates[a]! > dates[b]!) {
      return { ok: false, status: 422, error: `${a} cannot be after ${b}.` };
    }
  }

  let actual_cost: number | null = null;
  let actual_cost_currency: string | null = null;
  let cost_scope: string | null = null;
  let cost_scope_note: string | null = null;
  if (input.actual_cost !== undefined && input.actual_cost !== null && input.actual_cost !== "") {
    if (typeof input.actual_cost !== "number" || !Number.isFinite(input.actual_cost) || input.actual_cost < 0) {
      return { ok: false, status: 422, error: "actual_cost must be a non-negative number." };
    }
    actual_cost = input.actual_cost;
    const cur = typeof input.actual_cost_currency === "string" ? input.actual_cost_currency.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(cur)) {
      return { ok: false, status: 422, error: "actual_cost_currency is required with an actual cost: a three-letter ISO currency code." };
    }
    actual_cost_currency = cur;
    if (typeof input.cost_scope !== "string" || !(COST_SCOPES as readonly string[]).includes(input.cost_scope)) {
      return { ok: false, status: 422, error: `cost_scope is required with an actual cost: ${COST_SCOPES.join(", ")}.` };
    }
    cost_scope = input.cost_scope;
    cost_scope_note = typeof input.cost_scope_note === "string" ? input.cost_scope_note.trim().slice(0, 500) || null : null;
    if (cost_scope === "differs" && !cost_scope_note) {
      return { ok: false, status: 422, error: "cost_scope_note is required when the actual cost covers a different scope than the quote." };
    }
  } else if (input.actual_cost_currency || input.cost_scope) {
    return { ok: false, status: 422, error: "A currency or cost scope was given without an actual cost." };
  }

  if (Object.values(dates).every((d) => d === null) && actual_cost === null) {
    return { ok: false, status: 422, error: "Give at least one delivery fact: a date or the actual cost." };
  }
  const evidence_id = typeof input.evidence_id === "string" ? input.evidence_id : "";
  if (!UUID.test(evidence_id)) {
    return { ok: false, status: 422, error: "evidence_id is required: attach the source artifact (PO, delivery note, handover record) to this project first." };
  }
  const method = typeof input.method === "string" ? input.method.trim() : "";
  if (!method || method.length > 500) {
    return { ok: false, status: 422, error: "method is required: how these facts were established (at most 500 characters)." };
  }
  const submitted_by = typeof input.submitted_by === "string" ? input.submitted_by.trim() : "";
  if (!submitted_by || submitted_by.length > 120) {
    return { ok: false, status: 422, error: "submitted_by is required: who is reporting this." };
  }
  const supersedes_id = input.supersedes_id == null || input.supersedes_id === "" ? null : input.supersedes_id;
  if (supersedes_id !== null && (typeof supersedes_id !== "string" || !UUID.test(supersedes_id))) {
    return { ok: false, status: 422, error: "supersedes_id must be the id of the record this one corrects." };
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) || null : null;

  const added = await rpc<ActualRow>("gf_submit_supplier_actual", {
    p: {
      project_id: project.id, package_id: pk.pkg.id, ...dates, actual_cost, actual_cost_currency, cost_scope,
      cost_scope_note, evidence_id, method, submitted_by, supersedes_id, note,
    },
    p_event: ev("supplier_actual_submitted", submitted_by, {}),
  });
  if (!added.ok || !added.data) {
    if (added.ok === false && added.code === "23505") {
      return { ok: false, status: 409, error: supersedes_id
        ? "That record has already been corrected."
        : "Delivery facts are already recorded for this package; submit a correction that supersedes the earlier record." };
    }
    if (added.ok === false && added.code === "23514") {
      return { ok: false, status: 409, error: "The record was refused: no supplier is selected, or the facts are inconsistent." };
    }
    if (added.ok === false && added.code === "23503") {
      return { ok: false, status: 403, error: "That evidence or record does not belong to this package and project." };
    }
    return { ok: false, status: 502, error: "The delivery record could not be saved. Nothing was recorded." };
  }
  return { ok: true, actual: added.data };
}

/** A human decision on one record. Called only from an admin-authenticated route. */
export async function reviewSupplierActual(input: {
  actual_id: unknown;
  decision: unknown;
  verified_fields: unknown;
  reviewer: unknown;
  reason: unknown;
}): Promise<Result<{ review: ActualReviewRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const id = typeof input.actual_id === "string" ? input.actual_id : "";
  if (!UUID.test(id)) return { ok: false, status: 404, error: "Not found." };
  if (input.decision !== "verified" && input.decision !== "rejected") {
    return { ok: false, status: 422, error: "decision must be 'verified' or 'rejected'." };
  }
  const reviewer = typeof input.reviewer === "string" ? input.reviewer.trim() : "";
  if (!reviewer || reviewer.length > 120) return { ok: false, status: 422, error: "reviewer is required: the person taking this decision." };
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) || null : null;
  let fields: string[] = [];
  if (input.decision === "verified") {
    if (!Array.isArray(input.verified_fields) || input.verified_fields.length === 0 ||
        !input.verified_fields.every((f) => typeof f === "string" && (VERIFIABLE_FIELDS as readonly string[]).includes(f))) {
      return { ok: false, status: 422, error: `A verified record needs verified_fields: the facts you vouch for, from ${VERIFIABLE_FIELDS.join(", ")}.` };
    }
    fields = Array.from(new Set(input.verified_fields as string[]));
  } else {
    if (Array.isArray(input.verified_fields) && input.verified_fields.length > 0) {
      return { ok: false, status: 422, error: "A rejected record verifies nothing." };
    }
    if (!reason) return { ok: false, status: 422, error: "A rejection needs a reason." };
  }
  const done = await rpc<ActualReviewRow>("gf_review_supplier_actual", {
    p: { actual_id: id, decision: input.decision, verified_fields: fields, reviewer, reason },
    p_event: ev("supplier_actual_reviewed", reviewer, {}),
  });
  if (!done.ok || !done.data) {
    if (done.ok === false && done.code === "23503") return { ok: false, status: 404, error: "Not found." };
    if (done.ok === false && done.code === "23514") return { ok: false, status: 422, error: "You can only verify facts the record actually supplies." };
    if (done.ok === false && done.code === "23505") return { ok: false, status: 409, error: "This record has already been reviewed." };
    return { ok: false, status: 502, error: "The review could not be saved. Nothing was recorded." };
  }
  return { ok: true, review: done.data };
}

/** The derived quoted-vs-actual rows (a read-only database view), keyed by record id. */
export async function realityFor(projectId: string): Promise<Result<{ byActual: Map<string, RealityRow> }>> {
  const r = await rest<RealityRow[]>("GET", `supplier_reality?project_id=eq.${encodeURIComponent(projectId)}&select=*`);
  if (!r.ok) return { ok: false, status: 502, error: "The supplier record could not be read." };
  return { ok: true, byActual: new Map((r.data ?? []).map((x) => [x.actual_id, x])) };
}

/** Every record with its review, newest first — for the admin queue. */
export async function supplierActualQueue(
  state: "pending" | "all"
): Promise<Result<{ items: { actual: ActualRow; review: ActualReviewRow | null; reality: RealityRow | null }[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const [a, r, v] = await Promise.all([
    rest<ActualRow[]>("GET", "supplier_actuals?select=*&order=submitted_at.desc"),
    rest<ActualReviewRow[]>("GET", "supplier_actual_reviews?select=*"),
    rest<RealityRow[]>("GET", "supplier_reality?select=*"),
  ]);
  if (!a.ok || !r.ok || !v.ok) return { ok: false, status: 502, error: "The supplier-record queue could not be read." };
  const rv = new Map((r.data ?? []).map((x) => [x.actual_id, x]));
  const re = new Map((v.data ?? []).map((x) => [x.actual_id, x]));
  const items = (a.data ?? []).map((actual) => ({ actual, review: rv.get(actual.id) ?? null, reality: re.get(actual.id) ?? null }));
  return { ok: true, items: state === "pending" ? items.filter((i) => !i.review) : items };
}
