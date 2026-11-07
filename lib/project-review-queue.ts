// Server-only. What the administrator's review screen is given: the observations and delivery records still awaiting a human
// decision, each beside the evidence file it cites.
//
// A WHITELIST, not a pass-through. The stored rows carry values that are bearer credentials or private references:
// `case_token` and `prediction_ref` (which embeds it) open a BTM case; the project's own token opens the project; a file's
// `storage_ref` is a private object path. None is selected, copied or rendered. The reviewer sees the facts they are asked to
// vouch for, who submitted them, and the evidence file's name, type, size and SHA-256 (enough to find and check the file).

import { rest } from "@/lib/pgrest";
import { exportChecklists } from "@/lib/calibration-gate-inputs";
import type { GateResult } from "@/lib/calibration-gates";
import type { ObservationRow, ReviewRow } from "@/lib/project-observations";
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
  /** Every gate the calibration export view enforces, read for this observation (lib/project-observations.ts ledgerGateChecklist). Absent when it was not computed. */
  gates?: GateResult[];
}

/** An observation a reviewer has already verified, shown read-only with what still stands between it and the export. */
export interface VerifiedItem extends ObservationItem {
  review: { reviewer: string; reviewed_at: string; evidence_class: string | null };
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

/** An uploaded file nobody has decided on yet. Never carries its storage path: the reviewer sees the digest, the server re-reads the bytes. */
export interface FileItem {
  kind: "file";
  id: string;
  project: ProjectRef | null;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  source_category: string;
  note: string | null;
  uploaded_at: string;
}

/** How many of each kind the screen shows at once, how many rows one read fetches, and the most rows one load will scan. */
export const REVIEW_SHOW_MAX = 50;
export const REVIEW_PAGE = 100;
export const REVIEW_SCAN_MAX = 5000;
/** How many already-verified observations the checklist section lists (newest review first). */
export const VERIFIED_SHOW_MAX = 50;
/** How many of the most recently submitted observations are searched for verified ones. */
export const VERIFIED_SCAN = 100;

export interface QueueCount {
  /** Items on screen. */
  shown: number;
  /** Items awaiting a decision among the rows scanned. */
  pending: number;
  /** True when the scan stopped at REVIEW_SCAN_MAX: older records were not examined, so `pending` is a floor. */
  truncated: boolean;
}

export type ReviewQueue =
  | {
      ok: true;
      observations: ObservationItem[];
      actuals: ActualItem[];
      files: FileItem[];
      counts: { observations: QueueCount; actuals: QueueCount; files: QueueCount };
      /** Verified observations with their export checklist; null when they could not be read (never an empty list standing in for that). */
      verified: VerifiedItem[] | null;
    }
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

/** The columns a file row is read with. Never `*` and never `storage_ref`: that is a private object path. */
const FILE_COLUMNS = "id,project_id,filename,media_type,byte_size,sha256,source_category,note,uploaded_at";
type FileRow = Omit<FileItem, "kind" | "project"> & { project_id: string };

/**
 * Files still `unverified`, newest upload first with a stable order (upload time, then id), read in explicit pages and scanned up to
 * REVIEW_SCAN_MAX rows, saying so when the scan stops early. The status is filtered by the store, so a file decided elsewhere never
 * appears and a row cap cannot make a decided file look pending.
 */
export async function pendingFiles(): Promise<{ ok: true; pending: FileRow[]; truncated: boolean } | { ok: false; status: number; error: string }> {
  const pending: FileRow[] = [];
  for (let offset = 0; offset < REVIEW_SCAN_MAX; offset += REVIEW_PAGE) {
    const page = await rest<FileRow[]>(
      "GET",
      `project_evidence?review_status=eq.unverified&select=${FILE_COLUMNS}&order=uploaded_at.desc,id.desc&limit=${REVIEW_PAGE}&offset=${offset}`
    );
    if (!page.ok) return { ok: false, status: 502, error: "The review queue could not be read." };
    const rows = page.data ?? [];
    pending.push(...rows);
    if (rows.length < REVIEW_PAGE) return { ok: true, pending, truncated: false };
  }
  return { ok: true, pending, truncated: pending.length >= REVIEW_SCAN_MAX };
}

export function fileItem(f: FileRow, project: ProjectRef | null): FileItem {
  return {
    kind: "file", id: f.id, project, filename: f.filename, media_type: f.media_type, byte_size: Number(f.byte_size), sha256: f.sha256,
    source_category: f.source_category, note: f.note ?? null, uploaded_at: f.uploaded_at,
  };
}

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
  const [o, a, f] = await Promise.all([
    pendingOf<ObservationRow>("project_observations", "project_observation_reviews", "observation_id"),
    pendingOf<ActualRow>("supplier_actuals", "supplier_actual_reviews", "actual_id"),
    pendingFiles(),
  ]);
  if (!o.ok) return { ok: false, status: o.status, error: o.error };
  if (!a.ok) return { ok: false, status: a.status, error: a.error };
  if (!f.ok) return { ok: false, status: f.status, error: f.error };
  const obs = o.pending.slice(0, REVIEW_SHOW_MAX);
  const act = a.pending.slice(0, REVIEW_SHOW_MAX);
  const fil = f.pending.slice(0, REVIEW_SHOW_MAX);

