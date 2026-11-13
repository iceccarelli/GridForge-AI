"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loadSupabase, mayHaveSession } from "@/components/supabase-lazy";
import { SITING_REGIONS, sitingScore, costOfDelay, eurCompact, queueBasisNote } from "@/lib/siting";
import { IntelligenceSignalTable } from "@/components/IntelligenceSignalTable";
import { IntelligenceContext } from "@/components/IntelligenceContext";
import { Loader2, LogOut, Send, Download, Save } from "lucide-react";
import { generateSitingBrief } from "@/lib/brief";
import { PRODUCTS, intelligencePlanName } from "@/lib/products";
import TeamPanel from "@/components/TeamPanel";
import { IntelligenceManage, SuspendedAccessNote } from "@/components/IntelligenceManage";
import { PENDING_INVITE_KEY } from "@/lib/team-client";
import { CONFIRM_EMAIL_TEXT, isUnverified } from "@/lib/portal-links";

/** The verified identity the paid routes now require. The email is no longer sent: the server reads it
 *  from the token, so a request cannot name someone else's account. */
async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await (await loadSupabase()).auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: "Bearer " + token } : {};
}

export default function AccountPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  // "owner" runs the subscription and manages its seats; "member" holds a seat on someone else's.
  const [role, setRole] = useState<"owner" | "member" | null>(null);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  // "We could not check" is not "you have not subscribed". Showing a paying
  // subscriber the upgrade prompt because our own store was unreachable is the
  // client half of the defect fixed in app/api/subscription-status.
  const [unreachable, setUnreachable] = useState(false);
  // An unconfirmed email is not "not subscribed": say so rather than showing the upgrade prompt.
  const [unverified, setUnverified] = useState(false);

  useEffect(() => {
    // Signed out and not returning from a sign-in link: go straight to the sign-in page without downloading the Supabase client.
    if (!mayHaveSession()) { router.replace("/account/login"); return; }
    loadSupabase().then((sb) => sb.auth.getSession()).then(async ({ data }) => {
      const userEmail = data.session?.user?.email ?? null;
      if (!userEmail) { router.replace("/account/login"); return; }
      setEmail(userEmail);
      // An invitation link was opened before this person was signed in: pick it up where they left it.
      try {
        const pending = JSON.parse(localStorage.getItem(PENDING_INVITE_KEY) || "null") as { token?: string; at?: number } | null;
        localStorage.removeItem(PENDING_INVITE_KEY);   // used once: the invitation page has the link, and this must not trap the dashboard
        if (pending?.token && typeof pending.at === "number" && Date.now() - pending.at < 7 * 86_400_000) {
          router.replace("/account/invite/" + encodeURIComponent(pending.token));
          return;
        }
      } catch { /* storage unavailable: the emailed link still works */ }
      try {
        const res = await fetch("/api/subscription-status", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: "{}",
        });
        const j = await res.json();
        if (!res.ok) {
          setUnreachable(true);
          setActive(false);
        } else {
          setActive(!!j.active);
          setUnverified(isUnverified(j));
          setPlan(j.plan ?? null);
          setRole(j.role === "member" ? "member" : j.role === "owner" ? "owner" : null);
          setOwnerEmail(typeof j.ownerEmail === "string" ? j.ownerEmail : null);
        }
      } catch { setUnreachable(true); setActive(false); }
      setLoading(false);
    });
  }, [router]);

  async function signOut() {
    await (await loadSupabase()).auth.signOut();
    router.replace("/account/login");
  }

  if (loading) {
    return (<div className="bg-ink min-h-screen pt-32 flex justify-center"><Loader2 className="animate-spin text-power" /></div>);
  }

  return (
    <div className="bg-ink min-h-screen pt-28 pb-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between mb-8">
            <div>
              <div className="eyebrow text-power mb-2">GridForge Intelligence</div>
              <h1 className="text-3xl font-semibold tracking-tight">Siting dashboard</h1>
              <p className="text-mute text-sm mt-1">{email}{intelligencePlanName(plan) ? " - " + intelligencePlanName(plan) + " plan" : ""}</p>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="data text-xs uppercase tracking-[0.1em] text-mute hover:text-white">
                Engagements →
              </Link>
              <button onClick={signOut} className="data text-xs uppercase tracking-[0.1em] text-mute hover:text-white inline-flex items-center gap-1.5"><LogOut size={14} /> Sign out</button>
            </div>
          </div>
          {active && role === "member" && (
            <p className="mb-6 rounded-lg border border-line bg-panel px-4 py-3 text-[13px] text-mute">
              You have a seat on <span className="text-white">{ownerEmail}</span>&apos;s subscription.
            </p>
          )}
          {active ? <Intelligence email={email!} /> : unreachable ? <Unavailable /> : unverified ? <ConfirmEmail /> : <Gate />}
          {active && role === "owner" && <div className="mt-8"><TeamPanel headers={authHeaders} /></div>}
          {/* Billing: the owner opens Stripe's billing page to update the card or cancel; a seat member is told who does. */}
          {active && role && <IntelligenceManage role={role} ownerEmail={ownerEmail} authHeaders={authHeaders} />}
        </div>
    </div>
  );
}

