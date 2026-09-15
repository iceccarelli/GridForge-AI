// GridForge Intelligence — how the plans are PRESENTED.
//
// The prices are not here. They live in lib/products.ts, which is the one file in
// this repository allowed to carry a euro figure, because a price that only exists
// next to the copy describing it is a price nothing can check against the engine,
// the checkout or the proposal.
//
// What stays here is the sales argument: what each tier is for, what a buyer gets,
// and which one is the recommended entry point. Those are genuinely editorial and
// change on a different clock from the price.

import {
  INTELLIGENCE_PLANS,
  INTELLIGENCE_PLAN_IDS,
  type IntelligencePlanId,
} from "./products";

export type PlanId = IntelligencePlanId;

export interface Plan {
  id: IntelligencePlanId;
  name: string;
  priceCents: number;
  cadence: "month";
  tagline: string;
  features: string[];
  highlighted?: boolean;
}

interface Presentation {
  tagline: string;
  features: string[];
  highlighted?: boolean;
}

const PRESENTATION: Record<IntelligencePlanId, Presentation> = {
  developer: {
    tagline: "Live market intelligence for a single site team.",
    features: [
      "Live EPEX / day-ahead market data",
      "Basic interconnection-queue signals",
      "Fastest-to-energize directional reads",
      "1 seat",
    ],
  },
  team: {
    tagline: "Full siting intelligence for active developers.",
    features: [
      "Everything in Developer",
      "Full interconnection-queue intelligence",
      "Fastest-to-energize scoring across regions",
      "Price + congestion alerts",
      "API access",
      "5 seats",
    ],
    highlighted: true,
  },
  enterprise: {
    tagline: "Dedicated intelligence for hyperscale siting teams.",
    features: [
      "Everything in Team",
      "Custom regions & dedicated feeds",
      "Priority engineering-hours credit",
      "SSO & audit logging",
      "Unlimited seats",
      "Direct line to a senior engineer",
    ],
  },
};

/** Order is the order they are shown in. Name and price come from the catalogue. */
export const PLANS: Plan[] = INTELLIGENCE_PLAN_IDS.map((id) => ({
  id,
  name: INTELLIGENCE_PLANS[id].name,
  priceCents: INTELLIGENCE_PLANS[id].priceCents,
  cadence: INTELLIGENCE_PLANS[id].interval,
  ...PRESENTATION[id],
}));

export function eurMonth(cents: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(cents / 100);
}
