// What the Envelope Study needs that a buyer would not guess, said once and before they pay.
//
// Pure data (no React, no I/O): the Study's product page (lib/product-pages.ts), the engagement ladder, the Study intake form
// (components/EngagementIntake.tsx) and the Study offer made after a released Density Screen (lib/study-offer.ts, and its page and email) all print
// this sentence, so none of them can drop it or say it differently. tests/site/study-redundancy.test.ts pins it on each surface.
//
// What the engine does, which the sentence has to stay true to (gridforge/intake/loader.py `_bank_gaps`, schema.py `can_issue`): a transformer bank,
// UPS block or CDU bank that omits `redundancy` gets a REQUIRED gap named for it, is computed with N+1 as an E0 assumption, and `can_issue`
// (reported as can_issue_a_study) goes false, so the engine does not treat the intake as one a full Study can be issued on. Usable units are
// the units left after the redundancy reserve (gridforge/power/redundancy.py usable_units): the same four units are 3, 2 or 4 usable under N+1, 2N or N.

export const STUDY_REDUNDANCY_SENTENCE =
  "A Study needs the redundancy configuration (N, N+1, N+2 or 2N) of every transformer, UPS and cooling bank you list: " +
  "it sets how many of a bank's units are usable, so it decides whether the answer is N, N+1 or 2N-based. " +
  "Left out, it is named as a required gap, N+1 is assumed in its place, and the intake does not count as one a full Study can be issued on.";
