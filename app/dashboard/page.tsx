"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Clock,
  TrendingUp,
  Calendar,
  CheckCircle2,
  ArrowRight,
  LogOut,
  Plus,
  MapPin,
  Zap,
  Gauge,
} from "lucide-react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { toast } from "sonner";
import { openAudit } from "@/lib/ui";
import { Logo } from "@/components/Navbar";

interface User {
  email: string;
  name: string;
  company: string;
}

interface Project {
  id: number;
  name: string;
  location: string;
  capacity: string;
  status: "Active" | "In progress" | "Planning";
  progress: number;
  nextMilestone: string;
  eta: string;
}

const projects: Project[] = [
  {
    id: 1,
    name: "Texas AI training cluster — Phase 1",
    location: "Dallas–Fort Worth, TX",
    capacity: "48 MW",
    status: "Active",
    progress: 72,
    nextMilestone: "BESS commissioning complete",
    eta: "Mar 12, 2026",
  },
  {
    id: 2,
    name: "Northern Virginia expansion",
    location: "Ashburn, VA",
    capacity: "22 MW",
    status: "In progress",
    progress: 41,
    nextMilestone: "DC bus energization",
    eta: "Apr 28, 2026",
  },
  {
    id: 3,
    name: "Frankfurt pilot site",
    location: "Frankfurt, DE",
    capacity: "35 MW",
    status: "Planning",
    progress: 18,
    nextMilestone: "Final design review",
    eta: "Q3 2026",
  },
];

const reports = [
  { id: 101, title: "Power audit — Texas site", date: "2025-12-18", type: "Audit", status: "Final" },
  { id: 102, title: "Feasibility study — Ashburn expansion", date: "2026-01-09", type: "Feasibility", status: "Final" },
  { id: 103, title: "Integration design package v2.1", date: "2026-02-03", type: "Engineering", status: "Final" },
  { id: 104, title: "Performance validation — Phase 1", date: "2026-02-28", type: "Commissioning", status: "Draft" },
];

