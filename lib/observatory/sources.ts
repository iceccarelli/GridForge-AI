// Live market/grid/queue context for the Observatory, each value with its provenance and a freshness that is computed, not asserted.
//
// What this module refuses to do (each is a test):
//   - call a value "live" unless it is an observation that is still inside its age limit; a cached value keeps the time THIS
//     process fetched it (retrievedAt) and is re-assessed against the clock on every call
//   - present an auction price as an observation: the day-ahead price is for the delivery interval that contains "now", its
//     observedAt is that interval's start, and /api/market's `asOf` (the REQUEST time) is never used as a data time
//   - let one failing feed blank another, or wait longer than FEED_TIMEOUT_MS for any of them
//   - emit a number for a missing value, or any part of the EIA key (the key is used only to build the upstream request; no
//     error text, URL or log line from a failed request is ever copied into the result)
//
// Pure apart from the injected fetch/now/env and the explicit in-process cache.

import { QUEUE_SNAPSHOTS, type QueueSnapshot } from "@/lib/queue-data";
import {
  fetchEiaDemand,
  fetchGrid,
  fetchMarket,
  type GridOk,
  type MarketInterval,
  type MarketOk,
} from "@/lib/observatory/_shared/feeds";
import type { Freshness, LiveContext, Observed, Provenance } from "@/lib/observatory/types";

export interface SourceDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** In-process cache. Default: a shared module cache when no fetch is injected, otherwise a private empty one. */
  cache?: ContextCache;
  /** Per-feed bound; default FEED_TIMEOUT_MS. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants (the thresholds a reader of the page is entitled to know)
// ---------------------------------------------------------------------------------------------------------------------

export const REFERENCE_REGION =
  "Germany / Luxembourg (DE-LU) market and grid, shown for context — not the location of the demonstration halls";

/** Each upstream is given this long, and no longer. */
export const FEED_TIMEOUT_MS = 5000;
/** A fetched feed is reused for this long; the original retrievedAt is kept. */
export const CACHE_TTL_MS = 5 * 60_000;
/** A failed fetch is remembered this long so an outage is not hammered. */
export const FAILURE_TTL_MS = 30_000;
/** A timestamp this far ahead of the clock is tolerated as clock skew; further ahead is not believable. */
export const CLOCK_SKEW_SECONDS = 120;

