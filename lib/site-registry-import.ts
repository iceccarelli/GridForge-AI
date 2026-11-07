// Batch import of a hall's figures: parse a CSV or JSON file, judge EVERY row against the registry's own rules BEFORE anything is written, and (only
// after an explicit confirmation by the person) submit the writable rows one at a time to the existing POST /api/halls/:id/inputs.
// Plain functions, no I/O of their own and no server imports: the browser bundle uses them and the tests drive them with fakes.
//
// WHAT THIS DOES NOT DO. It does not fix anything. A row the rules refuse is shown as rejected with the reason and is never adjusted to fit (a class
// is not lowered, a unit is not converted, a source is not guessed). It does not verify anything either: origin and class are what the file's author
// declares, and the preview says so. The database is the last word on every rule below; this file mirrors them (supabase/migrations/0050_hall_inputs.sql
// and lib/sites.ts InputBody) only so a refusal is seen BEFORE the first write rather than half-way through.
//
// THE RULES MIRRORED (0050):
//   * field path: lower-case dotted, <= 120 characters (and, here, a path the registry knows: see allowedPaths)
//   * value: a finite number with |x| <= 1e15, a text of 1..200 characters, or true/false; none at all only for origin "missing"
//   * unit: <= 24 characters from a fixed alphabet, and only on a number
//   * origin measured / observed / quotation: exactly one source file; missing: no value, no source, class E0
//   * origin assumed / modelled: no class above E3; origin vendor with no file: no class above E3
//   * a purchased engagement's file is not reviewable: at most E3; a project file above E3 must be reviewed and verified when the row is written
//   * a rejected file cannot be cited; as of 1990-01-01 or later and not in the future; 500 fields per hall
// WHAT IT CANNOT KNOW: the review status of a project file that no current figure of this hall cites, whether the file belongs to a project attached
// to this hall, whether the engagement file was bought by the person importing, or how many corrections a field already has (the limit is 50). The
// preview marks a row that depends on such a fact, and the database settles it; if it refuses, the run STOPS at that row and reports.

import {
  EVIDENCE_CLASS_CODES, EXPECTED_HALL_FIELDS, FIELD_PATH_PATTERN, ORIGINS, ORIGINS_CAPPED_AT_E3, ORIGINS_NEEDING_A_SOURCE, UNIT_PATTERN, type Origin,
} from "@/lib/site-registry-fields";
import { parseCsv, toCsv } from "@/lib/site-registry-csv";
import { classRank, originText, sourceText, valueText, type RegistryInput } from "@/lib/site-registry-model";

export const IMPORT_MAX_ROWS = 200;
export const IMPORT_MAX_BYTES = 256 * 1024;
/** The registry's write allowance per verified account (lib/rate-limit.ts registry_write). Shown to the person; the server's 429 is what actually decides. */
export const WRITES_PER_HOUR = 120;
export const HALL_FIELD_LIMIT = 500;
/** A wait for a 429 longer than this is not waited out in the page: the run stops and says when to come back. */
export const MAX_AUTO_WAIT_SECONDS = 120;
export const MAX_429_RETRIES_PER_ROW = 3;

