// Export of a hall's record for a compliance binder: its current figures and its timeline, as JSON or CSV. Built in the browser from what the
// registry's read routes already return (GET /api/halls/:id/inputs and /timeline); no new route, so the same sign-in, membership check, allowance and
// uniform 404 as every other read apply to the data before it gets here.
//
// WHAT A FILE CARRIES. Per figure: the field path, value, unit, the DECLARED origin and class, the source file's name and its LIVE review status,
// who recorded it and when, and the figure it replaces. The file says so itself, first: origin and class are the recorder's declaration and
// nothing in the file verifies them. A file's review status is the status at the moment of export, not at the moment the figure was recorded.
// WHAT IT NEVER CARRIES: a storage location, a file digest, a project link token (the read API never returns them, and the shapes below are built field
// by field, never spread from the input, so a field the API did not mean to send cannot ride along).

import { toCsv } from "@/lib/site-registry-csv";
import type { RegistryApi, RegistryEvent, RegistryInput } from "@/lib/site-registry-model";

export const EXPORT_FORMAT = "gridforge-hall-record/1";

export const DECLARATION =
  "Origin and evidence class are the declaration of the person who recorded each figure. Nothing in this file verifies them against the real hall. " +
  "A source file's review status is its status at the time of export, not at the time the figure was recorded.";

export const PRIVACY_NOTE = "This file names the people who recorded figures (their email addresses). Keep it where you keep other personal data.";

export type ExportHall = { id: string; label: string; siteName: string; dataOrigin: string; country: string | null };

export interface HallExport {
  format: typeof EXPORT_FORMAT;
  declaration: string;
  privacy: string;
  exportedAt: string;
  hall: ExportHall;
  /** Whether the timeline below is the whole timeline. false: the pages cap was reached or a page could not be read, and `timelineNote` says which. */
  timelineComplete: boolean;
  timelineNote: string | null;
  currentInputs: ExportInput[];
  /** Oldest first. */
  timeline: ExportEvent[];
}

export interface ExportInput {
  fieldPath: string; value: number | string | boolean | null; unit: string | null; declaredOrigin: string; declaredClass: string; asOf: string;
  sourceFileName: string | null; sourceKind: string | null; sourceId: string | null; sourceReviewStatusNow: string | null;
  recordedBy: string; recordedAt: string | null; supersedesId: string | null; id: string;
}

