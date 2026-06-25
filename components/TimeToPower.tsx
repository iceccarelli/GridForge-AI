"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * FIG. 01 — the signature hero panel: the time-to-power gap, now interactive.
 *
 * The buyer dials capacity, the grid-queue wait, the on-site time-to-power, and
 * a revenue-per-MW assumption. The comparison bars and the headline finance
 * number recompute live: years recovered, first-power value unlocked, and the
 * cost of every day spent waiting on the utility. A real live EPEX sparkline
 * grounds the panel in actual market data.
 *
 * Honesty: queue/on-site/revenue are USER INPUTS with industry-typical defaults,
 * labeled planning estimates — not claims. The EPEX strip is a real live feed;
 * if it's unavailable the panel shows nothing rather than inventing a number.
 */

type Series = { t: number; price: number }[];

const fmtMoney = (m: number) => (m >= 1000 ? `$${(m / 1000).toFixed(2)}B` : `$${Math.round(m)}M`);
const fmtPerDay = (d: number) => (d >= 1_000_000 ? `$${(d / 1_000_000).toFixed(2)}M` : `$${Math.round(d / 1000)}k`);

export function TimeToPower() {
  const [mw, setMW] = useState(100);
  const [queueYrs, setQueueYrs] = useState(6);
  const [onsiteMo, setOnsiteMo] = useState(18);
  const [revPerMW, setRevPerMW] = useState(2.0); // $M / MW-yr (user assumption)

  const [series, setSeries] = useState<Series | null>(null);
  const [current, setCurrent] = useState<number | null>(null);

  // --- Autoplay scenario reel -------------------------------------------------
  // Five critical buyer stories. The reel glides the four knobs to each target
  // every 10s; because it calls the real setters, every bar + headline figure
  // animates for free. Grabbing a knob pauses autoplay for 20s, then it resumes.
  const SCENARIOS = useMemo(
    () => [
      { title: "Hyperscaler · Northern Virginia", sub: "PJM — the most congested grid on earth", mw: 200, queueYrs: 6.0, onsiteMo: 16, revPerMW: 2.4 },
      { title: "Training cluster · Texas", sub: "ERCOT — deregulated, fast behind-the-meter", mw: 100, queueYrs: 4.0, onsiteMo: 10, revPerMW: 2.0 },
      { title: "Sovereign AI · Germany", sub: "Live EPEX — bypass grid fees entirely", mw: 50, queueYrs: 4.5, onsiteMo: 12, revPerMW: 2.2 },
      { title: "Inference fleet · Kansas", sub: "SPP — wind-rich, low cost, lighter queue", mw: 300, queueYrs: 3.5, onsiteMo: 11, revPerMW: 2.6 },
      { title: "Your site · modeled by GridForge", sub: "This is what a Power Audit confirms for you", mw: 150, queueYrs: 5.0, onsiteMo: 14, revPerMW: 2.0 },
    ],
    []
  );
  const [sceneIdx, setSceneIdx] = useState(0);
  const [captionOn, setCaptionOn] = useState(true);
  const pausedUntil = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Pause autoplay for 20s whenever the user interacts with a control.
  const nudge = () => { pausedUntil.current = Date.now() + 20000; };

  useEffect(() => {
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    let dwellTimer: ReturnType<typeof setTimeout>;

    function glideTo(next: number) {
      const from = SCENARIOS[sceneIdx];
      const to = SCENARIOS[next];
      const dur = 1600;
      const t0 = performance.now();
      setCaptionOn(false);
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        const e = easeInOutCubic(p);
        setMW(Math.round(from.mw + (to.mw - from.mw) * e));
        setQueueYrs(Number((from.queueYrs + (to.queueYrs - from.queueYrs) * e).toFixed(1)));
        setOnsiteMo(Math.round(from.onsiteMo + (to.onsiteMo - from.onsiteMo) * e));
        setRevPerMW(Number((from.revPerMW + (to.revPerMW - from.revPerMW) * e).toFixed(1)));
        if (p < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          setSceneIdx(next);
          setCaptionOn(true);
        }
      };
      rafRef.current = requestAnimationFrame(step);
    }

    function schedule() {
      dwellTimer = setTimeout(function tick() {
        if (Date.now() < pausedUntil.current) {
          dwellTimer = setTimeout(tick, 1000); // wait out the pause, re-check
          return;
        }
        glideTo((sceneIdx + 1) % SCENARIOS.length);
      }, 10000);
    }
    schedule();

    return () => {
      clearTimeout(dwellTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [sceneIdx, SCENARIOS]);
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let live = true;
    fetch("/api/market")
      .then((r) => r.json())
      .then((d) => {
        if (!live || !d?.ok) return;
        if (Array.isArray(d.series)) setSeries(d.series);
        if (typeof d.current === "number") setCurrent(d.current);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const m = useMemo(() => {
    const onsiteYrs = onsiteMo / 12;
    const recovered = Math.max(0, queueYrs - onsiteYrs);
    const valueM = mw * revPerMW * recovered; // $M
    const perDay = (mw * revPerMW * 1_000_000) / 365; // $/day of delay
    const axisMax = Math.max(8, Math.ceil(queueYrs));
    return {
      onsiteYrs, recovered, valueM, perDay, axisMax,
      qFrac: Math.min(1, queueYrs / axisMax),
      oFrac: Math.min(1, onsiteYrs / axisMax),
    };
  }, [mw, queueYrs, onsiteMo, revPerMW]);

  const years = Array.from({ length: m.axisMax + 1 }, (_, i) => i);

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex items-start justify-between gap-4 mb-6 relative">
        <div>
          <div className="eyebrow">FIG. 01 — TIME TO POWER</div>
          <div className="text-sm text-mute mt-1" style={{ opacity: captionOn ? 1 : 0.25, transition: "opacity 0.5s ease" }}>
            <span className="text-power font-medium">{SCENARIOS[sceneIdx].title}</span>
            <span className="mx-1.5 text-faint">·</span>
            {SCENARIOS[sceneIdx].sub}
          </div>
        </div>
        <LiveEpex series={series} current={current} />
      </div>

      {/* Timeline axis */}
      <div className="relative">
        <div className="flex justify-between data text-[10px] text-faint mb-2 px-1">
          {years.map((y) => <span key={y}>{y}</span>)}
        </div>

        <Track
          label="Grid interconnection queue" sub="wait on the utility" tone="queue"
          fraction={m.qFrac} markerLabel={`energized · year ${queueYrs.toFixed(1).replace(/\.0$/, "")}`}
        />
        <div className="h-4" />
        <Track
          label="On-site behind-the-meter" sub="GridForge approach" tone="power"
          fraction={m.oFrac} markerLabel={`energized · month ${Math.round(onsiteMo)}`}
        />

        <div className="data text-[10px] text-faint mt-2 px-1 flex justify-between">
          <span className="text-power">{m.recovered.toFixed(1)} yrs recovered</span>
          <span>YEARS FROM APPLICATION →</span>
        </div>
      </div>

      {/* Knobs */}
      <div className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4">
        <Knob label="Capacity" value={mw} unit="MW" min={10} max={500} step={10} onChange={setMW} onNudge={nudge} />
        <Knob label="Queue wait" value={queueYrs} unit="yr" min={2} max={8} step={0.5} onChange={setQueueYrs} fixed={1} onNudge={nudge} />
        <Knob label="On-site time-to-power" value={onsiteMo} unit="mo" min={9} max={30} step={1} onChange={setOnsiteMo} onNudge={nudge} />
        <Knob label="Revenue / MW-yr" value={revPerMW} unit="$M" min={0.5} max={4} step={0.1} onChange={setRevPerMW} fixed={1} assumption onNudge={nudge} />

        {/* Scene dots — show the reel is alive and progressing */}
        <div className="col-span-2 flex items-center justify-center gap-2 mt-1">
          {SCENARIOS.map((_, i) => (
            <button
              key={i}
              onClick={() => { nudge(); setSceneIdx(i); }}
              aria-label={"Scenario " + (i + 1)}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: i === sceneIdx ? 22 : 6,
                background: i === sceneIdx ? "var(--power, #38bdf8)" : "rgba(255,255,255,0.18)",
              }}
            />
          ))}
        </div>
      </div>

      {/* Finance payoff */}
      <div className="mt-6 pt-5 border-t border-line">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-sm text-mute mb-1">First-power value unlocked</div>
            <div className="data text-power text-3xl sm:text-4xl font-semibold tracking-tight">{fmtMoney(m.valueM)}</div>
            <div className="data text-[11px] text-faint mt-1">
              {mw} MW · ${revPerMW.toFixed(1)}M/MW-yr · {m.recovered.toFixed(1)} yrs sooner
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-mute mb-1">Cost of waiting</div>
            <div className="data text-queue text-xl sm:text-2xl font-semibold tracking-tight">{fmtPerDay(m.perDay)}<span className="text-faint text-xs ml-1">/ day</span></div>
            <div className="data text-[11px] text-faint mt-1">every day in the queue</div>
          </div>
        </div>
        <div className="text-[10px] text-faint mt-3 leading-relaxed">
          Planning estimate on your inputs — value = capacity × revenue/MW-yr × years recovered.
          Queue, timeline and revenue are editable assumptions, not guarantees. A Power Audit
          replaces them with your site&apos;s real numbers.
        </div>
      </div>
    </div>
  );
}

function Track({ label, sub, tone, fraction, markerLabel }: {
  label: string; sub: string; tone: "queue" | "power"; fraction: number; markerLabel: string;
}) {
  const color = tone === "power" ? "var(--power)" : "var(--queue)";
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-ghost">{label}</span>
        <span className={`eyebrow ${tone === "queue" ? "eyebrow-queue" : ""} text-[10px]`}>{sub}</span>
      </div>
      <div className="relative h-9 rounded-lg bg-[#070b14] border border-line overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-lg"
          style={{
            width: `${fraction * 100}%`,
            background: tone === "power"
              ? "linear-gradient(90deg, rgba(0,229,255,0.25), rgba(0,229,255,0.6))"
              : "linear-gradient(90deg, rgba(255,176,32,0.18), rgba(255,176,32,0.42))",
            borderRight: `2px solid ${color}`,
            transition: "width 0.5s cubic-bezier(0.23,1,0.32,1)",
          }}
        />
        <div
          className="absolute inset-y-0 flex items-center"
          style={{ left: `min(calc(${fraction * 100}% + 8px), calc(100% - 96px))`, transition: "left 0.5s cubic-bezier(0.23,1,0.32,1)" }}
        >
          <span className="data text-[10px] whitespace-nowrap" style={{ color }}>{markerLabel}</span>
        </div>
      </div>
    </div>
  );
}

