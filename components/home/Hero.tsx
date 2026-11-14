import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CommissionScreen } from "@/components/CommissionScreen";
import { HeroReel } from "@/components/HeroReel";
import { WorkedResult } from "@/components/home/WorkedResult";
import { QUALIFY_LINK } from "@/lib/nav";
import { calibrationLine, loadCalibration } from "@/lib/worked-result";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { REFERENCE_PHOTO_NOTICE } from "@/lib/ttp-images";
import { GridForgeVisual } from "@/components/GridForgeVisual";

const SCREEN = PRODUCTS.density_screen;

/**
 * The first screen's words. Each of the seven things a buyer needs is answered once, in text that is on screen at 390 x 844 and at
 * 1440 x 900 without scrolling (tests/e2e/first-screen-journey.mjs asserts that in Chromium; tests/site/home-conversion-honesty.test.ts and
 * tests/site/home-architecture.test.ts assert the wording and its sources). The price and turnaround are read from the catalogue, never typed.
 *
 *   audience        AUDIENCE
 *   decision        H1
 *   data needed     FREE_NOTE ("7 numbers")
 *   what you get    SUB (and the worked result beside it)
 *   try now         the primary call to action
 *   difference      DIFFERENCE (we sell no equipment: the only sense in which the analysis is "independent")
 *   trust           the trust line: pilot-stage, founder-led, and the calibration ledger's count (read from calibration.json)
 *   next step       the secondary call to action
 */
export const AUDIENCE = "Colocation and AI-infrastructure operators, and the investors and engineers who underwrite them.";
export const H1 = "How many AI racks can your hall power — and what unlocks more?";
export const SUB =
  "Independent, evidence-graded capacity analysis for existing data-centre halls: the electrical or thermal limit that binds first, a relief ladder with costs and lead times (library placeholders until you supply quotes), and the evidence behind every figure.";
export const FREE_NOTE = "7 numbers you already know, no card, no account. Directional.";
export const DIFFERENCE = "We sell no equipment; that is all \u201cindependent\u201d means here.";
export const SAMPLE_LABEL = "See a sample deliverable";
export const PAID_LABEL = `Order a ${SCREEN.name} — ${eurFromCents(SCREEN.amountCents)} · ${SCREEN.turnaroundDays} working days`;

/** The seven answers by the question they answer, in the order the page gives them. tests/site/home-architecture.test.ts checks each one is
 *  in the rendered first screen, in this reading order, and says what its question asks for. */
export const FIRST_SCREEN = {
  audience: AUDIENCE,
  decision: H1,
  whatYouReceive: SUB,
  tryNow: QUALIFY_LINK.label,
  nextStep: SAMPLE_LABEL,
  buyNow: PAID_LABEL,
  dataNeeded: FREE_NOTE,
  difference: DIFFERENCE,
} as const;

/** The trust answer on the first screen: stage, and what the calibration record holds, read from public/reference/calibration.json. */
export function trustLine(): string {
  return calibrationLine(loadCalibration());
}

export function Hero() {
  const trust = trustLine();
  return (
    <section className="relative pb-10 pt-[4.25rem] sm:pt-28 lg:flex lg:min-h-[100dvh] lg:items-center lg:pb-14">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <HeroReel />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-7xl px-5 sm:px-6">
        <div className="grid items-start gap-2.5 sm:gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
          <div>
            {/* One link, to the page that lists all seven audiences: one tab stop before the main action, not seven. */}
            <p className="mb-2 max-w-xl text-[13px] leading-snug sm:mb-3 sm:text-sm">
              <Link href="/for" className="text-ghost/80 underline decoration-ghost/30 underline-offset-4 hover:text-white hover:decoration-power" aria-label={`${AUDIENCE} Who it is for.`}>
                {AUDIENCE} <span aria-hidden>→</span>
              </Link>
            </p>

            <h1 className="display mb-2 text-[1.5rem] font-semibold sm:mb-5 sm:text-5xl lg:text-[3.25rem]">{H1}</h1>

            <p className="mb-3 max-w-xl text-[13px] leading-[1.3] text-ghost/85 sm:mb-6 sm:text-lg sm:leading-relaxed">{SUB}</p>

            <div className="flex max-w-xl flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              <Link href={QUALIFY_LINK.href} className="btn-primary btn-shape sm:btn-shape-lg min-h-11">
                {QUALIFY_LINK.label} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link href="/reference" className="btn-secondary btn-shape min-h-11">
                {SAMPLE_LABEL}
              </Link>
              <div className="-mt-1 sm:mt-0 sm:basis-full">
                <CommissionScreen productId="density_screen" context="hero" tone="text" label={PAID_LABEL} />
              </div>
            </div>

            <p className="mt-1.5 max-w-xl text-xs leading-tight text-ghost/80 sm:mt-3 sm:leading-snug">
              {FREE_NOTE} {DIFFERENCE}{" "}
              <Link href="/legal/privacy" className="underline">What is stored</Link>.
            </p>
            <p className="mt-1 max-w-xl text-xs leading-tight text-ghost/80 sm:leading-snug" data-testid="trust-line">{trust}</p>
          </div>

          <div className="lg:mt-2">
            <WorkedResult />
          </div>
        </div>

        <p className="data mt-6 text-[10px] leading-snug text-faint">
          PILOT-STAGE · FOUNDER-LED · EVIDENCE-GRADED · {REFERENCE_PHOTO_NOTICE}
        </p>
      </div>
    
        <div className="mt-8 lg:mt-0">
          <GridForgeVisual
            slug="hero-binding-constraint-ai-hall"
            alt="Illustration of a brownfield AI data hall where rack feeds constrain capacity despite available transformer and cooling headroom."
            priority
            className="w-full h-auto rounded-xl border border-line"
          />
        </div>
      </section>
  );
}
