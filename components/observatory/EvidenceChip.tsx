import type { EvidenceClass } from "@/lib/observatory/types";
import { EVIDENCE_LEGEND, evidenceTitle } from "@/components/observatory/evidence";

// Two tones, never green: green is this site's "verified / operational" signal and nothing on this page is either. The class
// itself is always printed, so the tone only helps a reader scan.
function tone(c: EvidenceClass): string {
  return Number(c.slice(1)) <= 1 ? "border-queue/60 text-queue" : "border-power/60 text-power";
}

/**
 * The evidence class of a figure, always as text ("E1 Modelled"), never colour alone. The tooltip carries the meaning; the
 * legend at the top of the page carries it for keyboard and touch visitors, who do not get tooltips.
 */
export function EvidenceChip({ cls, compact = false }: { cls: EvidenceClass; compact?: boolean }) {
  const legend = EVIDENCE_LEGEND[cls];
  return (
    <abbr
      title={evidenceTitle(cls)}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px align-middle font-mono text-[10px] font-semibold uppercase leading-4 tracking-wide no-underline ${tone(cls)}`}
      data-evidence={cls}
    >
      {cls}
      {!compact && legend ? <span className="font-sans font-medium normal-case tracking-normal">{legend.name}</span> : null}
    </abbr>
  );
}

/** A plain-words basis tag for figures the engine does not class (the invented hall's own inputs). */
export function BasisTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block max-w-full rounded-md border border-line bg-ink/60 px-1.5 py-px align-middle font-mono text-[10px] font-semibold uppercase leading-4 tracking-wide text-mute">
      {children}
    </span>
  );
}
