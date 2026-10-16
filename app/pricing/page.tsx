import type { Metadata } from "next";
import Link from "next/link";
import { EngagementLadder } from "@/components/EngagementLadder";
import { TtpPhoto } from "@/components/TtpPhoto";
import { PRODUCTS, eurFromCents } from "@/lib/products";

const PRICING_DESCRIPTION = `Every engagement priced before it starts, from the ${eurFromCents(PRODUCTS.density_screen.amountCents)} Density Screen up to the full Capacity & Density Envelope Study. No retainer hours, no second price list.`;

export const metadata: Metadata = {
  title: "Pricing — fixed-fee engineering engagements",
  description: PRICING_DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — fixed-fee engineering engagements",
    description: PRICING_DESCRIPTION,
    url: "/pricing",
  },
};

export default function PricingPage() {
  return (
    <main className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl">
            <div className="eyebrow text-power mb-4">Engagement scope &amp; pricing</div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
              Fixed-scope engineering,
              <br />
              <span className="text-power">priced before we start.</span>
            </h1>
            <p className="text-mute text-[17px] leading-relaxed mt-6">
              Every engagement is a concrete deliverable a senior power-systems engineer
              produces for your site — not retainer hours. Most halls begin with the
              Density Screen, which credits in full against the study it usually leads to.
            </p>
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
          <EngagementLadder />

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
