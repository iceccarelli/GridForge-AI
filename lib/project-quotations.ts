// Server-only: which accepted supplier quotations a project may price a Time-to-Power comparison on.
//
// The authority is the quotation lifecycle that already exists (supabase/migrations/0022_cost_evidence.sql): a line is
// usable only after a named person ACCEPTED it, and only until it is superseded, withdrawn or expired. Nothing here
// decides that; this file only refuses to let anything else through. A caller never names a line, a project, a supplier
// or an amount: the server reads them, and a line is eligible for a project only when
//   * it is currently 'accepted' (not received, rejected, superseded or withdrawn),
//   * it was recorded for an engagement that is linked to THIS project (project_links) and is stamped with this project,
//   * it is a real quotation (not a synthetic fixture), in EUR, with a positive price.
// Anything else is returned in `excluded` with the reason, never silently dropped and never offered to the engine.

import { COLUMNS, toEngineEntry, type EvidenceRow } from "@/lib/cost-evidence";
import { rest, STORE_UNCONFIGURED, creds, type ProjectRow, type Result } from "@/lib/projects";

const q = encodeURIComponent;

export interface QuotationSet {
  /** The engine's CostEntry for each eligible line, ordered by evidence id so the same lines are always the same request. */
  entries: Record<string, unknown>[];
  ids: string[];
  /** Accepted lines that were NOT offered to the engine, and why. */
  excluded: { id: string; reason: string }[];
}

/** Pure: the eligibility rules, applied to accepted rows already read for one project. */
export function eligibleQuotations(rows: EvidenceRow[]): QuotationSet {
  const seen = new Set<string>();
  const excluded: QuotationSet["excluded"] = [];
  const kept: EvidenceRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue; // the same line twice is one line
    seen.add(r.id);
    if (r.state !== "accepted") excluded.push({ id: r.id, reason: `its state is ${r.state}, not accepted` });
    else if (r.synthetic) excluded.push({ id: r.id, reason: "it is a synthetic test fixture, not a real quotation" });
    else if (r.currency !== "EUR") excluded.push({ id: r.id, reason: `it is quoted in ${r.currency || "no stated currency"}; the comparison prices in EUR and converts nothing` });
    else if (!(Number(r.value) > 0)) excluded.push({ id: r.id, reason: "it carries no usable price" });
    else kept.push(r);
  }
  kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries: kept.map(toEngineEntry), ids: kept.map((r) => r.id), excluded };
}

/**
 * The project's eligible accepted quotations, as they stand now. A failed read is a failed read: it is never reported
 * as "no quotations", because that would let a comparison be saved as library-priced when it was asked to be priced
 * on evidence.
 */
export async function acceptedQuotations(project: ProjectRow): Promise<Result<{ set: QuotationSet }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const links = await rest<{ object_id: string }[]>(
    "GET",
    `project_links?project_id=eq.${q(project.id)}&object_type=eq.deliverable&select=object_id`
  );
  if (!links.ok) return { ok: false, status: 502, error: "The project's quotations could not be read. Nothing was saved." };
  const engagements = [...new Set((links.data ?? []).map((l) => l.object_id).filter(Boolean))];
  if (engagements.length === 0) return { ok: true, set: { entries: [], ids: [], excluded: [] } };
  const rows = await rest<EvidenceRow[]>(
    "GET",
    `cost_evidence_state?project_id=eq.${q(project.id)}&deliverable_id=in.(${engagements.map(q).join(",")})` +
      `&state=eq.accepted&select=${COLUMNS}&order=id.asc`
  );
  if (!rows.ok) return { ok: false, status: 502, error: "The project's quotations could not be read. Nothing was saved." };
  return { ok: true, set: eligibleQuotations(rows.data ?? []) };
}

/** Where each of these lines stands now. Used to say whether a saved comparison still rests on current evidence. */
export async function quotationStates(ids: string[]): Promise<Result<{ rows: Pick<EvidenceRow, "id" | "state" | "valid_until" | "retired_kind">[] }>> {
  if (ids.length === 0) return { ok: true, rows: [] };
  const r = await rest<Pick<EvidenceRow, "id" | "state" | "valid_until" | "retired_kind">[]>(
    "GET",
    `cost_evidence_state?id=in.(${ids.map(q).join(",")})&select=id,state,valid_until,retired_kind`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The project record could not be read." };
  return { ok: true, rows: r.data ?? [] };
}

/**
 * Whether the store can record which quotations a comparison rests on (migration 0026). Without it the save function
 * would accept the request and silently drop the evidence list, so a quotation-backed request is refused up front, before
 * the engine is called, rather than stored as something it is not.
 */
export async function quotationEvidenceReady(): Promise<Result<{ ready: true }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rest<unknown[]>("GET", "project_comparisons?select=evidence_ids&limit=1");
  if (!r.ok) {
    return {
      ok: false,
      status: 503,
      error: "Quotation-backed comparisons are not available on this deployment yet. Nothing was saved.",
    };
  }
  return { ok: true, ready: true };
}