/** Age beyond which each kind of value is called stale. */
export const MAX_AGE_SECONDS = {
  /** The interval containing "now" is at most an hour old by construction; anything older is a different hour's price. */
  dayAheadPrice: 60 * 60,
  /** Energy-Charts publishes on a 15-minute cadence and lags; three hours is generous, beyond it the mix is not "now". */
  generationMix: 3 * 3600,
  /** ISO queue reports are monthly or quarterly. */
  queue: 120 * 86400,
  /** EIA hourly demand is published with a delay. */
  usDemand: 6 * 3600,
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Freshness: the one rule
// ---------------------------------------------------------------------------------------------------------------------

export interface FreshnessInput {
  /** False for a value that does not apply here at all (EIA without a key). */
  applicable?: boolean;
  /** Whether there is a value to assess. */
  hasValue: boolean;
  observedAt: string | null;
  retrievedAt: string | null;
  maxAgeSeconds: number | null;
  now: Date;
}

/**
 * fresh | stale | unavailable | not_applicable. The reference time is observedAt, or retrievedAt when the value has no
 * observation time. Age exactly equal to the limit is still fresh; one millisecond over is stale. A reference time more than
 * CLOCK_SKEW_SECONDS in the future is not believable and is "unavailable", never fresh. An unparseable time, an invalid limit,
 * or a value that needs an age limit but has no time at all is "unavailable".
 */
export function freshnessOf(i: FreshnessInput): Freshness {
  if (i.applicable === false) return "not_applicable";
  if (!i.hasValue) return "unavailable";
  const nowMs = i.now.getTime();
  if (!Number.isFinite(nowMs)) return "unavailable";
  if (i.maxAgeSeconds !== null && (!Number.isFinite(i.maxAgeSeconds) || i.maxAgeSeconds < 0)) return "unavailable";

  const parse = (iso: string | null): number | null | "bad" => {
    if (iso === null) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : "bad";
  };
  const obs = parse(i.observedAt);
  const ret = parse(i.retrievedAt);
  if (obs === "bad" || ret === "bad") return "unavailable";

  const skewMs = CLOCK_SKEW_SECONDS * 1000;
  for (const t of [obs, ret]) if (t !== null && t - nowMs > skewMs) return "unavailable";

  const reference = obs ?? ret;
  if (reference === null) return i.maxAgeSeconds === null ? "fresh" : "unavailable";
  if (i.maxAgeSeconds === null) return "fresh";
  const ageMs = Math.max(0, nowMs - reference);
  return ageMs <= i.maxAgeSeconds * 1000 ? "fresh" : "stale";
}

/** Build an Observed<T>: freshness computed by freshnessOf, and the value dropped whenever the result is unavailable/not_applicable. */
export function observed<T>(args: {
  value: T | null;
  provenance: Provenance;
  now: Date;
  applicable?: boolean;
}): Observed<T> {
  const freshness = freshnessOf({
    applicable: args.applicable,
    hasValue: args.value !== null,
    observedAt: args.provenance.observedAt,
    retrievedAt: args.provenance.retrievedAt,
    maxAgeSeconds: args.provenance.maxAgeSeconds,
    now: args.now,
  });
  const keep = freshness === "fresh" || freshness === "stale";
  return { value: keep ? args.value : null, provenance: args.provenance, freshness };
}

/** True only for an observation that is still fresh: the single place that decides whether a value may be called "live". */
export function mayBeCalledLive(o: Observed<unknown>): boolean {
  return o.provenance.basis === "observed" && o.freshness === "fresh";
}

// ---------------------------------------------------------------------------------------------------------------------
// In-process cache of RAW upstream results (never of labelled values: freshness is re-derived on every call)
// ---------------------------------------------------------------------------------------------------------------------

type FeedResult<T> = { ok: true; data: T } | { ok: false };
interface CacheEntry { retrievedAtMs: number; expiresAtMs: number; result: FeedResult<unknown> }
export interface ContextCache {
  entries: Map<string, CacheEntry>;
  pending: Map<string, Promise<CacheEntry>>;
}
export function createContextCache(): ContextCache {
  return { entries: new Map(), pending: new Map() };
}
const moduleCache = createContextCache();
/** Test hook: forget everything the shared cache holds. */
export function resetContextCache(): void {
  moduleCache.entries.clear();
  moduleCache.pending.clear();
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function cached<T>(
  cache: ContextCache,
  feed: string,
  now: () => Date,
  timeoutMs: number,
  load: () => Promise<FeedResult<T>>,
): Promise<{ result: FeedResult<T>; retrievedAtMs: number }> {
  const t0 = now().getTime();
  const hit = cache.entries.get(feed);
  if (hit && t0 >= hit.retrievedAtMs && t0 < hit.expiresAtMs) return { result: hit.result as FeedResult<T>, retrievedAtMs: hit.retrievedAtMs };
  const inflight = cache.pending.get(feed);
  if (inflight) {
    const e = await inflight;
    return { result: e.result as FeedResult<T>, retrievedAtMs: e.retrievedAtMs };
  }
  const p: Promise<CacheEntry> = (async () => {
    let result: FeedResult<T>;
    try {
      // Bounded twice: the request aborts at timeoutMs, and a fetch that ignores the abort is still cut off here.
      result = await withDeadline(load(), timeoutMs);
    } catch {
      result = { ok: false };
    }
    const at = now().getTime();
    const entry: CacheEntry = { retrievedAtMs: at, expiresAtMs: at + (result.ok ? CACHE_TTL_MS : FAILURE_TTL_MS), result };
    cache.entries.set(feed, entry);
    return entry;
  })();
  cache.pending.set(feed, p);
  try {
    const e = await p;
    return { result: e.result as FeedResult<T>, retrievedAtMs: e.retrievedAtMs };
  } finally {
    cache.pending.delete(feed);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure derivations (exported so each rule is tested directly)
// ---------------------------------------------------------------------------------------------------------------------

/** The published interval with start <= now < end (end exclusive); the latest start if several overlap; null in a gap. */
export function pickInterval(intervals: MarketInterval[], nowMs: number): MarketInterval | null {
  let best: MarketInterval | null = null;
  for (const iv of intervals) {
    if (nowMs >= iv.start && nowMs < iv.end && (best === null || iv.start > best.start)) best = iv;
  }
  return best;
}

type DayAhead = LiveContext["dayAheadPrice"]["value"];
type Mix = LiveContext["generationMix"]["value"];
type Queue = LiveContext["queue"]["value"];

const DAY_AHEAD_SOURCE = "EPEX Spot day-ahead auction via aWATTar (DE-LU); min, max and avg are over the published window";
const GRID_SOURCE = "Fraunhofer ISE · Energy-Charts (Germany)";
const EIA_SOURCE = "U.S. EIA open data · hourly demand, Lower 48 (US48)";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The day-ahead value as served: the contract's fields plus the window min/max/avg were computed over (types.ts v2 should carry both). */
export type DayAheadValue = NonNullable<DayAhead> & { windowStart: string; windowEnd: string };

/**
 * min/max/avg are over EVERY published interval the feed returned (about a day, from some hours back to the end of tomorrow's
 * auction), not a calendar day. They are computed here from the intervals actually used, and the window they cover is carried
 * in the value so a reader is told what "min" and "max" are the min and max OF.
 */
export function deriveDayAhead(
  market: { body?: MarketOk; intervals: MarketInterval[] } | null,
  retrievedAtMs: number | null,
  now: Date,
): Observed<DayAheadValue> {
  const iv = market ? pickInterval(market.intervals, now.getTime()) : null;
  const lengthSec = iv ? (iv.end - iv.start) / 1000 : null;
  const hourly = lengthSec === 3600;
  const provenance: Provenance = {
    source: DAY_AHEAD_SOURCE,
    basis: "day_ahead_auction",
    observedAt: iv ? iso(iv.start) : null,
    retrievedAt: iv && retrievedAtMs !== null ? iso(retrievedAtMs) : null,
    // Fresh only while its own delivery interval lasts: a price is not an observation, and the next interval has a different price.
    maxAgeSeconds: lengthSec ?? MAX_AGE_SECONDS.dayAheadPrice,
    caveat: iv
      ? `a published auction price for this delivery ${hourly ? "hour" : "period"}, not a live observation`
      : "no published delivery interval covers the current time, so no price is shown",
  };
  if (!market || !iv) return observed<DayAheadValue>({ value: null, provenance, now });
  const prices = market.intervals.map((x) => x.eurPerMWh);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return observed<DayAheadValue>({
    value: {
      eurPerMWh: iv.eurPerMWh,
      deliveryStart: iso(iv.start),
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: r2(prices.reduce((a, b) => a + b, 0) / prices.length),
      windowStart: iso(Math.min(...market.intervals.map((x) => x.start))),
      windowEnd: iso(Math.max(...market.intervals.map((x) => x.end))),
    },
    provenance,
    now,
  });
}

export function deriveGenerationMix(grid: GridOk | null, retrievedAtMs: number | null, now: Date): Observed<NonNullable<Mix>> {
  const okTime = grid !== null && Number.isFinite(grid.asOf);
  const provenance: Provenance = {
    source: GRID_SOURCE,
    basis: "observed",
    observedAt: grid && okTime ? iso(grid.asOf) : null,
    retrievedAt: grid && retrievedAtMs !== null ? iso(retrievedAtMs) : null,
    maxAgeSeconds: MAX_AGE_SECONDS.generationMix,
    caveat: "generation for Germany at the interval shown; the renewable share is of reported generation, not of demand",
  };
  if (!grid || !okTime) return observed<NonNullable<Mix>>({ value: null, provenance, now });
  return observed({
    value: { totalMW: grid.totalMW, renewablePct: grid.renewablePct, mix: grid.mix.map((m) => ({ name: m.name, mw: m.mw, renewable: m.renewable })) },
    provenance,
    now,
  });
}

/** Snapshots the data itself labels as modelled are not published report figures (their 0 GW is a placeholder), so they are left out. */
export function publishedSnapshots(all: QueueSnapshot[] = QUEUE_SNAPSHOTS): QueueSnapshot[] {
  return all.filter((q) => !/modell?ed/i.test(q.source) && Number.isFinite(q.activeProjectsGW) && Number.isFinite(q.typicalWaitMonths));
}

export function deriveQueue(now: Date, all: QueueSnapshot[] = QUEUE_SNAPSHOTS): Observed<NonNullable<Queue>> {
  const snaps = publishedSnapshots(all);
  const dates = snaps.map((q) => Date.parse(q.asOf)).filter((t) => Number.isFinite(t));
  // Conservative: the report date is the OLDEST of the reports shown, so a stale one cannot hide behind a fresh one.
  const oldest = dates.length === snaps.length && dates.length > 0 ? Math.min(...dates) : null;
  const provenance: Provenance = {
    source: snaps.length ? `Published queue reports: ${snaps.map((q) => q.source).join("; ")}` : "Published queue reports",
    basis: "published_report",
    observedAt: oldest !== null ? iso(oldest) : null,
    retrievedAt: null, // bundled with this deployment, not fetched
    maxAgeSeconds: MAX_AGE_SECONDS.queue,
    caveat:
      "current as of that report (the oldest of the reports shown), not as of today; queues change between reports, and entries the data labels as modelled are left out",
  };
  if (oldest === null) return observed<NonNullable<Queue>>({ value: null, provenance, now });
  return observed({
    value: snaps.map((q) => ({ market: q.market, activeProjectsGW: q.activeProjectsGW, typicalWaitMonths: q.typicalWaitMonths })),
    provenance,
    now,
  });
}

const EIA_PERIOD = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/;

export function deriveUsDemand(
  key: string | null,
  eia: { mw: number; period: string; respondent: string | null } | null,
  retrievedAtMs: number | null,
  now: Date,
): Observed<{ mw: number; period: string }> {
  const m = eia ? EIA_PERIOD.exec(eia.period) : null;
  const observedAt = m ? `${m[1]}T${m[2]}:00:00.000Z` : null;
  const valid = eia !== null && observedAt !== null && Number.isFinite(Date.parse(observedAt)) && Number.isFinite(eia.mw) && eia.mw >= 0 && eia.respondent === "US48";
  const provenance: Provenance = {
    source: EIA_SOURCE,
    basis: "observed",
    observedAt: valid ? observedAt : null,
    retrievedAt: valid && retrievedAtMs !== null ? iso(retrievedAtMs) : null,
    maxAgeSeconds: MAX_AGE_SECONDS.usDemand,
    caveat: key ? "hourly Lower-48 demand as EIA reports it, with a delay; not a reading of this minute" : "needs an EIA API key, which is not configured here",
  };
  if (!key) return observed<{ mw: number; period: string }>({ value: null, provenance, now, applicable: false });
  if (!valid || !eia) return observed<{ mw: number; period: string }>({ value: null, provenance, now });
  return observed({ value: { mw: eia.mw, period: eia.period }, provenance, now });
}

// ---------------------------------------------------------------------------------------------------------------------
// The live context
// ---------------------------------------------------------------------------------------------------------------------

export interface LiveContextResult {
  context: LiveContext;
  /**
   * How many whole seconds this exact response stays true if a cache holds it: never more than MAX_RESPONSE_CACHE_SECONDS, and no
   * longer than the moment the price interval it shows ends or any fresh value passes its age limit. 0 = do not cache.
   */
  validForSeconds: number;
}

/** A shared cache (CDN) may hold a response at most this long, whatever else is true. */
export const MAX_RESPONSE_CACHE_SECONDS = 300;

/**
 * Freshness as of `now` for a value that was labelled earlier (a response held by a cache or a browser tab). The single rule is
 * freshnessOf; this applies it to an Observed that already carries its provenance. A value that was dropped stays unavailable.
 */
export function reassessFreshness(o: Observed<unknown>, now: Date): Freshness {
  return freshnessOf({
    applicable: o.freshness !== "not_applicable",
    hasValue: o.value !== null,
    observedAt: o.provenance.observedAt,
    retrievedAt: o.provenance.retrievedAt,
    maxAgeSeconds: o.provenance.maxAgeSeconds,
    now,
  });
}

export function getLiveContext(deps: SourceDeps = {}): Promise<LiveContext> {
  return getLiveContextWithValidity(deps).then((r) => r.context);
}

export async function getLiveContextWithValidity(deps: SourceDeps = {}): Promise<LiveContextResult> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? FEED_TIMEOUT_MS;
  const cache = deps.cache ?? (deps.fetch ? createContextCache() : moduleCache);
  const fetchImpl = deps.fetch;
  const rawKey = env.EIA_API_KEY;
  const key = typeof rawKey === "string" && rawKey.trim() !== "" ? rawKey.trim() : null;
  const common = { fetchImpl, timeoutMs, nowMs: () => now().getTime(), init: { cache: "no-store" as const } };

  const [market, grid, eia] = await Promise.allSettled([
    cached(cache, "market", now, timeoutMs, async () => {
      const r = await fetchMarket(common);
      return r.body.ok ? ({ ok: true, data: { body: r.body, intervals: r.intervals } } as const) : ({ ok: false } as const);
    }),
    cached(cache, "grid", now, timeoutMs, async () => {
      const r = await fetchGrid(common);
      return r.ok ? ({ ok: true, data: r } as const) : ({ ok: false } as const);
    }),
    key
      ? cached(cache, "eia", now, timeoutMs, async () => {
          const r = await fetchEiaDemand(key, { ...common, respondent: "US48" });
          return r
            ? ({ ok: true, data: { mw: r.live.value, period: r.live.asOf, respondent: r.respondent } } as const)
            : ({ ok: false } as const);
        })
      : Promise.resolve(null),
  ]);

  const settled = <T>(s: PromiseSettledResult<{ result: FeedResult<T>; retrievedAtMs: number } | null>) => {
    if (s.status !== "fulfilled" || s.value === null || !s.value.result.ok) return { data: null as T | null, at: null as number | null };
    return { data: s.value.result.data, at: s.value.retrievedAtMs };
  };
  const m = settled(market);
  const g = settled(grid);
  const e = settled(eia);

  const t = now();
  const marketData = m.data as { body?: MarketOk; intervals: MarketInterval[] } | null;
  const context: LiveContext = {
    generatedAt: t.toISOString(),
    referenceRegion: REFERENCE_REGION,
    dayAheadPrice: deriveDayAhead(marketData, m.at, t),
    generationMix: deriveGenerationMix(g.data as GridOk | null, g.at, t),
    queue: deriveQueue(t),
    usDemand: deriveUsDemand(key, e.data as { mw: number; period: string; respondent: string | null } | null, e.at, t),
  };
  return { context, validForSeconds: validForSeconds(context, marketData ? pickInterval(marketData.intervals, t.getTime()) : null, t) };
}

/** The longest a cache may hold `ctx` without it ever presenting a value as fresh after it has stopped being so. Pure. */
export function validForSeconds(ctx: LiveContext, priceInterval: MarketInterval | null, now: Date): number {
  const nowMs = now.getTime();
  let limitSec = MAX_RESPONSE_CACHE_SECONDS;
  if (ctx.dayAheadPrice.freshness === "fresh" && priceInterval) limitSec = Math.min(limitSec, (priceInterval.end - nowMs) / 1000);
  for (const o of [ctx.dayAheadPrice, ctx.generationMix, ctx.queue, ctx.usDemand] as Observed<unknown>[]) {
    if (o.freshness !== "fresh" || o.provenance.observedAt === null || o.provenance.maxAgeSeconds === null) continue;
    const staleAt = Date.parse(o.provenance.observedAt) + o.provenance.maxAgeSeconds * 1000;
    limitSec = Math.min(limitSec, (staleAt - nowMs) / 1000);
  }
  return Number.isFinite(limitSec) ? Math.max(0, Math.floor(limitSec)) : 0;
}
