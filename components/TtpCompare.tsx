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
import { QuotationEffectPanel } from "@/components/QuotationEffectPanel";
import { DateFigure } from "@/components/DateFigure";
import { formatRankingValue, formatWeeksDelta, formatLeadTime } from "@/lib/date-basis";
import { GridQueuePanel } from "@/components/GridQueuePanel";
import { RetailPricePanel } from "@/components/RetailPricePanel";
import { templateDerivedCount } from "@/lib/ttp-compare";
import {
  HALL_PRESETS,
  PRESET_DISCLOSURE,
  PRESET_VALUE_CLASS,
  PRESET_VALUE_KEYS,
  presetById,
  resultIsSynthetic,
  stillTemplateValues,
  templateLoadState,
  type HallPreset,
} from "@/lib/hall-presets";

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
  ["pumpFlowLPerMin", "Pumped flow available (l/min)"],
  ["existingNonItHeatKW", "Other heat already on the plant (kW)"],
  ["designDrybulbC", "Summer design dry-bulb (°C)"],
  ["residualAirKWPerRack", "Air removal per rack position (kW)"],
];

// Clearly synthetic: loaded only on request, and named as such wherever it is shown.
const SYNTHETIC: Fields = {
  siteName: "Synthetic example hall", hallId: "H1", contractedMW: "12", currentPeakMW: "7.4", currentItLoadMW: "4.9",
  buswayAmpacityA: "400", tapoffMaxA: "63", positionsAvailable: "180", plantSupplyC: "6", firmCapacityMVA: "15",
  floorLoadingKPa: "12", plantCapacityKW: "6000",
};

/** What a result remembers about a reference template it started from: the label stays with the answer, whatever was edited since. */
type TemplateUsed = { name: string; assumed: number; edited: number };

/** What the "Result (JSON)" button saves: the engine's result, with a `template_derived` header first when the comparison started from a template. */
export function resultDownload(out: { result: CompareResult; request: Record<string, unknown>; template?: TemplateUsed }): Record<string, unknown> {
  return out.template ? { template_derived: templateDerivedNote(out.template, out.request), ...out.result } : { ...out.result };
}

/** The header a downloaded result carries when it started from a template, so a reader of the file alone can tell. */
export function templateDerivedNote(t: TemplateUsed, request: Record<string, unknown>) {
  return {
    note: PRESET_DISCLOSURE,
    template: t.name,
    values_marked_assumed_e0: templateDerivedCount(request),
    values_changed_by_the_user: t.edited,
    marked_by: "this site, on the request; the engine's result carries no per-input classes",
  };
}

