// Characterisation of the three existing public feed routes. Written against the ORIGINAL routes and kept unchanged across the
// refactor that moved their upstream logic into lib/observatory/_shared, so a pass here before and after is the proof that
// /api/market, /api/grid and /api/queue still answer byte for byte the same (body text and the upstream request URL).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_SNAPSHOTS } from "@/lib/queue-data";

const NOW = Date.UTC(2026, 9, 25, 10, 30, 0);
const H = 3600_000;

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url));
  });
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/api/market byte-identical output", () => {
  const rows = [
    { start_timestamp: NOW - 90 * 60_000, end_timestamp: NOW - 30 * 60_000, marketprice: 80.123, unit: "Eur/MWh" },
    { start_timestamp: NOW - 30 * 60_000, end_timestamp: NOW + 30 * 60_000, marketprice: 95.5, unit: "Eur/MWh" },
    { start_timestamp: NOW + 30 * 60_000, end_timestamp: NOW + 90 * 60_000, marketprice: 60, unit: "Eur/MWh" },
    { start_timestamp: "bad", end_timestamp: 0, marketprice: 1, unit: "Eur/MWh" },
  ];

  it("success body", async () => {
    stubFetch(() => json({ data: rows }));
    const { GET } = await import("@/app/api/market/route");
    const res = await GET();
    expect(await res.text()).toBe(
      JSON.stringify({
        ok: true,
        market: "Germany / Luxembourg (DE-LU)",
        source: "EPEX Spot day-ahead via aWATTar",
        unit: "EUR/MWh",
        asOf: NOW,
        current: 95.5,
        min: 60,
        max: 95.5,
        avg: 78.54,
        spread: 35.5,
        series: [
          { t: NOW - 90 * 60_000, price: 80.12 },
          { t: NOW - 30 * 60_000, price: 95.5 },
          { t: NOW + 30 * 60_000, price: 60 },
        ],
      }),
    );
    expect(calls.map((c) => c.url)).toEqual(["https://api.awattar.de/v1/marketdata"]);
  });

  it("falls back to the first row when none contains now (existing behaviour)", async () => {
    stubFetch(() => json({ data: [{ start_timestamp: NOW + H, end_timestamp: NOW + 2 * H, marketprice: 12.345, unit: "Eur/MWh" }] }));
    const { GET } = await import("@/app/api/market/route");
    const body = await (await GET()).json();
    expect(body.current).toBe(12.35);
  });

  it("failure bodies", async () => {
    const { GET } = await import("@/app/api/market/route");
    stubFetch(() => json({}, 503));
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: false, reason: "upstream 503" }));
    stubFetch(() => json({ data: [] }));
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: false, reason: "empty" }));
    stubFetch(() => {
      throw new Error("boom");
    });
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: false, reason: "fetch-failed" }));
  });
});

describe("/api/grid byte-identical output", () => {
  const secs = [1_000_000, 1_000_900, 1_001_800];
  const upstream = {
    unix_seconds: secs,
    production_types: [
      { name: "Wind onshore", data: [100, 200, 300] },
      { name: "Solar", data: [0, 50.4, 100] },
      { name: "Fossil gas", data: [50, 60, 70] },
      { name: "Hydro Run-of-River", data: [5, 5, 5] },
      { name: "Hydro pumped storage", data: [1, 1, 1] },
      { name: "Hydro pumped storage consumption", data: [-9, -9, -9] },
      { name: "Load", data: [999, 999, 999] },
      { name: "Renewable share of load", data: [50, 50, 50] },
      { name: "Biomass", data: [10, 10, null] },
      { name: "Lignite", data: [10, 10, 10] },
      { name: "Hard coal", data: [10, 10, 10] },
      { name: "Nuclear", data: [10, 10, 10] },
      { name: "Waste", data: [10, 10, 10] },
    ],
  };

  it("success body", async () => {
    stubFetch(() => json(upstream));
    const { GET } = await import("@/app/api/grid/route");
    const text = await (await GET()).text();
    expect(text).toBe(
      JSON.stringify({
        ok: true,
        source: "Fraunhofer ISE · Energy-Charts",
        country: "Germany",
        asOf: 1_001_800_000,
        totalMW: 516,
        renewablePct: 78.5,
        mix: [
          { name: "Wind onshore", mw: 300, renewable: true },
          { name: "Solar", mw: 100, renewable: true },
          { name: "Fossil gas", mw: 70, renewable: false },
          { name: "Lignite", mw: 10, renewable: false },
          { name: "Hard coal", mw: 10, renewable: false },
          { name: "Nuclear", mw: 10, renewable: false },
          { name: "Other", mw: 16, renewable: false },
        ],
      }),
    );
    expect(calls.map((c) => c.url)).toEqual(["https://api.energy-charts.info/public_power?country=de"]);
  });

  it("failure bodies", async () => {
    const { GET } = await import("@/app/api/grid/route");
    stubFetch(() => json({}, 500));
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: false, reason: "upstream 500" }));
    stubFetch(() => json({ unix_seconds: [], production_types: [] }));
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: false, reason: "empty" }));
    stubFetch(() => json({ unix_seconds: [1], production_types: [{ name: "Solar", data: [0] }] }));
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: false, reason: "no-data" }));
    stubFetch(() => {
      throw new Error("boom");
    });
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: false, reason: "fetch-failed" }));
  });
});

describe("/api/queue byte-identical output", () => {
  it("without a key: snapshots only, no upstream call", async () => {
    vi.stubEnv("EIA_API_KEY", "");
    stubFetch(() => json({}));
    const { GET } = await import("@/app/api/queue/route");
    expect(await (await GET()).text()).toBe(JSON.stringify({ ok: true, snapshots: QUEUE_SNAPSHOTS, live: null }));
    expect(calls).toHaveLength(0);
  });

  it("with a key: the overlay and the exact upstream URL", async () => {
    vi.stubEnv("EIA_API_KEY", "k-test-123");
    stubFetch(() => json({ response: { data: [{ period: "2026-10-25T09", value: "412345.6" }] } }));
    const { GET } = await import("@/app/api/queue/route");
    expect(await (await GET()).text()).toBe(
      JSON.stringify({
        ok: true,
        snapshots: QUEUE_SNAPSHOTS,
        live: { label: "US grid demand", value: 412346, unit: "MW", asOf: "2026-10-25T09", source: "EIA open data (live)" },
      }),
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.eia.gov/v2/electricity/rto/region-data/data/?api_key=k-test-123&frequency=hourly&data[0]=value&facets[type][]=D&sort[0][column]=period&sort[0][direction]=desc&length=1",
    ]);
  });

  it("with a key but a failing upstream: snapshots stand alone", async () => {
    vi.stubEnv("EIA_API_KEY", "k-test-123");
    const { GET } = await import("@/app/api/queue/route");
    const handlers: (() => Response)[] = [
      () => json({}, 500),
      () => json({ response: { data: [] } }),
      () => {
        throw new Error("x");
      },
    ];
    for (const h of handlers) {
      stubFetch(h);
      expect(await (await GET()).text()).toBe(JSON.stringify({ ok: true, snapshots: QUEUE_SNAPSHOTS, live: null }));
    }
  });
});
