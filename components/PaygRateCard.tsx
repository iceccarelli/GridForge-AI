import { PAYG } from "@/lib/products";
import {
  FREE_ALLOWANCE_TEXT,
  billingRuleText,
  breakEvens,
  eurExact,
  isFree,
  isPerHall,
  type ToolRate,
} from "@/lib/payg-pricing";

/**
 * The rate card. Generated, not written: units per endpoint come from public/reference/tools.json (the
 * engine's own catalogue), the unit price and the allowance from PAYG in lib/products.ts, and the break-even
 * sentences from the API plans in the same file. There is no table of prices in this component to drift.
 */
export default function PaygRateCard({ rates, heading = "What one operation costs" }: { rates: ToolRate[]; heading?: string }) {
  const ordered = [...rates].sort((a, b) => a.units - b.units || a.endpoint.localeCompare(b.endpoint));
  const bes = breakEvens();
  return (
    <div>
      <h3 className="text-lg font-semibold text-ghost">{heading}</h3>
      <p className="mt-2 max-w-3xl text-sm text-mute">
        One unit price for every billable operation: <span className="font-mono text-ghost">{eurExact(PAYG.unitPriceCents)}</span>{" "}
        a unit. Each endpoint weighs a published number of units, so a constraint screen and a full study are
        not billed alike. {FREE_ALLOWANCE_TEXT}
      </p>

      {ordered.length === 0 ? (
        <p role="status" className="mt-4 rounded border border-line bg-panel p-4 text-sm text-mute">
          The tool catalogue is not available on this deployment, so no rate card is shown. Nothing is guessed
          in its place.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <caption className="sr-only">Units and pay-as-you-go cost per operation, from the engine tool catalogue</caption>
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                <th scope="col" className="py-2 pr-4">Operation</th>
                <th scope="col" className="py-2 pr-4">Endpoint</th>
                <th scope="col" className="py-2 pr-4 text-right">Units</th>
                <th scope="col" className="py-2 text-right">Pay as you go</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((t) => (
                <tr key={t.name} className="border-b border-line/60">
                  <th scope="row" className="py-2.5 pr-4 text-left font-mono text-xs font-normal text-ghost">{t.name}</th>
                  <td className="py-2.5 pr-4 font-mono text-xs text-mute">{t.endpoint}</td>
                  <td className="py-2.5 pr-4 text-right font-mono text-xs text-power">
                    {t.units}
                    {isPerHall(t) ? <span className="text-faint"> per hall</span> : null}
                  </td>
                  <td className="py-2.5 text-right font-mono text-xs text-ghost">
                    {isFree(t) ? (
                      <span className="text-verified">free</span>
                    ) : (
                      <>
                        {eurExact(t.units * PAYG.unitPriceCents)}
                        {isPerHall(t) ? <span className="text-faint"> per hall</span> : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded border border-line bg-panel p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">How it is billed</p>
          <p className="mt-2 text-sm text-mute">{billingRuleText()}</p>
          <p className="mt-2 text-xs text-faint">
            You set a monthly cap between {eurExact(PAYG.minCapEur * 100)} and {eurExact(PAYG.maxCapEur * 100)}. The engine
            stops at it. It does not go over.
          </p>
        </div>
        <div className="rounded border border-line bg-panel p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">When a plan is cheaper</p>
          <ul className="mt-2 space-y-2 text-sm text-mute">
            {bes.map((b) => (
              <li key={b.plan.id}>{b.text}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">
            Computed from the plan prices and the unit price above. Plans have no overage: past the included
            units the engine answers 402.
          </p>
        </div>
      </div>
    </div>
  );
}
