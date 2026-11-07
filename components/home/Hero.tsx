import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CommissionScreen } from "@/components/CommissionScreen";
import { HeroReel } from "@/components/HeroReel";
import { WorkedResult } from "@/components/home/WorkedResult";
import { QUALIFY_LINK } from "@/lib/nav";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { REFERENCE_PHOTO_NOTICE } from "@/lib/ttp-images";

const SCREEN = PRODUCTS.density_screen;

/**
 * The first screen's words. Each of the seven things a buyer needs is answered once, in text that is on screen at 390 x 844 and at
 * 1440 x 900 without scrolling (tests/e2e/first-screen-journey.mjs asserts that in Chromium; tests/site/home-first-screen.test.ts asserts
 * the wording and its sources). The price and turnaround are read from the catalogue, never typed.
 *
 *   audience        AUDIENCE
 *   decision        H1
 *   data needed     FREE_NOTE ("7 numbers")
 *   what you get    SUB (and the worked result beside it)
 *   try now         the primary call to action
 *   difference      DIFFERENCE (we sell no equipment: the only sense in which the analysis is "independent")
 *   next step       the secondary call to action
 */
export const AUDIENCE = "Colocation and AI-infrastructure operators, and the investors and engineers who underwrite them.";
export const H1 = "How many AI racks can your hall really power — and what unlocks more?";
export const SUB =
  "Independent, evidence-graded capacity analysis for existing data-centre halls: the electrical or thermal limit that binds first, a priced relief ladder with lead times, and the evidence behind every figure. A lead time that is only assumed is labelled as one.";
export const FREE_NOTE = "7 numbers you already know, no card, no account. Directional, and it says so.";
export const DIFFERENCE = "We sell no equipment; that is all \u201cindependent\u201d means here.";
export const SAMPLE_LABEL = "See a sample deliverable";
export const PAID_LABEL = `Order a ${SCREEN.name} — ${eurFromCents(SCREEN.amountCents)} · ${SCREEN.turnaroundDays} days`;

export function Hero() {
  return (
    <section className="relative pb-10 pt-[4.75rem] sm:pt-28 lg:flex lg:min-h-[100dvh] lg:items-center lg:pb-14">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <HeroReel />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-7xl px-5 sm:px-6">
        <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
          <div>
            {/* One link, to the page that lists all seven audiences: one tab stop before the main action, not seven. */}
            <p className="mb-2 max-w-xl text-[13px] leading-snug sm:mb-3 sm:text-sm">
              <Link href="/for" className="text-ghost/80 underline decoration-ghost/30 underline-offset-4 hover:text-white hover:decoration-power" aria-label={`${AUDIENCE} Who it is for.`}>
                {AUDIENCE} <span aria-hidden>→</span>
              </Link>
            </p>

            <h1 className="display mb-3 text-[1.7rem] font-semibold sm:mb-5 sm:text-5xl lg:text-[3.25rem]">{H1}</h1>

            <p className="mb-4 max-w-xl text-[14px] leading-snug text-ghost/85 sm:mb-6 sm:text-lg sm:leading-relaxed">{SUB}</p>

            <div className="flex max-w-xl flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              <Link href={QUALIFY_LINK.href} className="btn-primary btn-shape btn-shape-lg min-h-11">
                {QUALIFY_LINK.label} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link href="/reference" className="btn-secondary btn-shape min-h-11">
                {SAMPLE_LABEL}
              </Link>
              <div className="sm:basis-full">
                <CommissionScreen productId="density_screen" context="hero" tone="text" label={PAID_LABEL} />
              </div>
            </div>

            <p className="mt-2 max-w-xl text-[11px] leading-snug text-faint sm:mt-3 sm:text-xs">
              {FREE_NOTE} {DIFFERENCE}{" "}
              <Link href="/legal/privacy" className="underline">What is stored</Link>.
            </p>
          </div>

          <div className="lg:mt-2">
            <WorkedResult />
          </div>
        </div>

        <p className="data mt-6 text-[10px] leading-snug text-faint">
          PILOT-STAGE · FOUNDER-LED · EVIDENCE-GRADED · {REFERENCE_PHOTO_NOTICE}
        </p>
      </div>
    </section>
  );
}
