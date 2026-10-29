import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  FAILURE_TTL_MS,
  REFERENCE_REGION,
  createContextCache,
  deriveQueue,
  getLiveContext,
  pickInterval,
  publishedSnapshots,
} from "@/lib/observatory/sources";
import { QUEUE_SNAPSHOTS } from "@/lib/queue-data";
import type { LiveContext } from "@/lib/observatory/types";
import {
  EIA_KEY,
  H,
  MIN,
  NEVER,
  T0,
  awattar,
  eiaRow,
  grid,
  hourly,
  interval,
  jsonResponse,
  routedFetch,
  type Routes,
} from "./observatory-core-harness";

const NOW = new Date(T0);
const ctxAt = (ms: number, routes: Routes, extra: { env?: Record<string, string | undefined>; timeoutMs?: number; cache?: ReturnType<typeof createContextCache> } = {}) => {
  const r = routedFetch(routes);
  const p = getLiveContext({ fetch: r.fn, now: () => new Date(ms), env: extra.env ?? {}, timeoutMs: extra.timeoutMs, cache: extra.cache });
  return { r, p };
};
const run = async (routes: Routes, extra: Parameters<typeof ctxAt>[2] = {}, ms = T0) => {
  const { r, p } = ctxAt(ms, routes, extra);
  return { ctx: await p, r };
};

const HOURS_10 = Date.UTC(2026, 9, 25, 10, 0, 0);
const GOOD: Routes = {
  market: awattar(hourly(HOURS_10 - 2 * H, 6)), // 08:00Z .. 13:00Z, price 50..55
  grid: grid(Math.floor(T0 / 1000) - 20 * 60), // 20 minutes old
};

