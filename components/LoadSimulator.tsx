"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  Line,
  ComposedChart,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Pause, Play } from "lucide-react";
import { EMS_SIM } from "@/lib/site";
import { openAudit } from "@/lib/ui";

/**
 * Spiky AI Load EMS Monitor — dual timeframe (Live 1m / Day 24h).
 *
 * LIVE: the modeled waveform streams across the user's REAL wall-clock time at
 * true 1:1 real-time, like a trading terminal. DAY: the modeled diurnal load
 * arc across 24h, with a "now" marker at real local time and the REAL EPEX price
 * curve overlaid. The clock and the price are real; the LOAD is a model — no
 * operator publishes live GPU telemetry, and the UI says so. On a real
 * deployment this same monitor renders the client's actual data.
 */

type Gen = (t: number, L: number) => number;
const SC = EMS_SIM.stack;

const WINDOW = 60; // seconds visible in Live
const LEAD = 14;
const RES = 0.5;
const TICK_MS = 250;

const gauss = (t: number, c: number, w: number) => Math.exp(-(((t - c) / w) ** 2));
const mod = (a: number, n: number) => ((a % n) + n) % n;
const pad = (n: number) => String(n).padStart(2, "0");
const fmtClock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtEuro = (n: number) => (n >= 1000 ? `€${(n / 1000).toFixed(1)}k` : `€${Math.round(n)}`);
const round = (n: number) => Math.round(n * 10) / 10;

const SCENARIOS: { id: string; label: string; caption: string; source: string; gen: Gen }[] = [
  {
    id: "pretrain",
    label: "Pretraining",
    caption:
      "Large-scale pretraining synchronizes thousands of GPUs and runs around the clock. Checkpoints and all-reduce steps cause sharp, collective power swings — but the daily average barely moves: training doesn't care what time it is.",
    source: EMS_SIM.spike.source,
    gen: (t, L) => {
      const base = L * (0.72 + 0.05 * Math.sin(t / 9) + 0.02 * Math.sin(t / 2.3));
      const checkpoint = L * 0.34 * gauss(mod(t, 24), 12, 3.0);
      const dip = -L * 0.08 * gauss(mod(t, 8), 4, 1.6);
      return base + checkpoint + dip;
    },
  },
  {
    id: "allreduce",
    label: "All-reduce ripple",
    caption:
      "Every optimizer step ends in a gradient all-reduce — a brief, repeating synchronization draw. Constant through the day, so the BESS rides a continuous high-frequency ripple regardless of the hour.",
    source: "per-step gradient-sync characterization",
    gen: (t, L) =>
      L * (0.80 + 0.07 * Math.sin(t * 1.9) + 0.04 * Math.sin(t * 3.7 + 1) + 0.015 * Math.sin(t / 11)),
  },
  {
    id: "inference",
    label: "Inference serving",
    caption:
      "Inference follows user traffic: low overnight, climbing through the morning, peaking late afternoon and evening. This is the workload whose daily shape actually matters — and where time-of-day pricing bites hardest.",
    source: "serving-traffic diurnal shape",
    gen: (t, L) => L * (0.84 + 0.06 * Math.sin(t / 38) + 0.015 * Math.sin(t / 6)) + L * 0.1 * gauss(mod(t, 90), 45, 9),
  },
  {
    id: "flat",
    label: "Flat (naive)",
    caption:
      "What flat-load modeling assumes — and what gets you a brown-out or an over-build. Switch to a training or serving scenario to see the real shape it hides.",
    source: "naive constant-load assumption",
    gen: (t, L) => L * (0.8 + 0.006 * Math.sin(t / 15)),
  },
];

/** Daily envelope (fraction of nameplate) by hour-of-day for the 24h view. */
function envelope(hour: number, scenarioId: string) {
  if (scenarioId === "inference") return 0.6 + 0.4 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (hour - 5)) / 24));
  if (scenarioId === "flat") return 0.85;
  return 0.92 + 0.05 * Math.sin((2 * Math.PI * hour) / 24); // training ~flat
}

