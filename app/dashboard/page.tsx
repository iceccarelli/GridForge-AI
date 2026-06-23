"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileText, Clock, TrendingUp, Calendar, CheckCircle2, ArrowRight, LogOut,
  Plus, MapPin, Zap, Gauge, X, Battery, Activity, DollarSign, Download,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { format } from "date-fns";
import { toast } from "sonner";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { openAudit } from "@/lib/ui";
import { Logo } from "@/components/Navbar";

interface User { email: string; name: string; company: string; }
interface Project {
  id: number; name: string; location: string; capacity: string;
  status: "Active" | "In progress" | "Planning"; progress: number;
  nextMilestone: string; eta: string;
}

const projects: Project[] = [
  { id: 1, name: "Texas AI training cluster — Phase 1", location: "Dallas–Fort Worth, TX", capacity: "48 MW", status: "Active", progress: 72, nextMilestone: "BESS commissioning complete", eta: "Mar 12, 2026" },
  { id: 2, name: "Northern Virginia expansion", location: "Ashburn, VA", capacity: "22 MW", status: "In progress", progress: 41, nextMilestone: "DC bus energization", eta: "Apr 28, 2026" },
  { id: 3, name: "Frankfurt pilot site", location: "Frankfurt, DE", capacity: "35 MW", status: "Planning", progress: 18, nextMilestone: "Final design review", eta: "Q3 2026" },
];

const reports = [
  { id: 101, title: "Power audit — Texas site", date: "2025-12-18", type: "Audit", status: "Final", summary: "Site-level read on interconnection position, available behind-the-meter capacity, and a first-pass firm-power topology. Identifies a ~4.5-year time-to-power gap and the BTM path that closes it." },
  { id: 102, title: "Feasibility study — Ashburn expansion", date: "2026-01-09", type: "Feasibility", status: "Final", summary: "Bankable sizing for a 22 MW expansion: gas + BESS firming mix, phased capex aligned to the cluster ramp, and an arbitrage-inclusive operating model against regional wholesale prices." },
  { id: 103, title: "Integration design package v2.1", date: "2026-02-03", type: "Engineering", status: "Final", summary: "Single-line, protection coordination, and EMS control narrative for the hybrid plant. Includes islanding logic and grid-services interface at the POI." },
  { id: 104, title: "Performance validation — Phase 1", date: "2026-02-28", type: "Commissioning", status: "Draft", summary: "Draft commissioning results: measured transient absorption, round-trip efficiency, and uptime against SLA targets. Pending final sign-off." },
];

const pilot = { current: "Texas Phase 1 — 48 MW hybrid", efficiency: "99.1%", uptime: "99.87%", lastOptimized: "2 hours ago", savings: "$1.84M" };

const milestonesByProject: Record<number, { label: string; date: string; done: boolean }[]> = {
  1: [{ label: "DC bus energization", date: "Jan 22, 2026", done: true }, { label: "BESS commissioning complete", date: "Mar 12, 2026", done: false }, { label: "Grid-services activation", date: "Apr 03, 2026", done: false }],
  2: [{ label: "Site survey & interconnection review", date: "Dec 08, 2025", done: true }, { label: "DC bus energization", date: "Apr 28, 2026", done: false }, { label: "Phase 1 go-live", date: "Jun 2026", done: false }],
  3: [{ label: "Feasibility study", date: "Feb 2026", done: true }, { label: "Final design review", date: "Q3 2026", done: false }, { label: "Groundbreaking", date: "Q4 2026", done: false }],
};

const metricCards = [
  { label: "Active capacity", value: "105 MW", icon: Zap, note: "+48 MW this quarter", spark: [40, 40, 57, 57, 57, 83, 83, 83, 105, 105, 105, 105] },
  { label: "System efficiency", value: "99.1%", icon: Gauge, note: "+0.4% vs target", spark: [98.2, 98.4, 98.3, 98.6, 98.7, 98.9, 98.8, 99.0, 99.0, 99.1, 99.0, 99.1] },
  { label: "Projects live", value: "3", icon: CheckCircle2, note: "2 on schedule", spark: [1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3] },
  { label: "Energy savings", value: "$2.9M", icon: TrendingUp, note: "YTD, sample", spark: [0.2, 0.5, 0.8, 1.1, 1.4, 1.7, 2.0, 2.2, 2.4, 2.6, 2.8, 2.9] },
];

