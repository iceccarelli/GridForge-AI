"use client";

import React, { useState } from "react";
import { openAudit } from "@/lib/ui";

/**
 * Reference single-line diagram (SLD) of a data-center internal power system.
 *
 * Original artwork. The architecture shown — grid → POI/metering boundary →
 * switchboard → UPS → distribution → PDU/racks, with behind-the-meter gensets,
 * BESS, PV and cooling — is standard power-engineering practice, not anyone's
 * proprietary figure. Ratings are INDICATIVE planning ranges, not a spec for a
 * specific site. Click a block to see its role.
 */

type Id = "grid" | "hvmv" | "msb" | "ups" | "mvlv" | "racks" | "cooling" | "gensets" | "bess" | "solar";

const DETAIL: Record<Id, { label: string; rating: string; behind: boolean; role: string }> = {
  grid: {
    label: "Utility grid",
    rating: "~230 kV transmission (indicative)",
    behind: false,
    role: "The utility feed across the point of interconnection. Subject to the multi-year interconnection queue — the exact constraint behind-the-meter generation is built to bypass.",
  },
  hvmv: {
    label: "HV/MV transformer",
    rating: "~230 / 13.2 kV (indicative)",
    behind: false,
    role: "Steps transmission voltage down to the medium-voltage distribution level feeding the facility switchboard.",
  },
  msb: {
    label: "Main switchboard",
    rating: "MV main bus",
    behind: true,
    role: "The coupling point where the grid feed, on-site generation and storage meet. The EMS arbitrates sources here — this is where 'behind the meter' begins.",
  },
  ups: {
    label: "AC UPS / conditioning",
    rating: "~80 × 3 MVA class (indicative)",
    behind: true,
    role: "Power conditioning and ride-through for sub-cycle events. The BESS sits alongside for the longer sub-second to multi-second transients the racks throw.",
  },
  mvlv: {
    label: "MV/LV transformer",
    rating: "~13.2 kV / 480 V (indicative)",
    behind: true,
    role: "Steps medium voltage down to the low-voltage distribution bus that feeds the PDUs.",
  },
  racks: {
    label: "PDU → IT racks",
    rating: "480 V → PSUs → GPUs",
    behind: true,
    role: "The compute halls — racked GPUs drawing the spiky, synchronized training load the entire power system is engineered around.",
  },
  cooling: {
    label: "Cooling plant",
    rating: "~30–40% of total load",
    behind: true,
    role: "A large, somewhat steadier draw running alongside the racks. Often overlooked in firm-power sizing, but it materially shifts the load profile.",
  },
  gensets: {
    label: "Containerized gensets",
    rating: "indicative N × 3 MW",
    behind: true,
    role: "Gas or diesel generation in skids/containers — firm baseload and backup, dispatchable on-site without touching the interconnection queue.",
  },
  bess: {
    label: "Containerized BESS",
    rating: "Li-ion · ~15–60 min (indicative)",
    behind: true,
    role: "Battery storage in containers — sub-second transient absorption plus price arbitrage. The fast layer that lets firm generation stay sized to the average, not the peak.",
  },
  solar: {
    label: "On-site PV",
    rating: "behind-the-meter solar",
    behind: true,
    role: "Cuts energy cost and carbon intensity when the sun is up; firmed by gensets and BESS so the cluster never feels the intermittency.",
  },
};

const NODES: Record<Id, { x: number; y: number; w: number; h: number }> = {
  grid: { x: 24, y: 150, w: 110, h: 58 },
  hvmv: { x: 168, y: 162, w: 70, h: 34 },
  msb: { x: 268, y: 150, w: 104, h: 58 },
  ups: { x: 420, y: 150, w: 104, h: 58 },
  mvlv: { x: 560, y: 162, w: 70, h: 34 },
  racks: { x: 668, y: 144, w: 116, h: 70 },
  cooling: { x: 420, y: 36, w: 104, h: 46 },
  gensets: { x: 268, y: 300, w: 104, h: 52 },
  bess: { x: 420, y: 300, w: 104, h: 52 },
  solar: { x: 660, y: 300, w: 116, h: 52 },
};

const COLOR: Record<Id, string> = {
  grid: "#FFB020", hvmv: "#8A94A6", msb: "#00E5FF", ups: "#00E5FF", mvlv: "#8A94A6",
  racks: "#34D399", cooling: "#8A94A6", gensets: "#FFB020", bess: "#00E5FF", solar: "#34D399",
};

