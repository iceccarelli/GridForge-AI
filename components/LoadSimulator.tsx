"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Area,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { EMS_SIM } from "@/lib/site";
import { openAudit } from "@/lib/ui";

/**
 * Spiky AI Load EMS Simulator — workload-scenario edition.
 *
 * The load curve is a DETERMINISTIC, modeled archetype. No operator publishes
 * live GPU-cluster telemetry, so the shapes here are drawn from published
 * training-power characterizations — NOT a live feed and not a specific
 * company's data. What IS live is the price/grid context: the cost readout
 * pulls today's real EPEX wholesale price (and the live German renewable share)
 * from the same feeds the rest of the site uses. Real load sizing only ever
 * comes from a client's measured profile in a Power Audit — and the UI says so.
 *
 * Stack allocation (bottom → top, summing to load):
 *   renewables → gas baseload → fuel-cell firming (lags, by design) → BESS.
 */

type Gen = (t: number, L: number) => number;

const SC = EMS_SIM.stack;

const gauss = (t: number, c: number, w: number) => Math.exp(-(((t - c) / w) ** 2));

const SCENARIOS: {
  id: string;
  label: string;
  caption: string;
  source: string;
  gen: Gen;
}[] = [
  {
    id: "pretrain",
    label: "Pretraining",
    caption:
      "Large-scale pretraining synchronizes thousands of GPUs. Checkpoints and all-reduce steps cause sharp, collective power swings — the hardest signature to serve, and where the battery earns its place.",
    source: EMS_SIM.spike.source,
    gen: (t, L) => {
      let v = L * (0.72 + 0.05 * Math.sin(t / 9) + 0.02 * Math.sin(t / 2.3));
      for (const c of [22, 52, 82, 110]) v += L * 0.34 * gauss(t, c, 3.4);
      for (const c of [40, 70, 98]) v -= L * 0.08 * gauss(t, c, 2.2); // brief sync dips
      return v;
    },
  },
  {
    id: "allreduce",
    label: "All-reduce ripple",
    caption:
      "Every optimizer step ends in a gradient all-reduce — a brief, repeating synchronization draw. Lower amplitude than a checkpoint, but constant, so the BESS rides a continuous high-frequency ripple.",
    source: "per-step gradient-sync characterization",
    gen: (t, L) =>
      L * (0.80 + 0.07 * Math.sin(t * 1.9) + 0.04 * Math.sin(t * 3.7 + 1) + 0.015 * Math.sin(t / 11)),
  },
  {
    id: "inference",
    label: "Inference serving",
    caption:
      "Inference follows traffic, not training steps: a smoother, higher-baseline curve with occasional bursts. Notice how little transient the battery absorbs — the stack is sized to the workload, not over-built.",
    source: "serving-traffic diurnal shape",
    gen: (t, L) => L * (0.84 + 0.06 * Math.sin(t / 38) + 0.015 * Math.sin(t / 6)) + L * 0.10 * gauss(t, 74, 9),
  },
  {
    id: "flat",
    label: "Flat (naive)",
    caption:
      "What flat-load modeling assumes — and what gets you a brown-out or an over-build. Switch to a training scenario to see exactly the gap the battery closes.",
    source: "naive constant-load assumption",
    gen: (t, L) => L * (0.80 + 0.006 * Math.sin(t / 15)),
  },
];

const fmtEuro = (n: number) =>
  n >= 1000 ? `€${(n / 1000).toFixed(1)}k` : `€${Math.round(n)}`;

