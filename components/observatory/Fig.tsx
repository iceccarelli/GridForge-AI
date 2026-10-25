import type { Quantity } from "@/lib/observatory/types";
import { viewQuantity } from "@/components/observatory/format";
import { EvidenceChip } from "@/components/observatory/EvidenceChip";

/** A figure from the engine: the value, its range, and its evidence class, together. A missing value says why. */
export function Fig({ q, compactChip = false }: { q: Quantity | null; compactChip?: boolean }) {
  const v = viewQuantity(q);
  if (!v.known) {
    return (
      <span className="text-mute">
        {v.text}
        {v.missing ? <span className="block text-xs">{v.missing}</span> : null}
      </span>
    );
  }
  return (
    <span>
      <span className="data text-ghost">{v.text}</span> {v.evidence ? <EvidenceChip cls={v.evidence} compact={compactChip} /> : null}
      {v.range ? <span className="block text-xs text-mute">{v.range}</span> : null}
    </span>
  );
}
