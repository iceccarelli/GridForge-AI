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
  },
};

export const API_PRODUCTS: Product[] = Object.values(PRODUCTS).filter(
  (p) => p.apiUnits !== undefined
);

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

export const PRODUCT_BY_KIND: Record<string, Product> = Object.fromEntries(
  Object.values(PRODUCTS).map((p) => [p.kind, p])
);

export function isProductId(v: unknown): v is ProductId {
  return typeof v === "string" && v in PRODUCTS;
}