  // Observations a reviewer has already verified, listed read-only with the export checklist: a verified observation is where a missing
  // permission or file decision actually blocks the export. They are looked for among the VERIFIED_SCAN newest SUBMITTED observations
  // (a review is asked for by the ids in hand, as for the pending queue, never as one capped list of reviews), and a failed read is
  // `null`, never an empty list standing in for it.
  const recent = await rest<ObservationRow[]>("GET", `project_observations?select=*&order=submitted_at.desc,id.desc&limit=${VERIFIED_SCAN}`);
  const recentReviews = recent.ok && (recent.data ?? []).length
    ? await rest<ReviewRow[]>("GET", `project_observation_reviews?observation_id=in.(${(recent.data ?? []).map((r) => encodeURIComponent(r.id)).join(",")})&select=*`)
    : null;
  const verifiedReviews: ReviewRow[] | null = !recent.ok ? null : (recent.data ?? []).length === 0 ? [] : recentReviews && recentReviews.ok
    ? (recentReviews.data ?? [])
        .filter((r) => r.decision === "verified")
        .sort((x, y) => (x.reviewed_at < y.reviewed_at ? 1 : x.reviewed_at > y.reviewed_at ? -1 : 0))
        .slice(0, VERIFIED_SHOW_MAX)
    : null;
  const verifiedIds = new Set((verifiedReviews ?? []).map((r) => r.observation_id));
  const recentRows: ObservationRow[] = recent.ok ? (recent.data ?? []) : [];
  const verifiedRows: ObservationRow[] | null = verifiedReviews === null ? null : recentRows.filter((o) => verifiedIds.has(o.id));

  const evidenceIds = uniq([...obs.map((x) => x.evidence_id), ...act.map((x) => x.evidence_id), ...(verifiedRows ?? []).map((x) => x.evidence_id)].filter(Boolean));
  const projectIds = uniq([...obs.map((x) => x.project_id), ...act.map((x) => x.project_id), ...fil.map((x) => x.project_id), ...(verifiedRows ?? []).map((x) => x.project_id)].filter(Boolean));
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

  // The export checklist for each pending and each verified observation: the same function the project panel's blockers come from,
  // fed the file decision, site history, permission and forecast read here. It never fails the queue; a gate it cannot read says so.
  const reviewByObs = new Map((verifiedReviews ?? []).map((r) => [r.observation_id, r]));
  const subjects = [
    ...obs.map((observation) => ({ observation, review: null, evidence: evById.get(observation.evidence_id) ?? null })),
    ...(verifiedRows ?? []).map((observation) => ({ observation, review: reviewByObs.get(observation.id) ?? null, evidence: evById.get(observation.evidence_id) ?? null })),
  ];
  const checklists = await exportChecklists(subjects);
  const withGates = (o: ObservationRow): ObservationItem => ({
    ...observationItem(o, prById.get(o.project_id) ?? null, evById.get(o.evidence_id) ?? null),
    gates: checklists.get(o.id),
  });

  const verified: VerifiedItem[] | null = verifiedRows === null
    ? null
    : verifiedRows
        .flatMap((o) => {
          const review = reviewByObs.get(o.id);
          return review ? [{ ...withGates(o), review: { reviewer: review.reviewer, reviewed_at: review.reviewed_at, evidence_class: review.evidence_class } }] : [];
        })
        .sort((x, y) => (x.review.reviewed_at < y.review.reviewed_at ? 1 : x.review.reviewed_at > y.review.reviewed_at ? -1 : 0));

  return {
    ok: true,
    observations: obs.map(withGates),
    actuals: act.map((x) => actualItem(x, prById.get(x.project_id) ?? null, evById.get(x.evidence_id) ?? null)),
    files: fil.map((x) => fileItem(x, prById.get(x.project_id) ?? null)),
    counts: {
      observations: { shown: obs.length, pending: o.pending.length, truncated: o.truncated },
      actuals: { shown: act.length, pending: a.pending.length, truncated: a.truncated },
      files: { shown: fil.length, pending: f.pending.length, truncated: f.truncated },
    },
    verified,
  };
}
