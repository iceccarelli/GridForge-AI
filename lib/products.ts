// The engagement catalogue: what can actually be bought, and for how much.
// Single source for checkout, the webhook and every CTA. Amounts in EUR cents.
//
// These are engineering engagements, not software licences. The Density Screen is
// priced to stand on its own and credits in full against the Study — a prospect who
// buys the screen has already decided to spend, which is the only qualification
// signal that has ever meant anything.

export type ProductId =
  | "density_screen"
  | "envelope_study_deposit"
  | "portfolio_screen_deposit"
  | "hall_watch"
  | "procurement_spec"
  | "api_triage"
  | "api_scale"
  | "api_platform";

export interface Product {
  id: ProductId;
  /** Stripe metadata.kind — the webhook dispatches on this. */
  kind: string;
  name: string;
  amountCents: number;
  description: string;
  /** What the buyer receives, verbatim on the checkout page. */
  deliverable: string;
  /** Working days from a complete intake to delivery. */
  turnaroundDays: number;
  /** Does buying it start the intake → generate → release flow? */
  producesDeliverable: boolean;
  creditsAgainst?: ProductId;
  /** A recurring engagement. Checkout runs in subscription mode. */
  recurring?: { interval: "month" | "year"; intervalCount: number };
  /**
   * Metered API access. Buying one of these issues a signed key rather than
   * starting an engagement — see lib/api-access.ts. Mirrors API_PLANS in
   * gridforge/commercial.py; tests/test_catalogue_parity.py fails if they drift.
   */
  apiUnits?: number;
  /**
   * Where on the site this is sold. Required on every product, with no default.
   *
   * The engagement ladder used to be a hand-written array in a component, and a
   * product added to this catalogue simply never appeared for sale — which is how
   * the Procurement Specification shipped priced, documented and unbuyable. The
   * ladder is now derived from this field, and a test fails if any product omits
   * it. Something unsellable now has to be declared unsellable on purpose.
   */
  surface: "ladder" | "developers" | "upsell" | "hidden";
  /** Position on the engagement ladder. Lower first. */
  ladderOrder?: number;
  /**
   * For a deposit, the scoped band it opens, in EUR cents. Mirrors
   * Engagement.price_eur / price_eur_max in gridforge/commercial.py. The upper
   * half of every range used to be typed into a component, which made it a number
   * nothing could check.
   */
  opensBandCents?: [number, number];
  /**
   * Which engine endpoint generates this deliverable. Required whenever
   * producesDeliverable is true — the intake route reads it rather than
   * branching on the kind, which is how a EUR 18,000 specification purchase
   * once generated a Density Screen.
   */
  endpoint?: "screen" | "study" | "spec";
}

