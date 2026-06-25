"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { getSupabase } from "@/lib/supabase-client";
import { useMarket, arbPerDay } from "@/lib/market";
import { SITING_REGIONS, sitingScore } from "@/lib/siting";
import { Loader2, LogOut, Send } from "lucide-react";

export default function AccountPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<string | null>(null);

  useEffect(() => {
    getSupabase().auth.getSession().then(async ({ data }) => {
      const userEmail = data.session?.user?.email ?? null;
      if (!userEmail) { router.replace("/account/login"); return; }
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
      } catch { setActive(false); }
      setLoading(false);
    });
  }, [router]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/account/login");
  }

  if (loading) {
    return (<><Navbar /><main className="bg-ink min-h-screen pt-32 flex justify-center"><Loader2 className="animate-spin text-power" /></main></>);
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
              <p className="text-mute text-sm mt-1">{email}{plan ? " - " + plan.charAt(0).toUpperCase() + plan.slice(1) + " plan" : ""}</p>
            </div>
            <button onClick={signOut} className="data text-xs uppercase tracking-[0.1em] text-mute hover:text-white inline-flex items-center gap-1.5"><LogOut size={14} /> Sign out</button>
          </div>
          {active ? <Intelligence email={email!} /> : <Gate />}
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
      <p className="text-mute text-[14px] leading-relaxed mt-2 max-w-xl">Ranked behind-the-meter siting intelligence across global markets, plus an AI siting analyst for your specific site. Choose a plan to unlock.</p>
      <Link href="/intelligence" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-power text-ink px-5 py-3 text-sm font-semibold hover:bg-power/90 transition-all">View plans</Link>
    </div>
  );
}

function ProvBadge({ p }: { p: string }) {
  return <span className={`data text-[9px] uppercase px-1.5 py-0.5 rounded ${p === "live" ? "bg-power/15 text-power" : "bg-white/5 text-faint"}`}>{p}</span>;
}

function Intelligence({ email }: { email: string }) {
  const m = useMarket();
  const fmt = (n: number | null, s = "") => n === null ? "--" : n.toLocaleString("en-IE", { maximumFractionDigits: 1 }) + s;

  // Live EPEX overwrites the DE row's modeled cost/renewables.
  const regions = SITING_REGIONS.map((r) => {
    if (r.id === "de-eu" && m.ok) {
      return { ...r, powerCost: m.epex ?? r.powerCost, renewablePct: m.renewablePct ?? r.renewablePct };
    }
    return r;
  }).map((r) => ({ ...r, score: sitingScore(r) })).sort((a, b) => b.score - a.score);

  return (
    <div className="space-y-8">
      {/* Ranked siting table */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Fastest-to-energize — global markets</h2>
          <div className="flex items-center gap-2 data text-xs text-power"><span className="w-2 h-2 rounded-full bg-power animate-pulse" /> LIVE + MODELED</div>
        </div>
        <div className="rounded-[var(--radius)] border border-line bg-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="data text-[10px] text-faint uppercase border-b border-line">
                <th className="text-left font-medium px-4 py-3">Market / Region</th>
                <th className="text-right font-medium px-3 py-3">Score</th>
                <th className="text-right font-medium px-3 py-3">Power €/MWh</th>
                <th className="text-right font-medium px-3 py-3">Queue</th>
                <th className="text-right font-medium px-3 py-3">BTM</th>
                <th className="text-right font-medium px-3 py-3">Renew.</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r, i) => (
                <tr key={r.id} className={`border-b border-line/50 ${i === 0 ? "bg-power/[0.04]" : ""}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{r.region}</div>
                    <div className="data text-[10px] text-faint">{r.market} · {r.country}</div>
                  </td>
                  <td className="text-right px-3 py-3"><span className={`font-semibold ${i === 0 ? "text-power" : "text-white"}`}>{r.score}</span></td>
                  <td className="text-right px-3 py-3"><div className="text-white">{fmt(r.powerCost)}</div><ProvBadge p={r.powerCostProvenance} /></td>
                  <td className="text-right px-3 py-3 text-queue">{r.queueWaitMonths}mo</td>
                  <td className="text-right px-3 py-3 text-power">{r.btmMonths}mo</td>
                  <td className="text-right px-3 py-3"><div className="text-white">{fmt(r.renewablePct, "%")}</div><ProvBadge p={r.renewableProvenance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="data text-[10px] text-faint mt-2">Score weights speed-to-power (BTM), cost, and queue congestion. Queue = est. interconnection wait; BTM = GridForge time-to-energized. Modeled figures are documented estimates, not bankable.</p>
      </div>

      {/* Live EPEX strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { l: "EPEX DAY-AHEAD", v: m.epex === null ? "--" : "€" + fmt(m.epex), s: "live wholesale" },
          { l: "TODAY'S SPREAD", v: m.spread === null ? "--" : "€" + fmt(m.spread), s: "min–max" },
          { l: "RENEWABLE NOW", v: fmt(m.renewablePct, "%"), s: "DE grid mix" },
          { l: "20 MWh ARB/DAY", v: arbPerDay(m.spread, 20) === null ? "--" : "€" + fmt(arbPerDay(m.spread, 20)), s: "real spread" },
        ].map((c, i) => (
          <div key={i} className="rounded-[var(--radius)] border border-line bg-panel p-4">
            <div className="data text-[9px] text-faint">{c.l}</div>
            <div className="text-xl font-semibold mt-1">{c.v}</div>
            <div className="data text-[9px] text-faint mt-0.5">{c.s}</div>
          </div>
        ))}
      </div>

      {/* AI siting analyst */}
      <SitingAnalyst email={email} />
    </div>
  );
}

function SitingAnalyst({ email }: { email: string }) {
  const [brief, setBrief] = useState("");
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function analyze() {
    if (!brief.trim() || loading) return;
    setLoading(true);
    setAnalysis(null);
    try {
      const res = await fetch("/api/siting-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, brief }),
      });
      const j = await res.json();
      setAnalysis(j.ok ? j.analysis : (j.error || "Analyst unavailable."));
    } catch { setAnalysis("Connection error."); }
    finally { setLoading(false); }
  }

  return (
    <div className="rounded-[var(--radius)] border border-power/30 bg-power/[0.03] p-6">
      <div className="eyebrow text-power mb-2">AI siting analyst</div>
      <h2 className="text-lg font-semibold tracking-tight">Get a recommendation for your site</h2>
      <p className="text-mute text-[13px] mt-1 mb-4">Describe your site — MW, region preference, timeline, workload — and the analyst ranks the best markets and queue-bypass path. Directional; a paid Audit confirms.</p>
      <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="e.g. 80 MW for AI training, flexible on US region, need power by Q3 next year, prioritize low cost and fast energization." className="w-full resize-none bg-ink border border-line rounded-lg px-3.5 py-3 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none" />
      <button onClick={analyze} disabled={loading || !brief.trim()} className="mt-3 rounded-lg bg-power text-ink px-5 py-2.5 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-40 hover:bg-power/90 transition-all">
        {loading ? <Loader2 size={15} className="animate-spin" /> : <><Send size={14} /> Analyze my site</>}
      </button>
      {analysis && (
        <div className="mt-5 pt-5 border-t border-line text-[14px] text-ghost/90 leading-relaxed whitespace-pre-wrap">{analysis}</div>
      )}
    </div>
  );
}
