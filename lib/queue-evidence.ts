// MEASURED interconnection-queue evidence, replacing hand-typed "typical wait" figures.
//
// Source: Lawrence Berkeley National Laboratory, "Queued Up" 2026 edition (data through end of 2025), licence CC BY 4.0.
// `lib/queue-evidence.json` is a copy of the gridforge-stress harness fixture `lbnl_ir_to_cod_context.json`, which was computed
// in a CI run from the published workbook (sha256 in the file) and carries its own limits. This module only reads it.
//
// What the numbers ARE: years from interconnection request to in-service for US GENERATION and STORAGE requests that reached
// commercial operation. What they are NOT: a time-to-power for a LOAD, a data-centre connection time, or a promise for any
// site. Survivorship matters more than the median: most requests never complete (see `completionShare`).
import raw from "@/lib/queue-evidence.json";

export const QUEUE_EVIDENCE_SOURCE = {
  name: "LBNL Queued Up, 2026 edition",
  licence: "CC BY 4.0",
  attribution: "Lawrence Berkeley National Laboratory, Queued Up: 2026 Edition (data through 2025), CC BY 4.0",
  context: "cod_2018_2025",
  contextLabel: "projects that reached operation 2018-2025",
  measuredOn: raw.provenance.measured_on,
  workbookSha256: raw.provenance.workbook_sha256,
  definition: raw.definition,
} as const;

export interface MeasuredWait {
  region: string;
  n: number;
  p25Months: number;
  medianMonths: number;
  p75Months: number;
}

type Spread = { n: number; p25: number; median: number; p75: number };

const MONTHS_PER_YEAR = 12;

function toMonths(region: string, s: Spread): MeasuredWait {
  return {
    region,
    n: s.n,
    p25Months: Math.round(s.p25 * MONTHS_PER_YEAR),
    medianMonths: Math.round(s.median * MONTHS_PER_YEAR),
    p75Months: Math.round(s.p75 * MONTHS_PER_YEAR),
  };
}

const BY_REGION = raw.by_region_cod_2018_2025 as Record<string, Spread>;

/** LBNL's own regional grouping for a market key (for example "ERCOT", "PJM"), or undefined when there is no measurement. */
export function measuredWait(market: string): MeasuredWait | undefined {
  const s = Object.prototype.hasOwnProperty.call(BY_REGION, market) ? BY_REGION[market] : undefined;
  return s ? toMonths(market, s) : undefined;
}

export function allMeasuredWaits(): MeasuredWait[] {
  return Object.keys(BY_REGION).sort().map((k) => toMonths(k, BY_REGION[k]));
}

export interface CompletionShare {
  fromYear: number;
  toYear: number;
  entered: number;
  operational: number;
  withdrawn: number;
  unresolved: number;
  /** operational / entered, in [0, 1] */
  operationalShare: number;
  /** withdrawn / entered, in [0, 1] */
  withdrawnShare: number;
}

type Cohort = { entered: number; operational: number; withdrawn: number; active: number; suspended: number; unknown: number };

/** Outcome of every request that entered a queue in the mature cohort years the evidence names (older cohorts are mostly resolved;
 *  newer ones are still pending and would understate completion). */
export function completionShare(): CompletionShare {
  const [fromYear, toYear] = raw.survivorship.mature_cohort_years as [number, number];
  const cohorts = raw.survivorship.cohorts_by_entry_year as Record<string, Cohort>;
  let entered = 0;
  let operational = 0;
  let withdrawn = 0;
  for (let y = fromYear; y <= toYear; y += 1) {
    const c = cohorts[String(y)];
    entered += c.entered;
    operational += c.operational;
    withdrawn += c.withdrawn;
  }
  return {
    fromYear,
    toYear,
    entered,
    operational,
    withdrawn,
    unresolved: entered - operational - withdrawn,
    operationalShare: operational / entered,
    withdrawnShare: withdrawn / entered,
  };
}

/** One sentence a buyer can read: what the queue figure measures and what it leaves out. */
export function measuredWaitCaption(w: MeasuredWait): string {
  const c = completionShare();
  const pct = Math.round(c.operationalShare * 100);
  return (
    `Median ${w.medianMonths} months (middle half ${w.p25Months}-${w.p75Months}) from request to operation across ${w.n} ` +
    `completed ${w.region} generation and storage projects, ${QUEUE_EVIDENCE_SOURCE.name}. Only ${pct}% of requests that entered ` +
    `a queue in ${c.fromYear}-${c.toYear} reached operation, so this is the wait for the projects that made it, not for a load connection.`
  );
}
