import { HelpCircle } from "lucide-react";
import type { MissingInputBlock } from "./types";

export function MissingInputCard({ block }: { block: MissingInputBlock }) {
  return (
    <div className="panel p-5 border-queue/30">
      <div className="flex items-start gap-2 mb-2">
        <HelpCircle size={16} className="text-queue shrink-0 mt-0.5" />
        <div>
          <div className="eyebrow eyebrow-queue">
            {block.required ? "MISSING INPUT — REQUIRED" : "MISSING INPUT"}
          </div>
          <h4 className="text-base font-semibold text-ghost mt-0.5">
            {block.input}
            {block.unit && <span className="text-faint font-normal"> ({block.unit})</span>}
          </h4>
        </div>
      </div>

      <p className="text-[13px] text-mute leading-relaxed mb-2">{block.whyItBinds}</p>

      {block.assumed && (
        <div className="text-[12px] text-faint mb-2">
          Assumed for now: <span className="text-ghost">{block.assumed}</span> (E0, until you give us
          the real figure)
        </div>
      )}

      <div className="rounded-lg border border-line bg-ink/40 p-3 text-[13px] text-ghost">
        <span className="text-power font-medium">How to get it:</span> {block.howToGetIt}
      </div>
    </div>
  );
}
