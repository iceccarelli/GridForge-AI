// The Intelligence signal: a MODELLED ranking of regions by time to energize, with the one MEASURED input (the US queue waits) tagged
// as such on every row. Pure and presentational (no hooks, no network), so the subscriber page and the tests render the same thing.
//
// What this table is not: it is not live (nothing in it is fetched), it is not a verified-site portfolio, a queue wait is not a
// load-connection time, and the BTM months are an assumption. The live market context (price, generation mix) is a separate,
// separately labelled block with its own source and time (components/IntelligenceContext.tsx); it is never written into a row here.
import { QUEUE_EVIDENCE_SOURCE } from "@/lib/queue-evidence";
import { SCORE_WEIGHTS, SITING_DATASET, SITING_REGIONS, queueBasisNote, sitingScore, type SitingRegion } from "@/lib/siting";

const fmt = (n: number, suffix = "") => n.toLocaleString("en-IE", { maximumFractionDigits: 1 }) + suffix;
const pct = (w: number) => `${Math.round(w * 100)}%`;

export function rankRegions(regions: SitingRegion[] = SITING_REGIONS): (SitingRegion & { score: number })[] {
  return regions.map((r) => ({ ...r, score: sitingScore(r) })).sort((a, b) => b.score - a.score);
}

function Badge({ children, tone }: { children: string; tone: "measured" | "modeled" }) {
  return (
    <span className={`data text-[9px] uppercase px-1.5 py-0.5 rounded ${tone === "measured" ? "bg-power/15 text-power" : "bg-white/5 text-faint"}`}>{children}</span>
  );
}

export function IntelligenceSignalTable({ regions = SITING_REGIONS }: { regions?: SitingRegion[] }) {
  const ranked = rankRegions(regions);
  const firstMeasured = ranked.find((r) => r.queueBasis === "measured");
  return (
    <section aria-labelledby="signal-h" data-signal="modelled">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 id="signal-h" className="text-lg font-semibold tracking-tight">Fastest-to-energize ranking</h2>
        <span className="data text-xs text-queue border border-queue/40 rounded px-2 py-0.5">MODELLED</span>
      </div>
      <div className="rounded-[var(--radius)] border border-line bg-panel overflow-x-auto" role="region" aria-label="Modelled ranking of regions" tabIndex={0}>
        <table className="w-full text-sm">
          <caption className="sr-only">
            Regions ranked by a modelled time-to-energize score. Every figure is modelled except the US queue waits, which are measured medians for completed generation and storage projects.
          </caption>
          <thead>
            <tr className="data text-[10px] text-faint uppercase border-b border-line">
              <th scope="col" className="text-left font-medium px-4 py-3">Market / Region</th>
              <th scope="col" className="text-right font-medium px-3 py-3">Score</th>
              <th scope="col" className="text-right font-medium px-3 py-3">Power cost, €/MWh</th>
              <th scope="col" className="text-right font-medium px-3 py-3">Queue wait</th>
              <th scope="col" className="text-right font-medium px-3 py-3">BTM time</th>
              <th scope="col" className="text-right font-medium px-3 py-3">Renewables</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => (
              <tr key={r.id} className={`border-b border-line/50 ${i === 0 ? "bg-power/[0.04]" : ""}`}>
                <th scope="row" className="text-left font-normal px-4 py-3">
                  <div className="font-medium text-white">{r.region}</div>
                  <div className="data text-[10px] text-faint">{r.market} · {r.country}</div>
                </th>
                <td className="text-right px-3 py-3"><span className={`font-semibold ${i === 0 ? "text-power" : "text-white"}`}>{r.score}</span></td>
                <td className="text-right px-3 py-3"><div className="text-white">{fmt(r.powerCost)}</div><Badge tone="modeled">modeled</Badge></td>
                <td className="text-right px-3 py-3" data-queue-basis={r.queueBasis ?? "modeled"}>
                  <div className="text-queue">{r.queueWaitMonths} months</div>
                  {r.queueBasis === "measured" && r.queueMeasured ? (
                    <>
                      <Badge tone="measured">measured</Badge>
                      <div className="data text-[10px] text-faint mt-0.5">
                        {r.queueMeasured.n} completed · middle half {r.queueMeasured.p25Months}-{r.queueMeasured.p75Months}
                      </div>
                    </>
                  ) : (
                    <Badge tone="modeled">hand-set estimate</Badge>
                  )}
                </td>
                <td className="text-right px-3 py-3"><div className="text-power">{r.btmMonths} months</div><Badge tone="modeled">assumed</Badge></td>
                <td className="text-right px-3 py-3"><div className="text-white">{fmt(r.renewablePct, "%")}</div><Badge tone="modeled">modeled</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="data text-[10px] text-faint mt-2 space-y-1">
        <p>
          Score = {pct(SCORE_WEIGHTS.speed)} speed to power (from the assumed BTM months) + {pct(SCORE_WEIGHTS.cost)} low power cost + {pct(SCORE_WEIGHTS.queue)} low queue congestion. {SITING_DATASET.label} No as-of date applies to the hand-set figures.
        </p>
        <p>
          Queue wait: for the markets marked measured it is the median time from request to operation of generation and storage projects that reached operation, not a load-connection time; most requests never do. For the others it is a hand-set estimate.
          {firstMeasured ? ` Example basis: ${queueBasisNote(firstMeasured)}` : ""}
        </p>
        <p>
          Queue evidence: {QUEUE_EVIDENCE_SOURCE.attribution}, measured {QUEUE_EVIDENCE_SOURCE.measuredOn}. BTM time is an assumed time-to-energized, not a delivered result. This is a modelled ranking, not a verified-site portfolio.
        </p>
      </div>
    </section>
  );
}
