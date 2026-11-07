// Server-only. What the administrator's review screen is given: the observations and delivery records still awaiting a human
// decision, each beside the evidence file it cites.
//
// A WHITELIST, not a pass-through. The stored rows carry values that are bearer credentials or private references:
// `case_token` and `prediction_ref` (which embeds it) open a BTM case; the project's own token opens the project; a file's
// `storage_ref` is a private object path. None is selected, copied or rendered. The reviewer sees the facts they are asked to
// vouch for, who submitted them, and the evidence file's name, type, size and SHA-256 (enough to find and check the file).

import { rest } from "@/lib/pgrest";
import type { ObservationRow } from "@/lib/project-observations";
import { VERIFIABLE_FIELDS, type ActualRow } from "@/lib/supplier-reality";

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

/** How many of each kind the screen shows at once, how many rows one read fetches, and the most rows one load will scan. */
export const REVIEW_SHOW_MAX = 50;
export const REVIEW_PAGE = 100;
export const REVIEW_SCAN_MAX = 5000;

export interface QueueCount {
  /** Items on screen. */
  shown: number;
  /** Items awaiting a decision among the rows scanned. */
  pending: number;
  /** True when the scan stopped at REVIEW_SCAN_MAX: older records were not examined, so `pending` is a floor. */
  truncated: boolean;
}

export type ReviewQueue =
  | { ok: true; observations: ObservationItem[]; actuals: ActualItem[]; counts: { observations: QueueCount; actuals: QueueCount } }
  | { ok: false; status: number; error: string };

/**
 * The records of one kind that have no decision yet, newest first, with a STABLE order (saved time, then id) and an explicit
 * page size. Whether a record is decided is asked of the review table for exactly the ids in hand, never inferred from a
 * capped list of reviews: a row cap on either table (PostgREST's own default is 1000) therefore cannot make a decided record
 * look pending. The scan is bounded (REVIEW_SCAN_MAX) and says so when it stops early.
 */
export async function pendingOf<T extends { id: string }>(
  table: string,
  reviewTable: string,
  foreignKey: string
): Promise<{ ok: true; pending: T[]; truncated: boolean } | { ok: false; status: number; error: string }> {
  const pending: T[] = [];
  let scanned = 0;
  for (let offset = 0; offset < REVIEW_SCAN_MAX; offset += REVIEW_PAGE) {
    const page = await rest<T[]>("GET", `${table}?select=*&order=submitted_at.desc,id.desc&limit=${REVIEW_PAGE}&offset=${offset}`);
    if (!page.ok) return { ok: false, status: 502, error: "The review queue could not be read." };
    const rows = page.data ?? [];
    if (rows.length) {
      const decided = await rest<Record<string, string>[]>(
        "GET",
        `${reviewTable}?${foreignKey}=in.(${rows.map((r) => encodeURIComponent(r.id)).join(",")})&select=${foreignKey}`
      );
      if (!decided.ok) return { ok: false, status: 502, error: "The review queue could not be read." };
      const done = new Set((decided.data ?? []).map((d) => d[foreignKey]));
      for (const r of rows) if (!done.has(r.id)) pending.push(r);
    }
    scanned += rows.length;
    if (rows.length < REVIEW_PAGE) return { ok: true, pending, truncated: false };
  }
  return { ok: true, pending, truncated: scanned >= REVIEW_SCAN_MAX };
}

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

/** The newest pending observations and delivery records (REVIEW_SHOW_MAX of each), joined to their evidence files and project names. */
export async function reviewQueue(): Promise<ReviewQueue> {
  const [o, a] = await Promise.all([
    pendingOf<ObservationRow>("project_observations", "project_observation_reviews", "observation_id"),
    pendingOf<ActualRow>("supplier_actuals", "supplier_actual_reviews", "actual_id"),
  ]);
  if (!o.ok) return { ok: false, status: o.status, error: o.error };
  if (!a.ok) return { ok: false, status: a.status, error: a.error };
  const obs = o.pending.slice(0, REVIEW_SHOW_MAX);
  const act = a.pending.slice(0, REVIEW_SHOW_MAX);

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
    counts: {
      observations: { shown: obs.length, pending: o.pending.length, truncated: o.truncated },
      actuals: { shown: act.length, pending: a.pending.length, truncated: a.truncated },
    },
  };
}
