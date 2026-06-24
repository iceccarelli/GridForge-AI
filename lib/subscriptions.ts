export interface Plan {
  id: "developer" | "team" | "enterprise";
  name: string;
  priceCents: number;
  cadence: "month";
  tagline: string;
  features: string[];
  highlighted?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "developer",
    name: "Developer",
    priceCents: 49900,
    cadence: "month",
    tagline: "Live market intelligence for a single site team.",
    features: [
      "Live EPEX / day-ahead market data",
      "Basic interconnection-queue signals",
      "Fastest-to-energize directional reads",
      "1 seat",
    ],
  },
  {
    id: "team",
    name: "Team",
    priceCents: 199900,
    cadence: "month",
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
  {
    id: "enterprise",
    name: "Enterprise",
    priceCents: 499900,
    cadence: "month",
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
];

export function eurMonth(cents: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(cents / 100);
}
