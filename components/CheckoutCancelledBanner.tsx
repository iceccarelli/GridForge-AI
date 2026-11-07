"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { QUALIFY_LINK } from "@/lib/nav";
import { productBack, takeRememberedCheckout, type ProductBack } from "@/lib/checkout-return";
import { CANCELLED_TITLE } from "@/lib/checkout-return-path";

export { CANCELLED_TITLE };

/**
 * The notice itself, drawn IN THE PAGE FLOW directly under the header (never over content). Loaded only on a cancelled return (see
 * CheckoutReturnNotice), because it carries the product list. The announcement to assistive technology is made by the live region that the
 * shell mounts empty and fills after this appears; this element is plain content.
 *
 * `productParam` is the raw `product` query value, if any: it is only ever looked up, never shown. `useRemembered` says whether the product
 * the visitor sent to Stripe (sessionStorage) may name the page: it is used on /qualify, where a cancelled one-off product returns, and
 * not on /pricing, where an unattributed deposit or a buyer-link purchase returns and a remembered id could be stale or about something
 * else. The remembered id is consumed (removed) as it is read.
 */
export default function CheckoutCancelledBanner({ productParam, useRemembered, onDismiss }: { productParam: string | null; useRemembered: boolean; onDismiss: () => void }) {
  const [back, setBack] = useState<ProductBack | null>(() => productBack(productParam));

  useEffect(() => {
    // Read-and-clear on every show, so a stale id cannot name a product on a later return, whether or not it is used now.
    const remembered = takeRememberedCheckout();
    if (back || !useRemembered) return;
    const found = productBack(remembered);
    if (found) setBack(found);
  }, [back, useRemembered]);

  return (
    // z-[1] and the negative bottom margin: the page below carries its own top padding (it was written to clear the fixed header), so it is
    // pulled up under this notice; the notice stays above it so its links and button are never covered.
    <div className="relative z-[1] -mb-12 px-3 pt-[4.25rem] sm:pt-[5.25rem]" data-testid="checkout-cancelled">
      <div className="mx-auto flex max-w-3xl items-start gap-3 rounded-xl border border-line bg-panel px-4 py-3">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-ghost">{CANCELLED_TITLE}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 text-mute">
            {back ? (
              <Link href={back.href} className="inline-flex min-h-11 items-center text-power underline underline-offset-2">
                Back to the {back.name}
              </Link>
            ) : (
              <Link href="/products" className="inline-flex min-h-11 items-center text-power underline underline-offset-2">
                See the engagements
              </Link>
            )}
            <Link href={QUALIFY_LINK.href} className="inline-flex min-h-11 items-center text-power underline underline-offset-2">
              {QUALIFY_LINK.label}
            </Link>
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this notice"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-mute hover:text-white"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
