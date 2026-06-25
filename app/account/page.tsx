"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { getSupabase } from "@/lib/supabase-client";
import { useMarket, arbPerDay } from "@/lib/market";
import { SITING_REGIONS, sitingScore, costOfDelay, eurCompact } from "@/lib/siting";
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

      {/* Cost-of-delay calculator — the core hook */}
      <DelayCalculator />

      {/* AI siting analyst */}
      <SitingAnalyst email={email} />
    </div>
  );
}

function DelayCalculator() {
  const [mw, setMw] = useState(100);
  const [valuePerMwMonth, setVpm] = useState(25000);
  const ranked = [...SITING_REGIONS].map((r) => ({ ...r, score: sitingScore(r) })).sort((a, b) => b.score - a.score);
  const [regionId, setRegionId] = useState(ranked[0].id);
  const region = ranked.find((r) => r.id === regionId) ?? ranked[0];
  const d = costOfDelay(mw, region, valuePerMwMonth);
  const pct = d.queueCostEur > 0 ? (d.btmCostEur / d.queueCostEur) * 100 : 0;

  return (
    <div className="rounded-[var(--radius)] border border-line bg-panel p-6">
      <div className="flex items-center justify-between mb-1">
        <div className="eyebrow text-power">Cost of delay</div>
        <div className="data text-[10px] text-faint">{region.market}</div>
      </div>
      <h2 className="text-lg font-semibold tracking-tight">What the queue is costing you</h2>
      <p className="text-mute text-[13px] mt-1 mb-5">Quantify the capital your site strands waiting in the interconnection queue versus the behind-the-meter path. Adjust the assumptions — the model is transparent.</p>

      <div className="grid sm:grid-cols-3 gap-4 mb-6">
        <div>
          <label className="data text-[10px] text-faint">SITE SIZE — {mw} MW</label>
          <input type="range" min={5} max={500} step={5} value={mw} onChange={(e) => setMw(Number(e.target.value))} className="w-full mt-2 accent-[color:var(--power,#38bdf8)]" />
        </div>
        <div>
          <label className="data text-[10px] text-faint">REGION</label>
          <select value={regionId} onChange={(e) => setRegionId(e.target.value)} className="w-full mt-2 bg-ink border border-line rounded-lg px-3 py-2 text-[13px] text-white focus:border-power/50 focus:outline-none">
            {ranked.map((r) => <option key={r.id} value={r.id}>{r.region}</option>)}
          </select>
        </div>
        <div>
          <label className="data text-[10px] text-faint">€/MW-MONTH STRANDED</label>
          <input type="number" step={1000} value={valuePerMwMonth} onChange={(e) => setVpm(Math.max(0, Number(e.target.value)))} className="w-full mt-2 bg-ink border border-line rounded-lg px-3 py-2 text-[13px] text-white focus:border-power/50 focus:outline-none" />
        </div>
      </div>

      <div className="rounded-lg border border-power/30 bg-power/[0.04] p-5">
        <div className="data text-[10px] text-faint">BEHIND-THE-METER UNLOCKS</div>
        <div className="text-4xl font-semibold text-power tracking-tight mt-1">{eurCompact(d.avoidedEur)}</div>
        <div className="text-mute text-[13px] mt-1">{d.monthsSaved} months sooner to revenue — for a {mw} MW site in {region.region}.</div>
      </div>

      <div className="mt-5 space-y-2">
        <div className="flex items-center gap-3">
          <div className="data text-[10px] text-faint w-24 shrink-0">QUEUE PATH</div>
          <div className="flex-1 h-7 rounded bg-queue/20 border border-queue/30 flex items-center px-3">
            <span className="data text-[11px] text-queue">{region.queueWaitMonths}mo · {eurCompact(d.queueCostEur)} stranded</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="data text-[10px] text-faint w-24 shrink-0">BTM PATH</div>
          <div className="h-7 rounded bg-power/20 border border-power/30 flex items-center px-3" style={{ width: `${Math.max(18, pct)}%` }}>
            <span className="data text-[11px] text-power whitespace-nowrap">{region.btmMonths}mo · {eurCompact(d.btmCostEur)}</span>
          </div>
        </div>
      </div>
      <p className="data text-[10px] text-faint mt-4">Stranded value = your assumption for revenue/strategic value per MW per month a site sits un-energized. Directional; a paid Audit confirms site-specific figures.</p>
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