export const IMPORT_COLUMNS = ["field_path", "value", "unit", "origin", "class", "as_of", "source_kind", "source_id"] as const;
const REQUIRED_COLUMNS = ["field_path", "origin", "class", "as_of"] as const;
type Column = (typeof IMPORT_COLUMNS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

// --------------------------------------------------------------------------------------------------------------- parsing

export type RawRow = { n: number; cells: Partial<Record<Column, unknown>>; fromCsv: boolean; error?: string };
export type Parsed = { ok: true; rows: RawRow[]; format: "csv" | "json" } | { ok: false; error: string };

const byteLength = (s: string) => new TextEncoder().encode(s).length;
const isColumn = (k: string): k is Column => (IMPORT_COLUMNS as readonly string[]).includes(k);

/** Which format a file is, from its name, else from its first character. */
export function sniffFormat(fileName: string, text: string): "csv" | "json" {
  if (/\.json$/i.test(fileName)) return "json";
  if (/\.csv$/i.test(fileName)) return "csv";
  return /^\s*[[{]/.test(text.replace(/^﻿/, "")) ? "json" : "csv";
}

export function parseImport(text: string, format: "csv" | "json"): Parsed {
  if (byteLength(text) > IMPORT_MAX_BYTES) return { ok: false, error: `The file is larger than ${IMPORT_MAX_BYTES / 1024} KB. Split it into smaller files.` };
  return format === "json" ? parseJsonRows(text) : parseCsvRows(text);
}

function parseCsvRows(text: string): Parsed {
  const p = parseCsv(text, IMPORT_MAX_ROWS + 2);
  if (!p.ok) return { ok: false, error: p.error };
  if (p.rows.length === 0) return { ok: false, error: "The file has no header row. Start from the template." };
  const header = p.rows[0]!.map((h) => h.trim().toLowerCase());
  const unknown = header.filter((h) => !isColumn(h));
  if (unknown.length) return { ok: false, error: `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.map((u) => `“${u.slice(0, 40)}”`).join(", ")}. The columns are ${IMPORT_COLUMNS.join(", ")}.` };
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup) return { ok: false, error: `The column “${dup}” appears twice.` };
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { ok: false, error: `The header row lacks the column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` };
  const data = p.rows.slice(1);
  if (p.tooMany || data.length > IMPORT_MAX_ROWS) return { ok: false, error: `The file has more than ${IMPORT_MAX_ROWS} rows. Split it; nothing was read.` };
  if (data.length === 0) return { ok: false, error: "The file has a header row and no data rows." };
  const rows: RawRow[] = data.map((cells, i) => {
    const out: RawRow = { n: i + 1, cells: {}, fromCsv: true };
    if (cells.length !== header.length) out.error = `This row has ${cells.length} cell${cells.length === 1 ? "" : "s"}; the header has ${header.length}.`;
    header.forEach((h, k) => { if (isColumn(h) && cells[k] !== undefined) out.cells[h] = cells[k]; });
    return out;
  });
  return { ok: true, rows, format: "csv" };
}

function parseJsonRows(text: string): Parsed {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, error: "The file is not valid JSON." }; }
  let list: unknown = doc;
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const keys = Object.keys(doc);
    const extra = keys.filter((k) => k !== "rows" && k !== "comment");
    if (extra.length) return { ok: false, error: `Unknown top-level key${extra.length > 1 ? "s" : ""}: ${extra.map((k) => `“${k.slice(0, 40)}”`).join(", ")}. Use a list of rows, or {"rows": [...]}.` };
    list = (doc as { rows?: unknown }).rows;
  }
  if (!Array.isArray(list)) return { ok: false, error: "Expected a list of rows, or an object with a \"rows\" list." };
  if (list.length > IMPORT_MAX_ROWS) return { ok: false, error: `The file has more than ${IMPORT_MAX_ROWS} rows. Split it; nothing was read.` };
  if (list.length === 0) return { ok: false, error: "The file has no rows." };
  const rows: RawRow[] = list.map((item, i) => {
    const out: RawRow = { n: i + 1, cells: {}, fromCsv: false };
    if (!item || typeof item !== "object" || Array.isArray(item)) { out.error = "This row is not an object."; return out; }
    const unknown: string[] = [];
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (isColumn(k)) out.cells[k] = v; else unknown.push(k);
    }
    if (unknown.length) out.error = `Unknown key${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `“${k.slice(0, 40)}”`).join(", ")}.`;
    return out;
  });
  return { ok: true, rows, format: "json" };
}

// --------------------------------------------------------------------------------------------------------------- the preview

export type WriteBody = {
  fieldPath: string; value: number | string | boolean | null; unit: string | null; evidenceClass: string; origin: Origin; asOf: string;
  projectEvidenceId: string | null; intakeEvidenceFileId: string | null; supersedes: string | null;
};

export type RowStatus = "new" | "supersede" | "unchanged" | "rejected";

export interface RowPlan {
  n: number;
  status: RowStatus;
  /** The path as the registry stores it, or what was typed when it could not be read. */
  fieldPath: string;
  /** What the file said, for display (shortened). */
  shown: { value: string; origin: string; evidenceClass: string; source: string; asOf: string };
  reasons: string[];
  warnings: string[];
  replaces: RegistryInput | null;
  /** true: the row cites a project file above E3 whose review status this page cannot see; the database decides at write time. */
  needsDatabaseCheck: boolean;
  body: WriteBody | null;
}

