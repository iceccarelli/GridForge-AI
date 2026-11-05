"use client";

import React, { useMemo, useState } from "react";
import { CircleAlert, CircleCheck, Download, Loader2 } from "lucide-react";
import { PORTFOLIO_COLUMNS, parsePortfolioCsv, portfolioTemplate } from "@/lib/portfolio-csv";

/**
 * The hall list of a Portfolio Screen. One row per hall; the form shows what it understood before anything is sent, and the server
 * validates every hall again. A figure left blank becomes a named assumption for THAT hall in the document, never a silent default.
 */
export function PortfolioIntake({ token, minHalls, maxHalls }: { token: string; minHalls: number; maxHalls: number }) {
  const [text, setText] = useState("");
  const [client, setClient] = useState("");
  const [objective, setObjective] = useState("max_compute");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<{ message: string; assumed: { hall?: string; field: string; source: string }[] } | null>(null);
  const parsed = useMemo(() => (text.trim() ? parsePortfolioCsv(text) : null), [text]);

  function template() {
    const blob = new Blob([portfolioTemplate()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "portfolio-halls-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function submit() {
    if (!parsed) return;
    const local = [...parsed.errors];
    if (parsed.halls.length < minHalls) local.push(`A ranking needs at least ${minHalls} halls (you have ${parsed.halls.length}).`);
    if (parsed.halls.length > maxHalls) local.push(`One portfolio is scoped for up to ${maxHalls} halls (you have ${parsed.halls.length}).`);
    setProblems(local);
    if (local.length) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/intake/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(client.trim() ? { client: client.trim() } : {}), objective, halls: parsed.halls }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const issues: { path: string; message: string }[] = Array.isArray(body.hall_issues) ? body.hall_issues : [];
        setProblems(
          issues.length
            ? issues.map((i) => {
                const m = /^halls\.(\d+)\.(.+)$/.exec(i.path);
                return m ? `Hall ${Number(m[1]) + 1}, ${m[2]}: ${i.message}` : i.message;
              })
            : [body.error ?? "The portfolio could not be submitted."]
        );
        return;
      }
      setDone({ message: body.message ?? "Received.", assumed: Array.isArray(body.assumed) ? body.assumed : [] });
    } catch {
      setProblems(["Could not reach the server. Nothing was submitted."]);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded border border-verified/40 bg-panel-2 p-6" role="status">
        <p className="flex items-center gap-2 font-semibold text-ghost">
          <CircleCheck className="h-5 w-5 text-verified" aria-hidden /> Portfolio received
        </p>
        <p className="mt-2 text-sm text-mute">{done.message}</p>
        {done.assumed.length ? (
          <details className="mt-4 text-sm text-mute">
            <summary className="cursor-pointer text-ghost">What we assumed ({done.assumed.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {done.assumed.map((a, i) => (
                <li key={i}>
                  {a.hall ? `${a.hall}: ` : ""}
                  {a.field}, from {a.source}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded border border-line sm:overflow-x-auto">
        <table className="block w-full text-sm sm:table sm:min-w-[640px]">
          <thead className="sr-only sm:not-sr-only sm:table-header-group">
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              <th className="p-2">Column</th>
              <th className="p-2">What it is</th>
              <th className="p-2">Needed</th>
              <th className="p-2">Where it comes from</th>
            </tr>
          </thead>
          <tbody className="block sm:table-row-group">
            {PORTFOLIO_COLUMNS.map((c) => (
              <tr key={c.key} className="block border-t border-line/60 p-2 align-top first:border-t-0 sm:table-row sm:p-0 sm:first:border-t">
                <td className="block px-0 py-0.5 font-mono text-power sm:table-cell sm:p-2">{c.key}</td>
                <td className="block px-0 py-0.5 text-ghost sm:table-cell sm:p-2">
                  {c.label}
                  {c.unit ? <span className="text-faint"> ({c.unit})</span> : null}
                </td>
                <td className="block px-0 py-0.5 text-mute before:text-faint before:content-['Needed:_'] sm:table-cell sm:p-2 sm:before:content-none">{c.required ? "required" : "optional, named as an assumption if blank"}</td>
                <td className="block px-0 py-0.5 text-mute before:text-faint before:content-['From:_'] sm:table-cell sm:p-2 sm:before:content-none">{c.from}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={template} className="inline-flex min-h-11 items-center gap-2 rounded border border-line px-3 py-1.5 text-sm text-ghost hover:border-power/50">
          <Download className="h-4 w-4" aria-hidden /> Download the template
        </button>
        <label className="text-sm text-mute">
          or load a CSV file{" "}
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="min-h-11 py-2.5 text-xs"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f && f.size <= 256 * 1024) setText(await f.text());
              else if (f) setProblems(["That file is larger than a hall list can be."]);
            }}
          />
        </label>
      </div>

      <label className="block text-sm text-mute">
        The hall list: a header row, then one row per hall ({minHalls} to {maxHalls} halls). Paste from a spreadsheet works.
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          className="mt-1 w-full rounded border border-line bg-panel p-3 font-mono text-xs text-ghost focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60"
          aria-label="Hall list as CSV"
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-mute">
          Name printed on the document (optional)
          <input value={client} onChange={(e) => setClient(e.target.value)} maxLength={120} className="mt-1 min-h-11 w-full rounded border border-line bg-panel px-3 py-1.5 text-ghost focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60" />
        </label>
        <label className="text-sm text-mute">
          Rank the halls by
          <select value={objective} onChange={(e) => setObjective(e.target.value)} className="mt-1 min-h-11 w-full rounded border border-line bg-panel px-3 py-1.5 text-ghost focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60">
            <option value="max_compute">Deployable compute (most racks first)</option>
            <option value="min_cost">Capital cost per rack (cheapest first)</option>
            <option value="fastest">Time to power (soonest first)</option>
          </select>
        </label>
      </div>

      {parsed ? (
        <p className="text-sm text-mute" aria-live="polite">
          Understood {parsed.halls.length} hall{parsed.halls.length === 1 ? "" : "s"}
          {parsed.halls.length ? `: ${parsed.halls.map((h) => `${h.siteName ?? "?"}/${h.hallId ?? "?"}`).join(", ")}` : ""}.
        </p>
      ) : null}

      {problems.length ? (
        <ul className="space-y-1 rounded border border-flag/40 bg-flag/5 p-4 text-sm text-flag" role="alert">
          {problems.map((p, i) => (
            <li key={i} className="flex gap-2">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {p}
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={busy || !parsed}
        aria-describedby="portfolio-submit-note"
        className="inline-flex min-h-11 items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        Submit the portfolio
      </button>
      <p id="portfolio-submit-note" className="text-[12px] text-faint">
        {parsed
          ? "Nothing is sent until you press this."
          : `This unlocks once there is a hall list above (${minHalls} to ${maxHalls} halls). Paste it, or load a CSV file; what was understood is shown before anything is sent.`}
      </p>
    </div>
  );
}
