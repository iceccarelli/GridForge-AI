"use client";

import React, { useEffect, useState } from "react";
import { Pause, Play, ChevronLeft, ChevronRight } from "lucide-react";
import { openAudit } from "@/lib/ui";

/**
 * Cinematic single-line diagram — a 12-stage story in two acts.
 *
 * ACT I "THE PATH" (1–6): how power physically reaches the GPUs — grid intake,
 * step-down, behind-the-meter firming, conditioning, LV distribution, delivery.
 * ACT II "IN OPERATION" (7–12): the live dynamics that justify the design — the
 * load spike, BESS transient absorption, grid ride-through / islanding, price
 * arbitrage (charge), grid services / export, and full EMS orchestration.
 *
 * Original artwork. The architecture is standard power-engineering practice, not
 * a proprietary figure. Every voltage / power / current value is INDICATIVE for a
 * 100 MW-class facility — illustrative, not a spec for any specific site.
 */

type Id = "grid" | "hvmv" | "msb" | "ups" | "mvlv" | "racks" | "cooling" | "gensets" | "bess" | "solar";
type EdgeKey =
  | "gridHv" | "hvMsb" | "msbUps" | "upsMvlv" | "mvlvRacks"
  | "gensetsMsb" | "bessUps" | "solarRacks" | "upsCool";
type Accent = "power" | "queue" | "verified";
type FlowEdge = { k: EdgeKey; rev?: boolean };

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

const LABEL: Record<Id, { label: string; sub?: string }> = {
  grid: { label: "Grid", sub: "230 kV" },
  hvmv: { label: "" },
  msb: { label: "MSB", sub: "main bus" },
  ups: { label: "AC UPS", sub: "conditioning" },
  mvlv: { label: "" },
  racks: { label: "IT racks", sub: "480V → GPUs" },
  cooling: { label: "Cooling", sub: "30–40% load" },
  gensets: { label: "Gensets", sub: "containerized" },
  bess: { label: "BESS", sub: "containerized" },
  solar: { label: "On-site PV", sub: "behind-meter" },
};

const COLOR: Record<Id, string> = {
  grid: "#FFB020", hvmv: "#8A94A6", msb: "#00E5FF", ups: "#00E5FF", mvlv: "#8A94A6",
  racks: "#34D399", cooling: "#8A94A6", gensets: "#FFB020", bess: "#00E5FF", solar: "#34D399",
};

const ACCENT: Record<Accent, string> = { power: "#00E5FF", queue: "#FFB020", verified: "#34D399" };

const EDGES: Record<EdgeKey, string> = {
  gridHv: "M134 179 H168",
  hvMsb: "M238 179 H268",
  msbUps: "M372 179 H420",
  upsMvlv: "M524 179 H560",
  mvlvRacks: "M630 179 H668",
  gensetsMsb: "M320 300 V179",
  bessUps: "M472 300 V208",
  solarRacks: "M718 300 V214",
  upsCool: "M472 150 V82",
};

type Scene = {
  chapter: string; eyebrow: string; title: string; v: string; p: string; i: string; note: string;
  nodes: Id[]; edges: FlowEdge[]; accent?: Accent; gridDown?: boolean;
};

const PATH = "THE PATH";
const OPS = "IN OPERATION";

