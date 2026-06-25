"use client";

import { useState } from "react";
import { SITING_REGIONS, sitingScore, costOfDelay, eurCompact } from "@/lib/siting";

// Public cost-of-delay demo for the /intelligence sales page. Same model as the
// subscriber dashboard, so the number a prospect sees here is the real one.
// Read-only: no save, no brief, no auth — just the visceral euros-unlocked moment.
export function DelayDemo() {
  const [mw, setMw] = useState(100);
  const ranked = [...SITING_REGIONS]
    .map((r) => ({ ...r, score: sitingScore(r) }))
    .sort((a, b) => b.score - a.score);
  const [regionId, setRegionId] = useState(
    ranked.find((r) => r.id === "pjm-va")?.id ?? ranked[0].id
  );
  const region = ranked.find((r) => r.id === regionId) ?? ranked[0];
  const d = costOfDelay(mw, region, 25000);
  const pct = d.queueCostEur > 0 ? (d.btmCostEur / d.queueCostEur) * 100 : 0;

  return (
    <div className="rounded-[var(--radius)] border border-power/30 bg-power/[0.03] p-7">
      <div className="flex items-center justify-between mb-1">
        <div className="eyebrow text-power">See it live</div>
        <div className="data text-[10px] text-faint">no signup required</div>
      </div>
      <h2 className="text-xl font-semibold tracking-tight">What the queue is costing you</h2>
      <p className="text-mute text-[13px] mt-1 mb-5">
        Drag your site size, pick a market. This is the exact model subscribers use —
        live for you, right now.
      </p>

      <div className="grid sm:grid-cols-2 gap-5 mb-6">
        <div>
          <label className="data text-[10px] text-faint">SITE SIZE — {mw} MW</label>
          <input type="range" min={5} max={500} step={5} value={mw} onChange={(e) => setMw(Number(e.target.value))} className="w-full mt-2 accent-[color:var(--power,#38bdf8)]" />
        </div>
        <div>
          <label className="data text-[10px] text-faint">MARKET</label>
          <select value={regionId} onChange={(e) => setRegionId(e.target.value)} className="w-full mt-2 bg-ink border border-line rounded-lg px-3 py-2 text-[13px] text-white focus:border-power/50 focus:outline-none">
            {ranked.map((r) => <option key={r.id} value={r.id}>{r.region}</option>)}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-power/30 bg-power/[0.05] p-5">
        <div className="data text-[10px] text-faint">BEHIND-THE-METER UNLOCKS</div>
        <div className="text-4xl md:text-5xl font-semibold text-power tracking-tight mt-1">{eurCompact(d.avoidedEur)}</div>
        <div className="text-mute text-[13px] mt-1">{d.monthsSaved} months sooner to revenue — {mw} MW in {region.region}.</div>
      </div>

      <div className="mt-5 space-y-2">
        <div className="flex items-center gap-3">
          <div className="data text-[10px] text-faint w-24 shrink-0">QUEUE PATH</div>
          <div className="flex-1 h-7 rounded bg-queue/20 border border-queue/30 flex items-center px-3">
            <span className="data text-[11px] text-queue">{region.queueWaitMonths}mo · {eurCompact(d.queueCostEur)} stranded</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="data text-[10px] text-faint w-24 shrink-0">BTM PATH</div>
          <div className="h-7 rounded bg-power/20 border border-power/30 flex items-center px-3" style={{ width: `${Math.max(18, pct)}%` }}>
            <span className="data text-[11px] text-power whitespace-nowrap">{region.btmMonths}mo · {eurCompact(d.btmCostEur)}</span>
          </div>
        </div>
      </div>
      <p className="data text-[10px] text-faint mt-4">
        Subscribe for live + published ISO queue data across all markets, an AI siting analyst,
        saved scenarios, and downloadable board briefs. Directional; a paid Audit confirms.
      </p>
    </div>
  );
}
