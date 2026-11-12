import React from "react";
import Link from "next/link";
import { studyOffer } from "@/lib/study-offer";

/**
 * The step after a released Density Screen: the Envelope Study, which the catalogue says the Screen credits against.
 *
 * A server component with no script: it states what the Study decides, what it delivers, what remains unknown, the deposit, the band
 * and the credit, and links to the Study's own page, where the Commission button and the "before you buy" facts already are. It takes
 * no payment and opens no checkout. Every figure and every sentence about money comes from the catalogue through lib/study-offer.ts;
 * nothing is typed here. It renders only for a kind the catalogue declares as crediting against a deposit (the Density Screen), so a
 * Study, a Specification, a Portfolio row, a proposal or an unreleased page never shows it (the page renders it only once released).
 */
export function StudyUpsell({ kind }: { kind: string }) {
  const offer = studyOffer(kind);
  if (!offer) return null;
  const rows: [string, React.ReactNode][] = [
    ["What this document settles", offer.screenSettles],
    ["What the study decides", offer.studyDecides],
    ["You receive", offer.delivers],
    ["What stays unknown", `${offer.stillUnknownAfterScreen}${offer.stillUnknown ? ` ${offer.stillUnknown}` : ""}`],
    ["Price", offer.price],
    ["Credit", offer.credit],
    ["Turnaround", offer.timing],
  ];
  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-5 sm:p-6" aria-labelledby="study-next-h" data-testid="study-upsell">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-power">What happens next</p>
      <h2 id="study-next-h" className="mt-2 text-lg font-semibold text-ghost">
        If this hall is worth a full study: the {offer.studyName}
      </h2>
      <dl className="mt-4 grid max-w-3xl gap-x-6 gap-y-3 text-sm sm:grid-cols-[12rem_1fr]">
        {rows.map(([label, text]) => (
          <React.Fragment key={label}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint sm:pt-0.5">{label}</dt>
            <dd className="min-w-0 break-words text-mute">{text}</dd>
          </React.Fragment>
        ))}
      </dl>
      <div className="mt-5">
        <Link
          href={offer.href}
          className="inline-flex min-h-11 items-center justify-center rounded bg-power px-5 py-2.5 text-center font-semibold text-ink"
        >
          About the {offer.studyName} and its deposit
        </Link>
      </div>
    </section>
  );
}
