"use client";

import React, { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Zap } from "lucide-react";
import { EMS_SIM } from "@/lib/site";
import { openAudit } from "@/lib/ui";

/**
 * Spiky AI Load EMS Simulator.
 *
 * A DETERMINISTIC, illustrative model of how a hybrid behind-the-meter stack
 * serves a spiky GPU training load. Nothing here is measured field data — the
 * curves are computed live from the EMS_SIM parameters and the user's inputs,
 * and the UI says so plainly. The point is to make the physics legible:
 * the battery (sub-second) absorbs the checkpoint transient so firm generation
 * never has to be sized for the peak.
 *
 * Layering (bottom → top of the stacked area), summing exactly to load:
 *   renewables → gas baseload → fuel-cell firming → BESS (fast transient).
 * Fuel-cell output tracks an exponential moving average of the residual, so it
 * deliberately LAGS fast spikes — leaving the spike for the battery. That lag
 * is the whole argument.
 */
export function LoadSimulator() {
  const [loadMW, setLoadMW] = useState<number>(EMS_SIM.defaultLoadMW);
  const [renewPct, setRenewPct] = useState<number>(EMS_SIM.defaultRenewablePct);
  const [spike, setSpike] = useState<boolean>(true);

  const { series, metrics } = useMemo(
    () => buildModel(loadMW, renewPct, spike),
    [loadMW, renewPct, spike]
  );

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-6 relative">
        <div>
          <div className="eyebrow">FIG. 02 — EMS LOAD RESPONSE</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            Spiky AI load, served by the stack
          </h3>
          <p className="text-sm text-mute mt-1 max-w-md">
            A training checkpoint hammers the cluster for a few seconds. Watch
            which layer catches it.
          </p>
        </div>
        <span className="pill pill-progress shrink-0">ILLUSTRATIVE MODEL · NOT FIELD DATA</span>
      </div>

      {/* Chart */}
      <div className="h-[300px] w-full relative" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 8, right: 6, bottom: 4, left: -16 }}>
            <CartesianGrid stroke="rgba(0,229,255,0.06)" vertical={false} />
            <XAxis
              dataKey="t"
              tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }}
              tickLine={false}
              axisLine={{ stroke: "#1E2942" }}
              tickFormatter={(v) => `${v}s`}
              interval={29}
            />
            <YAxis
              tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }}
              tickLine={false}
              axisLine={{ stroke: "#1E2942" }}
              tickFormatter={(v) => `${v}`}
              width={42}
            />
            <Tooltip
              contentStyle={{
                background: "#0B1120",
                border: "1px solid #1E2942",
                borderRadius: 10,
                fontFamily: "var(--font-mono), monospace",
                fontSize: 12,
              }}
              labelStyle={{ color: "#8A94A6" }}
              labelFormatter={(v) => `t = ${v}s`}
              formatter={(value: number, name: string) => [`${value.toFixed(1)} MW`, name]}
            />
            <Area
              type="monotone" dataKey="renewables" stackId="1" name="On-site renewables"
              stroke={EMS_SIM.stack.renewables.color} fill={EMS_SIM.stack.renewables.color}
              fillOpacity={0.22} strokeWidth={1} isAnimationActive={false}
            />
            <Area
              type="monotone" dataKey="gas" stackId="1" name="Gas baseload"
              stroke={EMS_SIM.stack.gas.color} fill={EMS_SIM.stack.gas.color}
              fillOpacity={0.22} strokeWidth={1} isAnimationActive={false}
            />
            <Area
              type="monotone" dataKey="fuelCell" stackId="1" name="Fuel-cell firming"
              stroke={EMS_SIM.stack.fuelCell.color} fill={EMS_SIM.stack.fuelCell.color}
              fillOpacity={0.28} strokeWidth={1} isAnimationActive={false}
            />
            <Area
              type="monotone" dataKey="bess" stackId="1" name="BESS (sub-second)"
              stroke={EMS_SIM.stack.bess.color} fill={EMS_SIM.stack.bess.color}
              fillOpacity={0.42} strokeWidth={1.4} isAnimationActive={false}
            />
            <Line
              type="monotone" dataKey="load" name="GPU load"
              stroke="#F5F7FA" strokeWidth={1.4} dot={false} strokeDasharray="4 3"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3 mb-6 data text-[11px] text-mute">
        <LegendDot color={EMS_SIM.stack.bess.color} label="BESS · sub-second" />
        <LegendDot color={EMS_SIM.stack.fuelCell.color} label="Fuel cell · ~12s ramp" />
        <LegendDot color={EMS_SIM.stack.gas.color} label="Gas baseload" />
        <LegendDot color={EMS_SIM.stack.renewables.color} label="Renewables" />
        <LegendDot color="#F5F7FA" label="GPU load" dashed />
      </div>

      {/* Controls */}
      <div className="grid sm:grid-cols-2 gap-5">
        <Slider
          label="Cluster load" value={loadMW} unit="MW"
          min={EMS_SIM.loadRangeMW[0]} max={EMS_SIM.loadRangeMW[1]} step={5}
          onChange={setLoadMW}
        />
        <Slider
          label="On-site renewables" value={renewPct} unit="%"
          min={0} max={60} step={5} onChange={setRenewPct}
        />
      </div>

      <button
        onClick={() => setSpike((s) => !s)}
        className={`mt-5 w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition ${
          spike ? "btn-primary" : "btn-secondary"
        }`}
      >
        <Zap className="w-4 h-4" />
        {spike ? "Training spike: ON" : "Trigger training spike"}
      </button>

      {/* Derived metrics — computed live from the model above */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px mt-6 bg-line rounded-xl overflow-hidden border border-line">
        <Metric
          value={`${metrics.bessPeakMW.toFixed(1)} MW`}
          label="Peak transient the battery absorbs"
          accent="power"
        />
        <Metric
          value={`${metrics.firmAvoidedPct.toFixed(0)}%`}
          label="Firm generation capacity not sized for"
          accent="verified"
        />
        <Metric
          value={"<1s vs ~12s"}
          label="BESS response vs fuel-cell ramp"
          accent="mute"
        />
      </div>

      <div className="mt-5 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint max-w-lg leading-relaxed">
          Deterministic model for intuition. Spike signature based on{" "}
          {EMS_SIM.spike.source}. Real sizing comes from your measured load
          profile in a Power Audit.
        </p>
        <button onClick={() => openAudit("ems-simulator")} className="btn-secondary px-4 py-2 rounded-lg text-sm">
          Run it on my load profile →
        </button>
      </div>
    </div>
  );
}