/** Live window ending at tNow. Deterministic → SSR-safe. */
function computeFrame(tNow: number, loadMW: number, renewPct: number, gen: Gen) {
  const start = tNow - WINDOW - LEAD;
  const pts: { t: number; load: number }[] = [];
  for (let t = start; t <= tNow + 1e-6; t += RES) pts.push({ t, load: Math.max(gen(t, loadMW), 0) });

  const avg = pts.reduce((s, p) => s + p.load, 0) / pts.length;
  const gasFloor = 0.5 * avg;
  const tau = EMS_SIM.stack.fuelCell.rampSecondsToFull;
  const alpha = RES / (tau + RES);
  let fuelEMA = 0;
  let bessPeakMW = 0;
  let maxFirm = 0;
  let peakLoad = 0;
  let visAvg = 0;
  let visN = 0;

  const all = pts.map((p, i) => {
    const renewShare = (renewPct / 100) * avg;
    const renew = Math.min(renewShare * (0.85 + 0.15 * Math.sin(p.t / 20)), p.load);
    const rem1 = Math.max(p.load - renew, 0);
    const gas = Math.min(gasFloor, rem1);
    const rem2 = Math.max(rem1 - gas, 0);
    fuelEMA = i === 0 ? rem2 : fuelEMA + alpha * (rem2 - fuelEMA);
    const fuelCell = Math.min(fuelEMA, rem2);
    const bess = Math.max(rem2 - fuelCell, 0);
    const rel = p.t - tNow;
    const visible = rel >= -WINDOW;
    if (visible) {
      bessPeakMW = Math.max(bessPeakMW, bess);
      maxFirm = Math.max(maxFirm, gas + fuelCell);
      peakLoad = Math.max(peakLoad, p.load);
      visAvg += p.load;
      visN++;
    }
    return { rel: Math.round(rel * 10) / 10, visible, load: round(p.load), renewables: round(renew), gas: round(gas), fuelCell: round(fuelCell), bess: round(bess) };
  });

  const series = all.filter((p) => p.visible);
  const firmAvoidedPct = peakLoad > 0 ? Math.max(0, ((peakLoad - maxFirm) / peakLoad) * 100) : 0;
  return { series, metrics: { bessPeakMW, firmAvoidedPct, avgLoad: visN ? visAvg / visN : avg } };
}