describe("getLiveContext: day-ahead price honesty", () => {
  it("derives the price and observedAt from the interval that contains now, not from the request time", async () => {
    const { ctx } = await run(GOOD);
    const p = ctx.dayAheadPrice;
    expect(p.value).toEqual({
      eurPerMWh: 52,
      deliveryStart: "2026-10-25T10:00:00.000Z",
      min: 50,
      max: 55,
      avg: 52.5,
      windowStart: "2026-10-25T08:00:00.000Z", // what min/max/avg are over: the whole published window, not a calendar day
      windowEnd: "2026-10-25T14:00:00.000Z",
    });
    expect(p.provenance.basis).toBe("day_ahead_auction");
    expect(p.provenance.observedAt).toBe("2026-10-25T10:00:00.000Z");
    expect(p.provenance.observedAt).not.toBe(NOW.toISOString()); // /api/market's asOf is the request time: never used
    expect(p.provenance.retrievedAt).toBe(NOW.toISOString());
    expect(p.provenance.caveat).toBe("a published auction price for this delivery hour, not a live observation");
    expect(p.provenance.maxAgeSeconds).toBe(3600);
    expect(p.freshness).toBe("fresh");
    expect(ctx.referenceRegion).toBe(REFERENCE_REGION);
    expect(REFERENCE_REGION).toBe("Germany / Luxembourg (DE-LU) market and grid, shown for context — not the location of the demonstration halls");
    expect(ctx.generatedAt).toBe(NOW.toISOString());
  });

  it("hour boundaries: the interval is [start, end)", async () => {
    const at = async (ms: number) => (await run(GOOD, {}, ms)).ctx.dayAheadPrice;
    expect((await at(HOURS_10)).value?.deliveryStart).toBe("2026-10-25T10:00:00.000Z");
    expect((await at(HOURS_10 + H - 1)).value?.deliveryStart).toBe("2026-10-25T10:00:00.000Z");
    expect((await at(HOURS_10 + H)).value?.deliveryStart).toBe("2026-10-25T11:00:00.000Z");
    expect((await at(HOURS_10 + H)).value?.eurPerMWh).toBe(53);
    expect((await at(HOURS_10 - 1)).value?.deliveryStart).toBe("2026-10-25T09:00:00.000Z");
  });

  it("DST: epoch intervals across the autumn change (25-hour day in Germany) pick the right physical hour", async () => {
    // 2026-10-25 01:00Z is when CEST (UTC+2) ends: 02:00 local happens twice (00:00Z-01:00Z and 01:00Z-02:00Z).
    const start = Date.UTC(2026, 9, 24, 22, 0, 0); // 00:00 local on the 25th
    const rows = hourly(start, 25, 100); // 25 distinct hours, price 100..124
    const at = async (iso: string) => (await run({ ...GOOD, market: awattar(rows) }, {}, Date.parse(iso))).ctx.dayAheadPrice;
    const first = await at("2026-10-25T00:30:00Z"); // first 02:xx local (CEST)
    const second = await at("2026-10-25T01:30:00Z"); // second 02:xx local (CET)
    expect(first.value?.deliveryStart).toBe("2026-10-25T00:00:00.000Z");
    expect(second.value?.deliveryStart).toBe("2026-10-25T01:00:00.000Z");
    expect(first.value?.eurPerMWh).toBe(102);
    expect(second.value?.eurPerMWh).toBe(103);
    // and spring: 2026-03-29 01:00Z skips 02:00 local entirely
    const sStart = Date.UTC(2026, 2, 28, 23, 0, 0);
    const sRows = hourly(sStart, 23, 10);
    const s = (await run({ ...GOOD, market: awattar(sRows) }, {}, Date.parse("2026-03-29T01:10:00Z"))).ctx.dayAheadPrice;
    expect(s.value?.deliveryStart).toBe("2026-03-29T01:00:00.000Z");
    expect(s.value?.eurPerMWh).toBe(12);
  });

  it("15-minute intervals are labelled a delivery period, not an hour", async () => {
    const rows = [interval(HOURS_10, 15 * MIN, 40), interval(HOURS_10 + 30 * MIN, 15 * MIN, 41), interval(HOURS_10 + 15 * MIN, 15 * MIN, 42)];
    const p = (await run({ ...GOOD, market: awattar(rows) })).ctx.dayAheadPrice;
    expect(p.value?.eurPerMWh).toBe(41); // 10:30 falls in the 10:30-10:45 interval whatever the row order
    expect(p.provenance.caveat).toBe("a published auction price for this delivery period, not a live observation");
  });

  it("no interval contains now (gap, only future rows, only past rows): unavailable, never the first row's price", async () => {
    for (const rows of [
      [interval(HOURS_10 - 3 * H, H, 1), interval(HOURS_10 + 2 * H, H, 2)], // gap
      hourly(HOURS_10 + H, 3), // only future
      hourly(HOURS_10 - 5 * H, 3), // only past
    ]) {
      const p = (await run({ ...GOOD, market: awattar(rows) })).ctx.dayAheadPrice;
      expect(p.value).toBeNull();
      expect(p.freshness).toBe("unavailable");
      expect(p.provenance.observedAt).toBeNull();
    }
  });

  it("pickInterval: overlapping rows give the latest start; zero/negative-length rows never match", () => {
    expect(pickInterval([{ start: 0, end: 100, eurPerMWh: 1 }, { start: 50, end: 100, eurPerMWh: 2 }], 60)?.eurPerMWh).toBe(2);
    expect(pickInterval([{ start: 10, end: 10, eurPerMWh: 1 }], 10)).toBeNull();
    expect(pickInterval([], 10)).toBeNull();
  });
});

