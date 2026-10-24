"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { PAYG } from "@/lib/products";
import { getEngineEstimate, type ClientFailure, type EngineEstimate } from "@/lib/payg-client";
import {
  callsInFreeAllowance,
  compareMonthly,
  eurExact,
  callableRates,
  estimateOperation,
  isPerHall,
  normaliseHalls,
  type ToolRate,
} from "@/lib/payg-pricing";

type Live =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "done"; estimate: EngineEstimate }
  | { state: "failed"; failure: Pick<ClientFailure, "kind" | "message"> };

function toCount(raw: string, fallback: number, max: number): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/**
 * "What will this cost?" Everything it shows is computed from the rate card's own registries (units per
 * endpoint from tools.json, price and allowance from PAYG, plan prices from the catalogue), so it cannot
 * quote a figure the engine does not meter. An optional button asks the live engine's public, free
 * GET /v1/estimate and shows its answer next to ours; if that route is missing or the browser cannot reach it,
 * it says so and keeps the computed figure, clearly labelled as computed.
 */
export default function CostEstimator({
  rates: offered,
  engine,
  estimateAvailable = false,
}: {
  rates: ToolRate[];
  engine: string;
  /** The deployed engine serves GET /v1/estimate. Without it the "check against the live engine" button is not shown. */
  estimateAvailable?: boolean;
}) {
  const uid = useId();
  // Only operations the deployed engine serves can be estimated: a price for one that cannot run is a price nobody pays.
  const rates = useMemo(() => callableRates(offered), [offered]);
  const paid = useMemo(() => rates.filter((r) => r.units > 0), [rates]);
  const [endpoint, setEndpoint] = useState(paid[0]?.endpoint ?? rates[0]?.endpoint ?? "");
  const [hallsRaw, setHallsRaw] = useState("10");
  const [callsRaw, setCallsRaw] = useState("20");
  const [live, setLive] = useState<Live>({ state: "idle" });

  const rate = rates.find((r) => r.endpoint === endpoint) ?? paid[0] ?? rates[0] ?? null;
  if (!rate) {
    return (
      <p role="status" className="rounded border border-line bg-panel p-4 text-sm text-mute">
        {offered.length > 0
          ? "No operation can be called on the deployed engine right now, so there is nothing to estimate. Nothing is guessed in its place."
          : "The tool catalogue is not available on this deployment, so there is nothing to estimate against."}
      </p>
    );
  }

  const perHall = isPerHall(rate);
  const halls = normaliseHalls(hallsRaw === "" ? 1 : hallsRaw);
  const calls = toCount(callsRaw, 0, 1_000_000);
  const op = estimateOperation(rate, halls);
  const monthlyUnits = op.units * calls;
  const month = compareMonthly(monthlyUnits);
  const fits = callsInFreeAllowance(op.units);

  async function checkLive() {
    if (!rate) return;
    setLive({ state: "checking" });
    const res = await getEngineEstimate(engine, rate.endpoint, perHall ? halls : null);
    if (res.ok) setLive({ state: "done", estimate: res.data });
    else {
      setLive({
        state: "failed",
        failure: {
          kind: res.kind,
          message:
            res.kind === "network"
              ? "Could not check against the live engine from the browser. The computed figure above stands."
              : res.kind === "unavailable"
                ? "The live engine on this deployment does not publish /v1/estimate yet. The computed figure above stands."
                : `${res.message} The computed figure above stands.`,
        },
      });
    }
  }

  const field =
    "mt-1 min-h-11 w-full rounded border border-line bg-panel px-3 py-2 text-base text-ghost focus:border-power focus:outline-none focus:ring-2 focus:ring-power/40";
  const lab = "font-mono text-[10px] uppercase tracking-[0.14em] text-faint";

  return (
    <div className="rounded border border-line bg-panel-2 p-5 sm:p-6">
      <h3 className="text-lg font-semibold text-ghost">What will this cost?</h3>
      <p className="mt-2 max-w-3xl text-sm text-mute">
        Pick an operation and a volume. The figures are worked out from the same published unit weights the engine
        meters, at {eurExact(PAYG.unitPriceCents)} a unit.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={`${uid}-op`} className={lab}>Operation</label>
          <select
            id={`${uid}-op`}
            value={rate.endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              setLive({ state: "idle" });
            }}
            className={field}
          >
            {rates.map((r) => (
              <option key={r.endpoint} value={r.endpoint}>
                {r.name} ({r.units === 0 ? "free" : `${r.units} unit${r.units === 1 ? "" : "s"}${isPerHall(r) ? " per hall" : ""}`})
              </option>
            ))}
          </select>
        </div>
        {perHall ? (
          <div>
            <label htmlFor={`${uid}-halls`} className={lab}>Halls in one request</label>
            <input
              id={`${uid}-halls`}
              type="number"
              inputMode="numeric"
              min={1}
              max={10000}
              value={hallsRaw}
              onChange={(e) => {
                setHallsRaw(e.target.value);
                setLive({ state: "idle" });
              }}
              className={field}
            />
          </div>
        ) : null}
        <div>
          <label htmlFor={`${uid}-calls`} className={lab}>
            {perHall ? "Requests a month" : "Calls a month"}
          </label>
          <input
            id={`${uid}-calls`}
            type="number"
            inputMode="numeric"
            min={0}
            max={1000000}
            value={callsRaw}
            onChange={(e) => setCallsRaw(e.target.value)}
            className={field}
          />
        </div>
      </div>

      <div aria-live="polite" className="mt-5 grid gap-3 sm:grid-cols-3">
        <Stat k="This call" v={op.free ? "Free" : eurExact(op.cents)} sub={`${op.units} unit${op.units === 1 ? "" : "s"}`} />
        <Stat
          k="This volume, pay as you go"
          v={eurExact(month.paygCents)}
          sub={`${monthlyUnits.toLocaleString("en-IE")} units a month`}
        />
        <Stat k="Cheapest way to buy it" v={month.beyondEverything ? "Talk to us" : month.cheapest.label} sub={month.beyondEverything ? "above every cap and plan" : eurExact(month.cheapest.cents)} />
      </div>

      <ul className="mt-4 space-y-1.5 text-sm text-mute">
        <li>{op.basis}</li>
        {fits !== null ? (
          <li>
            The {PAYG.freeAllowanceUnits}-unit free allowance covers {fits} call{fits === 1 ? "" : "s"} of this size
            {fits === 0 ? ", so this call needs pay-as-you-go or a plan" : ""}.
          </li>
        ) : null}
        {month.withinFree && monthlyUnits > 0 ? <li>This volume fits inside the free allowance: no card, no invoice.</li> : null}
        {month.carried ? (
          <li>
            A month under {eurExact(PAYG.minInvoiceCents)} is carried forward and invoiced with the next, not on its own.
          </li>
        ) : null}
        {!month.withinFree && month.capNeededEur !== null ? (
          <li>
            A cap of {eurExact(month.capNeededEur * 100)} a month would cover it. The cap you set is a hard stop.
          </li>
        ) : null}
        {month.plansCovering.length > 0 && !month.withinFree ? (
          <li>
            Plans whose included units cover it:{" "}
            {month.plansCovering.map((p) => `${p.plan.name} (${eurExact(p.cents)} a month)`).join(", ")}.
          </li>
        ) : null}
        {month.beyondEverything ? (
          <li>
            That is more than the highest cap and every plan allowance. Volume like this is a conversation, not a
            checkout: <Link href="/pricing#engagements" className="text-power underline">engineering engagements</Link> are
            fixed-fee, or write to us.
          </li>
        ) : null}
      </ul>

      {estimateAvailable ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <button
            type="button"
            onClick={checkLive}
            disabled={live.state === "checking"}
            className="inline-flex min-h-11 items-center rounded border border-line px-4 py-2 text-sm font-semibold text-ghost hover:border-power/50 disabled:opacity-60"
          >
            {live.state === "checking" ? "Asking the engine" : "Check against the live engine"}
          </button>
          <span className="text-[11px] text-faint">
            Asks the engine&apos;s public, free <span className="font-mono">/v1/estimate</span>. It never counts against anything.
          </span>
        </div>
      ) : (
        <p className="mt-5 border-t border-line pt-4 text-[11px] text-faint">
          The engine&apos;s own live estimate (<span className="font-mono">/v1/estimate</span>) is not available yet: the
          figures above are computed from the published unit weights, not read back from the engine.
        </p>
      )}
      <div aria-live="polite" className="mt-3">
        {live.state === "done" ? (
          <p className="text-sm text-mute">
            The live engine says{" "}
            <span className="font-mono text-ghost">
              {live.estimate.units} unit{live.estimate.units === 1 ? "" : "s"}, {eurExact(live.estimate.estimatedCents)}
            </span>{" "}
            for this call{live.estimate.basis ? ` (${live.estimate.basis})` : ""}.
            {live.estimate.units !== op.units || live.estimate.estimatedCents !== op.cents ? (
              <span className="text-queue"> That differs from the computed figure above; the engine&apos;s figure is the one it meters.</span>
            ) : (
              <span className="text-verified"> Matches the computed figure.</span>
            )}
          </p>
        ) : null}
        {live.state === "failed" ? (
          <p role="status" className="text-sm text-queue">{live.failure.message}</p>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="rounded border border-line bg-panel px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{k}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-ghost">{v}</p>
      <p className="text-[11px] text-faint">{sub}</p>
    </div>
  );
}
