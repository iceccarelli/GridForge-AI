"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import type { ProjectState, PackageState } from "@/lib/project-state";

/**
 * The workflow continuation on a BTM case: attach it to a project, generate the RFQ
 * package for an architecture that is rfq_ready, take supplier responses, compare,
 * and let a person select.
 *
 * Every step calls a route that stores it and appends to the project's history; this
 * component keeps no business state of its own and shows only what those routes
 * return. There is no price, checkout or "buy" anywhere in it — the BTM assessment
 * and specification are not sold as a one-off product, so none is implied.
 */

export interface CaseArchitecture {
  label: string;
  rfq_ready: boolean;
  /** The engine's own contingency verdict and reason for this architecture. */
  status: string;
  basis: string;
  blocking: string[];
  capex_uncosted_units?: string[];
  readiness_gates: { gate: string; status: string; reason: string; missing: string[] }[];
}

async function call(path: string, body?: unknown, method = "POST") {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.ok !== false, status: res.status, json };
}

export function PowerDeployProcurement({
  caseToken,
  ownerEmail,
  architectures,
}: {
  caseToken: string;
  ownerEmail: string | null;
  architectures: CaseArchitecture[];
}) {
  const storageKey = `gridforge.project.${caseToken}`;
  const [projectToken, setProjectToken] = useState<string | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [actor, setActor] = useState("");
  const [paste, setPaste] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const t = window.localStorage.getItem(storageKey);
      if (t) setProjectToken(t);
    } catch {
      /* private mode: the token simply is not remembered */
    }
  }, [storageKey]);

  const refresh = useCallback(async () => {
    if (!projectToken) return;
    const r = await call(`/api/projects/${encodeURIComponent(projectToken)}`, undefined, "GET");
    if (r.ok) {
      setState(r.json as ProjectState);
      setError(null);
    } else {
      setState(null);
      setError(r.json?.error ?? "The project could not be read.");
    }
  }, [projectToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function remember(token: string) {
    setProjectToken(token);
    try {
      window.localStorage.setItem(storageKey, token);
    } catch {
      /* not remembered */
    }
  }

  async function step(label: string, fn: () => Promise<{ ok: boolean; json: any }>) {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) {
        const d = r.json?.details?.capex_uncosted_units?.length
          ? ` Uncosted: ${r.json.details.capex_uncosted_units.join(", ")}.`
          : "";
        setError((r.json?.error ?? "That did not go through.") + d + (r.json?.stored ? " (The record itself was saved.)" : ""));
      }
      await refresh();
    } catch {
      setError("Could not reach the server. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  const attachedHere = state?.cases.some((c) => c.case_token === caseToken) ?? false;
  const packages: PackageState[] = (state?.procurement.packages ?? []).filter((p) => p.case_token === caseToken);

  async function attachTo(token: string) {
    await step("attach", async () => {
      const r = await call(`/api/projects/${encodeURIComponent(token)}/cases`, {
        case_token: caseToken,
        email: ownerEmail ? email.trim() : undefined,
      });
      if (r.ok) remember(token);
      return r;
    });
  }

  async function createAndAttach(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await step("create", async () => {
      const made = await call("/api/projects", { project_name: name.trim() });
      if (!made.ok) return made;
      const token = made.json.project_token as string;
      remember(token);
      return call(`/api/projects/${encodeURIComponent(token)}/cases`, {
        case_token: caseToken,
        email: ownerEmail ? email.trim() : undefined,
      });
    });
  }

  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-6">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
        Procurement &middot; RFQ package
      </h2>
      <p className="mt-2 max-w-3xl text-sm text-mute">
        Turn an RFQ-ready architecture into a specification suppliers can quote against, collect their
        responses, compare them and record who selected whom. This is a workflow step on your project
        record — it is not a purchase, and nothing here is priced.
      </p>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded border border-flag/40 bg-flag/5 p-3 text-sm text-mute">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" />
          <p>{error}</p>
        </div>
      )}

      {!attachedHere && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-mute">This case is not attached to a project in this browser yet.</p>
          {ownerEmail && (
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email this case is registered to"
              className="w-full max-w-sm rounded border border-line bg-ink px-3 py-1.5 text-sm text-ghost"
            />
          )}
          <form onSubmit={createAndAttach} className="flex flex-wrap gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new project name"
              className="rounded border border-line bg-ink px-3 py-1.5 text-sm text-ghost" />
            <button disabled={!!busy || !name.trim()} className="rounded border border-power/60 px-3 py-1.5 text-sm text-power disabled:opacity-50">
              {busy === "create" ? "Creating" : "Create project and attach"}
            </button>
          </form>
          <form onSubmit={(e) => { e.preventDefault(); if (tokenInput.trim()) void attachTo(tokenInput.trim()); }} className="flex flex-wrap gap-2">
            <input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="existing project token"
              className="rounded border border-line bg-ink px-3 py-1.5 text-sm text-ghost" />
            <button disabled={!!busy || !tokenInput.trim()} className="rounded border border-line px-3 py-1.5 text-sm text-ghost disabled:opacity-50">
              {busy === "attach" ? "Attaching" : "Attach to project"}
            </button>
          </form>
        </div>
      )}

      {attachedHere && state && (
        <div className="mt-4 space-y-5">
          <p className="text-[12px] text-faint">
            Project <span className="text-ghost">{state.project.project_name}</span> &middot; keep its token to return:{" "}
            <code className="break-all text-ghost">{projectToken}</code>
          </p>

          {architectures.map((a) => {
            const made = packages.find((p) => p.architecture === a.label);
            return (
              <div key={a.label} className="rounded border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-ghost">{a.label}</h3>
                  <button
                    disabled={!a.rfq_ready || !!busy}
                    onClick={() =>
                      step("rfq", () => call(`/api/projects/${encodeURIComponent(projectToken!)}/packages`, { case_token: caseToken, architecture: a.label }))
                    }
                    className="rounded border border-power/60 px-3 py-1.5 text-sm text-power disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === "rfq" ? "Generating" : made ? "Generate another RFQ package" : "Generate RFQ package"}
                  </button>
                </div>
                {!a.rfq_ready && (
                  <div className="mt-2 text-[12px] text-faint">
                    <p>Not RFQ-ready — no package can be generated. From the engine:</p>
                    <p>Contingency test: {a.status.replace(/_/g, " ").toUpperCase()} — {a.basis}</p>
                    {a.blocking.map((b, i) => <p key={i}>⚠ {b}</p>)}
                    {(a.capex_uncosted_units ?? []).length > 0 && <p>Uncosted units: {a.capex_uncosted_units!.join(", ")}</p>}
                    {a.readiness_gates.filter((g) => g.status === "missing_data" || g.status === "unknown").map((g) => (
                      <p key={g.gate}>{g.gate}: {g.reason}{g.missing.length ? ` (needs ${g.missing.join(", ")})` : ""}</p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {packages.map((p) => (
            <div key={p.package_token} className="rounded border border-power/30 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ghost">
                  RFQ package · {p.architecture} · built from revision {p.case_revision}
                  {p.stale ? " (the case has since changed — regenerate before relying on it)" : ""}
                </p>
                <p className="text-[12px]">
                  {(["md", "html"] as const).map((f) => (
                    <a key={f} className="mr-3 text-power underline"
                      href={`/api/projects/${encodeURIComponent(projectToken!)}/packages/${encodeURIComponent(p.package_token)}?format=${f}`}>
                      Specification ({f})
                    </a>
                  ))}
                  <a className="text-power underline"
                    href={`/api/projects/${encodeURIComponent(projectToken!)}/packages/${encodeURIComponent(p.package_token)}`}>
                    Response schedule (JSON)
                  </a>
                </p>
              </div>

              {!p.selection && (
                <div>
                  <p className="text-[12px] text-faint">
                    Paste one supplier&apos;s completed response schedule (JSON). Responses so far: {p.response_count}.
                  </p>
                  <textarea
                    value={paste[p.package_token] ?? ""}
                    onChange={(e) => setPaste({ ...paste, [p.package_token]: e.target.value })}
                    rows={4}
                    className="mt-1 w-full rounded border border-line bg-ink p-2 font-mono text-[11px] text-ghost"
                  />
                  <button
                    disabled={!!busy || !(paste[p.package_token] ?? "").trim()}
                    onClick={() =>
                      step("response", async () => {
                        let parsed: unknown;
                        try {
                          parsed = JSON.parse(paste[p.package_token]);
                        } catch {
                          return { ok: false, json: { error: "That is not valid JSON. Nothing was submitted." } };
                        }
                        const r = await call(
                          `/api/projects/${encodeURIComponent(projectToken!)}/packages/${encodeURIComponent(p.package_token)}/responses`,
                          parsed
                        );
                        if (r.ok) setPaste({ ...paste, [p.package_token]: "" });
                        return r;
                      })
                    }
                    className="mt-2 rounded border border-line px-3 py-1.5 text-sm text-ghost disabled:opacity-50"
                  >
                    {busy === "response" ? "Submitting" : "Submit response"}
                  </button>
                  <button
                    disabled={!!busy || p.response_count === 0}
                    onClick={() =>
                      step("compare", () =>
                        call(`/api/projects/${encodeURIComponent(projectToken!)}/packages/${encodeURIComponent(p.package_token)}/comparison`, {})
                      )
                    }
                    className="ml-2 mt-2 rounded border border-power/60 px-3 py-1.5 text-sm text-power disabled:opacity-50"
                  >
                    {busy === "compare" ? <Loader2 className="inline h-4 w-4 animate-spin" /> : "Compare responses"}
                  </button>
                </div>
              )}

              {p.comparison && (
                <div className="overflow-x-auto">
                  <p className="text-[12px] text-faint">
                    Comparison saved {p.comparison.created_at.slice(0, 16).replace("T", " ")}Z. Selecting a supplier does not change this ranking.
                  </p>
                  <table className="mt-2 w-full min-w-[32rem] text-left text-sm">
                    <thead className="text-[11px] uppercase tracking-[0.1em] text-faint">
                      <tr><th className="py-1 pr-3">#</th><th className="py-1 pr-3">Supplier</th><th className="py-1 pr-3">Compliant</th><th className="py-1 pr-3" /></tr>
                    </thead>
                    <tbody className="text-mute">
                      {p.comparison.ranked.map((r: any) => (
                        <tr key={r.supplier} className="border-t border-line">
                          <td className="py-1 pr-3 font-mono text-xs">{r.rank}</td>
                          <td className="py-1 pr-3 text-ghost">{r.headline ?? r.supplier}</td>
                          <td className="py-1 pr-3">{r.disqualified ? "disqualified" : r.compliant ? "yes" : "no"}</td>
                          <td className="py-1 pr-3">
                            {!p.selection && !r.disqualified && (
                              <button
                                disabled={!!busy || !actor.trim()}
                                onClick={() =>
                                  step("select", () =>
                                    call(`/api/projects/${encodeURIComponent(projectToken!)}/packages/${encodeURIComponent(p.package_token)}/selection`, { supplier: r.supplier, actor: actor.trim() })
                                  )
                                }
                                className="rounded border border-line px-2 py-0.5 text-xs text-ghost disabled:opacity-40"
                              >
                                Select supplier
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!p.selection && (
                    <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="your name and role (recorded with the decision)"
                      className="mt-2 w-full max-w-sm rounded border border-line bg-ink px-3 py-1.5 text-sm text-ghost" />
                  )}
                </div>
              )}

              {p.selection && (
                <p className="text-sm text-ghost">
                  Selected: {p.selection.supplier} — by {p.selection.selected_by ?? "unknown"}. Recorded in the project history.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
