"use client";

import Link from "next/link";
import { ArrowRight, Zap, Shield, Clock } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { POWER_BLOCKS } from "@/lib/catalog";
import { SITE } from "@/lib/site";
import { openAudit } from "@/lib/ui";

export default function InfrastructurePage() {
  return (
    <>
      <Navbar />
      <main className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl">
            <div className="eyebrow text-power mb-4">Behind-the-meter power blocks</div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
              Megawatts in months,
              <br />
              <span className="text-power">not a queue position in years.</span>
            </h1>
            <p className="text-mute text-[17px] leading-relaxed mt-6">
              Reference configurations of our REF-01 hybrid microgrid, sized for AI load.
              Each block is engineered to your site and load profile — fuel-flexible,
              phased, and built to bypass a multi-year interconnection queue.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-14">
            {POWER_BLOCKS.map((b) => (
              <div
                key={b.id}
                className={`relative rounded-[var(--radius)] border p-7 flex flex-col transition-all ${
                  b.flagship
                    ? "border-power/40 bg-power/[0.03]"
                    : "border-line bg-panel hover:border-power/30"
                }`}
              >
                {b.flagship && (
                  <div className="absolute -top-3 left-7 data text-[10px] uppercase tracking-[0.14em] font-medium text-ink bg-power px-2.5 py-1 rounded">
                    Most requested
                  </div>
                )}

                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight">{b.name}</h2>
                    <p className="text-mute text-[14px] mt-1.5">{b.tagline}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-3xl font-semibold text-power leading-none">
                      {b.capacityMW}
                      <span className="text-base"> MW</span>
                    </div>
                    <div className="data text-[10px] text-faint mt-1">{b.firmPct}% firm</div>
                  </div>
                </div>

                <dl className="mt-6 pt-5 border-t border-line grid grid-cols-1 gap-2.5 text-[13px]">
                  <Spec label="Generation" value={b.generation} />
                  <Spec label="Storage" value={b.storage} />
                  <Spec label="Cooling" value={b.cooling} />
                  <Spec label="Footprint" value={b.footprint} />
                  <Spec label="Redundancy" value={b.redundancy} />
                </dl>

                <div className="mt-5 flex items-center gap-2 data text-xs text-queue">
                  <Clock size={13} /> {b.leadTime}
                </div>

                <p className="text-faint text-[12px] mt-4 leading-relaxed">
                  <span className="text-mute">Fits:</span> {b.fitFor}
                </p>

                <button
                  onClick={() =>
                    openAudit("infrastructure", {
                      capacityMW: b.capacityMW,
                      firmPct: b.firmPct,
                      service: "Feasibility Study & Financial Model",
                      summary: `Interested in a ${b.name} (${b.capacityMW} MW, ${b.firmPct}% firm) behind-the-meter block.`,
                    })
                  }
                  className={`mt-7 w-full rounded-lg px-4 py-3 text-sm font-medium inline-flex items-center justify-center gap-2 transition-all ${
                    b.flagship
                      ? "bg-power text-ink hover:bg-power/90"
                      : "border border-line text-white hover:border-power/50 hover:bg-white/5"
                  }`}
                >
                  Configure &amp; quote <ArrowRight size={15} />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 data text-xs text-faint">
            <span className="inline-flex items-center gap-1.5">
              <Zap size={13} className="text-power" /> Fuel-flexible · phased capacity
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Shield size={13} className="text-power" /> NDA on request
            </span>
            <span>Sized from a real load profile, not a rule of thumb</span>
          </div>

          <div className="mt-16 rounded-[var(--radius)] border border-line bg-panel p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="max-w-xl">
              <div className="eyebrow text-mute mb-2">Not sure which block?</div>
              <h3 className="text-xl font-semibold tracking-tight">
                Start with a Power Audit
              </h3>
              <p className="text-mute text-[14px] leading-relaxed mt-2">
                We size the block to your actual load, site, and grid position — and tell
                you honestly if behind-the-meter is the wrong answer. Go / no-go in 10–14 days.
              </p>
            </div>
            <button
              onClick={() => openAudit("infrastructure-audit", { service: "Power Audit & Site Assessment" })}
              className="shrink-0 rounded-lg bg-power text-ink px-5 py-3 text-sm font-medium inline-flex items-center gap-2 hover:bg-power/90 transition-all"
            >
              Request a power audit <ArrowRight size={15} />
            </button>
          </div>

          <div className="mt-12 flex gap-6">
            <Link
              href="/pricing"
              className="data text-xs uppercase tracking-[0.12em] text-mute hover:text-power transition-colors"
            >
              Engagement pricing →
            </Link>
            <Link
              href="/#architectures"
              className="data text-xs uppercase tracking-[0.12em] text-mute hover:text-power transition-colors"
            >
              Reference architectures →
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="data text-[10px] uppercase tracking-[0.1em] text-faint w-20 shrink-0 pt-0.5">
        {label}
      </dt>
      <dd className="text-mute">{value}</dd>
    </div>
  );
}