/** The body the form posts to /api/power/compare. Exported so the tests send exactly what a click-then-compare sends. */
export function buildCompareBody(f: Fields, btm: Btm[], objective: CompareObjective, preset: HallPreset | null) {
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
  // Only the figures that still hold the template's own value are declared assumed (E0) to the engine; a figure the visitor changed is theirs.
  const assumed = preset ? stillTemplateValues(preset, f).filter((k) => f[k]?.trim()) : [];
  return { hall, btm_options: options, objective, ...(assumed.length ? { assumed_fields: assumed } : {}) };
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

/** Under a field a template filled in: whether the figure is still the template's (assumed) or has become the visitor's. */
function TemplateTag({ id, preset, fieldKey, value }: { id: string; preset: HallPreset; fieldKey: string; value: string | undefined }) {
  if (!(PRESET_VALUE_KEYS as readonly string[]).includes(fieldKey)) return null;
  const still = (value ?? "").trim() === preset.values[fieldKey as (typeof PRESET_VALUE_KEYS)[number]];
  return (
    <span id={id} className={`mt-1 block text-[11px] leading-snug ${still ? "text-queue" : "text-faint"}`}>
      {still ? `Template value · assumed (${PRESET_VALUE_CLASS})` : "Your value"}
    </span>
  );
}

/** `initialTemplateId` starts the form as if that template had been clicked (used by the server-rendered tests; the page never passes it). */
export function TtpCompare({ initialTemplateId = null }: { initialTemplateId?: string | null }) {
  const uid = useId();
  const start = presetById(initialTemplateId);
  const loaded = start ? templateLoadState(start) : null;
  const [f, setF] = useState<Fields>(loaded?.form ?? { platform: "gb300_nvl72" });
  const [btm, setBtm] = useState<Btm[]>(loaded?.btm ?? []);
  const [objective, setObjective] = useState<CompareObjective>(loaded?.objective ?? "max_compute");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: string[] } | null>(null);
  const [out, setOut] = useState<{ result: CompareResult; request: Record<string, unknown>; synthetic: boolean; compare: Record<string, unknown>; template?: TemplateUsed } | null>(null);
  const [synthetic, setSynthetic] = useState(loaded?.synthetic ?? false);
  // The reference template the form was started from (null: none). It stays until the form is cleared, so the disclosure survives edits.
  const [templateId, setTemplateId] = useState<string | null>(loaded?.templateId ?? null);
  const preset = presetById(templateId);
  const templateStill = preset ? stillTemplateValues(preset, f).length : 0;
  const [copied, setCopied] = useState(false);

  const set = (k: string, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setSynthetic(false);
  };
  // A change to the supply options is a change to the hall too: an edited template is no longer an untouched example.
  const editBtm = (fn: (p: Btm[]) => Btm[]) => {
    setBtm(fn);
    if (templateId) setSynthetic(false);
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
      const compare = buildCompareBody(f, btm, objective, preset);
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
      const template = preset ? { name: preset.name, assumed: stillTemplateValues(preset, f).length, edited: PRESET_VALUE_KEYS.length - stillTemplateValues(preset, f).length } : undefined;
      // An untouched template is a synthetic example whatever its labels say; renaming it does not make it a hall.
      setOut({ result: body.result, request: body.request, synthetic: resultIsSynthetic(preset, synthetic, f, btm), compare, template });
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
        <fieldset className="flex flex-col gap-3">
          <legend className="eyebrow">No figures to hand? Start from a reference template</legend>
          <p id={`${uid}-tpl-help`} className="max-w-3xl text-xs text-mute">
            A template fills the form with input values only. They are synthetic and assumed (E0), not a customer&apos;s hall. Nothing is
            solved until you press Compare, and what comes back is what the engine produced from the values in the form.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {HALL_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={templateId === p.id}
                aria-describedby={`${uid}-tpl-help ${uid}-tpl-${p.id}`}
                className={`min-h-11 rounded border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-power/60 ${
                  templateId === p.id ? "border-power/70 bg-power/10" : "border-line bg-panel-2 hover:border-power/50"
                }`}
                onClick={() => {
                  const s = templateLoadState(p);
                  setF(s.form);
                  setBtm(s.btm);
                  setObjective(s.objective);
                  setTemplateId(s.templateId);
                  setSynthetic(s.synthetic);
                  setOut(null);
                  setError(null);
                }}
              >
                <span className="block text-sm font-semibold text-ghost">{p.name}</span>
                <span id={`${uid}-tpl-${p.id}`} className="mt-1 block text-xs text-mute">{p.shape}</span>
              </button>
            ))}
          </div>
          {preset ? (
            <div role="status" className="rounded border border-queue/40 bg-queue/10 p-3 text-sm text-ghost">
              <p><strong>{PRESET_DISCLOSURE}.</strong></p>
              <p className="mt-1 text-mute">
                Started from &ldquo;{preset.name}&rdquo;. {templateStill} of {PRESET_VALUE_KEYS.length} values are still the template&apos;s; this site marks
                them assumed ({PRESET_VALUE_CLASS}) on the request, and a value you change is yours from then on. The identity fields and the on-site
                supply options are labels and candidates, not measurements. Until a value or a supply option is changed, the comparison cannot be saved.
              </p>
            </div>
          ) : null}
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">The hall</p>
          <div className="flex flex-wrap gap-2">
            {preset ? (
              <button
                type="button"
                className="btn-ghost min-h-11 px-3 py-1.5 text-xs"
                onClick={() => {
                  setF({ platform: "gb300_nvl72" });
                  setBtm([]);
                  setTemplateId(null);
                  setSynthetic(false);
                  setOut(null);
                  setError(null);
                }}
              >
                Clear the form
              </button>
            ) : null}
            <button
              type="button"
              className="btn-secondary min-h-11 px-3 py-1.5 text-xs"
              onClick={() => {
                setF({ ...SYNTHETIC, platform: "gb300_nvl72" });
                setBtm([]);
                setTemplateId(null);
                setSynthetic(true);
                setOut(null);
                setError(null);
              }}
            >
              Load a synthetic example
            </button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {REQUIRED.map(([k, label, type]) => (
            <div key={k}>
              <label htmlFor={`${uid}-${k}`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                {label}
              </label>
              <input
                id={`${uid}-${k}`}
                className="field min-h-11 w-full"
                type={type}
                inputMode={type === "number" ? "decimal" : undefined}
                step="any"
                required
                value={f[k] ?? ""}
                aria-describedby={preset ? `${uid}-${k}-tag` : undefined}
                onChange={(e) => set(k, e.target.value)}
              />
              {preset ? <TemplateTag id={`${uid}-${k}-tag`} preset={preset} fieldKey={k} value={f[k]} /> : null}
            </div>
          ))}
        </div>
        <div className="max-w-xs">
          <label htmlFor={`${uid}-platform`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
            Target platform
          </label>
          <select id={`${uid}-platform`} className="field min-h-11 w-full" value={f.platform ?? "gb300_nvl72"} onChange={(e) => set("platform", e.target.value)}>
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
                <input id={`${uid}-${k}`} className="field min-h-11 w-full" type="number" step="any" value={f[k] ?? ""} aria-describedby={preset ? `${uid}-${k}-tag` : undefined} onChange={(e) => set(k, e.target.value)} />
                {preset ? <TemplateTag id={`${uid}-${k}-tag`} preset={preset} fieldKey={k} value={f[k]} /> : null}
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
                      className="field min-h-11 w-full"
                      value={o.kind}
                      onChange={(e) => editBtm((p) => p.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}
                    >
                      {BTM_KINDS.map((k) => (<option key={k} value={k}>{k.replace("_", " ")}</option>))}
                    </select>
                  ) : (
                    <input
                      id={`${uid}-b${i}${key}`}
                      className="field min-h-11 w-full"
                      type="number"
                      step="any"
                      value={(o as Record<string, string>)[key]}
                      onChange={(e) => editBtm((p) => p.map((x, j) => (j === i ? { ...x, [key]: e.target.value } : x)))}
                    />
                  )}
                </div>
              ))}
              <div className="flex items-end">
                <button type="button" className="btn-ghost min-h-11 px-3 py-2 text-xs" onClick={() => editBtm((p) => p.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary mt-3 min-h-11 px-3 py-1.5 text-xs"
            onClick={() => editBtm((p) => [...p, { id: `opt${p.length + 1}`, kind: "gas_engine", capacity_MW: "", lead_time_weeks: "", capex_eur_per_kW: "", energy_MWh: "" }])}
          >
            Add a supply option
          </button>
        </fieldset>

        <div className="flex flex-wrap items-end gap-4 border-t border-line pt-4">
          <div>
            <label htmlFor={`${uid}-obj`} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
              Rank by
            </label>
            <select id={`${uid}-obj`} className="field min-h-11" value={objective} onChange={(e) => setObjective(e.target.value as CompareObjective)}>
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

      {out && !out.synthetic ? <QuotationEffectPanel key={out.result.request_digest} compare={out.compare} base={out.result} /> : null}

      {out && !out.synthetic ? <TtpSaveToProject key={out.result.request_digest} compare={out.compare} defaultName={String(f.siteName ?? "").trim()} /> : null}
      {out?.synthetic ? (
        <p className="text-sm text-mute">
          This is a synthetic example, so it cannot be saved or shared. Enter your own hall to save a comparison to a project.
        </p>
      ) : null}
    </div>
  );
}