const SCENES: Scene[] = [
  { chapter: PATH, eyebrow: "SCENE 1 / 12", title: "Grid intake", v: "230 kV", p: "~100 MW", i: "~260 A",
    note: "Utility power crosses the POI — the metered boundary. Everything to the right is invisible to the TSO in real time.",
    nodes: ["grid", "hvmv"], edges: [{ k: "gridHv" }] },
  { chapter: PATH, eyebrow: "SCENE 2 / 12", title: "MV step-down", v: "13.2 kV", p: "~100 MW", i: "~4.6 kA",
    note: "The HV/MV transformer drops transmission voltage onto the medium-voltage main switchboard bus.",
    nodes: ["hvmv", "msb"], edges: [{ k: "hvMsb" }] },
  { chapter: PATH, eyebrow: "SCENE 3 / 12", title: "Behind-the-meter firming", v: "MV bus", p: "firm + storage + PV", i: "—",
    note: "Gensets, BESS and on-site PV inject at the bus. Firm generation is sized to the average; the battery covers the transients — and none of it touches the interconnection queue.",
    nodes: ["gensets", "bess", "solar", "msb"], edges: [{ k: "gensetsMsb" }, { k: "bessUps" }, { k: "solarRacks" }] },
  { chapter: PATH, eyebrow: "SCENE 4 / 12", title: "Conditioning & cooling", v: "MV", p: "IT + ~30–40% cooling", i: "—",
    note: "Power is conditioned through the AC UPS; the BESS rides through sub-second events. Cooling runs as a large parallel draw off the bus.",
    nodes: ["msb", "ups", "cooling", "bess"], edges: [{ k: "msbUps" }, { k: "upsCool" }] },
  { chapter: PATH, eyebrow: "SCENE 5 / 12", title: "LV distribution", v: "480 V", p: "to PDUs", i: "distributed",
    note: "The MV/LV transformer steps down to the 480 V distribution bus feeding the power distribution units.",
    nodes: ["ups", "mvlv"], edges: [{ k: "upsMvlv" }] },
  { chapter: PATH, eyebrow: "SCENE 6 / 12", title: "Delivery to compute", v: "480 V", p: "→ GPU racks", i: "per-rack",
    note: "PDUs feed the racks: 480 V → PSUs → GPUs. The spiky, synchronized training load the entire system is engineered around.",
    nodes: ["mvlv", "racks"], edges: [{ k: "mvlvRacks" }] },

  { chapter: OPS, eyebrow: "SCENE 7 / 12", title: "The load spike", v: "480 V", p: "+~40% in <1 s", i: "transient", accent: "queue",
    note: "A synchronized all-reduce step hits: rack demand jumps ~40% in well under a second. This millisecond transient is exactly what breaks naive grid-only designs.",
    nodes: ["racks", "mvlv"], edges: [{ k: "mvlvRacks" }] },
  { chapter: OPS, eyebrow: "SCENE 8 / 12", title: "BESS catches it", v: "DC → AC", p: "sub-second injection", i: "fast", accent: "power",
    note: "The BESS discharges in milliseconds to absorb the spike before it reaches the generators or the grid — so firm generation stays sized to the average load, not the peak.",
    nodes: ["bess", "ups", "mvlv", "racks"], edges: [{ k: "bessUps" }, { k: "upsMvlv" }, { k: "mvlvRacks" }] },
  { chapter: OPS, eyebrow: "SCENE 9 / 12", title: "Grid ride-through", v: "islanded", p: "on-site carries 100%", i: "—", accent: "queue", gridDown: true,
    note: "A grid disturbance opens the POI. The facility islands on gensets and BESS, and the cluster never drops a step — the resilience hyperscalers actually pay for.",
    nodes: ["gensets", "bess", "msb", "ups", "mvlv", "racks"], edges: [{ k: "gensetsMsb" }, { k: "bessUps" }, { k: "msbUps" }, { k: "upsMvlv" }, { k: "mvlvRacks" }] },
  { chapter: OPS, eyebrow: "SCENE 10 / 12", title: "Arbitrage — charge", v: "grid → BESS", p: "buying low", i: "import", accent: "verified",
    note: "When wholesale power is cheap, the EMS pulls from the grid to charge the BESS — buying low against today's real EPEX curve.",
    nodes: ["grid", "hvmv", "msb", "ups", "bess"], edges: [{ k: "gridHv" }, { k: "hvMsb" }, { k: "msbUps" }, { k: "bessUps", rev: true }] },
  { chapter: OPS, eyebrow: "SCENE 11 / 12", title: "Grid services & export", v: "export", p: "revenue", i: "reverse", accent: "verified",
    note: "At peak prices — or when the operator calls for grid services — stored energy flows back across the POI. The site becomes a revenue center, not just a cost.",
    nodes: ["bess", "gensets", "msb", "hvmv", "grid"], edges: [{ k: "bessUps" }, { k: "msbUps", rev: true }, { k: "hvMsb", rev: true }, { k: "gridHv", rev: true }] },
  { chapter: OPS, eyebrow: "SCENE 12 / 12", title: "EMS orchestration", v: "all sources", p: "balanced live", i: "real-time", accent: "power",
    note: "Every second, the energy-management system arbitrates grid, gensets, BESS and PV — balancing cost, carbon and reliability at once. The whole system, alive.",
    nodes: ["grid", "hvmv", "msb", "ups", "mvlv", "racks", "cooling", "gensets", "bess", "solar"],
    edges: [{ k: "gridHv" }, { k: "hvMsb" }, { k: "msbUps" }, { k: "upsMvlv" }, { k: "mvlvRacks" }, { k: "gensetsMsb" }, { k: "bessUps" }, { k: "solarRacks" }, { k: "upsCool" }] },
];

