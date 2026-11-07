import Link from "next/link";
import { loadWorkedResult, workedResultEvidenceLine, workedResultLines } from "@/lib/worked-result";

/**
 * The worked result: what the engine returned for the synthetic reference hall, on the first screen.
 *
 * A Server Component that reads public/reference/model_pack.json when the page is built (see lib/worked-result.ts). Nothing here is typed
 * beside the numbers: change the file and the panel changes, and tests/site/worked-result.test.ts fails if the two ever disagree.
 */
export function WorkedResult() {
  const w = loadWorkedResult();
  const lines = workedResultLines(w);
  return (
    <aside aria-labelledby="worked-result-h" data-testid="worked-result" className="panel p-3.5 sm:p-5">
      <p className="eyebrow hidden text-[11px] sm:block">Worked result · engine output</p>
      <h2 id="worked-result-h" className="text-[13px] font-semibold leading-snug tracking-tight text-ghost sm:mt-1 sm:text-base sm:tracking-normal">
        {w.hallLabel}
      </h2>
      <dl className="mt-2 space-y-1 sm:mt-3 sm:space-y-2.5">
        {lines.map((l) => (
          // Inline on a phone (the label leads its sentence, which saves two lines each), a two-column row from sm.
          <div key={l.label} className="sm:grid sm:grid-cols-[8.5rem_1fr] sm:gap-x-3">
            <dt className="data inline text-[10px] uppercase leading-[1.3] tracking-[0.08em] text-power after:content-[':'] sm:block sm:text-[11px] sm:after:content-none">{l.label}</dt>{" "}
            <dd className="inline text-[13px] leading-[1.3] text-ghost/90 sm:block sm:text-sm sm:leading-5">
              {l.text}
              {l.detail ? <span className="block text-[10.5px] leading-tight text-mute sm:text-xs sm:leading-snug">{l.detail}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 border-t border-line pt-1.5 text-[10.5px] leading-tight text-mute sm:mt-3 sm:pt-3 sm:text-xs sm:leading-snug">
        {workedResultEvidenceLine(w)} A lead time that is only assumed is labelled as one.{" "}
        <Link href="/evidence" className="whitespace-nowrap text-power underline underline-offset-2">Evidence classes</Link>
      </p>
    </aside>
  );
}
