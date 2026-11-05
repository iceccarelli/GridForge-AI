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

// Every feature listed here is something the dashboard does today, described by what it is made from.
// The three tiers unlock the same dashboard and differ in price and in seats. The seat
// count is the catalogue's (lib/products.ts) and is enforced by the database
// (migration 0027, lib/team.ts); tier-specific alerts, API access, SSO or dedicated
// feeds are not built, so they are not sold.
//
// Wording rules, enforced by tests/site/intelligence-page.test.ts: nothing here says "live" for a figure that is modelled or
// published on a schedule; the ranking is MODELLED, the queue history is a dated public report, the price is a published
// day-ahead auction price with its source and time.
const DASHBOARD_FEATURES = [
  "Modelled time-to-energize ranking of regions, every figure labelled modelled, measured or assumed",
  "Measured US interconnection-queue history (LBNL Queued Up), completed projects only",
  "Day-ahead power price and German generation mix as market context, each with source and time",
  "Saved scenarios you can compare",
  "Board brief (PDF) and an AI siting analyst working from the same modelled table",
];

/** What the plan's seat count means to a buyer. Read from the catalogue, so the copy cannot disagree with what is enforced. */
export function seatLine(seats: number | null): string {
  if (seats === null) return "Unlimited seats: invite as many people as you need";
  if (seats === 1) return "1 seat: the billing owner";
  return `${seats} seats, including the billing owner`;
}

const PRESENTATION: Record<IntelligencePlanId, Presentation> = {
  developer: {
    tagline: "The siting dashboard, billed monthly.",
    features: [...DASHBOARD_FEATURES, seatLine(INTELLIGENCE_PLANS.developer.seats)],
  },
  team: {
    tagline: "The same siting dashboard, shared with the people on your team.",
    features: [...DASHBOARD_FEATURES, seatLine(INTELLIGENCE_PLANS.team.seats)],
    highlighted: true,
  },
  enterprise: {
    tagline: "The same siting dashboard, with no limit on seats.",
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