function Knob({ label, value, unit, min, max, step, onChange, fixed = 0, assumption = false, onNudge }: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  onChange: (v: number) => void; fixed?: number; assumption?: boolean; onNudge?: () => void;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] text-mute flex items-center gap-1">
          {label}
          {assumption && <span className="data text-[8px] text-faint border border-line rounded px-1 py-px">EST</span>}
        </span>
        <span className="data text-power text-[13px]">
          {value.toFixed(fixed)}<span className="text-faint ml-0.5">{unit}</span>
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onPointerDown={onNudge}
        onChange={(e) => { onNudge?.(); onChange(Number(e.target.value)); }}
        className="w-full accent-[#00E5FF] cursor-pointer"
        aria-label={label}
      />
    </label>
  );
}

function LiveEpex({ series, current }: { series: Series | null; current: number | null }) {
  if (!series || series.length < 2 || current == null) {
    return (
      <svg width="104" height="34" viewBox="0 0 104 34" className="hidden sm:block opacity-30" aria-hidden>
        <line x1="0" y1="17" x2="104" y2="17" stroke="var(--line)" strokeWidth="1" strokeDasharray="3 3" />
      </svg>
    );
  }
  const prices = series.map((s) => s.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || 1;
  const W = 104, H = 30;
  const pts = series.map((s, i) => {
    const x = (i / (series.length - 1)) * W;
    const y = H - ((s.price - min) / span) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div className="hidden sm:flex flex-col items-end">
      <div className="data text-[9px] text-faint tracking-[0.14em] mb-1 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-verified animate-pulse" />
        LIVE · EPEX DE
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        <polyline points={pts} fill="none" stroke="var(--queue)" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <div className="data text-[11px] text-ghost mt-0.5">{Math.round(current)}<span className="text-faint text-[9px] ml-0.5">€/MWh now</span></div>
    </div>
  );
}
