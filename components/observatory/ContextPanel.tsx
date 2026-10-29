// Market and grid conditions, with every figure carrying its provenance. A server component: none of this ships as JS.
//
// Wording rules (enforced here and by tests): "live" appears ONLY for an observation that is fresh now AND very recent (a
// reading hours old is "the latest reading"). A day-ahead price is a published auction price for a delivery hour; the queue is a
// published report as of a date. An unavailable feed says so and why; there is no placeholder number. Every card names the
// region its data belongs to, and the reference-region sentence is shown exactly as the data layer wrote it. The invented halls
// have no location, so none of this is theirs.
import type { ReactNode } from "react";
import type { LiveContext, Observed } from "@/lib/observatory/types";
import { fmtNumber, fmtUtc } from "@/components/observatory/format";
import { effectiveFreshness, viewProvenance } from "@/components/observatory/provenance";

export type ContextState = { ok: true; context: LiveContext } | { ok: false; reason: string };

// Never green: green is this site's "verified / operational" signal, and a reading that is merely inside its age limit is neither.
const FRESH_TONE: Record<string, string> = {
  fresh: "border-power/60 text-power",
  stale: "border-queue/60 text-queue",
  unavailable: "border-flag/60 text-flag",
  not_applicable: "border-line text-mute",
};

/** "no price is shown" becomes "No price is shown." so a data-layer note reads as a sentence. */
export function asSentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

export function ProvenanceChip({ obs, now, hideCaveat = false }: { obs: Observed<unknown>; now: Date; hideCaveat?: boolean }) {
  const p = viewProvenance(obs, now);
  return (
    <div className="mt-3 rounded-lg border border-line bg-ink/50 p-3 text-xs" data-provenance={obs.provenance.basis} data-freshness={p.freshness}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ghost">{p.headline}</span>
        {p.freshness === "unavailable" ? null : (
          <span className={`rounded-full border px-2 py-px font-mono text-[10px] font-bold uppercase tracking-wide ${FRESH_TONE[p.freshness]}`}>{p.freshnessText}</span>
        )}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-mute">Source</dt>
        <dd className="text-ghost">{p.source}</dd>
        <dt className="text-mute">Describes</dt>
        <dd className="data text-ghost">{p.observedAt}</dd>
        <dt className="text-mute">Retrieved</dt>
        <dd className="text-ghost">
          <span className="data">{p.retrievedAt}</span>
          {p.retrievedAgo ? <span className="block text-mute">{p.retrievedAgo}</span> : null}
        </dd>
        <dt className="text-mute">Basis</dt>
        <dd className="text-mute">{p.basisText}</dd>
      </dl>
      {p.caveat && !hideCaveat ? <p className="mt-2 text-mute">{asSentence(p.caveat)}</p> : null}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4" aria-label={title}>
      <h3 className="text-sm font-semibold text-ghost">{title}</h3>
      {children}
    </section>
  );
}

function Unavailable({ why }: { why: string }) {
  return (
    <p className="mt-2 text-sm text-mute" role="note">
      <span className="font-semibold text-ghost">Unavailable.</span> {why}
    </p>
  );
}

/** A value is shown only when it exists AND the feed is not marked unavailable. Otherwise: unavailable, with the reason. */
function usable<T>(obs: Observed<T>, now: Date): T | null {
  return obs.value !== null && effectiveFreshness(obs, now) !== "unavailable" ? obs.value : null;
}
const whyMissing = (obs: Observed<unknown>) => (obs.provenance.caveat ? asSentence(obs.provenance.caveat) : "The source returned no reading, so nothing is shown in its place.");

/** Each card names the region its data belongs to. */
export const TITLES = {
  price: "Day-ahead electricity price: Germany/Luxembourg market",
  mix: "Generation mix: Germany grid",
  queue: "Interconnection queues: US ISOs (ERCOT, PJM, MISO, SPP)",
  demand: "Demand: US Lower 48",
} as const;

