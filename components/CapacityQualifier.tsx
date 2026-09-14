"use client";

import React, { useState } from "react";
import { ArrowRight, CircleAlert, Loader2 } from "lucide-react";
import type { QualifyResult } from "@/lib/qualify";
import { PRODUCTS } from "@/lib/products";
import { eur } from "@/lib/commerce";
import { openAudit } from "@/lib/ui";

/**
 * Capacity qualifier.
 *
 * Seven numbers a facilities engineer already knows, answered by the same engine
 * that produces the paid study. It returns the binding constraint — the thing that
 * actually stops the hall — and the list of inputs nobody has measured.
 *
 * What it deliberately withholds: capital cost, programme duration, the full
 * constraint ladder. The API enforces that server-side; this component could not
 * show them if it tried.
 *
 * Every figure it displays comes back from the engine with an evidence class
 * attached. Nothing here is computed in the browser.
 */

interface FieldDef {
  key: keyof typeof DEFAULTS;
  label: string;
  unit: string;
  hint: string;
  step?: string;
}

const DEFAULTS = {
  contractedMW: 12,
  currentPeakMW: 7.4,
  currentItLoadMW: 4.9,
  buswayAmpacityA: 400,
  tapoffMaxA: 63,
  plantSupplyC: 6,
  positionsAvailable: 180,
};

const FIELDS: FieldDef[] = [
  { key: "contractedMW", label: "Contracted capacity", unit: "MW", step: "0.1",
    hint: "From the supply contract, not the connection nameplate." },
  { key: "currentPeakMW", label: "Current site peak", unit: "MW", step: "0.1",
    hint: "Half-hourly metered peak over 12 months." },
  { key: "currentItLoadMW", label: "Current IT load", unit: "MW", step: "0.1",
    hint: "Protected load at the UPS output." },
  { key: "buswayAmpacityA", label: "Busway ampacity", unit: "A",
    hint: "400 A legacy or 800–1000 A modern. The most common hard stop." },
  { key: "tapoffMaxA", label: "Tap-off rating", unit: "A",
    hint: "A rack that cannot be fed cannot be placed." },
  { key: "plantSupplyC", label: "Plant supply temperature", unit: "°C", step: "0.5",
    hint: "Chilled water flow setpoint. Legacy plant runs 6–7 °C." },
  { key: "positionsAvailable", label: "Rack positions available", unit: "",
    hint: "Positions you could actually release from tenancy." },
];

const PLATFORMS = [
  { id: "gb300_nvl72", label: "NVIDIA GB300 NVL72" },
  { id: "gb200_nvl72", label: "NVIDIA GB200 NVL72" },
  { id: "generic_dlc_50", label: "Generic DLC rack, 50 kW" },
];

type Values = typeof DEFAULTS;

export function CapacityQualifier() {
  const [values, setValues] = useState<Values>(DEFAULTS);
  const [platform, setPlatform] = useState<string>("gb300_nvl72");
  const [siteName, setSiteName] = useState("");
  const [metro, setMetro] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QualifyResult | null>(null);
  const [headline, setHeadline] = useState<string>("");

  const set = (key: keyof Values, raw: string) =>
    setValues((v) => ({ ...v, [key]: raw === "" ? 0 : Number(raw) }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/qualify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, platform, siteName, metro }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body?.error ?? "The engine did not return a result.");
        return;
      }
      setResult(body.result as QualifyResult);
      setHeadline(String(body.headline ?? ""));
    } catch {
      setError("Could not reach the engine. Your figures were not lost — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel p-6 sm:p-8">
      <div className="mb-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power mb-2">
          Capacity qualifier
        </p>
        <h3 className="text-xl sm:text-2xl font-semibold text-ghost">
          What actually stops your hall?
        </h3>
        <p className="text-mute mt-2 max-w-2xl text-sm">
          Seven numbers you already know. The same engine that produces our paid study returns the
          binding constraint, the deployable rack count, and the inputs nobody has measured yet.
          Capital cost and programme duration are part of the engagement, not of this read.
        </p>
      </div>

      <form onSubmit={submit} className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {f.label}
                {f.unit ? ` · ${f.unit}` : ""}
              </span>
              <input
                id={`qualify-${f.key}`}
                type="number"
                inputMode="decimal"
                step={f.step ?? "1"}
                min={0}
                value={values[f.key]}
                onChange={(e) => set(f.key, e.target.value)}
                className="mt-1 w-full bg-panel-2 border border-line rounded px-3 py-2 font-mono text-ghost
                           focus:outline-none focus:ring-2 focus:ring-power/60 focus:border-power/60"
                required
              />
              <span className="block mt-1 text-[11px] leading-snug text-faint">{f.hint}</span>
            </label>
          ))}

          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Target platform
            </span>
            <select
              id="qualify-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="mt-1 w-full bg-panel-2 border border-line rounded px-3 py-2 font-mono text-ghost
                         focus:outline-none focus:ring-2 focus:ring-power/60"
            >
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="block mt-1 text-[11px] leading-snug text-faint">
              Platforms whose rack power the manufacturer has not published are absent by design.
            </span>
          </label>

          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Site / hall
            </span>
            <input
              id="qualify-site"
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="optional"
              className="mt-1 w-full bg-panel-2 border border-line rounded px-3 py-2 text-ghost
                         focus:outline-none focus:ring-2 focus:ring-power/60"
            />
          </label>

          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Metro
            </span>
            <input
              id="qualify-metro"
              type="text"
              value={metro}
              onChange={(e) => setMetro(e.target.value)}
              placeholder="optional"
              className="mt-1 w-full bg-panel-2 border border-line rounded px-3 py-2 text-ghost
                         focus:outline-none focus:ring-2 focus:ring-power/60"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink
                       disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? "Solving" : "Find the binding constraint"}
          </button>
          <span className="text-[11px] text-faint font-mono">
            13 constraints · electrical, thermal and physical · solved server-side
          </span>
        </div>
      </form>

      {error ? (
        <div className="mt-6 flex gap-3 rounded border border-flag/40 bg-flag/10 p-4 text-sm text-ghost">
          <CircleAlert className="h-4 w-4 shrink-0 text-flag mt-0.5" />
          <p>{error}</p>
        </div>
      ) : null}

      {result ? <QualifyReadout result={result} headline={headline} /> : null}
    </div>
  );
}