export interface Preview {
  rows: RowPlan[];
  counts: { total: number; new: number; supersede: number; unchanged: number; rejected: number; writes: number; needDatabaseCheck: number };
}

export interface ImportContext {
  /** The hall's current figures, freshly read. */
  current: RegistryInput[];
  /** Today, UTC, as YYYY-MM-DD. */
  today: string;
}

export type AllowedPath = { path: string; unit: string | null; numeric: boolean; why: "intake field" | "already recorded for this hall" };

/** The paths an import may write: the intake fields this registry expects, and any field that already has a figure for this hall. Nothing else, so a typo is a refusal and not a new field. */
export function allowedPaths(current: RegistryInput[]): Map<string, AllowedPath> {
  const out = new Map<string, AllowedPath>();
  for (const i of current) out.set(i.fieldPath, { path: i.fieldPath, unit: i.unit ?? null, numeric: typeof i.value === "number", why: "already recorded for this hall" });
  for (const f of EXPECTED_HALL_FIELDS) out.set(f.path, { path: f.path, unit: f.unit || null, numeric: true, why: "intake field" });
  return out;
}

const short = (v: unknown, n = 48): string => {
  const s = v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? "(not a plain value)" : String(v);
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const realDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** A cell as text: trimmed; absent or empty is null; anything but text (in JSON) is a problem the caller reports. */
function textCell(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  return { ok: true, value: t === "" ? null : t };
}

type ParsedValue = { ok: true; value: number | string | boolean | null } | { ok: false; reason: string };

function parseValue(v: unknown, fromCsv: boolean): ParsedValue {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) <= 1e15 ? { ok: true, value: v } : { ok: false, reason: "That number is out of range (at most 1e15, and finite)." };
  if (typeof v === "boolean") return { ok: true, value: v };
  if (typeof v !== "string") return { ok: false, reason: "A value is a number, a short text or true/false." };
  const t = v.trim();
  if (t === "") return { ok: true, value: null };
  if (fromCsv) {
    if (NUMBER.test(t)) {
      const n = Number(t);
      return Number.isFinite(n) && Math.abs(n) <= 1e15 ? { ok: true, value: n } : { ok: false, reason: "That number is out of range (at most 1e15, and finite)." };
    }
    if (t === "true" || t === "false") return { ok: true, value: t === "true" };
  }
  if (t.length > 200) return { ok: false, reason: "A text value is at most 200 characters." };
  return { ok: true, value: t };
}

const sameValue = (a: unknown, b: unknown) => a === b;

/** The review status the page knows for a source file id: only what the hall's current figures cite. */
function knownSources(current: RegistryInput[]): Map<string, { kind: string; reviewStatus: string | null }> {
  const m = new Map<string, { kind: string; reviewStatus: string | null }>();
  for (const i of current) if (i.source) m.set(i.source.id, { kind: i.source.kind, reviewStatus: i.source.reviewStatus });
  return m;
}

