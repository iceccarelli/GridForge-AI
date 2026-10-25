import { NextResponse } from "next/server";
import { QUEUE_SNAPSHOTS } from "@/lib/queue-data";
import { fetchEiaDemand } from "@/lib/observatory/_shared/feeds";

export const dynamic = "force-dynamic"; // never fetch upstream at build time
export const revalidate = 3600;          // 1h request-time cache

// Serves published ISO queue snapshots (always available, sourced + dated).
// When EIA_API_KEY is set, overlays a LIVE national electricity datapoint from
// the EIA open-data API as a freshness signal. Honest provenance on each field.
// The EIA request lives in lib/observatory/_shared/feeds.ts (shared with the Observatory); the JSON is unchanged.
export async function GET() {
  const base = {
    ok: true,
    snapshots: QUEUE_SNAPSHOTS,
    live: null as null | { label: string; value: number; unit: string; asOf: string; source: string },
  };

  const key = process.env.EIA_API_KEY;
  if (!key) return NextResponse.json(base);

  // EIA total US electricity demand (most recent hourly point) — a live,
  // verifiable national signal proving the feed is current.
  const eia = await fetchEiaDemand(key, { timeoutMs: 5000 });
  if (eia) base.live = eia.live;
  return NextResponse.json(base);
}
