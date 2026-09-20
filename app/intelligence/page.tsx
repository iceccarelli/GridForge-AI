"use client";

import { useState } from "react";
import { PLANS, eurMonth } from "@/lib/subscriptions";
import { DelayDemo } from "@/components/DelayDemo";
import { LiveScenario } from "@/components/LiveScenario";
import { Check, ArrowRight, Loader2 } from "lucide-react";
import { TtpPhoto } from "@/components/TtpPhoto";

export default function IntelligencePage() {
  const [loading, setLoading] = useState<string | null>(null);

  async function subscribe(planId: string) {
    setLoading(planId);
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planId }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error || "Could not start checkout.");
        setLoading(null);
      }
    } catch {
      alert("Could not start checkout.");
      setLoading(null);
    }
  }

  return (
    <main className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl">
            <div className="eyebrow text-power mb-4">Building toward · GridForge Intelligence</div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
              Comparing markets
              <br />
              <span className="text-power">by time to power, not just queue position.</span>
            </h1>
            <p className="text-mute text-[17px] leading-relaxed mt-6">
              A siting layer, in progress: interconnection-queue signal and modelled
              time-to-energize across regions, with behind-the-meter supply scored as one
              named relief option, priced and lead-timed like any other — not as
              equipment we sell or own. This is an intelligence subscription, not a
              verified-site portfolio; every figure is modelled, and the calibration
              ledger against instrumented sites is still empty.
            </p>
          </div>

          <TtpPhoto
            id="ttp-15"
            className="rounded-2xl overflow-hidden border border-line aspect-[16/9] mt-10 max-w-4xl"
          />

          <div className="mt-12">
            <DelayDemo />
          </div>

          <div className="mt-14">
            <div className="eyebrow text-power mb-3">MARKET ECONOMICS LAB</div>
            <h2 className="text-2xl font-semibold tracking-tight text-ghost">
              Operating-cost context for a site you already run.
            </h2>
            <div className="mt-4 rounded border border-queue/40 bg-queue/10 p-4 text-sm text-ghost max-w-2xl">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-queue">
                Not equipment we sell
              </span>
              <p className="mt-1 text-mute">
                This is a wholesale-price scenario tool, not a verified-site
                portfolio and not a battery we sell, install or own. Every figure
                is computed live from the real EPEX curve against inputs you
                dial in — a planning estimate, never a guarantee, and not backed
                by the calibration ledger, which is empty today.
              </p>
            </div>
            <div className="mt-6">
              <LiveScenario />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-14">
            {PLANS.map((plan) => (
              <div
                key={plan.id}
                className={`relative rounded-[var(--radius)] border p-7 flex flex-col transition-all ${
                  plan.highlighted
                    ? "border-power/40 bg-power/[0.03]"
                    : "border-line bg-panel hover:border-power/30"
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3 left-7 data text-[10px] uppercase tracking-[0.14em] font-medium text-ink bg-power px-2.5 py-1 rounded">
                    Most teams choose this
                  </div>
                )}
                <h2 className="text-xl font-semibold tracking-tight mt-1">{plan.name}</h2>
                <div className="mt-4 flex items-baseline gap-1.5">
                  <span className="text-3xl font-semibold text-power">{eurMonth(plan.priceCents)}</span>
                  <span className="text-mute text-sm">/ month</span>
                </div>
                <p className="text-mute text-[14px] leading-relaxed mt-3">{plan.tagline}</p>

                <ul className="mt-6 pt-5 border-t border-line space-y-2.5 flex-1">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex gap-2.5 text-sm">
                      <Check size={16} className="text-power shrink-0 mt-0.5" />
                      <span className="text-mute">{f}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => subscribe(plan.id)}
                  disabled={loading !== null}
                  className={`mt-7 w-full rounded-lg px-4 py-3 text-sm font-medium inline-flex items-center justify-center gap-2 transition-all disabled:opacity-50 ${
                    plan.highlighted
                      ? "bg-power text-ink hover:bg-power/90"
                      : "border border-line text-white hover:border-power/50 hover:bg-white/5"
                  }`}
                >
                  {loading === plan.id ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <>
                      Subscribe <ArrowRight size={15} />
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 data text-xs text-faint">
            <span>Cancel anytime</span>
            <span>EU-hosted · GDPR-aligned</span>
            <span>Secure payment via Stripe</span>
          </div>
        </div>
    </main>
  );
}
