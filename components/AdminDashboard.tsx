"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, LogOut, ChevronDown, ChevronUp, AlertTriangle, RefreshCw } from "lucide-react";
import type { AdminLead, LeadStatus } from "@/lib/admin";

const STATUSES: LeadStatus[] = ["new", "reviewed", "call_booked", "proposal", "won", "lost"];
const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  reviewed: "Reviewed",
  call_booked: "Call booked",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};
const TIERS = ["hot", "warm", "exploratory"] as const;
type Tier = (typeof TIERS)[number];

const tierClass: Record<Tier, string> = {
  hot: "text-flag border-flag/40 bg-flag/10",
  warm: "text-queue border-queue/40 bg-queue/10",
  exploratory: "text-mute border-line bg-panel-2/60",
};

export function AdminDashboard({
  initial,
  supabaseReady,
}: {
  initial: AdminLead[];
  supabaseReady: boolean;
}) {
  const router = useRouter();
  const [leads, setLeads] = useState<AdminLead[]>(initial);
  const [tierFilter, setTierFilter] = useState<Tier | "all">("all");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">("all");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = { hot: 0, warm: 0, exploratory: 0, open: 0 } as Record<string, number>;
    for (const l of leads) {
      c[l.tier] = (c[l.tier] ?? 0) + 1;
      if (l.status !== "won" && l.status !== "lost") c.open += 1;
    }
    return c;
  }, [leads]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (tierFilter !== "all" && l.tier !== tierFilter) return false;
      if (statusFilter !== "all" && l.status !== statusFilter) return false;
      if (needle) {
        const hay = `${l.company} ${l.name} ${l.email} ${l.location}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [leads, tierFilter, statusFilter, q]);

  const setStatus = async (id: string, status: LeadStatus) => {
    const prev = leads;
    setSaving(id);
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, status } : l))); // optimistic
    try {
      const res = await fetch("/api/admin/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) setLeads(prev); // rollback
    } catch {
      setLeads(prev);
    } finally {
      setSaving(null);
    }
  };

  const logout = async () => {
    await fetch("/api/admin/login", { method: "DELETE" });
    router.replace("/admin/login");
    router.refresh();
  };

  return (
    <main className="min-h-screen px-4 sm:px-8 py-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <div className="eyebrow mb-1">PIPELINE</div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Lead pipeline</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.refresh()}
            className="btn-secondary px-4 py-2 rounded-lg text-sm flex items-center gap-2"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={logout}
            className="btn-secondary px-4 py-2 rounded-lg text-sm flex items-center gap-2"
          >
            <LogOut size={14} /> Log out
          </button>
        </div>
      </div>

      {!supabaseReady && (
        <div className="panel p-4 mb-6 flex items-start gap-3 border-queue/40">
          <AlertTriangle size={18} className="text-queue shrink-0 mt-0.5" />
          <p className="text-sm text-mute">
            Supabase isn&apos;t configured, so no leads are stored yet. Set{" "}
            <code className="font-mono text-power">SUPABASE_URL</code> and{" "}
            <code className="font-mono text-power">SUPABASE_SERVICE_ROLE_KEY</code>, run{" "}
            <code className="font-mono text-power">supabase/schema.sql</code>, and submit a test
            audit to see it here.
          </p>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Total leads" value={leads.length} />
        <Stat label="Hot" value={counts.hot} accent="flag" />
        <Stat label="Warm" value={counts.warm} accent="queue" />
        <Stat label="Open (not closed)" value={counts.open} accent="power" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, name, email, location…"
            className="field w-full pl-9 pr-4 py-2.5 rounded-lg text-sm"
          />
        </div>
        <Segmented
          value={tierFilter}
          onChange={setTierFilter}
          options={[["all", "All tiers"], ["hot", "Hot"], ["warm", "Warm"], ["exploratory", "Exploratory"]]}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "all")}
          className="field px-3 py-2.5 rounded-lg text-sm"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      {/* List */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="panel p-8 text-center text-mute text-sm">
            No leads match these filters.
          </div>
        )}
        {filtered.map((l) => {
          const open = expanded === l.id;
          return (
            <div key={l.id} className="panel overflow-hidden">
              <button
                onClick={() => setExpanded(open ? null : l.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-panel-2/40"
              >
                <span
                  className={`font-mono text-[10px] uppercase px-2 py-1 rounded border shrink-0 ${
                    tierClass[l.tier as Tier]
                  }`}
                >
                  {l.tier} · {l.score}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {l.company}
                    <span className="text-faint font-normal"> — {l.name}</span>
                  </div>
                  <div className="text-xs text-mute font-mono truncate">
                    {l.capacity_mw ? `${l.capacity_mw} MW · ` : ""}
                    {l.location} · {l.context}
                  </div>
                </div>
                <span className="text-[10px] font-mono text-faint shrink-0 hidden sm:block">
                  {new Date(l.created_at).toLocaleDateString()}
                </span>
                {open ? <ChevronUp size={16} className="text-faint" /> : <ChevronDown size={16} className="text-faint" />}
              </button>

              {open && (
                <div className="px-4 pb-4 pt-1 border-t border-line space-y-3 text-sm">
                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs text-mute pt-3">
                    <span>email: <a className="text-power" href={`mailto:${l.email}`}>{l.email}</a></span>
                    <span>timeline: {l.urgency}</span>
                    <span>grid: {l.grid_status}</span>
                    <span>services: {l.services.join(", ") || "—"}</span>
                  </div>
                  {l.reasons.length > 0 && (
                    <p className="text-xs text-faint">
                      <span className="text-mute">why scored:</span> {l.reasons.join("; ")}
                    </p>
                  )}
                  <p className="text-mute whitespace-pre-wrap">{l.message}</p>
                  <div className="flex items-center gap-2 pt-1">
                    <span className="eyebrow text-[10px] text-faint">STATUS</span>
                    <select
                      value={l.status}
                      onChange={(e) => setStatus(l.id, e.target.value as LeadStatus)}
                      disabled={saving === l.id}
                      className="field px-3 py-2 rounded-lg text-sm disabled:opacity-60"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                    {saving === l.id && <span className="text-xs text-faint">saving…</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}

const STAT_COLOR: Record<string, string> = {
  flag: "text-flag",
  queue: "text-queue",
  power: "text-power",
  verified: "text-verified",
};
function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = (accent && STAT_COLOR[accent]) || "text-ghost";
  return (
    <div className="panel p-4">
      <div className={`text-2xl font-semibold font-mono ${color}`}>{value}</div>
      <div className="text-xs text-mute mt-0.5">{label}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="flex rounded-lg border border-line overflow-hidden">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-3 py-2.5 text-xs font-medium transition-colors ${
            value === v ? "bg-power/15 text-power" : "text-mute hover:bg-panel-2/40"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
