"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Loader2, Upload } from "lucide-react";

/**
 * Where the supplier responses go.
 *
 * The Procurement Specification's catalogue entry has always promised three
 * things, and the third — the bid comparison — had no surface at all. Adding the
 * route was half the fix: the buyer here is a procurement manager who has just
 * collected four filled-in schedules, not somebody who will POST JSON with curl.
 * A capability the customer cannot reach is the same defect wearing a different
 * shape.
 *
 * Files in, ranking out. The engine does the comparison; this reads the responses
 * off disk, says plainly which file it could not parse, and never invents a
 * supplier that was not in one.
 */

interface Ranked {
  rank: number;
  supplier: string;
  headline?: string;
  capex_eur?: number;
  weeks_to_energised?: number;
  eur_per_rack?: number;
  score?: number;
  compliant?: boolean;
  disqualified?: boolean;
  mandatory_failed?: string[];
  schedule_impact?: string;
  notes?: string[];
}

interface Line {
  id: string;
  state: string;
  cost_key: string;
  supplier: string;
  value: number | null;
  unit: string;
  problems?: string[];
  limitations?: string[];
  synthetic?: boolean;
}

interface RunSummary {
  id: string;
  created_at: string;
  legacy: boolean;
  run_fingerprint: string | null;
  is_current: boolean | null;
  accepted_evidence_ids: string[] | null;
  used_evidence_ids: string[];
  ignored_evidence: { key?: string; evidence_id?: string; reason?: string }[];
  engine: { version: string | null; fingerprint: string | null } | null;
  report_date: string | null;
  artifact: {
    status: "stored" | "legacy_unavailable";
    sha256: string | null;
    bytes: number | null;
    note?: string;
    legacy_document_sha256?: string;
  };
  artifact_url: string | null;
}

const eur = (n: number | undefined) =>
  typeof n === "number"
    ? new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n)
    : "—";

