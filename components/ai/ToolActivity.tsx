"use client";

import { Check, Loader2, Wrench, X } from "lucide-react";
import type { ToolCall } from "./types";

const TOOL_LABEL: Record<ToolCall["tool"], string> = {
  gridforge_qualify: "Qualify — free constraint read",
  gridforge_screen: "Screen — Density Screen solve",
  gridforge_study: "Study — full envelope study",
  gridforge_portfolio: "Portfolio — multi-hall ranking",
  gridforge_diff: "Diff — before/after comparison",
  gridforge_spec: "Spec — procurement specification",
  gridforge_bids: "Bids — bid comparison",
  gridforge_proposal: "Proposal — commercial proposal",
};

/**
 * Names which real gridforge_* engine tool backed the blocks in a turn. Every
 * numeric card in the canvas should trace back to one of these — this is
 * where that trace is made visible, not asserted in prose.
 */
export function ToolActivity({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-ink/50 px-3 py-2.5 space-y-1.5">
      <div className="eyebrow text-[10px] flex items-center gap-1.5">
        <Wrench size={11} /> TOOL ACTIVITY
      </div>
      {calls.map((c, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]">
          {c.status === "running" && <Loader2 size={12} className="animate-spin text-power shrink-0" />}
          {c.status === "ok" && <Check size={12} className="text-verified shrink-0" />}
          {c.status === "error" && <X size={12} className="text-flag shrink-0" />}
          <span className="data text-ghost">{c.tool}</span>
          <span className="text-faint truncate">{TOOL_LABEL[c.tool]}</span>
          {c.detail && <span className="text-faint">· {c.detail}</span>}
          {c.durationMs != null && (
            <span className="data text-faint ml-auto shrink-0">{c.durationMs}ms</span>
          )}
        </div>
      ))}
    </div>
  );
}