export interface ExportEvent {
  occurredAt: string; kind: string; subject: string | null; summary: string; origin: string; declaredClass: string | null; basis: string; actor: string | null;
  replacedByLaterFigure: boolean; sourceTable: string | null; sourceId: string | null; projectId: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function exportInput(i: RegistryInput): ExportInput {
  return {
    fieldPath: i.fieldPath, value: i.value ?? null, unit: i.unit ?? null, declaredOrigin: i.origin, declaredClass: i.evidenceClass, asOf: i.asOf,
    sourceFileName: i.source?.filename ?? null, sourceKind: i.source?.kind ?? null, sourceId: i.source?.id ?? null, sourceReviewStatusNow: i.source?.reviewStatus ?? null,
    recordedBy: i.recordedBy, recordedAt: str(i.recordedAt), supersedesId: str(i.supersedesId), id: i.id,
  };
}

export function exportEvent(e: RegistryEvent): ExportEvent {
  return {
    occurredAt: e.occurredAt, kind: e.kind, subject: str(e.subject), summary: e.summary, origin: e.origin, declaredClass: e.evidenceClass ?? null, basis: e.basis,
    actor: str(e.actor), replacedByLaterFigure: Boolean(e.superseded), sourceTable: str(e.sourceTable), sourceId: str(e.sourceId), projectId: str(e.projectId),
  };
}

/** Oldest first, ties kept in the order the server gave them reversed (the server's order is newest first, so the reversal is the chronological order). */
export const chronological = (events: RegistryEvent[]): RegistryEvent[] => [...events].reverse();

export function buildExport(args: {
  hall: ExportHall; inputs: RegistryInput[]; eventsNewestFirst: RegistryEvent[]; timelineComplete: boolean; timelineNote?: string | null; exportedAt: string;
}): HallExport {
  return {
    format: EXPORT_FORMAT, declaration: DECLARATION, privacy: PRIVACY_NOTE, exportedAt: args.exportedAt, hall: args.hall,
    timelineComplete: args.timelineComplete, timelineNote: args.timelineComplete ? null : args.timelineNote ?? "The timeline is incomplete.",
    currentInputs: [...args.inputs].sort((a, b) => a.fieldPath.localeCompare(b.fieldPath)).map(exportInput),
    timeline: chronological(args.eventsNewestFirst).map(exportEvent),
  };
}

export const exportJson = (x: HallExport): string => JSON.stringify(x, null, 2) + "\n";

const INPUT_COLUMNS = [
  "field_path", "value", "unit", "declared_origin", "declared_class", "as_of", "source_file_name", "source_kind", "source_id", "source_review_status_now",
  "recorded_by", "recorded_at", "supersedes_id", "id",
] as const;

const EVENT_COLUMNS = [
  "occurred_at", "kind", "subject", "summary", "origin", "declared_class", "basis", "actor", "replaced_by_later_figure", "source_table", "source_id", "project_id",
] as const;

/** Comment rows first (a line that starts with # is a comment to this registry's importer and to most tools), then the header, then one row per figure. */
function preamble(x: HallExport, what: string): string[][] {
  const lines = [
    `# GridForge hall record: ${what}. Exported ${x.exportedAt}.`,
    `# Hall: ${x.hall.label} at ${x.hall.siteName} (${x.hall.dataOrigin} data).`,
    `# ${x.declaration}`,
    `# ${x.privacy}`,
  ];
  if (!x.timelineComplete) lines.push(`# INCOMPLETE: ${x.timelineNote ?? "the timeline is not complete"}`);
  return lines.map((l) => [l.replace(/[\r\n]+/g, " ")]);
}

export function inputsCsv(x: HallExport): string {
  const rows: unknown[][] = [...preamble(x, "current figures")];
  rows.push([...INPUT_COLUMNS]);
  for (const i of x.currentInputs) {
    rows.push([i.fieldPath, i.value, i.unit, i.declaredOrigin, i.declaredClass, i.asOf, i.sourceFileName, i.sourceKind, i.sourceId, i.sourceReviewStatusNow, i.recordedBy, i.recordedAt, i.supersedesId, i.id]);
  }
  return toCsv(rows);
}

export function timelineCsv(x: HallExport): string {
  const rows: unknown[][] = [...preamble(x, "timeline, oldest first")];
  rows.push([...EVENT_COLUMNS]);
  for (const e of x.timeline) {
    rows.push([e.occurredAt, e.kind, e.subject, e.summary, e.origin, e.declaredClass, e.basis, e.actor, e.replacedByLaterFigure ? "true" : "false", e.sourceTable, e.sourceId, e.projectId]);
  }
  return toCsv(rows);
}

/** A file name from a hall label: letters, digits and hyphens only, never empty, never a path. */
export function exportFileName(hallLabel: string, kind: "record" | "figures" | "timeline", ext: "json" | "csv", exportedAt: string): string {
  const slug = hallLabel.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "hall";
  return `gridforge-${slug}-${kind}-${exportedAt.slice(0, 10)}.${ext}`;
}

// ------------------------------------------------------------------------------------------------- reading the whole timeline

/** The timeline's page size and the most pages one export reads (so an export always ends: 20 pages of 500 is 10,000 events). */
export const TIMELINE_PAGE = 500;
export const TIMELINE_MAX_PAGES = 20;

export type TimelineRead = { events: RegistryEvent[]; complete: boolean; note: string | null; error: string | null };

/** Every page of the timeline, newest first, following the cursor the server gave back verbatim. Stops at the page cap or at the first page that cannot be read. */
export async function readWholeTimeline(api: RegistryApi, hallId: string, maxPages = TIMELINE_MAX_PAGES, pageSize = TIMELINE_PAGE): Promise<TimelineRead> {
  const events: RegistryEvent[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= maxPages; page++) {
    let r: Awaited<ReturnType<RegistryApi>>;
    try {
      r = await api(`/api/halls/${hallId}/timeline?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    } catch {
      return { events, complete: false, note: `Page ${page} of the timeline could not be reached; ${events.length} events were read.`, error: "Could not reach the server." };
    }
    if (!r.body?.ok || !Array.isArray(r.body.events)) {
      const why = typeof r.body?.error === "string" ? r.body.error : "That did not work.";
      return { events, complete: false, note: `Page ${page} of the timeline could not be read (${why}); ${events.length} events were read.`, error: why };
    }
    events.push(...(r.body.events as RegistryEvent[]));
    if (!r.body.truncated || typeof r.body.nextCursor !== "string") return { events, complete: true, note: null, error: null };
    cursor = r.body.nextCursor;
  }
  return { events, complete: false, note: `Only the newest ${events.length} events were read (the export reads at most ${maxPages} pages).`, error: null };
}
