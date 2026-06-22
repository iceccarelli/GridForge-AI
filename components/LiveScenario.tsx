"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, BatteryCharging, Zap } from "lucide-react";
import { openAudit } from "@/lib/ui";

/**
 * Interactive scenario panel. Pulls today's real EPEX day-ahead curve and lets
 * the buyer dial in their own cluster + battery, then computes the real daily /
 * annual economics — grid bill, and BESS arbitrage savings from charging in the
 * cheapest hours and discharging in the priciest. The price curve highlights the
 * charge (green) and discharge (red) hours live as the battery is resized.
 *
 * Every number is computed from the REAL price series — nothing is invented.
 * Round-trip efficiency is a stated assumption (90%), not a guarantee.
 */

type Series = { t: number; price: number }[];
const RTE_OPTIONS = [0.85, 0.9, 0.95] as const;
const CYCLE_OPTIONS = [1, 2] as const;
const pad = (n: number) => String(n).padStart(2, "0");
const fmtHM = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function useTween(target: number, dur = 600) {
  const [v, setV] = useState(target);
  const ref = useRef(target);
  useEffect(() => {
    const from = ref.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min((t - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setV(from + (target - from) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else ref.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return v;
}

const fmtEuro = (n: number) => {
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `€${(n / 1_000).toFixed(1)}k`;
  return `€${Math.round(n)}`;
};

const PRESETS = [
  { label: "Edge pod", mw: 20, bess: 40 },
  { label: "Training cluster", mw: 80, bess: 160 },
  { label: "Hyperscale", mw: 160, bess: 360 },
];

export function LiveScenario() {
  const [series, setSeries] = useState<Series | null>(null);
  const [failed, setFailed] = useState(false);
  const [mw, setMW] = useState(80);
  const [bess, setBess] = useState(160); // MWh (4h battery → power = bess/4)
  const [arb, setArb] = useState(true);
  const [annual, setAnnual] = useState(false);
  const [cycles, setCycles] = useState<(typeof CYCLE_OPTIONS)[number]>(1);
  const [rte, setRte] = useState<(typeof RTE_OPTIONS)[number]>(0.9);
  const [fees, setFees] = useState(false);
  const [feeRate, setFeeRate] = useState(80);
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const set = () => setNowMs(Date.now());
    set();
    const id = setInterval(set, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/market")
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (d && d.ok && Array.isArray(d.series)) setSeries(d.series);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const model = useMemo(() => {
    if (!series || series.length === 0) return null;
    const hours = series.length;
    const prices = series.map((s) => s.price);

    // delivered energy bill: load × (wholesale + optional grid fees) each hour
    const fee = fees ? feeRate : 0;
    const gridDay = prices.reduce((sum, p) => sum + (p + fee) * mw, 0);

    // BESS arbitrage on the wholesale spread. 4h battery → power = bess/4.
    // Charge the N cheapest hours, discharge the N priciest; N scales with cycles.
    const bessMW = bess / 4;
    const nBase = bess > 0 ? Math.max(1, Math.round(bess / Math.max(bessMW, 1))) : 0;
    const nHours = Math.min(Math.floor(hours / 2), nBase * cycles);
    const order = prices.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
    const chargeIdx = new Set(order.slice(0, nHours).map((o) => o.i));
    const dischargeIdx = new Set(order.slice(hours - nHours).map((o) => o.i));
    const avg = (idx: Set<number>) =>
      idx.size ? [...idx].reduce((s, i) => s + prices[i], 0) / idx.size : 0;
    const avgCharge = avg(chargeIdx);
    const avgDischarge = avg(dischargeIdx);
    const energyMoved = bess * cycles;
    const arbDay = Math.max(0, energyMoved * (avgDischarge * rte - avgCharge));

    const bars = series.map((s, i) => ({
      hour: new Date(s.t).getHours(),
      price: s.price,
      role: arb && chargeIdx.has(i) ? "charge" : arb && dischargeIdx.has(i) ? "discharge" : "idle",
      isNow: nowMs != null && s.t <= nowMs && nowMs < s.t + 3600000,
    }));

    return {
      gridDay,
      arbDay,
      netDay: gridDay - (arb ? arbDay : 0),
      spread: avgDischarge - avgCharge,
      bars,
    };
  }, [series, mw, bess, arb, cycles, rte, fees, feeRate, nowMs]);

  const mult = annual ? 365 : 1;
  const tGrid = useTween(model ? model.gridDay * mult : 0);
  const tArb = useTween(model ? model.arbDay * mult : 0);
  const nowHour = model?.bars.find((b) => b.isNow)?.hour ?? null;

  if (failed)
    return (
      <div className="panel p-8 flex flex-col items-center text-center gap-2">
        <Activity className="w-6 h-6 text-faint" />
        <p className="text-sm text-mute max-w-sm">
          Live prices unavailable right now — the scenario model runs on the real
          EPEX curve, so it waits for the feed rather than showing made-up numbers.
        </p>
      </div>
    );

  if (!model)
    return (
      <div className="panel p-8 h-48 flex items-center justify-center text-mute text-sm data">
        Loading today&apos;s real price curve…
      </div>
    );

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-6 relative">
        <div>
          <div className="eyebrow">INTERACTIVE · YOUR SITE ON TODAY&apos;S GRID</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            Turn the knobs. Watch the money move.
          </h3>
          <p className="text-sm text-mute mt-1 max-w-lg">
            Dial in your cluster and battery — the bill and the savings recompute
            against today&apos;s real EPEX prices in real time.
          </p>
        </div>
        <div className="flex gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setMW(p.mw);
                setBess(p.bess);
              }}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-semibold border border-line text-mute hover:text-power hover:border-power/50 transition"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* price bars with charge/discharge highlight */}
      <div className="h-40 mb-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={model.bars} margin={{ top: 8, right: 0, bottom: 0, left: -20 }}>
            <YAxis
              tick={{ fill: "#5A6478", fontSize: 10, fontFamily: "var(--font-mono), monospace" }}
              tickLine={false}
              axisLine={{ stroke: "#1E2942" }}
              width={40}
            />
            <XAxis
              dataKey="hour"
              tick={{ fill: "#5A6478", fontSize: 9, fontFamily: "var(--font-mono), monospace" }}
              tickLine={false}
              axisLine={{ stroke: "#1E2942" }}
              interval={3}
              tickFormatter={(v) => `${pad(Number(v))}`}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.03)" }}
              contentStyle={{
                background: "#0B1120",
                border: "1px solid #1E2942",
                borderRadius: 10,
                fontFamily: "var(--font-mono), monospace",
                fontSize: 12,
              }}
              labelFormatter={((_: unknown, p: ReadonlyArray<{ payload?: { hour: number } }>) =>
                p && p[0]?.payload ? `${p[0].payload.hour}:00` : "") as never}
              formatter={((v: number, _n: unknown, p: { payload?: { role?: string } }) => {
                const role = p?.payload?.role;
                const tag = role === "charge" ? " · charge" : role === "discharge" ? " · discharge" : "";
                return [`€${v} /MWh${tag}`, "Price"];
              }) as never}
            />
            <Bar dataKey="price" radius={[2, 2, 0, 0]}>
              {model.bars.map((b, i) => (
                <Cell
                  key={i}
                  fill={b.role === "charge" ? "#34D399" : b.role === "discharge" ? "#F87171" : "#1E3A52"}
                  stroke={b.isNow ? "#00E5FF" : undefined}
                  strokeWidth={b.isNow ? 2 : 0}
                />
              ))}
            </Bar>
            {nowHour != null && (
              <ReferenceLine x={nowHour} stroke="#00E5FF" strokeWidth={1} strokeDasharray="3 3" />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center justify-between gap-4 data text-[11px] text-faint mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-verified" />charge (cheapest)</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-flag" />discharge (priciest)</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 rounded bg-power" />now</span>
        </div>
        {nowMs != null && (
          <span className="inline-flex items-center gap-1.5 text-power shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-verified animate-pulse" />
            {fmtHM(nowMs)} · live
          </span>
        )}
      </div>

      {/* knobs */}
      <div className="grid sm:grid-cols-2 gap-5 mb-6">
        <Knob icon={Zap} label="Cluster load" value={mw} unit="MW" min={10} max={200} step={5} onChange={setMW} />
        <Knob icon={BatteryCharging} label="On-site battery (4h)" value={bess} unit="MWh" min={0} max={400} step={20} onChange={setBess} />
      </div>

      {/* toggles */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Toggle on={arb} onClick={() => setArb((s) => !s)} label="BESS price arbitrage" />
        <Toggle on={annual} onClick={() => setAnnual((s) => !s)} label="Annualize" />
      </div>

      {/* operator calibration */}
      <div className="rounded-lg border border-line bg-[#0b1120] p-4 mb-6">
        <div className="eyebrow text-[10px] mb-3">OPERATOR CALIBRATION</div>
        <div className="grid sm:grid-cols-3 gap-5">
          <Segmented label="Battery cycles / day" value={cycles} options={CYCLE_OPTIONS} fmt={(v) => `${v}×`} onChange={setCycles} />
          <Segmented label="Round-trip efficiency" value={rte} options={RTE_OPTIONS} fmt={(v) => `${Math.round(v * 100)}%`} onChange={setRte} />
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] text-ghost">Grid fees &amp; levies</span>
              <span className="data text-[12px] text-queue">{fees ? `+€${feeRate}/MWh` : "off"}</span>
            </div>
            <div className="flex items-center gap-3">
              <Toggle on={fees} onClick={() => setFees((s) => !s)} label="" />
              <input
                type="range" min={0} max={160} step={10} value={feeRate} disabled={!fees}
                onChange={(e) => setFeeRate(Number(e.target.value))}
                className="flex-1 accent-[#FFB020] cursor-pointer disabled:opacity-40"
                aria-label="Grid fees and levies"
              />
            </div>
            <div className="text-[10px] text-faint mt-1.5">editable estimate — network charges + levies vary by site</div>
          </div>
        </div>
      </div>

      {/* results */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-line rounded-xl overflow-hidden border border-line">
        <Result value={fmtEuro(tGrid)} label={`${fees ? "All-in" : "Wholesale"} energy bill / ${annual ? "yr" : "day"}`} accent="ghost" />
        <Result
          value={arb ? `−${fmtEuro(tArb)}` : "—"}
          label={`BESS arbitrage saves / ${annual ? "yr" : "day"}`}
          accent="verified"
        />
        <Result
          value={`€${Math.round(model.spread)}`}
          label="Spread captured /MWh"
          accent="power"
        />
      </div>

      <div className="mt-5 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint max-w-lg leading-relaxed">
          Computed on today&apos;s real EPEX curve. Arbitrage assumes {cycles} cycle{cycles > 1 ? "s" : ""}/day
          at {Math.round(rte * 100)}% round-trip efficiency; grid fees are your editable estimate —
          all planning inputs, not guarantees. A Power Audit replaces them with your measured load.
        </p>
        <button onClick={() => openAudit("scenario")} className="btn-primary px-4 py-2 rounded-lg text-sm shrink-0">
          Model my real site →
        </button>
      </div>
    </div>
  );
}

function Knob({
  icon: Icon,
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 text-sm text-ghost">
          <Icon className="w-4 h-4 text-power" />
          {label}
        </span>
        <span className="data text-power text-sm">
          {value}
          <span className="text-faint ml-0.5">{unit}</span>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#00E5FF] cursor-pointer"
        aria-label={label}
      />
    </label>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition ${
        on ? "border-power/50 text-power bg-power/10" : "border-line text-mute hover:text-ghost"
      }`}
      role="switch"
      aria-checked={on}
    >
      <span
        className={`w-8 h-4 rounded-full relative transition ${on ? "bg-power/40" : "bg-line"}`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
            on ? "left-4" : "left-0.5"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

function Segmented<T extends number>({
  label,
  value,
  options,
  fmt,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  fmt: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <div className="text-[13px] text-ghost mb-2">{label}</div>
      <div className="inline-flex rounded-lg border border-line overflow-hidden">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`px-3 py-1.5 text-[12px] font-semibold transition ${
              value === o ? "bg-power/15 text-power" : "text-mute hover:text-ghost"
            }`}
          >
            {fmt(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Result({
  value,
  label,
  accent,
}: {
  value: string;
  label: string;
  accent: "ghost" | "verified" | "power";
}) {
  const color = accent === "verified" ? "text-verified" : accent === "power" ? "text-power" : "text-ghost";
  return (
    <div className="bg-panel p-4">
      <div className={`data text-2xl font-semibold tracking-tight ${color}`}>{value}</div>
      <div className="text-[11px] text-mute mt-1">{label}</div>
    </div>
  );
}
