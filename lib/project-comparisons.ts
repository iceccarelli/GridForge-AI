// Server-only: a Time-to-Power comparison saved to a project.
//
// The engine owns every number. What is stored is the request the person made and the engine's answer to it, verbatim
// (project_comparisons is append-only). The server re-asks the engine on save rather than accepting a result from the
// browser, so a stored comparison is always something the engine said, never something a client typed.

import { newCaseToken } from "@/lib/power-deploy";
import { creds, ev, rest, rpc, STORE_UNCONFIGURED, type ProjectRow, type Result } from "@/lib/projects";
import type { CompareResult } from "@/lib/ttp-compare";

const q = encodeURIComponent;

export interface ComparisonRow {
  id: string;
  project_id: string;
  request: Record<string, unknown>;
  result: CompareResult;
  schema: string;
  request_digest: string;
  provenance_digest: string;
  engine_version: string;
  grade: "indicative" | "screening";
  saved_at: string;
}

export type SaveTarget =
  | { kind: "existing"; project: ProjectRow }
  | { kind: "new"; project_name: string; company: string | null };

/**
 * Save one engine answer. For a new project the project and the comparison are created in one transaction, so a
 * failure leaves neither. Saving an identical comparison again (same request, same engine build) writes nothing.
 */
export async function saveComparison(
  target: SaveTarget,
  engineBody: Record<string, unknown>,
  result: CompareResult
): Promise<Result<{ project_id: string; comparison_id: string; created: boolean; project_token: string | null }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const stamp = new Date().toISOString();
  const projectToken = target.kind === "new" ? newCaseToken() : null;
  const record = {
    ...(target.kind === "existing" ? { project_id: target.project.id } : {}),
    request: engineBody,
    result,
    schema: result.schema,
    request_digest: result.request_digest,
    provenance_digest: result.provenance.digest,
    engine_version: result.provenance.engine_version,
    grade: result.grade,
    saved_at: stamp,
  };
  const r = await rpc<{ project_id: string; comparison_id: string; created: boolean }>("gf_save_comparison", {
    p: record,
    p_event: ev("comparison_saved", "project_token_holder", {
      request_digest: result.request_digest,
      grade: result.grade,
      engine_version: result.provenance.engine_version,
    }),
    ...(target.kind === "new"
      ? {
          p_new_project: {
            project_token: projectToken,
            company: target.company,
            project_name: target.project_name,
            site_label: null,
            location: null,
            status: "draft",
            created_at: stamp,
            updated_at: stamp,
          },
          p_new_event: ev("project_created", "project_token_holder", { project_name: target.project_name, via: "ttp_compare" }),
        }
      : {}),
  });
  if (!r.ok) {
    if (r.code === "23503") return { ok: false, status: 404, error: "That project was not found." };
    return { ok: false, status: r.status === 503 ? 503 : 502, error: "The comparison could not be saved. Nothing was recorded." };
  }
  if (!r.data) return { ok: false, status: 502, error: "The comparison could not be saved. Nothing was recorded." };
  return { ok: true, ...r.data, project_token: projectToken };
}

/** Newest first. */
export async function listComparisons(project_id: string): Promise<Result<{ comparisons: ComparisonRow[] }>> {
  const r = await rest<ComparisonRow[]>(
    "GET",
    `project_comparisons?project_id=eq.${q(project_id)}&select=*&order=saved_at.desc,id.desc`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The saved comparisons could not be read." };
  return { ok: true, comparisons: r.data ?? [] };
}