export function buildPreview(rows: RawRow[], ctx: ImportContext): Preview {
  const allowed = allowedPaths(ctx.current);
  const currentBy = new Map(ctx.current.map((i) => [i.fieldPath, i]));
  const sources = knownSources(ctx.current);
  const firstRowOf = new Map<string, number>();
  const maxDate = addDays(ctx.today, 1);
  const plans: RowPlan[] = [];
  let newFields = 0;

  for (const raw of rows) {
    const c = raw.cells;
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (raw.error) reasons.push(raw.error);
    const srcShown = short(c.source_id, 12);
    const shown = { value: short(c.value), origin: short(c.origin, 16), evidenceClass: short(c.class, 8), source: srcShown ? `${short(c.source_kind, 10)} ${srcShown}`.trim() : "", asOf: short(c.as_of, 12) };

    // ---- field path
    const pathCell = textCell(c.field_path);
    let fieldPath = short(c.field_path, 60);
    let allowedPath: AllowedPath | undefined;
    if (!pathCell.ok) reasons.push("field_path must be text.");
    else if (!pathCell.value) reasons.push("field_path is empty.");
    else {
      const p = pathCell.value.toLowerCase();
      fieldPath = p.length > 60 ? p.slice(0, 59) + "…" : p;
      if (p.length > 120 || !FIELD_PATH_PATTERN.test(p)) reasons.push(`“${short(p, 40)}” is not a dotted path such as grid.firm_capacity_mva.`);
      else if (!(allowedPath = allowed.get(p))) reasons.push(`“${p}” is not a field this registry knows. Use one of the template's paths, or a field already recorded for this hall; this import never creates a new kind of field.`);
      else {
        const earlier = firstRowOf.get(p);
        if (earlier !== undefined) reasons.push(`This field is already in row ${earlier}. One row per field in an import; a second figure is a second import.`);
        else firstRowOf.set(p, raw.n);
      }
    }

    // ---- origin and class
    const originCell = textCell(c.origin);
    const origin = originCell.ok && originCell.value ? (originCell.value.toLowerCase() as Origin) : null;
    if (!originCell.ok || !origin) reasons.push("origin is required: say where the figure came from.");
    else if (!(ORIGINS as readonly string[]).includes(origin)) reasons.push(`origin “${short(origin, 20)}” is not one of ${ORIGINS.join(", ")}.`);
    const classCell = textCell(c.class);
    const cls = classCell.ok && classCell.value ? classCell.value.toUpperCase() : null;
    if (!classCell.ok || !cls) reasons.push("class is required: declare E0 to E7.");
    else if (!(EVIDENCE_CLASS_CODES as readonly string[]).includes(cls)) reasons.push(`class “${short(cls, 8)}” is not one of E0 to E7.`);
    const originOk = origin !== null && (ORIGINS as readonly string[]).includes(origin);
    const clsOk = cls !== null && (EVIDENCE_CLASS_CODES as readonly string[]).includes(cls);

    // ---- as of
    const asOfCell = textCell(c.as_of);
    const asOf = asOfCell.ok ? asOfCell.value : null;
    if (!asOf) reasons.push("as_of is required: the date the figure is true for, as YYYY-MM-DD.");
    else if (!realDate(asOf)) reasons.push(`as_of “${short(asOf, 16)}” is not a date written as YYYY-MM-DD.`);
    else if (asOf < "1990-01-01") reasons.push("as_of is too old to be a figure's date (1990-01-01 or later).");
    else if (asOf > maxDate) reasons.push("as_of is in the future; a figure cannot be as of a later date.");

    // ---- value and unit
    const pv = parseValue(c.value, raw.fromCsv);
    if (!pv.ok) reasons.push(pv.reason);
    const value = pv.ok ? pv.value : null;
    const unitCell = textCell(c.unit);
    const unit = unitCell.ok ? unitCell.value : null;
    if (!unitCell.ok) reasons.push("unit must be text.");
    else if (unit !== null && (unit.length > 24 || !UNIT_PATTERN.test(unit))) reasons.push(`unit “${short(unit, 24)}” is longer than 24 characters or has a character a unit cannot have.`);
    if (pv.ok && originOk) {
      if (origin === "missing") {
        if (value !== null) reasons.push("A figure recorded as missing has no value: leave value empty.");
        if (unit !== null) reasons.push("A figure recorded as missing has no unit here: leave unit empty.");
        if (clsOk && cls !== "E0") reasons.push("A missing figure is class E0.");
      } else {
        if (value === null) reasons.push("Give a value, or set origin to missing.");
        if (unit !== null && typeof value !== "number" && value !== null) reasons.push("A unit belongs only to a number; this value is read as text.");
        if (typeof value === "string" && /^(nan|-?inf(inity)?)$/i.test(value)) warnings.push("This value reads as text, not as a number.");
        if (allowedPath) {
          if (allowedPath.numeric && value !== null && typeof value !== "number") reasons.push(`${allowedPath.path} is a number${allowedPath.unit ? ` in ${allowedPath.unit}` : ""}; “${short(value, 24)}” is read as ${typeof value === "string" ? "text" : "true/false"}.`);
          if (typeof value === "number") {
            const want = allowedPath.unit;
            if (want && unit === null) reasons.push(`Give the unit: ${allowedPath.path} is recorded in ${want}. This import never assumes a unit.`);
            else if (want && unit !== null && unit !== want) reasons.push(`Unit “${unit}” is not the unit ${allowedPath.path} is recorded in (${want}). Convert the value yourself; this import does not convert.`);
            else if (!want && unit !== null) reasons.push(`${allowedPath.path} is recorded without a unit; remove “${unit}” or correct the field.`);
            if (value < 0 && allowedPath.why === "intake field") warnings.push("This value is negative; check it.");
          }
        }
      }
    }

    // ---- the source file
    const kindCell = textCell(c.source_kind);
    const idCell = textCell(c.source_id);
    const kind = kindCell.ok && kindCell.value ? kindCell.value.toLowerCase() : null;
    const sid = idCell.ok ? idCell.value : null;
    let projectEvidenceId: string | null = null;
    let intakeEvidenceFileId: string | null = null;
    let needsDatabaseCheck = false;
    if (!kindCell.ok || !idCell.ok) reasons.push("source_kind and source_id must be text.");
    else if (kind || sid) {
      if (!kind || !sid) reasons.push("Give both source_kind (project or intake) and source_id, or neither.");
      else if (kind !== "project" && kind !== "intake") reasons.push(`source_kind “${short(kind, 16)}” is not project or intake.`);
      else if (!UUID.test(sid)) reasons.push("source_id is not a file id (a UUID).");
      else {
        if (kind === "project") projectEvidenceId = sid; else intakeEvidenceFileId = sid;
        const known = sources.get(sid);
        if (known) {
          if ((kind === "project") !== (known.kind === "project_evidence")) reasons.push("This id is known to this hall as the other kind of file; check source_kind.");
          else if (kind === "project" && known.reviewStatus === "rejected") reasons.push("That file was reviewed and rejected, so it cannot be cited.");
        }
      }
    }
    const hasSource = projectEvidenceId !== null || intakeEvidenceFileId !== null;
    if (originOk) {
      if (origin === "missing" && (kind || sid)) reasons.push("A missing figure cites no source file.");
      if (ORIGINS_NEEDING_A_SOURCE.includes(origin) && !hasSource && !(kind || sid)) {
        reasons.push(`A ${origin} figure needs a source file (a project file attached to this hall, or a file of an engagement you bought): give source_kind and source_id. This import never writes a ${origin} figure without one.`);
      }
      if (clsOk && classRank(cls) > 3) {
        if (ORIGINS_CAPPED_AT_E3.includes(origin)) reasons.push(`An ${origin} figure cannot claim a class above E3; ${cls} is refused. Declare E3 or lower.`);
        else if (origin === "vendor" && !hasSource) reasons.push(`A vendor figure with no file behind it cannot claim a class above E3; ${cls} is refused.`);
        if (intakeEvidenceFileId) reasons.push(`A purchased engagement's file is not reviewable, so it supports a declared class of E3 at most; ${cls} is refused.`);
        if (projectEvidenceId) {
          const known = sources.get(projectEvidenceId);
          if (known && known.kind === "project_evidence" && known.reviewStatus !== "rejected") {
            if (known.reviewStatus !== "verified") reasons.push(`A class above E3 needs a source file that has been reviewed and verified; this file is not (status: ${known.reviewStatus ?? "none"}). Declare E3 or lower until it is.`);
          } else if (!known) {
            needsDatabaseCheck = true;
            warnings.push(`Class ${cls} relies on a project file whose review status this page cannot see. The database accepts it only if the file is verified; if it is not, the import stops at this row.`);
          }
        }
      }
    }

    // ---- what would happen
    const cur = allowedPath ? currentBy.get(allowedPath.path) : undefined;
    if (cur && asOf && realDate(asOf) && asOf < cur.asOf) warnings.push(`This figure is as of ${asOf}, earlier than the current one (${cur.asOf}).`);
    let status: RowStatus = "rejected";
    let body: WriteBody | null = null;
    let replaces: RowPlan["replaces"] = null;
    if (reasons.length === 0 && allowedPath && origin && cls && asOf) {
      body = {
        fieldPath: allowedPath.path, value, unit, evidenceClass: cls, origin, asOf, projectEvidenceId, intakeEvidenceFileId, supersedes: cur ? cur.id : null,
      };
      if (!cur) {
        newFields++;
        if (ctx.current.length + newFields > HALL_FIELD_LIMIT) { reasons.push(`A hall holds at most ${HALL_FIELD_LIMIT} different fields.`); body = null; newFields--; }
        else status = "new";
      } else {
        const sameSource = (cur.source?.id ?? null) === (projectEvidenceId ?? intakeEvidenceFileId ?? null);
        const same = sameValue(cur.value ?? null, value) && (cur.unit ?? null) === unit && cur.origin === origin && cur.evidenceClass === cls && cur.asOf === asOf && sameSource;
        status = same ? "unchanged" : "supersede";
        replaces = cur;
        if (same) body = null;
      }
    }
    if (status === "rejected") { body = null; needsDatabaseCheck = false; }
    plans.push({ n: raw.n, status, fieldPath, shown, reasons, warnings, replaces: status === "supersede" || status === "unchanged" ? replaces : null, needsDatabaseCheck, body });
  }

  const count = (s: RowStatus) => plans.filter((p) => p.status === s).length;
  return {
    rows: plans,
    counts: {
      total: plans.length, new: count("new"), supersede: count("supersede"), unchanged: count("unchanged"), rejected: count("rejected"),
      writes: count("new") + count("supersede"), needDatabaseCheck: plans.filter((p) => p.needsDatabaseCheck).length,
    },
  };
}

