"use client";

// The one thing a primary CTA on this site does.
//
// This file used to be `openAudit()` — a global event that opened a multi-step
// form, captured a lead, scored it, and emailed the founder. Nothing on the other
// end of it was for sale. The Power Audit was a EUR 25k–45k engagement from the
// consultancy this repository used to be; it has no catalogue entry, no Stripe
// price, no intake, no engine endpoint and no deliverable. A visitor who pressed
// the most prominent button on the home page entered a funnel whose best possible
// outcome was an email.
//
// Meanwhile the Density Screen — EUR 4,500, five days, a real document the engine
// generates from the buyer's own seven numbers — was reachable only from /pricing
// and from the ladder at the bottom of it.
//
// So every CTA now commissions the Density Screen, and the price and the turnaround
// in the label are read from the catalogue rather than typed. A price that appears
// on a button and nowhere the tests can see it is a price that drifts, and this
// repository has already paid for that once.

import { toast } from "sonner";
import { PRODUCTS, eurFromCents, type ProductId } from "@/lib/products";

const SCREEN = PRODUCTS.density_screen;

/** The primary paid CTA. There is deliberately only one. */
export const DENSITY_SCREEN: ProductId = SCREEN.id;

/**
 * The primary CTA's label: the product's name, its fee and its turnaround, joined.
 *
 * Never type the figure. The whole point of lib/products.ts is that the amount a
 * buyer reads on a button and the amount Stripe charges come from one place — and
 * a euro figure typed into a comment here drifts exactly like one typed into code,
 * which is why the architecture guard refuses both.
 */
export const DENSITY_SCREEN_CTA = `${SCREEN.name} — ${eurFromCents(
  SCREEN.amountCents
)} · ${SCREEN.turnaroundDays} days`;

/** What the buyer gets, for the line of copy under a CTA. */
export const DENSITY_SCREEN_PROMISE =
  "One hall. What binds first, how many racks it carries, and the inputs nobody has measured.";

export interface CommissionContext {
  /** Which CTA started this. Travels to Stripe as metadata.service, for attribution. */
  context?: string;
  /**
   * The free read this purchase came from, when there is one.
   *
   * Carried so the engagement that opens is joined to the qualification behind it:
   * the intake then arrives with the seven numbers already filled in, instead of
   * asking a customer who has just paid to retype what they typed ten seconds ago.
   */
  qualificationId?: string | null;
  company?: string | null;
  capacityMW?: number | null;
}

export type CommissionOutcome = { ok: true } | { ok: false; error: string };

/**
 * Open Stripe Checkout for a catalogue product and send the browser to it.
 *
 * Resolves only on failure — a success navigates away. The two failure modes are
 * told apart on purpose: "Payments not configured" is our deployment missing a
 * key, and sending somebody to hunt a card problem for it wastes the one minute
 * in which they were willing to buy.
 */
export async function startCommission(
  product: ProductId,
  ctx: CommissionContext = {}
): Promise<CommissionOutcome> {
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product,
        qualificationId: ctx.qualificationId ?? undefined,
        company: ctx.company ?? undefined,
        capacityMW: ctx.capacityMW ?? undefined,
        service: ctx.context ?? undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.ok || !body?.url) {
      return {
        ok: false,
        error:
          body?.error === "Payments not configured"
            ? "Checkout is not live on this deployment yet — email us and we will invoice."
            : (body?.error ?? "Could not start checkout."),
      };
    }
    window.location.href = body.url as string;
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach checkout. Try again, or email us." };
  }
}

/**
 * Commission the Density Screen from an inline button.
 *
 * For CTAs that carry their own styling (the nav pill, the footer link, a tool's
 * "take this further"). Panels that have room for an error line should use
 * <CommissionScreen>, which renders the failure next to the button rather than in
 * a toast.
 */
export async function commissionDensityScreen(ctx: CommissionContext = {}): Promise<void> {
  const outcome = await startCommission(DENSITY_SCREEN, ctx);
  if (!outcome.ok) toast.error(outcome.error);
}
