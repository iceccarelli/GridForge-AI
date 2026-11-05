"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PLANS, eurMonth } from "@/lib/subscriptions";
import { DelayDemo } from "@/components/DelayDemo";
import { LazyIsland } from "@/components/home/LazyIsland";
import { Check, ArrowRight, Loader2 } from "lucide-react";
import { TtpPhoto } from "@/components/TtpPhoto";
import { SIGNAL_INPUTS } from "@/lib/intelligence-basis";

/** True when the address carries the marker the checkout's cancel address adds (app/api/subscribe/route.ts). */
export function checkoutWasCancelled(search: string): boolean {
  try {
    return new URLSearchParams(search).get("sub") === "cancelled";
  } catch {
    return false;
  }
}

export function IntelligenceClient() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Returning from a checkout that was not completed (the checkout's cancel address is /intelligence?sub=cancelled).
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    try {
      setCancelled(checkoutWasCancelled(window.location.search));
    } catch { /* no location: nothing to say */ }
  }, []);

  async function subscribe(planId: string) {
    setLoading(planId);
    setError(null);
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
        setError(typeof data.error === "string" && data.error ? data.error : "Could not start checkout. Please try again in a moment.");
        setLoading(null);
      }
    } catch {
      setError("Could not start checkout. Please try again in a moment.");
      setLoading(null);
    }
  }

  return (
    <div className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl">
            <div className="eyebrow text-power mb-4">GridForge Intelligence</div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1]">
              Comparing markets
              <br />
              <span className="text-power">by time to power, not just queue position.</span>
            </h1>
            <p className="text-mute text-[17px] leading-relaxed mt-6">
              A siting dashboard for subscribers: a modelled ranking of regions by time
              to energize, measured US interconnection-queue history beside it, and
              day-ahead price and grid-mix context that states its source and time or
              says it is unavailable. Behind-the-meter supply is scored as one named
              relief option, not as equipment we sell or own. This is an intelligence
              subscription, not a verified-site portfolio: the ranking is modelled, and
              the calibration ledger against instrumented sites is still empty.
            </p>
          </div>

          <TtpPhoto
            id="ttp-15"
            className="rounded-2xl overflow-hidden border border-line aspect-[16/9] mt-10 max-w-4xl"
          />

          <section className="mt-12" aria-labelledby="basis-h" data-testid="signal-basis">
            <div className="eyebrow text-power mb-3">WHAT THE SIGNAL IS MADE FROM</div>
            <h2 id="basis-h" className="text-2xl font-semibold tracking-tight text-ghost">Every input, its source and what it is not.</h2>
            <ul className="mt-5 grid gap-4 md:grid-cols-2">
              {SIGNAL_INPUTS.map((i) => (
                <li key={i.id} className="rounded-[var(--radius)] border border-line bg-panel p-5" data-signal-input={i.id}>
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-[15px] font-semibold text-ghost">{i.name}</h3>
                    <span className="data text-[10px] uppercase text-queue border border-queue/40 rounded px-1.5 py-0.5 shrink-0">{i.kind}</span>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-[13px]">
                    <div><dt className="inline text-faint">Source: </dt><dd className="inline text-mute">{i.source}</dd></div>
                    <div><dt className="inline text-faint">Describes: </dt><dd className="inline text-mute">{i.asOf}</dd></div>
                    <div><dt className="inline text-faint">Not: </dt><dd className="inline text-mute">{i.notThis}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-mute max-w-3xl">
              When a market feed does not answer, the dashboard shows Unavailable for that figure and nothing in its place.
            </p>
          </section>

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
                portfolio and not a battery we sell, install or own. The prices
                are the published EPEX day-ahead auction prices, shown with their
                source and delivery window under the result; everything else is an
                input you dial in. A planning estimate, never a guarantee, and not
                backed by the calibration ledger, which is empty today.
              </p>
            </div>
            <div className="mt-6">
              <LazyIsland which="liveScenario" minHeight={640} label="The live scenario loads as you scroll to it." />
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
                  aria-label={`Subscribe to ${plan.name}`}
                  aria-busy={loading === plan.id}
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

          {cancelled && !error && (
            <p role="status" className="mt-6 text-sm text-mute" data-testid="checkout-cancelled">
              Checkout was not completed. Choose a plan above whenever you are ready.
            </p>
          )}

          {error && (
            <p role="alert" className="mt-6 text-sm text-red-400">
              {error}
            </p>
          )}

          <p className="mt-6 text-sm text-mute" data-testid="already-subscribed">
            Already subscribed, or invited to a seat?{" "}
            <Link href="/account" className="text-power underline">Open the dashboard</Link>. It asks you to sign in with an emailed link.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 data text-xs text-faint">
            <span>Cancel anytime</span>
            <span>Secure payment via Stripe</span>
          </div>
        </div>
    </div>
  );
}
