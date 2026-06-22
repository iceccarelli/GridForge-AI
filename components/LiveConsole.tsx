"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts";
import { Activity, Zap, Leaf, Gauge } from "lucide-react";
import { openAudit } from "@/lib/ui";

/* ----------------------------- data contracts ----------------------------- */
type MarketOk = {
  ok: true;
  unit: string;
  asOf: number;
  current: number;
  min: number;
  max: number;
  avg: number;
  spread: number;
  series: { t: number; price: number }[];
};
type GridOk = {
  ok: true;
  asOf: number;
  totalMW: number;
  renewablePct: number;
  mix: { name: string; mw: number; renewable: boolean }[];
};
type Market = MarketOk | { ok: false } | null;
type Grid = GridOk | { ok: false } | null;

const REFRESH_MS = 30_000;

/* ------------------------------ tween helper ------------------------------ */
function useTween(target: number, dur = 700) {
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

/* =============================== main console ============================== */
export function LiveConsole() {
  const [market, setMarket] = useState<Market>(null);
  const [grid, setGrid] = useState<Grid>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pulse, setPulse] = useState(0);
  const [failed, setFailed] = useState(false);

  // poll both feeds
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [m, g] = await Promise.all([
          fetch("/api/market").then((r) => r.json()),
          fetch("/api/grid").then((r) => r.json()),
        ]);
        if (!live) return;
        setMarket(m);
        setGrid(g);
        setUpdatedAt(Date.now());
        setPulse((p) => p + 1);
      } catch {
        if (live) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  // 1s ticker for the countdown + moving "now" marker
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const mOk = market && market.ok ? (market as MarketOk) : null;
  const gOk = grid && grid.ok ? (grid as GridOk) : null;
  const booting = market === null && grid === null && !failed;
  const bothFailed =
    failed || (market !== null && !market.ok && grid !== null && !grid.ok);

  // derived "firm-power case" composite (transparent: from the live inputs)
  const stress = useMemo(() => {
    if (!mOk || !gOk) return null;
    const priceScore =
      mOk.max > mOk.min ? ((mOk.current - mOk.min) / (mOk.max - mOk.min)) * 100 : 50;
    const renewScore = 100 - gOk.renewablePct;
    const score = Math.round(0.5 * priceScore + 0.5 * renewScore);
    const verdict =
      score >= 66
        ? "Strong case for firm on-site power right now"
        : score >= 33
        ? "Moderate case — watch the swing"
        : "Grid relaxed at the moment";
    return { score, verdict };
  }, [mOk, gOk]);

  const secsAgo = updatedAt ? Math.floor((now - updatedAt) / 1000) : 0;
  const countdown = Math.max(0, Math.round(REFRESH_MS / 1000 - secsAgo));

  return (
    <div className="panel relative overflow-hidden">
      {/* refresh sweep */}
      <div
        key={pulse}
        className="absolute inset-0 pointer-events-none console-sweep"
        aria-hidden
      />
      <div className="scanline absolute inset-0 pointer-events-none" />

      {/* ---- header ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-6 sm:p-7 border-b border-line relative">
        <div>
          <div className="eyebrow">LIVE GRID CONSOLE · GERMANY (DE-LU)</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            The grid, streaming in real time.
          </h3>
        </div>
        <div className="flex items-center gap-3">
          {mOk || gOk ? (
            <>
              <span className="flex items-center gap-1.5 data text-[11px] text-verified">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-verified opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-verified" />
                </span>
                LIVE
              </span>
              <span className="data text-[11px] text-faint hidden sm:inline">
                updated {secsAgo}s ago · refresh {countdown}s
              </span>
            </>
          ) : (
            <span className="pill pill-progress">{booting ? "CONNECTING…" : "UNAVAILABLE"}</span>
          )}
        </div>
      </div>

      {booting && (
        <div className="h-56 flex items-center justify-center text-mute text-sm data">
          Connecting to live grid feeds…
        </div>
      )}

      {bothFailed && (
        <div className="h-56 flex flex-col items-center justify-center text-center gap-2 px-6">
          <Activity className="w-6 h-6 text-faint" />
          <p className="text-sm text-mute max-w-sm">
            Live feeds are temporarily unavailable. Data streams from EPEX Spot
            and Fraunhofer ISE when reachable — nothing is shown in its place.
          </p>
        </div>
      )}

      {(mOk || gOk) && (
        <div className="p-6 sm:p-7 space-y-7 relative">
          {/* ---- hero stat trio ---- */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-line rounded-xl overflow-hidden border border-line">
            <HeroStat
              icon={Zap}
              value={mOk ? mOk.current : null}
              suffix=" €/MWh"
              label="Wholesale power, this hour"
              accent="power"
            />
            <HeroStat
              icon={Leaf}
              value={gOk ? gOk.renewablePct : null}
              suffix="%"
              label="Renewable share, right now"
              accent="verified"
            />
            <HeroStat
              icon={Gauge}
              value={stress ? stress.score : null}
              suffix="/100"
              label="Firm-power case (derived)"
              accent="queue"
            />
          </div>

          {/* ---- price curve with live now-marker ---- */}
          {mOk && (
            <section>
              <Caption
                title="Day-ahead price curve"
                hint="Each point is one hour's wholesale price. The cyan line is the current time, moving live."
              />
              <PriceChart series={mOk.series} now={now} />
              <div className="flex justify-between data text-[10px] text-faint mt-1 px-1">
                <span>low €{mOk.min}</span>
                <span>avg €{mOk.avg}</span>
                <span>high €{mOk.max}</span>
              </div>
            </section>
          )}

          {/* ---- renewable gauge + generation mix ---- */}
          <div className="grid md:grid-cols-[auto_1fr] gap-7 items-center">
            {gOk && (
              <div className="flex flex-col items-center">
                <ArcGauge value={gOk.renewablePct} />
                <div className="text-[11px] text-mute mt-1 text-center max-w-[160px]">
                  Wind · solar · hydro · biomass share of generation
                </div>
              </div>
            )}
            {gOk && (
              <div>
                <Caption
                  title="What's generating right now"
                  hint="Green = renewable, amber/red = fossil. The grid leans on fossil when renewables dip."
                />
                <MixBar mix={gOk.mix} totalMW={gOk.totalMW} />
                <div className="data text-[11px] text-faint mt-2">
                  {(gOk.totalMW / 1000).toFixed(1)} GW total · Fraunhofer ISE
                </div>
              </div>
            )}
          </div>

          {/* ---- derived stress read ---- */}
          {stress && (
            <section className="rounded-xl border border-queue/25 bg-queue/[0.04] p-5">
              <Caption
                title="GridForge read"
                hint="A simple composite of today's price position and how low renewables are — the higher it climbs, the stronger the case for firm, dispatchable on-site power."
              />
              <StressMeter score={stress.score} />
              <p className="text-sm text-ghost mt-3">{stress.verdict}.</p>
            </section>
          )}

          {/* ---- footer ---- */}
          <div className="pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-faint data">
              EPEX Spot via aWATTar · Fraunhofer ISE Energy-Charts · auto-refresh {REFRESH_MS / 1000}s
            </p>
            <button onClick={() => openAudit("live-console")} className="btn-primary px-4 py-2 rounded-lg text-sm">
              Run this on my site →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* =============================== sub-pieces =============================== */

function HeroStat({
  icon: Icon,
  value,
  suffix,
  label,
  accent,
}: {
  icon: React.ElementType;
  value: number | null;
  suffix: string;
  label: string;
  accent: "power" | "verified" | "queue";
}) {
  const tv = useTween(value ?? 0);
  const color =
    accent === "power" ? "text-power" : accent === "verified" ? "text-verified" : "text-queue";
  return (
    <div className="bg-panel p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-[11px] text-mute">{label}</span>
      </div>
      <div className={`data text-3xl font-semibold tracking-tight ${color}`}>
        {value === null ? "—" : Math.round(tv * 10) / 10}
        <span className="text-base text-faint">{suffix}</span>
      </div>
    </div>
  );
}

const PriceChart = React.memo(function PriceChart({
  series,
  now,
}: {
  series: { t: number; price: number }[];
  now: number;
}) {
  const tMin = series[0]?.t ?? 0;
  const last = series[series.length - 1];
  const tMax = (last?.t ?? 0) + 3_600_000; // +1h so the last bar has width
  const nowPct =
    tMax > tMin ? Math.min(100, Math.max(0, ((now - tMin) / (tMax - tMin)) * 100)) : 0;

  return (
    <div className="relative h-44">
      {now >= tMin && now <= tMax && (
        <div
          className="absolute top-0 bottom-5 z-10 pointer-events-none"
          style={{ left: `${nowPct}%` }}
        >
          <div className="w-px h-full bg-power/70" />
          <div className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-power shadow-[0_0_8px_var(--power)]" />
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="lc-price" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00E5FF" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#00E5FF" stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin - 5", "dataMax + 5"]} />
          <Tooltip
            contentStyle={{
              background: "#0B1120",
              border: "1px solid #1E2942",
              borderRadius: 10,
              fontFamily: "var(--font-mono), monospace",
              fontSize: 12,
            }}
            labelFormatter={(_, p) =>
              p && p[0]
                ? new Date((p[0].payload as { t: number }).t).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : ""
            }
            formatter={(v: number) => [`€${v} /MWh`, "Day-ahead"]}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke="#00E5FF"
            strokeWidth={1.5}
            fill="url(#lc-price)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});

function ArcGauge({ value }: { value: number }) {
  const v = useTween(value);
  const r = 56;
  const circ = Math.PI * r; // half circle
  const pct = Math.min(100, Math.max(0, v)) / 100;
  return (
    <svg width="150" height="92" viewBox="0 0 150 92">
      <path
        d="M 15 82 A 60 60 0 0 1 135 82"
        fill="none"
        stroke="#1E2942"
        strokeWidth="10"
        strokeLinecap="round"
      />
      <path
        d="M 15 82 A 60 60 0 0 1 135 82"
        fill="none"
        stroke="#34D399"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
      />
      <text
        x="75"
        y="74"
        textAnchor="middle"
        className="data"
        fill="#34D399"
        fontSize="26"
        fontWeight="600"
      >
        {Math.round(v)}%
      </text>
    </svg>
  );
}

function MixBar({
  mix,
  totalMW,
}: {
  mix: { name: string; mw: number; renewable: boolean }[];
  totalMW: number;
}) {
  const color = (m: { renewable: boolean }, i: number) =>
    m.renewable
      ? ["#34D399", "#00E5FF", "#22D3EE", "#4ADE80"][i % 4]
      : ["#FFB020", "#F87171", "#A78BFA", "#8A94A6"][i % 4];
  return (
    <>
      <div className="flex h-7 rounded-lg overflow-hidden border border-line">
        {mix.map((m, i) => (
          <div
            key={m.name}
            className="transition-[width] duration-700 ease-out"
            style={{ width: `${(m.mw / totalMW) * 100}%`, background: color(m, i) }}
            title={`${m.name}: ${m.mw} MW`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 mt-3 data text-[11px]">
        {mix.map((m, i) => (
          <div key={m.name} className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color(m, i) }} />
            <span className="text-mute truncate">{m.name}</span>
            <span className="text-faint ml-auto shrink-0">
              {Math.round((m.mw / totalMW) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function StressMeter({ score }: { score: number }) {
  const v = useTween(score);
  return (
    <div className="relative h-3 rounded-full overflow-hidden mt-3"
      style={{ background: "linear-gradient(90deg,#34D399 0%,#FFB020 55%,#F87171 100%)" }}>
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white border-2 border-ink transition-all duration-700"
        style={{ left: `calc(${Math.min(100, Math.max(0, v))}% - 6px)` }}
      />
    </div>
  );
}

function Caption({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-3">
      <div className="eyebrow text-[10px]">{title}</div>
      <p className="text-xs text-faint mt-1 max-w-2xl leading-relaxed">{hint}</p>
    </div>
  );
}
