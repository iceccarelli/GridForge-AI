// Server-only: a supplier quotation a project holder attaches to an uploaded file (migration 0054).
//
//   upload the PDF (project evidence, unverified)  ->  record the claims about it (this file)  ->  a reviewer VERIFIES the file (0048)
//   and ACCEPTS the record (0022 + 0054)  ->  the accepted record is passed to the engine as cost_evidence for one request.
//
// What this file deliberately does not do:
//   * It decides nothing about trust. Storing a claim gives it no authority; the database refuses to accept it unless its file is verified.
//   * It never returns a storage path. A file is named by its id, its filename, its type, size and digest.
//   * It never reads another project's quotations: every read is scoped by the project the caller's token resolved to.
//   * It never prices, scales or converts a price. The engine does, from the accepted record.

import { digestOf } from "@/lib/run-identity";
import { missingFunction } from "@/lib/calibration-permissions";
import {
  FILE_STATUS_TEXT,
  NOT_COUNTED_REASON,
  SUGGESTED_BASIS,
  basisLabel,
  checkClaim,
  claimComparability,
  claimSchema,
  itemFor,
  type ClaimInput,
  type QuoteType,
} from "@/lib/cost-evidence-claims";
import { creds, ev, rest, rpc, STORE_UNCONFIGURED, type Fail, type ProjectRow, type Result } from "@/lib/projects";

const q = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_AVAILABLE: { ok: false; status: 503; error: string } = {
  ok: false,
  status: 503,
  error: "Supplier quotations are not available on this deployment yet: their database migration has not been applied. Nothing was recorded.",
};

/** A refusal that also says which fields were wrong (the routes pass `details` through to the caller). */
function refused(status: number, error: string, details: { field: string; problem: string }[]): Fail & { details: unknown } {
  return { ok: false, status, error, details };
}

/** The calendar day the server decides validity on, UTC. */
export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** The one line a claim is: the same claim twice has the same digest, so a retry creates nothing. */
export function claimDigest(projectId: string, c: ClaimInput): string {
  return digestOf({
    v: "gridforge/project-quotation-claim/1",
    project: projectId,
    file: c.file_id.toLowerCase(),
    key: c.cost_key,
    unit: c.unit,
    price: c.price_eur,
    quantity: c.quoted_quantity ?? null,
    type: c.quote_type,
    supplier: c.supplier,
    quoted_on: c.quoted_on,
    valid_until: c.valid_until,
    lead: c.lead_time_weeks ?? null,
    scope: c.scope,
  });
}

// ---------------------------------------------------------------------------------------------------------------- submit

export async function submitClaim(project: ProjectRow, raw: unknown, now: Date = new Date()): Promise<Result<{ id: string; created: boolean }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success) {
    return refused(422, parsed.error.issues[0]?.message ?? "The quotation was refused.", parsed.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })));
  }
  const c = parsed.data;
  const problems = checkClaim(c, todayUtc(now));
  if (problems.length) return refused(422, problems[0].message, problems.map((p) => ({ field: p.path, problem: p.message })));

  // The file must be this project's own, and not already refused. The database checks both again inside the write.
  const file = await rest<{ id: string; review_status: string }[]>(
    "GET",
    `project_evidence?id=eq.${q(c.file_id)}&project_id=eq.${q(project.id)}&select=id,review_status&limit=1`
  );
  if (!file.ok) return { ok: false, status: 502, error: "The file could not be looked up. Nothing was recorded." };
  const f = file.data?.[0];
  if (!f) return { ok: false, status: 404, error: "That file is not part of this project. Upload the quotation to this project first." };
  if (f.review_status === "rejected") return { ok: false, status: 409, error: "That file was reviewed and rejected, so a quotation cannot rest on it." };

  const item = itemFor(c.cost_key)!;
  const { comparability, limitations } = claimComparability(c);
  const done = await rpc<{ id: string; created: boolean }>("gf_submit_project_quotation", {
    p: {
      project_id: project.id,
      source_file_id: c.file_id,
      line_digest: claimDigest(project.id, c),
      cost_key: c.cost_key,
      unit: c.unit,
      value: c.price_eur,
      supplier: c.supplier,
      received_on: c.quoted_on,
      valid_until: c.valid_until,
      reference: c.reference ?? null,
      scope: c.scope,
      quoted_quantity: c.quoted_quantity ?? null,
      quoted_quantity_unit: c.quoted_quantity !== undefined ? item.quantityUnit : null,
      comparability,
      limitations,
      claimed_quote_type: c.quote_type,
      lead_time_weeks: c.lead_time_weeks ?? null,
      notes: c.notes ?? null,
      submitted_by: c.submitted_by,
    },
    p_event: ev("cost_evidence_received", c.submitted_by, {}),
  });
  if (!done.ok || !done.data) {
    if (done.ok === false) {
      if (missingFunction(done.code) || done.code === "42703") return NOT_AVAILABLE;
      if (done.code === "GF010") return { ok: false, status: 404, error: "That file is not part of this project." };
      if (done.code === "GF011") return { ok: false, status: 409, error: "That file was reviewed and rejected, so a quotation cannot rest on it." };
      if (done.code === "GF012") return { ok: false, status: 422, error: "The validity date must be in the future and not earlier than the quotation date." };
      if (done.code === "GF013") return { ok: false, status: 409, error: "This project already holds the most quotation claims it can." };
      if (done.code === "23514" || done.code === "22P02" || done.code === "22003") return { ok: false, status: 422, error: "The quotation was refused: a value is outside what is accepted." };
    }
    return { ok: false, status: 502, error: "The quotation could not be saved. Nothing was recorded." };
  }
  return { ok: true, id: done.data.id, created: done.data.created === true };
}

