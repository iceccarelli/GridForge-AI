"use client";

import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

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
 */
export function CommissionScreen({
  productId,
  qualificationId,
  company,
  capacityMW,
  label,
}: {
  productId: string;
  /** The read this purchase came from. Null when we could not resolve one. */
  qualificationId?: string | null;
  company?: string | null;
  capacityMW?: number | null;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commission() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: productId,
          qualificationId: qualificationId ?? undefined,
          company: company ?? undefined,
          capacityMW: capacityMW ?? undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.url) {
        // Say which of the two it is. "Could not start checkout" sends somebody
        // hunting a card problem when the deployment simply has no Stripe key.
        setError(
          body?.error === "Payments not configured"
            ? "Checkout is not live on this deployment yet — reply to the link you were sent and we will invoice."
            : (body?.error ?? "Could not start checkout.")
        );
        return;
      }
      window.location.href = body.url as string;
    } catch {
      setError("Could not reach checkout. Reply to the link you were sent and we will invoice.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={commission}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Opening checkout" : label}
        {busy ? null : <ArrowRight className="h-4 w-4" />}
      </button>
      {error ? <p className="max-w-sm text-[12px] text-flag">{error}</p> : null}
    </div>
  );
}
