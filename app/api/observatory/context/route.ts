import { NextResponse } from "next/server";
import { getLiveContextWithValidity } from "@/lib/observatory/sources";

/**
 * GET /api/observatory/context: the Observatory's live context (EPEX day-ahead price, German generation mix, published queue
 * snapshots, optional EIA demand), each value with its provenance and a freshness computed at the moment of this response.
 * The body is a LiveContext (lib/observatory/types.ts) and nothing else; a feed that failed is `value: null` with freshness
 * "unavailable", never a placeholder, and the response is still 200 so one dead feed does not hide the others.
 *
 * CACHING AND AGE. Freshness and "the price interval that contains now" are decided when the response is GENERATED, so a cache
 * must not hold it past the moment they stop being true. `s-maxage` is therefore min(300 s, seconds until the shown price
 * interval ends, seconds until any value labelled fresh passes its age limit): a response can never be served from a CDN as a
 * previous hour's price still labelled fresh. There is no stale-while-revalidate, because it would serve exactly that. A
 * browser is told `max-age=0`. Consumers that keep a response (a tab left open) must recompute age from `generatedAt` and each
 * provenance with `reassessFreshness` (lib/observatory/sources.ts), not trust the `freshness` field after time has passed.
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

/** Nothing usable from the fetched feeds: do not let the CDN pin the outage for long. */
const DEGRADED_MAX_SECONDS = 30;

export async function GET() {
  try {
    const { context: ctx, validForSeconds } = await getLiveContextWithValidity();
    // The bundled queue snapshots are always present, so the outage test looks only at the fetched feeds.
    const anyValue = [ctx.dayAheadPrice, ctx.generationMix, ctx.usDemand].some((o) => o.value !== null);
    const sMaxAge = anyValue ? validForSeconds : Math.min(validForSeconds, DEGRADED_MAX_SECONDS);
    return NextResponse.json(ctx, { headers: { "Cache-Control": `public, max-age=0, s-maxage=${sMaxAge}` } });
  } catch {
    // getLiveContext does not throw by design; if it ever does, say so plainly and cache nothing.
    return NextResponse.json({ ok: false, reason: "context-unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