/** What a row would replace, in the page's own words: the value, its declared origin and class, and its file. */
export function replacesText(r: RegistryInput): string {
  return `${valueText(r)}, ${originText(r.origin)}, declared class ${r.evidenceClass}, ${sourceText(r)}, as of ${r.asOf}`;
}

/** The rows to write, in the order they are written: rows that rely on a file the page cannot check go first, so a refusal stops the import before anything else is written. */
export function writeOrder(preview: Preview): RowPlan[] {
  const writable = preview.rows.filter((r) => r.body && (r.status === "new" || r.status === "supersede"));
  return [...writable.filter((r) => r.needsDatabaseCheck), ...writable.filter((r) => !r.needsDatabaseCheck)];
}

// --------------------------------------------------------------------------------------------------------------- the run

export type PostResult = { status: number; body: any; retryAfter?: number | null };

export interface RunDeps {
  /** One POST of one figure to /api/halls/:id/inputs. A thrown error means the request did not complete. */
  post: (body: WriteBody) => Promise<PostResult>;
  sleep: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  onProgress?: (p: { done: number; total: number; current: number | null; waitingSeconds: number | null }) => void;
  /** Pause between two writes, in ms. */
  gapMs?: number;
}

export interface WrittenRow { n: number; fieldPath: string; id: string; input: RegistryInput | null }
export interface FailedRow { n: number; fieldPath: string; status: number | null; message: string; outcomeUnknown: boolean }
export interface ImportReport {
  outcome: "complete" | "stopped" | "cancelled";
  written: WrittenRow[];
  failed: FailedRow | null;
  notAttempted: { n: number; fieldPath: string }[];
}