function Unavailable() {
  return (
    <div className="rounded-[var(--radius)] border border-line bg-panel p-8">
      <div className="eyebrow text-mute mb-2">Temporarily unavailable</div>
      <h2 className="text-xl font-semibold tracking-tight">We could not check your subscription</h2>
      <p className="text-mute text-[14px] leading-relaxed mt-2 max-w-xl">
        This is a fault on our side, not a change to your account. Nothing has been
        cancelled and you have not been charged for anything new. Reload in a moment,
        and if it persists, reply to your receipt and a person will pick it up.
      </p>
      <button
        onClick={() => window.location.reload()}
        className="mt-5 inline-flex items-center gap-2 rounded-lg border border-line px-5 py-3 text-sm font-semibold hover:border-power transition-all"
      >
        Try again
      </button>
    </div>
  );
}

function ConfirmEmail() {
  return (
    <div role="status" className="rounded-[var(--radius)] border border-line bg-panel p-8">
      <div className="eyebrow text-mute mb-2">Email not confirmed</div>
      <h2 className="text-xl font-semibold tracking-tight">Confirm your email to open this</h2>
      <p className="text-mute text-[14px] leading-relaxed mt-2 max-w-xl">{CONFIRM_EMAIL_TEXT}</p>
    </div>
  );
}

function Gate() {
  return (
    <div className="rounded-[var(--radius)] border border-line bg-panel p-8">
      <div className="eyebrow text-mute mb-2">Subscription required</div>
      <h2 className="text-xl font-semibold tracking-tight">Activate GridForge Intelligence</h2>
      <p className="text-mute text-[14px] leading-relaxed mt-2 max-w-xl">A modelled ranking of regions by time to energize with measured US queue history beside it, market and grid context that states its source and time, saved scenarios, board briefs and an AI siting analyst. Choose a plan to unlock.</p>
      <Link href="/intelligence" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-power text-ink px-5 py-3 text-sm font-semibold hover:bg-power/90 transition-all">View plans</Link>
      <SuspendedAccessNote />
    </div>
  );
}

function Intelligence({ email }: { email: string }) {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="space-y-8">
      {/* The modelled ranking, every figure labelled modelled / measured / assumed */}
      <IntelligenceSignalTable />

      {/* Market and grid context, each figure with source, time it describes, retrieval time and basis; unavailable says so */}
      <IntelligenceContext />

      {/* Saved scenarios comparison */}
      <SavedScenarios email={email} refreshKey={refreshKey} />

      {/* Cost-of-delay calculator — the core hook */}
      <DelayCalculator email={email} onSaved={() => setRefreshKey((k) => k + 1)} />

      {/* AI siting analyst */}
      <SitingAnalyst email={email} />
    </div>
  );
}

type Scenario = { id: string; name: string; mw: number; region_id: string; value_per_mw_month: number; months_saved: number; avoided_eur: number };

