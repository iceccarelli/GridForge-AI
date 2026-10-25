import { NextResponse } from "next/server";
import { fetchMarket } from "@/lib/observatory/_shared/feeds";

/**
 * Live German day-ahead power price (EPEX Spot via aWATTar, DE-LU zone).
 *
 * Fetched SERVER-SIDE so there's no CORS issue and the upstream fair-use limit
 * is respected via caching (revalidate 30 min → well under 100 req/day). This
 * endpoint returns ONLY real fetched data. On any upstream failure it returns
 * { ok: false } — the client shows "unavailable", never a fabricated number.
 *
 * aWATTar response shape: { data: [{ start_timestamp, end_timestamp,
 * marketprice, unit: "Eur/MWh" }, ...] } — prices from now up to ~24h ahead.
 */

export const dynamic = "force-dynamic"; // never fetch awattar at build time
export const revalidate = 1800; // 30 minutes (request-time cache)

// The upstream fetch and the arithmetic live in lib/observatory/_shared/feeds.ts (shared with the Observatory's live context);
// the JSON this route returns is unchanged (tests/site/observatory-core-routes-snapshot.test.ts).
export async function GET() {
  const { body } = await fetchMarket({ timeoutMs: 6000, init: { next: { revalidate: 1800 } } });
  return NextResponse.json(body);
}