function failureText(status: number, body: any): string {
  const base = typeof body?.error === "string" && body.error ? body.error : "That did not work.";
  const issue = Array.isArray(body?.issues) && body.issues[0] ? ` ${body.issues[0].field}: ${body.issues[0].message}` : "";
  if (status === 409 && (body?.reason === "superseded" || body?.reason === "field_already_recorded")) {
    return `${base} Someone recorded this field after the preview was made. Reload the hall and preview again.`;
  }
  if (status === 401) return "Your sign-in ended. Sign in again, then preview and import again.";
  return base + issue;
}

/**
 * Write the rows ONE AT A TIME, in order. A 429 (the allowance) is waited out when the wait is short (the same row is retried, at most three times) and
 * otherwise ends the run; any other refusal, and any request that did not complete, ENDS THE RUN at once. The report lists exactly which rows were written,
 * which one failed and why, and which were never tried: there is no half-silent state, and no row after a failure is attempted.
 */
export async function runImport(rows: RowPlan[], deps: RunDeps): Promise<ImportReport> {
  const written: WrittenRow[] = [];
  const total = rows.length;
  const rest = (from: number) => rows.slice(from).map((r) => ({ n: r.n, fieldPath: r.fieldPath }));
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k]!;
    if (deps.isCancelled?.()) return { outcome: "cancelled", written, failed: null, notAttempted: rest(k) };
    if (k > 0 && deps.gapMs) await deps.sleep(deps.gapMs);
    deps.onProgress?.({ done: written.length, total, current: row.n, waitingSeconds: null });
    let attempts = 0;
    for (;;) {
      let res: PostResult;
      try {
        res = await deps.post(row.body!);
      } catch {
        return {
          outcome: "stopped", written, notAttempted: rest(k + 1),
          failed: { n: row.n, fieldPath: row.fieldPath, status: null, outcomeUnknown: true, message: "The request did not complete, so it is not known whether this row was written. Reload the hall and check before you import again." },
        };
      }
      if (res.status === 201 && res.body?.ok) {
        written.push({ n: row.n, fieldPath: row.fieldPath, id: String(res.body.id ?? ""), input: (res.body.input as RegistryInput | undefined) ?? null });
        break;
      }
      if (res.status === 429) {
        const wait = Math.max(1, Math.ceil(Number(res.retryAfter ?? res.body?.retry_after_seconds ?? 60)));
        attempts++;
        if (wait <= MAX_AUTO_WAIT_SECONDS && attempts <= MAX_429_RETRIES_PER_ROW) {
          deps.onProgress?.({ done: written.length, total, current: row.n, waitingSeconds: wait });
          await deps.sleep(wait * 1000 + 500);
          if (deps.isCancelled?.()) return { outcome: "cancelled", written, failed: null, notAttempted: rest(k) };
          continue;
        }
        const mins = Math.ceil(wait / 60);
        return {
          outcome: "stopped", written, notAttempted: rest(k + 1),
          failed: { n: row.n, fieldPath: row.fieldPath, status: 429, outcomeUnknown: false, message: `The registry's allowance for writes is used up (${WRITES_PER_HOUR} an hour for your account). Try again in about ${mins} minute${mins === 1 ? "" : "s"}; this row was not written. Rows already written will show as unchanged in the next preview.` },
        };
      }
      return {
        outcome: "stopped", written, notAttempted: rest(k + 1),
        failed: { n: row.n, fieldPath: row.fieldPath, status: res.status, outcomeUnknown: false, message: failureText(res.status, res.body) },
      };
    }
  }
  deps.onProgress?.({ done: written.length, total, current: null, waitingSeconds: null });
  return { outcome: "complete", written, failed: null, notAttempted: [] };
}

