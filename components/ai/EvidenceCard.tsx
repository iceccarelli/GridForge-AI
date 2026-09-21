import { ShieldAlert } from "lucide-react";
import { EvidenceBadge, ProvenanceLine } from "./EvidenceBadge";
import type { EvidenceBlock } from "./types";

/**
 * Surfaces the calibration ledger's actual state. Per the honesty kernel this
 * is non-negotiable: the ledger is empty today, and that must render as a
 * visible fact on every turn that touches capacity/racks/MW/dates — never
 * omitted, never a placeholder number standing in for a real one.
 */
export function EvidenceCard({ block }: { block: EvidenceBlock }) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-3">
        <ShieldAlert size={16} className="text-queue shrink-0" />
        <div className="eyebrow">EVIDENCE &amp; CALIBRATION</div>
      </div>

      <div
        className={`rounded-lg border p-3 mb-3 ${
          block.calibration.empty
            ? "border-queue/40 bg-queue/[0.06]"
            : "border-verified/40 bg-verified/[0.06]"
        }`}
      >
        <div className="text-[13px] text-ghost font-medium">
          {block.calibration.empty
            ? "Calibration ledger: empty"
            : `Calibration ledger: ${block.calibration.sampleSize} field-validated result${
                block.calibration.sampleSize === 1 ? "" : "s"
              }`}
        </div>
        <p className="text-[12px] text-mute mt-1 leading-relaxed">{block.calibration.note}</p>
      </div>

      {block.items.length > 0 && (
        <ul className="space-y-2">
          {block.items.map((it, i) => (
            <li
              key={i}
              className="flex items-start justify-between gap-3 rounded-lg border border-line bg-ink/40 p-2.5"
            >
              <div>
                <div className="text-[13px] text-ghost">{it.label}</div>
                <ProvenanceLine provenance={it.provenance} />
              </div>
              <EvidenceBadge evidenceClass={it.evidenceClass} provenance={it.provenance} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
