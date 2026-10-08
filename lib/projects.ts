// Server-only data layer for the Verified Power Record: one canonical project,
// joined to the objects that already exist, with an immutable history.
//
// A project is a JOIN and EVIDENCE layer (supabase/migrations/0015_projects.sql).
// It is not authoritative for anything the engine computes: a BTM case's request
// and result stay in power_deployment_cases and are read from there on every
// call; nothing here copies or recomputes capacity, headroom, scoring or price.
//
// Same PostgREST-over-fetch shape as lib/power-deploy.ts and lib/watches.ts, with
// one deliberate difference: there is NO in-memory fallback. lib/power-deploy.ts
// can degrade to a per-process Map for local development; a project is a record
// customers rely on across sessions, so without Supabase every write here fails
// explicitly — in every environment, not only production — and no function in this
// file can report a durable success it did not get.
//
// Authority: a `project_token` is a bearer capability, like `case_token` and the
// deliverable `token` (the site has no account system). It is never enough to
// reach INTO another object: attaching a case also requires that case's own token
// and, when the case is registered to an email, that email. Possession of a guessed
// id, or of a case token alone, cannot mutate a project.

import crypto from "node:crypto";
import { latestDeploymentCase, newCaseToken } from "@/lib/power-deploy";

export type Fail = { ok: false; status: number; error: string };
export type Ok<T> = { ok: true } & T;
export type Result<T> = Ok<T> | Fail;

export const PROJECT_STATUSES = ["draft", "active", "decision", "closed"] as const;

export type ProjectEventType =
  | "project_created"
  | "btm_case_attached"
  | "btm_case_revised"
  | "rfq_generated"
  | "supplier_response_received"
  | "comparison_completed"
  | "supplier_selected"
  | "evidence_attached";

export interface ProjectRow {
  id: string;
  project_token: string;
  company: string | null;
  project_name: string;
  site_label: string | null;
  location: Record<string, string | number | boolean> | null;
  status: (typeof PROJECT_STATUSES)[number];
  created_at: string;
  updated_at: string;
}

export interface ProjectEventRow {
  id: string;
  project_id: string;
  event_type: ProjectEventType;
  occurred_at: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface ProjectLinkRow {
  id: string;
  project_id: string;
  object_type: string;
  object_id: string;
  prediction_ref: string | null;
  created_at: string;
}

export const STORE_UNCONFIGURED: Fail = {
  ok: false,
  status: 503,
  error:
    "The project record is not available: Supabase is not configured on this deployment. " +
    "Nothing was saved.",
};

export function creds(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers: { ...auth, "Content-Type": "application/json" } };
}

type Rest<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string };

/** One PostgREST call. Never throws: a transport failure and a non-2xx are both
 * `ok: false`, because `fetch` does not reject on 4xx/5xx and an unchecked 404 on a
 * table that does not exist is exactly how a write gets reported as saved. */
