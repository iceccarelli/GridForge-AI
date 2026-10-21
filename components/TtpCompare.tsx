"use client";

// Time-to-Power scenario comparison -- the interactive front of POST /v1/compare.
//
// Every figure on this screen is the engine's. The page adds no arithmetic of its own: it collects the inputs the
// Density Screen intake already defines, asks the engine, and lays the answer out with the evidence class, the
// missing inputs and the reason for any date it could not give. The example is labelled synthetic and is only ever
// loaded by a button press; nothing is shown before a calculation has been run.

import { useId, useMemo, useState } from "react";
import { CircleAlert, Download, Loader2 } from "lucide-react";
import {
  BTM_KINDS,
  OBJECTIVES,
  OBJECTIVE_LABEL,
  type CompareObjective,
  type CompareResult,
  type CompareScenario,
} from "@/lib/ttp-compare";
import { TtpSaveToProject } from "@/components/TtpSaveToProject";
import { DateFigure } from "@/components/DateFigure";
import { formatRankingValue, formatWeeksDelta, formatLeadTime } from "@/lib/date-basis";

type Fields = Record<string, string>;
type Btm = { id: string; kind: string; capacity_MW: string; lead_time_weeks: string; capex_eur_per_kW: string; energy_MWh: string };

const REQUIRED: [string, string, string][] = [
  ["siteName", "Site name", "text"],
  ["hallId", "Hall id", "text"],
  ["contractedMW", "Contracted grid capacity (MW)", "number"],
  ["currentPeakMW", "Current site peak (MW)", "number"],
  ["currentItLoadMW", "Current IT load (MW)", "number"],
  ["buswayAmpacityA", "Busway ampacity (A)", "number"],
  ["tapoffMaxA", "Tap-off rating, max (A)", "number"],
  ["positionsAvailable", "Free rack positions", "number"],
  ["plantSupplyC", "Chilled-water design supply (°C)", "number"],
];
const OPTIONAL: [string, string][] = [
  ["firmCapacityMVA", "Firm connection capacity (MVA)"],
  ["floorLoadingKPa", "Floor loading (kPa)"],
  ["plantCapacityKW", "Chilled-water plant capacity (kW)"],
];

// Clearly synthetic: loaded only on request, and named as such wherever it is shown.
const SYNTHETIC: Fields = {
  siteName: "Synthetic example hall", hallId: "H1", contractedMW: "12", currentPeakMW: "7.4", currentItLoadMW: "4.9",
  buswayAmpacityA: "400", tapoffMaxA: "63", positionsAvailable: "180", plantSupplyC: "6", firmCapacityMVA: "15",
  floorLoadingKPa: "12", plantCapacityKW: "6000",
};

function build(f: Fields, btm: Btm[], objective: CompareObjective) {
  const hall: Record<string, unknown> = { platform: f.platform || "gb300_nvl72" };
  for (const [k] of [...REQUIRED, ...OPTIONAL.map((o) => [o[0]])]) if (f[k]?.trim()) hall[k] = f[k].trim();
  const options = btm.map((o) => ({
    id: o.id.trim() || o.kind,
    kind: o.kind,
    capacity_MW: o.capacity_MW,
    lead_time_weeks: o.lead_time_weeks,
    ...(o.capex_eur_per_kW.trim() ? { capex_eur_per_kW: o.capex_eur_per_kW } : {}),
    ...(o.energy_MWh.trim() ? { energy_MWh: o.energy_MWh } : {}),
  }));
  return { hall, btm_options: options, objective };
}

const evidenceTone = (e: string | null) => (e && Number(e.slice(1)) >= 3 ? "text-verified" : "text-queue");

