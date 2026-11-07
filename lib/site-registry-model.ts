// The shapes the registry's read API returns (lib/sites.ts InputView / TimelineEventView) as the page and the import, export and diff helpers see them,
// and the words that describe them. Plain data and pure functions: no server imports, the browser bundle may import it.
//
// The words live here, once, so the figures table, the history, the export and the diff cannot describe the same figure in different terms.

import type { Origin } from "@/lib/site-registry-fields";

export type RegistrySource = { kind: string; id: string; filename: string | null; reviewStatus: string | null };

export type RegistryInput = {
  id: string; fieldPath: string; value: number | string | boolean | null; unit: string | null; evidenceClass: string; origin: Origin; asOf: string; recordedBy: string;
  superseded?: boolean; recordedAt?: string; supersedesId?: string | null;
  source: RegistrySource | null;
};

export type RegistryEvent = {
  occurredAt: string; kind: string; summary: string; origin: string; evidenceClass: string | null; basis: string; superseded: boolean; projectId?: string | null;
  sourceTable?: string; sourceId?: string; subject?: string; actor?: string;
};

/** The page's one door to the registry's routes (it adds the bearer token). Injected so the helpers run, and are tested, without a browser. */
export type RegistryApi = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any; retryAfter?: number | null }>;

export function valueText(i: Pick<RegistryInput, "origin" | "value" | "unit">): string {
  if (i.origin === "missing" || i.value === null) return "missing";
  return `${String(i.value)}${i.unit ? " " + i.unit : ""}`;
}

/** What the origin cell says: a figure's origin is the recorder's declaration, so it reads "declared measured", not "measured". */
export function originText(o: Origin): string {
  return o === "missing" ? "missing" : `declared ${o}`;
}

export function sourceText(i: Pick<RegistryInput, "origin" | "source">): string {
  if (!i.source) return i.origin === "missing" ? "none (missing)" : "no file cited";
  const name = i.source.filename ?? "a file";
  // A purchased engagement's file has no review step at all; a project file has a live review status.
  if (i.source.kind === "intake_evidence") return `${name} (file not reviewable)`;
  const review = i.source.reviewStatus === "verified" ? "file reviewed and verified" : i.source.reviewStatus === "rejected" ? "file rejected" : "file not yet reviewed";
  return `${name} (${review})`;
}

/** The numeric rank of a class code ("E5" -> 5); NaN for anything else. */
export const classRank = (c: string | null | undefined): number => (typeof c === "string" && /^E[0-7]$/.test(c) ? Number(c.slice(1)) : Number.NaN);
