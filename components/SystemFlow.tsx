"use client";

import React, { useEffect, useState } from "react";
import { Play, Pause, ChevronLeft, ChevronRight } from "lucide-react";
import { openAudit } from "@/lib/ui";

/**
 * System-flow explainer. Walks a buyer through the *sequence of events* when a
 * training spike hits a behind-the-meter cluster: baseline → spike → EMS detects
 * → BESS catches it (<1s) → fuel cell ramps → absorbed. Each step highlights the
 * active components and the energy path, with a plain-language caption.
 *
 * Deliberately 2D and instrument-grade — the goal is comprehension and trust,
 * not spectacle. The timings stated are ordinary equipment-class behaviour, not
 * a spec for a specific product.
 */

type NodeId = "grid" | "gas" | "fuel" | "bess" | "ems" | "dc" | "racks";
type EdgeId = "gas-dc" | "fuel-dc" | "bess-dc" | "dc-racks" | "grid-dc" | "ems-gas" | "ems-fuel" | "ems-bess" | "ems-dc";

const STEPS: {
  title: string;
  caption: string;
  nodes: NodeId[];
  edges: EdgeId[];
  rackLoad: "steady" | "spike";
}[] = [
  {
    title: "Baseline",
    caption:
      "Steady state. Gas baseload and the fuel cell serve the cluster entirely behind the meter. The grid sits in standby — no queue, no multi-year wait.",
    nodes: ["gas", "fuel", "dc", "racks"],
    edges: ["gas-dc", "fuel-dc", "dc-racks"],
    rackLoad: "steady",
  },
  {
    title: "Training spike",
    caption:
      "A checkpoint or all-reduce step hits. The cluster's draw jumps in milliseconds — the kind of sharp transient steady-load power design never plans for.",
    nodes: ["racks", "dc"],
    edges: ["dc-racks"],
    rackLoad: "spike",
  },
  {
    title: "EMS detects",
    caption:
      "The physics-informed EMS sees the transient from telemetry and physics — early enough to act before it cascades into a brownout or a grid call.",
    nodes: ["ems", "racks"],
    edges: ["ems-dc", "ems-bess"],
    rackLoad: "spike",
  },
  {
    title: "BESS catches it",
    caption:
      "The battery discharges in under a second — fast enough to absorb the spike instantly. No flicker at the rack, no demand charge, no call on the grid.",
    nodes: ["bess", "dc", "racks", "ems"],
    edges: ["bess-dc", "dc-racks", "ems-bess"],
    rackLoad: "spike",
  },
  {
    title: "Fuel cell ramps",
    caption:
      "Over the next few seconds the fuel cell ramps to take over from the battery, recharging it and holding the new load — firming the spike for as long as it lasts.",
    nodes: ["fuel", "bess", "dc", "ems"],
    edges: ["fuel-dc", "bess-dc", "ems-fuel"],
    rackLoad: "spike",
  },
  {
    title: "Absorbed",
    caption:
      "Spike handled end-to-end, behind the meter, in seconds. Firm power every millisecond — without ever touching the interconnection queue. That's the whole thesis, working.",
    nodes: ["gas", "fuel", "bess", "dc", "racks", "ems"],
    edges: ["gas-dc", "fuel-dc", "dc-racks"],
    rackLoad: "steady",
  },
];

const NODES: Record<NodeId, { x: number; y: number; w: number; h: number; label: string; sub?: string }> = {
  grid: { x: 16, y: 150, w: 104, h: 56, label: "Grid", sub: "standby" },
  gas: { x: 176, y: 56, w: 128, h: 52, label: "Gas baseload" },
  fuel: { x: 176, y: 150, w: 128, h: 52, label: "Fuel cell" },
  bess: { x: 176, y: 244, w: 128, h: 52, label: "BESS" },
  ems: { x: 300, y: 8, w: 180, h: 40, label: "EMS", sub: "physics-informed" },
  dc: { x: 392, y: 150, w: 110, h: 52, label: "DC bus" },
  racks: { x: 560, y: 138, w: 124, h: 78, label: "GPU racks" },
};

const EDGES: Record<EdgeId, { pts: string; control?: boolean }> = {
  "gas-dc": { pts: "304,82 348,82 348,168 392,168" },
  "fuel-dc": { pts: "304,176 392,176" },
  "bess-dc": { pts: "304,270 348,270 348,184 392,184" },
  "dc-racks": { pts: "502,176 560,176" },
  "grid-dc": { pts: "68,206 68,318 447,318 447,202" },
  "ems-gas": { pts: "360,48 360,82 304,82", control: true },
  "ems-fuel": { pts: "390,48 390,176 304,176", control: true },
  "ems-bess": { pts: "360,48 360,270 304,270", control: true },
  "ems-dc": { pts: "447,48 447,150", control: true },
};

