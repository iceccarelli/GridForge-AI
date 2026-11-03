import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { EVIDENCE_BANDS, type BandId } from "@/lib/evidence-bands";

// Where assumed ends and measured begins. HTML and CSS rather than SVG so it reflows on a phone and reads in order for a screen
// reader. The rule at the foot is the engine's own: a result carries the weakest class that went into it.

const TONE: Record<BandId, string> = {
  assumed: "border-queue/50",
  modelled: "border-chart/60",
  measured: "border-verified/50",
  observed: "border-line",
};

export function EvidenceBoundary() {
  return (
    <section aria-labelledby="eb-h" className="panel p-5 sm:p-7">
      <div className="eyebrow mb-2">MEASURED, OBSERVED, MODELLED, ASSUMED</div>
      <h3 id="eb-h" className="max-w-2xl text-lg font-semibold text-ghost">Four kinds of number, and what each lets you conclude.</h3>
      <ol className="mt-5 grid gap-3 md:grid-cols-4">
        {EVIDENCE_BANDS.map((b) => (
          <li key={b.id} className={`rounded-lg border bg-ink/40 p-4 ${TONE[b.id]}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-ghost">{b.label}</span>
              <span className="data text-[11px] text-faint">{b.codes.join(" ")}</span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-mute">{b.reading}</p>
            <ul className="mt-3 space-y-1 text-[12px] text-faint">
              {b.codes.map((code) => {
                const c = EVIDENCE_CLASSES.find((e) => e.code === code)!;
                return (
                  <li key={code}>
                    <span className="data text-mute">{code}</span> {c.verb}
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 border-t border-line pt-2 text-[12px] leading-relaxed text-mute">
              <span className="data mr-1 text-[10px] text-faint">TODAY</span>
              {b.today}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-5 max-w-3xl text-[13px] leading-relaxed text-mute">
        The weakest link sets the label. A result built from nine modelled inputs and one assumed one is reported as assumed. Nothing is
        shown as measured, field-validated or observed until it is, and the boundary between the bands is the boundary between a calculation
        and a fact.
      </p>
    </section>
  );
}
