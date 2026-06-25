"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { getSupabase } from "@/lib/supabase-client";
import { useMarket, arbPerDay } from "@/lib/market";
import { Loader2, LogOut, Zap, TrendingUp, Activity, Battery } from "lucide-react";

export default function AccountPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<string | null>(null);

  useEffect(() => {
    getSupabase().auth.getSession().then(async ({ data }) => {
      const userEmail = data.session?.user?.email ?? null;
      if (!userEmail) {
        router.replace("/account/login");
        return;
      }
      setEmail(userEmail);
      try {
        const res = await fetch("/api/subscription-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: userEmail }),
        });
        const j = await res.json();
        setActive(!!j.active);
        setPlan(j.plan ?? null);
      } catch {
        setActive(false);
      }
      setLoading(false);
    });
  }, [router]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/account/login");
  }

  if (loading) {
    return (
      <>
        <Navbar />
        <main className="bg-ink min-h-screen pt-32 flex justify-center">
          <Loader2 className="animate-spin text-power" />
        </main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between mb-8">
            <div>
              <div className="eyebrow text-power mb-2">GridForge Intelligence</div>
              <h1 className="text-3xl font-semibold tracking-tight">Live siting dashboard</h1>
              <p className="text-mute text-sm mt-1">
                {email}{plan ? " - " + plan.charAt(0).toUpperCase() + plan.slice(1) + " plan" : ""}
              </p>
            </div>
            <button onClick={signOut} className="data text-xs uppercase tracking-[0.1em] text-mute hover:text-white inline-flex items-center gap-1.5">
              <LogOut size={14} /> Sign out
            </button>
          </div>

          {active ? <LiveIntelligence /> : <Gate />}
        </div>
      </main>
    </>
  );
}

function Gate() {
  return (
    <div className="rounded-[var(--radius)] border border-line bg-panel p-8">
      <div className="eyebrow text-mute mb-2">Subscription required</div>
      <h2 className="text-xl font-semibold tracking-tight">Activate GridForge Intelligence</h2>
      <p className="text-mute text-[14px] leading-relaxed mt-2 max-w-xl">
        Live behind-the-meter siting intelligence: real-time market signals,
        interconnection-queue insight, and fastest-to-energize scoring. Choose a plan to unlock.
      </p>
      <Link href="/intelligence" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-power text-ink px-5 py-3 text-sm font-semibold hover:bg-power/90 transition-all">
        View plans
      </Link>
    </div>
  );
}

function LiveIntelligence() {
  const m = useMarket();
  const fmt = (n: number | null, suffix = "") =>
    n === null ? "--" : n.toLocaleString("en-IE", { maximumFractionDigits: 1 }) + suffix;
  const arb = arbPerDay(m.spread, 20);

  const cards = [
    { icon: Zap, label: "EPEX DAY-AHEAD", value: m.epex === null ? "--" : "EUR " + fmt(m.epex), sub: "current wholesale" },
    { icon: TrendingUp, label: "TODAY'S SPREAD", value: m.spread === null ? "--" : "EUR " + fmt(m.spread), sub: "min to max range" },
    { icon: Activity, label: "RENEWABLE NOW", value: fmt(m.renewablePct, "%"), sub: "German grid mix" },
    { icon: Battery, label: "20 MWh ARB / DAY", value: arb === null ? "--" : "EUR " + fmt(arb), sub: "illustrative, real spread" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 data text-xs text-power">
        <span className="w-2 h-2 rounded-full bg-power animate-pulse" />
        LIVE - EPEX DE / German grid {m.loading ? "(loading...)" : ""}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {cards.map((c, i) => {
          const Icon = c.icon;
          return (
            <div key={i} className="rounded-[var(--radius)] border border-line bg-panel p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="data text-[10px] text-faint">{c.label}</div>
                <Icon size={16} className="text-power" />
              </div>
              <div className="text-2xl font-semibold tracking-tight">{c.value}</div>
              <div className="data text-[10px] text-faint mt-1">{c.sub}</div>
            </div>
          );
        })}
      </div>

      <div className="rounded-[var(--radius)] border border-line bg-panel p-6">
        <div className="eyebrow text-mute mb-1">Day-ahead range</div>
        <div className="flex items-baseline gap-6 mt-3">
          <div>
            <div className="data text-[10px] text-faint">MIN</div>
            <div className="text-lg font-semibold text-power">{m.min === null ? "--" : "EUR " + fmt(m.min)}</div>
          </div>
          <div>
            <div className="data text-[10px] text-faint">AVG</div>
            <div className="text-lg font-semibold">{m.avg === null ? "--" : "EUR " + fmt(m.avg)}</div>
          </div>
          <div>
            <div className="data text-[10px] text-faint">MAX</div>
            <div className="text-lg font-semibold text-queue">{m.max === null ? "--" : "EUR " + fmt(m.max)}</div>
          </div>
          <div className="ml-auto data text-[10px] text-faint self-end">
            {m.series.length} hourly points
          </div>
        </div>
      </div>

      <div className="rounded-[var(--radius)] border border-power/30 bg-power/[0.03] p-6">
        <div className="eyebrow text-power mb-2">Fastest-to-energize</div>
        <p className="text-mute text-[14px] leading-relaxed max-w-2xl">
          Behind-the-meter bypasses a multi-year interconnection queue. With the current
          spread of {m.spread === null ? "--" : "EUR " + fmt(m.spread) + "/MWh"}, a 20 MWh
          BESS captures roughly {arb === null ? "--" : "EUR " + fmt(arb)}/day in arbitrage
          on top of avoided curtailment. Full regional siting scoring is updated continuously.
        </p>
      </div>
    </div>
  );
}