// --------------------------------------------------------------------------------------------------------------- the template

const TEMPLATE_NOTES = [
  "GridForge hall figures: import template. Generated from the registry's list of fields; it holds no real data.",
  "One row per field. Every row is previewed and nothing is written until you confirm.",
  "origin: measured, observed, quotation (these three need source_kind and source_id), vendor, modelled, assumed or missing.",
  "class: E0 to E7, declared by you. assumed and modelled cannot claim above E3; a purchased engagement's file supports E3 at most.",
  "source_kind: project (a file of a project attached to this hall) or intake (a file of an engagement you bought); source_id is that file's id.",
  "as_of: the date the figure is true for, YYYY-MM-DD. unit: keep the one shown. A missing figure has no value, no unit, no source and class E0.",
];

export function importTemplateCsv(): string {
  const rows: unknown[][] = TEMPLATE_NOTES.map((t) => [`# ${t}`]);
  rows.push([...IMPORT_COLUMNS]);
  for (const f of EXPECTED_HALL_FIELDS) rows.push([f.path, "", f.unit, "", "", "", "", ""]);
  return toCsv(rows);
}

export function importTemplateJson(): string {
  const rows = EXPECTED_HALL_FIELDS.map((f) => ({ field_path: f.path, value: null, unit: f.unit || null, origin: "", class: "", as_of: "", source_kind: "", source_id: "" }));
  return JSON.stringify({ comment: TEMPLATE_NOTES.join(" "), rows }, null, 2) + "\n";
}
