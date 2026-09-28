"use client";

import { useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { useRouter } from "next/navigation";

/**
 * Creates a BTM Power Deployment Case.
 *
 * Deliberately narrow: one generator, one battery, a flat load assumption. A
 * real intake with an uploaded interval CSV and an arbitrary equipment list is
 * the engine's own `deployment_request()` shape (see
 * docs/07_DELIVERY_RUNBOOK.md) — this form exists so a person can see the
 * capability work end to end without a JSON editor, not to be the only way
 * in. The API accepts everything this form does not expose.
 */
export function PowerDeployCaseForm() {
  const router = useRouter();
  const [targetMW, setTargetMW] = useState("35");
  const [gridFirmMW, setGridFirmMW] = useState("10");
  const [flatKW, setFlatKW] = useState("30000");
  const [genMW, setGenMW] = useState("20");
  const [bessPowerMW, setBessPowerMW] = useState("8");
  const [bessEnergyMWh, setBessEnergyMWh] = useState("32");
  const [redundancy, setRedundancy] = useState("N+1");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    setError(null);
    try {
      const res = await fetch("/api/power/deploy/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          load_profile: { flat_kW: Number(flatKW) },
          grid_firm_MW: Number(gridFirmMW),
          target_MW: Number(targetMW),
          redundancy,
          generation: Number(genMW) > 0
            ? [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: Number(genMW) }]
            : [],
          bess: Number(bessPowerMW) > 0
            ? [{ id: "BESS-1", power_MW: Number(bessPowerMW), energy_MWh: Number(bessEnergyMWh) }]
            : [],
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not run that assessment.");
        setState("error");
        return;
      }
      router.push(`/power/deploy/${body.case_token}`);
    } catch {
      setError("Could not reach the server. Try again.");
      setState("error");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded border border-line bg-panel-2 p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Target firm power (MW)" value={targetMW} onChange={setTargetMW} />
        <Field label="Grid firm capacity today (MW)" value={gridFirmMW} onChange={setGridFirmMW} />
        <Field label="Load, screening assumption (kW)" value={flatKW} onChange={setFlatKW} />
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-faint">
            Redundancy policy
          </label>
          <select
            value={redundancy}
            onChange={(e) => setRedundancy(e.target.value)}
            className="w-full rounded border border-line bg-panel px-3 py-2 text-sm text-ghost"
          >
            <option value="N">N</option>
            <option value="N+1">N+1</option>
            <option value="N+2">N+2</option>
            <option value="2N">2N</option>
          </select>
        </div>
        <Field label="Candidate generator, nameplate (MW)" value={genMW} onChange={setGenMW} />
        <Field label="Candidate battery, power (MW)" value={bessPowerMW} onChange={setBessPowerMW} />
        <Field label="Candidate battery, energy (MWh)" value={bessEnergyMWh} onChange={setBessEnergyMWh} />
      </div>
      <p className="text-[11px] text-faint">
        A flat load assumption is a screening-level figure, not a measurement — the assessment
        says so on every reading it produces. Upload a real interval export via the API for a
        customer-measured evidence class instead.
      </p>
      <button
        type="submit"
        disabled={state === "busy"}
        className="inline-flex w-fit items-center gap-2 rounded bg-power px-5 py-2.5 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "busy" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
        Run the assessment
      </button>
      {error ? <p className="text-[12px] text-flag">{error}</p> : null}
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-faint">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-line bg-panel px-3 py-2 text-sm text-ghost"
      />
    </div>
  );
}
