// What US customers in the site's state paid for electricity on average, shown beside the comparison's own electricity price.
//
// CONTEXT ONLY, and the panel says so in its own words: the figure is the average over every customer in a sector for one month, delivery
// included; it is not this site's tariff, and it changes no cost or evidence class in the result above. The currencies are not converted.
// The numbers are the engine's `retail_price_context`, which the independent gridforge-stress harness parses from EIA's published table.
import type { RetailPriceContext } from "@/lib/ttp-compare";

const APPLICABILITY: Record<RetailPriceContext["applicability"]["level"], string> = {
  same_country_context: "This site is in the United States; these are the state or national averages for the sector, not this site's price.",
  scale_reference_only: "This site is not stated to be in the United States, so a US average is a scale reference at most.",
};

const price = (s: { usd_per_MWh: number } | null | undefined): string => (s ? `$${s.usd_per_MWh}/MWh` : "no published figure");

export function RetailPricePanel({ ctx }: { ctx: RetailPriceContext | undefined }) {
  if (!ctx) return null;
  const o = ctx.observed;
  const a = ctx.assumed;
  return (
    <aside aria-label="What electricity has cost, as published" className="panel p-5" data-testid="retail-price-panel">
      <h3 className="text-sm font-semibold text-ghost">What electricity has cost on average (context, not this site&apos;s tariff)</h3>
      <p className="mt-2 text-sm text-ghost">
        {o.area}, {o.period}: industrial customers paid <strong className="data">{price(o.sectors.industrial)}</strong> on average
        and commercial customers <strong className="data">{price(o.sectors.commercial)}</strong>.
      </p>
      {a ? (
        <p className="mt-2 text-sm text-queue">
          This comparison uses <strong className="data">€{a.eur_per_MWh}/MWh</strong> ({a.source}). The two are in different currencies and are not
          converted here; convert at your own rate before comparing.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-mute">{APPLICABILITY[ctx.applicability.level]} One month of preliminary data, delivery included; it is not a data-centre price and changes no cost or evidence class above.</p>
      <p className="mt-2 text-[11px] text-faint">
        Source: {ctx.source.name}, released {ctx.source.release_date}. Parsed independently by the gridforge-stress harness (page sha256 {ctx.source.page_sha256.slice(0, 12)}…).
      </p>
    </aside>
  );
}
