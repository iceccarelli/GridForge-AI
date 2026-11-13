// What a buyer is told, after a released Density Screen, about the step the catalogue says it credits against: the Envelope Study.
//
// Pure data, no React and no I/O, so the released page (components/StudyUpsell.tsx) and the release email (lib/notifications.ts) say the
// same thing from the same place. Nothing is typed here that the catalogue owns: the deposit, the band, the credit sentence, the
// turnaround and what is delivered are read from lib/products.ts, lib/engagement-state.ts (depositTerms) and lib/product-pages.ts at call
// time, so a repriced or re-worded product changes here by itself. There is no payment path in this file: `href` is the product's own page,
// where its Commission button already is.

import { creditedEarlier, depositTerms } from "@/lib/engagement-state";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { productPageHref } from "@/lib/product-links";
import { PRODUCT_BY_KIND, PRODUCTS, priceLine } from "@/lib/products";
import { STUDY_REDUNDANCY_SENTENCE } from "@/lib/study-needs";

export interface StudyOffer {
  /** The purchase this page is the result of ("Density Screen"). */
  fromName: string;
  /** The step it leads to ("Capacity & Density Envelope Study"), without the deposit suffix. */
  studyName: string;
  /** The product's own page, which carries its purchase button and its "before you buy" facts. */
  href: string;
  /** The catalogue's price line for the deposit: the deposit, and the band of the scoped engagement it opens. */
  price: string;
  /** The catalogue's wording of the credit: the deposit against the fee, and the earlier purchase against the same fee, with its conditions. */
  credit: string;
  /** Only the sentence about the earlier purchase (what the Screen's fee does). */
  earlierCredit: string;
  /** Where the clock starts and what is committed, as the deposit states it. */
  timing: string;
  /** What the Study delivers, verbatim from the catalogue. */
  delivers: string;
  /** What the Study needs that the buyer would not guess (lib/study-needs.ts): the redundancy of the banks, and why. Said before they pay. */
  needs: string;
  /** The question the Screen settles, and the questions it leaves for the Study, from the two product pages. */
  screenSettles: string;
  studyDecides: string;
  /** What the Screen leaves unknown: the inputs its own data request lists (the catalogue says the Screen delivers "the list of inputs nobody has measured"). */
  stillUnknownAfterScreen: string;
  /** What stays unknown after the Study too, from the Study's own statement of what it is not; null when that statement is absent. */
  stillUnknown: string | null;
}

/** The inputs the Screen's data request lists are not measured; they stay assumptions until someone supplies a measurement. Pinned to the catalogue's wording by tests/site/study-upsell.test.ts. */
const STILL_UNKNOWN_AFTER_SCREEN = "The inputs this document lists as not measured are still assumptions until you or your engineers supply them.";

/**
 * The offer for a deliverable of this kind, or null. It exists only for a product the catalogue declares as crediting against an
 * engagement whose deposit is sold on a page of its own: a Study, Specification or Portfolio row, a proposal and an unknown kind get none.
 */
export function studyOffer(kind: string): StudyOffer | null {
  const from = PRODUCT_BY_KIND[kind];
  const target = from?.creditsAgainst ? PRODUCTS[from.creditsAgainst] : null;
  if (!from || !target?.opensBandCents) return null;
  const href = productPageHref(target.id);
  const terms = depositTerms(target.kind);
  const earlierCredit = creditedEarlier(target.kind);
  const fromPage = PRODUCT_PAGES.find((p) => p.productId === from.id);
  const toPage = PRODUCT_PAGES.find((p) => p.productId === target.id);
  // Never an offer with a missing piece: a link that goes nowhere or a credit sentence that is not the catalogue's would be worse than none.
  if (!href || !terms || !earlierCredit || !fromPage || !toPage) return null;
  return {
    fromName: from.name,
    studyName: target.name.replace(/ — deposit$/, ""),
    href,
    price: priceLine(target),
    credit: terms.credit,
    earlierCredit,
    timing: terms.timing,
    delivers: target.deliverable,
    needs: STUDY_REDUNDANCY_SENTENCE,
    screenSettles: fromPage.decision,
    studyDecides: toPage.decision,
    stillUnknownAfterScreen: STILL_UNKNOWN_AFTER_SCREEN,
    stillUnknown: toPage.limits.find((l) => /assumption/i.test(l)) ?? null,
  };
}

/**
 * The release email's paragraph: one sentence of price and one of credit, then the link. `base` is the site origin (lib/site.ts SITE_URL),
 * passed in so this module stays free of environment reads.
 */
export function studyOfferEmail(offer: StudyOffer, base: string): string {
  return (
    `If the result says this hall is worth a full study, the next step is the ${offer.studyName}: ${offer.price}. ` +
    `${offer.earlierCredit}\n\n` +
    `${offer.needs}\n\n` +
    `${base}${offer.href}`
  );
}
