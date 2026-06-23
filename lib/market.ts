"use client";

import { useEffect, useState } from "react";

/**
 * Shared live-market data layer for the dashboard. Pulls the two REAL feeds the
 * site already exposes — EPEX day-ahead (via /api/market) and the German
 * generation mix (via /api/grid) — and exposes a single snapshot the tabs can
 * read. Everything here is real, live data. On failure each field is null and
 * the UI shows "unavailable" rather than inventing a number.
 */

export type MarketSnapshot = {
  ok: boolean;
  loading: boolean;
  epex: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  spread: number | null;
  series: { t: number; price: number }[];
  renewablePct: number | null;
  totalMW: number | null;
};

const EMPTY: MarketSnapshot = {
  ok: false, loading: true, epex: null, avg: null, min: null, max: null,
  spread: null, series: [], renewablePct: null, totalMW: null,
};

export function useMarket(): MarketSnapshot {
  const [snap, setSnap] = useState<MarketSnapshot>(EMPTY);

  useEffect(() => {
    let live = true;
    Promise.allSettled([
      fetch("/api/market").then((r) => r.json()),
      fetch("/api/grid").then((r) => r.json()),
    ]).then(([m, g]) => {
      if (!live) return;
      const mk = m.status === "fulfilled" ? m.value : null;
      const gd = g.status === "fulfilled" ? g.value : null;
      setSnap({
        ok: !!(mk && mk.ok),
        loading: false,
        epex: mk?.ok ? mk.current : null,
        avg: mk?.ok ? mk.avg : null,
        min: mk?.ok ? mk.min : null,
        max: mk?.ok ? mk.max : null,
        spread: mk?.ok ? mk.spread : null,
        series: mk?.ok && Array.isArray(mk.series) ? mk.series : [],
        renewablePct: gd?.ok ? gd.renewablePct : null,
        totalMW: gd?.ok ? gd.totalMW : null,
      });
    });
    return () => { live = false; };
  }, []);

  return snap;
}

/**
 * Illustrative daily BESS arbitrage: applies a REAL wholesale spread to a
 * (sample) battery size. Returns euros, or null if the spread is unavailable.
 * The spread is real; the battery size is the caller's sample assumption.
 */
export function arbPerDay(spread: number | null, bessMWh: number, cycles = 1): number | null {
  if (spread == null) return null;
  return Math.max(0, spread * bessMWh * cycles);
}
