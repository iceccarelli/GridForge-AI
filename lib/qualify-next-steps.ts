// Where a qualify result sends the visitor next, in order. A plain module (no React, no server code) so the client component that renders the links and
// the tests that prove each one resolves read the same list.
//
// Order is cost to the visitor, lowest first: compare the relief scenarios (free), get a free API key (free, no card), then the paid Density Screen.
// Every entry names the real route or workflow behind it; tests/site/qualify-presets.test.ts checks each one exists in the code.

export interface NextStep {
  id: "compare" | "free-key" | "density-screen";
  /** Free to the visitor, or the paid product. */
  cost: "free" | "paid";
  /** The page the link goes to (a path, optionally with a fragment). */
  href: string;
  /** The page file under app/ that serves `href`, so a test can show the route exists. */
  page: string;
  /** For a step that is a workflow, not only a page: the API route it posts to. */
  workflowRoute?: string;
}

export const NEXT_STEPS: readonly NextStep[] = [
  { id: "compare", cost: "free", href: "/power/compare", page: "app/power/compare/page.tsx" },
  { id: "free-key", cost: "free", href: "/developers#rates", page: "app/developers/page.tsx", workflowRoute: "app/api/free-account/route.ts" },
  { id: "density-screen", cost: "paid", href: "/products/density-screen", page: "app/products/[slug]/page.tsx", workflowRoute: "app/api/checkout/route.ts" },
];

export const NEXT_STEP_HREFS = {
  compare: NEXT_STEPS[0].href,
  developersRates: NEXT_STEPS[1].href,
  densityScreen: NEXT_STEPS[2].href,
  engagements: "/pricing#engagements",
} as const;
