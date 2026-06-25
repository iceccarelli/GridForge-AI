import { NextResponse } from "next/server";
import { QUEUE_SNAPSHOTS } from "@/lib/queue-data";

export const dynamic = "force-dynamic"; // never fetch upstream at build time
export const revalidate = 3600;          // 1h request-time cache

// Serves published ISO queue snapshots (always available, sourced + dated).
// When EIA_API_KEY is set, overlays a LIVE national electricity datapoint from
// the EIA open-data API as a freshness signal. Honest provenance on each field.
export async function GET() {
  const base = {
    ok: true,
    snapshots: QUEUE_SNAPSHOTS,
    live: null as null | { label: string; value: number; unit: string; asOf: string; source: string },
  };

  const key = process.env.EIA_API_KEY;
  if (!key) return NextResponse.json(base);

  try {
    // EIA total US electricity demand (most recent hourly point) — a live,
    // verifiable national signal proving the feed is current.
    const url =
      "https://api.eia.gov/v2/electricity/rto/region-data/data/" +
      "?api_key=" + key +
      "&frequency=hourly&data[0]=value&facets[type][]=D" +
      "&sort[0][column]=period&sort[0][direction]=desc&length=1";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      const row = j?.response?.data?.[0];
      if (row && typeof row.value !== "undefined") {
        base.live = {
          label: "US grid demand",
          value: Math.round(Number(row.value)),
          unit: "MW",
          asOf: row.period || "",
          source: "EIA open data (live)",
        };
      }
    }
  } catch {
    // Live overlay is best-effort; snapshots always stand on their own.
  }
  return NextResponse.json(base);
}
