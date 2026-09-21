import { EVIDENCE_CLASS_LABEL, type EvidenceClass, type Provenance } from "./types";

/**
 * Every numeric card in the workspace wears one of these. It is the visible
 * half of the honesty kernel: a reader can always see how a number was
 * arrived at (E0 assumed .. E7 observed in operation) and which engine call
 * produced it, without leaving the card.
 */
export function EvidenceBadge({
  evidenceClass,
  provenance,
}: {
  evidenceClass: EvidenceClass;
  provenance?: Provenance;
}) {
  const low = evidenceClass === "E0" || evidenceClass === "E1" || evidenceClass === "E2";
  const tone = low ? "pill-queue" : evidenceClass >= "E5" ? "pill-verified" : "pill-progress";
  return (
    <span
      className={`pill ${tone} inline-flex items-center gap-1`}
      title={provenance ? `${provenance.source} · digest ${provenance.digest}` : undefined}
    >
      {evidenceClass} · {EVIDENCE_CLASS_LABEL[evidenceClass]}
    </span>
  );
}

export function ProvenanceLine({ provenance }: { provenance: Provenance }) {
  return (
    <div className="data text-[10px] text-faint mt-1 truncate">
      {provenance.source} · digest {provenance.digest}
    </div>
  );
}