export function BidComparison({
  token,
  initial,
}: {
  token: string;
  /** A comparison already run for this engagement, so a reload does not lose it. */
  initial?: { relief?: string; sized_for_racks?: number; ranked?: Ranked[]; note?: unknown } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState(initial ?? null);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [by, setBy] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rerun, setRerun] = useState<{ run: RunSummary; created: boolean; ids: number } | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  // The history comes from the server on every load, so a reload (or a new visit) shows every earlier run and its
  // stored document without any state from a previous request.
  const refreshRuns = useCallback(async () => {
    try {
      const r = await fetch(`/api/deliverable/${token}/evidence-run`, { cache: "no-store" });
      const b = await r.json();
      if (r.ok && b.ok) {
        setRuns(b.runs);
        setRunsError(null);
      } else setRunsError(b?.error ?? "The run history could not be read.");
    } catch {
      setRunsError("The run history could not be reached.");
    }
  }, [token]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  async function refreshLines() {
    try {
      const r = await fetch(`/api/deliverable/${token}/quotes`, { cache: "no-store" });
      const b = await r.json();
      if (r.ok && b.ok) setLines(b.items);
    } catch {
      /* the list is a convenience; the comparison above stands without it */
    }
  }

  async function applyAccepted() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/deliverable/${token}/evidence-run`, { method: "POST" });
      const b = await r.json();
      if (!r.ok || !b.ok) {
        setError(b?.error ?? "Could not re-run the study with the accepted quotations.");
        return;
      }
      setRerun({ run: b.run, created: b.created, ids: b.evidence_ids.length });
      await refreshRuns();
    } catch {
      setError("Could not reach the server. Nothing was recorded — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const responses: unknown[] = [];
      const unreadable: string[] = [];
      for (const file of Array.from(list)) {
        try {
          const parsed = JSON.parse(await file.text());
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) responses.push(parsed);
          else unreadable.push(file.name);
        } catch {
          unreadable.push(file.name);
        }
      }
      if (unreadable.length) {
        // Named, because "invalid file" sends somebody opening all four.
        setError(
          `Could not read ${unreadable.join(", ")}. Each file should be the response schedule ` +
            `from this engagement, filled in and saved as JSON.`
        );
        if (!responses.length) return;
      }
      const res = await fetch(`/api/deliverable/${token}/bids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body?.error ?? "Could not compare these responses.");
        return;
      }
      setResult(body);
      setSaved(body.saved !== false);
      // The same files, recorded as RECEIVED quotations so a reviewer can accept them as cost evidence. Receipt
      // changes no study: it is only the first state a quotation can be in.
      if (by.trim()) {
        const q = await fetch(`/api/deliverable/${token}/quotes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ responses, submitted_by: by.trim() }),
        });
        const qb = await q.json().catch(() => ({}));
        setNote(q.ok && qb.ok ? qb.note : qb?.error ?? "The quotations could not be recorded as cost evidence.");
        await refreshLines();
      } else {
        setNote("Enter your name before choosing files to also record these quotations as cost evidence for review.");
      }
    } catch {
      setError("Could not reach the server. Nothing was submitted — try again.");
    } finally {
      setBusy(false);
    }
  }

  const ranked = result?.ranked ?? [];

  return (
    <section className="mt-8 rounded border border-line bg-panel-2 p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
        Compare the bids
      </p>
      <p className="mt-2 max-w-3xl text-sm text-mute">
        Send every supplier the response schedule from this engagement, then drop their completed
        files here. They come back ranked against this hall&apos;s capacity model — in racks and
        weeks, not only in euros. The cheapest quote is frequently not the one that energises
        first.
      </p>

      <label className="mt-4 block text-xs text-faint">
        Your name (to record the quotations as cost evidence for review)
        <input
          value={by}
          onChange={(e) => setBy(e.target.value)}
          maxLength={120}
          className="mt-1 block w-72 rounded border border-line bg-transparent px-2 py-1 text-sm text-ghost"
        />
      </label>

      <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded border border-power/60 px-4 py-2 text-sm font-semibold text-power hover:bg-power/10">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {busy ? "Comparing" : ranked.length ? "Compare again" : "Choose the completed schedules"}
        <input
          type="file"
          accept="application/json,.json"
          multiple
          className="hidden"
          disabled={busy}
          onChange={(e) => onFiles(e.target.files)}
        />
      </label>

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded border border-flag/40 bg-flag/5 p-3 text-sm text-mute">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" />
          <p>{error}</p>
        </div>
      ) : null}

      {note ? <p className="mt-3 max-w-3xl text-[11px] leading-relaxed text-faint">{note}</p> : null}

      {lines?.length ? (
        <div className="mt-4 max-w-3xl">
          <p className="text-xs text-faint">Quotation lines and their state</p>
          <ul className="mt-2 space-y-1 text-[11px] text-mute">
            {lines.map((l) => (
              <li key={l.id}>
                <span className="font-mono">{l.state}</span> · {l.supplier} · {l.cost_key}
                {l.synthetic ? " · SYNTHETIC" : ""}
                {l.problems?.length ? ` · ${l.problems.join("; ")}` : ""}
                {l.limitations?.length ? ` · limited: ${l.limitations.join("; ")}` : ""}
              </li>
            ))}
          </ul>
          {lines.some((l) => l.state === "accepted") ? (
            <button
              type="button"
              disabled={busy}
              onClick={applyAccepted}
              className="mt-3 rounded border border-power/60 px-3 py-1.5 text-sm font-semibold text-power hover:bg-power/10"
            >
              Re-run the study with the accepted quotations
            </button>
          ) : (
            <p className="mt-2 text-[11px] text-faint">
              Nothing here affects a study until a named reviewer accepts it.
            </p>
          )}
          {rerun ? (
            <p className="mt-2 text-[11px] text-faint">
              Study re-run using {rerun.ids} accepted quotation{rerun.ids === 1 ? "" : "s"}
              {rerun.created ? " — recorded and stored" : " — this exact run was already recorded; its original document is returned"}
              . The document names each one and what it changed.
            </p>
          ) : null}
        </div>
      ) : null}

      {runsError ? <p className="mt-3 text-[11px] text-flag">{runsError}</p> : null}
      {runs?.length ? (
        <div className="mt-6 max-w-3xl" aria-label="Evidence runs">
          <p className="text-xs text-faint">Studies re-run with accepted quotations</p>
          <ul className="mt-2 space-y-2 text-[11px] text-mute">
            {runs.map((r) => (
              <li key={r.id} className="rounded border border-line p-3" data-run-id={r.id}>
                <p>
                  <span className="text-ghost">{new Date(r.created_at).toLocaleString()}</span>
                  {" · "}
                  {r.legacy ? (
                    <span className="font-mono uppercase text-queue">legacy</span>
                  ) : r.is_current === true ? (
                    <span className="font-mono uppercase text-verified">current</span>
                  ) : r.is_current === false ? (
                    <span className="font-mono uppercase text-faint">older — inputs have changed since</span>
                  ) : (
                    <span className="font-mono uppercase text-faint">currency not determined</span>
                  )}
                </p>
                <p className="mt-1">
                  Offered {r.accepted_evidence_ids?.length ?? "—"} accepted quotation
                  {r.accepted_evidence_ids?.length === 1 ? "" : "s"} · used {r.used_evidence_ids.length}
                  {r.ignored_evidence.length ? ` · ignored ${r.ignored_evidence.length}` : ""}
                  {r.engine?.version ? ` · engine ${r.engine.version}` : ""}
                </p>
                {r.ignored_evidence.map((x, n) => (
                  <p key={n} className="text-faint">
                    ignored {x.key ?? ""}: {x.reason ?? ""}
                  </p>
                ))}
                {r.run_fingerprint ? (
                  <p className="mt-1 font-mono text-[10px] text-faint break-all">run {r.run_fingerprint}</p>
                ) : null}
                {r.artifact.status === "stored" && r.artifact_url ? (
                  <p className="mt-1">
                    <a className="underline" href={r.artifact_url}>
                      Download the stored document
                    </a>
                    <span className="font-mono text-[10px] text-faint break-all">
                      {" "}
                      · sha256 {r.artifact.sha256} · {r.artifact.bytes} bytes
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-faint">
                    {r.artifact.note ?? "No document is stored for this run."}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {ranked.length ? (
        <div className="mt-5">
          {result?.relief ? (
            <p className="text-xs text-faint">
              Against: <span className="text-mute">{result.relief}</span>
              {result.sized_for_racks ? ` · sized for ${result.sized_for_racks} racks` : ""}
            </p>
          ) : null}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-[0.1em] text-faint">
                <tr>
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Supplier</th>
                  <th className="py-2 pr-3">Capex</th>
                  <th className="py-2 pr-3">Weeks to energised</th>
                  <th className="py-2 pr-3">Per rack</th>
                  <th className="py-2 pr-3">Score</th>
                </tr>
              </thead>
              <tbody className="text-mute">
                {ranked.map((r) => (
                  <tr key={`${r.rank}-${r.supplier}`} className="border-t border-line align-top">
                    <td className="py-2 pr-3 font-mono text-xs">{r.rank}</td>
                    <td className="py-2 pr-3">
                      <span className={r.rank === 1 ? "font-semibold text-ghost" : "text-ghost"}>
                        {r.supplier}
                      </span>
                      {r.disqualified ? (
                        <span className="ml-2 font-mono text-[10px] uppercase text-flag">
                          disqualified
                        </span>
                      ) : null}
                      {r.mandatory_failed?.length ? (
                        <p className="mt-1 text-[11px] text-flag">
                          fails mandatory: {r.mandatory_failed.join(", ")}
                        </p>
                      ) : null}
                      {r.schedule_impact ? (
                        <p className="mt-1 max-w-md text-[11px] text-faint">{r.schedule_impact}</p>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{eur(r.capex_eur)}</td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {typeof r.weeks_to_energised === "number" ? r.weeks_to_energised : "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{eur(r.eur_per_rack)}</td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {typeof r.score === "number" ? `${Math.round(r.score)}/100` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* The engine's own caveat, carried rather than summarised away. */}
          {ranked[0]?.notes?.length ? (
            <p className="mt-3 max-w-3xl text-[11px] leading-relaxed text-faint">
              {ranked[0].notes.join(" ")}
            </p>
          ) : null}
          {typeof result?.note === "string" ? (
            <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-faint">{result.note}</p>
          ) : null}

          <p className="mt-3 text-[11px] text-faint">
            {saved === false
              ? "This comparison was produced but not saved — copy what you need before leaving the page."
              : "Saved with this engagement as bid_comparison.json, above."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