function SavedScenarios({ email, refreshKey }: { email: string; refreshKey: number }) {
  const [rows, setRows] = useState<Scenario[]>([]);
  const [loaded, setLoaded] = useState(false);
  // "Could not read them" is not "you have none": say which it is.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let on = true;
    authHeaders()
      .then((h) => fetch("/api/scenarios", { headers: h }))
      .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }))
      .then(({ ok, j }) => {
        if (!on) return;
        if (ok && Array.isArray(j.scenarios)) { setRows(j.scenarios); setFailed(false); } else setFailed(true);
        setLoaded(true);
      })
      .catch(() => { if (on) { setFailed(true); setLoaded(true); } });
    return () => { on = false; };
  }, [email, refreshKey]);

  async function remove(id: string) {
    // Optimistic, but reversible: a delete that did not happen must not leave the
    // row missing from the screen until the next reload, or the subscriber
    // believes they removed something they still have.
    const before = rows;
    setRows((rs) => rs.filter((r) => r.id !== id));
    try {
      const res = await fetch(
        "/api/scenarios?id=" + encodeURIComponent(id),
        { method: "DELETE", headers: await authHeaders() }
      );
      if (!res.ok) setRows(before);
    } catch { setRows(before); }
  }

  if (!loaded) return null;
  if (failed) {
    return (
      <div role="note" className="rounded-[var(--radius)] border border-line bg-panel p-6 text-sm text-mute">
        <span className="font-semibold text-ghost">Saved scenarios unavailable.</span> They could not be read just now; nothing has been removed. Reload to try again.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-[var(--radius)] border border-line bg-panel p-6 text-sm text-mute">
        <span className="font-semibold text-ghost">No saved scenarios yet.</span> Save one from the cost-of-delay calculator below and it appears here for comparison.
      </div>
    );
  }
  const best = Math.max(...rows.map((r) => r.avoided_eur));

  return (
    <div className="rounded-[var(--radius)] border border-line bg-panel p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="eyebrow text-power mb-1">Your scenarios</div>
          <h2 className="text-lg font-semibold tracking-tight">Saved sites — compared</h2>
        </div>
        <div className="data text-[10px] text-faint">{rows.length} saved</div>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {rows.map((r) => (
          <div key={r.id} className={`rounded-lg border p-4 ${r.avoided_eur === best ? "border-power/40 bg-power/[0.04]" : "border-line bg-ink"}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium text-white text-sm">{r.name}</div>
              <button onClick={() => remove(r.id)} aria-label={"Remove saved scenario " + r.name} className="data text-[10px] text-faint hover:text-red-400 shrink-0">remove</button>
            </div>
            <div className="text-2xl font-semibold text-power tracking-tight mt-2">{eurCompact(r.avoided_eur)}</div>
            <div className="data text-[10px] text-faint mt-1">{r.months_saved} months sooner{r.avoided_eur === best ? " · best" : ""}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DelayCalculator({ email, onSaved }: { email: string; onSaved: () => void }) {
  const [mw, setMw] = useState(100);
  const [valuePerMwMonth, setVpm] = useState(25000);
  const ranked = [...SITING_REGIONS].map((r) => ({ ...r, score: sitingScore(r) })).sort((a, b) => b.score - a.score);
  const [regionId, setRegionId] = useState(ranked[0].id);
  const region = ranked.find((r) => r.id === regionId) ?? ranked[0];
  const d = costOfDelay(mw, region, valuePerMwMonth);
  const pct = d.queueCostEur > 0 ? (d.btmCostEur / d.queueCostEur) * 100 : 0;
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [showBrief, setShowBrief] = useState(false);
  const [briefCompany, setBriefCompany] = useState("");

  async function downloadBrief() {
    await generateSitingBrief({ mw, region, valuePerMwMonth, preparedFor: briefCompany || undefined });
    setShowBrief(false);
    // Log the brief as a lead in the existing funnel (best-effort).
    try {
      await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capacity: mw + " MW",
          location: region.region,
          urgency: "exploratory",
          gridStatus: "unknown",
          services: [PRODUCTS.density_screen.name],
          message: "Generated a board brief for " + mw + " MW in " + region.region + " (" + eurCompact(d.avoidedEur) + " unlocked).",
          name: "Intelligence subscriber",
          company: briefCompany || "Intelligence subscriber",
          email,
          context: "intelligence-brief",
        }),
      });
    } catch { /* non-blocking */ }
    setBriefCompany("");
  }

  async function saveScenario() {
    setSaving(true);
    setSavedMsg("");
    try {
      const res = await fetch("/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          name: region.region + " · " + mw + " MW",
          mw,
          regionId: region.id,
          valuePerMwMonth,
          monthsSaved: d.monthsSaved,
          avoidedEur: d.avoidedEur,
        }),
      });
      const j = await res.json();
      if (j.ok) { setSavedMsg("Saved"); onSaved(); }
      else setSavedMsg(typeof j.error === "string" ? j.error : "Could not save");
    } catch { setSavedMsg("Could not save"); }
    finally { setSaving(false); setTimeout(() => setSavedMsg(""), 2500); }
  }

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
          <label htmlFor="dc-mw" className="data text-[10px] text-faint">SITE SIZE — {mw} MW</label>
          <input id="dc-mw" type="range" min={5} max={500} step={5} value={mw} onChange={(e) => setMw(Number(e.target.value))} className="w-full mt-2 accent-[color:var(--power,#38bdf8)]" />
        </div>
        <div>
          <label htmlFor="dc-region" className="data text-[10px] text-faint">REGION</label>
          <select id="dc-region" value={regionId} onChange={(e) => setRegionId(e.target.value)} className="w-full mt-2 bg-ink border border-line rounded-lg px-3 py-2 text-[13px] text-white focus:border-power/50 focus:outline-none">
            {ranked.map((r) => <option key={r.id} value={r.id}>{r.region}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dc-vpm" className="data text-[10px] text-faint">€/MW-MONTH STRANDED</label>
          <input id="dc-vpm" type="number" step={1000} value={valuePerMwMonth} onChange={(e) => setVpm(Math.max(0, Number(e.target.value)))} className="w-full mt-2 bg-ink border border-line rounded-lg px-3 py-2 text-[13px] text-white focus:border-power/50 focus:outline-none" />
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
            <span className="data text-[11px] text-power whitespace-nowrap">{region.btmMonths}mo assumed · {eurCompact(d.btmCostEur)}</span>
          </div>
        </div>
      </div>
      <p className="data text-[10px] text-faint mt-3" data-testid="queue-basis">
        Queue path: {queueBasisNote(region)} BTM path: an assumption for this comparison, not a quotation or a delivery date.
      </p>
      <div className="mt-5 flex flex-wrap gap-3 items-center">
        <button onClick={() => setShowBrief(true)} className="rounded-lg border border-power/40 text-power px-5 py-2.5 text-sm font-semibold inline-flex items-center gap-2 hover:bg-power/10 transition-all">
          <Download size={14} /> Download board brief (PDF)
        </button>
        <button onClick={saveScenario} disabled={saving} className="rounded-lg bg-power text-ink px-5 py-2.5 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50 hover:bg-power/90 transition-all">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <><Save size={14} /> Save scenario</>}
        </button>
        <span role="status" aria-live="polite" className="data text-[11px] text-power">{savedMsg}</span>
      </div>
      <p className="data text-[10px] text-faint mt-4">Stranded value = your assumption for revenue/strategic value per MW per month a site sits un-energized. Directional; a <Link href="/pricing" className="text-power underline">Density Screen</Link> confirms site-specific figures for one hall.</p>
      {showBrief && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6" onClick={() => setShowBrief(false)} onKeyDown={(e) => { if (e.key === "Escape") setShowBrief(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="brief-h" className="w-full max-w-md rounded-[var(--radius)] border border-line bg-panel p-6" onClick={(e) => e.stopPropagation()}>
            <div className="eyebrow text-power mb-2">Board brief</div>
            <h3 id="brief-h" className="text-lg font-semibold tracking-tight">Prepare your brief</h3>
            <p className="text-mute text-[13px] mt-1 mb-4">We will brand the one-pager for your organization. Optional — leave blank for an unbranded brief.</p>
            <input aria-label="Company or organization (optional)" autoFocus value={briefCompany} onChange={(e) => setBriefCompany(e.target.value)} placeholder="Company / organization" className="w-full bg-ink border border-line rounded-lg px-3.5 py-2.5 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none" />
            <div className="flex gap-3 mt-4">
              <button onClick={downloadBrief} className="flex-1 rounded-lg bg-power text-ink px-4 py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 hover:bg-power/90 transition-all">
                <Download size={14} /> Generate PDF
              </button>
              <button onClick={() => setShowBrief(false)} className="rounded-lg border border-line text-mute px-4 py-2.5 text-sm hover:text-white transition-all">Cancel</button>
            </div>
          </div>
        </div>
      )}
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
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ brief }),
      });
      const j = await res.json();
      setAnalysis(j.ok ? j.analysis : (j.error || "Analyst unavailable."));
    } catch { setAnalysis("The analyst could not be reached just now. Nothing was generated."); }
    finally { setLoading(false); }
  }

  return (
    <div className="rounded-[var(--radius)] border border-power/30 bg-power/[0.03] p-6">
      <div className="eyebrow text-power mb-2">AI siting analyst</div>
      <h2 className="text-lg font-semibold tracking-tight">Get a recommendation for your site</h2>
      <p className="text-mute text-[13px] mt-1 mb-4">Describe your site — MW, region preference, timeline, workload — and the analyst ranks the best markets and queue-bypass path from the modelled table above (it reads no live feed). It is an AI model, so check what it says against that table. Directional; a <Link href="/pricing" className="text-power underline">Density Screen</Link> confirms figures for one hall.</p>
      <textarea aria-label="Project brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="e.g. 80 MW for AI training, flexible on US region, need power by Q3 next year, prioritize low cost and fast energization." className="w-full resize-none bg-ink border border-line rounded-lg px-3.5 py-3 text-[13px] text-white placeholder:text-faint focus:border-power/50 focus:outline-none" />
      <button onClick={analyze} disabled={loading || !brief.trim()} className="mt-3 rounded-lg bg-power text-ink px-5 py-2.5 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-40 hover:bg-power/90 transition-all">
        {loading ? <Loader2 size={15} className="animate-spin" /> : <><Send size={14} /> Analyze my site</>}
      </button>
      {analysis && (
        <div role="status" aria-live="polite" className="mt-5 pt-5 border-t border-line text-[14px] text-ghost/90 leading-relaxed whitespace-pre-wrap">{analysis}</div>
      )}
    </div>
  );
}
