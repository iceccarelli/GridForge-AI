"use client";

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { COMPARATOR } from "@/lib/site";
import { openAudit } from "@/lib/ui";

/**
 * Interactive Time-to-Power comparator.
 *
 * The hero animation makes the gap visceral; this lets a prospect quantify it
 * for THEIR project. Dial in cluster size and the interconnection wait in their
 * market, and it computes months recovered and the revenue-at-risk of waiting.
 *
 * The revenue figure is an explicit, editable ASSUMPTION (anchored to public
 * colo lease ranges, labeled as such) — not a quote and not a GridForge result.
 * onSiteMonths is a planning figure from COMPARATOR, not a guarantee.
 */
export function TimeToPowerComparator() {
  const [mw, setMW] = useState<number>(COMPARATOR.defaultMW);
  const [queueMonths, setQueueMonths] = useState<number>(COMPARATOR.defaultQueueMonths);
  const [revPerMW, setRevPerMW] = useState<number>(COMPARATOR.defaultRevPerMWYear);

  const m = useMemo(() => {
    const onSite = COMPARATOR.onSiteMonths;
    const saved = Math.max(0, queueMonths - onSite);
    const years = saved / 12;
    const revAtRisk = mw * (saved / 12) * revPerMW;
    const span = Math.max(queueMonths, onSite, 1);
    return {
      onSite,
      saved,
      years,
      revAtRisk,
      queueFrac: queueMonths / span,
      onSiteFrac: onSite / span,
    };
  }, [mw, queueMonths, revPerMW]);

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-7 relative">
        <div>
          <div className="eyebrow">FIG. 01B — TIME-TO-POWER, YOUR PROJECT</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            Put your numbers in.
          </h3>
        </div>
        <span className="pill pill-progress shrink-0">PLANNING MODEL</span>
      </div>

      {/* Bars */}
      <div className="relative mb-7">
        <Bar
          label="Grid interconnection queue"
          sub="wait on the utility"
          frac={m.queueFrac}
          marker={`energized · month ${queueMonths}`}
          tone="queue"
        />
        <div className="h-4" />
        <Bar
          label="On-site behind-the-meter"
          sub="GridForge approach"
          frac={m.onSiteFrac}
          marker={`energized · month ${m.onSite}`}
          tone="power"
        />
        <div className="data text-[10px] text-faint mt-2 px-1 text-right">
          MONTHS FROM APPLICATION →
        </div>
      </div>

      {/* Controls */}
      <div className="grid sm:grid-cols-3 gap-5">
        <Slider
          label="Cluster size" value={mw} unit="MW"
          min={COMPARATOR.mwRange[0]} max={COMPARATOR.mwRange[1]} step={5}
          onChange={setMW}
        />
        <Slider
          label="Queue wait in your market" value={queueMonths} unit="mo"
          min={COMPARATOR.queueRange[0]} max={COMPARATOR.queueRange[1]} step={3}
          onChange={setQueueMonths}
        />
        <Slider
          label="Revenue per MW·yr" value={revPerMW} unit="" money
          min={400_000} max={3_000_000} step={100_000}
          onChange={setRevPerMW}
        />
      </div>

      {/* Deltas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-px mt-7 bg-line rounded-xl overflow-hidden border border-line">
        <div className="bg-panel p-5">
          <div className="data text-3xl font-semibold tracking-tight text-power">
            {m.years.toFixed(1)} <span className="text-lg text-mute">yrs</span>
          </div>
          <div className="text-[12px] text-mute mt-1">
            Compute online sooner ({m.saved} months recovered)
          </div>
        </div>
        <div className="bg-panel p-5">
          <div className="data text-3xl font-semibold tracking-tight text-verified">
            {fmtMoney(m.revAtRisk)}
          </div>
          <div className="text-[12px] text-mute mt-1">
            Revenue-at-risk of waiting on the queue
          </div>
        </div>
      </div>

      <div className="mt-5 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint max-w-lg leading-relaxed">
          Revenue assumption is editable ({COMPARATOR.revSource}). On-site figure
          is a planning timeline, not a guarantee — a Power Audit replaces it with
          a defensible date for your site.
        </p>
        <button onClick={() => openAudit("comparator")} className="btn-primary px-4 py-2 rounded-lg text-sm">
          Pressure-test my timeline →
        </button>
      </div>
    </div>
  );
}

function Bar({
  label, sub, frac, marker, tone,
}: {
  label: string; sub: string; frac: number; marker: string; tone: "queue" | "power";
}) {
  const color = tone === "power" ? "var(--power)" : "var(--queue)";
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-ghost">{label}</span>
        <span className={`eyebrow ${tone === "queue" ? "eyebrow-queue" : ""} text-[10px]`}>{sub}</span>
      </div>
      <div className="relative h-9 rounded-lg bg-[#070b14] border border-line overflow-hidden">
        <motion.div
          className="absolute inset-y-0 left-0 rounded-lg"
          style={{
            background:
              tone === "power"
                ? "linear-gradient(90deg, rgba(0,229,255,0.25), rgba(0,229,255,0.6))"
                : "linear-gradient(90deg, rgba(255,176,32,0.18), rgba(255,176,32,0.42))",
            borderRight: `2px solid ${color}`,
          }}
          animate={{ width: `${Math.min(frac, 1) * 100}%` }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
        />
        <div
          className="absolute inset-y-0 flex items-center pointer-events-none"
          style={{ left: `calc(${Math.min(frac, 1) * 100}% + 8px)`, maxWidth: "48%" }}
        >
          <span className="data text-[10px] whitespace-nowrap" style={{ color }}>{marker}</span>
        </div>
      </div>
    </div>
  );
}

function Slider({
  label, value, unit, min, max, step, onChange, money,
}: {
  label: string; value: number; unit: string;
  min: number; max: number; step: number; onChange: (v: number) => void; money?: boolean;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-ghost">{label}</span>
        <span className="data text-power text-sm">
          {money ? fmtMoney(value) : value}
          {unit && <span className="text-faint ml-0.5">{unit}</span>}
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

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `€${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `€${Math.round(n / 1_000)}k`;
  return `€${Math.round(n)}`;
}