export function ComparisonResults({ out, cli, copied, onCopy }: { out: { result: CompareResult; request: Record<string, unknown>; synthetic: boolean; template?: TemplateUsed }; cli: string; copied: boolean; onCopy: () => void }) {
  const r = out.result;
  const byId = Object.fromEntries(r.scenarios.map((s) => [s.id, s]));
  return (
    <section aria-label="Comparison result" className="flex flex-col gap-6">
      {out.template ? (
        <div role="note" className="rounded border border-queue/40 bg-queue/10 p-3 text-sm text-ghost">
          <p><strong>{PRESET_DISCLOSURE}.</strong></p>
          <p className="mt-1 text-mute">
            This result started from &ldquo;{out.template.name}&rdquo;. {out.template.assumed} of {out.template.assumed + out.template.edited} template
            values were still the template&apos;s when it was run{out.template.edited > 0 ? `; ${out.template.edited} had been changed by you` : ""}.
            This site marked those {out.template.assumed} assumed ({PRESET_VALUE_CLASS}) on the request and records the marking in a saved comparison;
            the engine&apos;s result carries no per-input classes. Do not read it as a finding about any site.
          </p>
        </div>
      ) : out.synthetic ? (
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

      <GridQueuePanel ctx={r.grid_queue_context} />
      <RetailPricePanel ctx={r.retail_price_context} />

      <div className="overflow-x-auto" role="region" aria-label="Scenarios compared, scrollable" tabIndex={0}>
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
          <button type="button" className="btn-secondary inline-flex min-h-11 items-center gap-2 px-3 py-1.5 text-xs" onClick={() => download("ttp_compare_result.json", resultDownload(out))}>
            <Download className="h-3.5 w-3.5" aria-hidden /> Result (JSON)
          </button>
          <button type="button" className="btn-secondary inline-flex min-h-11 items-center gap-2 px-3 py-1.5 text-xs" onClick={() => download("request.json", out.request)}>
            <Download className="h-3.5 w-3.5" aria-hidden /> Request (JSON)
          </button>
          <button type="button" className="btn-ghost min-h-11 px-3 py-1.5 text-xs" onClick={onCopy}>{copied ? "Copied" : "Copy request"}</button>
        </div>
        <code className="data block overflow-x-auto whitespace-pre text-[11px] text-faint" role="region" aria-label="Command to reproduce this request" tabIndex={0}>{cli}</code>
      </div>
    </section>
  );
}