export function SystemFlow() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 2600);
    return () => clearInterval(id);
  }, [playing]);

  const cur = STEPS[step];
  const nodeOn = (id: NodeId) => cur.nodes.includes(id);
  const edgeOn = (id: EdgeId) => cur.edges.includes(id);

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-6 relative">
        <div>
          <div className="eyebrow">SEQUENCE OF EVENTS · SPIKE RESPONSE</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            How the system catches a spike.
          </h3>
        </div>
        <span className="data text-[11px] text-faint">
          step {step + 1} / {STEPS.length}
        </span>
      </div>

      {/* schematic */}
      <div className="rounded-xl border border-line bg-[#070b14] p-2 sm:p-4">
        <svg viewBox="0 0 700 336" className="w-full" role="img" aria-label="System flow schematic">
          {/* edges first (under nodes) */}
          {(Object.keys(EDGES) as EdgeId[]).map((id) => {
            const e = EDGES[id];
            const on = edgeOn(id);
            const isGrid = id === "grid-dc";
            return (
              <polyline
                key={id}
                points={e.pts}
                fill="none"
                stroke={
                  isGrid
                    ? "rgba(255,176,32,0.18)"
                    : e.control
                    ? on
                      ? "rgba(167,139,250,0.9)"
                      : "rgba(167,139,250,0.15)"
                    : on
                    ? "var(--power)"
                    : "rgba(0,229,255,0.15)"
                }
                strokeWidth={e.control ? 1 : on ? 2 : 1.2}
                strokeDasharray={e.control || isGrid ? "4 4" : on ? "6 6" : undefined}
                className={on && !e.control && !isGrid ? "flow-active" : ""}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}

          {/* nodes */}
          {(Object.keys(NODES) as NodeId[]).map((id) => {
            const n = NODES[id];
            const on = nodeOn(id);
            const isGrid = id === "grid";
            const isRacks = id === "racks";
            const stroke = isGrid
              ? "#FFB020"
              : id === "ems"
              ? "#A78BFA"
              : id === "bess"
              ? "#00E5FF"
              : "#00E5FF";
            return (
              <g key={id} opacity={isGrid ? 0.55 : on ? 1 : 0.4} style={{ transition: "opacity 0.4s" }}>
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={n.h}
                  rx={10}
                  fill={on && !isGrid ? "rgba(0,229,255,0.06)" : "#0b1120"}
                  stroke={stroke}
                  strokeWidth={on && !isGrid ? 1.8 : 1}
                  style={{ filter: on && !isGrid ? `drop-shadow(0 0 8px ${stroke}66)` : "none", transition: "all 0.4s" }}
                />
                <text
                  x={n.x + n.w / 2}
                  y={n.sub ? n.y + n.h / 2 - 2 : n.y + n.h / 2 + 4}
                  textAnchor="middle"
                  fill="#F5F7FA"
                  fontSize="12"
                  fontWeight="600"
                  fontFamily="var(--font-sans)"
                >
                  {n.label}
                </text>
                {n.sub && (
                  <text
                    x={n.x + n.w / 2}
                    y={n.y + n.h / 2 + 12}
                    textAnchor="middle"
                    fill="#5A6478"
                    fontSize="9"
                    fontFamily="var(--font-mono), monospace"
                    letterSpacing="0.1em"
                  >
                    {n.sub.toUpperCase()}
                  </text>
                )}
                {/* rack load indicator */}
                {isRacks && (
                  <rect
                    x={n.x + 12}
                    y={cur.rackLoad === "spike" ? n.y + 14 : n.y + 50}
                    width={n.w - 24}
                    height={cur.rackLoad === "spike" ? n.h - 60 : 10}
                    rx={3}
                    fill={cur.rackLoad === "spike" ? "#F87171" : "#34D399"}
                    opacity={0.8}
                    style={{ transition: "all 0.45s cubic-bezier(0.23,1,0.32,1)" }}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* caption */}
      <div className="mt-5 min-h-[88px]">
        <div className="eyebrow text-[11px] text-power">{cur.title}</div>
        <p className="text-[15px] text-ghost leading-relaxed mt-2">{cur.caption}</p>
      </div>

      {/* controls */}
      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={() => {
            setPlaying(false);
            setStep((s) => (s - 1 + STEPS.length) % STEPS.length);
          }}
          className="btn-ghost p-2 rounded-lg border border-line"
          aria-label="Previous step"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => setPlaying((p) => !p)}
          className="btn-secondary px-4 py-2 rounded-lg text-sm inline-flex items-center gap-2"
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            setStep((s) => (s + 1) % STEPS.length);
          }}
          className="btn-ghost p-2 rounded-lg border border-line"
          aria-label="Next step"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-1.5 ml-2">
          {STEPS.map((s, i) => (
            <button
              key={i}
              onClick={() => {
                setPlaying(false);
                setStep(i);
              }}
              aria-label={`Go to step ${i + 1}: ${s.title}`}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-power" : "w-1.5 bg-line hover:bg-mute"
              }`}
            />
          ))}
        </div>

        <button onClick={() => openAudit("system-flow")} className="btn-primary px-4 py-2 rounded-lg text-sm ml-auto shrink-0">
          Design this for my site →
        </button>
      </div>
    </div>
  );
}