export async function rest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<Rest<T>> {
  const c = creds();
  if (!c) return { ok: false, status: 503, error: STORE_UNCONFIGURED.error };
  try {
    const res = await fetch(`${c.url}/rest/v1/${path}`, {
      method,
      headers: method === "GET" ? c.headers : { ...c.headers, Prefer: "return=representation" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const code = (parsed as { code?: string } | null)?.code;
      console.error(`[GridForge] project store ${method} ${path.split("?")[0]} -> ${res.status}`, text);
      return { ok: false, status: res.status, error: `store ${res.status}`, code };
    }
    return { ok: true, status: res.status, data: parsed as T };
  } catch (err) {
    console.error(`[GridForge] project store ${method} ${path.split("?")[0]} unreachable:`, err);
    return { ok: false, status: 502, error: "store unreachable" };
  }
}

const q = encodeURIComponent;
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- events

/** One history event, as the atomic write functions in 0015_projects.sql take it.
 * There is deliberately NO function here that inserts, updates or deletes an event on
 * its own: every event is written by the same database call (an RPC, one transaction)
 * that writes the business record it describes — see `rpc` below — so a record and
 * its history succeed or fail together. The table's trigger additionally refuses
 * UPDATE and DELETE to every role, the service role included. */
export function ev(
  event_type: ProjectEventType,
  actor: string,
  payload: Record<string, unknown> = {}
): { event_type: ProjectEventType; actor: string; occurred_at: string; payload: Record<string, unknown> } {
  return { event_type, actor, occurred_at: now(), payload };
}

/** Call one of the gf_* functions. The record and its event commit or roll back
 * together; the caller never has to compensate for half a write. */
export async function rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<Rest<T>> {
  return rest<T>("POST", `rpc/${name}`, args);
}

export async function listEvents(project_id: string): Promise<Result<{ events: ProjectEventRow[] }>> {
  const r = await rest<ProjectEventRow[]>(
    "GET",
    `project_events?project_id=eq.${q(project_id)}&select=*&order=occurred_at.asc`
  );
  if (!r.ok) return { ok: false, status: r.status === 503 ? 503 : 502, error: "The project history could not be read." };
  return { ok: true, events: r.data ?? [] };
}

// ---------------------------------------------------------------- projects

const MAX_TEXT = 200;

function optText(v: unknown, field: string): Result<{ value: string | null }> {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || v.trim().length > MAX_TEXT) {
    return { ok: false, status: 422, error: `${field} must be text of at most ${MAX_TEXT} characters.` };
  }
  return { ok: true, value: v.trim() };
}

/** Whatever the customer typed, flat, nothing added. No geocoding, no lookups. */
function cleanLocation(v: unknown): Result<{ value: ProjectRow["location"] }> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, status: 422, error: "location must be an object of values you supplied." };
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 12) return { ok: false, status: 422, error: "location has too many fields." };
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of entries) {
    const okScalar =
      (typeof val === "string" && val.length <= MAX_TEXT) ||
      (typeof val === "number" && Number.isFinite(val)) ||
      typeof val === "boolean";
    if (!okScalar || k.length > 40) {
      return { ok: false, status: 422, error: `location.${k} must be a short text, number or boolean.` };
    }
    out[k] = val as string | number | boolean;
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}

/** The one server-side creation path. Validates, inserts, records `project_created`.
 * Never touches the engine and never creates an engineering object. */
export async function createProject(input: Record<string, unknown>): Promise<Result<{ project: ProjectRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const name = typeof input.project_name === "string" ? input.project_name.trim() : "";
  if (!name || name.length > MAX_TEXT) {
    return { ok: false, status: 422, error: `project_name is required (at most ${MAX_TEXT} characters).` };
  }
  const company = optText(input.company, "company");
  if (!company.ok) return company;
  const site = optText(input.site_label, "site_label");
  if (!site.ok) return site;
  const loc = cleanLocation(input.location);
  if (!loc.ok) return loc;

  const stamp = now();
  const made = await rpc<ProjectRow>("gf_create_project", {
    p: {
      project_token: newCaseToken(),
      company: company.value,
      project_name: name,
      site_label: site.value,
      location: loc.value,
      status: "draft",
      created_at: stamp,
      updated_at: stamp,
    },
    p_event: ev("project_created", "project_token_holder", { project_name: name }),
  });
  if (!made.ok || !made.data) return { ok: false, status: 502, error: "The project could not be saved." };
  return { ok: true, project: made.data };
}

export async function getProjectByToken(token: string): Promise<Result<{ project: ProjectRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  if (!token) return { ok: false, status: 404, error: "Not found." };
  const r = await rest<ProjectRow[]>("GET", `projects?project_token=eq.${q(token)}&select=*&limit=1`);
  if (!r.ok) return { ok: false, status: 502, error: "The project could not be read." };
  const project = r.data?.[0];
  if (!project) return { ok: false, status: 404, error: "Not found." };
  return { ok: true, project };
}

// ---------------------------------------------------------------- links

