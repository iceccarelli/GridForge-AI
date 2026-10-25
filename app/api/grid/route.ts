import { NextResponse } from "next/server";
import { fetchGrid } from "@/lib/observatory/_shared/feeds";

/**
 * Live German generation mix + renewable share (Fraunhofer ISE, Energy-Charts).
 *
 * Source: https://api.energy-charts.info/public_power?country=de — no token,
 * CC BY 4.0. Returns { unix_seconds: [...], production_types: [{ name, data:
 * [MW|null] }] }. We snapshot the latest fully-reported interval and classify
 * each source as renewable or not to compute a live renewable share.
 *
 * Real data only. On any failure → { ok: false }; the client shows
 * "unavailable", never a fabricated number. Cached 15 min.
 */

export const dynamic = "force-dynamic"; // never fetch upstream at build time
export const revalidate = 900; // 15 minutes (request-time cache)

// The upstream fetch and the arithmetic live in lib/observatory/_shared/feeds.ts (shared with the Observatory's live context);
// the JSON this route returns is unchanged (tests/site/observatory-core-routes-snapshot.test.ts).
export async function GET() {
  return NextResponse.json(await fetchGrid({ timeoutMs: 6000, init: { next: { revalidate: 900 } } }));
}
