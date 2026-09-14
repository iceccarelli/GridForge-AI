"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { CircleAlert, ExternalLink, Loader2 } from "lucide-react";
import type { AdminDeliverable, AdminQualification, QualificationInsights } from "@/lib/admin";
import { eur } from "@/lib/commerce";
import { PRODUCT_BY_KIND } from "@/lib/products";

/**
 * The pipeline: what came in, what was bought, and what is waiting on you.
 *
 * The release button is the only control here that does anything irreversible to a
 * client's view, and that is deliberate — generation is automated, release is not.
 */

const STATUS_TONE: Record<string, string> = {
  awaiting_intake: "text-mute border-line",
  generating: "text-power border-power/50",
  draft: "text-queue border-queue/50",
  released: "text-verified border-verified/50",
  engine_unavailable: "text-flag border-flag/50",
};

export function EngagementPipeline({
  deliverables,
  qualifications,
  insights,
  supabaseReady,
}: {
  deliverables: AdminDeliverable[];
  qualifications: AdminQualification[];
  insights: QualificationInsights;
  supabaseReady: boolean;
}) {
  const [rows, setRows] = useState(deliverables);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const waiting = useMemo(() => rows.filter((r) => r.status === "draft"), [rows]);
  const revenue = useMemo(
    () => rows.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0),
    [rows]
  );

  async function act(token: string, action: "release" | "unrelease") {
    setBusy(token);
    setError(null);
    try {
      const res = await fetch("/api/admin/deliverables", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body?.error ?? "Could not update this engagement.");
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.token === token
            ? {
                ...r,
                status: body.status,
                released_at: body.status === "released" ? new Date().toISOString() : null,
              }
            : r
        )
      );
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pb-24 pt-24 sm:px-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">Pipeline</p>
          <h1 className="mt-2 text-2xl font-semibold text-ghost">Engagements and qualified halls</h1>
        </div>
        <Link href="/admin" className="text-sm text-mute underline hover:text-ghost">
          Leads →
        </Link>
      </div>

      {!supabaseReady ? (
        <div className="mb-8 flex gap-3 rounded border border-queue/40 bg-queue/10 p-4 text-sm text-ghost">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-queue" />
          <p>
            Supabase is not configured, so nothing is stored and this page is empty by definition.
            Set <code className="font-mono text-power">SUPABASE_URL</code> and{" "}
            <code className="font-mono text-power">SUPABASE_SERVICE_ROLE_KEY</code>, then run
            migrations 0002 and 0003.
          </p>
        </div>
      ) : null}

      <div className="mb-8 grid gap-3 sm:grid-cols-4">
        <Stat label="Waiting on you" value={String(waiting.length)} tone="queue" />
        <Stat label="Engagements" value={String(rows.length)} tone="ghost" />
        <Stat label="Committed" value={eur(revenue)} tone="verified" />
        <Stat label="Halls qualified" value={String(insights.halls)} tone="power" />
      </div>

      {error ? (
        <div className="mb-6 flex gap-3 rounded border border-flag/40 bg-flag/10 p-4 text-sm text-ghost">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" />
          <p>{error}</p>
        </div>
      ) : null}

      <section className="mb-12">
        <h2 className="mb-3 text-sm font-semibold text-ghost">Purchased engagements</h2>
        {rows.length === 0 ? (
          <Empty>Nothing commissioned yet.</Empty>
        ) : (
          <div className="overflow-x-auto rounded border border-line">
            <table className="w-full text-sm">
              <Head cols={["Opened", "Client", "Engagement", "Value", "Status", ""]} />
              <tbody>
                {rows.map((d) => {
                  const product = PRODUCT_BY_KIND[d.kind];
                  return (
                    <tr key={d.id} className="border-t border-line align-middle">
                      <Td className="font-mono text-faint">
                        {new Date(d.created_at).toLocaleDateString()}
                      </Td>
                      <Td>
                        <span className="text-ghost">{d.company || "—"}</span>
                        <span className="block text-xs text-faint">{d.email || "—"}</span>
                      </Td>
                      <Td className="text-mute">{product?.name ?? d.kind}</Td>
                      <Td className="font-mono text-mute">
                        {d.amount_cents ? eur(d.amount_cents) : "—"}
                      </Td>
                      <Td>
                        <span
                          className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${
                            STATUS_TONE[d.status] ?? "text-mute border-line"
                          }`}
                        >
                          {d.status.replace(/_/g, " ")}
                        </span>
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <Link
                            href={`/deliverable/${d.token}`}
                            target="_blank"
                            className="inline-flex items-center gap-1 text-xs text-mute hover:text-ghost"
                          >
                            View <ExternalLink className="h-3 w-3" />
                          </Link>
                          {d.status === "draft" && d.has_document ? (
                            <button
                              type="button"
                              onClick={() => act(d.token, "release")}
                              disabled={busy === d.token}
                              className="inline-flex items-center gap-2 rounded bg-verified px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60"
                            >
                              {busy === d.token ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : null}
                              Release
                            </button>
                          ) : null}
                          {d.status === "released" ? (
                            <button
                              type="button"
                              onClick={() => act(d.token, "unrelease")}
                              disabled={busy === d.token}
                              className="rounded border border-line px-3 py-1.5 text-xs text-faint hover:text-flag disabled:opacity-60"
                            >
                              Pull back
                            </button>
                          ) : null}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-faint">
          Generation is automatic; release is not. Read the draft before you put your name on it.
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-sm font-semibold text-ghost">What actually binds</h2>
        <p className="mb-3 mt-1 max-w-3xl text-xs text-faint">
          Across {insights.withResult} hall{insights.withResult === 1 ? "" : "s"} that have been run
          through the engine. This distribution is the asset the physics is not: anyone can rebuild
          a constraint model, nobody else is accumulating what binds in real European halls.
        </p>
        {insights.constraints.length === 0 ? (
          <Empty>No halls qualified yet.</Empty>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="grid gap-2">
              {insights.constraints.map((c) => (
                <div key={c.constraint} className="rounded border border-line bg-panel-2 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-ghost">{c.constraint}</span>
                    <span className="font-mono text-sm text-power">
                      {c.halls}
                      <span className="text-faint"> · {Math.round(c.share * 100)}%</span>
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full rounded bg-line">
                    <div
                      className="h-1.5 rounded bg-power"
                      style={{ width: `${Math.max(2, Math.round(c.share * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="grid content-start gap-3">
              <Stat
                label="Blocked as they stand"
                value={`${insights.blockedAsFound} of ${insights.withResult}`}
                tone="queue"
                small
              />
              <Stat
                label="Median contracted headroom"
                value={
                  insights.medianHeadroomPct === null
                    ? "—"
                    : `${insights.medianHeadroomPct.toFixed(0)}%`
                }
                tone="ghost"
                small
              />
              <Stat
                label="Median tap-off rating"
                value={insights.medianTapoffA === null ? "—" : `${insights.medianTapoffA} A`}
                tone="ghost"
                small
              />
              <Stat
                label="Median busway ampacity"
                value={insights.medianBuswayA === null ? "—" : `${insights.medianBuswayA} A`}
                tone="ghost"
                small
              />
              <Stat
                label="Median plant supply"
                value={
                  insights.medianPlantSupplyC === null
                    ? "—"
                    : `${insights.medianPlantSupplyC.toFixed(1)} °C`
                }
                tone="ghost"
                small
              />
              {insights.metros.length ? (
                <div className="rounded border border-line bg-panel-2 px-4 py-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    Metros
                  </p>
                  <p className="mt-1 text-sm text-mute">
                    {insights.metros.map((m) => `${m.metro} (${m.halls})`).join(" · ")}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ghost">Qualified halls</h2>
        {qualifications.length === 0 ? (
          <Empty>Nobody has run the qualifier yet.</Empty>
        ) : (
          <div className="overflow-x-auto rounded border border-line">
            <table className="w-full text-sm">
              <Head
                cols={[
                  "When",
                  "Site / hall",
                  "Metro",
                  "As found",
                  "After ladder",
                  "Binds first",
                  "Intake",
                  "Contact",
                ]}
              />
              <tbody>
                {qualifications.map((q) => (
                  <tr key={q.id} className="border-t border-line align-top">
                    <Td className="font-mono text-faint">
                      {new Date(q.created_at).toLocaleDateString()}
                    </Td>
                    <Td className="text-ghost">
                      {q.site_name || "—"}
                      {q.hall_id ? <span className="text-faint"> / {q.hall_id}</span> : null}
                    </Td>
                    <Td className="text-mute">{q.metro || "—"}</Td>
                    <Td className="font-mono text-mute">{q.racks_as_found ?? "—"}</Td>
                    <Td className="font-mono text-power">{q.racks_after_relief ?? "—"}</Td>
                    <Td className="text-mute">{q.binding_constraint || "—"}</Td>
                    <Td className="font-mono text-faint">
                      {q.intake_completeness === null
                        ? "—"
                        : `${Math.round(q.intake_completeness * 100)}%`}
                    </Td>
                    <Td className="text-faint">
                      {q.company || q.email ? (
                        <>
                          <span className="block text-mute">{q.company || "—"}</span>
                          <span className="block text-xs">{q.email || ""}</span>
                        </>
                      ) : (
                        "anonymous"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Head({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr className="bg-panel">
        {cols.map((h, i) => (
          <th
            key={`${h}-${i}`}
            className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-faint"
          >
            {h}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  small,
}: {
  label: string;
  value: string;
  tone: "ghost" | "power" | "queue" | "verified";
  small?: boolean;
}) {
  const color =
    tone === "power"
      ? "text-power"
      : tone === "queue"
        ? "text-queue"
        : tone === "verified"
          ? "text-verified"
          : "text-ghost";
  return (
    <div className="rounded border border-line bg-panel-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className={`mt-1 font-mono ${small ? "text-lg" : "text-2xl"} font-semibold ${color}`}>
        {value}
      </p>
    </div>
  );
}
