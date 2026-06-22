"use client";

import React, { useEffect, useState } from "react";
import { Activity } from "lucide-react";

type MixItem = { name: string; mw: number; renewable: boolean };
type GridOk = {
  ok: true;
  source: string;
  country: string;
  asOf: number;
  totalMW: number;
  renewablePct: number;
  mix: MixItem[];
};
type Grid = GridOk | { ok: false; reason?: string };

/**
 * Live German generation mix (Fraunhofer Energy-Charts via /api/grid).
 * Renewable share + a stacked bar of the current sources. Real data only;
 * honest "unavailable" state on failure. Ties the live grid carbon/renewable
 * picture to the firm-power argument without overclaiming.
 */
export function GridMix() {
  const [data, setData] = useState<Grid | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/grid")
      .then((r) => r.json())
      .then((d: Grid) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const loading = data === null && !failed;
  const ok = data && data.ok ? (data as GridOk) : null;
  const errored = failed || (data !== null && !data.ok);

  const color = (m: MixItem, i: number) =>
    m.renewable
      ? ["#34D399", "#00E5FF", "#22D3EE", "#4ADE80"][i % 4]
      : ["#FFB020", "#F87171", "#A78BFA", "#8A94A6"][i % 4];

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-7 relative">
        <div>
          <div className="eyebrow">FIG. 05 — LIVE GENERATION MIX</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            What the German grid is burning now.
          </h3>
        </div>
        {ok ? (
          <span className="pill pill-verified inline-flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-verified animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="pill pill-progress shrink-0">{loading ? "FETCHING…" : "UNAVAILABLE"}</span>
        )}
      </div>

      {loading && (
        <div className="h-32 flex items-center justify-center text-mute text-sm data">
          Fetching live generation data…
        </div>
      )}

      {errored && (
        <div className="h-32 flex flex-col items-center justify-center text-center gap-2">
          <Activity className="w-6 h-6 text-faint" />
          <p className="text-sm text-mute max-w-sm">
            Live generation data is temporarily unavailable. It streams from
            Fraunhofer ISE when reachable — no placeholder numbers are shown.
          </p>
        </div>
      )}

      {ok && (
        <>
          <div className="flex items-end justify-between gap-4 mb-4">
            <div>
              <div className="data text-4xl font-semibold tracking-tight text-verified">
                {ok.renewablePct}%
              </div>
              <div className="text-[12px] text-mute mt-1">Renewable right now</div>
            </div>
            <div className="text-right">
              <div className="data text-lg text-ghost">
                {(ok.totalMW / 1000).toFixed(1)} GW
              </div>
              <div className="text-[11px] text-faint">total generation</div>
            </div>
          </div>

          {/* Stacked bar */}
          <div className="flex h-7 rounded-lg overflow-hidden border border-line">
            {ok.mix.map((m, i) => (
              <div
                key={m.name}
                style={{ width: `${(m.mw / ok.totalMW) * 100}%`, background: color(m, i) }}
                title={`${m.name}: ${m.mw} MW`}
              />
            ))}
          </div>

          {/* Legend */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 mt-4 data text-[11px]">
            {ok.mix.map((m, i) => (
              <div key={m.name} className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: color(m, i) }}
                />
                <span className="text-mute truncate">{m.name}</span>
                <span className="text-faint ml-auto shrink-0">
                  {Math.round((m.mw / ok.totalMW) * 100)}%
                </span>
              </div>
            ))}
          </div>

          <div className="mt-5 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-faint data">
              {ok.country} · {ok.source} · as of{" "}
              {new Date(ok.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
            <p className="text-xs text-faint max-w-xs sm:text-right">
              When renewables dip, the grid leans on fossil — the case for firm,
              dispatchable on-site power.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