const POI_X = 150;

export function SingleLineDiagram() {
  const [sel, setSel] = useState<Id>("bess");
  const d = DETAIL[sel];

  const Node = ({ id, label, sub }: { id: Id; label: string; sub?: string }) => {
    const n = NODES[id];
    const c = COLOR[id];
    const active = sel === id;
    return (
      <g onClick={() => setSel(id)} style={{ cursor: "pointer" }}>
        <rect
          x={n.x} y={n.y} width={n.w} height={n.h} rx={8}
          fill={active ? `${c}1a` : "#0b1120"}
          stroke={c} strokeWidth={active ? 2 : 1}
          style={{ filter: active ? `drop-shadow(0 0 8px ${c}66)` : "none", transition: "all 0.25s" }}
        />
        <text x={n.x + n.w / 2} y={n.y + (sub ? n.h / 2 - 3 : n.h / 2 + 4)} textAnchor="middle" fill="#F5F7FA" fontSize="11" fontWeight="600" fontFamily="var(--font-sans)">{label}</text>
        {sub && <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 11} textAnchor="middle" fill="#5A6478" fontSize="8.5" fontFamily="var(--font-mono), monospace" letterSpacing="0.05em">{sub}</text>}
      </g>
    );
  };

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="blueprint absolute inset-0 pointer-events-none opacity-40" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-6 relative">
        <div>
          <div className="eyebrow">FIG. 04 — REFERENCE SINGLE-LINE DIAGRAM</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">The system, end to end.</h3>
          <p className="text-sm text-mute mt-1 max-w-lg">A 100 MW-class behind-the-meter facility. Click any block to see what it does and why it&apos;s there.</p>
        </div>
        <span className="pill pill-progress shrink-0">ILLUSTRATIVE · INDICATIVE RATINGS</span>
      </div>

      {/* diagram */}
      <div className="rounded-xl border border-line bg-[#070b14] p-2 sm:p-4">
        <svg viewBox="0 0 800 372" className="w-full" role="img" aria-label="Single-line diagram">
          {/* behind-the-meter shaded region */}
          <rect x={POI_X} y={0} width={800 - POI_X} height={372} fill="rgba(0,229,255,0.025)" />
          {/* POI boundary */}
          <line x1={POI_X} y1={10} x2={POI_X} y2={362} stroke="#00E5FF" strokeWidth={1.5} strokeDasharray="6 5" opacity={0.7} />
          <text x={POI_X - 6} y={24} textAnchor="end" fill="#8A94A6" fontSize="8.5" fontFamily="var(--font-mono), monospace">TSO-VISIBLE</text>
          <text x={POI_X + 8} y={24} textAnchor="start" fill="#F87171" fontSize="8.5" fontFamily="var(--font-mono), monospace">BEHIND THE METER — NOT VISIBLE TO TSO IN REAL TIME</text>
          <text x={POI_X} y={358} textAnchor="middle" fill="#00E5FF" fontSize="8.5" fontFamily="var(--font-mono), monospace">POI</text>

          {/* main bus */}
          <polyline points="134,179 668,179" fill="none" stroke="#1E3A52" strokeWidth={2} />
          {/* drops */}
          <polyline points="472,82 472,150" fill="none" stroke="#1E3A52" strokeWidth={1.5} />
          <polyline points="320,300 320,179" fill="none" stroke="#1E3A52" strokeWidth={1.5} />
          <polyline points="472,300 472,208" fill="none" stroke="#1E3A52" strokeWidth={1.5} />
          <polyline points="718,300 718,214" fill="none" stroke="#1E3A52" strokeWidth={1.5} />

          {/* transformer glyphs */}
          {[NODES.hvmv, NODES.mvlv].map((t, i) => (
            <g key={i}>
              <circle cx={t.x + t.w / 2 - 8} cy={t.y + t.h / 2} r={9} fill="none" stroke="#8A94A6" strokeWidth={1.2} />
              <circle cx={t.x + t.w / 2 + 8} cy={t.y + t.h / 2} r={9} fill="none" stroke="#8A94A6" strokeWidth={1.2} />
            </g>
          ))}

          <Node id="grid" label="Grid" sub="230 kV" />
          <Node id="hvmv" label="" />
          <Node id="msb" label="MSB" sub="main bus" />
          <Node id="ups" label="AC UPS" sub="conditioning" />
          <Node id="mvlv" label="" />
          <Node id="racks" label="IT racks" sub="480V → GPUs" />
          <Node id="cooling" label="Cooling" sub="30–40% load" />
          <Node id="gensets" label="Gensets" sub="containerized" />
          <Node id="bess" label="BESS" sub="containerized" />
          <Node id="solar" label="On-site PV" sub="behind-meter" />

          <text x={203} y={158} textAnchor="middle" fill="#5A6478" fontSize="8" fontFamily="var(--font-mono), monospace">HV/MV</text>
          <text x={595} y={158} textAnchor="middle" fill="#5A6478" fontSize="8" fontFamily="var(--font-mono), monospace">MV/LV</text>
        </svg>
      </div>

      {/* detail panel */}
      <div className="mt-5 rounded-lg border border-line bg-[#0b1120] p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-ghost">{d.label}</span>
          <span className="data text-[11px] text-mute">· {d.rating}</span>
          <span className={`pill ${d.behind ? "pill-progress" : "pill-queue"} text-[10px]`}>{d.behind ? "BEHIND THE METER" : "TSO-VISIBLE"}</span>
        </div>
        <p className="text-[14px] text-mute leading-relaxed mt-2">{d.role}</p>
      </div>

      {/* deployment building blocks */}
      <div className="mt-6">
        <div className="eyebrow text-[10px] mb-3">PHYSICAL BUILDING BLOCKS</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {BLOCKS.map((b) => (
            <div key={b.title} className="rounded-lg border border-line bg-[#0b1120] p-3">
              <svg viewBox="0 0 60 40" className="w-12 h-8 mb-2">{b.icon}</svg>
              <div className="text-[13px] font-semibold text-ghost">{b.title}</div>
              <div className="text-[11px] text-faint mt-0.5 leading-snug">{b.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* references + CTA */}
      <div className="mt-6 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint max-w-xl leading-relaxed">
          Illustrative reference — indicative ratings, not a site spec. Training-cluster
          power signatures grounded in published profiles (Uptime Institute, 2025);
          capacity-demand context from industry studies (McKinsey, IDC, Gartner). A
          Feasibility Study produces the bankable single-line and ratings for your site.
        </p>
        <button onClick={() => openAudit("single-line")} className="btn-primary px-4 py-2 rounded-lg text-sm shrink-0">
          Scope this for my site →
        </button>
      </div>
    </div>
  );
}

const BLOCKS: { title: string; sub: string; icon: React.ReactNode }[] = [
  {
    title: "Containerized BESS",
    sub: "Li-ion racks in a 20–40 ft container",
    icon: (
      <>
        <rect x="6" y="10" width="48" height="22" rx="2" fill="#0b1120" stroke="#00E5FF" strokeWidth="1.4" />
        {[12, 22, 32, 42].map((x) => <rect key={x} x={x} y="14" width="6" height="14" rx="1" fill="#00E5FF" opacity="0.4" />)}
      </>
    ),
  },
  {
    title: "Genset skid",
    sub: "Gas / diesel, containerized",
    icon: (
      <>
        <rect x="6" y="12" width="36" height="20" rx="2" fill="#0b1120" stroke="#FFB020" strokeWidth="1.4" />
        <circle cx="48" cy="22" r="6" fill="none" stroke="#FFB020" strokeWidth="1.4" />
        <line x1="42" y1="22" x2="42" y2="22" stroke="#FFB020" />
      </>
    ),
  },
  {
    title: "Racked compute hall",
    sub: "GPU racks + PDUs",
    icon: (
      <>
        {[8, 24, 40].map((x) => (
          <g key={x}>
            <rect x={x} y="8" width="12" height="26" rx="1" fill="#0b1120" stroke="#34D399" strokeWidth="1.2" />
            {[11, 16, 21, 26].map((y) => <line key={y} x1={x + 2} y1={y} x2={x + 10} y2={y} stroke="#34D399" strokeWidth="0.8" opacity="0.5" />)}
          </g>
        ))}
      </>
    ),
  },
  {
    title: "Outdoor MV skid",
    sub: "Switchgear + transformers",
    icon: (
      <>
        <rect x="6" y="14" width="20" height="18" rx="2" fill="#0b1120" stroke="#8A94A6" strokeWidth="1.4" />
        <circle cx="40" cy="22" r="7" fill="none" stroke="#8A94A6" strokeWidth="1.4" />
        <circle cx="50" cy="22" r="7" fill="none" stroke="#8A94A6" strokeWidth="1.4" />
      </>
    ),
  },
];
