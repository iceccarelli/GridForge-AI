"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import type { ProjectState } from "@/lib/project-state";

/**
 * The project record, as stored.
 *
 * Reads GET /api/projects/{token} and renders exactly what comes back: the project's
 * own fields, the latest stored BTM revision and the readiness the ENGINE produced
 * for it, the evidence inventory, procurement, and the append-only history. Nothing
 * here is computed, defaulted or sampled. One rendering language for absence:
 *
 *   Not supplied      — something the customer could have told us and did not
 *   Unknown           — something the engine did not produce for this case
 *   Not yet created   — an artifact (RFQ, comparison, selection) that does not exist
 *
 * A failed read is shown as a failed read, never as an empty project.
 */

const NOT_SUPPLIED = "Not supplied";
const UNKNOWN = "Unknown";
const NOT_YET = "Not yet created";

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; state: ProjectState };

const mw = (v: number | null) => (v === null ? UNKNOWN : `${v} MW`);

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-ink/40 p-3.5">
      <div className="eyebrow text-[10px] mb-2">{title}</div>
      <div className="text-[12px] text-mute leading-relaxed space-y-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-faint shrink-0">{k}</span>
      <span className="text-ghost text-right break-words min-w-0">{v}</span>
    </div>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function EmptyProject({ onToken }: { onToken: (t: string) => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_name: name.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) setError(body?.error ?? "The project could not be created.");
      else onToken(body.project_token);
    } catch {
      setError("Could not reach the server. Nothing was created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="NO PROJECT OPEN">
        <p>
          A project ties a BTM case, its RFQ, supplier responses and evidence into one record. Open
          one with its token, or create one. {NOT_YET}.
        </p>
      </Card>
      <form onSubmit={(e) => { e.preventDefault(); if (token.trim()) onToken(token.trim()); }} className="space-y-2">
        <label className="eyebrow text-[10px]" htmlFor="pp-token">OPEN A PROJECT</label>
        <input id="pp-token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="project token"
          className="w-full rounded border border-line bg-ink px-2 py-1.5 text-[12px] text-ghost" />
        <button className="rounded border border-power/60 px-3 py-1 text-[12px] text-power">Open</button>
      </form>
      <form onSubmit={create} className="space-y-2">
        <label className="eyebrow text-[10px]" htmlFor="pp-name">CREATE A PROJECT</label>
        <input id="pp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="project name"
          className="w-full rounded border border-line bg-ink px-2 py-1.5 text-[12px] text-ghost" />
        <button disabled={busy || !name.trim()} className="rounded border border-power/60 px-3 py-1 text-[12px] text-power disabled:opacity-50">
          {busy ? "Creating" : "Create"}
        </button>
        {error && <p className="text-[11px] text-flag">{error}</p>}
      </form>
    </div>
  );
}

