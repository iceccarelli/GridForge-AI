import { AlertTriangle, Gauge } from "lucide-react";
import { EvidenceBadge, ProvenanceLine } from "./EvidenceBadge";
import type { ConstraintBlock } from "./types";

const DOMAIN_LABEL: Record<ConstraintBlock["domain"], string> = {
  electrical: "Electrical",
  thermal: "Thermal",
  physical: "Physical",
  economic: "Economic",
};

export function BindingConstraintCard({ block }: { block: ConstraintBlock }) {
  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          {block.binding ? (
            <AlertTriangle size={16} className="text-queue shrink-0" />
          ) : (
            <Gauge size={16} className="text-mute shrink-0" />
          )}
          <div>
            <div className="eyebrow">{block.binding ? "BINDING CONSTRAINT" : "CONSTRAINT"}</div>
            <h4 className="text-base font-semibold text-ghost mt-0.5">{block.name}</h4>
          </div>
        </div>
        <span className="pill pill-progress shrink-0">{DOMAIN_LABEL[block.domain]}</span>
      </div>

      <p className="text-[13px] text-mute leading-relaxed mb-3">{block.basis}</p>

      <div className="rounded-lg border border-line bg-ink/40 p-3 mb-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] text-faint uppercase tracking-wide">Racks permitted</span>
          <EvidenceBadge evidenceClass={block.maxRacks.evidenceClass} provenance={block.maxRacks.provenance} />
        </div>
        <div className="data text-2xl font-semibold text-ghost mt-1">
          {block.maxRacks.value.toLocaleString()}
          <span className="text-sm text-faint ml-1">{block.maxRacks.unit}</span>
          {block.maxRacks.low != null && block.maxRacks.high != null && (
            <span className="text-xs text-faint ml-2">
              ({block.maxRacks.low.toLocaleString()}–{block.maxRacks.high.toLocaleString()})
            </span>
          )}
        </div>
        <ProvenanceLine provenance={block.maxRacks.provenance} />
      </div>

      {block.relief && (
        <div className="text-[13px] text-ghost border-t border-line pt-3">
          <span className="text-power font-medium">Relief:</span> {block.relief.description}
          {block.relief.leadTimeWeeks && (
            <span className="text-faint">
              {" "}
              · {block.relief.leadTimeWeeks.value} wk lead
            </span>
          )}
        </div>
      )}
    </div>
  );
}
