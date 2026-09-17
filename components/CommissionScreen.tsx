"use client";

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { DENSITY_SCREEN_CTA, startCommission, type CommissionContext } from "@/lib/ui";
import type { ProductId } from "@/lib/products";

/**
 * Commission the engagement from the page the buyer is already reading.
 *
 * `/q/<token>` exists for one reason, stated when it was built: the person who
 * types seven numbers into the qualifier is an operations engineer, the person who
 * signs off a five-figure study is a director, and the distance between them is a
 * link. The page carries that read to the director.
 *
 * Its "commission it" button linked to /pricing. So the one person on the whole
 * site with the budget, holding a private read of their own hall with the binding
 * constraint named on it, clicked to buy and landed on a generic price list — the
 * hall gone, the constraint gone, and the qualification that produced it gone with
 * them. Every share was a conversion handed back to the top of the funnel.
 *
 * The qualification id travels with the purchase, so the engagement that opens is
 * joined to the read it was bought from rather than arriving as an unattached sale.
 *
 * It is now the primary CTA everywhere, not just here. The checkout call itself
 * lives in lib/ui.ts so that the nav pill, the footer link and this panel cannot
 * drift into three different ideas of what the button does.
 */
export function CommissionScreen({
  productId,
  qualificationId,
  company,
  capacityMW,
  label,
  context,
  size = "md",
  tone = "primary",
}: {
  productId: ProductId;
  /** The read this purchase came from. Null when we could not resolve one. */
  qualificationId?: string | null;
  company?: string | null;
  capacityMW?: number | null;
  /** Defaults to DENSITY_SCREEN_CTA, which is built from the catalogue. */
  label?: string;
  context?: string;
  size?: "md" | "lg";
  tone?: "primary" | "outline";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commission() {
    setBusy(true);
    setError(null);
    const ctx: CommissionContext = { qualificationId, company, capacityMW, context };
    const outcome = await startCommission(productId, ctx);
    if (!outcome.ok) setError(outcome.error);
    setBusy(false);
  }

  const dims = size === "lg" ? "px-8 py-4 text-base" : "px-5 py-2.5 text-sm";
  const skin =
    tone === "outline"
      ? "border border-power/50 text-power hover:bg-power/10"
      : "bg-power text-ink hover:bg-power/90";

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={commission}
        disabled={busy}
        className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${dims} ${skin}`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Opening checkout" : (label ?? DENSITY_SCREEN_CTA)}
        {busy ? null : <ArrowRight className="h-4 w-4" />}
      </button>
      {error ? <p className="max-w-sm text-[12px] text-flag">{error}</p> : null}
    </div>
  );
}