function QualifyReadout({ result, headline }: { result: QualifyResult; headline: string }) {
  const { as_found: found, after_relief: after, intake } = result;
  return (
    <div className="mt-8 animate-slide-up">
      <p className="text-lg text-ghost leading-snug max-w-3xl">{headline}</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Readout label="Deployable today" value={String(found.racks)} suffix="racks" tone="ghost" />
        <Readout label="After the ladder" value={String(after.racks)} suffix="racks" tone="power" />
        <Readout label="Sets the date" value={after.sets_the_date} tone="queue" small />
      </div>

      <div className="mt-5 rounded border border-line bg-panel-2 p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-queue">
          Binding constraint · {found.domain}
        </p>
        <p className="text-ghost font-semibold mt-1">{found.binding_constraint}</p>
        <p className="text-mute text-sm mt-1">{found.basis}</p>
      </div>

      {result.first_three_constraints.length ? (
        <div className="mt-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint mb-2">
            What has to move, in order
          </p>
          <ol className="grid gap-2">
            {result.first_three_constraints.map((c, i) => (
              <li
                key={`${c.name}-${i}`}
                className="flex gap-3 rounded border border-line bg-panel-2 px-3 py-2 text-sm"
              >
                <span className="font-mono text-faint">{i + 1}</span>
                <span className="text-ghost">{c.name}</span>
                <span className="text-faint ml-auto text-right">{c.relief ?? "—"}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {intake.gaps.length ? (
        <div className="mt-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint mb-2">
            Assumed, because nobody supplied it · intake {Math.round(intake.completeness * 100)}%
            complete
          </p>
          <div className="overflow-x-auto rounded border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-panel">
                  {["Input", "Assumed", "Why it binds"].map((h) => (
                    <th
                      key={h}
                      className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-faint px-3 py-2"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {intake.gaps.slice(0, 8).map((g) => (
                  <tr key={g.input} className="border-t border-line align-top">
                    <td className="px-3 py-2 text-ghost">
                      {g.input}
                      {g.required ? <span className="text-flag"> *</span> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-mute">{g.assumed}</td>
                    <td className="px-3 py-2 text-faint">{g.why_it_binds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-faint mt-2">
            {intake.required_inputs_missing} required input
            {intake.required_inputs_missing === 1 ? "" : "s"} assumed. Each one moves the answer.
          </p>
        </div>
      ) : null}

      <CommissionPanel
        recommendation={intake.recommended_engagement}
        summary={`${headline} Binding constraint: ${found.binding_constraint}. ${intake.required_inputs_missing} required inputs still assumed.`}
        capacityMW={Math.round((found.it_load_kW?.value ?? 0) / 1000)}
      />

      <p className="text-[11px] text-faint mt-5 leading-relaxed max-w-3xl">{result.notice}</p>
    </div>
  );
}

function CommissionPanel({
  recommendation,
  summary,
  capacityMW,
}: {
  recommendation: string;
  summary: string;
  capacityMW: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screen = PRODUCTS.density_screen;

  async function commission() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: screen.id, capacityMW }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.url) {
        setError(
          body?.error === "Payments not configured"
            ? "Checkout is not live on this deployment yet — use the conversation route below."
            : (body?.error ?? "Could not start checkout.")
        );
        return;
      }
      window.location.href = body.url as string;
    } catch {
      setError("Could not reach checkout. Try the conversation route below.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded border border-line bg-panel-2 p-4">
      <p className="text-sm text-ghost">{recommendation}</p>
      <p className="mt-2 text-xs text-faint">
        {screen.deliverable} {screen.turnaroundDays} working days from a complete intake, and the
        fee credits in full against the full study.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={commission}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded bg-power px-4 py-2 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Commission the {screen.name} · {eur(screen.amountCents)}
        </button>
        <button
          type="button"
          onClick={() => openAudit("capacity-qualifier", { capacityMW, summary })}
          className="inline-flex items-center gap-2 rounded border border-line px-4 py-2 text-sm text-mute hover:text-ghost"
        >
          Talk it through first <ArrowRight className="h-4 w-4" />
        </button>
      </div>
      {error ? <p className="mt-3 text-sm text-flag">{error}</p> : null}
    </div>
  );
}

function Readout({
  label,
  value,
  suffix,
  tone,
  small,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone: "ghost" | "power" | "queue";
  small?: boolean;
}) {
  const color = tone === "power" ? "text-power" : tone === "queue" ? "text-queue" : "text-ghost";
  return (
    <div className="rounded border border-line bg-panel-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className={`font-mono ${small ? "text-base" : "text-3xl"} font-semibold ${color} mt-1`}>
        {value}
        {suffix ? <span className="text-sm text-faint font-normal"> {suffix}</span> : null}
      </p>
    </div>
  );
}