export function ContextPanel({ state, now }: { state: ContextState; now: Date }) {
  if (!state.ok) {
    const why = `The server could not fetch the market and grid context (${state.reason}). Nothing is shown in its place.`;
    return (
      <div className="grid gap-4 md:grid-cols-2" data-context="unavailable">
        {[TITLES.price, TITLES.mix, TITLES.queue, TITLES.demand].map((t) => (
          <Card key={t} title={t}>
            <Unavailable why={why} />
          </Card>
        ))}
      </div>
    );
  }
  const c = state.context;
  const price = usable(c.dayAheadPrice, now);
  const mix = usable(c.generationMix, now);
  const queue = usable(c.queue, now);
  const demand = usable(c.usDemand, now);
  return (
    <div data-context="ok">
      <p className="rounded-lg border border-queue/50 bg-queue/5 p-3 text-sm text-ghost" role="note">
        {c.referenceRegion}
      </p>
      <p className="mt-2 text-xs text-mute">
        Assembled {fmtUtc(c.generatedAt)}. This page re-reads the feeds at most every five minutes, so check each figure&apos;s own times below.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card title={TITLES.price}>
          {price ? (
            <>
              <p className="mt-2">
                <span className="data text-2xl text-ghost">{fmtNumber(price.eurPerMWh)}</span> <span className="text-sm text-mute">EUR per MWh</span>
              </p>
              <p className="mt-1 text-sm text-mute">
                For the delivery hour starting <span className="data text-ghost">{fmtUtc(price.deliveryStart)}</span>. Over the published window{" "}
                {price.windowStart && price.windowEnd ? (
                  <>
                    <span className="data text-ghost">{fmtUtc(price.windowStart)}</span> to <span className="data text-ghost">{fmtUtc(price.windowEnd)}</span>{" "}
                  </>
                ) : null}
                (about the next 24 hours): lowest{" "}
                <span className="data text-ghost">{fmtNumber(price.min)}</span>, average <span className="data text-ghost">{fmtNumber(price.avg)}</span>, highest{" "}
                <span className="data text-ghost">{fmtNumber(price.max)}</span> EUR per MWh.
              </p>
            </>
          ) : (
            <Unavailable why={whyMissing(c.dayAheadPrice)} />
          )}
          <ProvenanceChip obs={c.dayAheadPrice} now={now} hideCaveat={!price} />
        </Card>

        <Card title={TITLES.mix}>
          {mix ? (
            <>
              <p className="mt-2">
                <span className="data text-2xl text-ghost">{fmtNumber(mix.renewablePct)}%</span> <span className="text-sm text-mute">renewable, of </span>
                <span className="data text-ghost">{fmtNumber(mix.totalMW)} MW</span> <span className="text-sm text-mute">generated</span>
              </p>
              <ul className="mt-2 space-y-1 text-sm" aria-label="Generation by source">
                {[...mix.mix].sort((a, b) => b.mw - a.mw).slice(0, 8).map((m) => (
                  <li key={m.name} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-ghost sm:w-36">{m.name}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink" aria-hidden="true">
                      <span className={`block h-full rounded-full ${m.renewable ? "bg-chart" : "bg-chart-alt"}`} style={{ width: `${mix.totalMW > 0 ? Math.min(100, (m.mw / mix.totalMW) * 100) : 0}%` }} />
                    </span>
                    <span className="data w-20 shrink-0 text-right text-mute">{fmtNumber(m.mw)} MW</span>
                    <span className="w-16 shrink-0 text-xs text-mute">{m.renewable ? "renewable" : "other"}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Unavailable why={whyMissing(c.generationMix)} />
          )}
          <ProvenanceChip obs={c.generationMix} now={now} hideCaveat={!mix} />
        </Card>

        <Card title={TITLES.queue}>
          {queue ? (
            <table role="table" className="mt-2 w-full text-left text-sm">
              <caption className="mb-1 text-left text-xs text-mute">Queue figures per market from the LBNL Queued Up data, as of the date below. Active is requested capacity in a queue, not capacity available to a new load. Median wait is for generation and storage projects that reached operation; most requests never do, and it is not a load-connection time.</caption>
              <thead>
                <tr>
                  <th scope="col" className="py-1 pr-2 font-mono text-[10px] uppercase tracking-wider text-mute">Market</th>
                  <th scope="col" className="py-1 pr-2 text-right font-mono text-[10px] uppercase tracking-wider text-mute">Active</th>
                  <th scope="col" className="py-1 text-right font-mono text-[10px] uppercase tracking-wider text-mute">Median wait (completed)</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={q.market} className="border-t border-line">
                    <th scope="row" className="py-1.5 pr-2 font-medium text-ghost">{q.market}</th>
                    <td className="data py-1.5 pr-2 text-right text-ghost">{fmtNumber(q.activeProjectsGW)} GW</td>
                    <td className="data py-1.5 text-right text-ghost">{fmtNumber(q.typicalWaitMonths)} months</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Unavailable why={whyMissing(c.queue)} />
          )}
          <ProvenanceChip obs={c.queue} now={now} hideCaveat={!queue} />
        </Card>

        <Card title={TITLES.demand}>
          {demand ? (
            <p className="mt-2">
              <span className="data text-2xl text-ghost">{fmtNumber(demand.mw)}</span> <span className="text-sm text-mute">MW, period </span>
              <span className="data text-ghost">{demand.period}</span>
            </p>
          ) : (
            <Unavailable why={`${whyMissing(c.usDemand)} This overlay appears only when its data key is configured and the read succeeds.`} />
          )}
          <ProvenanceChip obs={c.usDemand} now={now} hideCaveat={!demand} />
        </Card>
      </div>
    </div>
  );
}