export async function linksFor(
  object_type: string,
  object_id: string
): Promise<Result<{ links: ProjectLinkRow[] }>> {
  const r = await rest<ProjectLinkRow[]>(
    "GET",
    `project_links?object_type=eq.${q(object_type)}&object_id=eq.${q(object_id)}&select=*`
  );
  if (!r.ok) return { ok: false, status: 502, error: "Project links could not be read." };
  return { ok: true, links: r.data ?? [] };
}

export async function projectLinks(project_id: string): Promise<Result<{ links: ProjectLinkRow[] }>> {
  const r = await rest<ProjectLinkRow[]>("GET", `project_links?project_id=eq.${q(project_id)}&select=*`);
  if (!r.ok) return { ok: false, status: 502, error: "Project links could not be read." };
  return { ok: true, links: r.data ?? [] };
}

/**
 * Attach an existing BTM case to a project. The case stays authoritative where it is;
 * only a link row is written, and `btm_case_attached` is appended only when the link
 * was actually created.
 */
export async function attachCase(
  project: ProjectRow,
  case_token: string,
  confirmEmail?: string | null
): Promise<Result<{ created: boolean; revision: number }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const row = await latestDeploymentCase(case_token);
  if (!row) return { ok: false, status: 404, error: "That case was not found." };

  // Same ownership rule as the case's own revision route: a registered case needs
  // its email, not just its token.
  if (row.email) {
    const given = (confirmEmail ?? "").trim().toLowerCase();
    if (given !== row.email.trim().toLowerCase()) {
      return { ok: false, status: 403, error: "This case is registered to a different email address." };
    }
  }

  const elsewhere = await linksFor("power_deployment_case", case_token);
  if (!elsewhere.ok) return elsewhere;
  if (elsewhere.links.some((l) => l.project_id !== project.id)) {
    return { ok: false, status: 409, error: "This case is already attached to a different project." };
  }

  const r = await rpc<{ created: boolean }>("gf_attach_case", {
    p_project: project.id,
    p_case_token: case_token,
    p_event: ev("btm_case_attached", row.email ? row.email : "project_token_holder", {
      case_token,
      revision: row.revision,
    }),
  });
  if (!r.ok) {
    // The unique index on (object_type, object_id) lost a race to another project.
    if (r.code === "23505" || r.status === 409) {
      return { ok: false, status: 409, error: "This case is already attached to a different project." };
    }
    return { ok: false, status: 502, error: "The case could not be attached. Nothing was recorded." };
  }
  return { ok: true, created: r.data?.created === true, revision: row.revision };
}

/** The reference a future calibration observation attaches to. Pure; creates nothing. */
export function predictionRef(case_token: string, revision: number, architecture: string): string {
  return `power_deployment_case:${case_token}:r${revision}:${architecture}`;
}

// ---------------------------------------------------------------- evidence

export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MEDIA_TYPES = ["application/pdf", "text/csv", "application/json"] as const;
export const EVIDENCE_CATEGORIES = [
  "utility_correspondence",
  "supplier_document",
  "load_data",
  "site_documentation",
  "other",
] as const;
export const EVIDENCE_BUCKET = "project-evidence";

export interface EvidenceRow {
  id: string;
  project_id: string;
  filename: string;
  media_type: string;
  sha256: string;
  byte_size: number;
  storage_ref: string;
  source_category: string;
  evidence_class: string | null;
  review_status: "unverified" | "verified" | "rejected";
  note: string | null;
  uploaded_at: string;
}

/** The media-type gate, callable before a request body is read at all. */
export function checkEvidenceType(declared: string): Fail | null {
  const mediaType = declared.split(";")[0].trim().toLowerCase();
  if ((EVIDENCE_MEDIA_TYPES as readonly string[]).includes(mediaType)) return null;
  return {
    ok: false,
    status: 415,
    error: `Unsupported file type "${mediaType || "unknown"}". Accepted: ${EVIDENCE_MEDIA_TYPES.join(", ")}.`,
  };
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
}

/**
 * upload -> validate type -> validate size -> hash -> store object -> persist
 * metadata -> append `evidence_attached`. Validation runs before anything is
 * written; a failure at any later step undoes the earlier ones, so the database never
 * claims an object that is not stored and the caller is never told "attached" for a
 * file that is not. Contents are never parsed and never classified: the file lands
 * `unverified` with no evidence class.
 */
