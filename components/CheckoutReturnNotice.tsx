"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { isCancelledReturn } from "@/lib/checkout-return-path";

// Mounted once in the site shell. It costs one pathname and one query read on every page; the notice, and the product list it needs, is a
// separate chunk fetched only when Stripe has sent the visitor back after cancelling.
const Banner = dynamic(() => import("@/components/CheckoutCancelledBanner"), { ssr: false });

export function CheckoutReturnNotice() {
  const pathname = usePathname();
  const params = useSearchParams();
  const [dismissed, setDismissed] = useState(false);
  const shows = isCancelledReturn(pathname, params);

  useEffect(() => setDismissed(false), [pathname]);

  if (!shows || dismissed) return null;
  return (
    <Banner
      productParam={params.get("product")}
      onDismiss={() => {
        setDismissed(true);
        // Take the marker out of the address so a reload does not show a notice about something already acknowledged.
        try {
          const url = new URL(window.location.href);
          for (const k of ["purchase", "deposit", "product"]) url.searchParams.delete(k);
          window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
        } catch {
          /* the notice is dismissed either way */
        }
      }}
    />
  );
}
