"use client";

import Link from "next/link";
import { ArrowRight, Check, Shield } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { SERVICES, PACKAGES, SITE } from "@/lib/site";
import { openAudit } from "@/lib/ui";
import { startDeposit } from "@/lib/checkout";
import { COMMERCE, foundingSlotsRemaining, eur } from "@/lib/commerce";

const TIERS = PACKAGES.map((pkg) => {
  const svc = SERVICES.find((s) => s.title === pkg.tier);
  return {
    title: pkg.tier,
    band: pkg.band,
    basis: pkg.basis,
    anchor: "anchor" in pkg ? pkg.anchor : false,
    desc: svc?.desc ?? "",
    deliverable: svc?.deliverable ?? "Scoped per engagement",
    timeline: svc?.timeline ?? pkg.basis,
  };
});

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

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-14">
            {TIERS.map((t) => (
              <div
                key={t.title}
                className={`relative rounded-[var(--radius)] border p-7 flex flex-col transition-all ${
                  t.anchor
                    ? "border-power/40 bg-power/[0.03]"
                    : "border-line bg-panel hover:border-power/30"
                }`}
              >
                {t.anchor && (
                  <div className="absolute -top-3 left-7 data text-[10px] uppercase tracking-[0.14em] font-medium text-ink bg-power px-2.5 py-1 rounded">
                    Most start here
                  </div>
                )}
                <h2 className="text-xl font-semibold tracking-tight mt-1">{t.title}</h2>
                <div className="mt-4 flex items-baseline gap-2">
                  <span className="text-3xl font-semibold text-power">{t.band}</span>
                </div>
                <div className="data text-xs text-faint mt-1.5">{t.basis}</div>
                <p className="text-mute text-[14px] leading-relaxed mt-5">{t.desc}</p>

                <div className="mt-6 pt-5 border-t border-line space-y-3 text-sm">
                  <div className="flex gap-2.5">
                    <Check size={16} className="text-power shrink-0 mt-0.5" />
                    <span className="text-mute">
                      <span className="text-white">Deliverable:</span> {t.deliverable}
                    </span>
                  </div>
                  <div className="flex gap-2.5">
                    <Check size={16} className="text-power shrink-0 mt-0.5" />
                    <span className="text-mute">
                      <span className="text-white">Timeline:</span> {t.timeline}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => openAudit("pricing", { service: t.title })}
                  className={`mt-7 w-full rounded-lg px-4 py-3 text-sm font-medium inline-flex items-center justify-center gap-2 transition-all ${
                    t.anchor
                      ? "bg-power text-ink hover:bg-power/90"
                      : "border border-line text-white hover:border-power/50 hover:bg-white/5"
                  }`}
                >
                  Scope this engagement <ArrowRight size={15} />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 data text-xs text-faint">
            <span className="inline-flex items-center gap-1.5">
              <Shield size={13} className="text-power" /> NDA on request
            </span>
            <span>Independent · vendor-neutral</span>
            <span>Physics-first · bankable models</span>
            <span>{SITE.baseLocation}</span>
          </div>

          <div className="mt-16 rounded-[var(--radius)] border border-power/30 bg-power/[0.04] p-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="max-w-xl">
                <div className="eyebrow text-power mb-2">Reserve your engagement</div>
                <h3 className="text-2xl font-semibold tracking-tight">
                  {eur(COMMERCE.deposit.amountCents)} deposit to start
                </h3>
                <p className="text-mute text-[14px] leading-relaxed mt-2">
                  {COMMERCE.deposit.description}
                </p>
                {COMMERCE.founding.enabled && foundingSlotsRemaining() > 0 && (
                  <p className="data text-xs text-queue mt-3">
                    Founding Partner: {eur(COMMERCE.founding.creditCents)} credit ·{" "}
                    {foundingSlotsRemaining()} of {COMMERCE.founding.totalSlots} slots remaining
                  </p>
                )}
              </div>
              <button
                onClick={() =>
                  startDeposit({
                    service: "Power Audit & Site Assessment",
                    founding: COMMERCE.founding.enabled && foundingSlotsRemaining() > 0,
                  })
                }
                className="shrink-0 rounded-lg bg-power text-ink px-6 py-3.5 text-sm font-semibold inline-flex items-center gap-2 hover:bg-power/90 transition-all"
              >
                Reserve — pay deposit <ArrowRight size={15} />
              </button>
            </div>
            <p className="data text-[11px] text-faint mt-4">
              Secure payment via Stripe · fully credited against your engagement · refundable if we decline the project.
            </p>
          </div>

          <div className="mt-16 rounded-[var(--radius)] border border-line bg-panel p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="max-w-xl">
              <div className="eyebrow text-mute mb-2">Beyond feasibility</div>
              <h3 className="text-xl font-semibold tracking-tight">
                Integration, commissioning &amp; EMS tuning
              </h3>
              <p className="text-mute text-[14px] leading-relaxed mt-2">
                Once a site clears feasibility, integration design and commissioning are
                scoped against the real load profile and grid position — ready to hand to
                an EPC. Quoted per site after the feasibility model.
              </p>
            </div>
            <button
              onClick={() => openAudit("pricing-deep", { service: "Integration Design & Engineering" })}
              className="shrink-0 rounded-lg bg-power text-ink px-5 py-3 text-sm font-medium inline-flex items-center gap-2 hover:bg-power/90 transition-all"
            >
              Request a scoped quote <ArrowRight size={15} />
            </button>
          </div>

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
