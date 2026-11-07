"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { QUALIFY_LINK } from "@/lib/nav";
import { LAST_CHECKOUT_KEY, productBack, type ProductBack } from "@/lib/checkout-return";

export const CANCELLED_TITLE = "Checkout cancelled — nothing was charged.";

/**
 * The notice itself. Loaded only on a cancelled return (see CheckoutReturnNotice), because it carries the product list.
 * `productParam` is the raw `product` query value, if any: it is only ever looked up, never shown.
 */
export default function CheckoutCancelledBanner({ productParam, onDismiss }: { productParam: string | null; onDismiss: () => void }) {
  const [back, setBack] = useState<ProductBack | null>(() => productBack(productParam));

  useEffect(() => {
    if (back) return;
    try {
      const stored = window.sessionStorage.getItem(LAST_CHECKOUT_KEY);
      const found = productBack(stored);
      if (found) setBack(found);
    } catch {
      /* storage can be blocked; the generic notice is still correct */
    }
  }, [back]);

  return (
    <div className="fixed inset-x-0 top-16 z-40 px-3 pt-2 sm:top-20" data-testid="checkout-cancelled" role="status">
      <div className="mx-auto flex max-w-3xl items-start gap-3 rounded-xl border border-line bg-panel/95 px-4 py-3 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.8)] backdrop-blur">
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