export function LoadSimulator() {
  const [loadMW, setLoadMW] = useState<number>(EMS_SIM.defaultLoadMW);
  const [renewPct, setRenewPct] = useState<number>(EMS_SIM.defaultRenewablePct);
  const [scenarioId, setScenarioId] = useState<string>("pretrain");
  const [live, setLive] = useState<{ price?: number; renew?: number }>({});

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];

  useEffect(() => {
    let on = true;
    fetch("/api/market")
      .then((r) => r.json())
      .then((d) => on && d?.ok && typeof d.current === "number" && setLive((s) => ({ ...s, price: d.current })))
      .catch(() => {});
    fetch("/api/grid")
      .then((r) => r.json())
      .then((d) => on && d?.ok && typeof d.renewablePct === "number" && setLive((s) => ({ ...s, renew: d.renewablePct })))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  const { series, metrics } = useMemo(
    () => buildModel(loadMW, renewPct, scenario.gen),
    [loadMW, renewPct, scenario]
  );

  const costPerHr = live.price != null ? metrics.avgLoad * live.price : null;

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-5 relative">
        <div>
          <div className="eyebrow">FIG. 02 — EMS LOAD RESPONSE</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            Spiky AI load, served by the stack
          </h3>
          <p className="text-sm text-mute mt-1 max-w-md">
            Pick a real workload signature. Watch which layer of the stack catches it.
          </p>
        </div>
        <span className="pill pill-progress shrink-0">
          {live.price != null ? "MODELED LOAD · LIVE PRICE" : "ILLUSTRATIVE MODEL · NOT FIELD DATA"}
        </span>
      </div>

      {/* Scenario selector */}
      <div className="flex flex-wrap gap-2 mb-5">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => setScenarioId(s.id)}
            className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold border transition ${
              s.id === scenarioId
                ? "border-power/60 text-power bg-power/10"
                : "border-line text-mute hover:text-ghost"
            }`}
          >
            {s.label}
          </button>
        ))}
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
            <Area type="monotone" dataKey="renewables" stackId="1" name="On-site renewables" stroke={SC.renewables.color} fill={SC.renewables.color} fillOpacity={0.22} strokeWidth={1} isAnimationActive={false} />
            <Area type="monotone" dataKey="gas" stackId="1" name="Gas baseload" stroke={SC.gas.color} fill={SC.gas.color} fillOpacity={0.22} strokeWidth={1} isAnimationActive={false} />
            <Area type="monotone" dataKey="fuelCell" stackId="1" name="Fuel-cell firming" stroke={SC.fuelCell.color} fill={SC.fuelCell.color} fillOpacity={0.28} strokeWidth={1} isAnimationActive={false} />
            <Area type="monotone" dataKey="bess" stackId="1" name="BESS (sub-second)" stroke={SC.bess.color} fill={SC.bess.color} fillOpacity={0.42} strokeWidth={1.4} isAnimationActive={false} />
            <Line type="monotone" dataKey="load" name="GPU load" stroke="#F5F7FA" strokeWidth={1.4} dot={false} strokeDasharray="4 3" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3 mb-4 data text-[11px] text-mute">
        <LegendDot color={SC.bess.color} label="BESS · sub-second" />
        <LegendDot color={SC.fuelCell.color} label="Fuel cell · ~12s ramp" />
        <LegendDot color={SC.gas.color} label="Gas baseload" />
        <LegendDot color={SC.renewables.color} label="Renewables" />
        <LegendDot color="#F5F7FA" label="GPU load" dashed />
      </div>

      {/* Scenario caption */}
      <div className="rounded-lg border border-line bg-[#0b1120] px-4 py-3 mb-6">
        <p className="text-[13px] text-ghost leading-relaxed">
          {scenario.caption}
          <span className="text-faint"> — shape from {scenario.source}.</span>
        </p>
      </div>

      {/* Controls */}
      <div className="grid sm:grid-cols-2 gap-5">
        <Slider label="Cluster load" value={loadMW} unit="MW" min={EMS_SIM.loadRangeMW[0]} max={EMS_SIM.loadRangeMW[1]} step={5} onChange={setLoadMW} />
        <div>
          <Slider label="On-site renewables" value={renewPct} unit="%" min={0} max={60} step={5} onChange={setRenewPct} />
          {live.renew != null && (
            <button
              onClick={() => setRenewPct(Math.round(live.renew! / 5) * 5)}
              className="data text-[10px] text-faint hover:text-power transition mt-1.5"
            >
              ↳ German grid is {live.renew.toFixed(0)}% renewable right now — match it
            </button>
          )}
        </div>
      </div>

      {/* Derived metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px mt-6 bg-line rounded-xl overflow-hidden border border-line">
        <Metric value={`${metrics.bessPeakMW.toFixed(1)} MW`} label="Peak transient the battery absorbs" accent="power" />
        <Metric value={`${metrics.firmAvoidedPct.toFixed(0)}%`} label="Firm capacity not sized for" accent="verified" />
        <Metric value="<1s vs ~12s" label="BESS response vs fuel-cell ramp" accent="mute" />
        <Metric
          value={costPerHr != null ? `${fmtEuro(costPerHr)}/hr` : "—"}
          label={live.price != null ? `Energy at live price · ${live.price.toFixed(0)} €/MWh` : "fetching live price…"}
          accent="queue"
        />
      </div>

      <div className="mt-5 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint max-w-xl leading-relaxed">
          Load shapes are modeled archetypes from published training-power research —
          no operator publishes live GPU telemetry. Price and grid context are live
          (EPEX · Fraunhofer). Real sizing comes from your measured load profile in a
          Power Audit.
        </p>
        <button onClick={() => openAudit("ems-simulator")} className="btn-secondary px-4 py-2 rounded-lg text-sm shrink-0">
          Run it on my load profile →
        </button>
      </div>
    </div>
  );
}

/* ---------- the model ---------- */

function buildModel(loadMW: number, renewPct: number, gen: Gen) {
  const N = EMS_SIM.samples;
  const W = EMS_SIM.windowSeconds;
  const dt = W / (N - 1);

  const raw: { t: number; load: number }[] = [];
  for (let i = 0; i < N; i++) {
    const t = i * dt;
    raw.push({ t: Math.round(t), load: Math.max(gen(t, loadMW), 0) });
  }

  const avg = raw.reduce((s, p) => s + p.load, 0) / N;
  const gasFloor = 0.5 * avg;

  const tau = EMS_SIM.stack.fuelCell.rampSecondsToFull;
  const alpha = dt / (tau + dt);
  let fuelEMA = 0;

  let bessPeakMW = 0;
  let maxFirm = 0;
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

  const firmAvoidedPct = peakLoad > 0 ? Math.max(0, ((peakLoad - maxFirm) / peakLoad) * 100) : 0;

  return { series, metrics: { bessPeakMW, firmAvoidedPct, avgLoad: avg } };
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

function Metric({ value, label, accent }: { value: string; label: string; accent: "power" | "verified" | "mute" | "queue" }) {
  const color =
    accent === "power" ? "text-power" : accent === "verified" ? "text-verified" : accent === "queue" ? "text-queue" : "text-ghost";
  return (
    <div className="bg-panel p-4">
      <div className={`data text-2xl font-semibold tracking-tight ${color}`}>{value}</div>
      <div className="text-[11px] text-mute mt-1 leading-snug">{label}</div>
    </div>
  );
}