function Date_({ s }: { s: CompareScenario }) {
  const t = s.time_to_power;
  return <DateFigure t={t} evidenceText={t.evidence} evidenceClassName={evidenceTone(t.evidence)} />;
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function TtpCompare() {
  const uid = useId();
  const [f, setF] = useState<Fields>({ platform: "gb300_nvl72" });
  const [btm, setBtm] = useState<Btm[]>([]);
  const [objective, setObjective] = useState<CompareObjective>("max_compute");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: string[] } | null>(null);
  const [out, setOut] = useState<{ result: CompareResult; request: Record<string, unknown>; synthetic: boolean; compare: Record<string, unknown> } | null>(null);
  const [synthetic, setSynthetic] = useState(false);
  const [copied, setCopied] = useState(false);

  const set = (k: string, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setSynthetic(false);
  };
  const missing = useMemo(() => REQUIRED.filter(([k]) => !f[k]?.trim()).map(([, l]) => l), [f]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (missing.length) {
      setError({ message: "These are needed before the engine can solve the hall:", fields: missing });
      return;
    }
    setBusy(true);
    try {
      const compare = build(f, btm, objective);
      const res = await fetch("/api/power/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(compare),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const problems: string[] | undefined = Array.isArray(body?.problems)
          ? (body.problems as { path: string; message: string }[]).map((p) => `${p.path}: ${p.message}`)
          : body?.detail
            ? Object.entries(body.detail as Record<string, unknown>).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
            : undefined;
        setOut(null);
        setError({ message: body?.error ?? "The comparison could not be produced.", fields: problems });
        return;
      }
      setOut({ result: body.result, request: body.request, synthetic, compare });
    } catch {
      setOut(null);
      setError({ message: "Could not reach the server. Nothing was calculated; please try again." });
    } finally {
      setBusy(false);
    }
  }

  const cli = out ? `curl -X POST "$GRIDFORGE_API_URL/v1/compare" -H "X-API-Key: $GRIDFORGE_API_KEY" -H "Content-Type: application/json" -d @request.json` : "";

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={run} className="panel flex flex-col gap-6 p-6" aria-busy={busy}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">The hall</p>
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            onClick={() => {
              setF({ ...SYNTHETIC, platform: "gb300_nvl72" });
              setBtm([]);
              setSynthetic(true);
              setOut(null);
              setError(null);
            }}
          >
            Load a synthetic example
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {REQUIRED.map(([k, label, type]) => (
            <div key={k}>
              <label htmlFor={`${uid}-${k}`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                {label}
              </label>
              <input
                id={`${uid}-${k}`}
                className="field w-full"
                type={type}
                inputMode={type === "number" ? "decimal" : undefined}
                step="any"
                required
                value={f[k] ?? ""}
                onChange={(e) => set(k, e.target.value)}
              />
            </div>
          ))}
        </div>
        <div className="max-w-xs">
          <label htmlFor={`${uid}-platform`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
            Target platform
          </label>
          <select id={`${uid}-platform`} className="field w-full" value={f.platform ?? "gb300_nvl72"} onChange={(e) => set("platform", e.target.value)}>
            <option value="gb300_nvl72">NVIDIA GB300 NVL72</option>
            <option value="gb200_nvl72">NVIDIA GB200 NVL72</option>
            <option value="generic_dlc_50">Generic liquid-cooled, 50 kW/rack</option>
          </select>
        </div>
        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
            Optional — leave blank and the engine names each as an assumption instead of guessing
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {OPTIONAL.map(([k, label]) => (
              <div key={k}>
                <label htmlFor={`${uid}-${k}`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                  {label}
                </label>
                <input id={`${uid}-${k}`} className="field w-full" type="number" step="any" value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} />
              </div>
            ))}
          </div>
        </div>

        <fieldset className="border-t border-line pt-4">
          <legend className="eyebrow">On-site supply you are considering</legend>
          <p className="mt-2 text-xs text-mute">
            Needed to compare the behind-the-meter scenario. Lead times you enter are treated as assumptions (E0) until a supplier
            quotation is accepted, and the comparison says so.
          </p>
          {btm.map((o, i) => (
            <div key={i} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6">
              {[
                ["kind", "Kind"],
                ["capacity_MW", "MW"],
                ["lead_time_weeks", "Lead time (wk)"],
                ["capex_eur_per_kW", "€/kW (optional)"],
                ["energy_MWh", o.kind === "bess" ? "MWh (required)" : "MWh"],
              ].map(([key, label]) => (
                <div key={key}>
                  <label htmlFor={`${uid}-b${i}${key}`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">{label}</label>
                  {key === "kind" ? (
                    <select
                      id={`${uid}-b${i}${key}`}
                      className="field w-full"
                      value={o.kind}
                      onChange={(e) => setBtm((p) => p.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}
                    >
                      {BTM_KINDS.map((k) => (<option key={k} value={k}>{k.replace("_", " ")}</option>))}
                    </select>
                  ) : (
                    <input
                      id={`${uid}-b${i}${key}`}
                      className="field w-full"
                      type="number"
                      step="any"
                      value={(o as Record<string, string>)[key]}
                      onChange={(e) => setBtm((p) => p.map((x, j) => (j === i ? { ...x, [key]: e.target.value } : x)))}
                    />
                  )}
                </div>
              ))}
              <div className="flex items-end">
                <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={() => setBtm((p) => p.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary mt-3 px-3 py-1.5 text-xs"
            onClick={() => setBtm((p) => [...p, { id: `opt${p.length + 1}`, kind: "gas_engine", capacity_MW: "", lead_time_weeks: "", capex_eur_per_kW: "", energy_MWh: "" }])}
          >
            Add a supply option
          </button>
        </fieldset>

        <div className="flex flex-wrap items-end gap-4 border-t border-line pt-4">
          <div>
            <label htmlFor={`${uid}-obj`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
              Rank by
            </label>
            <select id={`${uid}-obj`} className="field" value={objective} onChange={(e) => setObjective(e.target.value as CompareObjective)}>
              {OBJECTIVES.map((o) => (<option key={o} value={o}>{OBJECTIVE_LABEL[o]}</option>))}
            </select>
          </div>
          <button type="submit" disabled={busy} className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy ? "Solving the hall…" : "Compare scenarios"}
          </button>
        </div>

        {error ? (
          <div role="alert" className="flex gap-3 rounded border border-flag/40 bg-flag/10 p-4 text-sm text-ghost">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" aria-hidden />
            <div>
              <p>{error.message}</p>
              {error.fields?.length ? (
                <ul className="mt-1 list-disc pl-5 text-mute">{error.fields.map((m) => (<li key={m}>{m}</li>))}</ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </form>

      {!out && !error && !busy ? (
        <p className="text-sm text-mute">
          No result yet. Enter your hall, or load the synthetic example, then compare. Nothing is shown until the engine has
          solved it.
        </p>
      ) : null}

      {out ? <ComparisonResults out={out} cli={cli} copied={copied} onCopy={async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(out.request, null, 2)); setCopied(true); } catch { setCopied(false); }
      }} /> : null}

      {out && !out.synthetic ? <TtpSaveToProject key={out.result.request_digest} compare={out.compare} defaultName={String(f.siteName ?? "").trim()} /> : null}
      {out?.synthetic ? (
        <p className="text-sm text-mute">
          This is a synthetic example, so it cannot be saved or shared. Enter your own hall to save a comparison to a project.
        </p>
      ) : null}
    </div>
  );
}

export function ComparisonResults({ out, cli, copied, onCopy }: { out: { result: CompareResult; request: Record<string, unknown>; synthetic: boolean }; cli: string; copied: boolean; onCopy: () => void }) {
  const r = out.result;
  const byId = Object.fromEntries(r.scenarios.map((s) => [s.id, s]));
  return (
    <section aria-label="Comparison result" className="flex flex-col gap-6">
      {out.synthetic ? (
        <p className="rounded border border-queue/40 bg-queue/10 p-3 text-sm text-ghost">
          <strong>Synthetic example.</strong> These inputs are not a real hall; do not read the result as a finding about any site.
        </p>
      ) : null}
      <div className="panel p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] ${r.grade === "indicative" ? "border-queue/50 text-queue" : "border-verified/50 text-verified"}`}>
            {r.grade}
          </span>
          <span className="text-sm text-mute">Ranked by {OBJECTIVE_LABEL[r.objective]} · baseline {byId[r.baseline]?.name ?? r.baseline}</span>
        </div>
        <p className="mt-3 text-ghost">
          {r.ranking.leader ? (
            <>Leader on this objective: <strong>{byId[r.ranking.leader]?.name}</strong> ({r.ranking.metric}: <span className="data">{formatRankingValue(r.ranking.metric, r.ranking.values[r.ranking.leader], byId[r.ranking.leader]?.time_to_power)}</span>).</>
          ) : (
            <>No leader. {r.ranking.note}</>
          )}
        </p>
        {r.ranking.leader && r.ranking.note ? <p className="mt-1 text-xs text-queue">{r.ranking.note}</p> : null}
        {r.ranking.excluded.length ? (
          <ul className="mt-2 list-disc pl-5 text-xs text-mute">
            {r.ranking.excluded.map((e) => (<li key={e.id}><span className="text-ghost">{byId[e.id]?.name ?? e.id}</span> not ranked — {e.reason}</li>))}
          </ul>
        ) : null}
        <ul className="mt-3 list-disc pl-5 text-xs text-mute">{r.caveats.map((c) => (<li key={c}>{c}</li>))}</ul>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <caption className="sr-only">Scenarios compared</caption>
          <thead>
            <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
              <th scope="col" className="py-2 pr-4">Scenario</th>
              <th scope="col" className="py-2 pr-4">Racks, as found → after relief</th>
              <th scope="col" className="py-2 pr-4">Limit after relief</th>
              <th scope="col" className="py-2 pr-4">Time to full capacity</th>
              <th scope="col" className="py-2 pr-4">Capex</th>
            </tr>
          </thead>
          <tbody>
            {r.scenarios.map((s) => (
              <tr key={s.id} className="border-b border-line/60 align-top">
                <th scope="row" className="py-3 pr-4 font-medium text-ghost">
                  {s.name}
                  {s.id === r.baseline ? <span className="ml-2 text-[10px] uppercase text-faint">baseline</span> : null}
                </th>
                <td className="data py-3 pr-4">{s.as_found.racks} → {s.after_ladder.racks}</td>
                <td className="py-3 pr-4 text-mute">{s.after_ladder.binding_name ?? "—"}</td>
                <td className="py-3 pr-4"><Date_ s={s} /></td>
                <td className="py-3 pr-4">
                  {s.economics.capex_total_eur ? (
                    <span className="data">€{Math.round(s.economics.capex_total_eur.value).toLocaleString()}</span>
                  ) : "—"}
                  {!s.economics.capex_complete ? (
                    <span className="block text-[11px] text-queue">incomplete — {s.economics.unpriced_components.length} unpriced</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        {r.scenarios.map((s) => (
          <details key={s.id} className="panel p-4">
            <summary className="cursor-pointer text-sm text-ghost">Why {s.name} differs, and what it still needs</summary>
            <div className="mt-3 grid gap-4 text-sm text-mute sm:grid-cols-2">
              <div>
                <p className="eyebrow">Against the baseline</p>
                {s.vs_baseline ? (
                  <ul className="mt-1 list-disc pl-5">
                    {s.vs_baseline.why.map((w) => (<li key={w}>{w}</li>))}
                    <li>
                      Date: {s.vs_baseline.weeks_delta === null ? s.vs_baseline.weeks_delta_unknown_reason : formatWeeksDelta(s.vs_baseline.weeks_delta, s.time_to_power, byId[r.baseline]?.time_to_power)}
                    </li>
                    <li>
                      Capex: {s.vs_baseline.capex_delta_eur === null ? s.vs_baseline.capex_delta_unknown_reason : `${s.vs_baseline.capex_delta_eur > 0 ? "+" : ""}€${s.vs_baseline.capex_delta_eur.toLocaleString()}`}
                    </li>
                  </ul>
                ) : (<p className="mt-1">This is the baseline.</p>)}
                <p className="eyebrow mt-3">Still needed to firm this up</p>
                {s.missing_inputs.length ? (
                  <ul className="mt-1 list-disc pl-5">{s.missing_inputs.map((m) => (<li key={m}>{m}</li>))}</ul>
                ) : (<p className="mt-1">Nothing flagged as missing.</p>)}
              </div>
              <div>
                <p className="eyebrow">Lead times behind the date</p>
                {s.time_to_power.lead_times.length ? (
                  <ul className="mt-1 list-disc pl-5">
                    {s.time_to_power.lead_times.map((l) => (
                      <li key={l.constraint}>
                        {l.name}: {l.lead_time_weeks ? (<span className="data">{formatLeadTime(l.lead_time_weeks.value, l.lead_time_weeks.evidence)}</span>) : "unknown"}
                      </li>
                    ))}
                  </ul>
                ) : (<p className="mt-1">No relief is taken in this scenario.</p>)}
                {s.economics.limitations.length ? (
                  <><p className="eyebrow mt-3">Limitations</p><ul className="mt-1 list-disc pl-5">{s.economics.limitations.map((l) => (<li key={l}>{l}</li>))}</ul></>
                ) : null}
              </div>
            </div>
          </details>
        ))}
      </div>

      <div className="panel flex flex-col gap-3 p-5">
        <p className="eyebrow">Reproduce this</p>
        <p className="text-xs text-mute">
          Digest <span className="data">{r.request_digest.slice(0, 16)}</span> · engine {r.provenance.engine_version} · provenance{" "}
          <span className="data">{r.provenance.digest.slice(0, 12)}</span>. The same request to the API or{" "}
          <code className="data">gridforge compare</code> returns the same numbers.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs" onClick={() => download("ttp_compare_result.json", r)}>
            <Download className="h-3.5 w-3.5" aria-hidden /> Result (JSON)
          </button>
          <button type="button" className="btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs" onClick={() => download("request.json", out.request)}>
            <Download className="h-3.5 w-3.5" aria-hidden /> Request (JSON)
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onCopy}>{copied ? "Copied" : "Copy request"}</button>
        </div>
        <code className="data block overflow-x-auto whitespace-pre text-[11px] text-faint">{cli}</code>
      </div>
    </section>
  );
}
