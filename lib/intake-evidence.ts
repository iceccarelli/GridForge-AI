// The buyer's own documents behind the numbers of a purchased engagement, and the values they confirm from them.
//
// The three figures a Density Screen can be left without (firm connection capacity, floor loading, chilled-water plant capacity) are
// the ones a customer can actually evidence: a DSO agreement, a structural record, a mechanical schedule. Typing a number into a form
// gives the engine "customer data" with nothing behind it. This lets the buyer attach the document, say where in it the number is,
// and attest to it; the engine then receives the number WITH that provenance, and the document the buyer gets back names the file.
//
// What this is not: nothing here reads a document. The value is a number the buyer typed against a file and confirmed, never a figure
// extracted from it, and it enters the model as customer data (E5, which is the most a customer can attest to; E6 and E7 are earned
// by the calibration ledger). GridForge has not verified the document, and the engine's note says so.
//
// Storage: migration 0044 (intake_evidence_files, intake_value_events), the private `project-evidence` bucket. Until that migration is
// applied every function here answers 503 "not available" and the intake works exactly as it did.

import crypto from "node:crypto";
import { storeFault } from "@/lib/safe-log";
import { creds, rest, type Fail, type Result } from "@/lib/pgrest";
import { EVIDENCE_BUCKET, EVIDENCE_MAX_BYTES, checkEvidenceType, safeName } from "@/lib/projects";
import { ASSUMABLE_FOR_SCREEN, screenIntakeSchema, type AssumableField } from "@/lib/engagement-intake";

/** A file is a few pages of a contract; an engagement does not need a file share. */
export const INTAKE_MAX_FILES = 10;
/** Confirmations and withdrawals together: history is cheap, but it is bounded. */
export const INTAKE_MAX_EVENTS = 60;

/** The only statuses in which an engagement still takes its intake (the same two /api/intake/<token> accepts; the database enforces it too). */
export const INTAKE_OPEN_STATUSES = ["awaiting_intake", "engine_unavailable"] as const;

export const CONFIRMABLE: Record<AssumableField, { unit: "MVA" | "kPa" | "kW"; label: string; path: readonly string[] }> = {
  firmCapacityMVA: { unit: "MVA", label: "Firm connection capacity", path: ["grid", "firm_capacity_MVA"] },
  floorLoadingKPa: { unit: "kPa", label: "Floor loading", path: ["hall", "floor_loading_kPa"] },
  plantCapacityKW: { unit: "kW", label: "Chilled-water plant capacity", path: ["thermal", "plant", "chilled_water_capacity_kW"] },
};

export interface IntakeFileRow {
  id: string;
  deliverable_id: string;
  filename: string;
  media_type: string;
  sha256: string;
  byte_size: number;
  storage_ref: string;
  uploaded_at: string;
}

export interface ValueEventRow {
  id: string;
  seq: number;
  deliverable_id: string;
  action: "confirm" | "withdraw";
  field: AssumableField;
  value: number | null;
  unit: string | null;
  file_id: string | null;
  locator: string | null;
  confirmed_by: string | null;
  occurred_at: string;
}

export interface ConfirmedValue {
  field: AssumableField;
  value: number;
  unit: string;
  file: Pick<IntakeFileRow, "id" | "filename" | "sha256">;
  locator: string;
  confirmedAt: string;
}

/** The engagement fields this module needs; a DeliverableRecord satisfies it. */
export interface IntakeOwner {
  id: string;
  status: string;
  email?: string | null;
}

const NOT_AVAILABLE: Fail = {
  ok: false,
  status: 503,
  error: "Attaching documents is not available yet. Your intake works as before: type the numbers in and they are used as your own data.",
};

const isConfirmable = (f: unknown): f is AssumableField => typeof f === "string" && (ASSUMABLE_FOR_SCREEN as readonly string[]).includes(f);

/** The migration is not applied: PostgREST says the relation is unknown (PGRST205) or Postgres says it does not exist (42P01). */
const missingTable = (code: string | undefined) => code === "PGRST205" || code === "42P01";

/**
 * A field's effective value is its newest event, if that event is a confirmation. A withdrawal removes it from use and leaves the
 * confirmation in the history. Pure; events may arrive in any order.
 */