// ---------------------------------------------------------------------------------------------------------------- read

interface ClaimRow {
  id: string;
  project_id: string;
  cost_key: string;
  unit: string;
  value: number;
  quoted_quantity: number | null;
  quoted_quantity_unit: string | null;
  supplier: string;
  received_on: string | null;
  valid_until: string | null;
  reference: string | null;
  scope: string;
  comparability: "exact" | "limited";
  limitations: string[];
  submitted_at: string;
  state: string;
  reviewed_basis: string | null;
  reviewed_comparability: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  superseded_by: string | null;
  retired_kind: string | null;
  retirement_reason: string | null;
  retired_by: string | null;
  source_file_id: string;
  claimed_quote_type: QuoteType;
  lead_time_weeks: number | null;
  notes: string | null;
  submitted_by: string;
}

const CLAIM_COLUMNS =
  "id,project_id,cost_key,unit,value,quoted_quantity,quoted_quantity_unit,supplier,received_on,valid_until,reference,scope,comparability," +
  "limitations,submitted_at,state,reviewed_basis,reviewed_comparability,reviewer,reviewed_at,review_reason,superseded_by,retired_kind," +
  "retirement_reason,retired_by,source_file_id,claimed_quote_type,lead_time_weeks,notes,submitted_by";

interface FileFacts {
  id: string;
  project_id: string;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  review_status: "unverified" | "verified" | "rejected";
}
interface FileDecision {
  evidence_id: string;
  decision: "verified" | "rejected";
  reviewer: string;
  sha256_confirmed: string | null;
  reviewed_at: string;
}

export interface FileView {
  id: string;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  review_status: FileFacts["review_status"];
  status_text: string;
  /** A verifying decision exists AND its confirmed digest equals the digest recorded at upload. Both, or false. */
  hash_confirmed: boolean;
  decided_by: string | null;
}

export interface ClaimView {
  id: string;
  cost_key: string;
  item: string;
  unit: string;
  price_eur: number;
  quoted_quantity: number | null;
  quoted_quantity_unit: string | null;
  quote_type: QuoteType;
  supplier: string;
  quoted_on: string | null;
  valid_until: string | null;
  reference: string | null;
  scope: string;
  lead_time_weeks: number | null;
  notes: string | null;
  submitted_by: string;
  submitted_at: string;
  comparability: "exact" | "limited";
  limitations: string[];
  state: string;
  /** Whether the engine is offered this record (accepted and not past its validity date today). */
  counted: boolean;
  /** The words for why not, when it is not counted. */
  reason: string | null;
  suggested_basis: string;
  review: null | {
    reviewer: string | null;
    reviewed_at: string | null;
    basis: string | null;
    basis_label: string | null;
    comparability: string | null;
    reason: string | null;
  };
  retired: null | { kind: string; by: string | null; reason: string | null };
  file: FileView;
}

async function filesFor(ids: string[], projectId?: string): Promise<Result<{ files: Map<string, FileView> }>> {
  const files = new Map<string, FileView>();
  if (ids.length === 0) return { ok: true, files };
  const list = ids.map(q).join(",");
  // Never `*`: the row holds the private storage path.
  const rows = await rest<FileFacts[]>(
    "GET",
    `project_evidence?id=in.(${list})${projectId ? `&project_id=eq.${q(projectId)}` : ""}&select=id,project_id,filename,media_type,byte_size,sha256,review_status`
  );
  if (!rows.ok) return { ok: false, status: 502, error: "The quotation files could not be read." };
  // The decision rows exist from 0048. Without them a file simply has no confirmed hash, which is the safe reading.
  const dec = await rest<FileDecision[]>("GET", `project_evidence_reviews?evidence_id=in.(${list})&select=evidence_id,decision,reviewer,sha256_confirmed,reviewed_at`);
  const decisions = new Map((dec.ok ? dec.data ?? [] : []).map((d) => [d.evidence_id, d]));
  for (const f of rows.data ?? []) {
    const d = decisions.get(f.id);
    files.set(f.id, {
      id: f.id,
      filename: f.filename,
      media_type: f.media_type,
      byte_size: Number(f.byte_size),
      sha256: f.sha256,
      review_status: f.review_status,
      status_text: FILE_STATUS_TEXT[f.review_status] ?? f.review_status,
      hash_confirmed: f.review_status === "verified" && d?.decision === "verified" && d.sha256_confirmed === f.sha256,
      decided_by: d?.reviewer ?? null,
    });
  }
  return { ok: true, files };
}

