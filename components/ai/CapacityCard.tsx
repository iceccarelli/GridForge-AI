import { ArrowRight, Server } from "lucide-react";
import { EvidenceBadge, ProvenanceLine } from "./EvidenceBadge";
import type { CapacityMetricBlock } from "./types";

export function CapacityCard({ block }: { block: CapacityMetricBlock }) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-3">
        <Server size={16} className="text-power shrink-0" />
        <div>
          <div className="eyebrow">HALL CAPACITY</div>
          <h4 className="text-base font-semibold text-ghost mt-0.5">{block.hallLabel}</h4>
        </div>
      </div>

      <div className="text-[12px] text-faint mb-3">Platform: {block.platform}</div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-line rounded-xl overflow-hidden border border-line">
        <div className="bg-panel p-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-faint uppercase tracking-wide">As found</span>
            <EvidenceBadge
              evidenceClass={block.racksAsFound.evidenceClass}
              provenance={block.racksAsFound.provenance}
            />
          </div>
          <div className="data text-3xl font-semibold text-ghost">
            {block.racksAsFound.value.toLocaleString()}
            <span className="text-sm text-faint ml-1">racks</span>
          </div>
          <ProvenanceLine provenance={block.racksAsFound.provenance} />
        </div>

        {block.racksAfterRelief && (
          <div className="bg-panel p-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] text-faint uppercase tracking-wide">After relief</span>
              <EvidenceBadge
                evidenceClass={block.racksAfterRelief.evidenceClass}
                provenance={block.racksAfterRelief.provenance}
              />
            </div>
            <div className="data text-3xl font-semibold text-verified">
              {block.racksAfterRelief.value.toLocaleString()}
              <span className="text-sm text-faint ml-1">racks</span>
            </div>
            <ProvenanceLine provenance={block.racksAfterRelief.provenance} />
          </div>
        )}
      </div>

      {block.racksAfterRelief && block.racksAfterRelief.value > block.racksAsFound.value && (
        <div className="mt-3 flex items-center gap-1.5 text-[12px] text-mute">
          <ArrowRight size={13} className="text-power" />
          {(block.racksAfterRelief.value - block.racksAsFound.value).toLocaleString()} more racks
          on the ladder
        </div>
      )}

      {block.itLoadKW && (
        <div className="mt-3 pt-3 border-t border-line flex items-center justify-between text-[12px]">
          <span className="text-faint">IT load</span>
          <span className="data text-ghost">
            {block.itLoadKW.value.toLocaleString()} {block.itLoadKW.unit}
          </span>
        </div>
      )}
    </div>
  );
}
