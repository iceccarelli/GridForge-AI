"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";

/**
 * The loop that makes this a case rather than a one-off report: change one
 * input, re-solve, see exactly what moved. `changedFields()`
 * (lib/power-deploy.ts) does the actual comparison — this component only
 * posts a partial update and re-renders on the server's redirect.
 */
export function PowerDeployCaseUpdate({ token }: { token: string }) {
  const router = useRouter();
  const [targetMW, setTargetMW] = useState("");
  const [gridFirmMW, setGridFirmMW] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    setError(null);
    const patch: Record<string, number> = {};
    if (targetMW.trim()) patch.target_MW = Number(targetMW);
    if (gridFirmMW.trim()) patch.grid_firm_MW = Number(gridFirmMW);
    if (!Object.keys(patch).length) {
      setState("idle");
      return;
    }
    try {
      const res = await fetch(`/api/power/deploy/cases/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not re-solve this case.");
        setState("error");
        return;
      }
      setTargetMW("");
      setGridFirmMW("");
      setState("idle");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
      setState("error");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded border border-line bg-panel-2 p-4">
      <div>
        <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-faint">
          New target (MW)
        </label>
        <input
          type="number"
          value={targetMW}
          onChange={(e) => setTargetMW(e.target.value)}
          placeholder="unchanged"
          className="w-40 rounded border border-line bg-panel px-3 py-2 text-sm text-ghost placeholder:text-faint"
        />
      </div>
      <div>
        <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-faint">
          New grid firm capacity (MW)
        </label>
        <input
          type="number"
          value={gridFirmMW}
          onChange={(e) => setGridFirmMW(e.target.value)}
          placeholder="unchanged"
          className="w-40 rounded border border-line bg-panel px-3 py-2 text-sm text-ghost placeholder:text-faint"
        />
      </div>
      <button
        type="submit"
        disabled={state === "busy"}
        className="inline-flex items-center gap-2 rounded border border-line px-4 py-2 text-sm font-semibold text-ghost hover:border-power/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "busy" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Re-solve
      </button>
      {error ? <p className="w-full text-[12px] text-flag">{error}</p> : null}
    </form>
  );
}
