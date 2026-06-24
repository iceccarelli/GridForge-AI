// Commercial config — engagement deposit + founding-partner promotion.
// All amounts in EUR cents (Stripe's smallest-unit convention).
// Change here once; checkout + UI read from this single source.

export const COMMERCE = {
  currency: "eur",
  // Deposit to reserve an engagement — fully credited against the final scope.
  deposit: {
    amountCents: 500_000, // €5,000
    label: "Engagement reservation deposit",
    description:
      "Reserves senior power-systems engineering capacity for your site. " +
      "Fully credited against your engagement. Refundable if we decline the project.",
  },
  // Founding Partner promotion — scarcity-driven first-mover credit.
  founding: {
    enabled: true,
    creditCents: 250_000, // €2,500 off first engagement
    totalSlots: 5,
    // Bump this as slots are claimed (or wire to a Supabase count later).
    slotsClaimed: 0,
  },
} as const;

export function foundingSlotsRemaining(): number {
  return Math.max(0, COMMERCE.founding.totalSlots - COMMERCE.founding.slotsClaimed);
}

export function eur(cents: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
