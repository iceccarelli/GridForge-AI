"use client";

// Mobile-only sticky buy bar.
//
// Past the hero, a phone-width visitor had no persistent path to either CTA —
// the navbar's two buttons live inside a hamburger menu once scrolled. This bar
// gives the free path and the paid path a fixed home at the bottom of the
// screen, safe-area aware, hidden once the visitor reaches the final CTA (no
// point stacking a sticky bar on top of the CTA it duplicates).

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { commissionDensityScreen, DENSITY_SCREEN } from "@/lib/ui";
import { PRODUCTS, eurFromCents } from "@/lib/products";

const SCREEN = PRODUCTS[DENSITY_SCREEN];

// Routes with their own dedicated bottom-of-page CTA, checkout flow, or no
// room for a fixed bar (the client portal, and the full-screen workspace app,
// whose own conversation input already sits at the bottom of the screen).
const HIDDEN_ON = ["/dashboard", "/checkout", "/workspace"];

export function StickyMobileCTA() {
  const pathname = usePathname();
  const [pastHero, setPastHero] = useState(false);
  const [atFinalCta, setAtFinalCta] = useState(false);

  useEffect(() => {
    const onScroll = () => setPastHero(window.scrollY > 420);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A page's own final CTA section (id="final-cta", currently only on home)
  // already makes this exact offer full-width and in context. Once it is on
  // screen, the fixed bar below it would just repeat the same button.
  useEffect(() => {
    const el = document.getElementById("final-cta");
    if (!el) {
      setAtFinalCta(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setAtFinalCta(entry.isIntersecting),
      { rootMargin: "0px 0px -10% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [pathname]);

  if (HIDDEN_ON.some((p) => pathname?.startsWith(p))) return null;
  if (!pastHero) return null;
  if (atFinalCta) return null;

  return (
    <div
      className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink/95 backdrop-blur px-3 pt-2.5 flex items-center gap-2"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)" }}
    >
      <Link
        href="/qualify"
        className="flex-1 text-center rounded-lg border border-line py-2.5 text-[13px] font-medium text-ghost"
      >
        Free capacity check
      </Link>
      <button
        onClick={() => commissionDensityScreen({ context: "sticky-mobile" })}
        className="flex-1 rounded-lg bg-power py-2.5 text-[13px] font-semibold text-ink"
      >
        {SCREEN.name} — {eurFromCents(SCREEN.amountCents)}
      </button>
    </div>
  );
}
