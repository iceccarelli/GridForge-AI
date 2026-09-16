"use client";

import Link from "next/link";
import { ArrowRight, Check, Shield } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { SERVICES, SITE } from "@/lib/site";
import { openAudit } from "@/lib/ui";
import { startDeposit } from "@/lib/checkout";
import { EngagementLadder } from "@/components/EngagementLadder";
import { COMMERCE, foundingSlotsRemaining, eur } from "@/lib/commerce";


export default function PricingPage() {
  return (
    <>
      <Navbar />
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
              produces for your site — not retainer hours. Most clients begin with the
              Power Audit, then scope deeper work from its findings.
            </p>
          </div>

          {/* One price list. It used to render PACKAGES above this — a second,
              unsourced fee structure from the practice this repository used to be,
              so a buyer met two unrelated price lists on one page. Everything
              purchasable now comes from the catalogue, which is parity-tested
              against the engine's own commercial figures. */}
          <EngagementLadder />

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
      <Footer />
    </>
  );
}
