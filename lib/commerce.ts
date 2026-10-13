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
    // Legacy constant; the real count is foundingSlotsClaimed() below, derived from paid deposits.
    slotsClaimed: 0,
  },
} as const;

export function foundingSlotsRemaining(): number {
  return Math.max(0, COMMERCE.founding.totalSlots - COMMERCE.founding.slotsClaimed);
}

/**
 * Founding slots already taken, counted from persisted paid deposits: a founding checkout pays exactly
 * deposit - credit for the engagement deposit, and no other path produces that amount for that kind.
 * Returns null when the store cannot be read, so callers fail closed rather than hand out the credit.
 */
export async function foundingSlotsClaimed(): Promise<number | null> {
  const amount = COMMERCE.deposit.amountCents - COMMERCE.founding.creditCents;
  // Self-contained (no server imports): client components import this module for COMMERCE and eur().
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const res = await fetch(
      `${url}/rest/v1/engagement_deposits?kind=eq.engagement_deposit&amount_cents=eq.${amount}&select=id`,
      { headers: auth, cache: "no-store" }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

/** Slots still open, from the store; null when it cannot be read (fail closed). */
export async function foundingSlotsRemainingLive(): Promise<number | null> {
  const claimed = await foundingSlotsClaimed();
  if (claimed === null) return null;
  return Math.max(0, COMMERCE.founding.totalSlots - claimed);
}

export function eur(cents: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
