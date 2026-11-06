// The evidence-upload contract, in a leaf module the browser can import.
//
// The server (lib/projects.ts attachEvidence, app/api/projects/[token]/evidence) is the authority: every limit below is
// re-checked there, and a file is stored `unverified` with no evidence class whatever the client sends. These constants are
// defined ONCE, here; lib/projects.ts imports and re-exports them, and the upload control reads the same values for its hints
// and its pre-checks, so the screen cannot promise a limit the route does not enforce.

export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
/** Per project: how many files and how many bytes in all. A project's inventory is a record, not a file share. */
export const EVIDENCE_MAX_FILES = 100;
export const EVIDENCE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const EVIDENCE_MEDIA_TYPES = ["application/pdf", "text/csv", "application/json"] as const;
export const EVIDENCE_CATEGORIES = [
  "utility_correspondence",
  "supplier_document",
  "load_data",
  "site_documentation",
  "other",
] as const;
export const EVIDENCE_NOTE_MAX = 500;

export const EVIDENCE_CATEGORY_LABEL: Record<(typeof EVIDENCE_CATEGORIES)[number], string> = {
  utility_correspondence: "Utility correspondence",
  supplier_document: "Supplier document",
  load_data: "Load data",
  site_documentation: "Site documentation",
  other: "Other",
};

const BY_EXTENSION: Record<string, (typeof EVIDENCE_MEDIA_TYPES)[number]> = {
  pdf: "application/pdf",
  csv: "text/csv",
  json: "application/json",
};

/** The file extensions the picker offers, derived from the accepted media types (not a second list). */
export const EVIDENCE_ACCEPT = [...Object.keys(BY_EXTENSION).map((e) => `.${e}`), ...EVIDENCE_MEDIA_TYPES].join(",");

/**
 * The media type to declare. Browsers report CSV as "application/vnd.ms-excel" or "" and JSON as "" on some systems, so a
 * declared type outside the list falls back to the file extension. Anything else stays undecided (null): the control refuses it
 * before sending, and the route would refuse it too.
 */
export function evidenceMediaType(file: { name: string; type: string }): (typeof EVIDENCE_MEDIA_TYPES)[number] | null {
  const declared = file.type.split(";")[0].trim().toLowerCase();
  if ((EVIDENCE_MEDIA_TYPES as readonly string[]).includes(declared)) return declared as (typeof EVIDENCE_MEDIA_TYPES)[number];
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.name.includes(".") ? BY_EXTENSION[ext] ?? null : null;
}

export const bytesLabel = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A refusal the control can give before any request, in the route's own words where the route has them. */
export function checkEvidenceFile(file: { name: string; size: number; type: string }): string | null {
  if (file.size === 0) return "The file is empty.";
  if (file.size > EVIDENCE_MAX_BYTES) return `The file is larger than the ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB limit.`;
  if (!evidenceMediaType(file)) return `Unsupported file type. Accepted: PDF, CSV or JSON.`;
  return null;
}

/**
 * The one request the control makes. The body is the file; the only things the caller can say are its name, a category from
 * the fixed list and a short note. There is deliberately no field for a review status or an evidence class: the route stores
 * every upload `unverified` and unclassified, and only a human review (an administrator) can change that.
 */
export function buildEvidenceRequest(
  projectToken: string,
  file: { name: string; type: string },
  input: { category: string; note: string }
): { url: string; headers: Record<string, string> } | { error: string } {
  const mediaType = evidenceMediaType(file);
  if (!mediaType) return { error: "Unsupported file type. Accepted: PDF, CSV or JSON." };
  const category = (EVIDENCE_CATEGORIES as readonly string[]).includes(input.category) ? input.category : "other";
  const q = new URLSearchParams({ filename: file.name, source_category: category });
  const note = input.note.trim().slice(0, EVIDENCE_NOTE_MAX);
  if (note) q.set("note", note);
  return { url: `/api/projects/${encodeURIComponent(projectToken)}/evidence?${q.toString()}`, headers: { "Content-Type": mediaType } };
}