const pilot = {
  current: "Texas Phase 1 — 48 MW hybrid",
  efficiency: "99.1%",
  uptime: "99.87%",
  lastOptimized: "2 hours ago",
  savings: "$1.84M",
};

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<"projects" | "reports" | "pilot">("projects");

  useEffect(() => {
    const auth = sessionStorage.getItem("gridforge_demo");
    const data = sessionStorage.getItem("gridforge_user");
    if (!auth || !data) {
      router.push("/");
      return;
    }
    try {
      setUser(JSON.parse(data));
    } catch {
      router.push("/");
    }
  }, [router]);

  const logout = () => {
    sessionStorage.removeItem("gridforge_demo");
    sessionStorage.removeItem("gridforge_user");
    router.push("/");
  };

  const sampleToast = () =>
    toast("Preview only", {
      description: "This portal shows sample data. Live accounts connect to your real projects.",
    });

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
      {/* Preview banner */}
      <div className="bg-power/10 border-b border-power/20">
        <div className="max-w-7xl mx-auto px-6 py-2.5 flex items-center justify-center gap-2 text-center">
          <span className="pill pill-progress">PREVIEW</span>
          <span className="text-xs text-power/90">
            Interactive demo with sample data — not a live account.
          </span>
        </div>
      </div>

      {/* Header */}
      <div className="border-b border-line bg-[#060912]">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div>
              <div className="font-semibold text-xl tracking-tight">Client portal</div>
              <div className="data text-[10px] text-faint tracking-[0.14em]">
                GRIDFORGE AI
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right hidden sm:block">
              <div className="font-medium">{user.name}</div>
              <div className="text-faint text-xs">{user.company}</div>
            </div>
            <button
              onClick={logout}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-line hover:bg-white/5 text-mute hover:text-white transition-all text-sm"
            >
              <LogOut size={15} /> Exit
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-10">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-9">
          <div>
            <div className="eyebrow">SAMPLE WORKSPACE</div>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mt-1">
              Good to see you, {user.name.split(" ")[0]}.
            </h1>
          </div>
          <button
            onClick={() => openAudit("dashboard")}
            className="btn-primary px-6 py-3 rounded-xl text-sm flex items-center gap-2 self-start md:self-auto"
          >
            <Plus size={16} /> New consultation
          </button>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {[
            { label: "Active capacity", value: "105 MW", icon: Zap, note: "+48 MW this quarter" },
            { label: "System efficiency", value: "99.1%", icon: Gauge, note: "+0.4% vs target" },
            { label: "Projects live", value: "3", icon: CheckCircle2, note: "2 on schedule" },
            { label: "Energy savings", value: "$2.9M", icon: TrendingUp, note: "YTD, sample" },
          ].map((m, i) => {
            const Icon = m.icon;
            return (
              <div key={i} className="panel p-5">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="data text-[10px] tracking-[0.1em] text-faint">
                      {m.label.toUpperCase()}
                    </div>
                    <div className="data text-3xl font-semibold tracking-tight mt-2">
                      {m.value}
                    </div>
                  </div>
                  <Icon className="w-6 h-6 text-power/60" />
                </div>
                <div className="text-verified text-xs mt-3">{m.note}</div>
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
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key as typeof tab)}
                className={`flex items-center gap-2 px-6 py-4 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-all ${
                  active
                    ? "border-power text-white"
                    : "border-transparent text-mute hover:text-white"
                }`}
              >
                <Icon size={16} /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Projects */}
        {tab === "projects" && (
          <div className="space-y-4">
            {projects.map((p) => (
              <motion.div
                key={p.id}
                whileHover={{ y: -1 }}
                className="panel p-6 sm:p-7 flex flex-col lg:flex-row lg:items-center gap-7"
              >
                <div className="flex-1">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold text-xl tracking-tight">
                        {p.name}
                      </div>
                      <div className="flex items-center gap-2 text-mute mt-1 text-sm">
                        <MapPin size={14} /> {p.location} · {p.capacity}
                      </div>
                    </div>
                    <span
                      className={`pill ${
                        p.status === "Active"
                          ? "pill-verified"
                          : p.status === "Planning"
                          ? "pill-queue"
                          : "pill-progress"
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>
                  <div className="mt-5">
                    <div className="flex justify-between data text-[11px] mb-2 text-mute">
                      <span>PROGRESS</span>
                      <span>{p.progress}%</span>
                    </div>
                    <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-power to-[#38BDF8]"
                        style={{ width: `${p.progress}%` }}
                      />
                    </div>
                  </div>
                </div>
                <div className="lg:w-72 space-y-3 text-sm">
                  <div className="flex justify-between border-b border-line pb-3">
                    <span className="text-mute">Next milestone</span>
                    <span className="font-medium text-right">{p.nextMilestone}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-mute">Target</span>
                    <span className="data font-medium">{p.eta}</span>
                  </div>
                  <button
                    onClick={sampleToast}
                    className="w-full mt-1 py-2.5 data text-[11px] tracking-wider border border-line hover:bg-white/5 rounded-xl flex items-center justify-center gap-2 text-power transition-colors"
                  >
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
                  <tr key={r.id} className="hover:bg-white/5 transition-colors group">
                    <td className="px-6 py-5 font-medium">{r.title}</td>
                    <td className="px-6 py-5 text-mute hidden md:table-cell">{r.type}</td>
                    <td className="px-6 py-5 text-mute data text-xs">
                      {format(new Date(r.date), "MMM dd, yyyy")}
                    </td>
                    <td className="px-6 py-5">
                      <span className={`pill ${r.status === "Final" ? "pill-verified" : "pill-queue"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-right">
                      <button
                        onClick={sampleToast}
                        className="data text-power text-[11px] tracking-wider flex items-center gap-1.5 group-hover:underline ml-auto"
                      >
                        OPEN <ArrowRight size={13} />
                      </button>
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
              <div className="eyebrow mb-2">SAMPLE PILOT — TEXAS PHASE 1</div>
              <div className="text-3xl font-semibold tracking-tight mb-8">
                {pilot.current}
              </div>
              <div className="grid grid-cols-2 gap-y-8">
                <Metric label="SYSTEM EFFICIENCY" value={pilot.efficiency} accent />
                <Metric label="UPTIME (90 DAYS)" value={pilot.uptime} />
                <div>
                  <div className="data text-[10px] text-faint tracking-[0.1em]">
                    LAST EMS OPTIMIZATION
                  </div>
                  <div className="font-medium mt-2 text-lg">{pilot.lastOptimized}</div>
                </div>
                <div>
                  <div className="data text-[10px] text-faint tracking-[0.1em]">
                    ENERGY SAVINGS (YTD)
                  </div>
                  <div className="data font-semibold text-3xl mt-1 text-verified">
                    {pilot.savings}
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-2 space-y-5">
              <div className="panel p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-verified/10">
                    <CheckCircle2 className="text-verified w-5 h-5" />
                  </div>
                  <div className="font-semibold">All systems nominal</div>
                </div>
                <p className="text-sm text-mute">
                  Sample telemetry: the EMS shaved three inference spikes this week
                  with zero curtailment.
                </p>
              </div>
              <div className="panel p-6 text-sm">
                <div className="font-semibold mb-4 flex items-center gap-2">
                  <Calendar size={16} /> Upcoming milestones
                </div>
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
          Interactive preview. In a live deployment this connects to your real
          projects via authenticated APIs.<br />
          Questions? <span className="text-power">power@gridforge.ai</span>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="data text-[10px] text-faint tracking-[0.1em]">{label}</div>
      <div
        className={`data text-5xl font-semibold tracking-tight mt-1 ${
          accent ? "text-power" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Row({ a, b, verified }: { a: string; b: string; verified?: boolean }) {
  return (
    <div className="flex justify-between">
      <span>{a}</span>
      <span className={`data ${verified ? "text-verified" : "text-mute"}`}>{b}</span>
    </div>
  );
}
