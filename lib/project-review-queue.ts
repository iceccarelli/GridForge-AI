// Server-only. What the administrator's review screen is given: the observations and delivery records still awaiting a human
// decision, each beside the evidence file it cites.
//
// A WHITELIST, not a pass-through. The stored rows carry values that are bearer credentials or private references:
// `case_token` and `prediction_ref` (which embeds it) open a BTM case; the project's own token opens the project; a file's
// `storage_ref` is a private object path. None is selected, copied or rendered. The reviewer sees the facts they are asked to
// vouch for, who submitted them, and the evidence file's name, type, size and SHA-256 (enough to find and check the file).

import { rest } from "@/lib/pgrest";
import { observationQueue, type ObservationRow } from "@/lib/project-observations";
import { supplierActualQueue, VERIFIABLE_FIELDS, type ActualRow } from "@/lib/supplier-reality";

export interface EvidenceRef {
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  review_status: "unverified" | "verified" | "rejected";
  source_category: string;
}

export interface ProjectRef {
  name: string;
  site: string | null;
  company: string | null;
}

export interface ObservationItem {
  kind: "observation";
  id: string;
  project: ProjectRef | null;
  metric: string;
  architecture: string;
  unit: string;
  predicted_value: number;
  observed_value: number;
  delta_pct: number;
  observed_on: string;
  method: string;
  measurement_kind: string | null;
  installed_basis: string;
  note: string | null;
  submitted_by: string;
  submitted_at: string;
  evidence: EvidenceRef | null;
}

export interface ActualItem {
  kind: "actual";
  id: string;
  project: ProjectRef | null;
  supplier: string;
  architecture: string;
  /** The facts this record actually supplies: the only ones a reviewer can vouch for. */
  facts: { field: string; value: string }[];
  actual_cost_currency: string | null;
  cost_scope: string | null;
  cost_scope_note: string | null;
  quoted_capex_eur: number | null;
  method: string;
  note: string | null;
  corrects_earlier_record: boolean;
  submitted_by: string;
  submitted_at: string;
  evidence: EvidenceRef | null;
}

export type ReviewQueue =
  | { ok: true; observations: ObservationItem[]; actuals: ActualItem[] }
  | { ok: false; status: number; error: string };

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs));

export function observationItem(o: ObservationRow, project: ProjectRef | null, evidence: EvidenceRef | null): ObservationItem {
  return {
    kind: "observation",
    id: o.id,
    project,
    metric: o.calibration_key,
    architecture: o.architecture,
    unit: o.unit,
    predicted_value: o.predicted_value,
    observed_value: o.observed_value,
    delta_pct: o.delta_pct,
    observed_on: o.observed_on,
    method: o.method,
    measurement_kind: o.measurement_kind,
    installed_basis: o.installed_basis,
    note: o.note,
    submitted_by: o.submitted_by,
    submitted_at: o.submitted_at,
    evidence,
  };
}

export function actualItem(a: ActualRow, project: ProjectRef | null, evidence: EvidenceRef | null): ActualItem {
  return {
    kind: "actual",
    id: a.id,
    project,
    supplier: a.supplier,
    architecture: a.architecture,
    facts: VERIFIABLE_FIELDS.filter((f) => a[f] !== null && a[f] !== undefined).map((f) => ({ field: f, value: String(a[f]) })),
    actual_cost_currency: a.actual_cost_currency,
    cost_scope: a.cost_scope,
    cost_scope_note: a.cost_scope_note,
    quoted_capex_eur: a.quoted_capex_eur,
    method: a.method,
    note: a.note,
    corrects_earlier_record: Boolean(a.supersedes_id),
    submitted_by: a.submitted_by,
    submitted_at: a.submitted_at,
    evidence,
  };
}

/** The pending observations and delivery records, joined to their evidence files and project names. */
export async function reviewQueue(): Promise<ReviewQueue> {
  const [o, a] = await Promise.all([observationQueue("pending"), supplierActualQueue("pending")]);
  if (!o.ok) return { ok: false, status: o.status, error: o.error };
  if (!a.ok) return { ok: false, status: a.status, error: a.error };
  const obs = o.items.map((i) => i.observation);
  const act = a.items.map((i) => i.actual);

  const evidenceIds = uniq([...obs.map((x) => x.evidence_id), ...act.map((x) => x.evidence_id)].filter(Boolean));
  const projectIds = uniq([...obs.map((x) => x.project_id), ...act.map((x) => x.project_id)].filter(Boolean));
  const list = (ids: string[]) => ids.map((i) => encodeURIComponent(i)).join(",");
  const [ev, pr] = await Promise.all([
    evidenceIds.length
      ? rest<(EvidenceRef & { id: string })[]>(
          "GET",
          `project_evidence?id=in.(${list(evidenceIds)})&select=id,filename,media_type,byte_size,sha256,review_status,source_category`
        )
      : Promise.resolve({ ok: true as const, status: 200, data: [] as (EvidenceRef & { id: string })[] }),
    projectIds.length
      ? rest<{ id: string; project_name: string; site_label: string | null; company: string | null }[]>(
          "GET",
          // Never `*`: the row holds the project's bearer token.
          `projects?id=in.(${list(projectIds)})&select=id,project_name,site_label,company`
        )
      : Promise.resolve({ ok: true as const, status: 200, data: [] as { id: string; project_name: string; site_label: string | null; company: string | null }[] }),
  ]);
  if (!ev.ok || !pr.ok) return { ok: false, status: 502, error: "The evidence files for the review queue could not be read. Nothing is shown rather than something incomplete." };

  const evById = new Map((ev.data ?? []).map((e) => [e.id, { filename: e.filename, media_type: e.media_type, byte_size: Number(e.byte_size), sha256: e.sha256, review_status: e.review_status, source_category: e.source_category } as EvidenceRef]));
  const prById = new Map((pr.data ?? []).map((p) => [p.id, { name: p.project_name, site: p.site_label, company: p.company } as ProjectRef]));
  return {
    ok: true,
    observations: obs.map((x) => observationItem(x, prById.get(x.project_id) ?? null, evById.get(x.evidence_id) ?? null)),
    actuals: act.map((x) => actualItem(x, prById.get(x.project_id) ?? null, evById.get(x.evidence_id) ?? null)),
  };
}
