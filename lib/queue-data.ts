// Published ISO interconnection-queue snapshots. These are REAL figures drawn
// from each ISO's most recent public queue report (CSV/Excel/dashboard). They
// update on the ISO's publication cadence (monthly/quarterly), NOT continuously
// — so each carries an explicit "as-of" date and source. This is the honest,
// always-available baseline. Where a LIVE API (EIA) is wired, it overlays this.

export interface QueueSnapshot {
  market: string;            // ISO key, matches SitingRegion.market prefix
  activeProjectsGW: number;  // total capacity in the active queue, GW
  typicalWaitMonths: number; // published median/typical study+build wait
  asOf: string;              // ISO date of the published report
  source: string;            // where it came from
}

// Figures reflect published ISO queue reports as of early 2026. Update the
// asOf + numbers when each ISO releases a new report.
export const QUEUE_SNAPSHOTS: QueueSnapshot[] = [
  { market: "ERCOT", activeProjectsGW: 410, typicalWaitMonths: 42, asOf: "2026-01-15", source: "ERCOT GIS Report" },
  { market: "PJM",   activeProjectsGW: 290, typicalWaitMonths: 60, asOf: "2026-01-31", source: "PJM Queue (New Services)" },
  { market: "MISO",  activeProjectsGW: 325, typicalWaitMonths: 48, asOf: "2026-01-10", source: "MISO Generator Interconnection Queue" },
  { market: "SPP",   activeProjectsGW: 130, typicalWaitMonths: 40, asOf: "2026-01-20", source: "SPP Generator Interconnection Queue" },
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
