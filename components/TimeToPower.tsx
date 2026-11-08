"use client";

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { REDUCED_MOTION_QUERY, autoplayReducer, prefersReducedMotion } from "@/lib/ttp-autoplay";

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
  // Five illustrative stories. The reel glides the four knobs to each target every 10 s; because it calls the real setters, every bar and
  // headline figure animates for free. It follows lib/ttp-autoplay.ts: no autoplay for a visitor who prefers reduced motion, a visible
  // Pause/Play control, and the first change the visitor makes to an input STOPS it for good (it never resumes over their numbers).
  // Illustrative scenarios — none is a named customer or a delivered result.
  // Each names the kind of constraint that binds a hall, not a place or a deal. The transformer story sits at the top of the months knob (the longest
  // value it offers) because a long lead time is the point; no weeks figure is quoted, and the marker reads "(assumed)".
  const SCENARIOS = useMemo(
    () => [
      { title: "Illustrative — busway-bound retrofit", sub: "200 MW contracted, tap-off ampacity binds first", mw: 200, queueYrs: 6.0, onsiteMo: 16, revPerMW: 2.4 },
      { title: "Illustrative — transformer-bound hall", sub: "100 MW contracted; a long transformer lead time (assumed, E0) sets the date", mw: 100, queueYrs: 4.0, onsiteMo: 30, revPerMW: 2.0 },
      { title: "Illustrative — grid-queue-blocked site", sub: "New connection years out, existing hall under-used", mw: 50, queueYrs: 4.5, onsiteMo: 12, revPerMW: 2.2 },
      { title: "Illustrative — floor-loading-bound hall", sub: "300 MW contracted, structural limit sets the ceiling", mw: 300, queueYrs: 3.5, onsiteMo: 11, revPerMW: 2.6 },
      { title: "Your site — placeholder inputs", sub: "Not an engine result: a Density Screen replaces these with your hall's numbers", mw: 150, queueYrs: 5.0, onsiteMo: 14, revPerMW: 2.0 },
    ],
    []
  );
  const [sceneIdx, setSceneIdx] = useState(0);
  const [captionOn, setCaptionOn] = useState(true);
  // Nothing plays until the visitor's motion preference has been read on mount.
  const [mode, dispatch] = useReducer(autoplayReducer, "paused");
  // True once the numbers on screen are the visitor's own, not a scenario's: the caption then says so.
  const [custom, setCustom] = useState(false);
  const reducedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const glideRef = useRef<{ finish: () => void } | null>(null);

  const cancelGlide = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    glideRef.current = null;
    setCaptionOn(true);
  }, []);

  // The first actual CHANGE to an input value stops the reel for good, mid-glide included. (Knob calls this only when the value differs.)
  const nudge = useCallback(() => {
    cancelGlide();
    setCustom(true);
    dispatch({ type: "user_adjusted" });
  }, [cancelGlide]);

  const applyScenario = useCallback((i: number) => {
    const t = SCENARIOS[i];
    setMW(t.mw);
    setQueueYrs(t.queueYrs);
    setOnsiteMo(t.onsiteMo);
    setRevPerMW(t.revPerMW);
  }, [SCENARIOS]);

  // Read the visitor's motion preference, and follow it if it changes while the page is open.
  useEffect(() => {
    reducedRef.current = prefersReducedMotion(window);
    dispatch({ type: "mount", reduced: reducedRef.current });
    let mq: MediaQueryList | null = null;
    try { mq = window.matchMedia(REDUCED_MOTION_QUERY); } catch { /* unreadable: the Pause control is the way out */ }
    const onChange = (e: MediaQueryListEvent) => {
      reducedRef.current = e.matches;
      if (e.matches) glideRef.current?.finish();
      dispatch({ type: "reduced_changed", reduced: e.matches });
    };
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (mode !== "playing") return;
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    function glideTo(next: number) {
      const from = SCENARIOS[sceneIdx];
      const to = SCENARIOS[next];
      const land = () => {
        applyScenario(next);
        setSceneIdx(next);
        setCaptionOn(true);
        rafRef.current = null;
        glideRef.current = null;
      };
      // Reduced motion: jump to the next scenario, no animation frames at all.
      if (reducedRef.current) { land(); return; }
      const dur = 1600;
      const t0 = performance.now();
      setCaptionOn(false);
      glideRef.current = { finish: () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); land(); } };
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
          land();
        }
      };
      rafRef.current = requestAnimationFrame(step);
    }

    const dwellTimer = setTimeout(() => glideTo((sceneIdx + 1) % SCENARIOS.length), 10000);

    return () => {
      clearTimeout(dwellTimer);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [mode, sceneIdx, SCENARIOS, applyScenario]);

  // Pause freezes the reel on a whole scenario, not on a half-way blend of two.
  const pauseReel = () => { glideRef.current?.finish(); dispatch({ type: "pause" }); };
  const playReel = () => dispatch({ type: "play" });
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
          <div data-testid="ttp-caption" className="text-sm text-mute mt-1" style={{ opacity: captionOn ? 1 : 0.25, transition: "opacity 0.5s ease" }}>
            {custom ? (
              <>
                <span className="text-power font-medium">Your inputs</span>
                <span className="mx-1.5 text-faint">·</span>
                Edited by you; not an engine result. A Density Screen replaces them with your hall&apos;s numbers
              </>
            ) : (
              <>
                <span className="text-power font-medium">{SCENARIOS[sceneIdx].title}</span>
                <span className="mx-1.5 text-faint">·</span>
                {SCENARIOS[sceneIdx].sub}
              </>
            )}
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
          label="New grid connection" sub="wait on the utility" tone="queue"
          fraction={m.qFrac} markerLabel={`energized · year ${queueYrs.toFixed(1).replace(/\.0$/, "")} (assumed)`}
        />
        <div className="h-4" />
        <Track
          label="Density unlocked in your existing hall" sub="Headroom Ladder" tone="power"
          fraction={m.oFrac} markerLabel={`unlocked · month ${Math.round(onsiteMo)} (assumed)`}
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
        <Knob label="Headroom Ladder time-to-power (your assumption)" value={onsiteMo} unit="mo" min={9} max={30} step={1} onChange={setOnsiteMo} onNudge={nudge} />
        <Knob label="Revenue / MW-yr" value={revPerMW} unit="$M" min={0.5} max={4} step={0.1} onChange={setRevPerMW} fixed={1} assumption onNudge={nudge} />

        {/* Pause / Play, then the scene dots */}
        <div className="col-span-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mt-1">
          {mode === "stopped" ? (
            <span className="data text-[11px] text-faint" role="status">Autoplay stopped; your inputs are kept.</span>
          ) : mode === "playing" ? (
            <button type="button" onClick={pauseReel} aria-label="Pause scenario autoplay" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-[12px] text-mute hover:text-ghost">
              <Pause size={14} aria-hidden /> Pause
            </button>
          ) : (
            <button type="button" onClick={playReel} aria-label="Play scenario autoplay" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line px-3 text-[12px] text-mute hover:text-ghost">
              <Play size={14} aria-hidden /> Play
            </button>
          )}
          {SCENARIOS.map((_, i) => (
            <button
              key={i}
              onClick={() => { cancelGlide(); dispatch({ type: "scenario_selected" }); setCustom(false); setSceneIdx(i); applyScenario(i); }}
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
          Queue, timeline and revenue are editable assumptions, not guarantees. A Density Screen
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
        onChange={(e) => {
          // Only a value that actually changed is an edit: a press on the thumb that moves nothing leaves the reel alone.
          const next = Number(e.target.value);
          if (next !== value) onNudge?.();
          onChange(next);
        }}
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
