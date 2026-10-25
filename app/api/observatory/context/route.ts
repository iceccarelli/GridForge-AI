import { NextResponse } from "next/server";
import { getLiveContext } from "@/lib/observatory/sources";

/**
 * GET /api/observatory/context: the Observatory's live context (EPEX day-ahead price, German generation mix, published queue
 * snapshots, optional EIA demand), each value with its provenance and a freshness computed at the moment of this response.
 * The body is a LiveContext (lib/observatory/types.ts) and nothing else; a feed that failed is `value: null` with freshness
 * "unavailable", never a placeholder, and the response is still 200 so one dead feed does not hide the others.
 *
 * GUARD. Like /api/market, /api/grid and /api/queue, this route spends no company credential and calls no paid provider
 * (lib/rate-limit.ts guards the engine and Anthropic paths, which this does not touch), so it carries no per-caller counter:
 * a counter that fails closed would turn an unconfigured preview into a 503 for a read-only public page. What bounds the
 * upstream traffic instead is, in order: the CDN (s-maxage below), a 5-minute in-process cache of the raw upstream answers in
 * lib/observatory/sources.ts (so any number of callers cause at most one fetch per feed per 5 minutes per instance, and one
 * every 30 seconds while a feed is failing), a 5-second bound on each fetch, and a single in-flight request per feed. The
 * optional EIA key is read server-side only and never appears in a response, error or log line.
 */
export const dynamic = "force-dynamic";

const OK = "public, max-age=0, s-maxage=300, stale-while-revalidate=60";
// Nothing usable from the fetched feeds: do not let the CDN pin the outage for five minutes.
const DEGRADED = "public, max-age=0, s-maxage=30";

export async function GET() {
  try {
    const ctx = await getLiveContext();
    // The bundled queue snapshots are always present, so the outage test looks only at the fetched feeds.
    const anyValue = [ctx.dayAheadPrice, ctx.generationMix, ctx.usDemand].some((o) => o.value !== null);
    return NextResponse.json(ctx, { headers: { "Cache-Control": anyValue ? OK : DEGRADED } });
  } catch {
    // getLiveContext does not throw by design; if it ever does, say so plainly and cache nothing.
    return NextResponse.json({ ok: false, reason: "context-unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
