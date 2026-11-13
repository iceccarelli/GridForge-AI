// The in-content next steps on a constraint page: where a reader who has understood this constraint can go. Pure data, read from the
// published reference (the constraint's own lead time) and the catalogue's product page, so nothing here is a figure typed beside copy and
// a step cannot point at a page that does not exist: the lead-times page is listed only for a constraint that HAS a lead time, and the
// Procurement Specification only while the catalogue has a page that sells it AND the engine can write one for this constraint's relief.

import type { ConstraintDoc } from "@/lib/constraints";
import { productPageHref } from "@/lib/product-links";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { PRODUCTS } from "@/lib/products";

export interface ConstraintNextStep {
  href: string;
  label: string;
  /** One sentence on what the reader finds there. */
  why: string;
}

export const LEAD_TIMES_PATH = "/lead-times";

export function constraintNextSteps(c: Pick<ConstraintDoc, "name" | "lead_time_weeks" | "specification_available">): ConstraintNextStep[] {
  const steps: ConstraintNextStep[] = [];
  if (c.lead_time_weeks) {
    steps.push({
      href: LEAD_TIMES_PATH,
      label: "Relief lead times for every constraint",
      why: `The relief for ${c.name} takes an indicative ${c.lead_time_weeks.low}–${c.lead_time_weeks.high} weeks. The lead-times page sets every constraint's range side by side; each is a library range, not a quotation.`,
    });
  }
  const spec = PRODUCTS.procurement_spec;
  const href = productPageHref(spec.id);
  const page = PRODUCT_PAGES.find((p) => p.productId === spec.id);
  // Only where a specification CAN be written for this constraint's relief. Two constraints have no purchasable relief (floor space is released
  // by commercial means, the cooling-architecture limit has no relief at all), and the engine refuses to produce a specification for them: a
  // page must not send a reader to buy one. Anything but an explicit true (an older reference file without the field) offers no step.
  if (c.specification_available === true && href && page) {
    const decision = page.decision.charAt(0).toLowerCase() + page.decision.slice(1);
    steps.push({
      href,
      label: `The ${spec.name}`,
      why: `If this is the constraint that binds in your hall, the specification is written for its relief and informs ${decision}`,
    });
  }
  return steps;
}