describe("getLiveContext: grid mix, queue, EIA", () => {
  it("grid mix: observedAt is the feed's own timestamp, basis observed, fresh when recent", async () => {
    const lastSecs = Math.floor(T0 / 1000) - 20 * 60;
    const g = (await run(GOOD)).ctx.generationMix;
    expect(g.provenance.basis).toBe("observed");
    expect(g.provenance.observedAt).toBe(new Date(lastSecs * 1000).toISOString());
    expect(g.provenance.retrievedAt).toBe(NOW.toISOString());
    expect(g.provenance.maxAgeSeconds).toBe(10800);
    expect(g.freshness).toBe("fresh");
    expect(g.value).toEqual({
      totalMW: 470,
      renewablePct: 85.1,
      mix: [
        { name: "Wind onshore", mw: 300, renewable: true },
        { name: "Solar", mw: 100, renewable: true },
        { name: "Fossil gas", mw: 70, renewable: false },
      ],
    });
  });

  it("grid mix: stale beyond 3 h, still shown but not fresh; a future timestamp is unavailable", async () => {
    const secs = (offsetSec: number) => Math.floor(T0 / 1000) + offsetSec;
    const stale = (await run({ ...GOOD, grid: grid(secs(-3 * 3600 - 60)) })).ctx.generationMix;
    expect(stale.freshness).toBe("stale");
    expect(stale.value).not.toBeNull();
    const edge = (await run({ ...GOOD, grid: grid(secs(-3 * 3600)) })).ctx.generationMix;
    expect(edge.freshness).toBe("fresh");
    const future = (await run({ ...GOOD, grid: grid(secs(3600)) })).ctx.generationMix;
    expect(future.freshness).toBe("unavailable");
    expect(future.value).toBeNull();
    const skew = (await run({ ...GOOD, grid: grid(secs(60)) })).ctx.generationMix;
    expect(skew.freshness).toBe("fresh");
  });

  it("queue: a published report, current only as of the report date, stale after ~120 days, modelled placeholders left out", async () => {
    const nowCtx = (await run(GOOD)).ctx.queue; // 2026-10-25: far beyond 120 days from the end-2025 data
    expect(nowCtx.provenance.basis).toBe("published_report");
    expect(nowCtx.provenance.observedAt).toBe("2025-12-31T00:00:00.000Z");
    expect(nowCtx.provenance.retrievedAt).toBeNull();
    expect(nowCtx.provenance.maxAgeSeconds).toBe(120 * 86400);
    expect(nowCtx.provenance.caveat).toMatch(/current as of that report/);
    expect(nowCtx.freshness).toBe("stale");
    expect(nowCtx.value?.map((q) => q.market)).toEqual(["ERCOT", "PJM", "MISO", "SPP"]);
    expect(JSON.stringify(nowCtx)).not.toMatch(/Nord Pool|EPEX/);
    const early = (await run(GOOD, {}, Date.parse("2026-02-01T00:00:00Z"))).ctx.queue;
    expect(early.freshness).toBe("fresh");
    // exactly at the limit is fresh, a second later is stale
    const limit = Date.parse("2025-12-31T00:00:00Z") + 120 * 86400_000;
    expect((await run(GOOD, {}, limit)).ctx.queue.freshness).toBe("fresh");
    expect((await run(GOOD, {}, limit + 1000)).ctx.queue.freshness).toBe("stale");
  });

  it("queue: snapshots the data labels as modelled are not published figures; an unparseable date is unavailable", () => {
    expect(publishedSnapshots().every((q) => !/modell?ed/i.test(q.source))).toBe(true);
    expect(publishedSnapshots(QUEUE_SNAPSHOTS).length).toBeLessThan(QUEUE_SNAPSHOTS.length);
    const bad = deriveQueue(NOW, [{ market: "X", activeProjectsGW: 1, typicalWaitMonths: 2, asOf: "garbage", source: "Test report" }]);
    expect(bad.freshness).toBe("unavailable");
    expect(bad.value).toBeNull();
    expect(deriveQueue(NOW, []).value).toBeNull();
  });

  it("EIA without a key: not_applicable, no request is made, no value", async () => {
    const { ctx, r } = await run({ ...GOOD, eia: eiaRow("2026-10-25T09", 400000) }, { env: {} });
    expect(ctx.usDemand.freshness).toBe("not_applicable");
    expect(ctx.usDemand.value).toBeNull();
    expect(r.count("api.eia.gov")).toBe(0);
    const blank = await run({ ...GOOD, eia: eiaRow("2026-10-25T09", 400000) }, { env: { EIA_API_KEY: "   " } });
    expect(blank.ctx.usDemand.freshness).toBe("not_applicable");
    expect(blank.r.count("api.eia.gov")).toBe(0);
  });

  it("EIA with a key: observed, hourly period -> observedAt, Lower-48 only, key used in the request and nowhere in the output", async () => {
    const { ctx, r } = await run({ ...GOOD, eia: eiaRow("2026-10-25T09", "412345.6") }, { env: { EIA_API_KEY: EIA_KEY } });
    expect(ctx.usDemand.value).toEqual({ mw: 412346, period: "2026-10-25T09" });
    expect(ctx.usDemand.provenance.basis).toBe("observed");
    expect(ctx.usDemand.provenance.observedAt).toBe("2026-10-25T09:00:00.000Z");
    expect(ctx.usDemand.provenance.maxAgeSeconds).toBe(21600);
    expect(ctx.usDemand.freshness).toBe("fresh");
    const eiaCall = r.calls.find((c) => c.url.includes("api.eia.gov"))!;
    expect(eiaCall.url).toContain(`api_key=${EIA_KEY}`);
    expect(eiaCall.url).toContain("facets[respondent][]=US48");
    expect(JSON.stringify(ctx)).not.toContain(EIA_KEY);
    expect(JSON.stringify(ctx)).not.toContain("api_key");
  });

  it("EIA: a row for another area, an unparseable period, a negative value, or an hour 7 h old are not shown as fresh Lower-48 demand", async () => {
    const env = { EIA_API_KEY: EIA_KEY };
    const other = (await run({ ...GOOD, eia: eiaRow("2026-10-25T09", 1000, "PJM") }, { env })).ctx.usDemand;
    expect(other.freshness).toBe("unavailable");
    expect(other.value).toBeNull();
    const noArea = (await run({ ...GOOD, eia: eiaRow("2026-10-25T09", 1000, null) }, { env })).ctx.usDemand;
    expect(noArea.value).toBeNull();
    expect((await run({ ...GOOD, eia: eiaRow("yesterday", 1000) }, { env })).ctx.usDemand.freshness).toBe("unavailable");
    expect((await run({ ...GOOD, eia: eiaRow("2026-10-25T09", -5) }, { env })).ctx.usDemand.freshness).toBe("unavailable");
    expect((await run({ ...GOOD, eia: eiaRow("2026-10-25T09", "abc") }, { env })).ctx.usDemand.freshness).toBe("unavailable");
    const old = (await run({ ...GOOD, eia: eiaRow("2026-10-25T03", 1000) }, { env })).ctx.usDemand;
    expect(old.freshness).toBe("stale"); // 03:00Z is 7.5 h before 10:30Z, limit 6 h
    const future = (await run({ ...GOOD, eia: eiaRow("2026-10-25T14", 1000) }, { env })).ctx.usDemand;
    expect(future.freshness).toBe("unavailable");
  });

  it("the key never appears when the EIA request fails, throws with the URL in its message, or times out", async () => {
    const env = { EIA_API_KEY: EIA_KEY };
    const leaky = (url: string): never => {
      throw new Error(`connect failed for ${url}`);
    };
    for (const eia of [leaky, () => jsonResponse({}, 500), () => jsonResponse({ response: { data: [] } })]) {
      const { ctx } = await run({ ...GOOD, eia }, { env });
      expect(ctx.usDemand.freshness).toBe("unavailable");
      expect(JSON.stringify(ctx)).not.toContain(EIA_KEY);
    }
    const slow = await run({ ...GOOD, eia: NEVER }, { env, timeoutMs: 15 });
    expect(slow.ctx.usDemand.freshness).toBe("unavailable");
    expect(JSON.stringify(slow.ctx)).not.toContain(EIA_KEY);
    // the other feeds are untouched by the EIA failure
    expect(slow.ctx.dayAheadPrice.freshness).toBe("fresh");
    expect(slow.ctx.generationMix.freshness).toBe("fresh");
  });
});

