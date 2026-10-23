import type { Metadata } from "next";
import { OG_IMAGES } from "@/lib/site";
import Link from "next/link";
import CostEstimator from "@/components/CostEstimator";
import { EngagementLadder } from "@/components/EngagementLadder";
import FreeAllowanceForm from "@/components/FreeAllowanceForm";
import PaygRateCard from "@/components/PaygRateCard";
import ThreePaths from "@/components/ThreePaths";
import { TtpPhoto } from "@/components/TtpPhoto";
import { PAYG, PRODUCTS, eurFromCents } from "@/lib/products";
import { readToolRatesSync } from "@/lib/tool-rates";

const PRICING_DESCRIPTION = `A free capacity check, metered software with a free allowance and a cap you set, and fixed-fee engineering engagements from the ${eurFromCents(PRODUCTS.density_screen.amountCents)} Density Screen up to the full Capacity & Density Envelope Study. No retainer hours, no second price list.`;

export const metadata: Metadata = {
  title: "Pricing — free check, metered API, fixed-fee engagements",
  description: PRICING_DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    images: OG_IMAGES,
    title: "Pricing — free check, metered API, fixed-fee engagements",
    description: PRICING_DESCRIPTION,
    url: "/pricing",
  },
};

export default function PricingPage() {
  const rates = readToolRatesSync();
  return (
    <main className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl">
            <div className="eyebrow text-power mb-4">Pricing</div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
              Three ways to use it,
              <br />
              <span className="text-power">each priced before you start.</span>
            </h1>
            <p className="text-mute text-[17px] leading-relaxed mt-6">
              A free result you can get without an account, metered software you call from your own code, and fixed-fee
              engineering a senior power-systems engineer produces for your site. They are different things with different
              prices, and none of them is billed by the hour.
            </p>
          </div>

          <div className="mt-10">
            <ThreePaths />
          </div>

          <TtpPhoto
            id="ttp-11"
            className="rounded-xl overflow-hidden border border-line aspect-[21/9] max-h-[280px] my-10"
          />

          {/* One price list. It used to render PACKAGES above this — a second,
              unsourced fee structure from the practice this repository used to be,
              so a buyer met two unrelated price lists on one page. Everything
              purchasable now comes from the catalogue, which is parity-tested
              against the engine's own commercial figures. */}
          <section id="engagements" aria-labelledby="engagements-h" className="scroll-mt-24">
            <h2 id="engagements-h" className="text-2xl font-semibold text-ghost">Engineering engagements</h2>
            <p className="mt-2 mb-6 max-w-2xl text-sm text-mute">
              Every engagement is a concrete deliverable, fixed-fee and agreed before we start, not retainer hours. Most
              halls begin with the Density Screen, which credits in full against the study it usually leads to.
            </p>
            <EngagementLadder />
          </section>

          <section id="metered" aria-labelledby="metered-h" className="mt-16 scroll-mt-24">
            <h2 id="metered-h" className="text-2xl font-semibold text-ghost">Metered software</h2>
            <p className="mt-2 max-w-3xl text-sm text-mute">
              The same engine, called directly. Start on a free allowance, move to pay-as-you-go under a monthly cap you
              set, and take a plan when the volume warrants one. API responses are screening output: an engagement is what
              puts an engineer&apos;s name on an opinion.
            </p>
            <div className="mt-6 rounded border border-power/40 bg-panel-2 p-5 sm:p-6">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-power">
                Free allowance · {PAYG.freeAllowanceUnits} units a month · no card
              </p>
              <div className="mt-3 max-w-2xl">
                <FreeAllowanceForm heading="Try the engine on your own hall, free" />
              </div>
            </div>
            <div className="mt-8">
              <PaygRateCard rates={rates} />
            </div>
            <div className="mt-6">
              <CostEstimator rates={rates} engine={process.env.GRIDFORGE_API_URL || "https://gridforge-engine.fly.dev"} />
            </div>
            <p className="mt-4 text-sm text-mute">
              Plans, the MCP install and the tool schemas are on the{" "}
              <Link href="/developers#plans" className="text-power underline">
                developers page
              </Link>
              .
            </p>
          </section>

          <section className="mt-12 max-w-3xl rounded border border-line bg-panel-2 p-6" aria-labelledby="start-free">
            <h2 id="start-free" className="text-lg font-semibold text-ghost">
              Not sure which step to start with?
            </h2>
            <p className="mt-2 text-sm text-mute">
              Run the free Time-to-Power comparison on your hall: racks as found and after relief, what binds, and the date to full
              capacity with the evidence class behind it. Save it to a project and send the read-only page to whoever approves the
              spend; they can commission the next step from it, at the prices above.
            </p>
            <Link href="/power/compare" className="mt-3 inline-block text-sm text-power">
              Run the comparison →
            </Link>
          </section>

          <div className="mt-12">
            <Link
              href="/#services"
              className="data text-xs uppercase tracking-[0.12em] text-mute hover:text-power transition-colors inline-flex items-center gap-1.5"
            >
              ← Full service detail
            </Link>
          </div>
        </div>
    </main>
  );
}
