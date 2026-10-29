// What completed US interconnection requests actually took, shown beside the comparison's refusal to date grid reinforcement.
//
// CONTEXT ONLY, and the panel says so in its own words: the figures describe generation and storage requests that reached operation (most
// requests never do), they are not a connection time for this site, and they change no date or evidence class in the result above. The
// numbers are the engine's `grid_queue_context`, which the independent gridforge-stress harness re-measures against LBNL's published workbook.
import type { GridQueueContext } from "@/lib/ttp-compare";

const YEARS_TO_MONTHS = 12;
const months = (years: number): number => Math.round(years * YEARS_TO_MONTHS);

const APPLICABILITY: Record<GridQueueContext["applicability"]["level"], string> = {
  same_country_context: "This site is in the same country as the observed data.",
  scale_reference_only: "This site is not in the observed data's country, or none is declared, so treat this as a scale reference only.",
};

export function GridQueuePanel({ ctx }: { ctx: GridQueueContext | undefined }) {
  if (!ctx) return null;
  const o = ctx.observed;
  const s = ctx.survivorship;
  return (
    <aside aria-label="How long the grid has taken, as observed" className="panel p-5" data-testid="grid-queue-panel">
      <h3 className="text-sm font-semibold text-ghost">How long the grid has actually taken (context, not this site&apos;s date)</h3>
      <p className="mt-2 text-sm text-ghost">
        US generation and storage requests that reached operation took a median of <strong className="data">{months(o.median_years)} months</strong>{" "}
        from request to operation (middle half {months(o.p25_years)}–{months(o.p75_years)} months), across <span className="data">{o.n}</span>{" "}
        completed projects ({o.name}).
      </p>
      {s ? (
        <p className="mt-2 text-sm text-queue">
          Only <strong className="data">{Math.round(s.share_operational_of_entered * 100)}%</strong> of the {s.entered} requests that entered a queue in{" "}
          {s.entry_years[0]}–{s.entry_years[1]} reached operation; {s.withdrawn} were withdrawn. The figures above describe only the ones that made it.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-mute">{APPLICABILITY[ctx.applicability.level]} It is not a connection time for a load or a data centre, says nothing about this site&apos;s network operator, and changes no date, figure or evidence class in the result above.</p>
      <p className="mt-2 text-[11px] text-faint">
        Source: {ctx.source.name}, {ctx.source.licence}. Computed independently by the gridforge-stress harness from the published workbook (sha256 {ctx.source.workbook_sha256.slice(0, 12)}…).
      </p>
    </aside>
  );
}