export function ProjectPanel({
  projectToken = null,
  onProjectToken,
}: {
  projectToken?: string | null;
  onProjectToken?: (token: string | null) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!projectToken) return;
    setLoaded({ kind: "loading" });
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectToken)}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setLoaded({
          kind: "error",
          message: res.status === 404 ? "No project has that token." : body?.error ?? "The project could not be read.",
        });
        return;
      }
      setLoaded({ kind: "ready", state: body as ProjectState });
    } catch {
      setLoaded({ kind: "error", message: "Could not reach the server. Nothing is shown rather than something guessed." });
    }
  }, [projectToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const state = loaded.kind === "ready" ? loaded.state : null;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3.5 border-b border-line flex items-center gap-2">
        <FolderOpen size={15} className="text-power shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ghost">Project</div>
          <div className="data text-[10px] text-faint truncate">
            {state ? state.project.project_name : projectToken ? "Loading" : "None open"}
          </div>
        </div>
        {projectToken && onProjectToken && (
          <button onClick={() => onProjectToken(null)} className="text-[10px] text-faint underline">
            Close
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!projectToken && <EmptyProject onToken={(t) => onProjectToken?.(t)} />}

        {projectToken && loaded.kind === "loading" && (
          <p className="text-[12px] text-faint flex items-center gap-2">
            <Loader2 size={13} className="animate-spin" /> Reading the stored record
          </p>
        )}
        {projectToken && loaded.kind === "error" && (
          <Card title="NOT AVAILABLE">
            <p className="text-flag">{loaded.message}</p>
            <button onClick={() => void load()} className="underline text-faint">Retry</button>
          </Card>
        )}

        {state && (
          <>
            <Card title="PROJECT">
              <Row k="Company" v={state.project.company ?? NOT_SUPPLIED} />
              <Row k="Project" v={state.project.project_name} />
              <Row k="Site" v={state.project.site_label ?? NOT_SUPPLIED} />
              <Row
                k="Location"
                v={
                  state.project.location
                    ? Object.entries(state.project.location).map(([k, v]) => `${k}: ${v}`).join(", ")
                    : NOT_SUPPLIED
                }
              />
              <Row k="Status" v={state.project.status} />
            </Card>

            <Card title="CURRENT ENGINEERING STATE">
              {state.cases.length === 0 && <p>{NOT_YET} — no BTM case is attached.</p>}
              {state.cases.map((c) => (
                <div key={c.case_token} className="space-y-1 border-b border-line pb-2 last:border-0">
                  <Row k="Latest revision" v={c.latest_revision} />
                  <Row k="Target" v={mw(c.target_MW)} />
                  <Row k="Grid firm today" v={mw(c.grid_firm_MW)} />
                  <Row k="Gap" v={mw(c.gap_MW)} />
                  <Row k="Redundancy" v={c.redundancy ?? UNKNOWN} />
                  {c.next_action && <p className="text-faint">Next: {c.next_action.action}</p>}
                  {c.architectures.map((a) => (
                    <div key={a.label} className="pt-1">
                      <Row k={a.label} v={a.status.toUpperCase()} />
                      <Row k="Margin" v={mw(a.margin_MW)} />
                      {a.blocking.length === 0 ? (
                        <Row k="Binding / blocking" v="None reported by the engine" />
                      ) : (
                        a.blocking.map((b, i) => <p key={i} className="text-flag">⚠ {b}</p>)
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </Card>

            <Card title="READINESS">
              {state.cases.length === 0 && <p>{UNKNOWN} — no case.</p>}
              {state.cases.flatMap((c) =>
                c.architectures.map((a) => (
                  <div key={`${c.case_token}-${a.label}`} className="space-y-0.5 border-b border-line pb-2 last:border-0">
                    <div className="text-ghost">{a.label}</div>
                    <Row k="rfq_ready" v={String(a.rfq_ready)} />
                    <Row k="execution_ready" v={String(a.execution_ready)} />
                    <Row
                      k="External clearances"
                      v={
                        a.external_clearances_required.length
                          ? Array.from(new Set(a.external_clearances_required.map((x) => x.review_requirement || x.gate))).join("; ")
                          : "None outstanding"
                      }
                    />
                    {a.blocking_gates.map((g) => (
                      <p key={g.gate} className="text-faint">
                        {g.gate}: {g.status.replace(/_/g, " ")}
                        {g.missing.length ? ` — needs ${g.missing.join(", ")}` : ""}
                      </p>
                    ))}
                  </div>
                ))
              )}
            </Card>

            <Card title="EVIDENCE">
              <Row k="Total" v={state.evidence.total} />
              <Row k="Unverified" v={state.evidence.unverified} />
              <Row k="Verified" v={state.evidence.verified} />
              <Row k="Rejected" v={state.evidence.rejected} />
              {state.evidence.items.map((e) => (
                <p key={e.id} className="text-faint break-words">
                  {e.filename} · {e.review_status} · class {e.evidence_class ?? "not classified"}
                </p>
              ))}
            </Card>

            <Card title="COMMERCIAL / PROCUREMENT">
              <Row
                k="Linked engagements"
                v={
                  state.other_links.length
                    ? state.other_links.map((l) => `${l.object_type} ${l.object_id}`).join(", ")
                    : NOT_YET
                }
              />
              {state.procurement.packages.length === 0 && <Row k="RFQ package" v={NOT_YET} />}
              {state.procurement.packages.map((p) => (
                <div key={p.package_token} className="space-y-0.5 border-t border-line pt-2">
                  <Row k="RFQ package" v={p.architecture} />
                  <Row k="Built from revision" v={p.stale ? `${p.case_revision} (case has moved on)` : p.case_revision} />
                  <Row k="Supplier responses" v={p.response_count} />
                  <Row
                    k="Comparison"
                    v={p.comparison ? `${p.comparison.ranked.length} ranked · leading ${p.comparison.leading ?? "none compliant"}` : NOT_YET}
                  />
                  <Row k="Selected supplier" v={p.selection ? `${p.selection.supplier} (by ${p.selection.selected_by ?? UNKNOWN})` : NOT_YET} />
                </div>
              ))}
            </Card>

            <Card title="EVENTS">
              {state.events.map((e) => (
                <div key={e.id} className="flex gap-2">
                  <span className="data text-[10px] text-faint shrink-0">{when(e.occurred_at)}</span>
                  <span className="text-ghost break-words">{e.event_type.replace(/_/g, " ")}</span>
                </div>
              ))}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
