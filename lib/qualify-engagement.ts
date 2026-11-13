// What the qualifier says to a BUYER about the paid step beside its button.
//
// The engine returns `intake.recommended_engagement`, a sentence written to our salesperson ("Intake too thin for a full study. Sell the Density
// Screen instead: ..."; "3 required inputs missing. Request them before starting; ..."). It is never shown to a buyer and nothing here reads it.
// This reads the answer's own structure (which assumed inputs are required, and how many) and the catalogue (lib/products.ts, through
// lib/study-offer.ts for the step after the Screen): the name, the price, the turnaround and the credit are the catalogue's words, typed nowhere here.
// Pure: no React, no I/O.

import type { QualifyResult } from "@/lib/qualify";
import { splitGaps } from "@/lib/qualify-readout";
import { PRODUCTS } from "@/lib/products";
import { studyOffer } from "@/lib/study-offer";

export interface EngagementAdvice {
  /** What this read leaves open, counted from the gaps the page shows; null when the answer carries no gap list to count. */
  situation: string | null;
  /** What the Density Screen is and when it arrives, from the catalogue. */
  offer: string;
  /** What it leads to and how its fee is treated, from the catalogue; null when the catalogue cannot state it whole. */
  next: string | null;
}

export function engagementAdvice(r: { intake?: Partial<QualifyResult["intake"]> | null }): EngagementAdvice {
  const screen = PRODUCTS.density_screen;
  const gaps = r.intake?.gaps;
  let situation: string | null = null;
  if (Array.isArray(gaps)) {
    const { shown, more, requiredCount } = splitGaps(gaps);
    const optionalCount = shown.length + more.length - requiredCount;
    if (requiredCount > 0) {
      situation = `${requiredCount} required input${requiredCount === 1 ? " is" : "s are"} still assumed in this read (marked * above).`;
    } else if (optionalCount > 0) {
      situation = `No required input is missing from this read; ${optionalCount} optional input${optionalCount === 1 ? " is" : "s are"} still assumed.`;
    } else {
      situation = "No input in this read is assumed.";
    }
  }
  const study = studyOffer(screen.kind);
  return {
    situation,
    offer: `${screen.description} You receive: ${screen.deliverable}`,
    next: study ? `If the Screen shows the hall is worth a full study, the next step is the ${study.studyName}: ${study.price}. ${study.earlierCredit}` : null,
  };
}