describe("getLiveContext: one feed failing never blanks the others", () => {
  const failures: [string, Routes["market"]][] = [
    ["HTTP 503", () => jsonResponse({}, 503)],
    ["a thrown error", () => {
      throw new Error("ECONNRESET");
    }],
    ["an empty body", () => jsonResponse({})],
    ["a timeout", NEVER],
  ];

  for (const [label, bad] of failures) {
    it(`market ${label}`, async () => {
      const { ctx } = await run({ ...GOOD, market: bad }, { timeoutMs: 15 });
      expect(ctx.dayAheadPrice).toMatchObject({ value: null, freshness: "unavailable" });
      expect(ctx.dayAheadPrice.provenance.basis).toBe("day_ahead_auction");
      expect(ctx.dayAheadPrice.provenance.retrievedAt).toBeNull();
      expect(ctx.generationMix.freshness).toBe("fresh");
      expect(ctx.queue.value).not.toBeNull();
    });
    it(`grid ${label}`, async () => {
      const { ctx } = await run({ ...GOOD, grid: bad }, { timeoutMs: 15 });
      expect(ctx.generationMix).toMatchObject({ value: null, freshness: "unavailable" });
      expect(ctx.dayAheadPrice.freshness).toBe("fresh");
      expect(ctx.queue.value).not.toBeNull();
    });
  }

  it("both live feeds down: still a complete LiveContext with honest unavailable values", async () => {
    const { ctx } = await run({ market: () => jsonResponse({}, 500), grid: () => jsonResponse({}, 500) });
    expect(ctx.dayAheadPrice.value).toBeNull();
    expect(ctx.generationMix.value).toBeNull();
    expect(ctx.usDemand.freshness).toBe("not_applicable");
    expect(ctx.queue.provenance.basis).toBe("published_report");
  });

  it("the default bound is 5 seconds for each feed", async () => {
    vi.useFakeTimers();
    try {
      const { r, p } = ctxAt(T0, { market: NEVER, grid: GOOD.grid });
      let done = false;
      void p.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const ctx = await p;
      expect(done).toBe(true);
      expect(ctx.dayAheadPrice.freshness).toBe("unavailable");
      expect(ctx.generationMix.freshness).toBe("fresh");
      expect(r.count("awattar")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests are made uncached and without Next's data cache, so retrievedAt is when WE asked", async () => {
    const { r } = await run(GOOD);
    for (const c of r.calls) {
      expect(c.init?.cache).toBe("no-store");
      expect(c.init).not.toHaveProperty("next");
    }
  });
});

describe("getLiveContext: the in-process cache keeps the original retrievedAt", () => {
  let cache = createContextCache();
  beforeEach(() => {
    cache = createContextCache();
  });
  const at = (ms: number, r: ReturnType<typeof routedFetch>) => getLiveContext({ fetch: r.fn, now: () => new Date(ms), env: {}, cache });

  it("a cached read is not relabelled: retrievedAt stays at the original fetch and freshness is recomputed", async () => {
    const r = routedFetch({ market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(T0 / 1000) - 10 * 60) });
    const first = await at(T0, r);
    expect(r.calls).toHaveLength(2);
    const later = T0 + 4 * MIN;
    const second = await at(later, r);
    expect(r.calls).toHaveLength(2); // served from cache
    expect(second.dayAheadPrice.provenance.retrievedAt).toBe(first.dayAheadPrice.provenance.retrievedAt);
    expect(second.generationMix.provenance.retrievedAt).toBe(new Date(T0).toISOString());
    expect(second.generatedAt).toBe(new Date(later).toISOString());
    expect(second.generatedAt).not.toBe(second.generationMix.provenance.retrievedAt);
    expect(second.generationMix.provenance.observedAt).toBe(first.generationMix.provenance.observedAt);
  });

  it("the cached rows are re-read against the new clock: crossing the hour changes the price, not the retrievedAt", async () => {
    const r = routedFetch({ market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(T0 / 1000)) });
    const t = HOURS_10 + H - 2 * MIN; // 10:58
    const a = await at(t, r);
    const b = await at(t + 4 * MIN, r); // 11:02, still inside the 5-minute cache
    expect(r.calls).toHaveLength(2);
    expect(a.dayAheadPrice.value?.deliveryStart).toBe("2026-10-25T10:00:00.000Z");
    expect(b.dayAheadPrice.value?.deliveryStart).toBe("2026-10-25T11:00:00.000Z");
    expect(b.dayAheadPrice.provenance.retrievedAt).toBe(new Date(t).toISOString());
  });

  it("cached grid data ages honestly: fresh at fetch, stale hours later when the feed is down", async () => {
    const lastSecs = Math.floor(T0 / 1000) - (3 * 3600 - 60); // 2 h 59 min old at fetch
    const r = routedFetch({ market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(lastSecs) });
    const a = await at(T0, r);
    expect(a.generationMix.freshness).toBe("fresh");
    const b = await at(T0 + 4 * MIN, r); // still cached; observation now 3 h 3 min old
    expect(b.generationMix.freshness).toBe("stale");
    expect(b.generationMix.provenance.retrievedAt).toBe(new Date(T0).toISOString());
  });

  it("expires after the TTL and re-fetches with a new retrievedAt", async () => {
    expect(CACHE_TTL_MS).toBe(5 * 60_000);
    const r = routedFetch({ market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(T0 / 1000)) });
    await at(T0, r);
    await at(T0 + CACHE_TTL_MS - 1, r);
    expect(r.calls).toHaveLength(2);
    const c = await at(T0 + CACHE_TTL_MS, r);
    expect(r.calls).toHaveLength(4);
    expect(c.dayAheadPrice.provenance.retrievedAt).toBe(new Date(T0 + CACHE_TTL_MS).toISOString());
  });

  it("a clock that moves backwards never serves a cache entry from its own future", async () => {
    const r = routedFetch({ market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(T0 / 1000)) });
    await at(T0, r);
    await at(T0 - 10 * MIN, r);
    expect(r.calls).toHaveLength(4);
  });

  it("failures are remembered briefly (no hammering) and then retried; a failure is never kept as success", async () => {
    expect(FAILURE_TTL_MS).toBe(30_000);
    let up = false;
    const r = routedFetch({
      market: () => (up ? jsonResponse({ data: hourly(HOURS_10 - 2 * H, 8) }) : jsonResponse({}, 500)),
      grid: grid(Math.floor(T0 / 1000)),
    });
    const a = await at(T0, r);
    expect(a.dayAheadPrice.freshness).toBe("unavailable");
    up = true;
    await at(T0 + 10_000, r);
    expect(r.count("awattar")).toBe(1);
    const c = await at(T0 + 30_000, r);
    expect(r.count("awattar")).toBe(2);
    expect(c.dayAheadPrice.freshness).toBe("fresh");
    expect(c.dayAheadPrice.provenance.retrievedAt).toBe(new Date(T0 + 30_000).toISOString());
  });

  it("concurrent callers share one upstream request per feed", async () => {
    const r = routedFetch({ market: awattar(hourly(HOURS_10 - 2 * H, 8)), grid: grid(Math.floor(T0 / 1000)) });
    await Promise.all([at(T0, r), at(T0, r), at(T0, r)]);
    expect(r.count("awattar")).toBe(1);
    expect(r.count("energy-charts")).toBe(1);
  });

  it("an injected fetch without an explicit cache never shares state with another call", async () => {
    const r = routedFetch(GOOD);
    await getLiveContext({ fetch: r.fn, now: () => NOW, env: {} });
    await getLiveContext({ fetch: r.fn, now: () => NOW, env: {} });
    expect(r.count("awattar")).toBe(2);
  });
});

describe("LiveContext honesty across all feeds", () => {
  it("nothing here is called live except an observation that is fresh", async () => {
    const { ctx } = await run({ ...GOOD, eia: eiaRow("2026-10-25T09", 1) }, { env: { EIA_API_KEY: EIA_KEY } });
    const all: (keyof LiveContext)[] = ["dayAheadPrice", "generationMix", "queue", "usDemand"];
    const observedOnes = all.filter((k) => (ctx[k] as { provenance: { basis: string } }).provenance.basis === "observed");
    expect(observedOnes.sort()).toEqual(["generationMix", "usDemand"]);
    expect(ctx.dayAheadPrice.provenance.basis).not.toBe("observed");
    expect(ctx.queue.provenance.basis).not.toBe("observed");
  });

  it("is deterministic for the same inputs", async () => {
    const a = (await run(GOOD)).ctx;
    const b = (await run(GOOD)).ctx;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