/* ---------- the model ---------- */

function buildModel(loadMW: number, renewPct: number, spike: boolean) {
  const N = EMS_SIM.samples;
  const W = EMS_SIM.windowSeconds;
  const dt = W / (N - 1);

  // Deterministic base load: ~75% utilization with gentle drift + micro-texture.
  const raw: { t: number; load: number }[] = [];
  for (let i = 0; i < N; i++) {
    const t = i * dt;
    let load =
      loadMW *
      (0.75 + 0.05 * Math.sin(t / 9) + 0.02 * Math.sin(t / 2.3));
    if (spike) {
      // Checkpoint / all-reduce transients at fixed points in the window.
      for (const c of [30, 68, 102]) {
        const d = (t - c) / EMS_SIM.spike.widthSeconds;
        load += loadMW * (EMS_SIM.spike.magnitudePct / 100) * Math.exp(-d * d);
      }
    }
    raw.push({ t: Math.round(t), load });
  }

  const avg = raw.reduce((s, p) => s + p.load, 0) / N;
  const gasFloor = 0.5 * avg; // flat firm floor over this short window

  // Fuel cell tracks an EMA of the residual → lags fast spikes by design.
  const tau = EMS_SIM.stack.fuelCell.rampSecondsToFull;
  const alpha = dt / (tau + dt);
  let fuelEMA = 0;

  let bessPeakMW = 0;
  let maxFirm = 0; // max(gas+fuel) with BESS smoothing
  const peakLoad = Math.max(...raw.map((p) => p.load));

  const series = raw.map((p, i) => {
    const renewShare = (renewPct / 100) * avg;
    const renew = Math.min(renewShare * (0.85 + 0.15 * Math.sin(p.t / 20)), p.load);
    const rem1 = Math.max(p.load - renew, 0);
    const gas = Math.min(gasFloor, rem1);
    const rem2 = Math.max(rem1 - gas, 0);
    fuelEMA = i === 0 ? rem2 : fuelEMA + alpha * (rem2 - fuelEMA);
    const fuelCell = Math.min(fuelEMA, rem2);
    const bess = Math.max(rem2 - fuelCell, 0);

    bessPeakMW = Math.max(bessPeakMW, bess);
    maxFirm = Math.max(maxFirm, gas + fuelCell);

    return {
      t: p.t,
      load: round(p.load),
      renewables: round(renew),
      gas: round(gas),
      fuelCell: round(fuelCell),
      bess: round(bess),
    };
  });

  // Without BESS, firm gen must be sized to the peak. With BESS, it's sized to
  // the smoothed envelope. The difference is capacity you don't have to buy.
  const firmAvoidedPct =
    peakLoad > 0 ? Math.max(0, ((peakLoad - maxFirm) / peakLoad) * 100) : 0;

  return { series, metrics: { bessPeakMW, firmAvoidedPct } };
}

const round = (n: number) => Math.round(n * 10) / 10;

/* ---------- small UI pieces ---------- */

function Slider({
  label, value, unit, min, max, step, onChange,
}: {
  label: string; value: number; unit: string;
  min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-ghost">{label}</span>
        <span className="data text-power text-sm">
          {value}
          <span className="text-faint ml-0.5">{unit}</span>
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#00E5FF] cursor-pointer"
        aria-label={label}
      />
    </label>
  );
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block w-3 h-[3px] rounded-full"
        style={dashed ? { borderTop: `2px dashed ${color}`, width: 12 } : { background: color }}
      />
      {label}
    </span>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent: "power" | "verified" | "mute" }) {
  const color = accent === "power" ? "text-power" : accent === "verified" ? "text-verified" : "text-ghost";
  return (
    <div className="bg-panel p-4">
      <div className={`data text-2xl font-semibold tracking-tight ${color}`}>{value}</div>
      <div className="text-[11px] text-mute mt-1 leading-snug">{label}</div>
    </div>
  );
}