export async function attachEvidence(
  project: ProjectRow,
  file: { filename: string; mediaType: string; bytes: Uint8Array; sourceCategory?: string; note?: string }
): Promise<Result<{ evidence: EvidenceRow }>> {
  const c = creds();
  if (!c) return STORE_UNCONFIGURED;

  const mediaType = file.mediaType.split(";")[0].trim().toLowerCase();
  const badType = checkEvidenceType(mediaType);
  if (badType) return badType;
  if (file.bytes.byteLength === 0) return { ok: false, status: 422, error: "The file is empty." };
  if (file.bytes.byteLength > EVIDENCE_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `The file is larger than the ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB limit.`,
    };
  }
  if (mediaType === "application/pdf") {
    const head = Buffer.from(file.bytes.subarray(0, 5)).toString("latin1");
    if (head !== "%PDF-") {
      return { ok: false, status: 415, error: "The file is not a PDF, whatever its declared type." };
    }
  }
  const category = file.sourceCategory ?? "other";
  if (!(EVIDENCE_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, status: 422, error: `source_category must be one of ${EVIDENCE_CATEGORIES.join(", ")}.` };
  }
  const filename = safeName(file.filename);
  if (!filename) return { ok: false, status: 422, error: "A filename is required." };
  const note = (file.note ?? "").trim().slice(0, 500) || null;

  const sha256 = crypto.createHash("sha256").update(file.bytes).digest("hex");

  const dup = await rest<EvidenceRow[]>(
    "GET",
    `project_evidence?project_id=eq.${q(project.id)}&sha256=eq.${sha256}&select=id&limit=1`
  );
  if (!dup.ok) return { ok: false, status: 502, error: "The evidence inventory could not be read." };
  if (dup.data?.length) {
    return { ok: false, status: 409, error: "This exact file is already attached to the project." };
  }

  const objectPath = `${project.id}/${sha256}-${filename}`;
  const storage_ref = `${EVIDENCE_BUCKET}/${objectPath}`;
  const objectUrl = `${c.url}/storage/v1/object/${storage_ref}`;
  const { "Content-Type": _json, ...authOnly } = c.headers;
  void _json;

  try {
    const put = await fetch(objectUrl, {
      method: "POST",
      headers: { ...authOnly, "Content-Type": mediaType, "x-upsert": "false" },
      body: Buffer.from(file.bytes),
      cache: "no-store",
    });
    if (!put.ok) {
      console.error("[GridForge] evidence object store failed:", put.status, await put.text());
      return { ok: false, status: 502, error: "The file could not be stored. Nothing was attached." };
    }
  } catch (err) {
    console.error("[GridForge] evidence object store unreachable:", err);
    return { ok: false, status: 502, error: "The file could not be stored. Nothing was attached." };
  }

  const undoObject = async () => {
    try {
      await fetch(objectUrl, { method: "DELETE", headers: authOnly, cache: "no-store" });
    } catch (err) {
      console.error("[GridForge] orphaned evidence object could not be removed:", storage_ref, err);
    }
  };

  const added = await rpc<EvidenceRow>("gf_add_evidence", {
    p: {
      project_id: project.id,
      filename,
      media_type: mediaType,
      sha256,
      byte_size: file.bytes.byteLength,
      storage_ref,
      source_category: category,
      evidence_class: null,
      review_status: "unverified",
      note,
      uploaded_at: now(),
    },
    p_event: ev("evidence_attached", "project_token_holder", {
      filename,
      media_type: mediaType,
      sha256,
      byte_size: file.bytes.byteLength,
      review_status: "unverified",
    }),
  });
  // Row and event were one transaction: if it failed, neither exists. Only the stored
  // object (outside the database) needs undoing.
  if (!added.ok || !added.data) {
    await undoObject();
    return { ok: false, status: 502, error: "The file's record could not be saved. Nothing was attached." };
  }
  return { ok: true, evidence: added.data };
}