const MISSING_FILE: FileView = {
  id: "",
  filename: "(file not found)",
  media_type: "",
  byte_size: 0,
  sha256: "",
  review_status: "unverified",
  status_text: "file could not be read",
  hash_confirmed: false,
  decided_by: null,
};

export function claimView(r: ClaimRow, file: FileView | undefined, today: string): ClaimView {
  const item = itemFor(r.cost_key);
  const expired = !!r.valid_until && r.valid_until < today;
  const counted = r.state === "accepted" && !expired;
  return {
    id: r.id,
    cost_key: r.cost_key,
    item: item?.label ?? r.cost_key,
    unit: r.unit,
    price_eur: Number(r.value),
    quoted_quantity: r.quoted_quantity === null ? null : Number(r.quoted_quantity),
    quoted_quantity_unit: r.quoted_quantity_unit,
    quote_type: r.claimed_quote_type,
    supplier: r.supplier,
    quoted_on: r.received_on,
    valid_until: r.valid_until,
    reference: r.reference,
    scope: r.scope,
    lead_time_weeks: r.lead_time_weeks === null ? null : Number(r.lead_time_weeks),
    notes: r.notes,
    submitted_by: r.submitted_by,
    submitted_at: r.submitted_at,
    comparability: r.comparability,
    limitations: Array.isArray(r.limitations) ? r.limitations : [],
    state: r.state,
    counted,
    reason: counted ? null : r.state === "accepted" && expired ? `Not counted: the validity date ${r.valid_until} has passed.` : NOT_COUNTED_REASON[r.state] ?? null,
    suggested_basis: SUGGESTED_BASIS[r.claimed_quote_type] ?? "budgetary_quote",
    review: r.reviewed_at
      ? {
          reviewer: r.reviewer,
          reviewed_at: r.reviewed_at,
          basis: r.reviewed_basis,
          basis_label: r.reviewed_basis ? basisLabel(r.reviewed_basis) : null,
          comparability: r.reviewed_comparability,
          reason: r.review_reason,
        }
      : null,
    retired: r.retired_kind ? { kind: r.retired_kind, by: r.retired_by, reason: r.retirement_reason } : null,
    file: file ?? MISSING_FILE,
  };
}

/** Every quotation claim of THIS project, newest first, each beside the standing of its file. Another project's rows are never selected. */
export async function claimsFor(project: ProjectRow, now: Date = new Date()): Promise<Result<{ claims: ClaimView[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const rows = await rest<ClaimRow[]>(
    "GET",
    `cost_evidence_state?project_id=eq.${q(project.id)}&source_file_id=not.is.null&select=${CLAIM_COLUMNS}&order=submitted_at.desc,id.asc&limit=100`
  );
  if (!rows.ok) {
    if (rows.code === "42703" || rows.code === "PGRST204") return NOT_AVAILABLE;
    return { ok: false, status: 502, error: "The project's quotations could not be read." };
  }
  const data = rows.data ?? [];
  const f = await filesFor([...new Set(data.map((r) => r.source_file_id))], project.id);
  if (!f.ok) return f;
  return { ok: true, claims: data.map((r) => claimView(r, f.files.get(r.source_file_id), todayUtc(now))) };
}

/** The administrator's queue: every project quotation claim, with its file, newest first. Admin routes only: this crosses projects. */
export async function claimQueue(state: "pending" | "all", now: Date = new Date()): Promise<Result<{ claims: (ClaimView & { project_id: string })[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const filter = state === "pending" ? "&state=eq.validated" : "";
  const rows = await rest<ClaimRow[]>(
    "GET",
    `cost_evidence_state?source_file_id=not.is.null${filter}&select=${CLAIM_COLUMNS}&order=submitted_at.desc,id.asc&limit=200`
  );
  if (!rows.ok) {
    if (rows.code === "42703" || rows.code === "PGRST204") return NOT_AVAILABLE;
    return { ok: false, status: 502, error: "The quotation queue could not be read." };
  }
  const data = rows.data ?? [];
  const f = await filesFor([...new Set(data.map((r) => r.source_file_id))]);
  if (!f.ok) return f;
  const today = todayUtc(now);
  return { ok: true, claims: data.map((r) => ({ ...claimView(r, f.files.get(r.source_file_id), today), project_id: r.project_id })) };
}

/** The files of this project that carry a quotation claim, for a screen that lets a person cite the same file elsewhere (the hall registry). */
export async function quotationFiles(project: ProjectRow): Promise<Result<{ files: { id: string; filename: string; review_status: string }[] }>> {
  const c = await claimsFor(project);
  if (!c.ok) return c;
  const seen = new Map<string, { id: string; filename: string; review_status: string }>();
  for (const x of c.claims) if (x.file.id && !seen.has(x.file.id)) seen.set(x.file.id, { id: x.file.id, filename: x.file.filename, review_status: x.file.review_status });
  return { ok: true, files: [...seen.values()] };
}

export const isUuid = (s: string): boolean => UUID.test(s);