function seedRand(seed: number) {
  let s = seed % 2147483647; if (s <= 0) s += 2147483646;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
function telemetry(p: Project) {
  const cap = parseInt(p.capacity) || 50;
  const r = seedRand(p.id * 131 + 7);
  const load = Array.from({ length: 24 }, (_, h) => {
    const diurnal = 0.78 + 0.18 * Math.sin(((h - 7) / 24) * 2 * Math.PI);
    const spike = r() > 0.82 ? 0.14 : 0;
    const v = cap * (diurnal + spike) * (0.92 + 0.08 * r());
    const soc = Math.round(45 + 38 * Math.abs(Math.sin(((h + p.id * 3) / 24) * 2 * Math.PI)));
    return { h, load: Math.round(Math.max(cap * 0.4, Math.min(cap, v))), soc };
  });
  const savingsToday = Math.round(cap * 1000 * (0.9 + 0.2 * r()));
  return { load, savingsToday, cap };
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<"projects" | "reports" | "pilot">("projects");
  const [selected, setSelected] = useState<Project | null>(null);
  const [openReport, setOpenReport] = useState<(typeof reports)[number] | null>(null);
  const [epex, setEpex] = useState<number | null>(null);

  useEffect(() => {
    const auth = sessionStorage.getItem("gridforge_demo");
    const data = sessionStorage.getItem("gridforge_user");
    if (!auth || !data) { router.push("/"); return; }
    try { setUser(JSON.parse(data)); } catch { router.push("/"); }
  }, [router]);

  useEffect(() => {
    let live = true;
    fetch("/api/market").then((r) => r.json()).then((d) => {
      if (live && d?.ok && typeof d.current === "number") setEpex(d.current);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  const logout = () => {
    sessionStorage.removeItem("gridforge_demo");
    sessionStorage.removeItem("gridforge_user");
    router.push("/");
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-power border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-mute">Opening preview…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink pt-16 sm:pt-20">
      <div className="bg-power/10 border-b border-power/20">
        <div className="max-w-7xl mx-auto px-6 py-2.5 flex items-center justify-center gap-2 text-center">
          <span className="pill pill-progress">PREVIEW</span>
          <span className="text-xs text-power/90">Interactive demo with sample data — not a live account.</span>
        </div>
      </div>

      <div className="border-b border-line bg-[#060912]">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div>
              <div className="font-semibold text-xl tracking-tight">Client portal</div>
              <div className="data text-[10px] text-faint tracking-[0.14em]">GRIDFORGE AI</div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right hidden sm:block">
              <div className="font-medium">{user.name}</div>
              <div className="text-faint text-xs">{user.company}</div>
            </div>
            <button onClick={logout} className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-line hover:bg-white/5 text-mute hover:text-white transition-all text-sm">
              <LogOut size={15} /> Exit
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-10">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-9">
          <div>
            <div className="eyebrow">SAMPLE WORKSPACE</div>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mt-1">Good to see you, {user.name.split(" ")[0]}.</h1>
          </div>
          <button onClick={() => openAudit("dashboard")} className="btn-primary px-6 py-3 rounded-xl text-sm flex items-center gap-2 self-start md:self-auto">
            <Plus size={16} /> New consultation
          </button>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {metricCards.map((m, i) => {
            const Icon = m.icon;
            return (
              <div key={i} className="panel p-5">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="data text-[10px] tracking-[0.1em] text-faint">{m.label.toUpperCase()}</div>
                    <div className="data text-3xl font-semibold tracking-tight mt-2">{m.value}</div>
                  </div>
                  <Icon className="w-6 h-6 text-power/60" />
                </div>
                <div className="flex items-end justify-between gap-2 mt-3">
                  <div className="text-verified text-xs">{m.note}</div>
                  <Sparkline data={m.spark} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-line mb-8 overflow-x-auto">
          {[
            { key: "projects", label: "Projects", icon: Zap },
            { key: "reports", label: "Reports", icon: FileText },
            { key: "pilot", label: "Pilot status", icon: Clock },
          ].map((t) => {
            const Icon = t.icon; const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key as typeof tab)}
                className={`flex items-center gap-2 px-6 py-4 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-all ${active ? "border-power text-white" : "border-transparent text-mute hover:text-white"}`}>
                <Icon size={16} /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Projects */}
        {tab === "projects" && (
          <div className="space-y-4">
            {projects.map((p) => (
              <motion.div key={p.id} whileHover={{ y: -1 }} className="panel p-6 sm:p-7 flex flex-col lg:flex-row lg:items-center gap-7">
                <div className="flex-1">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold text-xl tracking-tight">{p.name}</div>
                      <div className="flex items-center gap-2 text-mute mt-1 text-sm"><MapPin size={14} /> {p.location} · {p.capacity}</div>
                    </div>
                    <span className={`pill ${p.status === "Active" ? "pill-verified" : p.status === "Planning" ? "pill-queue" : "pill-progress"}`}>{p.status}</span>
                  </div>
                  <div className="mt-5">
                    <div className="flex justify-between data text-[11px] mb-2 text-mute"><span>PROGRESS</span><span>{p.progress}%</span></div>
                    <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-power to-[#38BDF8]" style={{ width: `${p.progress}%` }} />
                    </div>
                  </div>
                </div>
                <div className="lg:w-72 space-y-3 text-sm">
                  <div className="flex justify-between border-b border-line pb-3"><span className="text-mute">Next milestone</span><span className="font-medium text-right">{p.nextMilestone}</span></div>
                  <div className="flex justify-between"><span className="text-mute">Target</span><span className="data font-medium">{p.eta}</span></div>
                  <button onClick={() => setSelected(p)} className="w-full mt-1 py-2.5 data text-[11px] tracking-wider border border-line hover:bg-white/5 rounded-xl flex items-center justify-center gap-2 text-power transition-colors">
                    VIEW PROJECT <ArrowRight size={14} />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* Reports */}
        {tab === "reports" && (
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left data text-[10px] tracking-[0.1em] text-faint">
                  <th className="px-6 py-4 font-normal">REPORT</th>
                  <th className="px-6 py-4 font-normal hidden md:table-cell">TYPE</th>
                  <th className="px-6 py-4 font-normal">DATE</th>
                  <th className="px-6 py-4 font-normal">STATUS</th>
                  <th></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {reports.map((r) => (
                  <tr key={r.id} className="hover:bg-white/5 transition-colors group cursor-pointer" onClick={() => setOpenReport(r)}>
                    <td className="px-6 py-5 font-medium">{r.title}</td>
                    <td className="px-6 py-5 text-mute hidden md:table-cell">{r.type}</td>
                    <td className="px-6 py-5 text-mute data text-xs">{format(new Date(r.date), "MMM dd, yyyy")}</td>
                    <td className="px-6 py-5"><span className={`pill ${r.status === "Final" ? "pill-verified" : "pill-queue"}`}>{r.status}</span></td>
                    <td className="px-6 py-5 text-right">
                      <span className="data text-power text-[11px] tracking-wider inline-flex items-center gap-1.5 group-hover:underline ml-auto">OPEN <ArrowRight size={13} /></span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pilot */}
        {tab === "pilot" && (
          <div className="grid lg:grid-cols-5 gap-5">
            <div className="lg:col-span-3 panel p-7 sm:p-8">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow">SAMPLE PILOT — TEXAS PHASE 1</div>
                <LiveEpexTag epex={epex} />
              </div>
              <div className="text-3xl font-semibold tracking-tight mb-8">{pilot.current}</div>
              <div className="grid grid-cols-2 gap-y-8">
                <Metric label="SYSTEM EFFICIENCY" value={pilot.efficiency} accent />
                <Metric label="UPTIME (90 DAYS)" value={pilot.uptime} />
                <div>
                  <div className="data text-[10px] text-faint tracking-[0.1em]">LAST EMS OPTIMIZATION</div>
                  <div className="font-medium mt-2 text-lg">{pilot.lastOptimized}</div>
                </div>
                <div>
                  <div className="data text-[10px] text-faint tracking-[0.1em]">ENERGY SAVINGS (YTD)</div>
                  <div className="data font-semibold text-3xl mt-1 text-verified">{pilot.savings}</div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-2 space-y-5">
              <div className="panel p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-verified/10"><CheckCircle2 className="text-verified w-5 h-5" /></div>
                  <div className="font-semibold">All systems nominal</div>
                </div>
                <p className="text-sm text-mute">Sample telemetry: the EMS shaved three inference spikes this week with zero curtailment.</p>
              </div>
              <div className="panel p-6 text-sm">
                <div className="font-semibold mb-4 flex items-center gap-2"><Calendar size={16} /> Upcoming milestones</div>
                <div className="space-y-3 text-ghost/85">
                  <Row a="Full BESS integration test" b="Mar 4" verified />
                  <Row a="Grid services activation" b="Mar 18" verified />
                  <Row a="Phase 2 design kickoff" b="Apr 2" />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-14 text-center data text-[11px] text-faint leading-relaxed">
          Interactive preview. In a live deployment this connects to your real projects via authenticated APIs.<br />
          Questions? <span className="text-power">power@gridforge.ai</span>
        </div>
      </div>

      <AnimatePresence>
        {selected && <ProjectDrawer project={selected} epex={epex} onClose={() => setSelected(null)} />}
      </AnimatePresence>
      <AnimatePresence>
        {openReport && <ReportDrawer report={openReport} onClose={() => setOpenReport(null)} />}
      </AnimatePresence>
    </div>
  );
}

function ProjectDrawer({ project, epex, onClose }: { project: Project; epex: number | null; onClose: () => void }) {
  const { load, savingsToday, cap } = useMemo(() => telemetry(project), [project]);
  const [nowHour, setNowHour] = useState(12);
  useEffect(() => { setNowHour(new Date().getHours()); }, []);
  const loadNow = load[nowHour]?.load ?? load[12].load;
  const socNow = load[nowHour]?.soc ?? load[12].soc;
  const milestones = milestonesByProject[project.id] ?? [];

  return (
    <>
      <motion.div className="fixed inset-0 bg-black/60 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-[#080d18] border-l border-line z-50 overflow-y-auto"
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "tween", duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
      >
        <div className="sticky top-0 bg-[#080d18]/95 backdrop-blur border-b border-line px-6 py-4 flex items-start justify-between gap-4 z-10">
          <div>
            <div className="flex items-center gap-2">
              <span className={`pill ${project.status === "Active" ? "pill-verified" : project.status === "Planning" ? "pill-queue" : "pill-progress"}`}>{project.status}</span>
              <span className="pill pill-progress">SAMPLE TELEMETRY</span>
            </div>
            <div className="font-semibold text-lg tracking-tight mt-2">{project.name}</div>
            <div className="flex items-center gap-2 text-mute text-sm mt-0.5"><MapPin size={13} /> {project.location} · {project.capacity}</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg border border-line hover:bg-white/5 text-mute" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tile icon={Activity} label="Load now" value={`${loadNow} MW`} sub="sample" />
            <Tile icon={Battery} label="BESS SoC" value={`${socNow}%`} sub="sample" />
            <Tile icon={DollarSign} label="Savings today" value={`$${(savingsToday / 1000).toFixed(1)}k`} sub="sample" accent />
            <Tile icon={Zap} label="Wholesale now" value={epex != null ? `€${Math.round(epex)}` : "—"} sub={epex != null ? "LIVE · EPEX DE" : "feed offline"} live={epex != null} />
          </div>

          <div className="panel p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-[10px]">24-HOUR LOAD PROFILE · SAMPLE</div>
              <div className="data text-[10px] text-faint">peak {Math.max(...load.map((d) => d.load))} MW · {cap} MW cap</div>
            </div>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={load} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="ld" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00E5FF" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#00E5FF" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="h" tick={{ fill: "#5A6478", fontSize: 9, fontFamily: "var(--font-mono), monospace" }} tickLine={false} axisLine={{ stroke: "#1E2942" }} interval={3} tickFormatter={(v) => `${v}`} />
                  <YAxis tick={{ fill: "#5A6478", fontSize: 9, fontFamily: "var(--font-mono), monospace" }} tickLine={false} axisLine={{ stroke: "#1E2942" }} width={38} />
                  <Tooltip contentStyle={{ background: "#0B1120", border: "1px solid #1E2942", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-mono), monospace" }} labelFormatter={(h) => `${h}:00`} formatter={((v: number) => [`${v} MW`, "Load"]) as never} />
                  <ReferenceLine x={nowHour} stroke="#00E5FF" strokeDasharray="3 3" strokeWidth={1} />
                  <Area type="monotone" dataKey="load" stroke="#00E5FF" strokeWidth={2} fill="url(#ld)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="data text-[10px] text-faint mt-1">Modeled sample waveform · the cyan line is the current hour. A live deployment streams measured load.</div>
          </div>

          <div className="panel p-5">
            <div className="font-semibold mb-4 flex items-center gap-2 text-sm"><Calendar size={15} /> Milestone timeline</div>
            <div className="space-y-0">
              {milestones.map((m, i) => (
                <div key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`w-3 h-3 rounded-full mt-1 ${m.done ? "bg-verified" : "bg-line border border-mute"}`} />
                    {i < milestones.length - 1 && <div className="w-px flex-1 bg-line my-1" />}
                  </div>
                  <div className="pb-5">
                    <div className={`text-sm font-medium ${m.done ? "text-ghost" : "text-mute"}`}>{m.label}</div>
                    <div className="data text-[11px] text-faint mt-0.5">{m.date} {m.done && <span className="text-verified ml-1">· complete</span>}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-[10px] text-faint leading-relaxed">
            All account figures on this panel are sample data for preview. The wholesale price is a real live EPEX feed.
            A live deployment connects to your project&apos;s authenticated telemetry.
          </div>
        </div>
      </motion.div>
    </>
  );
}

function ReportDrawer({ report, onClose }: { report: (typeof reports)[number]; onClose: () => void }) {
  return (
    <>
      <motion.div className="fixed inset-0 bg-black/60 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-[#080d18] border-l border-line z-50 overflow-y-auto"
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "tween", duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
      >
        <div className="sticky top-0 bg-[#080d18]/95 backdrop-blur border-b border-line px-6 py-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="pill pill-progress">{report.type.toUpperCase()}</span>
              <span className={`pill ${report.status === "Final" ? "pill-verified" : "pill-queue"}`}>{report.status}</span>
            </div>
            <div className="font-semibold text-lg tracking-tight mt-2">{report.title}</div>
            <div className="data text-[11px] text-faint mt-0.5">{format(new Date(report.date), "MMMM dd, yyyy")}</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg border border-line hover:bg-white/5 text-mute" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="p-6 space-y-5">
          <div>
            <div className="eyebrow text-[10px] mb-2">EXECUTIVE SUMMARY · SAMPLE</div>
            <p className="text-[14px] text-mute leading-relaxed">{report.summary}</p>
          </div>
          <div className="grid grid-cols-3 gap-px bg-line rounded-lg overflow-hidden border border-line">
            {[["Pages", "—"], ["Prepared by", "GridForge"], ["Classification", "Client"]].map(([k, v]) => (
              <div key={k} className="bg-panel p-3"><div className="data text-sm font-semibold text-ghost">{v}</div><div className="text-[10px] text-mute mt-0.5">{k}</div></div>
            ))}
          </div>
          <button onClick={() => toast("Preview only", { description: "Sample report — live accounts deliver the real signed document." })}
            className="btn-secondary w-full py-3 rounded-xl text-sm inline-flex items-center justify-center gap-2">
            <Download size={15} /> Download PDF
          </button>
          <div className="text-[10px] text-faint leading-relaxed">This is a sample report preview. Live accounts deliver the actual engineering deliverable via authenticated download.</div>
        </div>
      </motion.div>
    </>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const W = 64, H = 22;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * (H - 3) - 1.5).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--power)" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" opacity={0.8} />
    </svg>
  );
}

function Tile({ icon: Icon, label, value, sub, accent, live }: { icon: React.ElementType; label: string; value: string; sub: string; accent?: boolean; live?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-[#0b1120] p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-faint data tracking-[0.08em]"><Icon size={12} /> {label.toUpperCase()}</div>
      <div className={`data text-xl font-semibold mt-1.5 ${accent ? "text-verified" : "text-ghost"}`}>{value}</div>
      <div className={`text-[9px] mt-0.5 flex items-center gap-1 ${live ? "text-power" : "text-faint"}`}>
        {live && <span className="w-1 h-1 rounded-full bg-verified animate-pulse" />}{sub}
      </div>
    </div>
  );
}

function LiveEpexTag({ epex }: { epex: number | null }) {
  if (epex == null) return null;
  return (
    <div className="data text-[10px] text-faint flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-verified animate-pulse" />
      LIVE · EPEX <span className="text-ghost ml-0.5">€{Math.round(epex)}/MWh</span>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="data text-[10px] text-faint tracking-[0.1em]">{label}</div>
      <div className={`data text-5xl font-semibold tracking-tight mt-1 ${accent ? "text-power" : ""}`}>{value}</div>
    </div>
  );
}

function Row({ a, b, verified }: { a: string; b: string; verified?: boolean }) {
  return (
    <div className="flex justify-between"><span>{a}</span><span className={`data ${verified ? "text-verified" : "text-mute"}`}>{b}</span></div>
  );
}
