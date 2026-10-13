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

// Every feature listed here is something the dashboard actually does today.
// The three tiers unlock the same dashboard; tier-specific alerts, API access,
// SSO, seat limits or dedicated feeds are not built, so they are not sold.
const DASHBOARD_FEATURES = [
  "Live EPEX day-ahead market data",
  "Interconnection-queue views by region",
  "Fastest-to-energize ranking across regions",
  "Saved scenarios you can compare",
  "AI siting analyst for your own site",
];

const PRESENTATION: Record<IntelligencePlanId, Presentation> = {
  developer: {
    tagline: "The live siting dashboard, billed monthly.",
    features: DASHBOARD_FEATURES,
  },
  team: {
    tagline: "The same live siting dashboard, for teams who want it on a larger plan.",
    features: [...DASHBOARD_FEATURES, "Same dashboard as Developer today; no extra tier-specific features yet"],
    highlighted: true,
  },
  enterprise: {
    tagline: "The same live siting dashboard, on the top plan.",
    features: [...DASHBOARD_FEATURES, "Same dashboard as Developer today; no extra tier-specific features yet"],
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