export const PRODUCTS: Record<ProductId, Product> = {
  density_screen: {
    id: "density_screen",
    kind: "density_screen",
    name: "Density Screen",
    amountCents: 450_000, // €4,500
    description:
      "A five-day screening opinion on one hall: what binds first, how many racks of your " +
      "target platform it carries as it stands and after the costed ladder, which item sets " +
      "the date, and the list of inputs nobody has measured.",
    deliverable:
      "Density Screen document (HTML + Markdown), the first six rungs of the headroom ladder, " +
      "and a data request you can send to your own engineers verbatim.",
    turnaroundDays: 5,
    producesDeliverable: true,
    creditsAgainst: "envelope_study_deposit",
    surface: "ladder",
    ladderOrder: 10,
    endpoint: "screen",
  },
  envelope_study_deposit: {
    id: "envelope_study_deposit",
    kind: "envelope_study_deposit",
    name: "Capacity & Density Envelope Study — deposit",
    amountCents: 900_000, // €9,000 against €22k–€45k
    description:
      "Reserves senior engineering capacity for the full study: the complete constraint ladder, " +
      "every architecture compared, time to power, sensitivity, economics and a machine-readable " +
      "model pack you keep.",
    deliverable:
      "Envelope Study (HTML + Markdown), model_pack.json, and a 90-minute walkthrough with your " +
      "engineering team.",
    turnaroundDays: 25,
    producesDeliverable: false,
    surface: "ladder",
    ladderOrder: 20,
    endpoint: "study",
    opensBandCents: [2_200_000, 4_500_000],
  },
  hall_watch: {
    id: "hall_watch",
    kind: "hall_watch",
    name: "Hall Watch",
    amountCents: 600_000, // €6,000 per quarter
    description:
      "We keep your hall's model live. Every quarter — and whenever you update an input — it " +
      "is re-solved and you get a change note: what moved, which input moved it, and whether " +
      "it changes the decision.",
    deliverable:
      "A quarterly change note naming the inputs that moved the answer, plus an unlimited " +
      "re-run whenever you update the hall's numbers. Nothing material to report is itself a " +
      "reportable answer, and we say so in three lines rather than padding it.",
    turnaroundDays: 2,
    producesDeliverable: false,
    recurring: { interval: "month", intervalCount: 3 },
    surface: "ladder",
    ladderOrder: 50,
  },
  portfolio_screen_deposit: {
    id: "portfolio_screen_deposit",
    kind: "portfolio_screen_deposit",
    name: "Portfolio Screen — deposit",
    amountCents: 1_500_000, // €15,000 against €60k–€140k
    description:
      "Five to fifteen halls ranked by deliverable compute, time to power and capital cost per " +
      "rack, under one methodology so the ranking is comparable.",
    deliverable:
      "Portfolio Screen document and one model pack per hall.",
    turnaroundDays: 45,
    producesDeliverable: false,
    surface: "ladder",
    ladderOrder: 40,
    opensBandCents: [6_000_000, 14_000_000],
  },
  procurement_spec: {
    id: "procurement_spec",
    kind: "procurement_spec",
    name: "Procurement Specification",
    amountCents: 1_800_000, // €18,000
    description:
      "The study says what binds and what relieves it. This is what you send to suppliers: " +
      "a tender-ready technical specification for one relief, with every duty derived from " +
      "the capacity model and quoted at your site conditions — then your bids compared in " +
      "racks and weeks, not only in euros.",
    deliverable:
      "Technical specification (HTML + Markdown), a machine-readable response schedule, and " +
      "a bid comparison against the capacity model showing what each response does to the " +
      "energisation date.",
    turnaroundDays: 12,
    producesDeliverable: true,
    surface: "ladder",
    ladderOrder: 30,
    endpoint: "spec",
  },
  api_triage: {
    id: "api_triage",
    kind: "api_triage",
    name: "API — Triage",
    amountCents: 90_000, // €900 / month
    description:
      "Metered access to the engine for one team screening a portfolio it already owns. " +
      "600 units a month: 600 constraint screens, or 120 full solves, or any mix. The free " +
      "qualifier stays free and never touches the allowance.",
    deliverable:
      "A signed API key, the MCP endpoint for agents, and 600 units a month. Screening-mode " +
      "output only: no issued opinion, no named signatory, no professional indemnity.",
    turnaroundDays: 0,
    producesDeliverable: false,
    recurring: { interval: "month", intervalCount: 1 },
    apiUnits: 600,
    surface: "developers",
  },
  api_scale: {
    id: "api_scale",
    kind: "api_scale",
    name: "API — Scale",
    amountCents: 290_000, // €2,900 / month
    description:
      "For a platform or fund pricing halls continuously rather than in batches. 2,500 units " +
      "a month, the portfolio endpoint billed per hall, and change notes naming the input that " +
      "moved the answer.",
    deliverable:
      "A signed API key and 2,500 units a month, with priority on new platform library entries.",
    turnaroundDays: 0,
    producesDeliverable: false,
    recurring: { interval: "month", intervalCount: 1 },
    apiUnits: 2_500,
    surface: "developers",
  },
  api_platform: {
    id: "api_platform",
    kind: "api_platform",
    name: "API — Platform",
    amountCents: 750_000, // €7,500 / month
    description:
      "For embedding the engine in a product your own customers use. 10,000 units a month, a " +
      "named engineer on call for model questions, and redistribution terms for output you " +
      "show to your own customers.",
    deliverable:
      "A signed API key, 10,000 units a month, a named engineer, and input on the constraint " +
      "roadmap.",
    turnaroundDays: 0,
    producesDeliverable: false,
    recurring: { interval: "month", intervalCount: 1 },
    apiUnits: 10_000,
    surface: "developers",
  },
};

