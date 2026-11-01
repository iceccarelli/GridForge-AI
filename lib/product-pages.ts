// What each engagement on the ladder is for, who it is for and what it does not do. One page per product at /products/<slug>.
//
// Everything that is a price, a duration or a name comes from the catalogue (lib/products.ts) at render time; this file holds only
// the prose the catalogue has no field for. No figure is typed here (tests/test_one_company.py forbids price literals outside the
// catalogue), and nothing here claims a customer, a result or a capability the product does not have: each `limits` entry is a
// statement of what the deliverable is NOT, taken from the screening-mode wording the product itself carries.

import { PRODUCTS, type Product, type ProductId } from "@/lib/products";

export interface ProductPage {
  slug: string;
  productId: ProductId;
  /** The role that signs for the spend, in plain words. */
  buyer: string;
  /** The decision the deliverable informs. */
  decision: string;
  /** What we ask the buyer for. */
  inputs: string[];
  /** What the deliverable is not. */
  limits: string[];
  /** How the work reaches the buyer. */
  flow: string[];
}

const SCREENING_LIMIT =
  "Screening-mode output: it carries its own evidence classes and assumptions, and it is not an issued engineering opinion.";

export const PRODUCT_PAGES: ProductPage[] = [
  {
    slug: "density-screen",
    productId: "density_screen",
    buyer: "The operations or engineering lead of an existing data hall, or the director who has to approve a densification study.",
    decision: "Whether this hall is worth a full study, and which constraint a study should start with.",
    inputs: [
      "Site and hall identity, contracted capacity (MW), current peak and current IT load (MW)",
      "Busway ampacity, tap-off rating and the positions still available",
      "Plant supply temperature and the platform you intend to deploy",
      "Optionally: the firm capacity in your grid agreement, the floor loading record and the mechanical plant capacity. Where you do not have them we use a named assumption and say so in the document.",
    ],
    limits: [
      SCREENING_LIMIT,
      "It uses the numbers you give it. It does not measure the hall.",
      "It does not reserve or promise grid capacity.",
    ],
    flow: [
      "Pay by card; you receive a private intake link.",
      "Submit the hall's numbers; the engine drafts the screen.",
      "A senior engineer reviews and releases it; you receive a private link to the finished document.",
    ],
  },
  {
    slug: "envelope-study",
    productId: "envelope_study_deposit",
    buyer: "The director or head of infrastructure who owns the densification or expansion decision for a hall.",
    decision: "Which architecture to commit to, what each step of extra density costs, and when the capacity can be energised.",
    inputs: [
      "Agreed with you in the scoping call after the deposit, because the scope depends on the hall and the questions that matter to you.",
    ],
    limits: [
      "The deposit is not the price of the study. It opens a scoped engagement in the band shown above, agreed with you before the work starts.",
      "The study states which figures are measured, supplied or assumed. It does not turn an assumption into a measurement.",
    ],
    flow: [
      "Pay the deposit; a person contacts you to scope the work.",
      "The turnaround is counted from the scoping call, not from payment.",
      "You receive the study, the machine-readable model pack and a walkthrough with your engineers.",
    ],
  },
  {
    slug: "procurement-specification",
    productId: "procurement_spec",
    buyer: "The engineer or procurement lead who has to send a relief item (for example a power or cooling upgrade) out to suppliers.",
    decision: "What to ask suppliers for, and which bid actually brings the energisation date forward.",
    inputs: [
      "The relief you are procuring and the site conditions it must work at. The intake form is strict: every field is required, and the document is not generated from a partial one.",
      "After release: the bids you receive, entered on your private deliverable page for comparison.",
    ],
    limits: [
      "One relief per engagement.",
      "Bids are compared in the engine's currency (EUR). A bid quoted in another currency is disqualified rather than converted, because the engine holds no exchange rate.",
      SCREENING_LIMIT,
    ],
    flow: [
      "Pay by card; you receive a private intake link.",
      "Submit the specification inputs; the engine drafts the document.",
      "A senior engineer reviews and releases it; you then compare your bids on the same page.",
    ],
  },
  {
    slug: "portfolio-screen",
    productId: "portfolio_screen_deposit",
    buyer: "A fund, operator or lender ranking several halls for investment or upgrade.",
    decision: "Which halls to put capital into first, ranked under one methodology.",
    inputs: [
      "Agreed in the scoping call after the deposit: the list of halls and the data you can supply for each.",
    ],
    limits: [
      "The deposit is not the price of the screen. It opens a scoped engagement in the band shown above.",
      "A ranking is only as good as the inputs per hall; the document shows the evidence class behind each.",
    ],
    flow: [
      "Pay the deposit; a person contacts you to scope the work.",
      "The turnaround is counted from the scoping call, not from payment.",
      "You receive the ranking and one model pack per hall.",
    ],
  },
  {
    slug: "hall-watch",
    productId: "hall_watch",
    buyer: "The owner of a hall whose inputs change (new equipment, a revised grid agreement, a plant upgrade) and who needs to know when the answer changes.",
    decision: "Whether anything that changed in the last quarter changes the decision you took.",
    inputs: [
      "The hall's numbers, submitted through a private intake link. Nothing is produced until you submit them.",
      "Updates to those numbers whenever they change.",
    ],
    limits: [
      "It is billed every quarter until you cancel. There is no minimum term.",
      "Nothing material to report is itself a reportable answer, and the note says so.",
      SCREENING_LIMIT,
    ],
    flow: [
      "Subscribe; you receive a private intake link.",
      "Submit the hall's numbers; the model is re-solved each quarter and whenever you update an input.",
      "You receive a change note naming the inputs that moved the answer.",
    ],
  },
];

export function productPageBySlug(slug: string): ProductPage | undefined {
  return PRODUCT_PAGES.find((p) => p.slug === slug);
}

export function productForPage(page: ProductPage): Product {
  return PRODUCTS[page.productId];
}
