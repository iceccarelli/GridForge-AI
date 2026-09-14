"use client";

import React, { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Loader2, Plus, Trash2 } from "lucide-react";

/**
 * The intake a client fills in after commissioning an engagement.
 *
 * Thirteen numbers decide the answer. Anything left blank becomes a library
 * default AND is named as an assumption in the delivered document — the form says
 * so, because a client who knows that supplies more of it.
 */

type Num = number | "";

interface Row {
  id: string;
  rating: Num;
  units: Num;
  redundancy: string;
}

const REDUNDANCY = ["N", "N+1", "N+2", "2N"];

export function EngagementIntake({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<{ product?: { name: string }; status?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [f, setF] = useState<Record<string, string>>({
    siteName: "", hallId: "", metro: "", country: "", buildYear: "", floorType: "raised_floor",
    dso: "", firmCapacityMVA: "", contractedMW: "", currentPeakMW: "", currentItLoadMW: "",
    powerFactor: "0.97", queueNote: "",
    buswayAmpacityA: "", buswayRuns: "6", tapoffMaxA: "", voltageV: "400",
    floorLoadingKPa: "", positionsAvailable: "", rackPositions: "", netWhiteSpaceM2: "",
    clearHeightM: "", aislePitchM: "", designDensityKWPerRack: "",
    plantCapacityKW: "", plantSupplyC: "", plantReturnC: "", pumpFlowLPerMin: "",
    residualAirKWPerRack: "", designDrybulbC: "",
    platform: "gb300_nvl72", utilisation: "0.75",
  });
  const [transformers, setTransformers] = useState<Row[]>([
    { id: "TX-1", rating: "", units: "", redundancy: "N+1" },
  ]);
  const [ups, setUps] = useState<Row[]>([{ id: "UPS-1", rating: "", units: "", redundancy: "N+1" }]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/intake/${token}`)
      .then((r) => r.json())
      .then((b) => {
        if (!alive) return;
        if (!b.ok) setError("This engagement link is not valid.");
        else setMeta(b);
      })
      .catch(() => alive && setError("Could not load this engagement."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [token]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const rows = (list: Row[], setList: (r: Row[]) => void, unit: string, label: string) => (
    <div className="grid gap-2">
      {list.map((r, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <input
            aria-label={`${label} ${i + 1} id`}
            className={inputCls}
            value={r.id}
            onChange={(e) =>
              setList(list.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))
            }
          />
          <input
            aria-label={`${label} ${i + 1} rating`}
            className={inputCls}
            type="number"
            min={0}
            placeholder={unit}
            value={r.rating}
            onChange={(e) =>
              setList(
                list.map((x, j) =>
                  j === i ? { ...x, rating: e.target.value === "" ? "" : Number(e.target.value) } : x
                )
              )
            }
          />
          <input
            aria-label={`${label} ${i + 1} units`}
            className={inputCls}
            type="number"
            min={1}
            placeholder="units"
            value={r.units}
            onChange={(e) =>
              setList(
                list.map((x, j) =>
                  j === i ? { ...x, units: e.target.value === "" ? "" : Number(e.target.value) } : x
                )
              )
            }
          />
          <select
            aria-label={`${label} ${i + 1} redundancy`}
            className={inputCls}
            value={r.redundancy}
            onChange={(e) =>
              setList(list.map((x, j) => (j === i ? { ...x, redundancy: e.target.value } : x)))
            }
          >
            {REDUNDANCY.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setList(list.filter((_, j) => j !== i))}
            className="inline-flex items-center justify-center rounded border border-line px-2 py-2 text-faint hover:text-flag"
            aria-label={`Remove ${label} ${i + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setList([...list, { id: `${label}-${list.length + 1}`, rating: "", units: "", redundancy: "N+1" }])
        }
        className="inline-flex w-fit items-center gap-2 rounded border border-line px-3 py-1.5 text-sm text-mute hover:text-ghost"
      >
        <Plus className="h-3.5 w-3.5" /> Add
      </button>
    </div>
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const clean = (v: string) => (v.trim() === "" ? undefined : v);
    const payload = {
      ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, clean(v)])),
      transformers: transformers
        .filter((r) => r.rating !== "" && r.units !== "")
        .map((r) => ({ id: r.id, unit_rating_MVA: r.rating, units: r.units, redundancy: r.redundancy })),
      ups: ups
        .filter((r) => r.rating !== "" && r.units !== "")
        .map((r) => ({ id: r.id, unit_rating_kW: r.rating, units: r.units, redundancy: r.redundancy })),
    };
    try {
      const res = await fetch(`/api/intake/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body?.error ?? "Submission failed.");
        return;
      }
      setDone(body.message);
    } catch {
      setError("Could not reach the server. Your numbers were not submitted — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="panel flex items-center gap-3 p-8 text-mute">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading engagement…
      </div>
    );
  }

  if (done) {
    return (
      <div className="panel p-8">
        <div className="flex gap-3">
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-verified" />
          <div>
            <h2 className="text-xl font-semibold text-ghost">Received</h2>
            <p className="mt-2 max-w-2xl text-mute">{done}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel grid gap-8 p-6 sm:p-8">
      {meta?.product ? (
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-power">
          {meta.product.name} · intake
        </p>
      ) : null}

      <Section
        title="The hall"
        note="Identity and geometry. Floor loading is a gate for 120 kW+ racks, not a margin."
      >
        <Field label="Site name" required><input className={inputCls} value={f.siteName} onChange={set("siteName")} required /></Field>
        <Field label="Hall id" required><input className={inputCls} value={f.hallId} onChange={set("hallId")} required /></Field>
        <Field label="Metro"><input className={inputCls} value={f.metro} onChange={set("metro")} /></Field>
        <Field label="Country"><input className={inputCls} value={f.country} onChange={set("country")} /></Field>
        <Field label="Build year"><input className={inputCls} type="number" value={f.buildYear} onChange={set("buildYear")} /></Field>
        <Field label="Floor">
          <select className={inputCls} value={f.floorType} onChange={set("floorType")}>
            <option value="raised_floor">Raised floor</option>
            <option value="slab">Slab</option>
          </select>
        </Field>
        <Field label="Floor loading · kPa" required hint="Design value from the structural record.">
          <input className={inputCls} type="number" step="0.5" value={f.floorLoadingKPa} onChange={set("floorLoadingKPa")} required />
        </Field>
        <Field label="Rack positions available" required><input className={inputCls} type="number" value={f.positionsAvailable} onChange={set("positionsAvailable")} required /></Field>
        <Field label="Rack positions total"><input className={inputCls} type="number" value={f.rackPositions} onChange={set("rackPositions")} /></Field>
        <Field label="Net white space · m²"><input className={inputCls} type="number" value={f.netWhiteSpaceM2} onChange={set("netWhiteSpaceM2")} /></Field>
        <Field label="Clear height · m"><input className={inputCls} type="number" step="0.1" value={f.clearHeightM} onChange={set("clearHeightM")} /></Field>
        <Field label="Aisle pitch · m"><input className={inputCls} type="number" step="0.1" value={f.aislePitchM} onChange={set("aislePitchM")} /></Field>
        <Field label="Design density · kW/rack"><input className={inputCls} type="number" step="0.5" value={f.designDensityKWPerRack} onChange={set("designDensityKWPerRack")} /></Field>
        <Field label="Summer design dry bulb · °C"><input className={inputCls} type="number" step="0.5" value={f.designDrybulbC} onChange={set("designDrybulbC")} /></Field>
      </Section>

      <Section title="Supply" note="The ceiling on everything downstream. Peak from metered data, not a nameplate.">
        <Field label="DSO"><input className={inputCls} value={f.dso} onChange={set("dso")} /></Field>
        <Field label="Firm connection · MVA" required><input className={inputCls} type="number" step="0.1" value={f.firmCapacityMVA} onChange={set("firmCapacityMVA")} required /></Field>
        <Field label="Contracted · MW" required><input className={inputCls} type="number" step="0.1" value={f.contractedMW} onChange={set("contractedMW")} required /></Field>
        <Field label="Current site peak · MW" required><input className={inputCls} type="number" step="0.1" value={f.currentPeakMW} onChange={set("currentPeakMW")} required /></Field>
        <Field label="Current IT load · MW" required><input className={inputCls} type="number" step="0.1" value={f.currentItLoadMW} onChange={set("currentItLoadMW")} required /></Field>
        <Field label="Power factor"><input className={inputCls} type="number" step="0.01" value={f.powerFactor} onChange={set("powerFactor")} /></Field>
      </Section>

      <Section title="Distribution" note="400 A legacy against 800–1000 A modern is the most common hard stop.">
        <Field label="Busway ampacity · A" required><input className={inputCls} type="number" value={f.buswayAmpacityA} onChange={set("buswayAmpacityA")} required /></Field>
        <Field label="Busway runs"><input className={inputCls} type="number" value={f.buswayRuns} onChange={set("buswayRuns")} /></Field>
        <Field label="Tap-off rating · A" required><input className={inputCls} type="number" value={f.tapoffMaxA} onChange={set("tapoffMaxA")} required /></Field>
        <Field label="LV voltage · V"><input className={inputCls} type="number" value={f.voltageV} onChange={set("voltageV")} /></Field>
      </Section>

      <Section title="Cooling" note="Legacy 6–7 °C plant against a 27–32 °C loop requirement governs the scheme.">
        <Field label="Plant capacity · kW" required><input className={inputCls} type="number" value={f.plantCapacityKW} onChange={set("plantCapacityKW")} required /></Field>
        <Field label="Supply temperature · °C" required><input className={inputCls} type="number" step="0.5" value={f.plantSupplyC} onChange={set("plantSupplyC")} required /></Field>
        <Field label="Return temperature · °C"><input className={inputCls} type="number" step="0.5" value={f.plantReturnC} onChange={set("plantReturnC")} /></Field>
        <Field label="Available pumped flow · l/min"><input className={inputCls} type="number" value={f.pumpFlowLPerMin} onChange={set("pumpFlowLPerMin")} /></Field>
        <Field label="Air removal per position · kW"><input className={inputCls} type="number" step="0.5" value={f.residualAirKWPerRack} onChange={set("residualAirKWPerRack")} /></Field>
      </Section>

      <Section title="Target compute" note="The tenant's actual order, not a press release.">
        <Field label="Platform">
          <select className={inputCls} value={f.platform} onChange={set("platform")}>
            <option value="gb300_nvl72">NVIDIA GB300 NVL72</option>
            <option value="gb200_nvl72">NVIDIA GB200 NVL72</option>
            <option value="generic_dlc_50">Generic DLC rack, 50 kW</option>
          </select>
        </Field>
        <Field label="Annual utilisation"><input className={inputCls} type="number" step="0.05" min="0.1" max="1" value={f.utilisation} onChange={set("utilisation")} /></Field>
      </Section>

      <div>
        <h3 className="text-sm font-semibold text-ghost">Transformer schedule</h3>
        <p className="mb-3 mt-1 text-xs text-faint">
          Usually the schedule driver — power transformers ran 160+ weeks in 2026.
        </p>
        {rows(transformers, setTransformers, "MVA", "TX")}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-ghost">UPS schedule</h3>
        <p className="mb-3 mt-1 text-xs text-faint">
          GPU racks present step loads, not just steady load.
        </p>
        {rows(ups, setUps, "kW", "UPS")}
      </div>

      {error ? (
        <div className="flex gap-3 rounded border border-flag/40 bg-flag/10 p-4 text-sm text-ghost">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-flag" />
          <p>{error}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded bg-power px-5 py-2.5 font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? "Solving" : "Submit the hall's numbers"}
        </button>
        <span className="max-w-md text-[11px] text-faint">
          Anything left blank is filled from a library default and named as an assumption in the
          delivered document. Nothing is invented silently.
        </span>
      </div>
    </form>
  );
}

const inputCls =
  "w-full rounded border border-line bg-panel-2 px-3 py-2 font-mono text-ghost " +
  "focus:border-power/60 focus:outline-none focus:ring-2 focus:ring-power/60";

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="grid gap-4">
      <legend className="sr-only">{title}</legend>
      <div>
        <h3 className="text-sm font-semibold text-ghost">{title}</h3>
        <p className="mt-1 text-xs text-faint">{note}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
        {label}
        {required ? <span className="text-flag"> *</span> : null}
      </span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-1 block text-[11px] text-faint">{hint}</span> : null}
    </label>
  );
}
