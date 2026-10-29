// Interconnection-queue snapshots shown on the Observatory and returned by /api/queue.
//
// The four US rows are MEASURED, from LBNL's Queued Up 2026 edition (data through 2025, CC BY 4.0):
//   - activeProjectsGW is the publisher's own printed figure for ACTIVE requests at the end of 2025
//     (lib/queue-active-capacity.json, sheet "02. Data Sample by Region");
//   - typicalWaitMonths is the MEDIAN request-to-operation time of generation and storage projects that reached operation
//     (lib/queue-evidence.json), so it describes the projects that made it, not a load connection. Most requests never complete.
// Neither is a time-to-power for a data centre. The field name `typicalWaitMonths` is kept for API compatibility.
//
// The two non-US rows are hand-set estimates labelled "(modeled)" in their source; they are left out of the Observatory table
// (see publishedSnapshots) and nothing here presents them as a report.
import capacity from "@/lib/queue-active-capacity.json";
import { measuredWait } from "@/lib/queue-evidence";

export interface QueueSnapshot {
  market: string;            // ISO key, matches SitingRegion.market prefix
  activeProjectsGW: number;  // capacity of active requests, GW
  typicalWaitMonths: number; // median months from request to operation, for projects that reached operation
  asOf: string;              // ISO date the figures describe
  source: string;            // where it came from
}

export const QUEUE_ACTIVE_CAPACITY_SOURCE = {
  attribution: capacity.source,
  sheet: capacity.sheet,
  asOf: capacity.as_of,
  workbookSha256: capacity.provenance.workbook_sha256,
} as const;

const LBNL_SOURCE = "LBNL Queued Up 2026 (data through 2025, CC BY 4.0)";

/** A measured US row, or undefined when either measurement is missing (nothing is invented to fill the gap). */
export function lbnlSnapshot(market: string): QueueSnapshot | undefined {
  const cap = Object.prototype.hasOwnProperty.call(capacity.active, market)
    ? (capacity.active as Record<string, { gw: number }>)[market]
    : undefined;
  const wait = measuredWait(market);
  if (!cap || !wait) return undefined;
  return { market, activeProjectsGW: cap.gw, typicalWaitMonths: wait.medianMonths, asOf: capacity.as_of, source: LBNL_SOURCE };
}

const MEASURED_MARKETS = ["ERCOT", "PJM", "MISO", "SPP"] as const;

export const QUEUE_SNAPSHOTS: QueueSnapshot[] = [
  ...MEASURED_MARKETS.flatMap((m) => {
    const row = lbnlSnapshot(m);
    return row ? [row] : [];
  }),
  { market: "EPEX (DE-LU)", activeProjectsGW: 0, typicalWaitMonths: 54, asOf: "2026-01-01", source: "ENTSO-E / BNetzA (modeled)" },
  { market: "Nord Pool", activeProjectsGW: 0, typicalWaitMonths: 36, asOf: "2026-01-01", source: "TSO published queues (modeled)" },
];

export function snapshotFor(market: string): QueueSnapshot | undefined {
  return QUEUE_SNAPSHOTS.find((q) => q.market === market);
}

// Format an "as-of" date compactly, e.g. "Jan 2026".
export function asOfLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "n/a";
  return d.toLocaleDateString("en-IE", { month: "short", year: "numeric" });
}