export function LoadSimulator() {
  const [loadMW, setLoadMW] = useState<number>(EMS_SIM.defaultLoadMW);
  const [renewPct, setRenewPct] = useState<number>(EMS_SIM.defaultRenewablePct);
  const [scenarioId, setScenarioId] = useState<string>("pretrain");
  const [streaming, setStreaming] = useState<boolean>(true);
  const [mode, setMode] = useState<"live" | "day">("live");
  const [live, setLive] = useState<{ price?: number; renew?: number; series?: { t: number; price: number }[] }>({});
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [nowHour, setNowHour] = useState<number | null>(null);

  const scenario = useMemo(() => SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0], [scenarioId]);

  const tRef = useRef<number>(WINDOW);
  const wallRef = useRef<number | null>(null);
  const loadRef = useRef(loadMW);
  const renewRef = useRef(renewPct);
  const genRef = useRef<Gen>(scenario.gen);
  useEffect(() => { loadRef.current = loadMW; }, [loadMW]);
  useEffect(() => { renewRef.current = renewPct; }, [renewPct]);
  useEffect(() => { genRef.current = scenario.gen; }, [scenario]);

  const [frame, setFrame] = useState(() => computeFrame(WINDOW, EMS_SIM.defaultLoadMW, EMS_SIM.defaultRenewablePct, SCENARIOS[0].gen));

  useEffect(() => {
    let on = true;
    fetch("/api/market").then((r) => r.json()).then((d) => {
      if (!on || !d?.ok) return;
      setLive((s) => ({ ...s, price: typeof d.current === "number" ? d.current : s.price, series: Array.isArray(d.series) ? d.series : s.series }));
    }).catch(() => {});
    fetch("/api/grid").then((r) => r.json()).then((d) => on && d?.ok && typeof d.renewablePct === "number" && setLive((s) => ({ ...s, renew: d.renewablePct }))).catch(() => {});
    return () => { on = false; };
  }, []);

  // tick local clock for the "now" marker (Day) every 10s
  useEffect(() => {
    const set = () => {
      const d = new Date();
      const m = new Date(); m.setHours(0, 0, 0, 0);
      setNowHour((d.getTime() - m.getTime()) / 3600000);
    };
    set();
    const id = setInterval(set, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setFrame(computeFrame(tRef.current, loadMW, renewPct, scenario.gen));
  }, [loadMW, renewPct, scenario]);

  useEffect(() => {
    if (!streaming) return;
    wallRef.current = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = (now - (wallRef.current ?? now)) / 1000;
      wallRef.current = now;
      tRef.current += dt; // true real-time advance
      setFrame(computeFrame(tRef.current, loadRef.current, renewRef.current, genRef.current));
      setNowMs(now);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [streaming]);

  const { series, metrics } = frame;
  const costPerHr = live.price != null ? metrics.avgLoad * live.price : null;

  // Day view data: modeled diurnal load + real price (when available)
  const dayData = useMemo(() => {
    if (live.series && live.series.length) {
      const m = new Date(); m.setHours(0, 0, 0, 0);
      const m0 = m.getTime();
      return live.series
        .map((s) => ({ hour: (s.t - m0) / 3600000, price: s.price }))
        .filter((p) => p.hour >= 0 && p.hour <= 24)
        .map((p) => ({ hour: Math.round(p.hour * 100) / 100, load: round(loadMW * envelope(p.hour, scenarioId)), price: p.price }))
        .sort((a, b) => a.hour - b.hour);
    }
    const arr: { hour: number; load: number; price: number | null }[] = [];
    for (let h = 0; h < 24; h++) arr.push({ hour: h, load: round(loadMW * envelope(h, scenarioId)), price: null });
    return arr;
  }, [live.series, loadMW, scenarioId]);

  const hasPrice = dayData.some((d) => d.price != null);

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-5 relative">
        <div>
          <div className="eyebrow">FIG. 02 — EMS LOAD MONITOR</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            Spiky AI load, served by the stack
          </h3>
          <p className="text-sm text-mute mt-1 max-w-md">
            {mode === "live" ? "Real-time, on your clock. Watch the stack catch each event." : "The whole day. See how load and price move hour to hour."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <span className="inline-flex items-center gap-2 data text-[11px]">
            <span className={`w-2 h-2 rounded-full ${mode === "live" && streaming ? "bg-verified animate-pulse" : "bg-faint"}`} />
            <span className={mode === "live" && streaming ? "text-verified" : "text-faint"}>
              {mode === "live" ? (streaming ? `LIVE · ${nowMs ? fmtClock(nowMs) : "--:--:--"}` : "PAUSED") : "24-HOUR VIEW"}
            </span>
          </span>
          <span className="pill pill-progress">{mode === "live" ? "REAL-TIME SIM · MODELED WAVEFORM" : "MODELED LOAD · LIVE PRICE"}</span>
        </div>
      </div>

      {/* Timeframe + scenario selectors */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="inline-flex rounded-lg border border-line overflow-hidden">
          {(["live", "day"] as const).map((mItem) => (
            <button
              key={mItem}
              onClick={() => setMode(mItem)}
              className={`px-3 py-1.5 text-[12px] font-semibold transition ${mode === mItem ? "bg-power/15 text-power" : "text-mute hover:text-ghost"}`}
            >
              {mItem === "live" ? "Live · 1m" : "Day · 24h"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => setScenarioId(s.id)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold border transition ${s.id === scenarioId ? "border-power/60 text-power bg-power/10" : "border-line text-mute hover:text-ghost"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="h-[300px] w-full relative" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          {mode === "live" ? (
            <ComposedChart data={series} margin={{ top: 8, right: 10, bottom: 4, left: -16 }}>
              <CartesianGrid stroke="rgba(0,229,255,0.06)" vertical={false} />
              <XAxis
                type="number" dataKey="rel" domain={[-WINDOW, 0]} ticks={[-60, -45, -30, -15, 0]}
                tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }}
                tickLine={false} axisLine={{ stroke: "#1E2942" }}
                tickFormatter={(v) => (nowMs == null ? `${v}s` : fmtClock(nowMs + v * 1000))}
              />
              <YAxis tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }} tickLine={false} axisLine={{ stroke: "#1E2942" }} width={42} />
              <Tooltip contentStyle={{ background: "#0B1120", border: "1px solid #1E2942", borderRadius: 10, fontFamily: "var(--font-mono), monospace", fontSize: 12 }} labelStyle={{ color: "#8A94A6" }} labelFormatter={(v) => (nowMs == null ? `${v}s` : fmtClock(nowMs + Number(v) * 1000))} formatter={(value: number, name: string) => [`${value.toFixed(1)} MW`, name]} />
              <Area type="monotone" dataKey="renewables" stackId="1" name="On-site renewables" stroke={SC.renewables.color} fill={SC.renewables.color} fillOpacity={0.22} strokeWidth={1} isAnimationActive={false} />
              <Area type="monotone" dataKey="gas" stackId="1" name="Gas baseload" stroke={SC.gas.color} fill={SC.gas.color} fillOpacity={0.22} strokeWidth={1} isAnimationActive={false} />
              <Area type="monotone" dataKey="fuelCell" stackId="1" name="Fuel-cell firming" stroke={SC.fuelCell.color} fill={SC.fuelCell.color} fillOpacity={0.28} strokeWidth={1} isAnimationActive={false} />
              <Area type="monotone" dataKey="bess" stackId="1" name="BESS (sub-second)" stroke={SC.bess.color} fill={SC.bess.color} fillOpacity={0.42} strokeWidth={1.4} isAnimationActive={false} />
              <Line type="monotone" dataKey="load" name="GPU load" stroke="#F5F7FA" strokeWidth={1.4} dot={false} strokeDasharray="4 3" isAnimationActive={false} />
              <ReferenceLine x={0} stroke="#00E5FF" strokeWidth={1} strokeDasharray="3 3" />
            </ComposedChart>
          ) : (
            <ComposedChart data={dayData} margin={{ top: 8, right: hasPrice ? -8 : 10, bottom: 4, left: -16 }}>
              <CartesianGrid stroke="rgba(0,229,255,0.06)" vertical={false} />
              <XAxis
                type="number" dataKey="hour" domain={[0, 24]} ticks={[0, 6, 12, 18, 24]}
                tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }}
                tickLine={false} axisLine={{ stroke: "#1E2942" }} tickFormatter={(v) => `${pad(v)}:00`}
              />
              <YAxis yAxisId="mw" tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }} tickLine={false} axisLine={{ stroke: "#1E2942" }} width={42} />
              {hasPrice && (
                <YAxis yAxisId="eur" orientation="right" tick={{ fill: "#FFB020", fontSize: 10, fontFamily: "var(--font-mono), monospace" }} tickLine={false} axisLine={{ stroke: "#1E2942" }} width={46} tickFormatter={(v) => `${v}`} />
              )}
              <Tooltip contentStyle={{ background: "#0B1120", border: "1px solid #1E2942", borderRadius: 10, fontFamily: "var(--font-mono), monospace", fontSize: 12 }} labelStyle={{ color: "#8A94A6" }} labelFormatter={(v) => `${pad(Number(v))}:00`} formatter={(value: number, name: string) => [name === "Price" ? `${value.toFixed(0)} €/MWh` : `${value.toFixed(1)} MW`, name]} />
              <Area yAxisId="mw" type="monotone" dataKey="load" name="Modeled load" stroke={SC.bess.color} fill={SC.bess.color} fillOpacity={0.18} strokeWidth={1.6} isAnimationActive={false} />
              {hasPrice && <Line yAxisId="eur" type="monotone" dataKey="price" name="Price" stroke="#FFB020" strokeWidth={1.6} dot={false} isAnimationActive={false} />}
              {nowHour != null && <ReferenceLine x={nowHour} yAxisId="mw" stroke="#00E5FF" strokeWidth={1} strokeDasharray="3 3" label={{ value: "now", position: "top", fill: "#00E5FF", fontSize: 10 }} />}
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Legend + control */}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 mb-4">
        <div className="flex flex-wrap gap-x-5 gap-y-2 data text-[11px] text-mute">
          {mode === "live" ? (
            <>
              <LegendDot color={SC.bess.color} label="BESS · sub-second" />
              <LegendDot color={SC.fuelCell.color} label="Fuel cell · ~12s ramp" />
              <LegendDot color={SC.gas.color} label="Gas baseload" />
              <LegendDot color={SC.renewables.color} label="Renewables" />
              <LegendDot color="#F5F7FA" label="GPU load" dashed />
            </>
          ) : (
            <>
              <LegendDot color={SC.bess.color} label="Modeled load (MW)" />
              {hasPrice && <LegendDot color="#FFB020" label="Real EPEX price (€/MWh)" />}
            </>
          )}
        </div>
        {mode === "live" && (
          <button onClick={() => setStreaming((s) => !s)} className="btn-secondary px-3 py-1.5 rounded-lg text-[13px] inline-flex items-center gap-2 shrink-0">
            {streaming ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {streaming ? "Pause stream" : "Resume stream"}
          </button>
        )}
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
            <button onClick={() => setRenewPct(Math.round(live.renew! / 5) * 5)} className="data text-[10px] text-faint hover:text-power transition mt-1.5">
              ↳ German grid is {live.renew.toFixed(0)}% renewable right now — match it
            </button>
          )}
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px mt-6 bg-line rounded-xl overflow-hidden border border-line">
        <Metric value={`${metrics.bessPeakMW.toFixed(1)} MW`} label="Peak transient the battery absorbs" accent="power" />
        <Metric value={`${metrics.firmAvoidedPct.toFixed(0)}%`} label="Firm capacity not sized for" accent="verified" />
        <Metric value="<1s vs ~12s" label="BESS response vs fuel-cell ramp" accent="mute" />
        <Metric value={costPerHr != null ? `${fmtEuro(costPerHr)}/hr` : "—"} label={live.price != null ? `Energy at live price · ${live.price.toFixed(0)} €/MWh` : "fetching live price…"} accent="queue" />
      </div>

      <div className="mt-5 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint max-w-xl leading-relaxed">
          The clock and the EPEX price are live; the load waveform is a model — no
          operator publishes live GPU telemetry, so on a real deployment this monitor
          streams your cluster&apos;s actual data instead.
        </p>
        <button onClick={() => openAudit("ems-simulator")} className="btn-secondary px-4 py-2 rounded-lg text-sm shrink-0">
          Run it on my load profile →
        </button>
      </div>
    </div>
  );
}

/* ---------- small UI pieces ---------- */

function Slider({ label, value, unit, min, max, step, onChange }: { label: string; value: number; unit: string; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-ghost">{label}</span>
        <span className="data text-power text-sm">{value}<span className="text-faint ml-0.5">{unit}</span></span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#00E5FF] cursor-pointer" aria-label={label} />
    </label>
  );
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-3 h-[3px] rounded-full" style={dashed ? { borderTop: `2px dashed ${color}`, width: 12 } : { background: color }} />
      {label}
    </span>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent: "power" | "verified" | "mute" | "queue" }) {
  const color = accent === "power" ? "text-power" : accent === "verified" ? "text-verified" : accent === "queue" ? "text-queue" : "text-ghost";
  return (
    <div className="bg-panel p-4">
      <div className={`data text-2xl font-semibold tracking-tight ${color}`}>{value}</div>
      <div className="text-[11px] text-mute mt-1 leading-snug">{label}</div>
    </div>
  );
}