const NODE_SCENE: Record<Id, number> = {
  grid: 0, hvmv: 1, msb: 2, gensets: 2, bess: 2, solar: 2, ups: 3, cooling: 3, mvlv: 4, racks: 5,
};

const DUR = 3800;

export function SingleLineDiagram() {
  const [scene, setScene] = useState(0);
  const [playing, setPlaying] = useState(true);
  const sc = SCENES[scene];
  const flow = ACCENT[sc.accent ?? "power"];
  const activeNode = (id: Id) => sc.nodes.includes(id);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setScene((s) => (s + 1) % SCENES.length), DUR);
    return () => clearInterval(id);
  }, [playing]);

  const go = (n: number) => { setPlaying(false); setScene((n + SCENES.length) % SCENES.length); };

  const Node = ({ id }: { id: Id }) => {
    const n = NODES[id];
    const down = id === "grid" && !!sc.gridDown;
    const c = down ? "#F87171" : COLOR[id];
    const on = activeNode(id);
    const { label, sub } = LABEL[id];
    return (
      <g
        onClick={() => go(NODE_SCENE[id])}
        style={{ cursor: "pointer", opacity: on ? 1 : down ? 0.5 : 0.26, transition: "opacity 0.6s ease" }}
      >
        <rect
          x={n.x} y={n.y} width={n.w} height={n.h} rx={8}
          fill={on ? `${c}1f` : "#0b1120"}
          stroke={c} strokeWidth={on || down ? 2 : 1}
          strokeDasharray={down ? "5 4" : undefined}
          style={{ filter: on ? `drop-shadow(0 0 10px ${c}88)` : "none", transition: "all 0.5s ease" }}
        />
        <text x={n.x + n.w / 2} y={n.y + (sub ? n.h / 2 - 3 : n.h / 2 + 4)} textAnchor="middle" fill="#F5F7FA" fontSize="11" fontWeight="600" fontFamily="var(--font-sans)">{label}</text>
        {sub && <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 11} textAnchor="middle" fill="#5A6478" fontSize="8.5" fontFamily="var(--font-mono), monospace" letterSpacing="0.05em">{sub}</text>}
      </g>
    );
  };

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <style>{`
        @keyframes gfflow { to { stroke-dashoffset: -120; } }
        @keyframes gfflowrev { to { stroke-dashoffset: 120; } }
        @keyframes gffade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        @keyframes gfbar { from { width: 0%; } to { width: 100%; } }
      `}</style>
      <div className="blueprint absolute inset-0 pointer-events-none opacity-40" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-6 relative">
        <div>
          <div className="eyebrow">FIG. 04 — REFERENCE SINGLE-LINE DIAGRAM</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">Watch the power flow, grid to GPU.</h3>
          <p className="text-sm text-mute mt-1 max-w-lg">A 100 MW-class facility told in twelve stages — from grid intake to live EMS orchestration. Press play, step through, or click any block.</p>
        </div>
        <span className="pill pill-progress shrink-0">ILLUSTRATIVE · INDICATIVE RATINGS</span>
      </div>

      {/* diagram */}
      <div className="rounded-xl border border-line bg-[#070b14] p-2 sm:p-4 relative">
        <svg viewBox="0 0 800 372" className="w-full" role="img" aria-label="Animated single-line diagram">
          <rect x={150} y={0} width={650} height={372} fill="rgba(0,229,255,0.025)" />
          <line x1={150} y1={10} x2={150} y2={362} stroke={sc.gridDown ? "#F87171" : "#00E5FF"} strokeWidth={1.5} strokeDasharray="6 5" opacity={0.7} style={{ transition: "stroke 0.5s" }} />
          <text x={144} y={24} textAnchor="end" fill="#8A94A6" fontSize="8.5" fontFamily="var(--font-mono), monospace">TSO-VISIBLE</text>
          <text x={158} y={24} textAnchor="start" fill="#F87171" fontSize="8.5" fontFamily="var(--font-mono), monospace">BEHIND THE METER — NOT VISIBLE TO TSO IN REAL TIME</text>
          {sc.gridDown ? (
            <>
              <line x1={142} y1={285} x2={158} y2={301} stroke="#F87171" strokeWidth={2} />
              <line x1={158} y1={285} x2={142} y2={301} stroke="#F87171" strokeWidth={2} />
              <text x={150} y={320} textAnchor="middle" fill="#F87171" fontSize="8.5" fontFamily="var(--font-mono), monospace">POI OPEN</text>
            </>
          ) : (
            <text x={150} y={358} textAnchor="middle" fill="#00E5FF" fontSize="8.5" fontFamily="var(--font-mono), monospace">POI</text>
          )}

          {/* base conductors */}
          {(Object.keys(EDGES) as EdgeKey[]).map((k) => (
            <path key={k} d={EDGES[k]} fill="none" stroke="#1E3A52" strokeWidth={2} />
          ))}

          {/* transformer glyphs */}
          {[NODES.hvmv, NODES.mvlv].map((t, idx) => (
            <g key={idx}>
              <circle cx={t.x + t.w / 2 - 8} cy={t.y + t.h / 2} r={9} fill="none" stroke="#8A94A6" strokeWidth={1.2} />
              <circle cx={t.x + t.w / 2 + 8} cy={t.y + t.h / 2} r={9} fill="none" stroke="#8A94A6" strokeWidth={1.2} />
            </g>
          ))}

          {/* animated flow — remounts per scene */}
          <g key={scene}>
            {sc.edges.map((e, idx) => (
              <g key={e.k}>
                <path id={`fp-${scene}-${idx}`} d={EDGES[e.k]} fill="none" stroke={flow} strokeWidth={2.6}
                  strokeLinecap="round" strokeDasharray="6 10"
                  style={{ animation: `${e.rev ? "gfflowrev" : "gfflow"} 1s linear infinite`, filter: `drop-shadow(0 0 4px ${flow})` }} />
                {[0, 0.5].map((b, j) => (
                  <circle key={j} r={3} fill={flow} style={{ filter: `drop-shadow(0 0 5px ${flow})` }}>
                    <animateMotion dur="1.5s" begin={`${b}s`} repeatCount="indefinite" keyPoints={e.rev ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear">
                      <mpath href={`#fp-${scene}-${idx}`} />
                    </animateMotion>
                  </circle>
                ))}
              </g>
            ))}
          </g>

          <Node id="grid" /><Node id="hvmv" /><Node id="msb" /><Node id="ups" /><Node id="mvlv" />
          <Node id="racks" /><Node id="cooling" /><Node id="gensets" /><Node id="bess" /><Node id="solar" />

          <text x={203} y={158} textAnchor="middle" fill="#5A6478" fontSize="8" fontFamily="var(--font-mono), monospace">HV/MV</text>
          <text x={595} y={158} textAnchor="middle" fill="#5A6478" fontSize="8" fontFamily="var(--font-mono), monospace">MV/LV</text>
        </svg>
      </div>

      {/* scene readout */}
      <div key={`r-${scene}`} className="mt-5 rounded-lg border border-line bg-[#0b1120] p-4" style={{ animation: "gffade 0.5s ease" }}>
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className={`pill ${sc.chapter === PATH ? "pill-progress" : "pill-queue"} text-[10px]`}>{sc.chapter}</span>
          <span className="eyebrow text-[10px]">{sc.eyebrow}</span>
          <span className="text-base font-semibold text-ghost">{sc.title}</span>
        </div>
        <div className="grid grid-cols-3 gap-px bg-line rounded-lg overflow-hidden border border-line mb-3">
          <Stat label="Voltage / path" value={sc.v} accent="power" />
          <Stat label="Power (indicative)" value={sc.p} accent="ghost" />
          <Stat label="Current (illustrative)" value={sc.i} accent="queue" />
        </div>
        <p className="text-[14px] text-mute leading-relaxed">{sc.note}</p>
      </div>

      {/* transport controls */}
      <div className="mt-4 flex items-center gap-3">
        <button onClick={() => setPlaying((p) => !p)} className="btn-secondary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-2 shrink-0" aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {playing ? "Pause" : "Play"}
        </button>
        <button onClick={() => go(scene - 1)} className="btn-ghost px-2.5 py-2 rounded-lg shrink-0" aria-label="Previous scene"><ChevronLeft className="w-4 h-4" /></button>
        <div className="flex-1 flex items-center gap-1">
          {SCENES.map((s, idx) => (
            <button key={idx} onClick={() => go(idx)} className="flex-1 h-1.5 rounded-full overflow-hidden bg-line relative" aria-label={`Scene ${idx + 1}: ${s.title}`} title={s.title}>
              {idx < scene && <span className={`absolute inset-0 ${s.chapter === PATH ? "bg-power/50" : "bg-queue/50"}`} />}
              {idx === scene && (
                <span className={`absolute inset-y-0 left-0 ${s.chapter === PATH ? "bg-power" : "bg-queue"}`} style={{ animation: playing ? `gfbar ${DUR}ms linear` : "none", width: "100%" }} />
              )}
            </button>
          ))}
        </div>
        <button onClick={() => go(scene + 1)} className="btn-ghost px-2.5 py-2 rounded-lg shrink-0" aria-label="Next scene"><ChevronRight className="w-4 h-4" /></button>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-faint data">
        <span>ACT I · THE PATH (1–6)</span>
        <span>ACT II · IN OPERATION (7–12)</span>
      </div>

      {/* deployment building blocks */}
      <div className="mt-7">
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
          Illustrative reference — indicative ratings, not a site spec. Currents shown are
          order-of-magnitude for a 100 MW-class facility. Training-cluster power signatures
          grounded in published profiles (Uptime Institute, 2025); capacity-demand context
          from industry studies (McKinsey, IDC, Gartner). A Feasibility Study produces the
          bankable single-line and ratings for your site.
        </p>
        <button
          onClick={() =>
            openAudit("single-line", {
              service: "Integration Design & Engineering",
              summary: `Reviewing the single-line reference design (was on "${
                SCENES[scene]?.title ?? "the walkthrough"
              }"). Want a bankable single-line and equipment ratings for our site.`,
            })
          }
          className="btn-primary px-4 py-2 rounded-lg text-sm shrink-0"
        >
          Scope this for my site →
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: "power" | "ghost" | "queue" }) {
  const color = accent === "power" ? "text-power" : accent === "queue" ? "text-queue" : "text-ghost";
  return (
    <div className="bg-panel p-3">
      <div className={`data text-base font-semibold ${color}`}>{value}</div>
      <div className="text-[10px] text-mute mt-0.5">{label}</div>
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