export function effectiveConfirmed(events: ValueEventRow[], files: IntakeFileRow[]): ConfirmedValue[] {
  const newest = new Map<AssumableField, ValueEventRow>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) newest.set(e.field, e);
  const byId = new Map(files.map((f) => [f.id, f]));
  const out: ConfirmedValue[] = [];
  for (const f of ASSUMABLE_FOR_SCREEN) {
    const e = newest.get(f);
    if (!e || e.action !== "confirm" || e.value === null || !e.file_id || !e.locator) continue;
    const file = byId.get(e.file_id);
    if (!file) continue; // cannot happen under the foreign key; never confirm a value whose file we cannot name
    out.push({ field: f, value: e.value, unit: CONFIRMABLE[f].unit, file: { id: file.id, filename: file.filename, sha256: file.sha256 }, locator: e.locator, confirmedAt: e.occurred_at });
  }
  return out;
}

/** What the engine's report prints beside the number. Names the file and the place in it, and is plain that GridForge has not verified it. */
export function provenanceFor(c: ConfirmedValue): { source: string; note: string } {
  return {
    source: `${c.file.filename} (sha256 ${c.file.sha256.slice(0, 12)}…), ${c.locator}`,
    // The date is the event's own timestamp. If a row ever lacks one the note says less, never a date made up (and never an error that
    // would turn a paid submission into a 500).
    note:
      `Confirmed by the buyer from their own document${typeof c.confirmedAt === "string" && c.confirmedAt.length >= 10 ? ` on ${c.confirmedAt.slice(0, 10)}` : ""}. ` +
      "GridForge has not independently verified the document or the figure.",
  };
}

export type MergeResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; conflicts: { field: AssumableField; typed: number; confirmed: number }[] };

/**
 * Put the confirmed values into the engine's intake document, each as {value, source, note, evidence: "E5"} (the loader's own shape for
 * a number with provenance). A field the form also filled in with a DIFFERENT number is a contradiction and is refused, not resolved:
 * picking one would silently discard something the buyer said. The same number is fine; the confirmed one carries the provenance.
 */
export function applyConfirmedValues(doc: Record<string, unknown>, typed: Record<string, unknown>, confirmed: ConfirmedValue[]): MergeResult {
  const conflicts: { field: AssumableField; typed: number; confirmed: number }[] = [];
  for (const c of confirmed) {
    const t = typed[c.field];
    if (typeof t === "number" && t !== c.value) conflicts.push({ field: c.field, typed: t, confirmed: c.value });
  }
  if (conflicts.length) return { ok: false, conflicts };
  const out = structuredClone(doc);
  for (const c of confirmed) {
    const path = CONFIRMABLE[c.field].path;
    let node = out as Record<string, unknown>;
    for (const key of path.slice(0, -1)) {
      const next = node[key];
      node = (next && typeof next === "object" && !Array.isArray(next) ? next : (node[key] = {})) as Record<string, unknown>;
    }
    node[path[path.length - 1]] = { value: c.value, ...provenanceFor(c), evidence: "E5" };
  }
  return { ok: true, doc: out };
}

const q = encodeURIComponent;

async function readAll(owner: IntakeOwner): Promise<Result<{ files: IntakeFileRow[]; events: ValueEventRow[] }>> {
  const files = await rest<IntakeFileRow[]>("GET", `intake_evidence_files?deliverable_id=eq.${q(owner.id)}&select=*&order=uploaded_at.asc&limit=${INTAKE_MAX_FILES + 1}`);
  if (!files.ok) return missingTable((files as { code?: string }).code) ? NOT_AVAILABLE : { ok: false, status: 502, error: "The attached documents could not be read." };
  const events = await rest<ValueEventRow[]>("GET", `intake_value_events?deliverable_id=eq.${q(owner.id)}&select=*&order=seq.desc&limit=${INTAKE_MAX_EVENTS + 1}`);
  if (!events.ok) return missingTable((events as { code?: string }).code) ? NOT_AVAILABLE : { ok: false, status: 502, error: "The confirmed values could not be read." };
  return { ok: true, files: files.data ?? [], events: events.data ?? [] };
}

