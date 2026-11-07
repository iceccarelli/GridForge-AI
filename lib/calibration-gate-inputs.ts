// Server-only: reads, with the service role, the records the export checklist needs beyond what an observation row carries, and runs the
// SAME function the project panel's blockers come from (lib/project-observations.ts) over them.
//
// What is read, per screenful of observations (at most REVIEW_SHOW_MAX of them) and never `*`:
//   calibration_permissions       scope_id, kind, seq            -> the project's standing permission (newest row)
//   project_evidence_reviews      evidence_id, decision, sha256_confirmed
//   hall_project_attachments      project_id, site_id            -> then sites: id, data_origin
//   power_deployment_cases        case_token, revision, created_at, case_digest   (NOT the request or the result)
// A read that fails, or a table that is not there (HTTP 404 before its migration is applied), makes that gate "cannot be read": it is
// never reported as met. Nothing read here is returned except as a gate's status and a sentence.

import { rest } from "@/lib/pgrest";
import type { GateResult } from "@/lib/calibration-gates";
import {
  ledgerGateChecklist,
  type FileDecisionRead,
  type ForecastRead,
  type ObservationRow,
  type PermissionStanding,
  type ReviewRow,
  type SiteOriginRead,
} from "@/lib/project-observations";

/** Rows one batched read may return before the answer is treated as incomplete (and so unreadable) rather than trusted. */
const BATCH_MAX = 5000;

export interface ChecklistSubject {
  observation: ObservationRow;
  review: Pick<ReviewRow, "decision" | "evidence_class" | "reviewer" | "evidence_sha256"> | null;
  evidence: { review_status: string; sha256: string } | null;
}

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs));
const list = (ids: string[]) => ids.map((i) => encodeURIComponent(i)).join(",");

/** `in.(...)` filter; an empty list reads nothing and succeeds. */
async function readIn<T>(table: string, column: string, ids: string[], select: string, extra = ""): Promise<{ ok: true; rows: T[] } | { ok: false }> {
  if (!ids.length) return { ok: true, rows: [] };
  const r = await rest<T[]>("GET", `${table}?${column}=in.(${list(ids)})&select=${select}${extra}&limit=${BATCH_MAX}`);
  if (!r.ok) return { ok: false };
  const rows = r.data ?? [];
  // A full page may have been cut: what is missing from it cannot be called absent.
  return rows.length >= BATCH_MAX ? { ok: false } : { ok: true, rows };
}

/** One checklist per observation id. Never throws. */
export async function exportChecklists(subjects: ChecklistSubject[]): Promise<Map<string, GateResult[]>> {
  const projectIds = uniq(subjects.map((s) => s.observation.project_id).filter(Boolean));
  const evidenceIds = uniq(subjects.map((s) => s.observation.evidence_id).filter(Boolean));
  const caseTokens = uniq(subjects.map((s) => s.observation.case_token).filter(Boolean));

  const [perm, files, attach, cases] = await Promise.all([
    readIn<{ scope_id: string; kind: "granted" | "revoked"; seq: number }>("calibration_permissions", "scope_id", projectIds, "scope_id,kind,seq", "&scope_type=eq.project&order=seq.desc"),
    readIn<{ evidence_id: string; decision: "verified" | "rejected"; sha256_confirmed: string | null }>("project_evidence_reviews", "evidence_id", evidenceIds, "evidence_id,decision,sha256_confirmed"),
    readIn<{ project_id: string; site_id: string }>("hall_project_attachments", "project_id", projectIds, "project_id,site_id"),
    readIn<{ case_token: string; revision: number; created_at: string | null; case_digest: string | null }>("power_deployment_cases", "case_token", caseTokens, "case_token,revision,created_at,case_digest"),
  ]);

  // The standing permission is the NEWEST row (highest seq), as the view reads it; rows arrive newest first.
  const standingOf = new Map<string, PermissionStanding>();
  if (perm.ok) for (const p of perm.rows) if (!standingOf.has(p.scope_id)) standingOf.set(p.scope_id, p.kind);

  const decisionOf = new Map<string, FileDecisionRead>();
  if (files.ok) for (const f of files.rows) decisionOf.set(f.evidence_id, { decision: f.decision, sha256_confirmed: f.sha256_confirmed });

  // Site history: attachments first, then the origin of each site they name. Two reads, so a missing sites table is its own answer.
  const siteIds = attach.ok ? uniq(attach.rows.map((a) => a.site_id)) : [];
  const sites = attach.ok ? await readIn<{ id: string; data_origin: string }>("sites", "id", siteIds, "id,data_origin") : ({ ok: false } as const);
  const originOfSite = new Map<string, string>();
  if (sites.ok) for (const s of sites.rows) originOfSite.set(s.id, s.data_origin);
  const siteOriginOf = (projectId: string): SiteOriginRead => {
    if (!attach.ok) return "unreadable";
    const mine = attach.rows.filter((a) => a.project_id === projectId);
    if (mine.length === 0) return { attachments: 0, nonProduction: 0 };
    if (!sites.ok) return "unreadable";
    let nonProduction = 0;
    for (const a of mine) {
      const origin = originOfSite.get(a.site_id);
      // A site the join cannot find is not known to be production.
      if (origin === undefined) return "unreadable";
      if (origin !== "production") nonProduction += 1;
    }
    return { attachments: mine.length, nonProduction };
  };

  const out = new Map<string, GateResult[]>();
  for (const s of subjects) {
    const o = s.observation;
    const standing: PermissionStanding = !perm.ok ? "unknown" : (standingOf.get(o.project_id) ?? "none");
    const fileDecision: FileDecisionRead = !files.ok ? "unreadable" : (decisionOf.get(o.evidence_id) ?? "none");
    const forecast: ForecastRead = !cases.ok
      ? "unreadable"
      : (() => {
          const c = cases.rows.find((x) => x.case_token === o.case_token && x.revision === o.case_revision);
          return c ? { created_at: c.created_at ?? null, case_digest: c.case_digest ?? null } : "missing";
        })();
    out.set(o.id, ledgerGateChecklist(o, s.review, s.evidence, { standing, fileDecision, siteOrigin: siteOriginOf(o.project_id), forecast }));
  }
  return out;
}
