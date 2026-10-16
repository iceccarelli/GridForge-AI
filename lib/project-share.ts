// Server-only: the read-only buyer link for a project (supabase/migrations/0025_project_comparisons_and_shares.sql).
//
// A project_token is a bearer capability to WRITE the project, so it cannot be handed to a CFO or a utility contact.
// The share link is a second, weaker capability: it reads the decision, and it can start a checkout that attaches a
// purchase to the project. It can change nothing else. Only the SHA-256 of the secret is stored; the secret itself is
// returned once, when issued, and cannot be shown again -- only replaced or revoked.

import crypto from "node:crypto";
import { creds, ev, rest, rpc, STORE_UNCONFIGURED, type ProjectRow, type Result } from "@/lib/projects";

const q = encodeURIComponent;

/** 32 random bytes, base64url: 43 characters. */
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function isShareToken(v: unknown): v is string {
  return typeof v === "string" && SHARE_TOKEN.test(v);
}

export function hashShareToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Issue a new link, retiring the previous one in the same transaction. The secret is in the return value and nowhere else. */
export async function issueShare(project: ProjectRow): Promise<Result<{ share_token: string; replaced_previous: boolean }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const token = newShareToken();
  const r = await rpc<{ replaced_previous: boolean }>("gf_issue_share", {
    p_project: project.id,
    p_token_hash: hashShareToken(token),
    p_event: ev("share_issued", "project_token_holder", {}),
  });
  if (!r.ok || !r.data) {
    return { ok: false, status: r.status === 503 ? 503 : 502, error: "The buyer link could not be created. Nothing was changed." };
  }
  return { ok: true, share_token: token, replaced_previous: r.data.replaced_previous === true };
}

export async function revokeShare(project: ProjectRow): Promise<Result<{ revoked: boolean }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rpc<{ revoked: boolean }>("gf_revoke_share", {
    p_project: project.id,
    p_event: ev("share_revoked", "project_token_holder", {}),
  });
  if (!r.ok || !r.data) {
    return { ok: false, status: r.status === 503 ? 503 : 502, error: "The buyer link could not be revoked. Nothing was changed." };
  }
  return { ok: true, revoked: r.data.revoked === true };
}

/** Whether the project has an active link, and since when. Never the secret or its hash. */
export async function shareStatus(project_id: string): Promise<Result<{ active: boolean; issued_at: string | null }>> {
  const r = await rest<{ created_at: string }[]>(
    "GET",
    `project_shares?project_id=eq.${q(project_id)}&revoked_at=is.null&select=created_at&limit=1`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The buyer link status could not be read." };
  const row = r.data?.[0];
  return { ok: true, active: !!row, issued_at: row?.created_at ?? null };
}

/**
 * Resolve a link to its project. A malformed, unknown or revoked secret is the same 404, and a malformed one never
 * reaches the store.
 */
export async function projectForShare(token: string): Promise<Result<{ project: ProjectRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  if (!isShareToken(token)) return { ok: false, status: 404, error: "Not found." };
  const s = await rest<{ project_id: string }[]>(
    "GET",
    `project_shares?token_hash=eq.${hashShareToken(token)}&revoked_at=is.null&select=project_id&limit=1`
  );
  if (!s.ok) return { ok: false, status: 502, error: "The project could not be read." };
  const projectId = s.data?.[0]?.project_id;
  if (!projectId) return { ok: false, status: 404, error: "Not found." };
  const p = await rest<ProjectRow[]>("GET", `projects?id=eq.${q(projectId)}&select=*&limit=1`);
  if (!p.ok) return { ok: false, status: 502, error: "The project could not be read." };
  const project = p.data?.[0];
  if (!project) return { ok: false, status: 404, error: "Not found." };
  return { ok: true, project };
}
