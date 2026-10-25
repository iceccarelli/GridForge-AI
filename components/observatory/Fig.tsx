import type { Quantity } from "@/lib/observatory/types";
import { viewQuantity } from "@/components/observatory/format";
import { EvidenceChip } from "@/components/observatory/EvidenceChip";

/** A figure from the engine: the value, its range, and its evidence class, together. A missing value says why. `large` is the presenter's sizing (14px notes, 11px chips). */
export function Fig({ q, compactChip = false, large = false }: { q: Quantity | null; compactChip?: boolean; large?: boolean }) {
  const v = viewQuantity(q);
  const note = large ? "block line-clamp-2 text-sm" : "block text-xs";
  if (!v.known) {
    return (
      <span className="text-mute">
        {v.text}
        {v.missing ? <span className={note}>{v.missing}</span> : null}
      </span>
    );
  }
  return (
    <span>
      <span className="data text-ghost">{v.text}</span> {v.evidence ? <EvidenceChip cls={v.evidence} compact={compactChip} large={large} /> : null}
      {v.range ? <span className={`${note} text-mute`}>{v.range}</span> : null}
    </span>
  );
}
