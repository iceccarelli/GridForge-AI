// The engagement catalogue: what can actually be bought, and for how much.
// Single source for checkout, the webhook and every CTA. Amounts in EUR cents.
//
// These are engineering engagements, not software licences. The Density Screen is
// priced to stand on its own and credits in full against the Study — a prospect who
// buys the screen has already decided to spend, which is the only qualification
// signal that has ever meant anything.

export type ProductId = "density_screen" | "envelope_study_deposit" | "portfolio_screen_deposit";

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
};

export const PRODUCT_BY_KIND: Record<string, Product> = Object.fromEntries(
  Object.values(PRODUCTS).map((p) => [p.kind, p])
);

export function isProductId(v: unknown): v is ProductId {
  return typeof v === "string" && v in PRODUCTS;
}