/** The panel's data: the files, and the values currently confirmed from them. */
export async function listIntakeEvidence(owner: IntakeOwner): Promise<Result<{ files: Omit<IntakeFileRow, "storage_ref" | "deliverable_id">[]; confirmed: ConfirmedValue[] }>> {
  const all = await readAll(owner);
  if (!all.ok) return all;
  return {
    ok: true,
    files: all.files.map(({ storage_ref: _s, deliverable_id: _d, ...f }) => f),
    confirmed: effectiveConfirmed(all.events, all.files),
  };
}

/** For the intake submission: the confirmed values, or an empty list where evidence is simply not available (the intake then works as before). */
export async function confirmedForIntake(owner: IntakeOwner): Promise<Result<{ confirmed: ConfirmedValue[] }>> {
  const all = await readAll(owner);
  if (!all.ok) return all.status === 503 ? { ok: true, confirmed: [] } : all;
  return { ok: true, confirmed: effectiveConfirmed(all.events, all.files) };
}

const closed = (owner: IntakeOwner): Fail | null =>
  (INTAKE_OPEN_STATUSES as readonly string[]).includes(owner.status)
    ? null
    : { ok: false, status: 409, error: "This engagement is no longer taking its intake, so documents can no longer be changed." };

/** Attach one file to the engagement. Stored as received and never read: the bytes are checked for what they claim to be, not interpreted. */
export async function attachIntakeFile(
  owner: IntakeOwner,
  file: { filename: string; mediaType: string; bytes: Uint8Array }
): Promise<Result<{ file: Omit<IntakeFileRow, "storage_ref" | "deliverable_id"> }>> {
  const c = creds();
  if (!c) return NOT_AVAILABLE;
  const shut = closed(owner);
  if (shut) return shut;
  const mediaType = file.mediaType.split(";")[0].trim().toLowerCase();
  const badType = checkEvidenceType(mediaType);
  if (badType) return badType;
  if (file.bytes.byteLength === 0) return { ok: false, status: 422, error: "The file is empty." };
  if (file.bytes.byteLength > EVIDENCE_MAX_BYTES) return { ok: false, status: 413, error: `The file is larger than the ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB limit.` };
  if (mediaType === "application/pdf" && Buffer.from(file.bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    return { ok: false, status: 415, error: "The file is not a PDF, whatever its declared type." };
  }
  const filename = safeName(file.filename);
  if (!filename) return { ok: false, status: 422, error: "A filename is required." };
  const sha256 = crypto.createHash("sha256").update(file.bytes).digest("hex");

  const held = await readAll(owner);
  if (!held.ok) return held;
  if (held.files.length >= INTAKE_MAX_FILES) return { ok: false, status: 409, error: `This engagement already holds ${INTAKE_MAX_FILES} documents, which is the most it keeps.` };
  if (held.files.some((f) => f.sha256 === sha256)) return { ok: false, status: 409, error: "This exact file is already attached." };

  const storage_ref = `${EVIDENCE_BUCKET}/intake/${owner.id}/${sha256}-${filename}`;
  const objectUrl = `${c.url}/storage/v1/object/${storage_ref}`;
  const { "Content-Type": _json, ...authOnly } = c.headers;
  void _json;
  try {
    const put = await fetch(objectUrl, { method: "POST", headers: { ...authOnly, "Content-Type": mediaType, "x-upsert": "false" }, body: Buffer.from(file.bytes), cache: "no-store" });
    if (!put.ok) {
      console.error("[GridForge] intake evidence object store failed:", await storeFault(put));
      return { ok: false, status: 502, error: "The file could not be stored. Nothing was attached." };
    }
  } catch (err) {
    console.error("[GridForge] intake evidence object store unreachable:", err);
    return { ok: false, status: 502, error: "The file could not be stored. Nothing was attached." };
  }
  const added = await rest<IntakeFileRow[]>("POST", "intake_evidence_files", {
    deliverable_id: owner.id, filename, media_type: mediaType, sha256, byte_size: file.bytes.byteLength, storage_ref,
  });
  if (!added.ok || !added.data?.[0]) {
    // The object is outside the database: remove it, so the store never holds a file the inventory does not know.
    try {
      await fetch(objectUrl, { method: "DELETE", headers: authOnly, cache: "no-store" });
    } catch (err) {
      console.error("[GridForge] orphaned intake evidence object could not be removed:", storage_ref, err);
    }
    if (!added.ok && missingTable((added as { code?: string }).code)) return NOT_AVAILABLE;
    return { ok: false, status: 502, error: "The file's record could not be saved. Nothing was attached." };
  }
  const { storage_ref: _s, deliverable_id: _d, ...safe } = added.data[0];
  return { ok: true, file: safe };
}

/**
 * Record that the buyer confirms a figure from one of THEIR attached files. The unit comes from the field, the attester from the
 * engagement; the request supplies only the number, the file and where in it. The number must be a JSON number inside the intake form's
 * own bounds for that field (a numeric string is refused for the reason the engine refuses it: it is text).
 */
export async function confirmValue(
  owner: IntakeOwner,
  input: { field: unknown; value: unknown; fileId: unknown; locator: unknown }
): Promise<Result<{ confirmed: ConfirmedValue[] }>> {
  const shut = closed(owner);
  if (shut) return shut;
  if (!isConfirmable(input.field)) return { ok: false, status: 422, error: `field must be one of ${ASSUMABLE_FOR_SCREEN.join(", ")}.` };
  const field = input.field;
  if (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value <= 0) {
    return { ok: false, status: 422, error: `${field} must be a positive number (as a JSON number, not text).` };
  }
  const bounds = screenIntakeSchema.shape[field].safeParse(input.value);
  if (!bounds.success) return { ok: false, status: 422, error: `${field} is outside the range this tool models (${bounds.error.issues[0]?.message ?? "invalid"}).` };
  const locator = typeof input.locator === "string" ? input.locator.trim() : "";
  // Printed in the buyer's document beside the number: plain text only, so it cannot carry markup into the Markdown rendering.
  if (locator.length < 1 || locator.length > 200 || /[<>\u0000-\u001f]/.test(locator)) {
    return { ok: false, status: 422, error: "locator must say where in the file the number is (1 to 200 plain characters, no < or >), for example 'clause 4.2' or 'page 3, table 1'." };
  }
  if (typeof input.fileId !== "string") return { ok: false, status: 422, error: "fileId must be the id of a document attached to this engagement." };

  const all = await readAll(owner);
  if (!all.ok) return all;
  if (!all.files.some((f) => f.id === input.fileId)) return { ok: false, status: 404, error: "That document is not attached to this engagement." };
  if (all.events.length >= INTAKE_MAX_EVENTS) return { ok: false, status: 409, error: "This engagement has reached the most confirmations it keeps." };

  const added = await rest("POST", "intake_value_events", {
    deliverable_id: owner.id, action: "confirm", field, value: input.value, unit: CONFIRMABLE[field].unit,
    file_id: input.fileId, locator, confirmed_by: owner.email ?? null,
  });
  if (!added.ok) return missingTable((added as { code?: string }).code) ? NOT_AVAILABLE : { ok: false, status: 502, error: "The confirmation could not be saved." };
  const after = await listIntakeEvidence(owner);
  return after.ok ? { ok: true, confirmed: after.confirmed } : after;
}

/** Stop using a confirmed figure. The confirmation stays in the history; the field goes back to whatever the form says, or to an assumption. */
export async function withdrawValue(owner: IntakeOwner, field: unknown): Promise<Result<{ confirmed: ConfirmedValue[] }>> {
  const shut = closed(owner);
  if (shut) return shut;
  if (!isConfirmable(field)) return { ok: false, status: 422, error: `field must be one of ${ASSUMABLE_FOR_SCREEN.join(", ")}.` };
  const all = await readAll(owner);
  if (!all.ok) return all;
  if (!effectiveConfirmed(all.events, all.files).some((c) => c.field === field)) return { ok: false, status: 404, error: "There is no confirmed value for that field." };
  if (all.events.length >= INTAKE_MAX_EVENTS) return { ok: false, status: 409, error: "This engagement has reached the most confirmations it keeps." };
  const added = await rest("POST", "intake_value_events", { deliverable_id: owner.id, action: "withdraw", field });
  if (!added.ok) return { ok: false, status: 502, error: "The withdrawal could not be saved." };
  const after = await listIntakeEvidence(owner);
  return after.ok ? { ok: true, confirmed: after.confirmed } : after;
}