export const PRODUCT_BY_KIND: Record<string, Product> = Object.fromEntries(
  Object.values(PRODUCTS).map((p) => [p.kind, p])
);

export const API_PRODUCTS: Product[] = Object.values(PRODUCTS).filter(
  (p) => p.surface === "developers"
);

/**
 * The engagement ladder, derived rather than hand-written.
 *
 * A product added to this file now appears for sale automatically. The previous
 * arrangement — a literal array of ids inside a component — meant adding a
 * product to the catalogue and forgetting one line left it priced, documented
 * and impossible to buy.
 */
export const LADDER_PRODUCTS: Product[] = Object.values(PRODUCTS)
  .filter((p) => p.surface === "ladder")
  .sort((a, b) => (a.ladderOrder ?? 999) - (b.ladderOrder ?? 999));

/**
 * Which engine endpoint generates a purchased deliverable.
 *
 * Single source of truth. The intake route used to branch on the kind inline —
 * `kind === "envelope_study_deposit" ? "study" : "screen"` — so a Procurement
 * Specification purchase silently generated a Density Screen. The client paid
 * EUR 18,000 for the wrong document and nothing in the system objected.
 */
export function deliverableEndpoint(kind: string): "screen" | "study" | "spec" | null {
  const p = PRODUCT_BY_KIND[kind];
  if (!p) return null;
  return p.endpoint ?? null;
}

export function isApiProduct(id: string): boolean {
  return Boolean(PRODUCTS[id as ProductId]?.apiUnits);
}

export function eurFromCents(cents: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function isProductId(v: unknown): v is ProductId {
  return typeof v === "string" && v in PRODUCTS;
}

// --- GridForge Intelligence ---------------------------------------------------
//
// The third recurring product, and the one that was not in this file.
//
// Its prices lived in lib/subscriptions.ts as `priceCents` and reached the page
// through a formatter, so no `€` ever appeared in that file and the one-price-list
// guard — which looks for the character — could not see them. A price the checks
// cannot see is a price that can drift, and this repository has already paid for
// that once: "deposit against EUR 22k–45k" had the 22 in the engine and the 45
// typed into a React component, which made the upper half of every quoted range
// unsourceable.
//
// This is not a different category of thing from the rest of the catalogue. The
// file already prices recurring products (hall_watch) and metered software
// subscriptions that involve no engineering hours at all (api_triage, api_scale,
// api_platform). Intelligence is the same shape as those and simply was not here.
//
// It stays a separate table rather than joining PRODUCTS because the three tiers
// share one Stripe metadata.kind and are dispatched by `plan`, where every entry
// in PRODUCTS is dispatched by a unique `kind` through PRODUCT_BY_KIND. Merging
// them would mean either three new kinds or a collision in that map. What matters
// commercially is that the euro figures are in the file that owns euro figures.
//
// lib/subscriptions.ts now holds only presentation — tagline, features, which tier
// is highlighted — and reads name and price from here.

export type IntelligencePlanId = "developer" | "team" | "enterprise";

export interface IntelligencePlan {
  id: IntelligencePlanId;
  name: string;
  priceCents: number;
  interval: "month";
  /** Stripe metadata.kind. One family; the tier travels as metadata.plan. */
  kind: "intelligence_subscription";
  /** null means unlimited. */
  seats: number | null;
}

export const INTELLIGENCE_PLANS: Record<IntelligencePlanId, IntelligencePlan> = {
  developer: {
    id: "developer",
    name: "Developer",
    priceCents: 49_900,
    interval: "month",
    kind: "intelligence_subscription",
    seats: 1,
  },
  team: {
    id: "team",
    name: "Team",
    priceCents: 199_900,
    interval: "month",
    kind: "intelligence_subscription",
    seats: 5,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceCents: 499_900,
    interval: "month",
    kind: "intelligence_subscription",
    seats: null,
  },
};

export const INTELLIGENCE_PLAN_IDS: IntelligencePlanId[] = [
  "developer",
  "team",
  "enterprise",
];

export function isIntelligencePlanId(v: unknown): v is IntelligencePlanId {
  return typeof v === "string" && v in INTELLIGENCE_PLANS;
}
