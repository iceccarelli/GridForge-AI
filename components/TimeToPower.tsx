"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion, useInView } from "framer-motion";

/**
 * The signature element: the time-to-power gap.
 * A grid-interconnection bar crawls across ~6 years; the on-site bar lands at
 * ~18 months. Above it, a spiky GPU load trace with the EMS shaving the peaks.
 * This IS the company thesis, rendered in the vernacular of the subject.
 */
export function TimeToPower() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });

  // years 0..8 grid
  const years = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  return (
    <div ref={ref} className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex items-center justify-between mb-6 relative">
        <div>
          <div className="eyebrow">FIG. 01 — TIME TO POWER</div>
          <div className="text-sm text-mute mt-1">
            Application → energized, typical constrained US market
          </div>
        </div>
        <LoadTrace play={inView} />
      </div>

      {/* Timeline axis */}
      <div className="relative">
        <div className="flex justify-between data text-[10px] text-faint mb-2 px-1">
          {years.map((y) => (
            <span key={y}>{y}</span>
          ))}
        </div>

        {/* Grid queue track */}
        <Track
          label="Grid interconnection queue"
          sub="wait on the utility"
          color="var(--queue)"
          fraction={6.4 / 8}
          markerLabel="energized · year 6+"
          play={inView}
          delay={0.2}
          tone="queue"
        />

        <div className="h-4" />

        {/* On-site track */}
        <Track
          label="On-site behind-the-meter"
          sub="GridForge approach"
          color="var(--power)"
          fraction={1.5 / 8}
          markerLabel="energized · month 18"
          play={inView}
          delay={0.9}
          tone="power"
        />

        <div className="data text-[10px] text-faint mt-2 px-1 text-right">
          YEARS FROM APPLICATION →
        </div>
      </div>

      <div className="mt-6 pt-5 border-t border-line flex items-center justify-between gap-4">
        <div className="text-sm text-mute">
          The gap is the business case.
        </div>
        <div className="data text-power text-2xl sm:text-3xl font-semibold tracking-tight">
          <Countup target={4.5} play={inView} suffix=" yrs" />
          <span className="text-mute text-xs ml-2">recovered</span>
        </div>
      </div>
    </div>
  );
}

function Track({
  label,
  sub,
  color,
  fraction,
  markerLabel,
  play,
  delay,
  tone,
}: {
  label: string;
  sub: string;
  color: string;
  fraction: number;
  markerLabel: string;
  play: boolean;
  delay: number;
  tone: "queue" | "power";
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-ghost">{label}</span>
        <span
          className={`eyebrow ${tone === "queue" ? "eyebrow-queue" : ""} text-[10px]`}
        >
          {sub}
        </span>
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
          initial={{ width: 0 }}
          animate={play ? { width: `${fraction * 100}%` } : { width: 0 }}
          transition={{
            duration: tone === "queue" ? 2.4 : 0.9,
            delay,
            ease: [0.23, 1, 0.32, 1],
          }}
        />
        <motion.div
          className="absolute inset-y-0 flex items-center"
          style={{ left: `calc(${fraction * 100}% + 8px)` }}
          initial={{ opacity: 0 }}
          animate={play ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: delay + (tone === "queue" ? 2.4 : 0.9) }}
        >
          <span
            className="data text-[10px] whitespace-nowrap"
            style={{ color }}
          >
            {markerLabel}
          </span>
        </motion.div>
      </div>
    </div>
  );
}

// Small oscilloscope-style GPU load trace, with the shaved ceiling line.
function LoadTrace({ play }: { play: boolean }) {
  // a spiky path approximating a training/inference load
  const path =
    "M0 24 L8 24 L12 8 L16 24 L24 24 L28 22 L32 6 L36 24 L44 24 L48 12 L52 24 L60 24 L64 9 L68 24 L76 24 L80 20 L84 7 L88 24 L96 24";
  return (
    <svg
      width="104"
      height="34"
      viewBox="0 0 104 34"
      className="hidden sm:block opacity-90"
      aria-hidden
    >
      {/* shaved ceiling */}
      <line
        x1="0"
        y1="11"
        x2="104"
        y2="11"
        stroke="rgba(0,229,255,0.35)"
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      <path
        d={path}
        fill="none"
        stroke="var(--queue)"
        strokeWidth="1.4"
        strokeLinejoin="round"
        className={play ? "trace-path" : ""}
        style={!play ? { strokeDashoffset: 1400 } : undefined}
      />
    </svg>
  );
}

function Countup({
  target,
  play,
  suffix = "",
}: {
  target: number;
  play: boolean;
  suffix?: string;
}) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!play) return;
    let raf = 0;
    const start = performance.now();
    const dur = 1400;
    const tick = (t: number) => {
      const p = Math.min((t - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(parseFloat((eased * target).toFixed(1)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, target]);
  return (
    <span>
      {val.toFixed(1)}
      {suffix}
    </span>
  );
}
