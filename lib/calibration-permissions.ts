// Server-only: the owner's permission for a project's measurements to feed the shared calibration ledger (migration 0047).
//
// An administrator RECORDS a decision the project's owner took elsewhere: the e-mail address of the person who took it, the SHA-256 of
// the signed document that evidences it, and a note. Nothing here asks the owner and nothing authenticates the address: it is a record
// of a document the administrator holds, kept in an append-only log. A revocation is a new row, never an edit. The standing decision is
// the newest row, and the calibration_ledger_rows view, which `gridforge calibrate import` trusts, admits a project's observations only
// while that row is a grant.

import { creds, ev, rpc, STORE_UNCONFIGURED, type Result } from "@/lib/projects";

export const PERMISSION_KINDS = ["granted", "revoked"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export interface PermissionRow {
  id: string;
  seq: number;
  scope_type: "project";
  scope_id: string;
  kind: PermissionKind;
  granted_by_email: string;
  granted_at: string;
  document_sha256: string;
  note: string | null;
}

const NOT_AVAILABLE = {
  ok: false as const,
  status: 503,
  error: "Recording calibration permissions is not available yet: its database migration has not been applied. Nothing was recorded.",
};

/** PostgREST says the function is unknown (PGRST202) or Postgres says it does not exist (42883): the migration is not applied. */
export const missingFunction = (code: string | undefined) => code === "PGRST202" || code === "42883";

export async function recordCalibrationPermission(input: {
  project_id: string;
  kind: PermissionKind;
  granted_by_email: string;
  document_sha256: string;
  note?: string;
}): Promise<Result<{ permission: PermissionRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const done = await rpc<PermissionRow>("gf_record_calibration_permission", {
    p: {
      scope_type: "project",
      scope_id: input.project_id,
      kind: input.kind,
      granted_by_email: input.granted_by_email,
      document_sha256: input.document_sha256,
      note: input.note ?? null,
    },
    // The history line names the kind and the document digest. The address is not repeated into it.
    p_event: ev("calibration_permission_recorded", "admin_console", { kind: input.kind }),
  });
  if (!done.ok || !done.data) {
    if (done.ok === false) {
      if (missingFunction(done.code)) return NOT_AVAILABLE;
      if (done.code === "23503") return { ok: false, status: 404, error: "No such project." };
      if (done.code === "GF006") {
        return { ok: false, status: 409, error: "There is no standing permission to revoke for this project." };
      }
      if (done.code === "23514" || done.code === "23502" || done.code === "22P02") {
        return { ok: false, status: 422, error: "The permission was refused: it needs a valid e-mail address, the SHA-256 of the signed document and a known kind." };
      }
    }
    return { ok: false, status: 502, error: "The permission could not be recorded. Nothing was recorded." };
  }
  return { ok: true, permission: done.data };
}
