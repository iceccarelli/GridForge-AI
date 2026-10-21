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
// The three tiers unlock the same dashboard and differ in price and in seats. The seat
// count is the catalogue's (lib/products.ts) and is enforced by the database
// (migration 0027, lib/team.ts); tier-specific alerts, API access, SSO or dedicated
// feeds are not built, so they are not sold.
const DASHBOARD_FEATURES = [
  "Live EPEX day-ahead market data",
  "Interconnection-queue views by region",
  "Fastest-to-energize ranking across regions",
  "Saved scenarios you can compare",
  "AI siting analyst for your own site",
];

/** What the plan's seat count means to a buyer. Read from the catalogue, so the copy cannot disagree with what is enforced. */
export function seatLine(seats: number | null): string {
  if (seats === null) return "Unlimited seats: invite as many people as you need";
  if (seats === 1) return "1 seat: the billing owner";
  return `${seats} seats, including the billing owner`;
}

const PRESENTATION: Record<IntelligencePlanId, Presentation> = {
  developer: {
    tagline: "The live siting dashboard, billed monthly.",
    features: [...DASHBOARD_FEATURES, seatLine(INTELLIGENCE_PLANS.developer.seats)],
  },
  team: {
    tagline: "The same live siting dashboard, shared with the people on your team.",
    features: [...DASHBOARD_FEATURES, seatLine(INTELLIGENCE_PLANS.team.seats)],
    highlighted: true,
  },
  enterprise: {
    tagline: "The same live siting dashboard, with no limit on seats.",
    features: [...DASHBOARD_FEATURES, seatLine(INTELLIGENCE_PLANS.enterprise.seats)],
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
