"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CANCELLED_TITLE, isCancelledReturn } from "@/lib/checkout-return-path";

// Mounted once in the site shell. It costs one pathname and one query read on every page; the notice, and the product list it needs, is a
// separate chunk fetched only when Stripe has sent the visitor back after cancelling.
const Banner = dynamic(() => import("@/components/CheckoutCancelledBanner"), { ssr: false });

export function CheckoutReturnNotice() {
  const pathname = usePathname();
  const params = useSearchParams();
  const [dismissed, setDismissed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const shows = isCancelledReturn(pathname, params) && !dismissed;

  useEffect(() => setDismissed(false), [pathname]);

  // A live region is announced reliably only when it exists EMPTY and is then filled; one that is mounted already holding its text is
  // often skipped. This region is always in the shell, empty; its text arrives a moment after the notice appears and is cleared with it.
  useEffect(() => {
    if (!shows) {
      setAnnouncement("");
      return;
    }
    const t = window.setTimeout(() => setAnnouncement(CANCELLED_TITLE), 150);
    return () => window.clearTimeout(t);
  }, [shows]);

  const dismiss = () => {
    setDismissed(true);
    // Take the marker out of the address so a reload does not show a notice about something already acknowledged.
    try {
      const url = new URL(window.location.href);
      for (const k of ["purchase", "deposit", "product"]) url.searchParams.delete(k);
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch {
      /* the notice is dismissed either way */
    }
  };

  useEffect(() => {
    if (!shows) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shows]);

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only" data-testid="checkout-cancelled-live">{announcement}</div>
      {shows ? <Banner productParam={params.get("product")} useRemembered={pathname === "/qualify"} onDismiss={dismiss} /> : null}
    </>
  );
}
