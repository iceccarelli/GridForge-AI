"use client";

import React, { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { Activity } from "lucide-react";
import { openAudit } from "@/lib/ui";

type MarketOk = {
  ok: true;
  market: string;
  source: string;
  unit: string;
  asOf: number;
  current: number;
  min: number;
  max: number;
  avg: number;
  spread: number;
  series: { t: number; price: number }[];
};
type Market = MarketOk | { ok: false; reason?: string };

/**
 * Live Market Intelligence. Reads our own /api/market endpoint (which fetches
 * real EPEX day-ahead prices server-side). Shows ONLY fetched data; on failure
 * it renders an honest "unavailable" state rather than any placeholder number.
 * The intraday spread is connected to the actual value proposition (BESS
 * arbitrage / firm BTM hedge) — a real number doing real argumentative work.
 */
export function LiveMarket() {
  const [data, setData] = useState<Market | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/market")
      .then((r) => r.json())
      .then((d: Market) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const loading = data === null && !failed;
  const ok = data && data.ok ? (data as MarketOk) : null;
  const errored = failed || (data !== null && !data.ok);

  return (
    <div className="panel p-6 sm:p-8 relative overflow-hidden">
      <div className="scanline absolute inset-0 pointer-events-none" />

      <div className="flex flex-wrap items-end justify-between gap-4 mb-7 relative">
        <div>
          <div className="eyebrow">FIG. 04 — LIVE MARKET INTELLIGENCE</div>
          <h3 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1">
            German day-ahead power, right now.
          </h3>
        </div>
        {ok ? (
          <span className="pill pill-verified inline-flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-verified animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="pill pill-progress shrink-0">
            {loading ? "FETCHING…" : "UNAVAILABLE"}
          </span>
        )}
      </div>

      {loading && (
        <div className="h-40 flex items-center justify-center text-mute text-sm data">
          Fetching live EPEX day-ahead prices…
        </div>
      )}

      {errored && (
        <div className="h-40 flex flex-col items-center justify-center text-center gap-2">
          <Activity className="w-6 h-6 text-faint" />
          <p className="text-sm text-mute max-w-sm">
            Live market data is temporarily unavailable. It streams from EPEX
            Spot (via aWATTar) when the feed is reachable — no placeholder
            numbers are shown in its place.
          </p>
        </div>
      )}

      {ok && (
        <>
          <div className="grid sm:grid-cols-[1.1fr_1fr] gap-6 items-center">
            {/* Numbers */}
            <div className="grid grid-cols-2 gap-px bg-line rounded-xl overflow-hidden border border-line">
              <Tile value={`€${ok.current}`} label={`Current hour · ${ok.unit}`} accent="power" />
              <Tile value={`€${ok.avg}`} label="24h average" accent="mute" />
              <Tile value={`€${ok.min}`} label="Cheapest hour" accent="verified" />
              <Tile value={`€${ok.max}`} label="Priciest hour" accent="queue" />
            </div>

            {/* Sparkline */}
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ok.series} margin={{ top: 8, right: 4, bottom: 0, left: -28 }}>
                  <defs>
                    <linearGradient id="lm" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00E5FF" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#00E5FF" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis hide domain={["dataMin - 5", "dataMax + 5"]} />
                  <Tooltip
                    contentStyle={{
                      background: "#0B1120",
                      border: "1px solid #1E2942",
                      borderRadius: 10,
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: 12,
                    }}
                    labelFormatter={(_, p) =>
                      p && p[0]
                        ? new Date((p[0].payload as { t: number }).t).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""
                    }
                    formatter={(v: number) => [`€${v} /MWh`, "Day-ahead"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke="#00E5FF"
                    strokeWidth={1.5}
                    fill="url(#lm)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Insight tied to the value prop */}
          <div className="mt-6 rounded-xl border border-power/25 bg-power/[0.04] p-4">
            <p className="text-sm text-ghost leading-relaxed">
              Today&apos;s spread is{" "}
              <span className="data text-power font-semibold">€{ok.spread}/MWh</span>{" "}
              between the cheapest and priciest hour. That intraday volatility is
              exactly what on-site BESS arbitrages and what firm behind-the-meter
              generation hedges — the economics aren&apos;t theoretical, they&apos;re
              priced into the market every day.
            </p>
          </div>

          <div className="mt-5 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-faint data">
              {ok.market} · {ok.source} · as of{" "}
              {new Date(ok.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
            <button onClick={() => openAudit("live-market")} className="btn-secondary px-4 py-2 rounded-lg text-sm">
              Model this against my load →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({
  value,
  label,
  accent,
}: {
  value: string;
  label: string;
  accent: "power" | "verified" | "queue" | "mute";
}) {
  const color =
    accent === "power"
      ? "text-power"
      : accent === "verified"
      ? "text-verified"
      : accent === "queue"
      ? "text-queue"
      : "text-ghost";
  return (
    <div className="bg-panel p-4">
      <div className={`data text-2xl font-semibold tracking-tight ${color}`}>{value}</div>
      <div className="text-[11px] text-mute mt-1">{label}</div>
    </div>
  );
}
